#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BacklogMorningMeetingStack } from '../lib/backlog-morning-meeting-stack';

const app = new cdk.App();
new BacklogMorningMeetingStack(app, 'BacklogMorningMeetingStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  },
});

