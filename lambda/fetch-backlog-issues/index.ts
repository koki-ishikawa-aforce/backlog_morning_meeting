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

interface IssuesByAssignee {
    assigneeName: string;
    assigneeId?: number;
    issues: Issue[];
}

interface LambdaResponse {
    projects: Array<{
        projectKey: string;
        projectName: string;
        todayIssues: IssuesByAssignee[];
        incompleteIssues: IssuesByAssignee[];
        dueTodayIssues: IssuesByAssignee[];
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
        const projects: Array<{
            projectKey: string;
            projectName: string;
            todayIssues: IssuesByAssignee[];
            incompleteIssues: IssuesByAssignee[];
            dueTodayIssues: IssuesByAssignee[];
        }> = [];

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

                // 本日対応予定の課題（開始日から期限日の期間に今日が含まれる課題）
                // より広範囲に課題を取得してからフィルタリング（確実性を重視）
                // 開始日が設定されている未完了課題を広範囲に取得（過去から未来まで）
                // 期限日が設定されている未完了課題を広範囲に取得（過去から未来まで）
                // 両方をマージして重複を除去し、フィルタリングで本日対応予定の課題を抽出
                
                // 開始日が設定されている未完了課題を取得（広範囲: 過去30日から未来30日）
                const past30Days = new Date(jstNow.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                const future30Days = new Date(jstNow.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                
                const issuesWithStartDate = await fetchIssuesFromBacklog(trimmedKey, projectInfo.id, {
                    startDateSince: past30Days,
                    startDateUntil: future30Days,
                    statusId: incompleteStatusIds,
                }, credentials);
                
                // 期限日が設定されている未完了課題を取得（広範囲: 過去30日から未来30日）
                const issuesWithDueDate = await fetchIssuesFromBacklog(trimmedKey, projectInfo.id, {
                    dueDateSince: past30Days,
                    dueDateUntil: future30Days,
                    statusId: incompleteStatusIds,
                }, credentials);
                
                // 両方のクエリ結果をマージして重複を除去
                const allPotentialTodayIssues = [...issuesWithStartDate, ...issuesWithDueDate];
                const uniquePotentialTodayIssues = Array.from(
                    new Map(allPotentialTodayIssues.map(issue => [issue.id, issue])).values()
                );

                // デバッグログ: 課題取得状況
                console.log(`[${trimmedKey}] 本日対応予定 課題取得:`);
                console.log(`  - issuesWithStartDate: ${issuesWithStartDate.length}件`);
                console.log(`  - issuesWithDueDate: ${issuesWithDueDate.length}件`);
                console.log(`  - uniquePotentialTodayIssues: ${uniquePotentialTodayIssues.length}件`);
                console.log(`  - today: ${today}`);

                // デバッグログ: フィルタリング前に課題の詳細を出力
                uniquePotentialTodayIssues.forEach(issue => {
                    console.log(`  検証: ${issue.issueKey} - startDate=${issue.startDate}, dueDate=${issue.dueDate}, assignee=${issue.assignee?.name || '未割り当て'}`);
                });

                // 本日対応予定の課題を抽出
                // 開始日と期限日の両方が設定されている場合: startDate <= today && dueDate >= today
                // 開始日のみ設定されている場合: startDate <= today（開始日が未来の場合は除外）
                // 期限日のみ設定されている場合: dueDate >= today
                const todayIssues = uniquePotentialTodayIssues.filter(issue => {
                    const todayStr = today;
                    
                    // 開始日と期限日の両方が設定されている場合
                    if (issue.startDate && issue.dueDate) {
                        const startDateStr = new Date(issue.startDate).toISOString().split('T')[0];
                        const dueDateStr = new Date(issue.dueDate).toISOString().split('T')[0];
                        // 開始日が未来の場合は除外
                        if (startDateStr > todayStr) return false;
                        return startDateStr <= todayStr && dueDateStr >= todayStr;
                    }
                    
                    // 開始日のみ設定されている場合
                    if (issue.startDate && !issue.dueDate) {
                        const startDateStr = new Date(issue.startDate).toISOString().split('T')[0];
                        // 開始日が未来の場合は除外
                        if (startDateStr > todayStr) return false;
                        return startDateStr <= todayStr;
                    }
                    
                    // 期限日のみ設定されている場合
                    if (!issue.startDate && issue.dueDate) {
                        const dueDateStr = new Date(issue.dueDate).toISOString().split('T')[0];
                        // 期限日が今日以降なら対応予定（開始日が未設定なので、開始日のチェックは不要）
                        return dueDateStr >= todayStr;
                    }
                    
                    // 開始日も期限日も設定されていない場合は除外
                    return false;
                });

                // デバッグログ: フィルタリング後の課題
                console.log(`  - todayIssues（フィルタ後）: ${todayIssues.length}件`);
                todayIssues.forEach(issue => {
                    console.log(`    採用: ${issue.issueKey}`);
                });

                // 期限超過・未完了の課題（期限日が過去、ステータスが未完了）
                const yesterdayStr = new Date(jstNow.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                const incompleteIssues = await fetchIssuesFromBacklog(trimmedKey, projectInfo.id, {
                    dueDateUntil: yesterdayStr,
                    statusId: incompleteStatusIds,
                }, credentials);

                // 今日締め切りの課題（期限日が今日、未完了）
                const dueTodayIssues = await fetchIssuesFromBacklog(trimmedKey, projectInfo.id, {
                    dueDateSince: today,
                    dueDateUntil: today,
                    statusId: incompleteStatusIds,
                }, credentials);

                // 担当者フィルタリング関数
                const filterByAssignee = (issues: Issue[]) =>
                    activeAssigneeIds.length > 0
                        ? issues.filter(issue =>
                            issue.assignee && activeAssigneeIds.includes(issue.assignee.id)
                        )
                        : issues;

                // デバッグログ: 担当者フィルタリング前後
                const filteredTodayIssues = filterByAssignee(todayIssues);
                const filteredIncompleteIssues = filterByAssignee(incompleteIssues);
                const filteredDueTodayIssues = filterByAssignee(dueTodayIssues);
                console.log(`[${trimmedKey}] 担当者フィルタリング:`);
                console.log(`  - activeAssigneeIds: ${activeAssigneeIds.length > 0 ? JSON.stringify(activeAssigneeIds) : '(未設定)'}`);
                console.log(`  - todayIssues: ${todayIssues.length}件 → ${filteredTodayIssues.length}件`);
                console.log(`  - incompleteIssues: ${incompleteIssues.length}件 → ${filteredIncompleteIssues.length}件`);
                console.log(`  - dueTodayIssues: ${dueTodayIssues.length}件 → ${filteredDueTodayIssues.length}件`);

                // 各リストを個別に担当者フィルタリング・グループ化（リスト間の重複は許可）
                projects.push({
                    projectKey: trimmedKey,
                    projectName: projectInfo.name,
                    todayIssues: groupIssuesByAssignee(filteredTodayIssues),
                    incompleteIssues: groupIssuesByAssignee(filteredIncompleteIssues),
                    dueTodayIssues: groupIssuesByAssignee(filteredDueTodayIssues),
                });
            } catch (error) {
                console.error(`プロジェクト ${trimmedKey} の課題取得に失敗:`, error);
                // エラーが発生しても他のプロジェクトの処理は続行
                projects.push({
                    projectKey: trimmedKey,
                    projectName: trimmedKey,
                    todayIssues: [],
                    incompleteIssues: [],
                    dueTodayIssues: [],
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

// 課題を担当者別にグループ化
function groupIssuesByAssignee(issues: Issue[]): IssuesByAssignee[] {
    const grouped = new Map<string, { assigneeId?: number; issues: Issue[] }>();

    for (const issue of issues) {
        const name = issue.assignee?.name || '未割り当て';
        const id = issue.assignee?.id;

        if (!grouped.has(name)) {
            grouped.set(name, { assigneeId: id, issues: [] });
        }
        grouped.get(name)!.issues.push(issue);
    }

    // 担当者名でソートして返す
    return Array.from(grouped.entries())
        .sort(([a], [b]) => a.localeCompare(b, 'ja'))
        .map(([assigneeName, data]) => ({
            assigneeName,
            assigneeId: data.assigneeId,
            issues: data.issues,
        }));
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
