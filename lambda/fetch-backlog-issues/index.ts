import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { Handler } from 'aws-lambda';
import * as https from 'https';
import { URL, URLSearchParams } from 'url';
import { IncomingMessage } from 'http';

const secretsManager = new SecretsManagerClient({});
const ssm = new SSMClient({});

interface BacklogCredentials {
    apiKey: string;
    spaceId: string;
    domain?: string; // 'backlog.com' or 'backlog.jp'
}

interface BacklogApiIssue {
    id: number;
    projectId: number;
    issueKey: string;
    keyId: number;
    issueType: {
        id: number;
        name: string;
    };
    summary: string;
    description: string;
    status: {
        id: number;
        name: string;
    };
    assignee?: {
        id: number;
        name: string;
    };
    dueDate?: string;
    startDate?: string;
    priority: {
        id: number;
        name: string;
    };
    category?: Array<{
        id: number;
        name: string;
    }>;
}

interface BacklogProject {
    id: number;
    projectKey: string;
    name: string;
}

interface BacklogStatus {
    id: number;
    name: string;
}

interface Issue {
    id: number;
    issueKey: string;
    summary: string;
    description: string;
    status: {
        id: number;
        name: string;
    };
    assignee?: {
        id: number;
        name: string;
    };
    dueDate?: string;
    startDate?: string;
    priority: {
        id: number;
        name: string;
    };
    category?: Array<{
        id: number;
        name: string;
    }>;
    url: string;
    project: {
        id: number;
        projectKey: string;
        name: string;
    };
}

interface LambdaResponse {
    projects: Array<{
        projectKey: string;
        projectName: string;
        issues: Issue[];
    }>;
    activeAssigneeIds: number[];
}

export const handler: Handler<{}, LambdaResponse> = async (event): Promise<LambdaResponse> => {
    try {
        // 環境変数から設定を取得
        const secretName = process.env.BACKLOG_SECRET_NAME || 'backlog-morning-meeting/backlog-credentials';
        const paramName = process.env.ACTIVE_ASSIGNEE_IDS_PARAM || '/backlog-morning-meeting/active-assignee-ids';
        const projectKeysParamName = process.env.BACKLOG_PROJECT_KEYS_PARAM || '/backlog-morning-meeting/project-keys';

        // Parameter Storeから対象プロジェクトキーを取得（必須）
        const projectKeysValue = await getSsmParameterValue(projectKeysParamName);
        const projectKeys = parseStringList(projectKeysValue);

        if (projectKeys.length === 0) {
            throw new Error(`対象プロジェクトキーが取得できません（SSM: ${projectKeysParamName}）`);
        }

        // Secrets Managerから認証情報を取得
        let credentials: BacklogCredentials;
        try {
            const secretResponse = await secretsManager.send(
                new GetSecretValueCommand({ SecretId: secretName })
            );
            credentials = JSON.parse(secretResponse.SecretString || '{}');
            if (!credentials.apiKey || !credentials.spaceId) {
                throw new Error('認証情報にapiKeyまたはspaceIdが含まれていません');
            }
        } catch (error) {
            throw new Error(`Secrets Managerからの認証情報取得に失敗: ${error}`);
        }

        // Parameter Storeまたは環境変数から有効な担当者IDを取得
        let activeAssigneeIds: number[] = [];

        // Parameter Storeから取得（オプション）
        try {
            const assigneeIdsValue = await getSsmParameterValue(paramName);
            activeAssigneeIds = parseAssigneeIds(assigneeIdsValue);
        } catch (error) {
            console.warn(`Parameter Storeからの担当者ID取得に失敗（スキップ）: ${error}`);
        }

        // 現在日時を取得（JST）
        const now = new Date();
        const jstOffset = 9 * 60 * 60 * 1000; // JST is UTC+9
        const jstNow = new Date(now.getTime() + jstOffset);
        const today = jstNow.toISOString().split('T')[0]; // YYYY-MM-DD形式

        // 7日後の日付を計算
        const sevenDaysLater = new Date(jstNow.getTime() + 7 * 24 * 60 * 60 * 1000);
        const sevenDaysLaterStr = sevenDaysLater.toISOString().split('T')[0];

        // プロジェクトごとに課題を取得
        const projects: Array<{ projectKey: string; projectName: string; issues: Issue[] }> = [];

        for (const projectKey of projectKeys) {
            const trimmedKey = projectKey.trim();

            try {
                // プロジェクト情報を取得
                const projectInfo = await getProjectInfo(trimmedKey, credentials);

                // プロジェクトのステータス一覧を取得（未完了ステータスを特定するため）
                const statuses = await getProjectStatuses(trimmedKey, credentials);
                const incompleteStatusIds = statuses
                    .filter(s => s.name !== '完了' && s.name !== 'クローズ' && s.name !== 'Closed')
                    .map(s => s.id);

                // 本日対応予定の課題（開始日が今日）
                const todayIssues = await fetchIssuesFromBacklog(trimmedKey, projectInfo.id, {
                    startDateSince: today,
                    startDateUntil: today,
                    statusId: incompleteStatusIds,
                }, credentials);

                // 過去のスケジュールで未完了の課題（開始日が過去、ステータスが未完了）
                const yesterdayStr = new Date(jstNow.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                const incompleteIssues = await fetchIssuesFromBacklog(trimmedKey, projectInfo.id, {
                    startDateUntil: yesterdayStr,
                    statusId: incompleteStatusIds,
                }, credentials);

                // 期限が近い課題（期限日が今日から7日以内、未完了）
                const dueSoonIssues = await fetchIssuesFromBacklog(trimmedKey, projectInfo.id, {
                    dueDateSince: today,
                    dueDateUntil: sevenDaysLaterStr,
                    statusId: incompleteStatusIds,
                }, credentials);

                // 課題をマージして重複を除去
                const allIssues = [...todayIssues, ...incompleteIssues, ...dueSoonIssues];
                const uniqueIssues = Array.from(
                    new Map(allIssues.map(issue => [issue.id, issue])).values()
                );

                // 担当者フィルタリング
                const filteredIssues = activeAssigneeIds.length > 0
                    ? uniqueIssues.filter(issue =>
                        issue.assignee && activeAssigneeIds.includes(issue.assignee.id)
                    )
                    : uniqueIssues;

                projects.push({
                    projectKey: trimmedKey,
                    projectName: projectInfo.name,
                    issues: filteredIssues,
                });
            } catch (error) {
                console.error(`プロジェクト ${trimmedKey} の課題取得に失敗:`, error);
                // エラーが発生しても他のプロジェクトの処理は続行
                projects.push({
                    projectKey: trimmedKey,
                    projectName: trimmedKey,
                    issues: [],
                });
            }
        }

        return {
            projects,
            activeAssigneeIds,
        };
    } catch (error) {
        console.error('エラー:', error);
        throw error;
    }
};

async function getSsmParameterValue(name: string): Promise<string> {
    const paramResponse = await ssm.send(
        new GetParameterCommand({ Name: name })
    );
    return paramResponse.Parameter?.Value || '';
}

function parseStringList(value: string): string[] {
    return (value || '')
        .split(',')
        .map(v => v.trim())
        .filter(v => v.length > 0);
}

function parseAssigneeIds(value: string): number[] {
    const trimmed = (value || '').trim();
    if (!trimmed) return [];

    // 1) JSON配列形式: [1,2,3] / ["1","2"]
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (Array.isArray(parsed)) {
                return parsed
                    .map((v) => (typeof v === 'number' ? v : parseInt(String(v), 10)))
                    .filter((n) => Number.isFinite(n));
            }
        } catch {
            // fallthrough
        }
    }

    // 2) StringList/カンマ区切り形式: 1,2,3
    return trimmed
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n));
}

// Backlog APIのベースURLを取得
function getBacklogBaseUrl(credentials: BacklogCredentials): string {
    const domain = credentials.domain || 'backlog.com';
    return `https://${credentials.spaceId}.${domain}/api/v2`;
}

// Backlog APIを呼び出す汎用関数
function callBacklogApi<T>(path: string, credentials: BacklogCredentials): Promise<T> {
    return new Promise((resolve, reject) => {
        const baseUrl = getBacklogBaseUrl(credentials);
        const separator = path.includes('?') ? '&' : '?';
        const url = `${baseUrl}${path}${separator}apiKey=${credentials.apiKey}`;

        const urlObj = new URL(url);

        const options = {
            hostname: urlObj.hostname,
            port: 443,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        };

        const req = https.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed as T);
                    } catch (e) {
                        reject(new Error(`JSONパースエラー: ${e}`));
                    }
                } else {
                    reject(new Error(`Backlog API エラー: HTTP ${res.statusCode} - ${data}`));
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.end();
    });
}

// プロジェクト情報を取得
async function getProjectInfo(
    projectKey: string,
    credentials: BacklogCredentials
): Promise<BacklogProject> {
    return callBacklogApi<BacklogProject>(`/projects/${projectKey}`, credentials);
}

// プロジェクトのステータス一覧を取得
async function getProjectStatuses(
    projectKey: string,
    credentials: BacklogCredentials
): Promise<BacklogStatus[]> {
    return callBacklogApi<BacklogStatus[]>(`/projects/${projectKey}/statuses`, credentials);
}

// 課題一覧を取得
async function fetchIssuesFromBacklog(
    projectKey: string,
    projectId: number,
    filters: {
        startDateSince?: string;
        startDateUntil?: string;
        dueDateSince?: string;
        dueDateUntil?: string;
        statusId?: number[];
    },
    credentials: BacklogCredentials
): Promise<Issue[]> {
    // クエリパラメータを構築
    const params = new URLSearchParams();
    params.append('projectId[]', projectId.toString());
    params.append('count', '100'); // 最大100件

    if (filters.startDateSince) {
        params.append('startDateSince', filters.startDateSince);
    }
    if (filters.startDateUntil) {
        params.append('startDateUntil', filters.startDateUntil);
    }
    if (filters.dueDateSince) {
        params.append('dueDateSince', filters.dueDateSince);
    }
    if (filters.dueDateUntil) {
        params.append('dueDateUntil', filters.dueDateUntil);
    }
    if (filters.statusId && filters.statusId.length > 0) {
        filters.statusId.forEach(id => params.append('statusId[]', id.toString()));
    }

    const path = `/issues?${params.toString()}`;
    const apiIssues = await callBacklogApi<BacklogApiIssue[]>(path, credentials);

    // APIレスポンスをIssue形式に変換
    const baseUrl = `https://${credentials.spaceId}.${credentials.domain || 'backlog.com'}`;

    return apiIssues.map(issue => ({
        id: issue.id,
        issueKey: issue.issueKey,
        summary: issue.summary,
        description: issue.description || '',
        status: issue.status,
        assignee: issue.assignee,
        dueDate: issue.dueDate,
        startDate: issue.startDate,
        priority: issue.priority,
        category: issue.category,
        url: `${baseUrl}/view/${issue.issueKey}`,
        project: {
            id: issue.projectId,
            projectKey: projectKey,
            name: projectKey, // プロジェクト名は別途取得済み
        },
    }));
}
