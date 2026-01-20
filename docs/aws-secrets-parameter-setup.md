# AWS Secrets Manager / Parameter Store 設定ガイド

このドキュメントでは、Backlog朝会システムに必要なAWS Secrets ManagerとParameter Storeの設定手順を説明します。

## リージョンについて（重要）

本システムは **Lambda実行リージョンと同じリージョン** の Secrets Manager / Parameter Store を参照します。  
本手順書では **`ap-northeast-1`（東京）** を前提に、すべてのAWS CLIコマンドに `--region ap-northeast-1` を付けています。

## 目次

1. [前提条件](#前提条件)
2. [AWS CLIのセットアップ](#aws-cliのセットアップ)
3. [Secrets Managerの設定](#secrets-managerの設定)
4. [Parameter Storeの設定](#parameter-storeの設定)
5. [設定値の確認](#設定値の確認)
6. [トラブルシューティング](#トラブルシューティング)

---

## 前提条件

- AWSアカウントを持っていること
- AWS CLIがインストールされていること
- 適切なIAM権限があること

### 必要なIAM権限

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:CreateSecret",
        "secretsmanager:GetSecretValue",
        "secretsmanager:UpdateSecret",
        "secretsmanager:DeleteSecret",
        "secretsmanager:ListSecrets"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ssm:PutParameter",
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:DeleteParameter",
        "ssm:DescribeParameters"
      ],
      "Resource": "*"
    }
  ]
}
```

---

## AWS CLIのセットアップ

### 1. インストール（Windows）

#### 方法A: MSIインストーラー（推奨）

1. [AWS CLI公式ページ](https://aws.amazon.com/cli/)からMSIインストーラーをダウンロード
2. ダウンロードした `AWSCLIV2.msi` を実行
3. インストールウィザードに従って完了

#### 方法B: PowerShellでインストール

```powershell
# ダウンロードしてインストール
msiexec.exe /i https://awscli.amazonaws.com/AWSCLIV2.msi /quiet

# インストール確認
aws --version
```

### 2. 認証設定

```powershell
aws configure
```

プロンプトに従って入力:

```
AWS Access Key ID [None]: YOUR_ACCESS_KEY_ID
AWS Secret Access Key [None]: YOUR_SECRET_ACCESS_KEY
Default region name [None]: ap-northeast-1
Default output format [None]: json
```

### 3. 設定確認

```powershell
aws sts get-caller-identity
```

成功すると以下のような出力:

```json
{
    "UserId": "AIDAXXXXXXXXXXXXXXXXX",
    "Account": "123456789012",
    "Arn": "arn:aws:iam::123456789012:user/your-username"
}
```

---

## Secrets Managerの設定

### 1. Backlog認証情報の登録

Backlog APIへのアクセスに必要な認証情報を登録します。

```powershell
aws secretsmanager create-secret `
  --name "backlog-morning-meeting/backlog-credentials" `
  --description "Backlog API credentials for morning meeting system" `
  --secret-string '{\"apiKey\":\"YOUR_BACKLOG_API_KEY\",\"spaceId\":\"YOUR_SPACE_ID\",\"domain\":\"backlog.com\"}' `
  --region ap-northeast-1
```

#### `spaceId` について（重要）

Backlog APIのエンドポイントは `GET /api/v2/issues` のようにパスで説明されていますが、実際の呼び出し先ホストは **`{spaceId}.{domain}`** になります。

- 例: `spaceId=your-company`, `domain=backlog.com` の場合  
  `https://your-company.backlog.com/api/v2/issues`

参考: [課題一覧の取得（Backlog API v2）](https://developer.nulab.com/ja/docs/backlog/api/2/get-issue-list/)

#### パラメータ説明

| パラメータ | 説明              | 例                                     |
| ---------- | ----------------- | -------------------------------------- |
| `apiKey`   | Backlog APIキー   | `abcdefghijklmnopqrstuvwxyz1234567890` |
| `spaceId`  | BacklogスペースID | `your-company`                         |
| `domain`   | Backlogドメイン   | `backlog.com` または `backlog.jp`      |

#### Backlog APIキーの取得方法

1. Backlogにログイン
2. 右上のプロフィールアイコン → **個人設定**
3. **API** → **新しいAPIキーの発行**
4. メモを入力して **登録**
5. 表示されたAPIキーをコピー

### 2. Teams Workflows URLの登録

Teams Workflowsで作成したHTTPトリガーのURLを登録します。

```powershell
aws secretsmanager create-secret `
  --name "backlog-morning-meeting/teams-workflows-url" `
  --description "Teams Workflows HTTP trigger URL" `
  --secret-string '{\"url\":\"https://prod-XX.japaneast.logic.azure.com:443/workflows/XXXXXXXX...\"}' `
  --region ap-northeast-1
```

> 重要: 本システムの `notify-teams` Lambdaは Secrets Manager の値をJSONとして読み取り、`url` キーを参照します（`{\"url\":\"...\"}` 形式）。

#### Teams Workflows URLの取得方法

1. Teams → **その他のアプリ** → **Workflows**
2. **新しいフローを作成** → **Webリクエストが受信されたとき**
3. フローを作成・保存
4. トリガーの **HTTPのURL** をコピー

### 3. シークレットの更新（値を変更する場合）

```powershell
# Backlog認証情報の更新
aws secretsmanager update-secret `
  --secret-id "backlog-morning-meeting/backlog-credentials" `
  --secret-string '{\"apiKey\":\"NEW_API_KEY\",\"spaceId\":\"YOUR_SPACE_ID\",\"domain\":\"backlog.com\"}' `
  --region ap-northeast-1

# Teams Workflows URLの更新
aws secretsmanager update-secret `
  --secret-id "backlog-morning-meeting/teams-workflows-url" `
  --secret-string '{\"url\":\"https://new-url...\"}' `
  --region ap-northeast-1
```

---

## Parameter Storeの設定

### 0. 推奨パラメータ一覧（このシステムで使用）

| 種類      | 名前                                           | 必須 | 内容                                            |
| --------- | ---------------------------------------------- | ---- | ----------------------------------------------- |
| Parameter | `/backlog-morning-meeting/project-keys`        | ✅    | 対象プロジェクトキー（カンマ区切り）            |
| Parameter | `/backlog-morning-meeting/active-assignee-ids` | ⬜    | 有効担当者ID（StringList / JSON配列どちらも可） |
| Parameter | `/backlog-morning-meeting/email-from`          | ✅    | 送信元メールアドレス                            |
| Parameter | `/backlog-morning-meeting/email-recipients`    | ✅    | 送信先メールアドレス（StringList推奨）          |

### 1. アクティブ担当者IDリストの登録

課題をフィルタリングする対象の担当者IDをカンマ区切りで登録します。

```powershell
aws ssm put-parameter `
  --name "/backlog-morning-meeting/active-assignee-ids" `
  --type "StringList" `
  --value "12345,67890,11111,22222" `
  --description "Active assignee IDs for filtering Backlog issues" `
  --region ap-northeast-1
```

> メモ: Lambda側は `StringList` の `12345,67890,...` 形式に加えて、互換性のため `JSON配列（例: [12345,67890]）` も受け付けます。

#### 担当者IDの確認方法

Backlog APIで担当者一覧を取得:

```powershell
# curlで取得
curl "https://YOUR_SPACE_ID.backlog.com/api/v2/projects/PROJECT_KEY/users?apiKey=YOUR_API_KEY"
```

または、Backlogの課題画面で担当者を選択し、ブラウザの開発者ツールでネットワークリクエストを確認。

### 2. プロジェクトIDリストの登録（オプション）

対象プロジェクトを指定する場合:

```powershell
aws ssm put-parameter `
  --name "/backlog-morning-meeting/project-ids" `
  --type "StringList" `
  --value "100,200,300" `
  --description "Target project IDs for morning meeting" `
  --region ap-northeast-1
```

### 3. メール受信者リストの登録

```powershell
aws ssm put-parameter `
  --name "/backlog-morning-meeting/email-recipients" `
  --type "StringList" `
  --value "user1@example.com,user2@example.com,user3@example.com" `
  --description "Email recipients for morning meeting notification" `
  --region ap-northeast-1
```

### 4. 送信元メールアドレスの登録

```powershell
aws ssm put-parameter `
  --name "/backlog-morning-meeting/email-from" `
  --type "String" `
  --value "noreply@example.com" `
  --description "Email from address for morning meeting notification" `
  --region ap-northeast-1
```

### 5. 対象プロジェクトキーの登録（必須）

```powershell
aws ssm put-parameter `
  --name "/backlog-morning-meeting/project-keys" `
  --type "String" `
  --value "PROJECT1,PROJECT2" `
  --description "Target Backlog project keys for morning meeting" `
  --region ap-northeast-1
```

### 6. パラメータの更新

```powershell
# 担当者IDの更新（--overwriteフラグが必要）
aws ssm put-parameter `
  --name "/backlog-morning-meeting/active-assignee-ids" `
  --type "StringList" `
  --value "12345,67890,11111,22222,33333" `
  --overwrite `
  --region ap-northeast-1
```

---

## 設定値の確認

### Secrets Managerの確認

```powershell
# シークレット一覧
aws secretsmanager list-secrets --query "SecretList[?contains(Name, 'backlog-morning-meeting')]" --region ap-northeast-1

# Backlog認証情報の値を確認
aws secretsmanager get-secret-value `
  --secret-id "backlog-morning-meeting/backlog-credentials" `
  --query "SecretString" `
  --output text `
  --region ap-northeast-1

# Teams Workflows URLの値を確認
aws secretsmanager get-secret-value `
  --secret-id "backlog-morning-meeting/teams-workflows-url" `
  --query "SecretString" `
  --output text `
  --region ap-northeast-1
```

### Parameter Storeの確認

```powershell
# パラメータ一覧
aws ssm describe-parameters --query "Parameters[?contains(Name, 'backlog-morning-meeting')]" --region ap-northeast-1

# 対象プロジェクトキーの値を確認
aws ssm get-parameter `
  --name "/backlog-morning-meeting/project-keys" `
  --query "Parameter.Value" `
  --output text `
  --region ap-northeast-1

# 担当者IDリストの値を確認
aws ssm get-parameter `
  --name "/backlog-morning-meeting/active-assignee-ids" `
  --query "Parameter.Value" `
  --output text `
  --region ap-northeast-1

# 送信元メールアドレスの値を確認
aws ssm get-parameter `
  --name "/backlog-morning-meeting/email-from" `
  --query "Parameter.Value" `
  --output text `
  --region ap-northeast-1

# メール受信者リストの値を確認
aws ssm get-parameter `
  --name "/backlog-morning-meeting/email-recipients" `
  --query "Parameter.Value" `
  --output text `
  --region ap-northeast-1
```

---

## トラブルシューティング

### エラー: AccessDeniedException

```
An error occurred (AccessDeniedException) when calling the CreateSecret operation
```

**原因**: IAM権限が不足しています。

**対処法**: 
1. IAMユーザーに必要な権限を付与
2. または管理者に権限追加を依頼

### エラー: ResourceExistsException

```
An error occurred (ResourceExistsException) when calling the CreateSecret operation
```

**原因**: 同名のシークレットが既に存在します。

**対処法**: 
```powershell
# 更新する場合
aws secretsmanager update-secret --secret-id "シークレット名" --secret-string "新しい値"

# 削除して再作成する場合
aws secretsmanager delete-secret --secret-id "シークレット名" --force-delete-without-recovery
aws secretsmanager create-secret --name "シークレット名" --secret-string "値"
```

### エラー: ParameterAlreadyExists

```
An error occurred (ParameterAlreadyExists) when calling the PutParameter operation
```

**原因**: 同名のパラメータが既に存在します。

**対処法**: 
```powershell
# --overwriteフラグを追加
aws ssm put-parameter --name "パラメータ名" --value "値" --type "StringList" --overwrite
```

### JSON形式のエラー

PowerShellでJSON文字列を渡す際にエスケープが必要:

```powershell
# 正しい例（ダブルクォートをエスケープ）
--secret-string '{\"key\":\"value\"}'

# または、ファイルから読み込み
--secret-string file://secret.json
```

---

## クイックリファレンス

### 登録コマンド一覧

```powershell
# 1. Backlog認証情報
aws secretsmanager create-secret `
  --name "backlog-morning-meeting/backlog-credentials" `
  --secret-string '{\"apiKey\":\"YOUR_API_KEY\",\"spaceId\":\"YOUR_SPACE_ID\",\"domain\":\"backlog.com\"}' `
  --region ap-northeast-1

# 2. Teams Workflows URL
aws secretsmanager create-secret `
  --name "backlog-morning-meeting/teams-workflows-url" `
  --secret-string '{\"url\":\"YOUR_TEAMS_WORKFLOWS_URL\"}' `
  --region ap-northeast-1

# 3. アクティブ担当者ID
aws ssm put-parameter `
  --name "/backlog-morning-meeting/active-assignee-ids" `
  --type "StringList" `
  --value "ID1,ID2,ID3" `
  --region ap-northeast-1

# 4. メール受信者
aws ssm put-parameter `
  --name "/backlog-morning-meeting/email-recipients" `
  --type "StringList" `
  --value "email1@example.com,email2@example.com" `
  --region ap-northeast-1

# 5. メール送信元
aws ssm put-parameter `
  --name "/backlog-morning-meeting/email-from" `
  --type "String" `
  --value "noreply@example.com" `
  --region ap-northeast-1

# 6. 対象プロジェクトキー
aws ssm put-parameter `
  --name "/backlog-morning-meeting/project-keys" `
  --type "String" `
  --value "PROJECT1,PROJECT2" `
  --region ap-northeast-1
```

### 設定値一覧

| 種類      | 名前                                           | 必須 | 説明                                  |
| --------- | ---------------------------------------------- | ---- | ------------------------------------- |
| Secret    | `backlog-morning-meeting/backlog-credentials`  | ✅    | Backlog APIキー、スペースID、ドメイン |
| Secret    | `backlog-morning-meeting/teams-workflows-url`  | ✅    | Teams Workflows HTTPトリガーURL       |
| Parameter | `/backlog-morning-meeting/project-keys`        | ✅    | 対象プロジェクトキー（カンマ区切り）  |
| Parameter | `/backlog-morning-meeting/active-assignee-ids` | ⬜    | フィルタ対象の担当者ID                |
| Parameter | `/backlog-morning-meeting/email-from`          | ✅    | メール送信元                          |
| Parameter | `/backlog-morning-meeting/email-recipients`    | ✅    | メール通知先                          |
| Parameter | `/backlog-morning-meeting/project-ids`         | ⬜    | 対象プロジェクトID（カンマ区切り）    |

---

## 参考資料

- [課題一覧の取得（Backlog API v2）](https://developer.nulab.com/ja/docs/backlog/api/2/get-issue-list/)

