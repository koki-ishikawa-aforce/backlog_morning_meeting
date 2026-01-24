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

  describe('議事録セクションのメモ欄フォーマット', () => {
    const createTestIssue = (overrides: any = {}) => ({
      id: 1,
      issueKey: 'PROJECT1-1',
      summary: 'テスト課題',
      description: '',
      status: { id: 1, name: '未対応' },
      assignee: { id: 1, name: 'Test User' },
      dueDate: '2024-01-20',
      startDate: '2024-01-15',
      priority: { id: 1, name: '中' },
      category: [],
      url: 'https://example.com/view/PROJECT1-1',
      project: { id: 1, projectKey: 'PROJECT1', name: 'Project 1' },
      ...overrides,
    });

    describe('期限超過・未完了課題（要対応）のメモ欄', () => {
      it('「遅延理由」テンプレートが含まれる（delayInfoがない場合）', async () => {
        const mockEvent = {
          projects: [
            {
              projectKey: 'PROJECT1',
              projectName: 'Project 1',
              todayIssues: [],
              incompleteIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [createTestIssue()] }],
              dueTodayIssues: [],
            },
          ],
          activeAssigneeIds: [1],
        };

        const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

        expect(result.documents[0].content).toContain('**遅延理由**: <!-- 自責/社内待ち/顧客待ち/仕様変更/割り込み対応 -->');
      });

      it('「ボール」テンプレートが含まれる（delayInfoがない場合）', async () => {
        const mockEvent = {
          projects: [
            {
              projectKey: 'PROJECT1',
              projectName: 'Project 1',
              todayIssues: [],
              incompleteIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [createTestIssue()] }],
              dueTodayIssues: [],
            },
          ],
          activeAssigneeIds: [1],
        };

        const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

        expect(result.documents[0].content).toContain('**ボール**: <!-- 自分/社内（誰）/顧客 -->');
      });

      it('「次のアクション」テンプレートが含まれる（delayInfoがない場合）', async () => {
        const mockEvent = {
          projects: [
            {
              projectKey: 'PROJECT1',
              projectName: 'Project 1',
              todayIssues: [],
              incompleteIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [createTestIssue()] }],
              dueTodayIssues: [],
            },
          ],
          activeAssigneeIds: [1],
        };

        const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

        expect(result.documents[0].content).toContain('**次のアクション**: <!-- -->');
      });

      it('「完了見込み」テンプレートが含まれる（delayInfoがない場合）', async () => {
        const mockEvent = {
          projects: [
            {
              projectKey: 'PROJECT1',
              projectName: 'Project 1',
              todayIssues: [],
              incompleteIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [createTestIssue()] }],
              dueTodayIssues: [],
            },
          ],
          activeAssigneeIds: [1],
        };

        const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

        expect(result.documents[0].content).toContain('**完了見込み**: <!-- -->');
      });
    });

    describe('本日対応予定課題のメモ欄', () => {
      it('「進捗」テンプレートが含まれる', async () => {
        const mockEvent = {
          projects: [
            {
              projectKey: 'PROJECT1',
              projectName: 'Project 1',
              todayIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [createTestIssue()] }],
              incompleteIssues: [],
              dueTodayIssues: [],
            },
          ],
          activeAssigneeIds: [1],
        };

        const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

        expect(result.documents[0].content).toContain('**進捗**: <!-- 進行中/完了間近/着手前/ブロック中 -->');
      });

      it('「状況」テンプレートが含まれる', async () => {
        const mockEvent = {
          projects: [
            {
              projectKey: 'PROJECT1',
              projectName: 'Project 1',
              todayIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [createTestIssue()] }],
              incompleteIssues: [],
              dueTodayIssues: [],
            },
          ],
          activeAssigneeIds: [1],
        };

        const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

        expect(result.documents[0].content).toContain('**状況**: <!-- -->');
      });

      it('「ボール」テンプレートが含まれる', async () => {
        const mockEvent = {
          projects: [
            {
              projectKey: 'PROJECT1',
              projectName: 'Project 1',
              todayIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [createTestIssue()] }],
              incompleteIssues: [],
              dueTodayIssues: [],
            },
          ],
          activeAssigneeIds: [1],
        };

        const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

        // 本日対応予定セクション内のボールテンプレートを確認
        const content = result.documents[0].content;
        const todaySection = content.split('#### 📅 本日対応予定')[1];
        expect(todaySection).toContain('**ボール**: <!-- 自分/社内（誰）/顧客 -->');
      });
    });

    describe('エッジケース', () => {
      it('今日締め切りの本日対応予定課題には🔔マークと本日対応予定用テンプレートが適用される', async () => {
        const today = new Date().toISOString().split('T')[0];
        const dueTodayIssue = createTestIssue({ dueDate: today, issueKey: 'PROJECT1-99' });

        const mockEvent = {
          projects: [
            {
              projectKey: 'PROJECT1',
              projectName: 'Project 1',
              todayIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [dueTodayIssue] }],
              incompleteIssues: [],
              dueTodayIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [dueTodayIssue] }],
            },
          ],
          activeAssigneeIds: [1],
        };

        const result = (await handler(mockEvent, {} as any, jest.fn())) as any;
        const content = result.documents[0].content;

        // 🔔マークが付いている
        expect(content).toContain('PROJECT1-99: テスト課題 🔔（今日締め切り）');
        // 本日対応予定用のテンプレートが適用されている
        expect(content).toContain('**進捗**: <!-- 進行中/完了間近/着手前/ブロック中 -->');
      });

      it('期限超過と本日対応予定の両方に課題がある場合、各セクションで正しいテンプレートが使用される', async () => {
        const incompleteIssue = createTestIssue({ issueKey: 'PROJECT1-1', summary: '期限超過課題' });
        const todayIssue = createTestIssue({ issueKey: 'PROJECT1-2', summary: '本日対応課題' });

        const mockEvent = {
          projects: [
            {
              projectKey: 'PROJECT1',
              projectName: 'Project 1',
              todayIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [todayIssue] }],
              incompleteIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [incompleteIssue] }],
              dueTodayIssues: [],
            },
          ],
          activeAssigneeIds: [1],
        };

        const result = (await handler(mockEvent, {} as any, jest.fn())) as any;
        const content = result.documents[0].content;

        // 期限超過セクションのテンプレート（要対応）
        const incompleteSection = content.split('#### ⚠️ 期限超過・未完了（要対応）')[1].split('#### 📅 本日対応予定')[0];
        expect(incompleteSection).toContain('**遅延理由**:');
        expect(incompleteSection).toContain('**次のアクション**:');
        expect(incompleteSection).toContain('**完了見込み**:');

        // 本日対応予定セクションのテンプレート
        const todaySection = content.split('#### 📅 本日対応予定')[1].split('---')[0];
        expect(todaySection).toContain('**進捗**:');
        expect(todaySection).toContain('**状況**:');
      });
    });
  });

  describe('遅延情報による分類表示', () => {
    const createTestIssue = (overrides: any = {}) => ({
      id: 1,
      issueKey: 'PROJECT1-1',
      summary: 'テスト課題',
      description: '',
      status: { id: 1, name: '未対応' },
      assignee: { id: 1, name: 'Test User' },
      dueDate: '2024-01-20',
      startDate: '2024-01-15',
      priority: { id: 1, name: '中' },
      category: [],
      url: 'https://example.com/view/PROJECT1-1',
      project: { id: 1, projectKey: 'PROJECT1', name: 'Project 1' },
      ...overrides,
    });

    describe('分類ロジック', () => {
      it('delayInfoがない課題は「要対応」に分類される', async () => {
        const issueWithoutDelayInfo = createTestIssue({ issueKey: 'PROJECT1-1' });

        const mockEvent = {
          projects: [
            {
              projectKey: 'PROJECT1',
              projectName: 'Project 1',
              todayIssues: [],
              incompleteIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [issueWithoutDelayInfo] }],
              dueTodayIssues: [],
            },
          ],
          activeAssigneeIds: [1],
        };

        const result = (await handler(mockEvent, {} as any, jest.fn())) as any;
        const content = result.documents[0].content;

        expect(content).toContain('#### ⚠️ 期限超過・未完了（要対応）');
        expect(content).toContain('PROJECT1-1: テスト課題');
      });

      it('遅延理由が「自責」の課題は「要対応」に分類される', async () => {
        const issueWithSelfReason = createTestIssue({
          issueKey: 'PROJECT1-1',
          delayInfo: { delayReason: '自責', ball: '自分' },
        });

        const mockEvent = {
          projects: [
            {
              projectKey: 'PROJECT1',
              projectName: 'Project 1',
              todayIssues: [],
              incompleteIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [issueWithSelfReason] }],
              dueTodayIssues: [],
            },
          ],
          activeAssigneeIds: [1],
        };

        const result = (await handler(mockEvent, {} as any, jest.fn())) as any;
        const content = result.documents[0].content;

        expect(content).toContain('#### ⚠️ 期限超過・未完了（要対応）');
        expect(content).toContain('PROJECT1-1: テスト課題');
        expect(content).toContain('**遅延理由**: 自責');
      });

      it('遅延理由が「顧客待ち」の課題は「他者待ち」に分類される', async () => {
        const issueWithCustomerWait = createTestIssue({
          issueKey: 'PROJECT1-2',
          summary: '顧客待ち課題',
          delayInfo: { delayReason: '顧客待ち', ball: '顧客' },
        });

        const mockEvent = {
          projects: [
            {
              projectKey: 'PROJECT1',
              projectName: 'Project 1',
              todayIssues: [],
              incompleteIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [issueWithCustomerWait] }],
              dueTodayIssues: [],
            },
          ],
          activeAssigneeIds: [1],
        };

        const result = (await handler(mockEvent, {} as any, jest.fn())) as any;
        const content = result.documents[0].content;

        expect(content).toContain('#### 🚧 期限超過・未完了（他者待ち）');
        expect(content).toContain('PROJECT1-2: 顧客待ち課題');
        expect(content).toContain('**遅延理由**: 顧客待ち');
      });

      it('遅延理由が「社内待ち」の課題は「他者待ち」に分類される', async () => {
        const issueWithInternalWait = createTestIssue({
          issueKey: 'PROJECT1-3',
          summary: '社内待ち課題',
          delayInfo: { delayReason: '社内待ち', ball: '社内（山田さん）' },
        });

        const mockEvent = {
          projects: [
            {
              projectKey: 'PROJECT1',
              projectName: 'Project 1',
              todayIssues: [],
              incompleteIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [issueWithInternalWait] }],
              dueTodayIssues: [],
            },
          ],
          activeAssigneeIds: [1],
        };

        const result = (await handler(mockEvent, {} as any, jest.fn())) as any;
        const content = result.documents[0].content;

        expect(content).toContain('#### 🚧 期限超過・未完了（他者待ち）');
        expect(content).toContain('PROJECT1-3: 社内待ち課題');
        expect(content).toContain('**遅延理由**: 社内待ち');
      });

      it('要対応と他者待ちの課題が混在する場合、両方のセクションが表示される', async () => {
        const actionRequiredIssue = createTestIssue({
          issueKey: 'PROJECT1-1',
          summary: '要対応課題',
          delayInfo: { delayReason: '自責', ball: '自分', nextAction: '明日対応', expectedCompletion: '1/25' },
        });
        const waitingIssue = createTestIssue({
          issueKey: 'PROJECT1-2',
          summary: '他者待ち課題',
          delayInfo: { delayReason: '顧客待ち', ball: '顧客' },
        });

        const mockEvent = {
          projects: [
            {
              projectKey: 'PROJECT1',
              projectName: 'Project 1',
              todayIssues: [],
              incompleteIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [actionRequiredIssue, waitingIssue] }],
              dueTodayIssues: [],
            },
          ],
          activeAssigneeIds: [1],
        };

        const result = (await handler(mockEvent, {} as any, jest.fn())) as any;
        const content = result.documents[0].content;

        // 両セクションが存在
        expect(content).toContain('#### ⚠️ 期限超過・未完了（要対応）');
        expect(content).toContain('#### 🚧 期限超過・未完了（他者待ち）');

        // 要対応セクション
        const actionSection = content.split('#### ⚠️ 期限超過・未完了（要対応）')[1].split('#### 🚧 期限超過・未完了（他者待ち）')[0];
        expect(actionSection).toContain('PROJECT1-1: 要対応課題');
        expect(actionSection).toContain('**次のアクション**: 明日対応');
        expect(actionSection).toContain('**完了見込み**: 1/25');

        // 他者待ちセクション
        const waitSection = content.split('#### 🚧 期限超過・未完了（他者待ち）')[1].split('#### 📅 本日対応予定')[0];
        expect(waitSection).toContain('PROJECT1-2: 他者待ち課題');
        expect(waitSection).toContain('**状況**: <!-- -->');
      });
    });

    describe('delayInfo表示', () => {
      it('抽出されたdelayInfoの値がテンプレートの代わりに表示される', async () => {
        const issueWithFullDelayInfo = createTestIssue({
          issueKey: 'PROJECT1-1',
          delayInfo: {
            delayReason: '仕様変更',
            ball: '自分',
            nextAction: 'テスト実装',
            expectedCompletion: '1/30',
          },
        });

        const mockEvent = {
          projects: [
            {
              projectKey: 'PROJECT1',
              projectName: 'Project 1',
              todayIssues: [],
              incompleteIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [issueWithFullDelayInfo] }],
              dueTodayIssues: [],
            },
          ],
          activeAssigneeIds: [1],
        };

        const result = (await handler(mockEvent, {} as any, jest.fn())) as any;
        const content = result.documents[0].content;

        expect(content).toContain('**遅延理由**: 仕様変更');
        expect(content).toContain('**ボール**: 自分');
        expect(content).toContain('**次のアクション**: テスト実装');
        expect(content).toContain('**完了見込み**: 1/30');
      });

      it('delayInfoの一部のみが設定されている場合、未設定項目はテンプレートになる', async () => {
        const issueWithPartialDelayInfo = createTestIssue({
          issueKey: 'PROJECT1-1',
          delayInfo: {
            delayReason: '割り込み対応',
          },
        });

        const mockEvent = {
          projects: [
            {
              projectKey: 'PROJECT1',
              projectName: 'Project 1',
              todayIssues: [],
              incompleteIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [issueWithPartialDelayInfo] }],
              dueTodayIssues: [],
            },
          ],
          activeAssigneeIds: [1],
        };

        const result = (await handler(mockEvent, {} as any, jest.fn())) as any;
        const content = result.documents[0].content;

        expect(content).toContain('**遅延理由**: 割り込み対応');
        expect(content).toContain('**ボール**: <!-- 自分/社内（誰）/顧客 -->');
        expect(content).toContain('**次のアクション**: <!-- -->');
        expect(content).toContain('**完了見込み**: <!-- -->');
      });

      it('他者待ち課題は「状況」欄がテンプレートとして表示される', async () => {
        const waitingIssue = createTestIssue({
          issueKey: 'PROJECT1-1',
          delayInfo: {
            delayReason: '顧客待ち',
            ball: '顧客（田中様）',
          },
        });

        const mockEvent = {
          projects: [
            {
              projectKey: 'PROJECT1',
              projectName: 'Project 1',
              todayIssues: [],
              incompleteIssues: [{ assigneeName: 'Test User', assigneeId: 1, issues: [waitingIssue] }],
              dueTodayIssues: [],
            },
          ],
          activeAssigneeIds: [1],
        };

        const result = (await handler(mockEvent, {} as any, jest.fn())) as any;
        const content = result.documents[0].content;

        const waitSection = content.split('#### 🚧 期限超過・未完了（他者待ち）')[1];
        expect(waitSection).toContain('**遅延理由**: 顧客待ち');
        expect(waitSection).toContain('**ボール**: 顧客（田中様）');
        expect(waitSection).toContain('**状況**: <!-- -->');
        // 他者待ちセクションには「次のアクション」「完了見込み」は表示されない
        expect(waitSection).not.toContain('**次のアクション**');
        expect(waitSection).not.toContain('**完了見込み**');
      });
    });
  });
});
