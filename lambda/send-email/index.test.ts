import { handler } from './index';
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
            fileName: 'morning-meeting-PROJECT1-2024-01-20.md',
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
            fileName: 'morning-meeting-PROJECT1-2024-01-20.md',
            content: '# Test Document 1',
          },
          {
            projectKey: 'PROJECT2',
            projectName: 'Project 2',
            fileName: 'morning-meeting-PROJECT2-2024-01-20.md',
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
            fileName: 'morning-meeting-PROJECT1-2024-01-20.md',
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
        expect(messageStr).toContain('morning-meeting-PROJECT1-2024-01-20.md');
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
            fileName: 'morning-meeting-PROJECT1-2024-01-20.md',
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
            fileName: 'morning-meeting-PROJECT1-2024-01-20.md',
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
            fileName: 'morning-meeting-PROJECT1-2024-01-20.md',
            content: '# Test Document 1',
          },
          {
            projectKey: 'PROJECT2',
            projectName: 'Project 2',
            fileName: 'morning-meeting-PROJECT2-2024-01-20.md',
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
            fileName: 'morning-meeting-PROJECT1-2024-01-20.md',
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
            fileName: 'morning-meeting-PROJECT1-2024-01-20.md',
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
