import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { Handler } from 'aws-lambda';

const ses = new SESClient({});
const ssm = new SSMClient({});

interface Document {
  projectKey: string;
  projectName: string;
  fileName: string;
  content: string;
}

interface LambdaEvent {
  documents: Document[];
}

interface LambdaResponse {
  success: boolean;
  message: string;
}

export const handler: Handler<LambdaEvent, LambdaResponse> = async (event) => {
  try {
    const { documents } = event;

    if (!documents || documents.length === 0) {
      return {
        success: false,
        message: 'ドキュメントがありません',
      };
    }

    const emailFromParam = process.env.EMAIL_FROM_PARAM || '/backlog-morning-meeting/email-from';
    const emailRecipientsParam = process.env.EMAIL_RECIPIENTS_PARAM || '/backlog-morning-meeting/email-recipients';

    const emailFrom = (await getSsmParameterValue(emailFromParam)).trim();
    const emailRecipients = parseEmailList(await getSsmParameterValue(emailRecipientsParam));

    if (!emailFrom) {
      throw new Error(`EMAIL_FROMが取得できません（SSM: ${emailFromParam}）`);
    }

    if (emailRecipients.length === 0) {
      throw new Error(`EMAIL_RECIPIENTSが取得できません（SSM: ${emailRecipientsParam}）`);
    }

    // 各ドキュメントをメール送信
    const results = await Promise.allSettled(
      documents.map(doc => sendEmail(doc, emailFrom, emailRecipients))
    );

    const successCount = results.filter(r => r.status === 'fulfilled').length;
    const failureCount = results.filter(r => r.status === 'rejected').length;

    if (failureCount > 0) {
      console.error('一部のメール送信に失敗しました');
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.error(`ドキュメント ${documents[index].fileName} のメール送信に失敗:`, result.reason);
        }
      });
    }

    return {
      success: successCount > 0,
      message: `${successCount}件のメールを送信しました（失敗: ${failureCount}件）`,
    };
  } catch (error) {
    console.error('エラー:', error);
    throw error;
  }
};

async function getSsmParameterValue(name: string): Promise<string> {
  const res = await ssm.send(new GetParameterCommand({ Name: name }));
  return res.Parameter?.Value || '';
}

function parseEmailList(value: string): string[] {
  return (value || '')
    .split(',')
    .map(v => v.trim())
    .filter(v => v.length > 0);
}

async function sendEmail(
  document: Document,
  from: string,
  recipients: string[]
): Promise<void> {
  const htmlContent = markdownToHtml(document.content);
  const subject = `【朝会ドキュメント】${document.projectName} - ${document.fileName}`;

  const raw = buildRawMimeEmail({
    from,
    to: recipients,
    subject,
    textBody: document.content,
    htmlBody: htmlContent,
    attachmentFileName: document.fileName,
    attachmentContent: document.content,
  });

  const command = new SendRawEmailCommand({
    Source: from,
    Destinations: recipients,
    RawMessage: {
      Data: Buffer.from(raw, 'utf-8'),
    },
  });

  await ses.send(command);
  console.log(`メール送信成功: ${document.fileName} -> ${recipients.join(', ')}`);
}

function buildRawMimeEmail(params: {
  from: string;
  to: string[];
  subject: string;
  textBody: string;
  htmlBody: string;
  attachmentFileName: string;
  attachmentContent: string; // markdown
}): string {
  const mixedBoundary = `mixed_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const altBoundary = `alt_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  const headers = [
    `From: ${params.from}`,
    `To: ${params.to.join(', ')}`,
    `Subject: ${encodeMimeHeader(params.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
  ].join('\r\n');

  const attachmentBase64 = toBase64Lines(Buffer.from(params.attachmentContent, 'utf-8').toString('base64'));

  const parts: string[] = [];

  // multipart/alternative (text + html)
  parts.push(
    [
      `--${mixedBoundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      '',
      `--${altBoundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      params.textBody,
      '',
      `--${altBoundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      params.htmlBody,
      '',
      `--${altBoundary}--`,
      '',
    ].join('\r\n')
  );

  // Attachment: markdown file
  parts.push(
    [
      `--${mixedBoundary}`,
      `Content-Type: text/markdown; name="${escapeHeaderValue(params.attachmentFileName)}"; charset="UTF-8"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${escapeHeaderValue(params.attachmentFileName)}"`,
      '',
      attachmentBase64,
      '',
    ].join('\r\n')
  );

  // closing boundary
  parts.push(`--${mixedBoundary}--\r\n`);

  return `${headers}\r\n\r\n${parts.join('')}`;
}

function toBase64Lines(base64: string, lineLength = 76): string {
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += lineLength) {
    lines.push(base64.slice(i, i + lineLength));
  }
  return lines.join('\r\n');
}

function encodeMimeHeader(value: string): string {
  // RFC 2047 (簡易): UTF-8 Base64
  const b64 = Buffer.from(value, 'utf-8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

function escapeHeaderValue(value: string): string {
  // very small sanitization for header parameters
  return value.replace(/"/g, "'").replace(/\r|\n/g, ' ');
}

function markdownToHtml(markdown: string): string {
  let html = markdown;

  // ヘッダー
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');

  // 太字
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // リンク
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');

  // コードブロック
  html = html.replace(/```[\s\S]*?```/g, (match) => {
    return `<pre><code>${match.replace(/```/g, '')}</code></pre>`;
  });

  // インラインコード
  html = html.replace(/`(.+?)`/g, '<code>$1</code>');

  // テーブル
  html = html.replace(/\|(.+)\|/g, (match, content) => {
    const cells = content.split('|').map(cell => cell.trim());
    return `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`;
  });

  // テーブルヘッダー
  html = html.replace(/\|:---\|/g, '');

  // リスト
  html = html.replace(/^\- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

  // 段落
  html = html.replace(/\n\n/g, '</p><p>');
  html = `<p>${html}</p>`;

  // 水平線
  html = html.replace(/^---$/gm, '<hr>');

  // HTMLエスケープ
  html = html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // スタイルを追加
  const styledHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; line-height: 1.6; color: #333; }
        table { border-collapse: collapse; width: 100%; margin: 1em 0; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; font-weight: bold; }
        code { background-color: #f4f4f4; padding: 2px 4px; border-radius: 3px; }
        pre { background-color: #f4f4f4; padding: 10px; border-radius: 5px; overflow-x: auto; }
        a { color: #0066cc; text-decoration: none; }
        a:hover { text-decoration: underline; }
        hr { border: none; border-top: 1px solid #ddd; margin: 1em 0; }
      </style>
    </head>
    <body>
      ${html}
    </body>
    </html>
  `;

  return styledHtml;
}


