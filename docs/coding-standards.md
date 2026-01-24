# コーディング規約

## 言語
- コメント・エラーメッセージ・ログ出力は日本語

## 命名規則
| 対象 | 形式 | 例 |
|------|------|-----|
| 関数・変数 | camelCase | `fetchIssues`, `projectKey` |
| 型・インターフェース | PascalCase | `LambdaEvent`, `Issue` |
| ディレクトリ・ファイル | kebab-case | `fetch-backlog-issues/` |
| Lambdaエントリポイント | index.ts | - |

## TypeScript
- strict: true（any禁止、null安全）
- 型定義はinterfaceを優先

## エラーハンドリング
- try-catchでラップし、`console.error('エラー:', error)` でログ出力後にthrow
- 部分失敗を許容する場合は `Promise.allSettled()` を使用
- 必須パラメータ不足時は即座にthrow

## Lambda関数テンプレート
```typescript
export const handler: Handler<LambdaEvent, LambdaResponse> = async (event) => {
  try {
    // 処理
    return { /* result */ };
  } catch (error) {
    console.error('エラー:', error);
    throw error;
  }
};
```

## 関数設計

TDDの方針に基づき、関数は以下のルールで設計する。

- **単一責任**: 1つの関数は1つのことだけを行う
- **小さい単位**: 1関数あたり5〜10個のテストケースでカバーできる規模
- **テスト容易性**: モック化しやすいよう、依存関係は引数で注入する
- **分割の目安**:
  - テストケースが10個を超える場合は関数の分割を検討
  - 複数の責任を持つ場合は関数を分割する

詳細は [TDDガイドライン](./tdd-guidelines.md) を参照。

## テスト
- ファイル配置: Lambda関数と同じディレクトリに `index.test.ts`
- フレームワーク: Jest
- AWS SDKモック: `aws-sdk-client-mock`
- describe/itの説明は日本語
