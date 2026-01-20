# Backlog朝会ドキュメント自動生成システム

EventBridgeで毎日9:30にスケジュール実行し、Step Functions経由でBacklogから課題を取得して朝会用Markdownドキュメントを生成し、Teamsとメールで通知するAWSサーバーレスシステムです。

## アーキテクチャ

```
EventBridge (9:30 JST)
  ↓
Step Functions
  ↓
Lambda: fetch-backlog-issues (Backlogから課題取得)
  ↓
Lambda: generate-document (Markdown生成)
  ↓
  ├─→ Lambda: notify-teams → Teams Workflows → SharePoint保存 + Teams通知
  └─→ Lambda: send-email → SES → メール送信
```

## 機能

- **Backlogから課題を取得**
  - 本日対応予定の課題（開始日が今日）
  - 過去のスケジュールで未完了の課題
  - 期限が近い課題（7日以内）

- **Markdownドキュメント生成**
  - プロジェクトごとに別ドキュメントを生成
  - 担当者別にグループ化して表示
  - 表形式で課題情報を表示
  - 議事録セクション（担当者別）

- **通知**
  - Teams Workflows経由でSharePointに保存
  - Teamsチャネルに通知
  - メール送信（SES経由）

## 前提条件

- Node.js 20.x以上
- AWS CLIが設定済み
- AWS CDK CLIがインストール済み（`npm install -g aws-cdk`）
- Backlog MCPサーバーが設定済み
- Teams Workflows HTTPトリガーが設定済み

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. Secrets Managerの設定

#### Backlog認証情報

```bash
aws secretsmanager create-secret \
  --name backlog-morning-meeting/backlog-credentials \
  --secret-string '{"apiKey":"YOUR_API_KEY","spaceId":"YOUR_SPACE_ID"}'
```

または、AWSコンソールから手動で作成してください。

#### Teams Workflows URL（オプション）

```bash
aws secretsmanager create-secret \
  --name backlog-morning-meeting/teams-workflows-url \
  --secret-string '{"url":"YOUR_TEAMS_WORKFLOWS_HTTP_TRIGGER_URL"}'
```

### 3. Parameter Storeの設定（担当者ID管理）

```bash
aws ssm put-parameter \
  --name /backlog-morning-meeting/active-assignee-ids \
  --value '[123,456,789]' \
  --type String
```

### 4. 環境変数の設定

`.env`ファイルを作成するか、デプロイ時に環境変数を設定してください：

```bash
export BACKLOG_PROJECT_KEYS="PROJECT1,PROJECT2"
export ACTIVE_ASSIGNEE_IDS="123,456,789"  # オプション（Parameter Storeを使用する場合は不要）
export TEAMS_WORKFLOWS_URL="https://..."  # オプション（Secrets Managerを使用する場合は不要）
export EMAIL_RECIPIENTS="user1@example.com,user2@example.com"
export EMAIL_FROM="noreply@example.com"
```

### 5. SESの設定

メール送信を使用する場合、SESで以下を設定してください：

1. 送信元メールアドレスの検証
2. サンドボックス環境の場合は、送信先メールアドレスの検証も必要

```bash
aws ses verify-email-identity --email-address noreply@example.com
```

## デプロイ

### 初回デプロイ

```bash
# CDKブートストラップ（初回のみ）
cdk bootstrap

# デプロイ
cdk deploy
```

### 環境変数を指定してデプロイ

```bash
BACKLOG_PROJECT_KEYS="PROJECT1,PROJECT2" \
EMAIL_RECIPIENTS="user1@example.com" \
EMAIL_FROM="noreply@example.com" \
cdk deploy
```

## 環境変数

| 変数名 | 説明 | 必須 | デフォルト |
|:---|:---|:---|:---|
| `BACKLOG_PROJECT_KEYS` | 対象プロジェクトキー（カンマ区切り） | はい | - |
| `ACTIVE_ASSIGNEE_IDS` | 有効な担当者ID（カンマ区切り） | いいえ | Parameter Storeから取得 |
| `TEAMS_WORKFLOWS_URL` | Teams Workflows HTTPトリガーURL | いいえ | Secrets Managerから取得 |
| `EMAIL_RECIPIENTS` | メール送信先（カンマ区切り） | はい | - |
| `EMAIL_FROM` | 送信元メールアドレス | はい | - |

## Teams Workflows側の設定

Teams Workflowsで以下のフローを作成してください：

1. **HTTPトリガー**を作成
   - 認証設定: 「Anyone（認証なし）」または適切な認証設定
   - HTTPトリガーURLを取得

2. **SharePointにファイルを保存**
   - 「Create file」アクションまたは「Send an HTTP request to SharePoint」アクションを使用
   - リクエストボディから`fileName`と`content`を取得
   - SharePointのドキュメントライブラリに保存

3. **Teamsチャネルに通知**
   - 「Post a message in a chat or channel」アクションを使用
   - Markdownテキストを投稿
   - SharePointに保存したファイルのリンクを含める

## 生成されるドキュメントの形式

```markdown
# 【朝会ドキュメント】YYYY/MM/DD - [プロジェクト名]

生成時刻: HH:mm

## 📊 サマリー
| 項目 | 件数 |
|:---|:---:|
| 本日対応予定 | X件 |
| 未完了課題 | Y件 |
| 期限間近（7日以内） | Z件 |

## ⚠️ 期限超過・未完了の課題
### [担当者名]
| 課題キー | 課題名 | ステータス | ... |
...

## 📅 本日対応予定の課題
...

## 🔔 期限が近い課題（7日以内）
...

## 📝 議事録
### [担当者名1]
<!-- ここに議事録を記入 -->
...
```

## トラブルシューティング

### Backlog MCP接続エラー

`fetch-backlog-issues`関数でBacklog MCPへの接続に失敗する場合：

1. MCPサーバーが正しく設定されているか確認
2. Secrets Managerの認証情報が正しいか確認
3. CloudWatch Logsでエラーログを確認

### Teams Workflowsへの送信エラー

`notify-teams`関数でエラーが発生する場合：

1. Teams Workflows HTTPトリガーURLが正しいか確認
2. HTTPトリガーの認証設定を確認
3. CloudWatch Logsでエラーログを確認

### メール送信エラー

`send-email`関数でエラーが発生する場合：

1. SESで送信元メールアドレスが検証されているか確認
2. サンドボックス環境の場合は、送信先メールアドレスも検証が必要
3. CloudWatch Logsでエラーログを確認

## 注意事項

- Backlog MCPサーバーが既に設定されていることを前提とします
- SESのサンドボックス環境の場合は、送信先メールアドレスの検証が必要です
- EventBridgeルールのタイムゾーンはUTC基準のため、JST 9:30 = UTC 0:30として設定しています
- Teams Workflows HTTPトリガーURLはSecrets Managerで管理することを推奨します

## ライセンス

MIT

