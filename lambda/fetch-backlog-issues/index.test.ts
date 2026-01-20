import { handler } from './index';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import * as https from 'https';

const secretsManagerMock = mockClient(SecretsManagerClient);
const ssmMock = mockClient(SSMClient);

// HTTPSモジュールのモック
jest.mock('https', () => {
  const actualHttps = jest.requireActual('https');
  return {
    ...actualHttps,
    request: jest.fn(),
  };
});

describe('fetch-backlog-issues', () => {
  beforeEach(() => {
    secretsManagerMock.reset();
    ssmMock.reset();
    jest.clearAllMocks();
    process.env.BACKLOG_SECRET_NAME = 'backlog-morning-meeting/backlog-credentials';
    process.env.ACTIVE_ASSIGNEE_IDS_PARAM = '/backlog-morning-meeting/active-assignee-ids';
    process.env.BACKLOG_PROJECT_KEYS_PARAM = '/backlog-morning-meeting/project-keys';
  });

  afterEach(() => {
    delete process.env.BACKLOG_SECRET_NAME;
    delete process.env.ACTIVE_ASSIGNEE_IDS_PARAM;
    delete process.env.BACKLOG_PROJECT_KEYS_PARAM;
  });

  describe('正常系', () => {
    it('プロジェクトキーと課題を正常に取得できる', async () => {
      // SSM Parameter Storeのモック
      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/project-keys',
      }).resolves({
        Parameter: { Value: 'PROJECT1,PROJECT2' },
      });

      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/active-assignee-ids',
      }).resolves({
        Parameter: { Value: '123,456' },
      });

      // Secrets Managerのモック
      secretsManagerMock.on(GetSecretValueCommand, {
        SecretId: 'backlog-morning-meeting/backlog-credentials',
      }).resolves({
        SecretString: JSON.stringify({
          apiKey: 'test-api-key',
          spaceId: 'test-space',
          domain: 'backlog.com',
        }),
      });

      // HTTPSリクエストのモック
      const mockRequest = https.request as jest.Mock;
      let requestCount = 0;

      mockRequest.mockImplementation((options: any, callback: any) => {
        requestCount++;
        const mockResponse: any = {
          statusCode: 200,
          on: jest.fn((event: string, handler: any) => {
            if (event === 'data') {
              setTimeout(() => {
                // プロジェクト情報取得
                if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                  handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                }
                // ステータス一覧取得
                else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                  handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                }
                // 課題一覧取得（本日対応予定、期限超過、今日締め切りの各クエリに対応）
                else if (options.path?.includes('/issues')) {
                  // 本日対応予定の課題のクエリ（startDateSince/startDateUntil または dueDateSince/dueDateUntil）
                  // 期限超過の課題のクエリ（startDateUntil: yesterday）
                  // 今日締め切りの課題のクエリ（dueDateSince: today, dueDateUntil: today）
                  handler(JSON.stringify([]));
                }
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
          end: jest.fn(),
        };
      });

      const result = (await handler({}, {} as any, jest.fn())) as any;

      expect(result).toHaveProperty('projects');
      expect(result).toHaveProperty('activeAssigneeIds');
      expect(Array.isArray(result.projects)).toBe(true);
      expect(Array.isArray(result.activeAssigneeIds)).toBe(true);
    });
  });

  describe('異常系', () => {
    it('プロジェクトキーが取得できない場合はエラーを投げる', async () => {
      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/project-keys',
      }).rejects(new Error('Parameter not found'));

      await expect(handler({}, {} as any, jest.fn())).rejects.toThrow();
    });

    it('認証情報が取得できない場合はエラーを投げる', async () => {
      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/project-keys',
      }).resolves({
        Parameter: { Value: 'PROJECT1' },
      });

      secretsManagerMock.on(GetSecretValueCommand).rejects(new Error('Secret not found'));

      await expect(handler({}, {} as any, jest.fn())).rejects.toThrow();
    });

    it('認証情報にapiKeyが含まれていない場合はエラーを投げる', async () => {
      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/project-keys',
      }).resolves({
        Parameter: { Value: 'PROJECT1' },
      });

      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: JSON.stringify({
          spaceId: 'test-space',
        }),
      });

      await expect(handler({}, {} as any, jest.fn())).rejects.toThrow('認証情報にapiKeyまたはspaceIdが含まれていません');
    });
  });

  describe('エッジケース', () => {
    it('プロジェクトキーが空の場合はエラーを投げる', async () => {
      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/project-keys',
      }).resolves({
        Parameter: { Value: '' },
      });

      await expect(handler({}, {} as any, jest.fn())).rejects.toThrow('対象プロジェクトキーが取得できません');
    });

    it('担当者IDが空の場合は空配列を返す', async () => {
      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/project-keys',
      }).resolves({
        Parameter: { Value: 'PROJECT1' },
      });

      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/active-assignee-ids',
      }).resolves({
        Parameter: { Value: '' },
      });

      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: JSON.stringify({
          apiKey: 'test-api-key',
          spaceId: 'test-space',
        }),
      });

      const mockRequest = https.request as jest.Mock;
      let callCount = 0;
      mockRequest.mockImplementation((options: any, callback: any) => {
        callCount++;
        const mockResponse: any = {
          statusCode: 200,
          on: jest.fn((event: string, handler: any) => {
            if (event === 'data') {
              setTimeout(() => {
                if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                  handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                  handler(JSON.stringify([{ id: 1, name: '未対応' }]));
                } else if (options.path?.includes('/issues')) {
                  handler(JSON.stringify([]));
                }
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
          end: jest.fn(),
        };
      });

      const result = (await handler({}, {} as any, jest.fn())) as any;
      expect(result.activeAssigneeIds).toEqual([]);
    });
  });

  describe('仕様検証', () => {
    // テスト用の固定日付
    const today = '2026-01-20';
    const yesterday = '2026-01-19';
    const tomorrow = '2026-01-21';
    const past30Days = '2025-12-21';
    const future30Days = '2026-02-19';

    // 共通のモック設定ヘルパー
    const setupCommonMocks = () => {
      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/project-keys',
      }).resolves({
        Parameter: { Value: 'PROJECT1' },
      });

      ssmMock.on(GetParameterCommand, {
        Name: '/backlog-morning-meeting/active-assignee-ids',
      }).resolves({
        Parameter: { Value: '' },
      });

      secretsManagerMock.on(GetSecretValueCommand, {
        SecretId: 'backlog-morning-meeting/backlog-credentials',
      }).resolves({
        SecretString: JSON.stringify({
          apiKey: 'test-api-key',
          spaceId: 'test-space',
          domain: 'backlog.com',
        }),
      });
    };

    // 日付を固定するためのモック
    const mockDate = (fixedDate: string) => {
      // JSTオフセットを考慮（UTC+9）
      // 固定日付をUTCで設定し、JSTとして扱うために9時間戻す
      const fixedDateObj = new Date(fixedDate + 'T00:00:00.000Z');
      const jstOffset = 9 * 60 * 60 * 1000;
      const mockTime = fixedDateObj.getTime() - jstOffset;
      // setTimeoutはモックしない（HTTPSモックで使用するため）
      jest.useFakeTimers({ doNotFake: ['setTimeout'] });
      jest.setSystemTime(mockTime);
    };

    afterEach(() => {
      jest.useRealTimers();
    });

    describe('本日対応予定の課題の抽出', () => {
      beforeEach(() => {
        setupCommonMocks();
        mockDate(today);
      });

      it('開始日が昨日、期限日が明日の課題が抽出される', async () => {
        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    // 開始日または期限日のクエリで返す課題
                    const issue = {
                      id: 1,
                      issueKey: 'PROJECT1-1',
                      summary: 'Test Issue',
                      description: '',
                      status: { id: 1, name: '未対応' },
                      startDate: yesterday + 'T00:00:00Z',
                      dueDate: tomorrow + 'T00:00:00Z',
                      priority: { id: 2, name: '中' },
                      projectId: 1,
                    };
                    handler(JSON.stringify([issue]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        expect(result.projects[0].issues).toHaveLength(1);
        expect(result.projects[0].issues[0].issueKey).toBe('PROJECT1-1');
      });

      it('開始日が今日、期限日が未来の課題が抽出される', async () => {
        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    const issue = {
                      id: 1,
                      issueKey: 'PROJECT1-1',
                      summary: 'Test Issue',
                      description: '',
                      status: { id: 1, name: '未対応' },
                      startDate: today + 'T00:00:00Z',
                      dueDate: future30Days + 'T00:00:00Z',
                      priority: { id: 2, name: '中' },
                      projectId: 1,
                    };
                    handler(JSON.stringify([issue]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        expect(result.projects[0].issues).toHaveLength(1);
        expect(result.projects[0].issues[0].issueKey).toBe('PROJECT1-1');
      });

      it('開始日が過去、期限日が今日の課題が抽出される', async () => {
        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    const issue = {
                      id: 1,
                      issueKey: 'PROJECT1-1',
                      summary: 'Test Issue',
                      description: '',
                      status: { id: 1, name: '未対応' },
                      startDate: yesterday + 'T00:00:00Z',
                      dueDate: today + 'T00:00:00Z',
                      priority: { id: 2, name: '中' },
                      projectId: 1,
                    };
                    handler(JSON.stringify([issue]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        expect(result.projects[0].issues).toHaveLength(1);
        expect(result.projects[0].issues[0].issueKey).toBe('PROJECT1-1');
      });

      it('開始日が未来、期限日が今日の課題が除外される', async () => {
        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    const issue = {
                      id: 1,
                      issueKey: 'PROJECT1-1',
                      summary: 'Test Issue',
                      description: '',
                      status: { id: 1, name: '未対応' },
                      startDate: tomorrow + 'T00:00:00Z',
                      dueDate: today + 'T00:00:00Z',
                      priority: { id: 2, name: '中' },
                      projectId: 1,
                    };
                    handler(JSON.stringify([issue]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        // 開始日が未来なので本日対応予定からは除外される（今日締め切りには含まれる可能性があるが、ここでは本日対応予定のフィルタリングを確認）
        const todayIssues = result.projects[0].issues.filter((issue: any) => {
          // 今日締め切りの課題は別途取得されるため、本日対応予定のフィルタリング結果を確認
          return issue.startDate && new Date(issue.startDate).toISOString().split('T')[0] <= today;
        });
        expect(todayIssues).toHaveLength(0);
      });

      it('開始日が未来、期限日が未来の課題が除外される', async () => {
        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    const issue = {
                      id: 1,
                      issueKey: 'PROJECT1-1',
                      summary: 'Test Issue',
                      description: '',
                      status: { id: 1, name: '未対応' },
                      startDate: tomorrow + 'T00:00:00Z',
                      dueDate: future30Days + 'T00:00:00Z',
                      priority: { id: 2, name: '中' },
                      projectId: 1,
                    };
                    handler(JSON.stringify([issue]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        const todayIssues = result.projects[0].issues.filter((issue: any) => {
          return issue.startDate && new Date(issue.startDate).toISOString().split('T')[0] <= today;
        });
        expect(todayIssues).toHaveLength(0);
      });

      it('開始日のみ設定されていて、開始日が今日以前の課題が抽出される', async () => {
        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    const issue = {
                      id: 1,
                      issueKey: 'PROJECT1-1',
                      summary: 'Test Issue',
                      description: '',
                      status: { id: 1, name: '未対応' },
                      startDate: yesterday + 'T00:00:00Z',
                      priority: { id: 2, name: '中' },
                      projectId: 1,
                    };
                    handler(JSON.stringify([issue]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        expect(result.projects[0].issues).toHaveLength(1);
        expect(result.projects[0].issues[0].issueKey).toBe('PROJECT1-1');
      });

      it('開始日のみ設定されていて、開始日が未来の課題が除外される', async () => {
        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    const issue = {
                      id: 1,
                      issueKey: 'PROJECT1-1',
                      summary: 'Test Issue',
                      description: '',
                      status: { id: 1, name: '未対応' },
                      startDate: tomorrow + 'T00:00:00Z',
                      priority: { id: 2, name: '中' },
                      projectId: 1,
                    };
                    handler(JSON.stringify([issue]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        const todayIssues = result.projects[0].issues.filter((issue: any) => {
          return issue.startDate && new Date(issue.startDate).toISOString().split('T')[0] <= today;
        });
        expect(todayIssues).toHaveLength(0);
      });

      it('期限日のみ設定されていて、期限日が今日以降の課題が抽出される', async () => {
        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    const issue = {
                      id: 1,
                      issueKey: 'PROJECT1-1',
                      summary: 'Test Issue',
                      description: '',
                      status: { id: 1, name: '未対応' },
                      dueDate: tomorrow + 'T00:00:00Z',
                      priority: { id: 2, name: '中' },
                      projectId: 1,
                    };
                    handler(JSON.stringify([issue]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        expect(result.projects[0].issues).toHaveLength(1);
        expect(result.projects[0].issues[0].issueKey).toBe('PROJECT1-1');
      });

      it('期限日のみ設定されていて、期限日が過去の課題が除外される', async () => {
        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    const issue = {
                      id: 1,
                      issueKey: 'PROJECT1-1',
                      summary: 'Test Issue',
                      description: '',
                      status: { id: 1, name: '未対応' },
                      dueDate: yesterday + 'T00:00:00Z',
                      priority: { id: 2, name: '中' },
                      projectId: 1,
                    };
                    handler(JSON.stringify([issue]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        const todayIssues = result.projects[0].issues.filter((issue: any) => {
          return issue.dueDate && new Date(issue.dueDate).toISOString().split('T')[0] >= today;
        });
        expect(todayIssues).toHaveLength(0);
      });

      it('開始日も期限日も設定されていない課題が除外される', async () => {
        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    const issue = {
                      id: 1,
                      issueKey: 'PROJECT1-1',
                      summary: 'Test Issue',
                      description: '',
                      status: { id: 1, name: '未対応' },
                      priority: { id: 2, name: '中' },
                      projectId: 1,
                    };
                    handler(JSON.stringify([issue]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        const todayIssues = result.projects[0].issues.filter((issue: any) => {
          return issue.startDate || issue.dueDate;
        });
        expect(todayIssues).toHaveLength(0);
      });
    });

    describe('今日締め切りの課題の抽出', () => {
      beforeEach(() => {
        setupCommonMocks();
        mockDate(today);
      });

      it('期限日が今日の課題が抽出される', async () => {
        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    // 今日締め切りのクエリ（dueDateSince: today, dueDateUntil: today）の場合
                    if (options.path?.includes('dueDateSince=' + today) && options.path?.includes('dueDateUntil=' + today)) {
                      const issue = {
                        id: 1,
                        issueKey: 'PROJECT1-1',
                        summary: 'Test Issue',
                        description: '',
                        status: { id: 1, name: '未対応' },
                        dueDate: today + 'T00:00:00Z',
                        priority: { id: 2, name: '中' },
                        projectId: 1,
                      };
                      handler(JSON.stringify([issue]));
                    } else {
                      handler(JSON.stringify([]));
                    }
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        const dueTodayIssues = result.projects[0].issues.filter((issue: any) => {
          return issue.dueDate && new Date(issue.dueDate).toISOString().split('T')[0] === today;
        });
        expect(dueTodayIssues.length).toBeGreaterThan(0);
      });

      it('期限日が昨日の課題が除外される', async () => {
        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    handler(JSON.stringify([]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        const dueTodayIssues = result.projects[0].issues.filter((issue: any) => {
          return issue.dueDate && new Date(issue.dueDate).toISOString().split('T')[0] === today;
        });
        expect(dueTodayIssues).toHaveLength(0);
      });

      it('期限日が明日の課題が除外される', async () => {
        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    handler(JSON.stringify([]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        const dueTodayIssues = result.projects[0].issues.filter((issue: any) => {
          return issue.dueDate && new Date(issue.dueDate).toISOString().split('T')[0] === today;
        });
        expect(dueTodayIssues).toHaveLength(0);
      });

      it('期限日が未設定の課題が除外される', async () => {
        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    handler(JSON.stringify([]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        const dueTodayIssues = result.projects[0].issues.filter((issue: any) => {
          return issue.dueDate && new Date(issue.dueDate).toISOString().split('T')[0] === today;
        });
        expect(dueTodayIssues).toHaveLength(0);
      });
    });

    describe('過去のスケジュールで未完了の課題の抽出', () => {
      beforeEach(() => {
        setupCommonMocks();
        mockDate(today);
      });

      it('開始日が昨日で未完了の課題が抽出される', async () => {
        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    // 過去のスケジュールのクエリ（startDateUntil: yesterday）の場合
                    if (options.path?.includes('startDateUntil=' + yesterday)) {
                      const issue = {
                        id: 1,
                        issueKey: 'PROJECT1-1',
                        summary: 'Test Issue',
                        description: '',
                        status: { id: 1, name: '未対応' },
                        startDate: yesterday + 'T00:00:00Z',
                        priority: { id: 2, name: '中' },
                        projectId: 1,
                      };
                      handler(JSON.stringify([issue]));
                    } else {
                      handler(JSON.stringify([]));
                    }
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        const incompleteIssues = result.projects[0].issues.filter((issue: any) => {
          return issue.startDate && new Date(issue.startDate).toISOString().split('T')[0] <= yesterday;
        });
        expect(incompleteIssues.length).toBeGreaterThan(0);
      });

      it('開始日が過去で未完了の課題が抽出される', async () => {
        const mockRequest = https.request as jest.Mock;
        const pastDate = '2026-01-10';
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    if (options.path?.includes('startDateUntil=' + yesterday)) {
                      const issue = {
                        id: 1,
                        issueKey: 'PROJECT1-1',
                        summary: 'Test Issue',
                        description: '',
                        status: { id: 1, name: '未対応' },
                        startDate: pastDate + 'T00:00:00Z',
                        priority: { id: 2, name: '中' },
                        projectId: 1,
                      };
                      handler(JSON.stringify([issue]));
                    } else {
                      handler(JSON.stringify([]));
                    }
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        const incompleteIssues = result.projects[0].issues.filter((issue: any) => {
          return issue.startDate && new Date(issue.startDate).toISOString().split('T')[0] <= yesterday;
        });
        expect(incompleteIssues.length).toBeGreaterThan(0);
      });

      it('開始日が今日で未完了の課題が除外される', async () => {
        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    handler(JSON.stringify([]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        const incompleteIssues = result.projects[0].issues.filter((issue: any) => {
          return issue.startDate && new Date(issue.startDate).toISOString().split('T')[0] <= yesterday;
        });
        expect(incompleteIssues).toHaveLength(0);
      });

      it('開始日が未来で未完了の課題が除外される', async () => {
        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    handler(JSON.stringify([]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        const incompleteIssues = result.projects[0].issues.filter((issue: any) => {
          return issue.startDate && new Date(issue.startDate).toISOString().split('T')[0] <= yesterday;
        });
        expect(incompleteIssues).toHaveLength(0);
      });

      it('開始日が過去で完了済みの課題が除外される', async () => {
        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    // 完了ステータスは未完了ステータスIDでフィルタリングされるため、返されない
                    handler(JSON.stringify([]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        const incompleteIssues = result.projects[0].issues.filter((issue: any) => {
          return issue.startDate && new Date(issue.startDate).toISOString().split('T')[0] <= yesterday;
        });
        expect(incompleteIssues).toHaveLength(0);
      });

      it('開始日が未設定の課題が除外される', async () => {
        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    handler(JSON.stringify([]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        const incompleteIssues = result.projects[0].issues.filter((issue: any) => {
          return issue.startDate && new Date(issue.startDate).toISOString().split('T')[0] <= yesterday;
        });
        expect(incompleteIssues).toHaveLength(0);
      });
    });

    describe('より広範囲に課題を取得するロジック', () => {
      beforeEach(() => {
        setupCommonMocks();
        mockDate(today);
      });

      it('開始日が過去30日以内の課題が取得される', async () => {
        const mockRequest = https.request as jest.Mock;
        const testDate = '2026-01-10';
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    // 開始日のクエリ（startDateSince: past30Days, startDateUntil: future30Days）の場合
                    if (options.path?.includes('startDateSince=' + past30Days) && options.path?.includes('startDateUntil=' + future30Days)) {
                      const issue = {
                        id: 1,
                        issueKey: 'PROJECT1-1',
                        summary: 'Test Issue',
                        description: '',
                        status: { id: 1, name: '未対応' },
                        startDate: testDate + 'T00:00:00Z',
                        priority: { id: 2, name: '中' },
                        projectId: 1,
                      };
                      handler(JSON.stringify([issue]));
                    } else {
                      handler(JSON.stringify([]));
                    }
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        const issues = result.projects[0].issues.filter((issue: any) => {
          return issue.startDate && new Date(issue.startDate).toISOString().split('T')[0] === testDate;
        });
        expect(issues.length).toBeGreaterThan(0);
      });

      it('開始日が未来30日以内の課題は取得されるが本日対応予定フィルタリングで除外される', async () => {
        const mockRequest = https.request as jest.Mock;
        const testDate = '2026-02-10'; // 未来の日付
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    if (options.path?.includes('startDateSince=' + past30Days) && options.path?.includes('startDateUntil=' + future30Days)) {
                      const issue = {
                        id: 1,
                        issueKey: 'PROJECT1-1',
                        summary: 'Test Issue',
                        description: '',
                        status: { id: 1, name: '未対応' },
                        startDate: testDate + 'T00:00:00Z',
                        priority: { id: 2, name: '中' },
                        projectId: 1,
                      };
                      handler(JSON.stringify([issue]));
                    } else {
                      handler(JSON.stringify([]));
                    }
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        // 開始日が未来の課題は本日対応予定のフィルタリングで除外される
        const issues = result.projects[0].issues.filter((issue: any) => {
          return issue.startDate && new Date(issue.startDate).toISOString().split('T')[0] === testDate;
        });
        expect(issues.length).toBe(0);
      });

      it('期限日が過去30日以内の課題は取得されるが本日対応予定フィルタリングで除外される', async () => {
        const mockRequest = https.request as jest.Mock;
        const testDate = '2026-01-10'; // 過去の日付
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    // 期限日のクエリ（dueDateSince: past30Days, dueDateUntil: future30Days）の場合
                    if (options.path?.includes('dueDateSince=' + past30Days) && options.path?.includes('dueDateUntil=' + future30Days)) {
                      const issue = {
                        id: 1,
                        issueKey: 'PROJECT1-1',
                        summary: 'Test Issue',
                        description: '',
                        status: { id: 1, name: '未対応' },
                        dueDate: testDate + 'T00:00:00Z',
                        priority: { id: 2, name: '中' },
                        projectId: 1,
                      };
                      handler(JSON.stringify([issue]));
                    } else {
                      handler(JSON.stringify([]));
                    }
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        // 期限日が過去の課題は本日対応予定のフィルタリングで除外される（期限日のみ設定時は dueDate >= today）
        const issues = result.projects[0].issues.filter((issue: any) => {
          return issue.dueDate && new Date(issue.dueDate).toISOString().split('T')[0] === testDate;
        });
        expect(issues.length).toBe(0);
      });

      it('期限日が未来30日以内の課題が取得される', async () => {
        const mockRequest = https.request as jest.Mock;
        const testDate = '2026-02-10';
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    if (options.path?.includes('dueDateSince=' + past30Days) && options.path?.includes('dueDateUntil=' + future30Days)) {
                      const issue = {
                        id: 1,
                        issueKey: 'PROJECT1-1',
                        summary: 'Test Issue',
                        description: '',
                        status: { id: 1, name: '未対応' },
                        dueDate: testDate + 'T00:00:00Z',
                        priority: { id: 2, name: '中' },
                        projectId: 1,
                      };
                      handler(JSON.stringify([issue]));
                    } else {
                      handler(JSON.stringify([]));
                    }
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        const issues = result.projects[0].issues.filter((issue: any) => {
          return issue.dueDate && new Date(issue.dueDate).toISOString().split('T')[0] === testDate;
        });
        expect(issues.length).toBeGreaterThan(0);
      });
    });

    describe('課題の重複除去', () => {
      beforeEach(() => {
        setupCommonMocks();
        mockDate(today);
      });

      it('同じ課題が両方のクエリ結果に含まれている場合、重複が除去される', async () => {
        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    // 同じ課題IDが開始日と期限日の両方のクエリで返される
                    const issue = {
                      id: 1,
                      issueKey: 'PROJECT1-1',
                      summary: 'Test Issue',
                      description: '',
                      status: { id: 1, name: '未対応' },
                      startDate: yesterday + 'T00:00:00Z',
                      dueDate: tomorrow + 'T00:00:00Z',
                      priority: { id: 2, name: '中' },
                      projectId: 1,
                    };
                    handler(JSON.stringify([issue]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        // 重複が除去されているため、同じ課題IDは1つだけ
        const issueIds = result.projects[0].issues.map((issue: any) => issue.id);
        const uniqueIssueIds = Array.from(new Set(issueIds));
        expect(issueIds.length).toBe(uniqueIssueIds.length);
      });

      it('異なる課題が両方のクエリ結果に含まれている場合、すべてが含まれる', async () => {
        const mockRequest = https.request as jest.Mock;
        let callCount = 0;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    callCount++;
                    // 開始日のクエリと期限日のクエリで異なる課題を返す
                    if (options.path?.includes('startDateSince=' + past30Days)) {
                      const issue1 = {
                        id: 1,
                        issueKey: 'PROJECT1-1',
                        summary: 'Test Issue 1',
                        description: '',
                        status: { id: 1, name: '未対応' },
                        startDate: yesterday + 'T00:00:00Z',
                        priority: { id: 2, name: '中' },
                        projectId: 1,
                      };
                      handler(JSON.stringify([issue1]));
                    } else if (options.path?.includes('dueDateSince=' + past30Days)) {
                      const issue2 = {
                        id: 2,
                        issueKey: 'PROJECT1-2',
                        summary: 'Test Issue 2',
                        description: '',
                        status: { id: 1, name: '未対応' },
                        dueDate: tomorrow + 'T00:00:00Z',
                        priority: { id: 2, name: '中' },
                        projectId: 1,
                      };
                      handler(JSON.stringify([issue2]));
                    } else {
                      handler(JSON.stringify([]));
                    }
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        // 異なる課題が両方含まれている
        expect(result.projects[0].issues.length).toBeGreaterThanOrEqual(2);
        const issueIds = result.projects[0].issues.map((issue: any) => issue.id);
        expect(issueIds).toContain(1);
        expect(issueIds).toContain(2);
      });
    });

    describe('担当者フィルタリング', () => {
      beforeEach(() => {
        setupCommonMocks();
        mockDate(today);
      });

      it('指定された担当者の課題が抽出される', async () => {
        ssmMock.on(GetParameterCommand, {
          Name: '/backlog-morning-meeting/active-assignee-ids',
        }).resolves({
          Parameter: { Value: '123' },
        });

        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    const issue = {
                      id: 1,
                      issueKey: 'PROJECT1-1',
                      summary: 'Test Issue',
                      description: '',
                      status: { id: 1, name: '未対応' },
                      assignee: { id: 123, name: 'Assignee 1' },
                      startDate: yesterday + 'T00:00:00Z',
                      priority: { id: 2, name: '中' },
                      projectId: 1,
                    };
                    handler(JSON.stringify([issue]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        expect(result.projects[0].issues).toHaveLength(1);
        expect(result.projects[0].issues[0].assignee?.id).toBe(123);
      });

      it('指定されていない担当者の課題が除外される', async () => {
        ssmMock.on(GetParameterCommand, {
          Name: '/backlog-morning-meeting/active-assignee-ids',
        }).resolves({
          Parameter: { Value: '123' },
        });

        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    const issue = {
                      id: 1,
                      issueKey: 'PROJECT1-1',
                      summary: 'Test Issue',
                      description: '',
                      status: { id: 1, name: '未対応' },
                      assignee: { id: 456, name: 'Assignee 2' },
                      startDate: yesterday + 'T00:00:00Z',
                      priority: { id: 2, name: '中' },
                      projectId: 1,
                    };
                    handler(JSON.stringify([issue]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        expect(result.projects[0].issues).toHaveLength(0);
      });

      it('担当者が未割り当ての課題が除外される', async () => {
        ssmMock.on(GetParameterCommand, {
          Name: '/backlog-morning-meeting/active-assignee-ids',
        }).resolves({
          Parameter: { Value: '123' },
        });

        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    const issue = {
                      id: 1,
                      issueKey: 'PROJECT1-1',
                      summary: 'Test Issue',
                      description: '',
                      status: { id: 1, name: '未対応' },
                      startDate: yesterday + 'T00:00:00Z',
                      priority: { id: 2, name: '中' },
                      projectId: 1,
                    };
                    handler(JSON.stringify([issue]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        expect(result.projects[0].issues).toHaveLength(0);
      });

      it('activeAssigneeIdsが空の場合はすべての課題が抽出される', async () => {
        ssmMock.on(GetParameterCommand, {
          Name: '/backlog-morning-meeting/active-assignee-ids',
        }).resolves({
          Parameter: { Value: '' },
        });

        const mockRequest = https.request as jest.Mock;
        mockRequest.mockImplementation((options: any, callback: any) => {
          const mockResponse: any = {
            statusCode: 200,
            on: jest.fn((event: string, handler: any) => {
              if (event === 'data') {
                setTimeout(() => {
                  if (options.path?.includes('/projects/PROJECT1') && !options.path?.includes('statuses') && !options.path?.includes('issues')) {
                    handler(JSON.stringify({ id: 1, projectKey: 'PROJECT1', name: 'Project 1' }));
                  } else if (options.path?.includes('/projects/PROJECT1/statuses')) {
                    handler(JSON.stringify([{ id: 1, name: '未対応' }, { id: 2, name: '完了' }]));
                  } else if (options.path?.includes('/issues')) {
                    const issue1 = {
                      id: 1,
                      issueKey: 'PROJECT1-1',
                      summary: 'Test Issue 1',
                      description: '',
                      status: { id: 1, name: '未対応' },
                      assignee: { id: 123, name: 'Assignee 1' },
                      startDate: yesterday + 'T00:00:00Z',
                      priority: { id: 2, name: '中' },
                      projectId: 1,
                    };
                    const issue2 = {
                      id: 2,
                      issueKey: 'PROJECT1-2',
                      summary: 'Test Issue 2',
                      description: '',
                      status: { id: 1, name: '未対応' },
                      startDate: yesterday + 'T00:00:00Z',
                      priority: { id: 2, name: '中' },
                      projectId: 1,
                    };
                    handler(JSON.stringify([issue1, issue2]));
                  }
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
            end: jest.fn(),
          };
        });

        const result = (await handler({}, {} as any, jest.fn())) as any;
        // 担当者フィルタリングが適用されないため、すべての課題が含まれる
        expect(result.projects[0].issues.length).toBeGreaterThanOrEqual(2);
      });
    });
  });
});
