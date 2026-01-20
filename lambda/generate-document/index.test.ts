import { handler } from './index';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';

const secretsManagerMock = mockClient(SecretsManagerClient);

// fetchのモック
global.fetch = jest.fn() as jest.Mock;

describe('generate-document', () => {
  beforeEach(() => {
    secretsManagerMock.reset();
    jest.clearAllMocks();
    delete process.env.OPENAI_API_KEY_SECRET_NAME;
    delete process.env.OPENAI_MODEL;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('正常系', () => {
    it('Markdownドキュメントを正常に生成できる（OpenAIなし）', async () => {
      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            issues: [
              {
                id: 1,
                issueKey: 'PROJECT1-1',
                summary: 'Test Issue',
                description: 'Test Description',
                status: { id: 1, name: '未対応' },
                assignee: { id: 1, name: 'Test User' },
                dueDate: '2024-01-20',
                startDate: new Date().toISOString().split('T')[0],
                priority: { id: 1, name: '高' },
                category: [],
                url: 'https://example.com/view/PROJECT1-1',
                project: { id: 1, projectKey: 'PROJECT1', name: 'Project 1' },
              },
            ],
          },
        ],
        activeAssigneeIds: [1],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result).toHaveProperty('documents');
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0]).toHaveProperty('projectKey', 'PROJECT1');
      expect(result.documents[0]).toHaveProperty('projectName', 'Project 1');
      expect(result.documents[0]).toHaveProperty('fileName');
      expect(result.documents[0]).toHaveProperty('content');
      expect(result.documents[0].content).toContain('【朝会ドキュメント】');
      expect(result.documents[0].content).toContain('Project 1');
    });

    it('複数プロジェクトのドキュメントを生成できる', async () => {
      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            issues: [],
          },
          {
            projectKey: 'PROJECT2',
            projectName: 'Project 2',
            issues: [],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.documents).toHaveLength(2);
      expect(result.documents[0].projectKey).toBe('PROJECT1');
      expect(result.documents[1].projectKey).toBe('PROJECT2');
    });

    it('OpenAI APIを使用してドキュメントを生成できる', async () => {
      process.env.OPENAI_API_KEY_SECRET_NAME = 'backlog-morning-meeting/openai-api-key';
      process.env.OPENAI_MODEL = 'gpt-4o-mini';

      secretsManagerMock.on(GetSecretValueCommand, {
        SecretId: 'backlog-morning-meeting/openai-api-key',
      }).resolves({
        SecretString: JSON.stringify({ apiKey: 'sk-test-key' }),
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({
          choices: [{
            message: {
              content: '# 【朝会ドキュメント】2024/01/20 - Project 1\n\n生成時刻: 10:00\n\n## 📊 サマリー\n\n| 項目 | 件数 |\n|:---|:---:|\n| 本日対応予定 | 0件 |\n',
            },
          }],
        }),
      });

      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            issues: [],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.documents).toHaveLength(1);
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe('異常系', () => {
    it('OpenAI APIが失敗した場合はフォールバックで生成する', async () => {
      process.env.OPENAI_API_KEY_SECRET_NAME = 'backlog-morning-meeting/openai-api-key';

      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: JSON.stringify({ apiKey: 'sk-test-key' }),
      });

      (global.fetch as jest.Mock).mockRejectedValue(new Error('API Error'));

      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            issues: [],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      // フォールバックで生成される
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].content).toContain('【朝会ドキュメント】');
    });
  });

  describe('エッジケース', () => {
    it('課題が0件の場合でもドキュメントを生成できる', async () => {
      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            issues: [],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].content).toContain('本日対応予定 | 0件');
    });

    it('担当者が未割り当ての課題も処理できる', async () => {
      const today = new Date().toISOString().split('T')[0];
      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            issues: [
              {
                id: 1,
                issueKey: 'PROJECT1-1',
                summary: 'Test Issue',
                description: '',
                status: { id: 1, name: '未対応' },
                startDate: today,
                dueDate: today, // 本日対応予定として表示される（startDate <= today && dueDate >= today）
                priority: { id: 1, name: '中' },
                url: 'https://example.com/view/PROJECT1-1',
                project: { id: 1, projectKey: 'PROJECT1', name: 'Project 1' },
              },
            ],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.documents[0].content).toContain('未割り当て');
    });

    it('本日対応予定の課題は開始日から期限日の期間に今日が含まれる課題を抽出する', async () => {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      
      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            issues: [
              {
                id: 1,
                issueKey: 'PROJECT1-1',
                summary: '本日対応予定の課題（開始日が昨日、期限日が明日）',
                description: '',
                status: { id: 1, name: '未対応' },
                assignee: { id: 1, name: 'Test User' },
                startDate: yesterday,
                dueDate: tomorrow, // 開始日 <= today && 期限日 >= today なので本日対応予定
                priority: { id: 1, name: '中' },
                category: [],
                url: 'https://example.com/view/PROJECT1-1',
                project: { id: 1, projectKey: 'PROJECT1', name: 'Project 1' },
              },
              {
                id: 2,
                issueKey: 'PROJECT1-2',
                summary: '本日対応予定ではない課題（開始日が明日）',
                description: '',
                status: { id: 1, name: '未対応' },
                assignee: { id: 1, name: 'Test User' },
                startDate: tomorrow,
                dueDate: tomorrow,
                priority: { id: 1, name: '中' },
                category: [],
                url: 'https://example.com/view/PROJECT1-2',
                project: { id: 1, projectKey: 'PROJECT1', name: 'Project 1' },
              },
            ],
          },
        ],
        activeAssigneeIds: [1],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.documents[0].content).toContain('本日対応予定の課題（開始日が昨日、期限日が明日）');
      expect(result.documents[0].content).not.toContain('本日対応予定ではない課題（開始日が明日）');
    });

    it('今日締め切りの課題を正しく抽出する', async () => {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      
      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            issues: [
              {
                id: 1,
                issueKey: 'PROJECT1-1',
                summary: '今日締め切りの課題',
                description: '',
                status: { id: 1, name: '未対応' },
                assignee: { id: 1, name: 'Test User' },
                startDate: yesterday,
                dueDate: today, // 今日締め切り
                priority: { id: 1, name: '中' },
                category: [],
                url: 'https://example.com/view/PROJECT1-1',
                project: { id: 1, projectKey: 'PROJECT1', name: 'Project 1' },
              },
            ],
          },
        ],
        activeAssigneeIds: [1],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.documents[0].content).toContain('今日締め切りの課題');
      expect(result.documents[0].content).toContain('今日締め切り');
    });

    it('テーブルの列順序が開始日、期限日の順になっている', async () => {
      const today = new Date().toISOString().split('T')[0];
      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            issues: [
              {
                id: 1,
                issueKey: 'PROJECT1-1',
                summary: 'Test Issue',
                description: '',
                status: { id: 1, name: '未対応' },
                assignee: { id: 1, name: 'Test User' },
                startDate: today,
                dueDate: today,
                priority: { id: 1, name: '中' },
                category: [],
                url: 'https://example.com/view/PROJECT1-1',
                project: { id: 1, projectKey: 'PROJECT1', name: 'Project 1' },
              },
            ],
          },
        ],
        activeAssigneeIds: [1],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      const content = result.documents[0].content;
      const headerIndex = content.indexOf('| 課題キー | 課題名 | ステータス |');
      const startDateIndex = content.indexOf('開始日', headerIndex);
      const dueDateIndex = content.indexOf('期限日', headerIndex);
      
      expect(startDateIndex).toBeLessThan(dueDateIndex);
    });
  });
});
