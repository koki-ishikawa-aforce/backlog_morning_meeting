import { Handler } from 'aws-lambda';

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

    // プロジェクトごとにドキュメントを生成
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
  const { projectKey, projectName, issues } = project;

  // 課題を分類
  const today = new Date().toISOString().split('T')[0];
  const sevenDaysLater = new Date();
  sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);
  const sevenDaysLaterStr = sevenDaysLater.toISOString().split('T')[0];

  const todayIssues = issues.filter(issue => issue.startDate === today);
  const incompleteIssues = issues.filter(issue => {
    if (!issue.startDate) return false;
    const startDate = new Date(issue.startDate);
    const todayDate = new Date(today);
    return startDate < todayDate && issue.status.name !== '完了';
  });
  const dueSoonIssues = issues.filter(issue => {
    if (!issue.dueDate) return false;
    const dueDate = new Date(issue.dueDate);
    const todayDate = new Date(today);
    const sevenDaysLaterDate = new Date(sevenDaysLaterStr);
    return dueDate >= todayDate && dueDate <= sevenDaysLaterDate;
  });

  // 統計情報
  const summary = {
    today: todayIssues.length,
    incomplete: incompleteIssues.length,
    dueSoon: dueSoonIssues.length,
  };

  // 担当者リストを取得（課題から抽出）
  const assignees = new Set<string>();
  [...todayIssues, ...incompleteIssues, ...dueSoonIssues].forEach(issue => {
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
  markdown += `| 期限間近（7日以内） | ${summary.dueSoon}件 |\n\n`;

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

  // 期限が近い課題
  if (dueSoonIssues.length > 0) {
    markdown += `## 🔔 期限が近い課題（7日以内）\n\n`;
    markdown += generateIssuesByAssignee(dueSoonIssues);
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
    markdown += `| 課題キー | 課題名 | ステータス | 期限日 | 開始日 | 優先度 | カテゴリ | URL |\n`;
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
      
      markdown += `| ${issueKey} | ${summary} | ${status} | ${dueDate} | ${startDate} | ${priority} | ${category} | [リンク](${url}) |\n`;
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


