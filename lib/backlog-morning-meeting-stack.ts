import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'path';

export class BacklogMorningMeetingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Secrets Manager: Backlog認証情報
    const backlogSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'BacklogSecret',
      'backlog-morning-meeting/backlog-credentials'
    );

    // Secrets Manager: Teams Workflows URL
    const teamsWorkflowsSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'TeamsWorkflowsSecret',
      'backlog-morning-meeting/teams-workflows-url'
    );

    // Secrets Manager: OpenAI API Key（Markdown生成をLLMに任せる場合）
    const openAiApiKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'OpenAiApiKeySecret',
      'backlog-morning-meeting/openai-api-key'
    );

    // Parameter Store（パラメータ名は固定。Lambdaが実行時にSSMから値を取得する）
    // NOTE: CloudFormationがSSM型検証を行い StringList/String の不整合でデプロイが止まることがあるため、
    // ここではssm.*の型付き参照を避け、文字列 + IAM権限付与に寄せる。
    const activeAssigneeIdsParamName = '/backlog-morning-meeting/active-assignee-ids';
    const projectKeysParamName = '/backlog-morning-meeting/project-keys';
    const emailFromParamName = '/backlog-morning-meeting/email-from';
    const emailRecipientsParamName = '/backlog-morning-meeting/email-recipients';

    // Lambda関数: fetch-backlog-issues（TypeScriptをデプロイ時にバンドル）
    const fetchBacklogIssuesFn = new NodejsFunction(this, 'FetchBacklogIssues', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/fetch-backlog-issues/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      environment: {
        BACKLOG_SECRET_NAME: backlogSecret.secretName,
        ACTIVE_ASSIGNEE_IDS_PARAM: activeAssigneeIdsParamName,
        BACKLOG_PROJECT_KEYS_PARAM: projectKeysParamName,
      },
      bundling: {
        target: 'node20',
        sourceMap: true,
        minify: true,
      },
    });

    // Secrets Manager読み取り権限
    backlogSecret.grantRead(fetchBacklogIssuesFn);

    // Parameter Store読み取り権限（SSM）
    fetchBacklogIssuesFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${activeAssigneeIdsParamName}`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter${projectKeysParamName}`,
        ],
      })
    );

    // Lambda関数: generate-document（TypeScriptをデプロイ時にバンドル）
    const generateDocumentFn = new NodejsFunction(this, 'GenerateDocument', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/generate-document/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      environment: {
        OPENAI_API_KEY_SECRET_NAME: openAiApiKeySecret.secretName,
        // 必要ならSSM化も可能。まずは固定デフォルトで運用。
        OPENAI_MODEL: 'gpt-4o-mini',
      },
      bundling: {
        target: 'node20',
        sourceMap: true,
        minify: true,
      },
    });

    openAiApiKeySecret.grantRead(generateDocumentFn);

    // Lambda関数: notify-teams（TypeScriptをデプロイ時にバンドル）
    const notifyTeamsFn = new NodejsFunction(this, 'NotifyTeams', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/notify-teams/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(2),
      bundling: {
        target: 'node20',
        sourceMap: true,
        minify: true,
      },
    });

    // Teams Workflows URLはSecrets Managerから取得
    teamsWorkflowsSecret.grantRead(notifyTeamsFn);

    // Lambda関数: send-email（TypeScriptをデプロイ時にバンドル）
    const sendEmailFn = new NodejsFunction(this, 'SendEmail', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/send-email/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(2),
      environment: {
        EMAIL_FROM_PARAM: emailFromParamName,
        EMAIL_RECIPIENTS_PARAM: emailRecipientsParamName,
        REGION: this.region,
      },
      bundling: {
        target: 'node20',
        sourceMap: true,
        minify: true,
      },
    });

    // Parameter Store読み取り権限（メール設定）
    sendEmailFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${emailFromParamName}`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter${emailRecipientsParamName}`,
        ],
      })
    );

    // SES送信権限
    sendEmailFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*'],
      })
    );

    // Step Functions: ステートマシン定義
    const fetchTask = new tasks.LambdaInvoke(this, 'FetchBacklogIssuesTask', {
      lambdaFunction: fetchBacklogIssuesFn,
      outputPath: '$.Payload',
    });

    const generateTask = new tasks.LambdaInvoke(this, 'GenerateDocumentTask', {
      lambdaFunction: generateDocumentFn,
      outputPath: '$.Payload',
    });

    const notifyTeamsTask = new tasks.LambdaInvoke(this, 'NotifyTeamsTask', {
      lambdaFunction: notifyTeamsFn,
      outputPath: '$.Payload',
    });

    const sendEmailTask = new tasks.LambdaInvoke(this, 'SendEmailTask', {
      lambdaFunction: sendEmailFn,
      outputPath: '$.Payload',
    });

    // 並列実行: Teams通知とメール送信
    const notifyParallel = new stepfunctions.Parallel(this, 'NotifyParallel', {
      resultPath: '$.Notifications',
    });

    notifyParallel.branch(notifyTeamsTask);
    notifyParallel.branch(sendEmailTask);

    // ステートマシン定義
    const definition = fetchTask
      .next(generateTask)
      .next(notifyParallel);

    const stateMachine = new stepfunctions.StateMachine(this, 'BacklogMorningMeetingStateMachine', {
      definitionBody: stepfunctions.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.minutes(15),
    });

    // EventBridgeルール: 毎日9:30 JST（UTC 0:30）
    const rule = new events.Rule(this, 'MorningMeetingSchedule', {
      schedule: events.Schedule.cron({
        minute: '30',
        hour: '0',
        day: '*',
        month: '*',
        year: '*',
      }),
      description: '毎日9:30 JSTに朝会ドキュメントを生成',
    });

    rule.addTarget(new targets.SfnStateMachine(stateMachine));
  }
}

