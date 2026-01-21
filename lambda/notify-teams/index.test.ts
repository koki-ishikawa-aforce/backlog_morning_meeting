import { handler } from './index';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import * as https from 'https';

const secretsManagerMock = mockClient(SecretsManagerClient);

// HTTPSモジュールのモック
jest.mock('https', () => {
  const actualHttps = jest.requireActual('https');
  return {
    ...actualHttps,
    request: jest.fn(),
  };
});

describe('notify-teams', () => {
  beforeEach(() => {
    secretsManagerMock.reset();
    jest.clearAllMocks();
    delete process.env.TEAMS_WORKFLOWS_URL;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('正常系', () => {
    it('環境変数からURLを取得してTeams Workflowsに送信できる', async () => {
      process.env.TEAMS_WORKFLOWS_URL = 'https://example.com/workflows/trigger';

      const mockRequest = https.request as jest.Mock;
      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockResponse: any = {
          statusCode: 200,
          on: jest.fn((event: string, handler: any) => {
            if (event === 'end') {
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
      expect(result.message).toContain('1件のドキュメントを送信しました');
      expect(mockRequest).toHaveBeenCalled();
    });

    it('Secrets ManagerからURLを取得してTeams Workflowsに送信できる', async () => {
      secretsManagerMock.on(GetSecretValueCommand, {
        SecretId: 'backlog-morning-meeting/teams-workflows-url',
      }).resolves({
        SecretString: JSON.stringify({ url: 'https://example.com/workflows/trigger' }),
      });

      const mockRequest = https.request as jest.Mock;
      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockResponse: any = {
          statusCode: 200,
          on: jest.fn((event: string, handler: any) => {
            if (event === 'end') {
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
      expect(secretsManagerMock.calls()).toHaveLength(1);
    });

    it('複数のドキュメントを送信できる', async () => {
      process.env.TEAMS_WORKFLOWS_URL = 'https://example.com/workflows/trigger';

      const mockRequest = https.request as jest.Mock;
      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockResponse: any = {
          statusCode: 200,
          on: jest.fn((event: string, handler: any) => {
            if (event === 'end') {
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
      expect(result.message).toContain('2件のドキュメントを送信しました');
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

    it('URLが設定されていない場合はエラーを投げる', async () => {
      secretsManagerMock.on(GetSecretValueCommand).rejects(new Error('Secret not found'));

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

      await expect(handler(mockEvent, {} as any, jest.fn())).rejects.toThrow('TEAMS_WORKFLOWS_URL環境変数またはSecrets ManagerにURLが設定されていません');
    });

    it('一部のドキュメント送信が失敗しても成功した分は返す', async () => {
      process.env.TEAMS_WORKFLOWS_URL = 'https://example.com/workflows/trigger';

      let callCount = 0;
      const mockRequest = https.request as jest.Mock;
      mockRequest.mockImplementation((options: any, callback: any) => {
        callCount++;
        const mockResponse: any = {
          statusCode: callCount === 1 ? 200 : 500,
          on: jest.fn((event: string, handler: any) => {
            if (event === 'end') {
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
    it('HTTPエラーが発生した場合はエラーを処理する', async () => {
      process.env.TEAMS_WORKFLOWS_URL = 'https://example.com/workflows/trigger';

      const mockRequest = https.request as jest.Mock;
      mockRequest.mockImplementation((options: any, callback: any) => {
        const mockResponse: any = {
          statusCode: 404,
          on: jest.fn((event: string, handler: any) => {
            if (event === 'data') {
              setTimeout(() => handler('Not Found'), 0);
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

      expect(result.success).toBe(false);
      expect(result.message).toContain('失敗: 1件');
    });
  });
});
