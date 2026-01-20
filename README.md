# Backlog朝会ドキュメント自動生成システム

EventBridgeで毎日9:30にスケジュール実行し、Step Functions経由でBacklogから課題を取得して朝会用Markdownドキュメントを生成し、Teamsとメールで通知するAWSサーバーレスシステムです。

## アーキテクチャ

```text
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
  - 本日対応予定の課題（開始日から期限日の期間に今日が含まれる課題）
  - 過去のスケジュールで未完了の課題
  - 今日が期限の課題（期限日が今日）

- **Markdownドキュメント生成**
  - プロジェクトごとに別ドキュメントを生成
  - 担当者別にグループ化して表示
  - 表形式で課題情報を表示
  - 議事録セクション（担当者別）
  - OpenAI（任意）: LLMにMarkdown生成を委譲可能（Secrets ManagerにAPIキーを登録）

- **通知**
  - Teams Workflows経由でSharePointに保存
  - Teamsチャネルに通知
  - メール送信（SES経由・Markdownを `.md` 添付）

## 前提条件

- Node.js 20.x以上
- AWS CLIが設定済み
- AWS CDK CLIがインストール済み（`npm install -g aws-cdk`）
- Backlog APIキーが取得済み
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
  --secret-string '{"apiKey":"YOUR_API_KEY","spaceId":"YOUR_SPACE_ID","domain":"backlog.com"}'
```

- `apiKey`: BacklogのAPIキー（個人設定 → API → 新しいAPIキーの発行）
- `spaceId`: BacklogのスペースID（URLの `https://{spaceId}.backlog.com` の部分）
- `domain`: `backlog.com` または `backlog.jp`（使用しているドメインに応じて設定）

または、AWSコンソールから手動で作成してください。

#### Teams Workflows URL（オプション）

```bash
aws secretsmanager create-secret \
  --name backlog-morning-meeting/teams-workflows-url \
  --secret-string '{"url":"YOUR_TEAMS_WORKFLOWS_HTTP_TRIGGER_URL"}'
```

#### OpenAI APIキー（任意 / LLMでMarkdown生成する場合）

```bash
aws secretsmanager create-secret \
  --name backlog-morning-meeting/openai-api-key \
  --secret-string '{"apiKey":"YOUR_OPENAI_API_KEY"}'
```

### 3. Parameter Storeの設定（AWS側で設定値を一元管理）

```bash
# 対象プロジェクトキー（必須）
aws ssm put-parameter \
  --name /backlog-morning-meeting/project-keys \
  --value "PROJECT1,PROJECT2" \
  --type String

# 有効な担当者ID（オプション: StringList推奨 / 例はカンマ区切り）
aws ssm put-parameter \
  --name /backlog-morning-meeting/active-assignee-ids \
  --value "123,456,789" \
  --type StringList

# メール設定（必須）
aws ssm put-parameter \
  --name /backlog-morning-meeting/email-from \
  --value "noreply@example.com" \
  --type String

aws ssm put-parameter \
  --name /backlog-morning-meeting/email-recipients \
  --value "user1@example.com,user2@example.com" \
  --type StringList
```

### 4. 環境変数の設定

原則不要です（設定値は Secrets Manager / Parameter Store から実行時に取得します）。
Teams Workflows URLのみ、環境変数 `TEAMS_WORKFLOWS_URL` でも上書き可能ですが、基本はSecrets Managerを推奨します。

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

### GitHub Actions自動デプロイ

mainブランチへのpush時に自動的にデプロイが実行されます。

#### GitHub Secretsの設定

リポジトリのSettings > Secrets and variables > Actionsで以下のシークレットを設定してください：

- `AWS_ACCESS_KEY_ID`: AWSアクセスキーID（必須）
- `AWS_SECRET_ACCESS_KEY`: AWSシークレットアクセスキー（必須）
- `AWS_ACCOUNT_ID`: AWSアカウントID（必須）
- `AWS_REGION`: AWSリージョン（オプション、デフォルト: `ap-northeast-1`）

#### IAMユーザーの権限

GitHub Actionsで使用するIAMユーザーには、以下の権限が必要です：

- CDKデプロイに必要な権限（CloudFormation、Lambda、Step Functions、EventBridge、IAM、Secrets Manager、SSM Parameter Store、SESなど）
- CDKブートストラップ済みのS3バケットとECRリポジトリへのアクセス権限

最小権限の原則に従い、必要最小限の権限を付与することを推奨します。

## 環境変数

| 変数名                       | 説明                                        | 必須   | デフォルト              |
| :--------------------------- | :------------------------------------------ | :----- | :---------------------- |
| `TEAMS_WORKFLOWS_URL`        | Teams Workflows HTTPトリガーURL（上書き用） | いいえ | Secrets Managerから取得 |
| `BACKLOG_SECRET_NAME`        | Backlog認証情報Secret名                     | いいえ | CDKで固定               |
| `BACKLOG_PROJECT_KEYS_PARAM` | 対象プロジェクトキーのSSMパラメータ名       | いいえ | CDKで固定               |
| `ACTIVE_ASSIGNEE_IDS_PARAM`  | 有効担当者IDのSSMパラメータ名（任意）       | いいえ | CDKで固定               |
| `EMAIL_FROM_PARAM`           | 送信元のSSMパラメータ名                     | いいえ | CDKで固定               |
| `EMAIL_RECIPIENTS_PARAM`     | 送信先のSSMパラメータ名                     | いいえ | CDKで固定               |

## Teams Workflows側の設定

Teams Workflowsで以下のフローを作成してください：

1. **HTTPトリガー**を作成
   - 認証設定: 「Anyone（認証なし）」または適切な認証設定
   - HTTPトリガーURLを取得

2. **SharePointにファイルを保存**
   - 「Create file」アクションまたは「Send an HTTP request to SharePoint」アクションを使用
   - リクエストボディから`fileName`と`content`を取得
   - SharePointのドキュメントライブラリに保存

   **リクエストボディの構造**:
   ```json
   {
     "fileName": "morning-meeting-PROJECT1-2024-01-20.md",
     "projectKey": "PROJECT1",
     "projectName": "Project 1",
     "content": "# 【朝会ドキュメント】...",
     "timestamp": "2024-01-20T10:00:00.000Z"
   }
   ```

   **Teams Workflowsでの設定例**:
   - **「Create file」アクションを使用する場合**:
     - `Site Address`: SharePointサイトのURL（例: `https://yourtenant.sharepoint.com/sites/YourSite`）
     - `Folder Path`: 保存先フォルダパス（例: `/Shared Documents/朝会ドキュメント`）
     - `File Name`: `triggerBody()?['fileName']` の動的コンテンツ
     - `File Content`: `triggerBody()?['content']` の動的コンテンツ
     
     **ファイル作成後のリンク取得方法**:
     - 「Create file」アクションの出力から、以下のプロパティでファイルのURLを取得できます:
       - `body('Create_file')?['WebUrl']`: ファイルのWeb URL（ブラウザで開く用）
       - `body('Create_file')?['Path']`: ファイルのパス
       - `body('Create_file')?['Id']`: ファイルのID
     
     **動的コンテンツの選択方法**:
     1. 「Post a message in a chat or channel」アクションのメッセージ欄で「動的コンテンツを追加」をクリック
     2. 「Create file」アクションを選択
     3. 「WebUrl」または「Path」プロパティを選択
   
   - **「Send an HTTP request to SharePoint」アクションを使用する場合**:
     - `Site Address`: SharePointサイトのURL
     - `Method`: `POST`
     - `Uri`: `/sites/{site-id}/drive/items/{folder-id}/children`
     - `Headers`: 
       ```json
       {
         "Content-Type": "application/json"
       }
       ```
     - `Body`: 
       ```json
       {
         "name": "@{triggerBody()?['fileName']}",
         "file": {
           "mimeType": "text/markdown",
           "contentBytes": "@{base64(triggerBody()?['content'])}"
         }
       }
       ```
     
     **ファイル作成後のリンク取得方法**:
     - レスポンスボディから`webUrl`プロパティを取得:
       - `body('Send_an_HTTP_request_to_SharePoint')?['body/webUrl']`
       - または、レスポンス全体から: `body('Send_an_HTTP_request_to_SharePoint')?['body']` を選択し、`webUrl`プロパティを参照

3. **Teamsチャネルに通知**
   - 「Post a message in a chat or channel」アクションを使用
   - Markdownテキストを投稿
   - SharePointに保存したファイルのリンクを含める

   **メッセージ例**:
   
   **シンプルな形式（推奨）**:
   ```
   📅 朝会ドキュメントを作成しました: `@{triggerBody()?['fileName']}`
   
   📎 [SharePointで開く](@{body('Create_file')?['WebUrl']})
   ```
   
   **詳細な形式**:
   ```
   📅 朝会ドキュメントが作成されました
   
   **ファイル名**: `@{triggerBody()?['fileName']}`
   **プロジェクト**: @{triggerBody()?['projectName']} (@{triggerBody()?['projectKey']})
   **作成日時**: @{formatDateTime(triggerBody()?['timestamp'], 'yyyy/MM/dd HH:mm')}
   
   📎 [SharePointで開く](@{body('Create_file')?['WebUrl']})
   ```
   
   **動的コンテンツの説明**:
   - `triggerBody()?['fileName']`: リクエストボディからファイル名を取得
   - `triggerBody()?['projectName']`: プロジェクト名を取得
   - `triggerBody()?['projectKey']`: プロジェクトキーを取得
   - `triggerBody()?['timestamp']`: タイムスタンプを取得
   - `body('Create_file')?['WebUrl']`: 「Create file」アクションの出力からSharePointファイルのURLを取得
   
   **重要**: 
   - `body('Create_file')?['WebUrl']`の`'Create_file'`は、実際のアクション名に置き換える必要があります
   - アクション名が「ファイルを作成する」などの日本語の場合: `body('ファイルを作成する')?['WebUrl']`
   - アクション名が「Create file」などの英語の場合: `body('Create file')?['WebUrl']`
   - 動的コンテンツピッカーを使用する場合:
     1. メッセージ欄で「動的コンテンツを追加」をクリック
     2. 「Create file」（または実際のアクション名）を選択
     3. 「WebUrl」プロパティを選択
   - SharePointファイルのURLが取得できない場合は、手動でURLを構築することもできます:
     ```
     📎 [SharePointで開く](https://yourtenant.sharepoint.com/sites/YourSite/Shared%20Documents/@{triggerBody()?['fileName']})
     ```

## 生成されるドキュメントの形式

```markdown
# 【朝会ドキュメント】YYYY/MM/DD - [プロジェクト名]

生成時刻: HH:mm

## 📊 サマリー
| 項目                | 件数  |
| :------------------ | :---: |
| 本日対応予定        |  X件  |
| 未完了課題          |  Y件  |
| 今日締め切り        |  Z件  |

## ⚠️ 期限超過・未完了の課題
### [担当者名]
| 課題キー | 課題名 | ステータス | ... |
...

## 📅 本日対応予定の課題
...

## 🔔 今日締め切りの課題
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

- Backlog MCPは利用しません（Backlog REST APIを直接呼び出します）
- SESのサンドボックス環境の場合は、送信先メールアドレスの検証が必要です
- EventBridgeルールのタイムゾーンはUTC基準のため、JST 9:30 = UTC 0:30として設定しています
- Teams Workflows HTTPトリガーURLはSecrets Managerで管理することを推奨します

## ライセンス

MIT
