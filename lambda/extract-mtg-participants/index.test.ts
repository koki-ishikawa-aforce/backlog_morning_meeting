import { handler } from './index';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';

const secretsManagerMock = mockClient(SecretsManagerClient);

// OpenAI API呼び出しをモック
jest.mock('https', () => {
  const actualHttps = jest.requireActual('https');
  return {
    ...actualHttps,
    request: jest.fn(),
  };
});

import * as https from 'https';

describe('extract-mtg-participants', () => {
  beforeEach(() => {
    secretsManagerMock.reset();
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY_SECRET_NAME = 'backlog-morning-meeting/openai-api-key';
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY_SECRET_NAME;
  });

  // 共通のモック設定
  const setupSecretsMock = () => {
    secretsManagerMock.on(GetSecretValueCommand, {
      SecretId: 'backlog-morning-meeting/openai-api-key',
    }).resolves({
      SecretString: 'test-openai-api-key',
    });
  };

  // OpenAI APIレスポンスのモック設定
  const setupOpenAiMock = (response: any) => {
    const mockRequest = https.request as jest.Mock;
    mockRequest.mockImplementation((options: any, callback: any) => {
      const mockResponse: any = {
        statusCode: 200,
        on: jest.fn((event: string, handler: any) => {
          if (event === 'data') {
            setTimeout(() => {
              handler(JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify(response),
                    },
                  },
                ],
              }));
            }, 0);
          } else if (event === 'end') {
            setTimeout(() => handler(), 0);
          }
          return mockResponse;
        }),
      };
      setTimeout(() => callback(mockResponse), 0);
      return {
        on: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      };
    });
  };

  // OpenAI APIエラーのモック設定
  const setupOpenAiErrorMock = () => {
    const mockRequest = https.request as jest.Mock;
    mockRequest.mockImplementation((options: any, callback: any) => {
      const mockResponse: any = {
        statusCode: 500,
        on: jest.fn((event: string, handler: any) => {
          if (event === 'data') {
            setTimeout(() => {
              handler(JSON.stringify({ error: 'Internal Server Error' }));
            }, 0);
          } else if (event === 'end') {
            setTimeout(() => handler(), 0);
          }
          return mockResponse;
        }),
      };
      setTimeout(() => callback(mockResponse), 0);
      return {
        on: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      };
    });
  };

  describe('正常系', () => {
    it('MTG課題のdescriptionから参加者情報を抽出できる', async () => {
      setupSecretsMock();
      setupOpenAiMock({
        purpose: 'プロジェクト進捗確認',
        datetime: '2026-01-24 14:00〜15:00',
        internalParticipantIds: [1, 2],
        externalParticipants: ['田中様（ABC株式会社）'],
        mtgUrl: 'https://zoom.us/j/123456789',
      });

      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
            mtgIssues: [
              {
                issueKey: 'PROJECT1-100',
                summary: '進捗確認MTG',
                description: '## 参加者\n- 山田太郎\n- 鈴木花子\n- 田中様（ABC株式会社）\n\n## 開催日時\n2026-01-24 14:00〜15:00\n\n## URL\nhttps://zoom.us/j/123456789',
                url: 'https://example.backlog.com/view/PROJECT1-100',
                startDate: '2026-01-24',
                dueDate: '2026-01-24',
              },
            ],
            backlogUsers: [
              { id: 1, name: '山田太郎' },
              { id: 2, name: '鈴木花子' },
            ],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.projects[0].mtgIssues[0]).toHaveProperty('purpose', 'プロジェクト進捗確認');
      expect(result.projects[0].mtgIssues[0]).toHaveProperty('datetime', '2026-01-24 14:00〜15:00');
      expect(result.projects[0].mtgIssues[0]).toHaveProperty('mtgUrl', 'https://zoom.us/j/123456789');
    });

    it('自社参加者のIDがBacklogユーザーIDで返され名前に変換される', async () => {
      setupSecretsMock();
      setupOpenAiMock({
        purpose: '定例MTG',
        datetime: '14:00〜15:00',
        internalParticipantIds: [1, 2],
        externalParticipants: [],
        mtgUrl: null,
      });

      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
            mtgIssues: [
              {
                issueKey: 'PROJECT1-100',
                summary: '定例MTG',
                description: '参加者: 山田太郎、鈴木花子',
                url: 'https://example.backlog.com/view/PROJECT1-100',
              },
            ],
            backlogUsers: [
              { id: 1, name: '山田太郎' },
              { id: 2, name: '鈴木花子' },
              { id: 3, name: '佐藤次郎' },
            ],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.projects[0].mtgIssues[0].internalParticipants).toEqual(['山田太郎', '鈴木花子']);
    });

    it('外部参加者は名前で返される', async () => {
      setupSecretsMock();
      setupOpenAiMock({
        purpose: '顧客MTG',
        datetime: '10:00〜11:00',
        internalParticipantIds: [1],
        externalParticipants: ['田中様（ABC株式会社）', '佐々木様'],
        mtgUrl: 'https://teams.microsoft.com/l/meetup-join/xxx',
      });

      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
            mtgIssues: [
              {
                issueKey: 'PROJECT1-100',
                summary: '顧客MTG',
                description: '参加者: 山田太郎、田中様（ABC株式会社）、佐々木様',
                url: 'https://example.backlog.com/view/PROJECT1-100',
              },
            ],
            backlogUsers: [
              { id: 1, name: '山田太郎' },
            ],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.projects[0].mtgIssues[0].externalParticipants).toEqual(['田中様（ABC株式会社）', '佐々木様']);
    });

    it('MTGのURLが抽出される', async () => {
      setupSecretsMock();
      setupOpenAiMock({
        purpose: 'オンラインMTG',
        datetime: '15:00〜16:00',
        internalParticipantIds: [],
        externalParticipants: [],
        mtgUrl: 'https://zoom.us/j/987654321',
      });

      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
            mtgIssues: [
              {
                issueKey: 'PROJECT1-100',
                summary: 'オンラインMTG',
                description: 'URL: https://zoom.us/j/987654321',
                url: 'https://example.backlog.com/view/PROJECT1-100',
              },
            ],
            backlogUsers: [],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.projects[0].mtgIssues[0].mtgUrl).toBe('https://zoom.us/j/987654321');
    });

    it('MTGの目的・アジェンダが抽出される', async () => {
      setupSecretsMock();
      setupOpenAiMock({
        purpose: 'Q1振り返りと今後の計画策定',
        datetime: '13:00〜14:00',
        internalParticipantIds: [],
        externalParticipants: [],
        mtgUrl: null,
      });

      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
            mtgIssues: [
              {
                issueKey: 'PROJECT1-100',
                summary: '振り返りMTG',
                description: '## 目的\nQ1振り返りと今後の計画策定',
                url: 'https://example.backlog.com/view/PROJECT1-100',
              },
            ],
            backlogUsers: [],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.projects[0].mtgIssues[0].purpose).toBe('Q1振り返りと今後の計画策定');
    });
  });

  describe('異常系', () => {
    it('OpenAI APIがエラーを返した場合、元のMTG課題をそのまま返す', async () => {
      setupSecretsMock();
      setupOpenAiErrorMock();

      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
            mtgIssues: [
              {
                issueKey: 'PROJECT1-100',
                summary: 'MTGタイトル',
                description: '説明文',
                url: 'https://example.backlog.com/view/PROJECT1-100',
              },
            ],
            backlogUsers: [{ id: 1, name: '山田太郎' }],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      // エラー時は元のMTG課題をそのまま返す（抽出結果は空）
      expect(result.projects[0].mtgIssues[0].issueKey).toBe('PROJECT1-100');
      expect(result.projects[0].mtgIssues[0].internalParticipants).toEqual([]);
      expect(result.projects[0].mtgIssues[0].externalParticipants).toEqual([]);
    });

    it('descriptionが空の場合、抽出結果は空になる', async () => {
      setupSecretsMock();
      setupOpenAiMock({
        purpose: null,
        datetime: null,
        internalParticipantIds: [],
        externalParticipants: [],
        mtgUrl: null,
      });

      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
            mtgIssues: [
              {
                issueKey: 'PROJECT1-100',
                summary: 'MTGタイトル',
                description: '',
                url: 'https://example.backlog.com/view/PROJECT1-100',
              },
            ],
            backlogUsers: [],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.projects[0].mtgIssues[0].internalParticipants).toEqual([]);
      expect(result.projects[0].mtgIssues[0].externalParticipants).toEqual([]);
    });
  });

  describe('エッジケース', () => {
    it('参加者が0人の場合でも正常に処理される', async () => {
      setupSecretsMock();
      setupOpenAiMock({
        purpose: '場所決めMTG',
        datetime: '16:00〜17:00',
        internalParticipantIds: [],
        externalParticipants: [],
        mtgUrl: null,
      });

      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
            mtgIssues: [
              {
                issueKey: 'PROJECT1-100',
                summary: '場所決めMTG',
                description: '参加者は後日決定',
                url: 'https://example.backlog.com/view/PROJECT1-100',
              },
            ],
            backlogUsers: [{ id: 1, name: '山田太郎' }],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      expect(result.projects[0].mtgIssues[0].internalParticipants).toEqual([]);
      expect(result.projects[0].mtgIssues[0].externalParticipants).toEqual([]);
      expect(result.projects[0].mtgIssues[0].purpose).toBe('場所決めMTG');
    });

    it('MTG課題が0件の場合、処理をスキップする', async () => {
      setupSecretsMock();
      const mockRequest = https.request as jest.Mock;

      const mockEvent = {
        projects: [
          {
            projectKey: 'PROJECT1',
            projectName: 'Project 1',
            todayIssues: [],
            incompleteIssues: [],
            dueTodayIssues: [],
            mtgIssues: [],
            backlogUsers: [{ id: 1, name: '山田太郎' }],
          },
        ],
        activeAssigneeIds: [],
      };

      const result = (await handler(mockEvent, {} as any, jest.fn())) as any;

      // OpenAI APIは呼び出されない
      expect(mockRequest).not.toHaveBeenCalled();
      expect(result.projects[0].mtgIssues).toEqual([]);
    });
  });
});
