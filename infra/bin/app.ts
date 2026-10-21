import { App } from "aws-cdk-lib";

import { CodeJudgeStack, HOST_REGION } from "../lib/codejudge-stack.ts";

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;

// With credentials (cdk diff / deploy) the default VPC of the account is
// looked up. Without them (cdk synth in CI, tests) the stack synthesises
// offline against a placeholder VPC: that template is for review only.
new CodeJudgeStack(app, "CodeJudgeProd", {
  env: { account, region: HOST_REGION },
  offline: !account,
  description: "CodeJudge production (EC2 + gVisor, ECR, backups, GitHub OIDC deploy role)",
  alarmEmail: app.node.tryGetContext("alarmEmail"),
  existingOidcProviderArn: app.node.tryGetContext("existingOidcProviderArn"),
  // Pinned in cdk.json; changing it replaces the host (docs/DEPLOY.md, "The host's AMI").
  hostAmi: app.node.tryGetContext("codejudge:hostAmi"),
});
