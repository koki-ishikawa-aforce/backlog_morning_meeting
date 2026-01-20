import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Handler } from 'aws-lambda';
import https from 'https';
import { URL } from 'url';

const secretsManager = new SecretsManagerClient({});

interface Document {
  projectKey: string;
  projectName: string;
  fileName: string;
  content: string;
}

interface LambdaEvent {
  documents: Document[];
}

interface LambdaResponse {
  success: boolean;
  message: string;
}

export const handler: Handler<LambdaEvent, LambdaResponse> = async (event) => {
  try {
    const { documents } = event;

    if (!documents || documents.length === 0) {
      return {
        success: false,
        message: 'ドキュメントがありません',
      };
    }

    // Teams Workflows URLを取得
    let teamsWorkflowsUrl = process.env.TEAMS_WORKFLOWS_URL || '';

    // Secrets Managerから取得を試みる
    if (!teamsWorkflowsUrl) {
      try {
        const secretResponse = await secretsManager.send(
          new GetSecretValueCommand({ SecretId: 'backlog-morning-meeting/teams-workflows-url' })
        );
        const secret = JSON.parse(secretResponse.SecretString || '{}');
        teamsWorkflowsUrl = secret.url || secret.TEAMS_WORKFLOWS_URL || '';
      } catch (error) {
        console.warn('Secrets ManagerからのURL取得に失敗:', error);
      }
    }

    if (!teamsWorkflowsUrl) {
      throw new Error('TEAMS_WORKFLOWS_URL環境変数またはSecrets ManagerにURLが設定されていません');
    }

    // 各ドキュメントをTeams Workflowsに送信
    const results = await Promise.allSettled(
      documents.map(doc => sendToTeamsWorkflows(doc, teamsWorkflowsUrl))
    );

    const successCount = results.filter(r => r.status === 'fulfilled').length;
    const failureCount = results.filter(r => r.status === 'rejected').length;

    if (failureCount > 0) {
      console.error('一部のドキュメントの送信に失敗しました');
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.error(`ドキュメント ${documents[index].fileName} の送信に失敗:`, result.reason);
        }
      });
    }

    return {
      success: successCount > 0,
      message: `${successCount}件のドキュメントを送信しました（失敗: ${failureCount}件）`,
    };
  } catch (error) {
    console.error('エラー:', error);
    throw error;
  }
};

function sendToTeamsWorkflows(document: Document, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    
    const payload = JSON.stringify({
      fileName: document.fileName,
      projectKey: document.projectKey,
      projectName: document.projectName,
      content: document.content,
      timestamp: new Date().toISOString(),
    });

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`ドキュメント ${document.fileName} の送信に成功`);
          resolve();
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(payload);
    req.end();
  });
}

