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

  // テスト用の課題データを生成するヘルパー
  const createIssue = (overrides: any = {}) => ({
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
    ...overrides,
  });

  describe('正常系', () => {
    it('Markdownドキュメントを正常に生成できる（OpenAIなし）', async () => {
      const testIssue = createIssue();
      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [testIssue] }],
            incompleteIssues: [],
            dueTodayIssues: [],
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
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
          },
          {
            projectKey: 'PROJECT2',
            projectName: 'Project 2',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
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
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
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
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
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
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
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
      const unassignedIssue = {
        id: 1,
        issueKey: 'PROJECT1-1',
        summary: 'Test Issue',
        description: '',
        status: { id: 1, name: '未対応' },
        startDate: today,
        dueDate: today,
        priority: { id: 1, name: '中' },
        url: 'https://example.com/view/PROJECT1-1',
        project: { id: 1, projectKey: 'PROJECT1', name: 'Project 1' },
      };
      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [{ assigneeName: '未割り当て', issues: [unassignedIssue] }],
            incompleteIssues: [],
            dueTodayIssues: [],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.documents[0].content).toContain('未割り当て');
    });

    it('本日対応予定の課題がドキュメントに正しく出力される', async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      // 分類済みのデータを作成
      const todayIssue = {
        id: 1,
        issueKey: 'PROJECT1-1',
        summary: '本日対応予定の課題',
        description: '',
        status: { id: 1, name: '未対応' },
        assignee: { id: 1, name: 'Test User' },
        startDate: yesterday,
        dueDate: tomorrow,
        priority: { id: 1, name: '中' },
        category: [],
        url: 'https://example.com/view/PROJECT1-1',
        project: { id: 1, projectKey: 'PROJECT1', name: 'Project 1' },
      };

      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [todayIssue] }],
            incompleteIssues: [],
            dueTodayIssues: [],
          },
        ],
        activeAssigneeIds: [1],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.documents[0].content).toContain('本日対応予定の課題');
      expect(result.documents[0].content).toContain('📅 本日対応予定の課題');
    });

    it('今日締め切りの課題がドキュメントに正しく出力される', async () => {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      
      const dueTodayIssue = {
        id: 1,
        issueKey: 'PROJECT1-1',
        summary: '今日締め切りの課題',
        description: '',
        status: { id: 1, name: '未対応' },
        assignee: { id: 1, name: 'Test User' },
        startDate: yesterday,
        dueDate: today,
        priority: { id: 1, name: '中' },
        category: [],
        url: 'https://example.com/view/PROJECT1-1',
        project: { id: 1, projectKey: 'PROJECT1', name: 'Project 1' },
      };

      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [dueTodayIssue] }],
          },
        ],
        activeAssigneeIds: [1],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.documents[0].content).toContain('今日締め切りの課題');
      expect(result.documents[0].content).toContain('🔔 今日締め切りの課題');
    });

    it('テーブルの列順序が開始日、期限日の順になっている', async () => {
      const today = new Date().toISOString().split('T')[0];
      const testIssue = {
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
      };
      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [testIssue] }],
            incompleteIssues: [],
            dueTodayIssues: [],
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

    it('同じ課題が複数のリストに含まれる場合もそれぞれのセクションに表示される', async () => {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      
      // 同じ課題が3つすべてのリストに含まれるケース
      const sharedIssue = {
        id: 1,
        issueKey: 'PROJECT1-1',
        summary: '複数セクションに表示される課題',
        description: '',
        status: { id: 1, name: '未対応' },
        assignee: { id: 1, name: 'Test User' },
        startDate: yesterday,
        dueDate: today,
        priority: { id: 1, name: '中' },
        category: [],
        url: 'https://example.com/view/PROJECT1-1',
        project: { id: 1, projectKey: 'PROJECT1', name: 'Project 1' },
      };

      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [sharedIssue] }],
            incompleteIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [sharedIssue] }],
            dueTodayIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [sharedIssue] }],
          },
        ],
        activeAssigneeIds: [1],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      const content = result.documents[0].content;
      // すべてのセクションが存在することを確認
      expect(content).toContain('📅 本日対応予定の課題');
      expect(content).toContain('⚠️ 期限超過・未完了の課題');
      expect(content).toContain('🔔 今日締め切りの課題');
      
      // 課題キーがドキュメントに3回出現することを確認（各セクションで1回ずつ）
      const occurrences = (content.match(/PROJECT1-1/g) || []).length;
      expect(occurrences).toBeGreaterThanOrEqual(3);
    });
  });
});
