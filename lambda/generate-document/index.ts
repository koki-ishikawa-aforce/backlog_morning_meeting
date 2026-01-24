import type { Handler } from 'aws-lambda';

// 遅延情報の型
interface DelayInfo {
  delayReason?: string;      // 遅延理由
  ball?: string;             // ボール
  nextAction?: string;       // 次のアクション
  expectedCompletion?: string; // 完了見込み
}

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
  delayInfo?: DelayInfo;
}

// 他者待ちの遅延理由
const WAITING_REASONS = ['社内待ち', '顧客待ち'];

// 課題が要対応かどうかを判定
function isActionRequired(issue: Issue): boolean {
  const reason = issue.delayInfo?.delayReason;
  if (!reason) return true; // 未設定は要対応
  return !WAITING_REASONS.includes(reason);
}

interface IssuesByAssignee {
  assigneeName: string;
  assigneeId?: number;
  issues: Issue[];
}

interface BacklogUser {
  id: number;
  name: string;
}

interface MtgIssue {
  issueKey: string;
  summary: string;
  description: string;
  url: string;
  dueDate?: string;
  startDate?: string;
  purpose?: string;
  datetime?: string;
  internalParticipants: string[];
  externalParticipants: string[];
  mtgUrl?: string;
}

interface ProjectData {
  projectKey: string;
  projectName: string;
  todayIssues: IssuesByAssignee[];
  incompleteIssues: IssuesByAssignee[];
  dueTodayIssues: IssuesByAssignee[];
  mtgIssues?: MtgIssue[];
  backlogUsers?: BacklogUser[];
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
    const dateStr = formatDate(jstNow);
    const timeStr = formatTime(jstNow);
    const year = jstNow.getFullYear();
    const month = String(jstNow.getMonth() + 1).padStart(2, '0');
    const day = String(jstNow.getDate()).padStart(2, '0');
    const fileNameDateStr = `${year}${month}${day}`;

    // プロジェクトごとにドキュメントを生成（固定ロジック）
    for (const project of projects) {
      const document = generateMarkdownDocument(project, dateStr, timeStr, fileNameDateStr);
      documents.push(document);
    }

    return { documents };
  } catch (error) {
    console.error('エラー:', error);
    throw error;
  }
};

function generateMarkdownDocument(
  project: ProjectData,
  dateStr: string,
  timeStr: string,
  fileNameDateStr: string
): Document {
  const { projectKey, projectName, todayIssues, incompleteIssues, dueTodayIssues, mtgIssues } = project;

  // 課題数を計算（担当者グループから合計）
  const countIssues = (groups: IssuesByAssignee[]) =>
    groups.reduce((sum, g) => sum + g.issues.length, 0);

  // 統計情報
  const summary = {
    today: countIssues(todayIssues),
    incomplete: countIssues(incompleteIssues),
    dueToday: countIssues(dueTodayIssues),
  };

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
  markdown += generateMeetingNotesSection(todayIssues, incompleteIssues, dueTodayIssues, mtgIssues || []);

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

    markdown += `\n---\n\n`;
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
  dueTodayIssues: IssuesByAssignee[],
  mtgIssues: MtgIssue[]
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

  let markdown = `## 📝 議事録\n\n`;
  const assigneeNames = Array.from(assigneeMap.keys()).sort();

  for (const assigneeName of assigneeNames) {
    const data = assigneeMap.get(assigneeName)!;
    markdown += `### ${assigneeName}\n\n`;

    // 期限超過・未完了を分類
    const actionRequired = data.incomplete.filter(isActionRequired);
    const waiting = data.incomplete.filter(issue => !isActionRequired(issue));

    // 要対応セクション
    if (actionRequired.length > 0) {
      markdown += `#### ⚠️ 期限超過・未完了（要対応）\n`;
      for (const issue of actionRequired) {
        const info = issue.delayInfo || {};
        markdown += `- ${issue.issueKey}: ${issue.summary}\n`;
        markdown += `  - **遅延理由**: ${info.delayReason || '<!-- 自責/社内待ち/顧客待ち/仕様変更/割り込み対応 -->'}\n`;
        markdown += `  - **ボール**: ${info.ball || '<!-- 自分/社内（誰）/顧客 -->'}\n`;
        markdown += `  - **次のアクション**: ${info.nextAction || '<!-- -->'}\n`;
        markdown += `  - **完了見込み**: ${info.expectedCompletion || '<!-- -->'}\n`;
      }
      markdown += `\n`;
    }

    // 他者待ちセクション
    if (waiting.length > 0) {
      markdown += `#### 🚧 期限超過・未完了（他者待ち）\n`;
      for (const issue of waiting) {
        const info = issue.delayInfo || {};
        markdown += `- ${issue.issueKey}: ${issue.summary}\n`;
        markdown += `  - **遅延理由**: ${info.delayReason}\n`;
        markdown += `  - **ボール**: ${info.ball || '<!-- 自分/社内（誰）/顧客 -->'}\n`;
        markdown += `  - **状況**: <!-- -->\n`;
      }
      markdown += `\n`;
    }

    // 本日対応予定（今日締め切りはマーク付き）
    if (data.today.length > 0) {
      markdown += `#### 📅 本日対応予定\n`;
      for (const issue of data.today) {
        const dueTodayMark = dueTodayKeys.has(issue.issueKey) ? ' 🔔（今日締め切り）' : '';
        markdown += `- ${issue.issueKey}: ${issue.summary}${dueTodayMark}\n`;
        markdown += `  - **進捗**: <!-- 進行中/完了間近/着手前/ブロック中 -->\n`;
        markdown += `  - **状況**: <!-- -->\n`;
        markdown += `  - **ボール**: <!-- 自分/社内（誰）/顧客 -->\n`;
        markdown += `  - **追加課題**: <!-- この課題に関連して発生した新規課題があれば記載 -->\n`;
      }
      markdown += `\n`;
    }

    // その他セクション（常に表示）
    markdown += `#### 📌 その他\n`;
    markdown += `- **新たな課題**: <!-- 朝会中に発生した新規課題があれば記載 -->\n`;
    markdown += `- **他連絡事項**: <!-- その他の連絡事項があれば記載 -->\n`;
    markdown += `\n`;

    markdown += `---\n\n`;
  }

  // 本日のミーティング予定セクション
  if (mtgIssues.length > 0) {
    markdown += `### 📅 本日のミーティング予定\n\n`;
    markdown += generateMtgSection(mtgIssues);
  }

  return markdown;
}

function generateMtgSection(mtgIssues: MtgIssue[]): string {
  let markdown = '';

  for (const mtg of mtgIssues) {
    markdown += `#### ${mtg.summary}\n\n`;

    if (mtg.purpose) {
      markdown += `- **目的**: ${mtg.purpose}\n`;
    }
    if (mtg.datetime) {
      markdown += `- **開催日時**: ${mtg.datetime}\n`;
    }
    if (mtg.internalParticipants && mtg.internalParticipants.length > 0) {
      markdown += `- **自社参加者**: ${mtg.internalParticipants.join('、')}\n`;
    }
    if (mtg.externalParticipants && mtg.externalParticipants.length > 0) {
      markdown += `- **外部参加者**: ${mtg.externalParticipants.join('、')}\n`;
    }
    if (mtg.mtgUrl) {
      markdown += `- **MTG URL**: [リンク](${mtg.mtgUrl})\n`;
    }
    markdown += `- **課題URL**: [リンク](${mtg.url})\n`;
    markdown += `<!-- メモ -->\n\n`;
  }

  return markdown;
}
