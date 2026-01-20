import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as ses from 'aws-cdk-lib/aws-ses';
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

    // Parameter Store: 有効な担当者ID（オプション）
    const activeAssigneeIdsParam = ssm.StringParameter.fromStringParameterName(
      this,
      'ActiveAssigneeIdsParam',
      '/backlog-morning-meeting/active-assignee-ids'
    );

    // Lambda関数: fetch-backlog-issues
    const fetchBacklogIssuesFn = new lambda.Function(this, 'FetchBacklogIssues', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/fetch-backlog-issues')),
      timeout: cdk.Duration.minutes(5),
      environment: {
        BACKLOG_PROJECT_KEYS: process.env.BACKLOG_PROJECT_KEYS || '',
        ACTIVE_ASSIGNEE_IDS: process.env.ACTIVE_ASSIGNEE_IDS || '',
        BACKLOG_SECRET_NAME: backlogSecret.secretName,
        ACTIVE_ASSIGNEE_IDS_PARAM: '/backlog-morning-meeting/active-assignee-ids',
      },
    });

    // Secrets Manager読み取り権限
    backlogSecret.grantRead(fetchBacklogIssuesFn);
    
    // Parameter Store読み取り権限
    activeAssigneeIdsParam.grantRead(fetchBacklogIssuesFn);

    // Lambda関数: generate-document
    const generateDocumentFn = new lambda.Function(this, 'GenerateDocument', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/generate-document')),
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
    });

    // Lambda関数: notify-teams
    const notifyTeamsFn = new lambda.Function(this, 'NotifyTeams', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/notify-teams')),
      timeout: cdk.Duration.minutes(2),
      environment: {
        TEAMS_WORKFLOWS_URL: process.env.TEAMS_WORKFLOWS_URL || '',
      },
    });

    // Teams Workflows URLをSecrets Managerで管理する場合（オプション）
    // 環境変数で設定されていない場合のみSecrets Managerから取得
    if (!process.env.TEAMS_WORKFLOWS_URL) {
      const teamsWorkflowsSecret = secretsmanager.Secret.fromSecretNameV2(
        this,
        'TeamsWorkflowsSecret',
        'backlog-morning-meeting/teams-workflows-url'
      );
      teamsWorkflowsSecret.grantRead(notifyTeamsFn);
    }

    // Lambda関数: send-email
    const sendEmailFn = new lambda.Function(this, 'SendEmail', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/send-email')),
      timeout: cdk.Duration.minutes(2),
      environment: {
        EMAIL_RECIPIENTS: process.env.EMAIL_RECIPIENTS || '',
        EMAIL_FROM: process.env.EMAIL_FROM || '',
        REGION: this.region,
      },
    });

    // SES送信権限
    sendEmailFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*'],
      })
    );

    // Step Functions: ステートマシン定義
    const fetchTask = new tasks.LambdaInvoke(this, 'FetchBacklogIssues', {
      lambdaFunction: fetchBacklogIssuesFn,
      outputPath: '$.Payload',
    });

    const generateTask = new tasks.LambdaInvoke(this, 'GenerateDocument', {
      lambdaFunction: generateDocumentFn,
      inputPath: '$.Payload',
      outputPath: '$.Payload',
    });

    const notifyTeamsTask = new tasks.LambdaInvoke(this, 'NotifyTeams', {
      lambdaFunction: notifyTeamsFn,
      inputPath: '$.Payload',
      outputPath: '$.Payload',
    });

    const sendEmailTask = new tasks.LambdaInvoke(this, 'SendEmail', {
      lambdaFunction: sendEmailFn,
      inputPath: '$.Payload',
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

