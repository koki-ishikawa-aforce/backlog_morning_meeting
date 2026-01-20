/**
 * fetch-backlog-issues Lambda関数のローカル実行スクリプト
 * 
 * 使用方法:
 *   npx ts-node scripts/run-fetch-backlog-issues.ts
 * 
 * 環境変数:
 *   BACKLOG_API_KEY      - Backlog APIキー
 *   BACKLOG_SPACE_ID     - BacklogスペースID（例: your-space）
 *   BACKLOG_DOMAIN       - Backlogドメイン（backlog.com または backlog.jp）
 *   BACKLOG_PROJECT_KEYS - プロジェクトキー（カンマ区切り、例: PROJ1,PROJ2）
 *   ACTIVE_ASSIGNEE_IDS  - 有効な担当者ID（カンマ区切り、オプション）
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';

// 環境変数から設定を取得
const BACKLOG_API_KEY = process.env.BACKLOG_API_KEY || '';
const BACKLOG_SPACE_ID = process.env.BACKLOG_SPACE_ID || '';
const BACKLOG_DOMAIN = process.env.BACKLOG_DOMAIN || 'backlog.com';
const BACKLOG_PROJECT_KEYS = process.env.BACKLOG_PROJECT_KEYS || '';
const ACTIVE_ASSIGNEE_IDS = process.env.ACTIVE_ASSIGNEE_IDS || '';

async function main() {
  // 必須環境変数のチェック
  if (!BACKLOG_API_KEY || !BACKLOG_SPACE_ID || !BACKLOG_PROJECT_KEYS) {
    console.error('❌ 必須環境変数が設定されていません:');
    console.error('   BACKLOG_API_KEY, BACKLOG_SPACE_ID, BACKLOG_PROJECT_KEYS');
    console.error('');
    console.error('使用例:');
    console.error('  BACKLOG_API_KEY=xxx BACKLOG_SPACE_ID=your-space BACKLOG_PROJECT_KEYS=PROJ1 npx ts-node scripts/run-fetch-backlog-issues.ts');
    process.exit(1);
  }

  console.log('🚀 fetch-backlog-issues ローカル実行');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`スペースID: ${BACKLOG_SPACE_ID}`);
  console.log(`ドメイン: ${BACKLOG_DOMAIN}`);
  console.log(`プロジェクト: ${BACKLOG_PROJECT_KEYS}`);
  console.log(`担当者ID: ${ACTIVE_ASSIGNEE_IDS || '(全員)'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  // AWS SDKをモック
  const secretsManagerMock = mockClient(SecretsManagerClient);
  const ssmMock = mockClient(SSMClient);

  // Secrets Managerモック - Backlog認証情報
  secretsManagerMock.on(GetSecretValueCommand).resolves({
    SecretString: JSON.stringify({
      apiKey: BACKLOG_API_KEY,
      spaceId: BACKLOG_SPACE_ID,
      domain: BACKLOG_DOMAIN,
    }),
  });

  // SSM Parameter Storeモック - プロジェクトキー
  ssmMock.on(GetParameterCommand, {
    Name: '/backlog-morning-meeting/project-keys',
  }).resolves({
    Parameter: { Value: BACKLOG_PROJECT_KEYS },
  });

  // SSM Parameter Storeモック - 担当者ID
  ssmMock.on(GetParameterCommand, {
    Name: '/backlog-morning-meeting/active-assignee-ids',
  }).resolves({
    Parameter: { Value: ACTIVE_ASSIGNEE_IDS },
  });

  // 環境変数を設定
  process.env.BACKLOG_SECRET_NAME = 'backlog-morning-meeting/backlog-credentials';
  process.env.ACTIVE_ASSIGNEE_IDS_PARAM = '/backlog-morning-meeting/active-assignee-ids';
  process.env.BACKLOG_PROJECT_KEYS_PARAM = '/backlog-morning-meeting/project-keys';

  try {
    // handlerをインポートして実行
    const { handler } = await import('../lambda/fetch-backlog-issues/index');
    
    console.log('⏳ Backlog APIから課題を取得中...\n');
    
    const result = await handler({}, {} as any, () => {});
    
    console.log('✅ 取得完了!\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 結果サマリー');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    for (const project of result!.projects) {
      console.log(`\n📁 プロジェクト: ${project.projectName} (${project.projectKey})`);
      
      const countIssues = (groups: any[]) => 
        groups.reduce((sum, g) => sum + g.issues.length, 0);
      
      console.log(`   📅 本日対応予定: ${countIssues(project.todayIssues)}件`);
      console.log(`   ⚠️  期限超過・未完了: ${countIssues(project.incompleteIssues)}件`);
      console.log(`   🔔 今日締め切り: ${countIssues(project.dueTodayIssues)}件`);
    }
    
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📝 詳細データ (JSON)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(JSON.stringify(result, null, 2));
    
  } catch (error) {
    console.error('❌ エラー:', error);
    process.exit(1);
  }
}

main();
