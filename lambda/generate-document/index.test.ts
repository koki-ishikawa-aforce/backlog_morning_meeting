import { handler } from './index';

describe('generate-document', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    it('Markdownドキュメントを正常に生成できる', async () => {
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

    it('課題の説明文がドキュメントに含まれない', async () => {
      const testIssue = createIssue({
        description: 'この説明文は出力されないはず',
      });
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

      expect(result.documents[0].content).not.toContain('の説明:');
      expect(result.documents[0].content).not.toContain('この説明文は出力されないはず');
    });
  });

  describe('MTGセクション', () => {
    // テスト用のMTG課題データを生成するヘルパー
    const createMtgIssue = (overrides: any = {}) => ({
      issueKey: 'PROJECT1-100',
      summary: '進捗確認MTG',
      description: '参加者情報など',
      url: 'https://example.backlog.com/view/PROJECT1-100',
      startDate: '2026-01-24',
      dueDate: '2026-01-24',
      purpose: 'プロジェクト進捗確認',
      datetime: '14:00〜15:00',
      internalParticipants: ['山田太郎', '鈴木花子'],
      externalParticipants: ['田中様（ABC株式会社）'],
      mtgUrl: 'https://zoom.us/j/123456789',
      ...overrides,
    });

    it('「本日のミーティング予定」セクションが生成される', async () => {
      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
            mtgIssues: [createMtgIssue()],
            backlogUsers: [{ id: 1, name: '山田太郎' }],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.documents[0].content).toContain('### 📅 本日のミーティング予定');
    });

    it('MTGの目的が表示される', async () => {
      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
            mtgIssues: [createMtgIssue({ purpose: 'Q1振り返りと計画策定' })],
            backlogUsers: [],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.documents[0].content).toContain('**目的**: Q1振り返りと計画策定');
    });

    it('MTGの開催日時が表示される', async () => {
      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
            mtgIssues: [createMtgIssue({ datetime: '2026-01-24 14:00〜15:00' })],
            backlogUsers: [],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.documents[0].content).toContain('**開催日時**: 2026-01-24 14:00〜15:00');
    });

    it('自社参加者が表示される', async () => {
      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
            mtgIssues: [createMtgIssue({ internalParticipants: ['山田太郎', '鈴木花子', '佐藤次郎'] })],
            backlogUsers: [],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.documents[0].content).toContain('**自社参加者**: 山田太郎、鈴木花子、佐藤次郎');
    });

    it('外部参加者が表示される', async () => {
      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
            mtgIssues: [createMtgIssue({ externalParticipants: ['田中様（ABC株式会社）', '佐々木様'] })],
            backlogUsers: [],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.documents[0].content).toContain('**外部参加者**: 田中様（ABC株式会社）、佐々木様');
    });

    it('MTG URLが表示される', async () => {
      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
            mtgIssues: [createMtgIssue({ mtgUrl: 'https://zoom.us/j/987654321' })],
            backlogUsers: [],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.documents[0].content).toContain('**MTG URL**: [リンク](https://zoom.us/j/987654321)');
    });

    it('課題URLが表示される', async () => {
      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
            mtgIssues: [createMtgIssue({ url: 'https://example.backlog.com/view/PROJECT1-100' })],
            backlogUsers: [],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.documents[0].content).toContain('**課題URL**: [リンク](https://example.backlog.com/view/PROJECT1-100)');
    });

    it('MTG課題が0件の場合、MTGセクションは表示されない', async () => {
      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
            mtgIssues: [],
            backlogUsers: [],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.documents[0].content).not.toContain('本日のミーティング予定');
    });

    it('一部の情報が欠けている場合でも正しく表示される', async () => {
      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
            mtgIssues: [createMtgIssue({
              purpose: undefined,
              datetime: undefined,
              mtgUrl: undefined,
              internalParticipants: [],
              externalParticipants: [],
            })],
            backlogUsers: [],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      // エラーにならずにドキュメントが生成される
      expect(result.documents[0].content).toContain('### 📅 本日のミーティング予定');
      expect(result.documents[0].content).toContain('#### 進捗確認MTG');
      // 情報がない項目は表示されない
      expect(result.documents[0].content).not.toContain('**目的**:');
      expect(result.documents[0].content).not.toContain('**開催日時**:');
      expect(result.documents[0].content).not.toContain('**MTG URL**:');
    });

    it('メモ欄が各MTGに追加される', async () => {
      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
            mtgIssues: [createMtgIssue()],
            backlogUsers: [],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.documents[0].content).toContain('<!-- メモ -->');
    });
  });
});
