import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { Handler } from 'aws-lambda';
import * as https from 'https';

const secretsManager = new SecretsManagerClient({});

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
}

interface EnrichedMtgIssue extends MtgIssue {
  purpose?: string;
  datetime?: string;
  internalParticipants: string[];
  externalParticipants: string[];
  mtgUrl?: string;
}

interface ProjectData {
  projectKey: string;
  projectName: string;
  todayIssues: any[];
  incompleteIssues: any[];
  dueTodayIssues: any[];
  mtgIssues: MtgIssue[];
  backlogUsers: BacklogUser[];
}

interface LambdaEvent {
  projects: ProjectData[];
  activeAssigneeIds: number[];
}

interface LambdaResponse {
  projects: Array<Omit<ProjectData, 'mtgIssues'> & { mtgIssues: EnrichedMtgIssue[] }>;
  activeAssigneeIds: number[];
}

interface OpenAiExtractedData {
  purpose?: string | null;
  datetime?: string | null;
  internalParticipantIds: number[];
  externalParticipants: string[];
  mtgUrl?: string | null;
}

export const handler: Handler<LambdaEvent, LambdaResponse> = async (event) => {
  const { projects, activeAssigneeIds } = event;

  // OpenAI API Keyを取得
  const secretName = process.env.OPENAI_API_KEY_SECRET_NAME || 'backlog-morning-meeting/openai-api-key';
  let openAiApiKey: string | null = null;

  try {
    const secretResponse = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: secretName })
    );
    openAiApiKey = secretResponse.SecretString || null;
  } catch (error) {
    console.warn('OpenAI API Keyの取得に失敗:', error);
  }

  const enrichedProjects = await Promise.all(
    projects.map(async (project) => {
      const { mtgIssues, backlogUsers, ...rest } = project;

      // MTG課題がない場合はスキップ
      if (!mtgIssues || mtgIssues.length === 0) {
        return {
          ...rest,
          mtgIssues: [],
          backlogUsers,
        };
      }

      // 各MTG課題に対して参加者情報を抽出
      const enrichedMtgIssues = await Promise.all(
        mtgIssues.map(async (mtgIssue) => {
          return await extractParticipants(mtgIssue, backlogUsers, openAiApiKey);
        })
      );

      return {
        ...rest,
        mtgIssues: enrichedMtgIssues,
        backlogUsers,
      };
    })
  );

  return {
    projects: enrichedProjects,
    activeAssigneeIds,
  };
};

async function extractParticipants(
  mtgIssue: MtgIssue,
  backlogUsers: BacklogUser[],
  openAiApiKey: string | null
): Promise<EnrichedMtgIssue> {
  // OpenAI API Keyがない場合は抽出なしで返す
  if (!openAiApiKey) {
    return {
      ...mtgIssue,
      internalParticipants: [],
      externalParticipants: [],
    };
  }

  try {
    const extractedData = await callOpenAiApi(mtgIssue.description, backlogUsers, openAiApiKey);

    // internalParticipantIds を名前に変換
    const userIdToName = new Map(backlogUsers.map(u => [u.id, u.name]));
    const internalParticipants = (extractedData.internalParticipantIds || [])
      .map(id => userIdToName.get(id))
      .filter((name): name is string => name !== undefined);

    return {
      ...mtgIssue,
      purpose: extractedData.purpose || undefined,
      datetime: extractedData.datetime || undefined,
      internalParticipants,
      externalParticipants: extractedData.externalParticipants || [],
      mtgUrl: extractedData.mtgUrl || undefined,
    };
  } catch (error) {
    console.error('OpenAI API呼び出しエラー:', error);
    // エラー時は抽出なしで返す
    return {
      ...mtgIssue,
      internalParticipants: [],
      externalParticipants: [],
    };
  }
}

async function callOpenAiApi(
  description: string,
  backlogUsers: BacklogUser[],
  apiKey: string
): Promise<OpenAiExtractedData> {
  const userListText = backlogUsers
    .map(u => `{"id": ${u.id}, "name": "${u.name}"}`)
    .join(', ');

  const prompt = `以下のミーティング説明文から情報を抽出してJSONで返してください。

## Backlogユーザー一覧（自社メンバー）
[${userListText}]

## 説明文
${description}

## 抽出ルール
- purpose: ミーティングの目的・アジェンダ
- datetime: 「開催日時」欄から抽出
- internalParticipantIds: Backlogユーザー一覧と照合し、該当するユーザーのIDを配列で返す
- externalParticipants: 自社メンバー以外の参加者（名前で返す）
- mtgUrl: ミーティングURL（Zoom/Teamsリンクなど）があれば抽出

## 出力形式（JSONのみ返してください）
{
  "purpose": "文字列またはnull",
  "datetime": "文字列またはnull",
  "internalParticipantIds": [数値の配列],
  "externalParticipants": ["文字列の配列"],
  "mtgUrl": "文字列またはnull"
}`;

  const requestBody = JSON.stringify({
    model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
    messages: [
      {
        role: 'system',
        content: 'あなたはミーティング情報を抽出するアシスタントです。指定されたJSON形式でのみ回答してください。',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(requestBody),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.message?.content;
            if (content) {
              const extracted = JSON.parse(content) as OpenAiExtractedData;
              resolve(extracted);
            } else {
              reject(new Error('OpenAI APIからの応答が空です'));
            }
          } catch (e) {
            reject(new Error(`JSONパースエラー: ${e}`));
          }
        } else {
          reject(new Error(`OpenAI API エラー: HTTP ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(requestBody);
    req.end();
  });
}
