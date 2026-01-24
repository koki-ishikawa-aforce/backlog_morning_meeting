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

    // デバッグログ: 入力データの確認
    console.log('=== generate-document 開始 ===');
    console.log(`プロジェクト数: ${projects.length}`);
    for (const project of projects) {
      console.log(`[${project.projectKey}] 入力データ:`);
      console.log(`  - todayIssues グループ数: ${project.todayIssues.length}`);
      console.log(`  - incompleteIssues グループ数: ${project.incompleteIssues.length}`);
      console.log(`  - dueTodayIssues グループ数: ${project.dueTodayIssues.length}`);

      // todayIssuesの詳細
      project.todayIssues.forEach(group => {
        console.log(`    todayIssues[${group.assigneeName}]: ${group.issues.length}件`);
        group.issues.forEach(issue => {
          console.log(`      - ${issue.issueKey}: ${issue.summary}`);
        });
      });
    }

    // 現在日時を取得（JST）
    const now = new Date();
    const jstNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const dateStr = formatDate(jstNow); // YYYY/MM/DD形式
    const timeStr = formatTime(jstNow); // HH:mm形式
    // YYYYMMDD形式（ファイル名用）
    const year = jstNow.getFullYear();
    const month = String(jstNow.getMonth() + 1).padStart(2, '0');
    const day = String(jstNow.getDate()).padStart(2, '0');
    const fileNameDateStr = `${year}${month}${day}`;

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

async function generateMarkdownDocumentWithOpenAi(
  project: ProjectData,
  dateStr: string,
  timeStr: string,
  fileNameDateStr: string,
  apiKey: string,
  model: string
): Promise<Document> {
  const { projectKey, projectName, todayIssues, incompleteIssues, dueTodayIssues } = project;
  const fileName = `${fileNameDateStr}_【${projectName}】朝会資料.md`;

  // 件数を事前計算（LLMに数えさせず、この値をそのまま使用させる）
  const countIssues = (groups: IssuesByAssignee[]) =>
    groups.reduce((sum, g) => sum + g.issues.length, 0);

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
    // 事前計算した件数（サマリー表でこの値をそのまま使用する）
    summary: {
      todayCount: countIssues(todayIssues),
      incompleteCount: countIssues(incompleteIssues),
      dueTodayCount: countIssues(dueTodayIssues),
    },
    todayIssues: convertToSimpleFormat(todayIssues),
    incompleteIssues: convertToSimpleFormat(incompleteIssues),
    dueTodayIssues: convertToSimpleFormat(dueTodayIssues),
    meetingNotes: generateMeetingNotesData(todayIssues, incompleteIssues, dueTodayIssues),
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
    '- summary: 各リストの件数（重要: この値をサマリー表にそのまま使用すること。自分で数えないでください）',
    '  - todayCount: 本日対応予定の件数',
    '  - incompleteCount: 期限超過・未完了の件数',
    '  - dueTodayCount: 今日締め切りの件数',
    '- todayIssues: 本日対応予定の課題（担当者別にグループ化済み）',
    '- incompleteIssues: 期限超過・未完了の課題（担当者別にグループ化済み）',
    '- dueTodayIssues: 今日締め切りの課題（担当者別にグループ化済み）',
    '- meetingNotes: 議事録セクション用データ（担当者ごと）',
    '  - assigneeName: 担当者名',
    '  - incomplete: 期限超過・未完了の課題（issueKey, summaryのみ）',
    '  - today: 本日対応予定の課題（issueKey, summary, isDueToday）',
    '    - isDueToday: trueの場合は今日締め切り',
    '※同じ課題が複数のリストに含まれる場合があります（仕様）',
    '',
    '【出力要件】',
    '- 先頭に: `# 【朝会ドキュメント】YYYY/MM/DD - {プロジェクト名}`',
    '- `生成時刻: HH:mm` を出力',
    '- セクションは以下（該当があるものだけ出す）:',
    '  - `## 📊 サマリー`（summaryの値をそのまま使用して以下の順番で表を作成）:',
    '    1. 期限超過・未完了: incompleteCount件',
    '    2. 本日対応予定: todayCount件',
    '    3. 今日締め切り: dueTodayCount件',
    '  - `## ⚠️ 期限超過・未完了の課題`（incompleteIssuesを出力）',
    '  - `## 📅 本日対応予定の課題`（todayIssuesを出力）',
    '  - `## 🔔 今日締め切りの課題`（dueTodayIssuesを出力）',
    '- 各セクション内は担当者でグルーピングし、担当者ごとに表形式で出力（データは既にグループ化済み）',
    '- 表の列: 課題キー / 課題名 / ステータス / 開始日 / 期限日 / 優先度 / カテゴリ / URL',
    '- URL列は `[リンク](URL)` 形式',
    '- `## 📝 議事録` を最後に追加。meetingNotesデータを使用して以下の形式で出力:',
    '  - 担当者ごとに見出し（###）を作成',
    '  - 各担当者の下に、該当課題があるセクションのみ追加:',
    '    - `#### ⚠️ 期限超過・未完了`（incompleteから）',
    '    - `#### 📅 本日対応予定`（todayから、isDueToday=trueなら「🔔（今日締め切り）」を付与）',
    '  - 各課題は「- 課題キー: 課題名」形式（今日締め切りは「- 課題キー: 課題名 🔔（今日締め切り）」）',
    '  - 各課題の下に「  <!-- メモ -->」を追加',
    '',
    '入力JSON:',
    JSON.stringify(input),
  ].join('\n');

  try {
    const markdown = await callOpenAiChatCompletion({
      apiKey,
      model,
      system,
      user,
    });

    return {
      projectKey,
      projectName,
      fileName,
      content: sanitizeMarkdown(markdown),
    };
  } catch (e) {
    console.error('OpenAI生成に失敗。フォールバックで生成します:', e);
    return generateMarkdownDocument(project, dateStr, timeStr, fileNameDateStr);
  }
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

  // 議事録セクション（担当者ごと・セクションごと・課題ごとにメモ欄）
  markdown += generateMeetingNotesSection(todayIssues, incompleteIssues, dueTodayIssues);

  const fileName = `${fileNameDateStr}_【${projectName}】朝会資料.md`;

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

function generateMeetingNotesSection(
  todayIssues: IssuesByAssignee[],
  incompleteIssues: IssuesByAssignee[],
  dueTodayIssues: IssuesByAssignee[]
): string {
  // 今日締め切りの課題キーをSetで管理
  const dueTodayKeys = new Set<string>();
  for (const group of dueTodayIssues) {
    for (const issue of group.issues) {
      dueTodayKeys.add(issue.issueKey);
    }
  }

  // 担当者ごとにデータを集約
  const assigneeMap = new Map<string, {
    incomplete: Issue[];
    today: Issue[];
  }>();

  for (const group of incompleteIssues) {
    if (!assigneeMap.has(group.assigneeName)) {
      assigneeMap.set(group.assigneeName, { incomplete: [], today: [] });
    }
    assigneeMap.get(group.assigneeName)!.incomplete = group.issues;
  }
  for (const group of todayIssues) {
    if (!assigneeMap.has(group.assigneeName)) {
      assigneeMap.set(group.assigneeName, { incomplete: [], today: [] });
    }
    assigneeMap.get(group.assigneeName)!.today = group.issues;
  }

  // デバッグログ: 議事録セクション生成
  console.log('=== 議事録セクション生成 ===');
  console.log(`todayIssues グループ数: ${todayIssues.length}`);
  console.log(`incompleteIssues グループ数: ${incompleteIssues.length}`);
  console.log(`assigneeMap 担当者数: ${assigneeMap.size}`);
  for (const [name, data] of assigneeMap) {
    console.log(`  ${name}: incomplete=${data.incomplete.length}件, today=${data.today.length}件`);
  }

  let markdown = `## 📝 議事録\n\n`;
  const assigneeNames = Array.from(assigneeMap.keys()).sort();

  for (const assigneeName of assigneeNames) {
    const data = assigneeMap.get(assigneeName)!;
    markdown += `### ${assigneeName}\n\n`;

    // 期限超過・未完了
    if (data.incomplete.length > 0) {
      markdown += `#### ⚠️ 期限超過・未完了\n`;
      for (const issue of data.incomplete) {
        markdown += `- ${issue.issueKey}: ${issue.summary}\n`;
        markdown += `  <!-- メモ -->\n`;
      }
      markdown += `\n`;
    }

    // 本日対応予定（今日締め切りはマーク付き）
    if (data.today.length > 0) {
      markdown += `#### 📅 本日対応予定\n`;
      for (const issue of data.today) {
        const dueTodayMark = dueTodayKeys.has(issue.issueKey) ? ' 🔔（今日締め切り）' : '';
        markdown += `- ${issue.issueKey}: ${issue.summary}${dueTodayMark}\n`;
        markdown += `  <!-- メモ -->\n`;
      }
      markdown += `\n`;
    }

    markdown += `---\n\n`;
  }

  return markdown;
}

function generateMeetingNotesData(
  todayIssues: IssuesByAssignee[],
  incompleteIssues: IssuesByAssignee[],
  dueTodayIssues: IssuesByAssignee[]
): Array<{
  assigneeName: string;
  incomplete: Array<{ issueKey: string; summary: string }>;
  today: Array<{ issueKey: string; summary: string; isDueToday: boolean }>;
}> {
  // 今日締め切りの課題キーをSetで管理
  const dueTodayKeys = new Set<string>();
  for (const group of dueTodayIssues) {
    for (const issue of group.issues) {
      dueTodayKeys.add(issue.issueKey);
    }
  }

  const assigneeMap = new Map<string, {
    incomplete: Array<{ issueKey: string; summary: string }>;
    today: Array<{ issueKey: string; summary: string; isDueToday: boolean }>;
  }>();

  for (const group of incompleteIssues) {
    if (!assigneeMap.has(group.assigneeName)) {
      assigneeMap.set(group.assigneeName, { incomplete: [], today: [] });
    }
    assigneeMap.get(group.assigneeName)!.incomplete = group.issues.map(i => ({
      issueKey: i.issueKey,
      summary: i.summary,
    }));
  }
  for (const group of todayIssues) {
    if (!assigneeMap.has(group.assigneeName)) {
      assigneeMap.set(group.assigneeName, { incomplete: [], today: [] });
    }
    assigneeMap.get(group.assigneeName)!.today = group.issues.map(i => ({
      issueKey: i.issueKey,
      summary: i.summary,
      isDueToday: dueTodayKeys.has(i.issueKey),
    }));
  }

  return Array.from(assigneeMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([assigneeName, data]) => ({ assigneeName, ...data }));
}


