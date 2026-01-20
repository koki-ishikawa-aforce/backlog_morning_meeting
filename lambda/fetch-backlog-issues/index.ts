import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { Handler } from 'aws-lambda';

const secretsManager = new SecretsManagerClient({});
const ssm = new SSMClient({});

interface BacklogCredentials {
  apiKey?: string;
  token?: string;
  spaceId?: string;
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

export const handler: Handler = async (event): Promise<LambdaResponse> => {
  try {
    // 環境変数から設定を取得
    const projectKeys = (process.env.BACKLOG_PROJECT_KEYS || '').split(',').filter(k => k.trim());
    const activeAssigneeIdsEnv = process.env.ACTIVE_ASSIGNEE_IDS || '';
    const secretName = process.env.BACKLOG_SECRET_NAME || 'backlog-morning-meeting/backlog-credentials';
    const paramName = process.env.ACTIVE_ASSIGNEE_IDS_PARAM || '/backlog-morning-meeting/active-assignee-ids';

    if (projectKeys.length === 0) {
      throw new Error('BACKLOG_PROJECT_KEYS環境変数が設定されていません');
    }

    // Secrets Managerから認証情報を取得
    let credentials: BacklogCredentials;
    try {
      const secretResponse = await secretsManager.send(
        new GetSecretValueCommand({ SecretId: secretName })
      );
      credentials = JSON.parse(secretResponse.SecretString || '{}');
    } catch (error) {
      throw new Error(`Secrets Managerからの認証情報取得に失敗: ${error}`);
    }

    // Parameter Storeまたは環境変数から有効な担当者IDを取得
    let activeAssigneeIds: number[] = [];
    
    if (activeAssigneeIdsEnv) {
      // 環境変数から取得（カンマ区切り）
      activeAssigneeIds = activeAssigneeIdsEnv
        .split(',')
        .map(id => parseInt(id.trim(), 10))
        .filter(id => !isNaN(id));
    } else {
      // Parameter Storeから取得
      try {
        const paramResponse = await ssm.send(
          new GetParameterCommand({ Name: paramName })
        );
        const paramValue = paramResponse.Parameter?.Value || '[]';
        activeAssigneeIds = JSON.parse(paramValue);
      } catch (error) {
        console.warn(`Parameter Storeからの担当者ID取得に失敗（スキップ）: ${error}`);
      }
    }

    // 現在日時を取得（JST）
    const now = new Date();
    const jstNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const today = jstNow.toISOString().split('T')[0]; // YYYY-MM-DD形式

    // 7日後の日付を計算
    const sevenDaysLater = new Date(jstNow);
    sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);
    const sevenDaysLaterStr = sevenDaysLater.toISOString().split('T')[0];

    // プロジェクトごとに課題を取得
    const projects: Array<{ projectKey: string; projectName: string; issues: Issue[] }> = [];

    for (const projectKey of projectKeys) {
      const trimmedKey = projectKey.trim();
      
      try {
        // Backlog MCPを使用して課題を取得
        // 注意: 実際の実装では、MCPサーバーへの接続が必要です
        // ここでは、MCPクライアントを使用する想定で実装します
        
        // 本日対応予定の課題（開始日が今日）
        const todayIssues = await fetchIssuesFromBacklog(trimmedKey, {
          startDateSince: today,
          startDateUntil: today,
          statusId: [], // すべてのステータス
        }, credentials);

        // 過去のスケジュールで未完了の課題（開始日が過去、ステータスが未完了）
        const incompleteIssues = await fetchIssuesFromBacklog(trimmedKey, {
          startDateUntil: today,
          statusId: [], // 未完了ステータスのIDを指定する必要があります
        }, credentials);

        // 期限が近い課題（期限日が今日から7日以内）
        const dueSoonIssues = await fetchIssuesFromBacklog(trimmedKey, {
          dueDateSince: today,
          dueDateUntil: sevenDaysLaterStr,
          statusId: [],
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

        // プロジェクト情報を取得
        const projectInfo = await getProjectInfo(trimmedKey, credentials);

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

// Backlog MCPを使用して課題を取得する関数
// 注意: 実際の実装では、MCPサーバーへの接続が必要です
async function fetchIssuesFromBacklog(
  projectKey: string,
  filters: {
    startDateSince?: string;
    startDateUntil?: string;
    dueDateSince?: string;
    dueDateUntil?: string;
    statusId?: number[];
  },
  credentials: BacklogCredentials
): Promise<Issue[]> {
  // TODO: Backlog MCPを使用して実際に課題を取得する実装が必要です
  // 現在は、MCPクライアントの実装方法に依存します
  
  // プレースホルダー: 実際のMCP呼び出しに置き換える必要があります
  // 例: const response = await mcpClient.call('backlog_get_issues', { projectKey, ...filters });
  
  return [];
}

// プロジェクト情報を取得する関数
async function getProjectInfo(
  projectKey: string,
  credentials: BacklogCredentials
): Promise<{ name: string }> {
  // TODO: Backlog MCPを使用してプロジェクト情報を取得する実装が必要です
  return { name: projectKey };
}

