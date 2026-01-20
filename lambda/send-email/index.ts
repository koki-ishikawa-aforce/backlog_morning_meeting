import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { Handler } from 'aws-lambda';

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
      documents.map((doc: Document) => sendEmail(doc, emailFrom, emailRecipients))
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
  const plainTextContent = markdownToPlainText(document.content);
  const subject = `【朝会ドキュメント】${document.projectName} - ${document.fileName}`;

  const raw = buildRawMimeEmail({
    from,
    to: recipients,
    subject,
    textBody: plainTextContent,
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

// HTMLエスケープ関数
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function markdownToHtml(markdown: string): string {
  let html = markdown;

  // 1. コードブロックを一時的に保護（エスケープ前に保護）
  const codeBlockPlaceholders: string[] = [];
  html = html.replace(/```([\s\S]*?)```/g, (match, code) => {
    const placeholder = `__CODEBLOCK${codeBlockPlaceholders.length}__`;
    // コード内容をエスケープしてからpre/codeタグで囲む
    // 改行はそのまま保持（段落処理の影響を受けないように）
    const escapedCode = escapeHtml(code.trim());
    codeBlockPlaceholders.push(`<pre><code>${escapedCode}</code></pre>`);
    return placeholder;
  });

  // 2. インラインコードを一時的に保護
  const inlineCodePlaceholders: string[] = [];
  html = html.replace(/`([^`]+)`/g, (match, code) => {
    const placeholder = `__INLINECODE${inlineCodePlaceholders.length}__`;
    const escapedCode = escapeHtml(code);
    inlineCodePlaceholders.push(`<code>${escapedCode}</code>`);
    return placeholder;
  });

  // 3. リンクを一時的に保護（URLはエスケープしない、テキストは後でエスケープ）
  interface LinkInfo {
    text: string;
    url: string;
  }
  const linkPlaceholders: LinkInfo[] = [];
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
    const placeholder = `__LINK${linkPlaceholders.length}__`;
    linkPlaceholders.push({ text, url });
    return placeholder;
  });

  // 4. HTMLエスケープ（特殊文字をエスケープ）
  // プレースホルダーはアンダースコアと英数字のみなのでエスケープされないが、
  // 念のためエスケープ後に復元する
  html = escapeHtml(html);

  // 5. リンクを復元（テキストはエスケープ済み）
  linkPlaceholders.forEach((link, index) => {
    // プレースホルダー内のテキストは既にエスケープされているので、そのまま使用
    // ただし、プレースホルダー自体がエスケープされている可能性があるので、元のテキストをエスケープ
    const escapedText = escapeHtml(link.text);
    html = html.replace(`__LINK${index}__`, `<a href="${link.url}">${escapedText}</a>`);
  });

  // 6. 太字を変換（**はエスケープされないので、そのまま変換可能）
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // 7. 水平線を変換
  html = html.replace(/^---$/gm, '<hr>');

  // 8. ヘッダーを変換（段落処理の前に）
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // 9. テーブル処理（改善版）
  html = processTables(html);

  // 10. リスト処理（改善版）
  html = processLists(html);

  // 11. コードブロックとインラインコードを復元（段落処理の前に）
  codeBlockPlaceholders.forEach((placeholder, index) => {
    html = html.replace(`__CODEBLOCK${index}__`, placeholder);
  });
  inlineCodePlaceholders.forEach((placeholder, index) => {
    html = html.replace(`__INLINECODE${index}__`, placeholder);
  });

  // 12. 段落処理（改善版）- 最後に実行
  html = processParagraphs(html);

  // 12. スタイルを追加
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

// テーブル処理関数（改善版）
function processTables(html: string): string {
  const lines = html.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // テーブル行の検出（|で始まり|で終わる）
    if (/^\|.+\|$/.test(line.trim())) {
      const tableRows: string[] = [];
      let isHeader = false;
      let headerRow: string | null = null;

      // テーブルブロックを収集
      while (i < lines.length && /^\|.+\|$/.test(lines[i].trim())) {
        const currentLine = lines[i].trim();
        
        // ヘッダー区切り行（|:---|など）を検出
        if (/^\|[\s:|-]+\|$/.test(currentLine)) {
          isHeader = true;
          i++;
          continue;
        }

        tableRows.push(currentLine);
        i++;
      }

      // テーブルを生成
      if (tableRows.length > 0) {
        let tableHtml = '<table>';
        
        // ヘッダー行がある場合
        if (isHeader && tableRows.length > 0) {
          tableHtml += '<thead><tr>';
          const headerCells = tableRows[0].split('|').slice(1, -1).map((cell: string) => cell.trim());
          headerCells.forEach((cell: string) => {
            tableHtml += `<th>${cell}</th>`;
          });
          tableHtml += '</tr></thead>';
          tableRows.shift(); // ヘッダー行を削除
        }

        // データ行
        if (tableRows.length > 0) {
          tableHtml += '<tbody>';
          tableRows.forEach((row: string) => {
            tableHtml += '<tr>';
            const cells = row.split('|').slice(1, -1).map((cell: string) => cell.trim());
            cells.forEach((cell: string) => {
              tableHtml += `<td>${cell}</td>`;
            });
            tableHtml += '</tr>';
          });
          tableHtml += '</tbody>';
        }

        tableHtml += '</table>';
        result.push(tableHtml);
      }
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join('\n');
}

// リスト処理関数（改善版）
function processLists(html: string): string {
  const lines = html.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // リスト項目の検出（- で始まる）
    if (/^[\s]*[-*+]\s+/.test(line)) {
      const listItems: string[] = [];
      
      // リストブロックを収集
      while (i < lines.length && (/^[\s]*[-*+]\s+/.test(lines[i]) || lines[i].trim() === '')) {
        if (lines[i].trim() === '') {
          i++;
          continue;
        }
        const match = lines[i].match(/^[\s]*[-*+]\s+(.+)$/);
        if (match) {
          listItems.push(match[1]);
        }
        i++;
      }

      // リストを生成
      if (listItems.length > 0) {
        let listHtml = '<ul>';
        listItems.forEach((item: string) => {
          listHtml += `<li>${item}</li>`;
        });
        listHtml += '</ul>';
        result.push(listHtml);
      }
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join('\n');
}

// 段落処理関数（改善版）
function processParagraphs(html: string): string {
  const lines = html.split('\n');
  const result: string[] = [];
  let currentParagraph: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // 空行の場合、現在の段落を閉じる
    if (line === '') {
      if (currentParagraph.length > 0) {
        const paraText = currentParagraph.join(' ');
        // 既にHTMLタグで囲まれている場合はそのまま
        if (/^<[^>]+>/.test(paraText) || paraText.startsWith('<table') || paraText.startsWith('<ul') || paraText.startsWith('<ol') || paraText.startsWith('<h1') || paraText.startsWith('<h2') || paraText.startsWith('<h3') || paraText.startsWith('<hr') || paraText.startsWith('<pre')) {
          result.push(paraText);
        } else {
          result.push(`<p>${paraText}</p>`);
        }
        currentParagraph = [];
      }
      continue;
    }

    // コードブロックのプレースホルダーを含む行はそのまま追加
    if (line.includes('__CODEBLOCK') || line.includes('__INLINECODE')) {
      if (currentParagraph.length > 0) {
        const paraText = currentParagraph.join(' ');
        result.push(`<p>${paraText}</p>`);
        currentParagraph = [];
      }
      result.push(line);
      continue;
    }

    // HTMLタグで始まる行はそのまま追加
    if (/^<[^>]+>/.test(line) || line.startsWith('<table') || line.startsWith('<ul') || line.startsWith('<ol') || line.startsWith('<h1') || line.startsWith('<h2') || line.startsWith('<h3') || line.startsWith('<hr') || line.startsWith('<pre')) {
      if (currentParagraph.length > 0) {
        const paraText = currentParagraph.join(' ');
        result.push(`<p>${paraText}</p>`);
        currentParagraph = [];
      }
      result.push(line);
      continue;
    }

    // 通常のテキスト行
    currentParagraph.push(line);
  }

  // 最後の段落を処理
  if (currentParagraph.length > 0) {
    const paraText = currentParagraph.join(' ');
    if (/^<[^>]+>/.test(paraText) || paraText.startsWith('<table') || paraText.startsWith('<ul') || paraText.startsWith('<ol') || paraText.startsWith('<h1') || paraText.startsWith('<h2') || paraText.startsWith('<h3') || paraText.startsWith('<hr') || paraText.startsWith('<pre')) {
      result.push(paraText);
    } else {
      result.push(`<p>${paraText}</p>`);
    }
  }

  return result.join('\n');
}

// プレーンテキスト変換関数
export function markdownToPlainText(markdown: string): string {
  let text = markdown;

  // コードブロックを削除（内容は残す）
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    return match.replace(/```/g, '').trim();
  });

  // インラインコードの記号を削除
  text = text.replace(/`([^`]+)`/g, '$1');

  // リンクを変換: [テキスト](URL) -> テキスト (URL)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // 太字記号を削除
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');

  // ヘッダー記号を削除
  text = text.replace(/^#{1,3}\s+(.+)$/gm, '$1');

  // 水平線を空行に変換
  text = text.replace(/^---$/gm, '');

  // リスト記号を削除（またはそのまま残す）
  text = text.replace(/^[\s]*[-*+]\s+(.+)$/gm, '$1');

  // テーブルヘッダー区切り行を削除
  text = text.replace(/^\|[\s:|-]+\|$/gm, '');

  // テーブルの|記号は残す（見やすさのため）
  // または削除する場合は以下のコメントを外す
  // text = text.replace(/\|/g, ' ');

  // 連続する空行を1つに
  text = text.replace(/\n{3,}/g, '\n\n');

  // 前後の空白を削除
  text = text.trim();

  return text;
}


