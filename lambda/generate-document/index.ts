import type { Handler } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secretsManager = new SecretsManagerClient({});

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

interface ProjectData {
  projectKey: string;
  projectName: string;
  todayIssues: IssuesByAssignee[];
  incompleteIssues: IssuesByAssignee[];
  dueTodayIssues: IssuesByAssignee[];
}

interface LambdaEvent {
  projects: ProjectData[];
  activeAssigneeIds: number[];
}

interface Document {
  projectKey: string;
  projectName: string;
  fileName: string;
  content: string;
}

interface LambdaResponse {
  documents: Document[];
}

export const handler: Handler<LambdaEvent, LambdaResponse> = async (event) => {
  try {
    const { projects } = event;
    const documents: Document[] = [];

    // 現在日時を取得（JST）
    const now = new Date();
    const jstNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const dateStr = formatDate(jstNow); // YYYY/MM/DD形式
    const timeStr = formatTime(jstNow); // HH:mm形式
    const fileNameDateStr = jstNow.toISOString().split('T')[0]; // YYYY-MM-DD形式（ファイル名用）

    // OpenAIを使う場合（失敗時は既存ロジックにフォールバック）
    const openAiSecretName = process.env.OPENAI_API_KEY_SECRET_NAME || '';
    const openAiModel = process.env.OPENAI_MODEL || 'gpt-4o';
    const openAiApiKey = openAiSecretName ? await getOpenAiApiKey(openAiSecretName) : '';

    // プロジェクトごとにドキュメントを生成
    for (const project of projects) {
      const document = openAiApiKey
        ? await generateMarkdownDocumentWithOpenAi(project, dateStr, timeStr, fileNameDateStr, openAiApiKey, openAiModel)
        : generateMarkdownDocument(project, dateStr, timeStr, fileNameDateStr);
      documents.push(document);
    }

    return { documents };
  } catch (error) {
    console.error('エラー:', error);
    throw error;
  }
};

async function getOpenAiApiKey(secretName: string): Promise<string> {
  try {
    const res = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretName }));
    const secretString = (res.SecretString || '').trim();
    if (!secretString) return '';

    // JSON: {"apiKey":"..."} / {"OPENAI_API_KEY":"..."}  or  raw: "sk-..."
    try {
      const parsed = JSON.parse(secretString) as any;
      return (parsed?.apiKey || parsed?.OPENAI_API_KEY || '').trim();
    } catch {
      return secretString;
    }
  } catch (e) {
    console.warn(`OpenAI APIキー取得に失敗（secret: ${secretName}）:`, e);
    return '';
  }
}

const MAX_RETRIES = 3;

// 課題件数をカウント
function countIssues(groups: IssuesByAssignee[]): number {
  return groups.reduce((sum, g) => sum + g.issues.length, 0);
}

// LLMによる検証
async function validateWithLlm(
  markdown: string,
  expectedCounts: { today: number; incomplete: number; dueToday: number },
  apiKey: string,
  model: string
): Promise<{ valid: boolean; reason?: string }> {
  const system = `あなたはMarkdownドキュメントの検証を行うアシスタントです。
サマリセクションの件数が期待値と一致しているか確認してください。
必ず以下のJSON形式のみを出力してください（他の文字は一切出力しないでください）:
{"valid": true} または {"valid": false, "reason": "不一致の理由"}`;

  const user = `以下のMarkdownドキュメントのサマリ件数を検証してください。

【期待値】
- 本日対応予定: ${expectedCounts.today}件
- 未完了課題: ${expectedCounts.incomplete}件
- 今日締め切り: ${expectedCounts.dueToday}件

【検証対象のMarkdown】
${markdown}`;

  try {
    const response = await callOpenAiChatCompletion({ apiKey, model, system, user });
    // JSON部分を抽出（前後に余計な文字がある場合に対応）
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { valid: false, reason: '検証レスポンスのパースに失敗' };
    }
    return JSON.parse(jsonMatch[0]) as { valid: boolean; reason?: string };
  } catch (e) {
    console.warn('検証LLM呼び出しエラー:', e);
    return { valid: false, reason: '検証LLM呼び出しに失敗' };
  }
}

async function generateMarkdownDocumentWithOpenAi(
  project: ProjectData,
  dateStr: string,
  timeStr: string,
  fileNameDateStr: string,
  apiKey: string,
  model: string
): Promise<Document> {
  const { projectKey, projectName, todayIssues, incompleteIssues, dueTodayIssues } = project;
  const fileName = `morning-meeting-${projectKey}-${fileNameDateStr}.md`;

  // 期待されるサマリ件数
  const expectedCounts = {
    today: countIssues(todayIssues),
    incomplete: countIssues(incompleteIssues),
    dueToday: countIssues(dueTodayIssues),
  };

  // 担当者グループをシンプルな形式に変換（トークン削減のためdescriptionは除外）
  const convertToSimpleFormat = (groups: IssuesByAssignee[]) =>
    groups.map(g => ({
      assigneeName: g.assigneeName,
      issues: g.issues.map(i => ({
        issueKey: i.issueKey,
        summary: i.summary,
        status: i.status?.name,
        dueDate: i.dueDate || null,
        startDate: i.startDate || null,
        priority: i.priority?.name,
        categories: i.category?.map(c => c.name) || [],
        url: i.url,
      })),
    }));

  const input = {
    generatedAtJst: { date: dateStr, time: timeStr },
    project: { projectKey, projectName },
    todayIssues: convertToSimpleFormat(todayIssues),
    incompleteIssues: convertToSimpleFormat(incompleteIssues),
    dueTodayIssues: convertToSimpleFormat(dueTodayIssues),
  };

  const system = [
    'あなたはプロジェクトの朝会ドキュメントをMarkdownで生成するアシスタントです。',
    '必ずMarkdownのみを出力し、前後に説明文を付けないでください。',
    '日付は必ず YYYY/MM/DD 形式で表示してください。',
    '課題が0件のセクションは出力しないでください。',
    'エラーがあれば「## ❌ エラー」セクションで明示してください。',
  ].join('\n');

  const user = [
    '次のJSON入力から、朝会用Markdownドキュメントを生成してください。',
    '',
    '【入力データ構造】',
    '- todayIssues: 本日対応予定の課題（担当者別にグループ化済み）',
    '- incompleteIssues: 期限超過・未完了の課題（担当者別にグループ化済み）',
    '- dueTodayIssues: 今日締め切りの課題（担当者別にグループ化済み）',
    '※同じ課題が複数のリストに含まれる場合があります（仕様）',
    '',
    '【出力要件】',
    '- 先頭に: `# 【朝会ドキュメント】YYYY/MM/DD - {プロジェクト名}`',
    '- `生成時刻: HH:mm` を出力',
    '- セクションは以下（該当があるものだけ出す）:',
    '  - `## 📊 サマリー`（各リストの課題件数集計の表）',
    '  - `## ⚠️ 期限超過・未完了の課題`（incompleteIssuesを出力）',
    '  - `## 📅 本日対応予定の課題`（todayIssuesを出力）',
    '  - `## 🔔 今日締め切りの課題`（dueTodayIssuesを出力）',
    '- 各セクション内は担当者でグルーピングし、担当者ごとに表形式で出力（データは既にグループ化済み）',
    '- 表の列: 課題キー / 課題名 / ステータス / 開始日 / 期限日 / 優先度 / カテゴリ / URL',
    '- URL列は `[リンク](URL)` 形式',
    '- `## 📝 議事録` を最後に追加し、全リストに含まれる担当者名ごとに見出し（###）とメモ欄を用意する',
    '',
    '入力JSON:',
    JSON.stringify(input),
  ].join('\n');

  // リトライ付き生成
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const markdown = await callOpenAiChatCompletion({
        apiKey,
        model,
        system,
        user,
      });

      const sanitized = sanitizeMarkdown(markdown);

      // LLMによる検証
      const validation = await validateWithLlm(sanitized, expectedCounts, apiKey, model);

      if (validation.valid) {
        console.log(`検証成功 (試行 ${attempt}/${MAX_RETRIES})`);
        return {
          projectKey,
          projectName,
          fileName,
          content: sanitized,
        };
      }

      console.warn(`検証失敗 (試行 ${attempt}/${MAX_RETRIES}): ${validation.reason}`);
    } catch (e) {
      console.error(`OpenAI生成エラー (試行 ${attempt}/${MAX_RETRIES}):`, e);
    }
  }

  // 3回失敗: フォールバック生成を使用
  console.error('LLM生成が3回検証失敗。フォールバックを使用します。');
  return generateMarkdownDocument(project, dateStr, timeStr, fileNameDateStr);
}

async function callOpenAiChatCompletion(params: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
}): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      temperature: 0.2,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.user },
      ],
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI API error: HTTP ${res.status} ${text}`);
  }

  const json = JSON.parse(text) as any;
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('OpenAI API returned empty content');
  }
  return content;
}

function sanitizeMarkdown(markdown: string): string {
  // 前後の余計な空白やコードフェンスを軽く除去
  let out = (markdown || '').trim();
  out = out.replace(/^```(?:markdown)?\s*/i, '').replace(/```$/i, '').trim();
  return out + '\n';
}

function generateMarkdownDocument(
  project: ProjectData,
  dateStr: string,
  timeStr: string,
  fileNameDateStr: string
): Document {
  const { projectKey, projectName, todayIssues, incompleteIssues, dueTodayIssues } = project;

  // 課題数を計算（担当者グループから合計）
  const countIssues = (groups: IssuesByAssignee[]) =>
    groups.reduce((sum, g) => sum + g.issues.length, 0);

  // 統計情報
  const summary = {
    today: countIssues(todayIssues),
    incomplete: countIssues(incompleteIssues),
    dueToday: countIssues(dueTodayIssues),
  };

  // 担当者リストを取得（全リストから抽出、重複を除去）
  const assignees = new Set<string>();
  [...todayIssues, ...incompleteIssues, ...dueTodayIssues].forEach(group => {
    assignees.add(group.assigneeName);
  });
  const assigneeList = Array.from(assignees).sort();

  // Markdownを生成
  let markdown = `# 【朝会ドキュメント】${dateStr} - ${projectName}\n\n`;
  markdown += `生成時刻: ${timeStr}\n\n`;

  // サマリー
  markdown += `## 📊 サマリー\n\n`;
  markdown += `| 項目 | 件数 |\n`;
  markdown += `|:---|:---:|\n`;
  markdown += `| 本日対応予定 | ${summary.today}件 |\n`;
  markdown += `| 未完了課題 | ${summary.incomplete}件 |\n`;
  markdown += `| 今日締め切り | ${summary.dueToday}件 |\n\n`;

  // 期限超過・未完了の課題
  if (countIssues(incompleteIssues) > 0) {
    markdown += `## ⚠️ 期限超過・未完了の課題\n\n`;
    markdown += generateIssuesFromAssigneeGroups(incompleteIssues);
  }

  // 本日対応予定の課題
  if (countIssues(todayIssues) > 0) {
    markdown += `## 📅 本日対応予定の課題\n\n`;
    markdown += generateIssuesFromAssigneeGroups(todayIssues);
  }

  // 今日締め切りの課題
  if (countIssues(dueTodayIssues) > 0) {
    markdown += `## 🔔 今日締め切りの課題\n\n`;
    markdown += generateIssuesFromAssigneeGroups(dueTodayIssues);
  }

  // 議事録セクション
  markdown += `## 📝 議事録\n\n`;
  for (const assignee of assigneeList) {
    markdown += `### ${assignee}\n\n`;
    markdown += `<!-- ここに${assignee}の議事録を記入してください -->\n\n`;
    markdown += `---\n\n`;
  }

  const fileName = `morning-meeting-${projectKey}-${fileNameDateStr}.md`;

  return {
    projectKey,
    projectName,
    fileName,
    content: markdown,
  };
}

function generateIssuesFromAssigneeGroups(groups: IssuesByAssignee[]): string {
  let markdown = '';

  // 担当者グループは既にソート済み
  for (const group of groups) {
    const { assigneeName, issues } = group;

    markdown += `### ${assigneeName}\n\n`;
    markdown += `| 課題キー | 課題名 | ステータス | 開始日 | 期限日 | 優先度 | カテゴリ | URL |\n`;
    markdown += `|:---|:---|:---|:---|:---|:---|:---|:---|\n`;

    for (const issue of issues) {
      const issueKey = issue.issueKey;
      const summary = escapeMarkdown(issue.summary);
      const status = issue.status.name;
      const dueDate = issue.dueDate ? formatDate(new Date(issue.dueDate)) : '-';
      const startDate = issue.startDate ? formatDate(new Date(issue.startDate)) : '-';
      const priority = issue.priority.name;
      const category = issue.category && issue.category.length > 0
        ? issue.category.map(c => c.name).join(', ')
        : '-';
      const url = issue.url;

      markdown += `| ${issueKey} | ${summary} | ${status} | ${startDate} | ${dueDate} | ${priority} | ${category} | [リンク](${url}) |\n`;
    }

    // 課題の説明を追加
    for (const issue of issues) {
      if (issue.description && issue.description.trim()) {
        markdown += `\n**${issue.issueKey}** の説明:\n`;
        markdown += `${escapeMarkdown(issue.description)}\n\n`;
      }
    }

    markdown += `---\n\n`;
  }

  return markdown;
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function formatTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function escapeMarkdown(text: string): string {
  return text
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
    .trim();
}


