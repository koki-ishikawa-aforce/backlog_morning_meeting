import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { Handler } from 'aws-lambda';

const ses = new SESClient({});

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

    const emailFrom = process.env.EMAIL_FROM;
    const emailRecipients = (process.env.EMAIL_RECIPIENTS || '').split(',').map(e => e.trim()).filter(e => e);

    if (!emailFrom) {
      throw new Error('EMAIL_FROM環境変数が設定されていません');
    }

    if (emailRecipients.length === 0) {
      throw new Error('EMAIL_RECIPIENTS環境変数が設定されていません');
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

async function sendEmail(
  document: Document,
  from: string,
  recipients: string[]
): Promise<void> {
  const htmlContent = markdownToHtml(document.content);
  const subject = `【朝会ドキュメント】${document.projectName} - ${document.fileName}`;

  const command = new SendEmailCommand({
    Source: from,
    Destination: {
      ToAddresses: recipients,
    },
    Message: {
      Subject: {
        Data: subject,
        Charset: 'UTF-8',
      },
      Body: {
        Html: {
          Data: htmlContent,
          Charset: 'UTF-8',
        },
        Text: {
          Data: document.content,
          Charset: 'UTF-8',
        },
      },
    },
  });

  await ses.send(command);
  console.log(`メール送信成功: ${document.fileName} -> ${recipients.join(', ')}`);
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

