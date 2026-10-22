import { App } from "aws-cdk-lib";

import { CodeJudgeStack, HOST_REGION } from "../lib/codejudge-stack.ts";

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;

/** A context value that must be given (-c key=value); synthesis stops without it. */
function required(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(message);
  return value;
}

// With credentials (cdk diff / deploy) the default VPC of the account is
// looked up. Without them (cdk synth in CI, tests) the stack synthesises
// offline against a placeholder VPC: that template is for review only.
new CodeJudgeStack(app, "CodeJudgeProd", {
  env: { account, region: HOST_REGION },
  offline: !account,
  description: "CodeJudge production (EC2 + gVisor, ECR, backups, GitHub OIDC deploy role)",
  // Required: the stack subscribes this address to the alarms only when it is
  // given, so a deploy without it would silently drop the subscription.
  alarmEmail: required(
    app.node.tryGetContext("alarmEmail"),
    "pass -c alarmEmail=<you@example.com>: without it the deploy drops the alarm subscription",
  ),
  existingOidcProviderArn: app.node.tryGetContext("existingOidcProviderArn"),
  // Pinned in cdk.json; changing it replaces the host (docs/DEPLOY.md, "The host's AMI").
  hostAmi: app.node.tryGetContext("codejudge:hostAmi"),
});
