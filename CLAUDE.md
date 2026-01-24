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

## Development Flow (TDD)

このプロジェクトではテスト駆動開発（TDD）を採用する。以下のフローに従うこと。

### TDDの基本フロー

1. **仕様決定** - 実装する機能の仕様を明確にする
2. **テストケース作成** - 仕様に基づいてテストケースを作成する
3. **テスト実行（Red）** - テストが失敗することを確認する
4. **実装（Green）** - テストが通る最小限の実装を行う
5. **テスト実行（確認）** - 全てのテストが通ることを確認する
6. **リファクタリング** - 必要に応じてコードを改善する（テストは変更しない）

### 重要なルール

- **テストファーストの原則**: 実装コードを書く前に必ずテストを書く
- **テストコードの書き換え禁止**: テストを通すためにテストコードを修正することは禁止
  - テストが間違っている場合は、仕様を再確認してから修正する
  - テストの修正が必要な場合は、明確な理由を説明する
- **細かい単位での進行**: テストは細かい単位で作成し、1つずつ通るように実装を進める
- **レビューしやすさ**: 各ステップでレビュアーが変更を追いやすいようにする

### テストの命名規則

```typescript
describe('対象の機能やモジュール名', () => {
  describe('正常系', () => {
    it('〜の場合、〜となる', () => { ... });
  });
  describe('異常系', () => {
    it('〜の場合、エラーとなる', () => { ... });
  });
  describe('エッジケース', () => {
    it('〜の場合でも正しく処理される', () => { ... });
  });
});
```

## Guardrails

以下の操作は禁止（.claude/settings.jsonで設定済み）：
- `git push --force` / `git reset --hard` / `git clean -f`
- `rm -rf` の実行
- `.env` ファイルの内容をコミットに含める
- Secrets Manager / Parameter Store のキー名変更
