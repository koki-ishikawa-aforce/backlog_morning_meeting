import { handler, markdownToHtml, markdownToPlainText } from './index';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';

const sesMock = mockClient(SESClient);
const ssmMock = mockClient(SSMClient);

describe('send-email', () => {
  beforeEach(() => {
    sesMock.reset();
    ssmMock.reset();
    jest.clearAllMocks();
    delete process.env.EMAIL_FROM_PARAM;
    delete process.env.EMAIL_RECIPIENTS_PARAM;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('正常系', () => {
    it('メールを正常に送信できる', async () => {
      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/email-from',
      }).resolves({
        Parameter: { Value: 'noreply@example.com' },
      });

      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/email-recipients',
      }).resolves({
        Parameter: { Value: 'user1@example.com,user2@example.com' },
      });

      sesMock.on(SendRawEmailCommand).resolves({
        MessageId: 'test-message-id',
      });

      const mockEvent = {
        documents: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            fileName: '20240120_【Project 1】朝会資料.md',
            content: '# Test Document\n\n## Test Section',
          },
        ],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.success).toBe(true);
      expect(result.message).toContain('1件のメールを送信しました');
      expect(sesMock.calls()).toHaveLength(1);
    });

    it('複数のドキュメントをメール送信できる', async () => {
      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/email-from',
      }).resolves({
        Parameter: { Value: 'noreply@example.com' },
      });

      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/email-recipients',
      }).resolves({
        Parameter: { Value: 'user1@example.com' },
      });

      sesMock.on(SendRawEmailCommand).resolves({
        MessageId: 'test-message-id',
      });

      const mockEvent = {
        documents: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            fileName: '20240120_【Project 1】朝会資料.md',
            content: '# Test Document 1',
          },
          {
            projectKey: 'PROJECT2',
            projectName: 'Project 2',
            fileName: '20240120_【Project 2】朝会資料.md',
            content: '# Test Document 2',
          },
        ],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.success).toBe(true);
      expect(result.message).toContain('2件のメールを送信しました');
      expect(sesMock.calls()).toHaveLength(2);
    });

    it('MarkdownをHTMLに変換して送信する', async () => {
      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/email-from',
      }).resolves({
        Parameter: { Value: 'noreply@example.com' },
      });

      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/email-recipients',
      }).resolves({
        Parameter: { Value: 'user@example.com' },
      });

      sesMock.on(SendRawEmailCommand).resolves({
        MessageId: 'test-message-id',
      });

      const mockEvent = {
        documents: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            fileName: '20240120_【Project 1】朝会資料.md',
            content: '# Header\n\n**Bold text**\n\n[Link](https://example.com)',
          },
        ],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.success).toBe(true);
      const sendCommand = sesMock.calls()[0].args[0] as SendRawEmailCommand;
      const rawMessage = sendCommand.input.RawMessage?.Data;
      expect(rawMessage).toBeDefined();
      if (rawMessage) {
        const messageStr = Buffer.from(rawMessage).toString('utf-8');
        expect(messageStr).toContain('text/html');
        expect(messageStr).toContain('text/plain');
        expect(messageStr).toContain('20240120_【Project 1】朝会資料.md');
      }
    });
  });

  describe('異常系', () => {
    it('ドキュメントが空の場合はエラーを返す', async () => {
      const mockEvent = {
        documents: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.success).toBe(false);
      expect(result.message).toBe('ドキュメントがありません');
    });

    it('EMAIL_FROMが取得できない場合はエラーを投げる', async () => {
      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/email-from',
      }).resolves({
        Parameter: { Value: '' }, // 空文字列を返す
      });

      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/email-recipients',
      }).resolves({
        Parameter: { Value: 'user@example.com' },
      });

      const mockEvent = {
        documents: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            fileName: '20240120_【Project 1】朝会資料.md',
            content: '# Test Document',
          },
        ],
      };

      await expect(handler(mockEvent, {} as any, jest.fn())).rejects.toThrow('EMAIL_FROMが取得できません');
    });

    it('EMAIL_RECIPIENTSが取得できない場合はエラーを投げる', async () => {
      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/email-from',
      }).resolves({
        Parameter: { Value: 'noreply@example.com' },
      });

      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/email-from',
      }).resolves({
        Parameter: { Value: 'noreply@example.com' },
      });

      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/email-recipients',
      }).resolves({
        Parameter: { Value: '' }, // 空文字列を返す
      });

      const mockEvent = {
        documents: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            fileName: '20240120_【Project 1】朝会資料.md',
            content: '# Test Document',
          },
        ],
      };

      await expect(handler(mockEvent, {} as any, jest.fn())).rejects.toThrow('EMAIL_RECIPIENTSが取得できません');
    });

    it('一部のメール送信が失敗しても成功した分は返す', async () => {
      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/email-from',
      }).resolves({
        Parameter: { Value: 'noreply@example.com' },
      });

      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/email-recipients',
      }).resolves({
        Parameter: { Value: 'user@example.com' },
      });

      let callCount = 0;
      sesMock.on(SendRawEmailCommand).callsFake(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ MessageId: 'test-message-id' });
        } else {
          return Promise.reject(new Error('SES Error'));
        }
      });

      const mockEvent = {
        documents: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            fileName: '20240120_【Project 1】朝会資料.md',
            content: '# Test Document 1',
          },
          {
            projectKey: 'PROJECT2',
            projectName: 'Project 2',
            fileName: '20240120_【Project 2】朝会資料.md',
            content: '# Test Document 2',
          },
        ],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.success).toBe(true);
      expect(result.message).toContain('失敗: 1件');
    });
  });

  describe('エッジケース', () => {
    it('メールアドレスが空の場合はエラーを投げる', async () => {
      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/email-from',
      }).resolves({
        Parameter: { Value: 'noreply@example.com' },
      });

      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/email-recipients',
      }).resolves({
        Parameter: { Value: '' },
      });

      const mockEvent = {
        documents: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            fileName: '20240120_【Project 1】朝会資料.md',
            content: '# Test Document',
          },
        ],
      };

      await expect(handler(mockEvent, {} as any, jest.fn())).rejects.toThrow();
    });

    it('カンマ区切りのメールアドレスリストを正しくパースする', async () => {
      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/email-from',
      }).resolves({
        Parameter: { Value: 'noreply@example.com' },
      });

      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/email-recipients',
      }).resolves({
        Parameter: { Value: 'user1@example.com, user2@example.com , user3@example.com' },
      });

      sesMock.on(SendRawEmailCommand).resolves({
        MessageId: 'test-message-id',
      });

      const mockEvent = {
        documents: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            fileName: '20240120_【Project 1】朝会資料.md',
            content: '# Test Document',
          },
        ],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.success).toBe(true);
      const sendCommand = sesMock.calls()[0].args[0] as SendRawEmailCommand;
      expect(sendCommand.input.Destinations).toHaveLength(3);
    });
  });
});

describe('markdownToHtml', () => {
  describe('HTMLエスケープの順序', () => {
    it('HTMLエスケープが最初に実行され、変換後のHTMLタグがエスケープされない', () => {
      const input = `# Header & <script>alert('xss')</script>`;
      const result = markdownToHtml(input);
      expect(result).toContain('<h1>Header &amp;');
      expect(result).toContain('&lt;script&gt;');
      expect(result).toContain('&lt;/script&gt;');
      expect(result).not.toContain('&lt;h1&gt;'); // HTMLタグはエスケープされない
    });
  });

  describe('ヘッダーの変換', () => {
    it('h1, h2, h3が正しく変換される', () => {
      const input = `# H1\n## H2\n### H3`;
      const result = markdownToHtml(input);
      expect(result).toContain('<h1>H1</h1>');
      expect(result).toContain('<h2>H2</h2>');
      expect(result).toContain('<h3>H3</h3>');
    });
  });

  describe('太字の変換', () => {
    it('**太字**が正しく変換される', () => {
      const input = `**太字テキスト**`;
      const result = markdownToHtml(input);
      expect(result).toContain('<strong>太字テキスト</strong>');
    });
  });

  describe('リンクの変換', () => {
    it('[リンク](URL)が正しく変換される', () => {
      const input = `[リンクテキスト](https://example.com)`;
      const result = markdownToHtml(input);
      expect(result).toContain('<a href="https://example.com">リンクテキスト</a>');
    });
  });

  describe('コードブロックの変換', () => {
    it('コードブロックが正しく変換される', () => {
      const input = '```\ncode\n```';
      const result = markdownToHtml(input);
      expect(result).toContain('<pre><code>code</code></pre>');
    });
  });

  describe('インラインコードの変換', () => {
    it('インラインコードが正しく変換される', () => {
      const input = '`code`';
      const result = markdownToHtml(input);
      expect(result).toContain('<code>code</code>');
    });
  });

  describe('テーブルの変換', () => {
    it('単純なテーブルが正しくHTMLに変換される', () => {
      const input = `| 項目 | 件数 |\n|:---|:---:|\n| 本日対応予定 | 5件 |`;
      const result = markdownToHtml(input);
      expect(result).toContain('<table>');
      expect(result).toContain('<thead>');
      expect(result).toContain('<tbody>');
      expect(result).toContain('<th>項目</th>');
      expect(result).toContain('<th>件数</th>');
      expect(result).toContain('<td>本日対応予定</td>');
      expect(result).toContain('<td>5件</td>');
    });

    it('複数行のテーブルが正しくHTMLに変換される', () => {
      const input = `| 課題キー | 課題名 | ステータス |\n|:---|:---|:---|\n| PROJECT-1 | 課題1 | 未対応 |\n| PROJECT-2 | 課題2 | 対応中 |`;
      const result = markdownToHtml(input);
      expect(result).toContain('<table>');
      expect(result).toContain('<thead>');
      expect(result).toContain('<tbody>');
      expect(result).toContain('<td>PROJECT-1</td>');
      expect(result).toContain('<td>PROJECT-2</td>');
    });
  });

  describe('リストの変換', () => {
    it('順序なしリストが正しく変換される', () => {
      const input = `- 項目1\n- 項目2\n- 項目3`;
      const result = markdownToHtml(input);
      expect(result).toContain('<ul>');
      expect(result).toContain('<li>項目1</li>');
      expect(result).toContain('<li>項目2</li>');
      expect(result).toContain('<li>項目3</li>');
    });
  });

  describe('段落の変換', () => {
    it('空行で区切られた段落が正しく変換される', () => {
      const input = `段落1\n\n段落2`;
      const result = markdownToHtml(input);
      expect(result).toContain('<p>段落1</p>');
      expect(result).toContain('<p>段落2</p>');
    });
  });

  describe('水平線の変換', () => {
    it('水平線が正しく変換される', () => {
      const input = `---`;
      const result = markdownToHtml(input);
      expect(result).toContain('<hr>');
    });
  });

  describe('特殊文字のエスケープ', () => {
    it('HTML特殊文字が正しくエスケープされる', () => {
      const input = `テキスト & <script> & "引用"`;
      const result = markdownToHtml(input);
      expect(result).toContain('&amp;');
      expect(result).toContain('&lt;script&gt;');
      expect(result).toContain('&quot;引用&quot;');
    });
  });

  describe('絵文字の処理', () => {
    it('絵文字が正しく表示される', () => {
      const input = `## 📊 サマリー`;
      const result = markdownToHtml(input);
      expect(result).toContain('<h2>📊 サマリー</h2>');
    });
  });

  describe('複合的なMarkdownの変換', () => {
    it('実際の朝会ドキュメント形式が正しく変換される', () => {
      const input = `# 【朝会ドキュメント】2024/01/20 - Project 1

生成時刻: 10:00

## 📊 サマリー

| 項目 | 件数 |
|:---|:---:|
| 本日対応予定 | 2件 |
| 未完了課題 | 1件 |

## 📅 本日対応予定の課題

### 担当者1

| 課題キー | 課題名 | ステータス |
|:---|:---|:---|
| PROJECT-1 | 課題1 | 未対応 |

## 📝 議事録

### 担当者1

- 項目1
- 項目2

<!-- ここに議事録を記入 -->`;
      const result = markdownToHtml(input);
      expect(result).toContain('<h1>');
      expect(result).toContain('<h2>');
      expect(result).toContain('<h3>');
      expect(result).toContain('<table>');
      expect(result).toContain('<ul>');
    });
  });
});

describe('markdownToPlainText', () => {
  describe('ヘッダーの変換', () => {
    it('ヘッダーがプレーンテキストに変換される', () => {
      const input = `# H1\n## H2`;
      const result = markdownToPlainText(input);
      expect(result).toContain('H1');
      expect(result).toContain('H2');
      expect(result).not.toContain('#');
    });
  });

  describe('太字の変換', () => {
    it('太字記号が削除される', () => {
      const input = `**太字テキスト**`;
      const result = markdownToPlainText(input);
      expect(result).toBe('太字テキスト');
    });
  });

  describe('リンクの変換', () => {
    it('リンクがテキスト (URL)形式に変換される', () => {
      const input = `[リンクテキスト](https://example.com)`;
      const result = markdownToPlainText(input);
      expect(result).toBe('リンクテキスト (https://example.com)');
    });
  });

  describe('コードブロックの変換', () => {
    it('コードブロック記号が削除される', () => {
      const input = '```\ncode\n```';
      const result = markdownToPlainText(input);
      expect(result).toContain('code');
      expect(result).not.toContain('```');
    });
  });

  describe('インラインコードの変換', () => {
    it('インラインコード記号が削除される', () => {
      const input = '`code`';
      const result = markdownToPlainText(input);
      expect(result).toBe('code');
    });
  });

  describe('テーブルの変換', () => {
    it('テーブルが簡易的なテキスト形式に変換される', () => {
      const input = `| 項目 | 件数 |\n|:---|:---:|\n| 本日対応予定 | 5件 |`;
      const result = markdownToPlainText(input);
      expect(result).toContain('項目');
      expect(result).toContain('件数');
      expect(result).toContain('本日対応予定');
      expect(result).toContain('5件');
    });
  });

  describe('リストの変換', () => {
    it('リスト記号が削除される', () => {
      const input = `- 項目1\n- 項目2`;
      const result = markdownToPlainText(input);
      expect(result).toContain('項目1');
      expect(result).toContain('項目2');
    });
  });

  describe('水平線の変換', () => {
    it('水平線が空行に変換される', () => {
      const input = `---`;
      const result = markdownToPlainText(input);
      expect(result).not.toContain('---');
    });
  });

  describe('複合的なMarkdownの変換', () => {
    it('実際の朝会ドキュメントが読みやすいプレーンテキストに変換される', () => {
      const input = `# 【朝会ドキュメント】2024/01/20 - Project 1

## 📊 サマリー

| 項目 | 件数 |
|:---|:---:|
| 本日対応予定 | 2件 |

- 項目1
- 項目2

[リンク](https://example.com)`;
      const result = markdownToPlainText(input);
      expect(result).not.toContain('#');
      expect(result).not.toContain('**');
      expect(result).not.toContain('```');
      expect(result).toContain('リンク (https://example.com)');
    });
  });

  describe('エッジケース', () => {
    it('空のMarkdownが正しく処理される', () => {
      const result = markdownToPlainText('');
      expect(result).toBe('');
    });

    it('プレーンテキストのみが正しく処理される', () => {
      const input = `これは普通のテキストです。`;
      const result = markdownToPlainText(input);
      expect(result).toBe('これは普通のテキストです。');
    });
  });
});

describe('sendEmail - HTML/PlainText統合', () => {
  beforeEach(() => {
    sesMock.reset();
    ssmMock.reset();
    jest.clearAllMocks();
  });

  it('メールにHTML本文とプレーンテキスト本文の両方が含まれる', async () => {
    ssmMock.on(GetParameterCommand, {
      Name: '/backlog-morning-meeting/email-from',
    }).resolves({
      Parameter: { Value: 'noreply@example.com' },
    });

    ssmMock.on(GetParameterCommand, {
      Name: '/backlog-morning-meeting/email-recipients',
    }).resolves({
      Parameter: { Value: 'user@example.com' },
    });

    sesMock.on(SendRawEmailCommand).resolves({
      MessageId: 'test-message-id',
    });

    const mockEvent = {
      documents: [
        {
          projectKey: 'PROJECT1',
          projectName: 'Project 1',
          fileName: 'morning-meeting-PROJECT1-2024-01-20.md',
          content: '# Test Document\n\n**Bold**',
        },
      ],
    };

    const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

    expect(result.success).toBe(true);
    const sendCommand = sesMock.calls()[0].args[0] as SendRawEmailCommand;
    const rawMessage = sendCommand.input.RawMessage?.Data;
    expect(rawMessage).toBeDefined();
    if (rawMessage) {
      const messageStr = Buffer.from(rawMessage).toString('utf-8');
      expect(messageStr).toContain('multipart/alternative');
      expect(messageStr).toContain('Content-Type: text/plain');
      expect(messageStr).toContain('Content-Type: text/html');
      // プレーンテキスト版にはMarkdown記法が含まれていないことを確認
      const plainTextMatch = messageStr.match(/Content-Type: text\/plain[\s\S]*?(?=Content-Type: text\/html)/);
      if (plainTextMatch) {
        const plainText = plainTextMatch[0];
        expect(plainText).not.toContain('**');
        expect(plainText).not.toContain('#');
      }
    }
  });

  describe('議事録セクションの除外', () => {
    it('メール本文には議事録セクションが含まれない', async () => {
      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/email-from',
      }).resolves({
        Parameter: { Value: 'noreply@example.com' },
      });

      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/email-recipients',
      }).resolves({
        Parameter: { Value: 'user@example.com' },
      });

      sesMock.on(SendRawEmailCommand).resolves({
        MessageId: 'test-message-id',
      });

      const mockEvent = {
        documents: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            fileName: '20240120_【Project 1】朝会資料.md',
            content: `# 【朝会ドキュメント】2024/01/20 - Project 1

生成時刻: 10:00

## 📊 サマリー

| 項目 | 件数 |
|:---|:---:|
| 本日対応予定 | 0件 |

## 📝 議事録

### Test User

<!-- ここにTest Userの議事録を記入してください -->

---`,
          },
        ],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.success).toBe(true);
      const sendCommand = sesMock.calls()[0].args[0] as SendRawEmailCommand;
      const rawMessage = sendCommand.input.RawMessage?.Data;
      expect(rawMessage).toBeDefined();
      if (rawMessage) {
        const messageStr = Buffer.from(rawMessage).toString('utf-8');
        // メール本文には議事録セクションが含まれない
        expect(messageStr).not.toContain('## 📝 議事録');
        expect(messageStr).not.toContain('Test User');
        // 添付ファイルには議事録セクションが含まれる
        expect(messageStr).toContain('20240120_【Project 1】朝会資料.md');
        // Base64エンコードされた添付ファイルに議事録が含まれることを確認
        // Content-Transfer-Encoding: base64 の後のBase64データを抽出
        const attachmentMatch = messageStr.match(/Content-Transfer-Encoding: base64[\s\S]*?\r\n\r\n([A-Za-z0-9+\/=\s\r\n]+?)(?=\r\n--|$)/);
        if (attachmentMatch) {
          const attachmentBase64 = attachmentMatch[1].replace(/[\s\r\n]/g, '');
          const attachmentContent = Buffer.from(attachmentBase64, 'base64').toString('utf-8');
          expect(attachmentContent).toContain('## 📝 議事録');
          expect(attachmentContent).toContain('Test User');
        }
      }
    });
  });
});
