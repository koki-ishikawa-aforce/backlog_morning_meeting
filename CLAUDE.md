# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Backlog朝会ドキュメント自動生成システム - AWS CDK + Step Functions + Lambda で構成されたサーバーレスアプリケーション。Backlogの課題情報を取得し、朝会用のMarkdownドキュメントを生成してTeamsとメールに通知する。

## Commands

```bash
# Build
npm run build          # TypeScriptコンパイル

# Test
npm test               # Jest実行（lambda/配下のテスト）
npm run test:coverage  # カバレッジレポート付きテスト

# CDK
npm run synth          # CloudFormationテンプレート生成
npm run deploy         # AWSにデプロイ
npm run cdk -- diff    # 差分確認
```

## Architecture

### Step Functions ワークフロー

EventBridge (毎日9:30 JST) → Step Functions → Lambda (並列通知)

1. **FetchBacklogIssues** - Backlog APIから課題を取得
2. **GenerateDocument** - Markdownドキュメント生成（固定ロジック）
3. **NotifyTeams** + **SendEmail** - 並列で通知

### Lambda関数（lambda/配下）

各Lambda関数は独自のtsconfig.jsonを持ち、CDKのNodejsFunctionでesbuildによりバンドルされる。

| Lambda | 役割 |
|--------|------|
| fetch-backlog-issues | Backlog API呼び出し、課題の分類・グループ化 |
| generate-document | Markdown生成（固定ロジック） |
| notify-teams | Teams Workflowsへのポスト |
| send-email | SESでメール送信（添付ファイル付き） |

### 設定値

**Secrets Manager:**
- `backlog-morning-meeting/backlog-credentials` - Backlog認証情報
- `backlog-morning-meeting/teams-workflows-url` - Teams Webhook URL

**Parameter Store:**
- `/backlog-morning-meeting/project-keys` - 対象プロジェクトキー
- `/backlog-morning-meeting/active-assignee-ids` - フィルタ対象担当者ID
- `/backlog-morning-meeting/email-from` - メール送信元
- `/backlog-morning-meeting/email-recipients` - メール受信者

## Key Files

- `lib/backlog-morning-meeting-stack.ts` - CDKスタック定義
- `bin/backlog-morning-meeting.ts` - CDKアプリエントリポイント
- `docs/aws-secrets-parameter-setup.md` - AWS設定手順書

## Testing

テストはJestで実行。各Lambda関数に対応する`*.test.ts`ファイルがある。

```bash
# 単一テストファイル実行
npx jest lambda/fetch-backlog-issues/index.test.ts

# 特定テスト名で絞り込み
npx jest -t "テスト名の一部"
```

AWS SDKのモックには`aws-sdk-client-mock`を使用。

## Rules

詳細な規約は以下を参照：
- コーディング規約: docs/coding-standards.md
- コミット規約: docs/commit-conventions.md
- TDD開発フロー: docs/tdd-guidelines.md

## Guardrails

以下の操作は禁止（.claude/settings.jsonで設定済み）：
- `git push --force` / `git reset --hard` / `git clean -f`
- `rm -rf` の実行
- `.env` ファイルの内容をコミットに含める
- Secrets Manager / Parameter Store のキー名変更
