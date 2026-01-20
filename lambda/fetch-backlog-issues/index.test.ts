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
                // 課題一覧取得
                else if (options.path?.includes('/issues')) {
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
});
