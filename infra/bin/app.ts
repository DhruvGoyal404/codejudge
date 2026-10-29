import { App } from "aws-cdk-lib";

import { CodeJudgeHostStack, CodeJudgeStack, HOST_REGION } from "../lib/codejudge-stack.ts";

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;

/** A context value that must be given (-c key=value); synthesis stops without it. */
function required(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(message);
  return value;
}

// Two stacks (MAINTENANCE.md, "Up and down"): CodeJudgeProd holds what stays
// while the site is down; CodeJudgeHost holds what bills while idle and is
// destroyed by codejudge-down.sh. With credentials (cdk diff / deploy) the
// default VPC of the account is looked up. Without them (cdk synth in CI,
// tests) the host synthesises offline against a placeholder VPC: that template
// is for review only.
const env = { account, region: HOST_REGION };
const persistent = new CodeJudgeStack(app, "CodeJudgeProd", {
  env,
  description: "CodeJudge persistent parts (backups, alarm topic, deploy document, GitHub OIDC deploy role, budget)",
  // Required: the stack subscribes this address to the alarms only when it is
  // given, so a deploy without it would silently drop the subscription.
  alarmEmail: required(
    app.node.tryGetContext("alarmEmail"),
    "pass -c alarmEmail=<you@example.com>: without it the deploy drops the alarm subscription",
  ),
  budgetEmail: app.node.tryGetContext("budgetEmail"),
  existingOidcProviderArn: app.node.tryGetContext("existingOidcProviderArn"),
});
new CodeJudgeHostStack(app, "CodeJudgeHost", {
  env,
  offline: !account,
  description: "CodeJudge host (EC2 + gVisor, EBS, Elastic IP, ECR): destroyed by codejudge-down.sh",
  persistent,
  // Pinned in cdk.json; changing it replaces the host (docs/DEPLOY.md, "The host's AMI").
  hostAmi: app.node.tryGetContext("codejudge:hostAmi"),
});
