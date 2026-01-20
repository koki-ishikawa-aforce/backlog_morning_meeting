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

    // Secrets Manager: Teams Workflows URL
    const teamsWorkflowsSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'TeamsWorkflowsSecret',
      'backlog-morning-meeting/teams-workflows-url'
    );

    // Parameter Store: 有効な担当者ID（オプション）
    const activeAssigneeIdsParam = ssm.StringParameter.fromStringParameterName(
      this,
      'ActiveAssigneeIdsParam',
      '/backlog-morning-meeting/active-assignee-ids'
    );

    // Parameter Store: 対象プロジェクトキー（必須）
    const projectKeysParam = ssm.StringParameter.fromStringParameterName(
      this,
      'ProjectKeysParam',
      '/backlog-morning-meeting/project-keys'
    );

    // Parameter Store: メール設定（必須）
    const emailFromParam = ssm.StringParameter.fromStringParameterName(
      this,
      'EmailFromParam',
      '/backlog-morning-meeting/email-from'
    );

    const emailRecipientsParam = ssm.StringParameter.fromStringParameterName(
      this,
      'EmailRecipientsParam',
      '/backlog-morning-meeting/email-recipients'
    );

    // Lambda関数: fetch-backlog-issues
    const fetchBacklogIssuesFn = new lambda.Function(this, 'FetchBacklogIssues', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/fetch-backlog-issues')),
      timeout: cdk.Duration.minutes(5),
      environment: {
        BACKLOG_SECRET_NAME: backlogSecret.secretName,
        ACTIVE_ASSIGNEE_IDS_PARAM: activeAssigneeIdsParam.parameterName,
        BACKLOG_PROJECT_KEYS_PARAM: projectKeysParam.parameterName,
      },
    });

    // Secrets Manager読み取り権限
    backlogSecret.grantRead(fetchBacklogIssuesFn);
    
    // Parameter Store読み取り権限
    activeAssigneeIdsParam.grantRead(fetchBacklogIssuesFn);
    projectKeysParam.grantRead(fetchBacklogIssuesFn);

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
    });

    // Teams Workflows URLはSecrets Managerから取得
    teamsWorkflowsSecret.grantRead(notifyTeamsFn);

    // Lambda関数: send-email
    const sendEmailFn = new lambda.Function(this, 'SendEmail', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/send-email')),
      timeout: cdk.Duration.minutes(2),
      environment: {
        EMAIL_FROM_PARAM: emailFromParam.parameterName,
        EMAIL_RECIPIENTS_PARAM: emailRecipientsParam.parameterName,
        REGION: this.region,
      },
    });

    // Parameter Store読み取り権限（メール設定）
    emailFromParam.grantRead(sendEmailFn);
    emailRecipientsParam.grantRead(sendEmailFn);

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

