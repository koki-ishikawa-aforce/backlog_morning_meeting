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

interface ProjectData {
  projectKey: string;
  projectName: string;
  issues: Issue[];
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
    const openAiModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';
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
  const { projectKey, projectName, issues } = project;
  const fileName = `morning-meeting-${projectKey}-${fileNameDateStr}.md`;

  const input = {
    generatedAtJst: { date: dateStr, time: timeStr },
    project: { projectKey, projectName },
    issues: issues.map(i => ({
      issueKey: i.issueKey,
      summary: i.summary,
      description: i.description,
      status: i.status?.name,
      assignee: i.assignee?.name || '未割り当て',
      dueDate: i.dueDate || null,
      startDate: i.startDate || null,
      priority: i.priority?.name,
      categories: i.category?.map(c => c.name) || [],
      url: i.url,
    })),
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
    '【出力要件】',
    '- 先頭に: `# 【朝会ドキュメント】YYYY/MM/DD - {プロジェクト名}`',
    '- `生成時刻: HH:mm` を出力',
    '- セクションは以下（該当があるものだけ出す）:',
    '  - `## 📊 サマリー`（件数集計の表）',
    '  - `## ⚠️ 期限超過・未完了の課題`',
    '  - `## 📅 本日対応予定の課題`',
    '  - `## 🔔 今日締め切りの課題`',
    '- 各セクション内は担当者でグルーピングし、担当者ごとに表形式で出力',
    '- 表の列: 課題キー / 課題名 / ステータス / 開始日 / 期限日 / 優先度 / カテゴリ / URL',
    '- URL列は `[リンク](URL)` 形式',
    '- `## 📝 議事録` を最後に追加し、担当者名ごとに見出し（###）とメモ欄を用意する',
    '',
    '【分類ルール】',
    '- 本日対応予定: startDate <= 今日 && dueDate >= 今日（JST）',
    '- 今日締め切り: dueDate が今日（JST）',
    '- 期限超過・未完了: startDate が過去で、ステータスが完了扱いでないもの',
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
  const { projectKey, projectName, issues } = project;

  // 課題を分類
  const today = new Date().toISOString().split('T')[0];
  const sevenDaysLater = new Date();
  sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);
  const sevenDaysLaterStr = sevenDaysLater.toISOString().split('T')[0];

  const todayIssues = issues.filter(issue => {
    if (!issue.startDate || !issue.dueDate) return false;
    const startDate = new Date(issue.startDate);
    const dueDate = new Date(issue.dueDate);
    const todayDate = new Date(today);
    return startDate <= todayDate && dueDate >= todayDate;
  });
  const incompleteIssues = issues.filter(issue => {
    if (!issue.startDate) return false;
    const startDate = new Date(issue.startDate);
    const todayDate = new Date(today);
    return startDate < todayDate && issue.status.name !== '完了';
  });
  const dueTodayIssues = issues.filter(issue => {
    if (!issue.dueDate) return false;
    const dueDate = new Date(issue.dueDate);
    const todayDate = new Date(today);
    return dueDate.toISOString().split('T')[0] === todayDate.toISOString().split('T')[0];
  });

  // 統計情報
  const summary = {
    today: todayIssues.length,
    incomplete: incompleteIssues.length,
    dueToday: dueTodayIssues.length,
  };

  // 担当者リストを取得（課題から抽出）
  const assignees = new Set<string>();
  [...todayIssues, ...incompleteIssues, ...dueTodayIssues].forEach(issue => {
    if (issue.assignee) {
      assignees.add(issue.assignee.name);
    }
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
  if (incompleteIssues.length > 0) {
    markdown += `## ⚠️ 期限超過・未完了の課題\n\n`;
    markdown += generateIssuesByAssignee(incompleteIssues);
  }

  // 本日対応予定の課題
  if (todayIssues.length > 0) {
    markdown += `## 📅 本日対応予定の課題\n\n`;
    markdown += generateIssuesByAssignee(todayIssues);
  }

  // 今日締め切りの課題
  if (dueTodayIssues.length > 0) {
    markdown += `## 🔔 今日締め切りの課題\n\n`;
    markdown += generateIssuesByAssignee(dueTodayIssues);
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

function generateIssuesByAssignee(issues: Issue[]): string {
  // 担当者別にグループ化
  const issuesByAssignee = new Map<string, Issue[]>();

  issues.forEach(issue => {
    const assigneeName = issue.assignee?.name || '未割り当て';
    if (!issuesByAssignee.has(assigneeName)) {
      issuesByAssignee.set(assigneeName, []);
    }
    issuesByAssignee.get(assigneeName)!.push(issue);
  });

  let markdown = '';

  // 担当者名でソート
  const sortedAssignees = Array.from(issuesByAssignee.keys()).sort();

  for (const assigneeName of sortedAssignees) {
    const assigneeIssues = issuesByAssignee.get(assigneeName)!;

    markdown += `### ${assigneeName}\n\n`;
    markdown += `| 課題キー | 課題名 | ステータス | 開始日 | 期限日 | 優先度 | カテゴリ | URL |\n`;
    markdown += `|:---|:---|:---|:---|:---|:---|:---|:---|\n`;

    for (const issue of assigneeIssues) {
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
    for (const issue of assigneeIssues) {
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


