import { readFileSync } from "node:fs";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";

import { AMI_ID, APP_REPOS, BACKUP_PREFIX, BUDGET_USD, CodeJudgeHostStack, CodeJudgeStack, GITHUB_REF, GITHUB_SUB, HOST_TAG, MANIFEST_MAX_CHARS, PARAM_PREFIX, SANDBOX_REPOS } from "../lib/codejudge-stack.ts";

// The committed pin, exactly as `cdk deploy` reads it.
const HOST_AMI: string = JSON.parse(readFileSync(new URL("../cdk.json", import.meta.url), "utf8")).context["codejudge:hostAmi"];

const ENV = { account: "123456789012", region: "ap-south-1" };
// t/json: the persistent stack (CodeJudgeProd); h/hjson: the host stack (CodeJudgeHost).
let t: Template;
let json: Record<string, any>;
let h: Template;
let hjson: Record<string, any>;
let persistent: CodeJudgeStack;

beforeAll(() => {
  const app = new App();
  persistent = new CodeJudgeStack(app, "Test", { env: ENV, alarmEmail: "alarms@example.invalid", budgetEmail: "budget@example.invalid" });
  const host = new CodeJudgeHostStack(app, "TestHost", { env: ENV, offline: true, hostAmi: HOST_AMI, persistent });
  t = Template.fromStack(persistent);
  json = t.toJSON();
  h = Template.fromStack(host);
  hjson = h.toJSON();
}, 120_000);

const resources = (type: string, j: Record<string, any> = json) => Object.entries(j.Resources as Record<string, any>).filter(([, r]) => r.Type === type);
const hostResources = (type: string) => resources(type, hjson);
/** Every policy statement of every inline policy attached to the role with this logical-id prefix. */
function statementsOf(rolePrefix: string): any[] {
  const j = rolePrefix === "InstanceRole" ? hjson : json;
  return resources("AWS::IAM::Policy", j)
    .filter(([, p]) => p.Properties.Roles.some((r: any) => JSON.stringify(r).includes(rolePrefix)))
    .flatMap(([, p]) => p.Properties.PolicyDocument.Statement);
}
const asList = <T>(x: T | T[]) => (Array.isArray(x) ? x : [x]);

describe("network exposure", () => {
  it("never opens port 22, and opens only 80/443 to the world", () => {
    expect(hostResources("AWS::EC2::SecurityGroup").length).toBeGreaterThan(0);
    expect(resources("AWS::EC2::SecurityGroup")).toHaveLength(0); // nothing network-facing stays while down
    for (const [, sg] of hostResources("AWS::EC2::SecurityGroup")) {
      for (const rule of sg.Properties.SecurityGroupIngress ?? []) {
        expect(rule.FromPort <= 22 && rule.ToPort >= 22, JSON.stringify(rule)).toBe(false);
        expect([80, 443]).toContain(rule.FromPort);
        expect(rule.ToPort).toBe(rule.FromPort);
      }
    }
    expect(hostResources("AWS::EC2::SecurityGroupIngress")).toHaveLength(0); // no rules added elsewhere
  });

  it("has an Elastic IP associated with the instance", () => {
    h.resourceCountIs("AWS::EC2::EIP", 1);
    t.resourceCountIs("AWS::EC2::EIP", 0);
    h.hasResourceProperties("AWS::EC2::EIPAssociation", { InstanceId: Match.anyValue(), AllocationId: Match.anyValue() });
  });
});

describe("instance", () => {
  it("is a t3.small with credits UNLIMITED", () => {
    h.hasResourceProperties("AWS::EC2::Instance", { InstanceType: "t3.small", CreditSpecification: { CPUCredits: "unlimited" } });
    t.resourceCountIs("AWS::EC2::Instance", 0);
  });

  it("requires IMDSv2", () => {
    h.hasResourceProperties("AWS::EC2::LaunchTemplate", {
      LaunchTemplateData: { MetadataOptions: { HttpTokens: "required" } },
    });
  });

  it("has a 20 GB encrypted gp3 root volume", () => {
    h.hasResourceProperties("AWS::EC2::Instance", {
      BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { VolumeSize: 20, VolumeType: "gp3", Encrypted: true } }],
    });
  });

  it("its user data runs the bootstrap and carries no secrets", () => {
    const [[, inst]] = hostResources("AWS::EC2::Instance");
    const userData = JSON.stringify(inst.Properties.UserData);
    expect(userData).toContain("bootstrap.sh");
    expect(userData).not.toContain("\\r"); // LF only, even when synthesised from a Windows checkout
    for (const word of ["password", "client_secret", "client_id", "private key", "deploy_key", "get-parameter", "/codejudge/prod/"]) {
      expect(userData.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it("recovers on a failed system status check and alarms on surplus credit charges", () => {
    const recover = hostResources("AWS::CloudWatch::Alarm").find(([, a]) => a.Properties.MetricName === "StatusCheckFailed_System")![1];
    expect(JSON.stringify(recover.Properties.AlarmActions)).toContain(":automate:ap-south-1:ec2:recover");
    h.hasResourceProperties("AWS::CloudWatch::Alarm", { MetricName: "CPUSurplusCreditsCharged", Threshold: 0, ComparisonOperator: "GreaterThanThreshold" });
  });

  it("carries the tag the deploy workflow and the deploy role find it by", () => {
    const [[, inst]] = hostResources("AWS::EC2::Instance");
    expect(inst.Properties.Tags).toContainEqual({ Key: HOST_TAG.key, Value: HOST_TAG.value });
  });
});

describe("backup freshness", () => {
  it("lets the host publish metrics only in its own namespace", () => {
    const s = statementsOf("InstanceRole").find((x: any) => x.Sid === "HostMetrics");
    expect(s).toMatchObject({
      Effect: "Allow",
      Action: "cloudwatch:PutMetricData",
      Resource: "*",
      Condition: { StringEquals: { "cloudwatch:namespace": "CodeJudge" } },
    });
  });

  it("alarms when no backup succeeded for 26 hours", () => {
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "CodeJudge",
      MetricName: "BackupSucceeded",
      Statistic: "Sum",
      Period: 3600,
      Threshold: 1,
      ComparisonOperator: "LessThanThreshold",
      EvaluationPeriods: 26,
      DatapointsToAlarm: 26,
      TreatMissingData: "breaching",
    });
    const [, a] = resources("AWS::CloudWatch::Alarm").find(([, x]) => x.Properties.MetricName === "BackupSucceeded")!;
    // CloudWatch: evaluation range (period x periods) at most 7 days for periods of an hour or more.
    expect(a.Properties.Period * a.Properties.EvaluationPeriods).toBeLessThanOrEqual(7 * 24 * 3600);
    expect(a.Properties.AlarmActions).toHaveLength(1); // the SNS topic
  });

  it("lets the host upload dumps exactly where pg-backup.sh writes them", () => {
    // deploy.sh renders BACKUP_DEST=s3://<bucket>/codejudge/pg; the role allows that prefix only.
    expect(BACKUP_PREFIX).toBe("codejudge/pg/");
    const s = statementsOf("InstanceRole").find((x: any) => x.Sid === "BackupPrefixObjects");
    expect(s.Action).toEqual(["s3:PutObject", "s3:GetObject"]);
    expect(JSON.stringify(s.Resource)).toContain("/codejudge/pg/*");
  });
});

describe("storage and registries", () => {
  it("backup bucket: private, encrypted, unversioned, expires after 14 days, retained on stack deletion", () => {
    t.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      Properties: {
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
        LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 14, Status: "Enabled" })]) },
      },
    });
    const [[, bucket]] = resources("AWS::S3::Bucket");
    expect(bucket.Properties.VersioningConfiguration).toBeUndefined();
    // Only the nightly prefix expires: codejudge-down.sh's final backups must survive a long down.
    expect(bucket.Properties.LifecycleConfiguration.Rules).toEqual([expect.objectContaining({ Prefix: BACKUP_PREFIX, ExpirationInDays: 14 })]);
  });

  it("one ECR repo per image, kept while down, each keeping the current and previous release", () => {
    const repos = resources("AWS::ECR::Repository");
    expect(hostResources("AWS::ECR::Repository")).toHaveLength(0); // they outlive the host
    expect(repos.map(([, r]) => r.Properties.RepositoryName).sort()).toEqual(
      [...APP_REPOS, ...SANDBOX_REPOS.map((s) => `sandbox-${s}`)].map((n) => `codejudge/${n}`).sort(),
    );
    for (const [, r] of repos) {
      const policy = JSON.parse(r.Properties.LifecyclePolicy.LifecyclePolicyText);
      expect(policy.rules).toEqual([expect.objectContaining({ selection: expect.objectContaining({ countType: "imageCountMoreThan", countNumber: 2 }) })]);
      expect(r.Properties.ImageTagMutability).toBe("IMMUTABLE");
    }
  });
});

describe("GitHub OIDC deploy role", () => {
  it("is trusted only by this repository's main branch", () => {
    t.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "codejudge-github-deploy",
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                // Exactly the claim a real token carries (the one-off "OIDC claims" workflow,
                // run 39559657597): immutable subject, main branch, no environment.
                "token.actions.githubusercontent.com:sub": "repo:DhruvGoyal404@151380878/codejudge@1418599693:ref:refs/heads/main",
              },
            },
          }),
        ],
      },
    });
    const role = resources("AWS::IAM::Role").find(([, r]) => r.Properties.RoleName === "codejudge-github-deploy")![1];
    for (const s of role.AssumeRolePolicyDocument?.Statement ?? role.Properties.AssumeRolePolicyDocument.Statement) {
      expect(JSON.stringify(s.Condition)).not.toMatch(/StringLike|\*/); // no wildcard subjects
    }
  });
});

describe("least privilege", () => {
  // Actions AWS offers no resource-level permissions for.
  const UNSCOPABLE = new Set(["ecr:GetAuthorizationToken", "ssm:GetCommandInvocation", "ssm:ListCommandInvocations", "ec2:DescribeInstances"]);

  for (const role of ["InstanceRole", "DeployRole"]) {
    it(`${role}: every statement names specific ARNs (except unscopable actions)`, () => {
      const statements = statementsOf(role);
      expect(statements.length).toBeGreaterThan(0);
      for (const s of statements) {
        expect(s.Effect).toBe("Allow");
        const actions = asList(s.Action);
        expect(actions.some((a: string) => a.endsWith(":*") || a === "*"), JSON.stringify(s)).toBe(false);
        const wildcardResource = asList(s.Resource).some((r: any) => r === "*");
        if (wildcardResource) {
          for (const a of actions) expect(UNSCOPABLE.has(a) || s.Condition, `${a} on "*" in ${s.Sid}`).toBeTruthy();
        }
      }
    });
  }

  it("instance: parameters only under the prefix, objects only under the backup prefix, pulls only from our repos", () => {
    const s = statementsOf("InstanceRole");
    const bySid = (sid: string) => s.find((x) => x.Sid === sid)!;
    expect(JSON.stringify(bySid("ReadOwnParameters").Resource)).toContain(`parameter${PARAM_PREFIX}*`);
    expect(JSON.stringify(bySid("DecryptOwnParameters").Condition)).toContain("kms:ViaService");
    expect(JSON.stringify(bySid("BackupPrefixObjects").Resource)).toContain(`/${BACKUP_PREFIX}*`);
    expect(asList(bySid("BackupPrefixObjects").Action).sort()).toEqual(["s3:GetObject", "s3:PutObject"]);
    expect(JSON.stringify(bySid("BackupPrefixList").Condition)).toContain(BACKUP_PREFIX);
    expect(asList(bySid("PullOwnImages").Resource)).toHaveLength(APP_REPOS.length + SANDBOX_REPOS.length);
    expect(asList(bySid("PullOwnImages").Action)).not.toContain("ecr:PutImage");
    h.hasResourceProperties("AWS::IAM::Role", {
      ManagedPolicyArns: [Match.objectLike({ "Fn::Join": Match.arrayWith([Match.arrayWith([":iam::aws:policy/AmazonSSMManagedInstanceCore"])]) })],
    });
  });

  it("deploy role: SendCommand only with our document and only to the tagged host; push only to our repos", () => {
    const s = statementsOf("DeployRole");
    const doc = s.find((x) => x.Sid === "RunDeployDocument")!;
    expect(asList(doc.Action)).toEqual(["ssm:SendCommand"]);
    expect(JSON.stringify(doc.Resource)).toContain(":document/");
    expect(asList(doc.Resource)).toHaveLength(1);
    const onHost = s.find((x) => x.Sid === "RunOnTaggedHost")!;
    expect(asList(onHost.Action)).toEqual(["ssm:SendCommand"]);
    expect(JSON.stringify(onHost.Resource)).toContain(":instance/*");
    expect(onHost.Condition).toEqual({ StringEquals: { [`ssm:resourceTag/${HOST_TAG.key}`]: HOST_TAG.value } });
    const push = s.find((x) => x.Sid === "PushOwnImages")!;
    expect(JSON.stringify(push.Resource)).toContain(":repository/codejudge/*");
    expect(asList(push.Resource)).toHaveLength(1);
    const actions = s.flatMap((x) => asList(x.Action));
    expect(actions.filter((a: string) => !a.startsWith("ecr:") && !a.startsWith("ssm:")), "only ECR, deploy, find host").toEqual(["ec2:DescribeInstances"]);
    expect([...new Set(actions.filter((a: string) => a.startsWith("ssm:")))].sort()).toEqual(["ssm:GetCommandInvocation", "ssm:ListCommandInvocations", "ssm:SendCommand"]);
  });
});

describe("deploy document", () => {
  it("is a Command document taking a base64 manifest and running deploy.sh", () => {
    t.hasResourceProperties("AWS::SSM::Document", {
      Name: "CodeJudge-Deploy",
      DocumentType: "Command",
      Content: Match.objectLike({
        parameters: { Manifest: Match.objectLike({ type: "String", allowedPattern: Match.stringLikeRegexp("A-Za-z0-9") }) },
      }),
    });
    expect(JSON.stringify(resources("AWS::SSM::Document"))).toContain("deploy.sh '{{ Manifest }}'");
  });
});


describe("the host is never replaced by accident", () => {
  it("boots a literal, pinned AMI ID, not one resolved from SSM at deploy time", () => {
    expect(HOST_AMI).toMatch(AMI_ID);
    const [[, inst]] = hostResources("AWS::EC2::Instance");
    expect(inst.Properties.ImageId).toBe(HOST_AMI); // a string, not { Ref: <SSM parameter> }
    // No image ID resolved at deploy time. (CDK's own BootstrapVersion
    // parameter is also read from SSM, but it is a version number, not an AMI.)
    const params = Object.values((hjson.Parameters ?? {}) as Record<string, any>);
    expect(params.filter((p) => String(p.Type).includes("AWS::EC2::Image::Id"))).toEqual([]);
    expect(JSON.stringify(hjson)).not.toContain("/aws/service/canonical/");
  });

  it("keeps a stable logical ID (a new ID means a new instance)", () => {
    // userDataCausesReplacement: false, so user-data edits do not alter the
    // logical ID; CloudFormation applies UserData changes with a stop/start.
    expect(hostResources("AWS::EC2::Instance").map(([id]) => id)).toEqual(["HostB4E45AD7"]);
  });

  it("refuses to synthesise without a pinned AMI", () => {
    for (const bad of [undefined, "", "ami-", "resolve:ssm:/aws/service/canonical/x", "ami-XYZ"]) {
      const app = new App();
      const p = new CodeJudgeStack(app, "P", { env: ENV });
      expect(() => new CodeJudgeHostStack(app, "Bad", { env: ENV, offline: true, persistent: p, hostAmi: bad as string })).toThrow(/pinned AMI/);
    }
  });
});

describe("cdk destroy leaves nothing behind", () => {
  it("creates no custom resources or Lambdas (their log groups would outlive the stack)", () => {
    for (const j of [json, hjson]) {
      const types = Object.values(j.Resources as Record<string, any>).map((r) => r.Type as string);
      expect(types.filter((x) => x.startsWith("Custom::") || x.startsWith("AWS::Lambda::") || x === "AWS::Logs::LogGroup")).toEqual([]);
    }
    t.resourceCountIs("AWS::IAM::OIDCProvider", 1);
  });

  it("retains only the backup bucket; everything else is deleted with its stack", () => {
    const retained = (j: Record<string, any>) =>
      Object.entries(j.Resources as Record<string, any>)
        .filter(([, r]) => r.DeletionPolicy === "Retain" || r.DeletionPolicy === "RetainExceptOnCreate" || r.UpdateReplacePolicy === "Retain")
        .map(([, r]) => r.Type);
    expect(retained(json)).toEqual(["AWS::S3::Bucket"]);
    expect(retained(hjson)).toEqual([]); // codejudge-down.sh destroys the host stack completely
  });

  it("empties the image repositories and releases the address and the volume", () => {
    for (const [, r] of resources("AWS::ECR::Repository")) expect(r.Properties.EmptyOnDelete).toBe(true);
    const [[, inst]] = hostResources("AWS::EC2::Instance");
    expect(inst.Properties.BlockDeviceMappings[0].Ebs.DeleteOnTermination).toBe(true);
    h.resourceCountIs("AWS::EC2::EIP", 1); // released when the stack deletes it
  });
});


// SSM validates a document parameter's allowedPattern with RE2 (Go regexp):
// bounded repeats stop at {1000}, and lookaround, backreferences and atomic
// groups do not exist. A violation fails only at deploy time, in AWS; this
// catches it at synth. (No native re2 binding: a static check is enough.)
function re2Problems(pattern: string): string[] {
  const out: string[] = [];
  try {
    new RegExp(pattern);
  } catch (e) {
    out.push(`does not compile: ${(e as Error).message}`);
  }
  // Repeat counts: {n}, {n,}, {n,m}, not preceded by a backslash.
  for (const m of pattern.matchAll(/(?<!\\)\{(\d+)(?:,(\d*))?\}/g)) {
    for (const n of [m[1], m[2]]) if (n && Number(n) > 1000) out.push(`repeat count ${n} > 1000 in ${m[0]}`);
  }
  for (const [re, what] of [
    [/\(\?[=!]/, "lookahead"],
    [/\(\?<[=!]/, "lookbehind"],
    [/\(\?>/, "atomic group"],
    [/\\[1-9]/, "backreference"],
    [/\\k</, "named backreference"],
  ] as const) {
    if (re.test(pattern)) out.push(`${what} is not RE2`);
  }
  return out;
}

describe("SSM document parameters are valid for SSM", () => {
  it("the RE2 checker itself rejects what SSM rejects", () => {
    expect(re2Problems("^[A-Za-z0-9+/=]{1,4000}$")).not.toEqual([]); // the pattern that failed the first deploy
    expect(re2Problems("^a{1001}$")).not.toEqual([]);
    expect(re2Problems("^(?=a)a$")).not.toEqual([]);
    expect(re2Problems("^(a)\\1$")).not.toEqual([]);
    expect(re2Problems("^[A-Za-z0-9+/=]+$")).toEqual([]);
    expect(re2Problems("^a{2,1000}\\{5000\\}$")).toEqual([]); // escaped braces are literals
  });

  it("every allowedPattern is RE2-compatible", () => {
    const docs = resources("AWS::SSM::Document");
    expect(docs.length).toBeGreaterThan(0);
    for (const [id, d] of docs) {
      for (const [name, p] of Object.entries((d.Properties.Content.parameters ?? {}) as Record<string, any>)) {
        if (p.allowedPattern !== undefined) expect(re2Problems(p.allowedPattern), `${id}.${name}`).toEqual([]);
      }
    }
  });

  it("the manifest's length is bounded by maxChars, and a real manifest fits", () => {
    const [[, d]] = resources("AWS::SSM::Document");
    const p = d.Properties.Content.parameters.Manifest;
    expect(p.maxChars).toBe(MANIFEST_MAX_CHARS);
    const digest = "sha256:" + "a".repeat(64);
    const registry = "123456789012.dkr.ecr.ap-south-1.amazonaws.com";
    const img = (repo: string) => `${registry}/codejudge/${repo}@${digest}`;
    const manifest = JSON.stringify({
      release: "f".repeat(40),
      problems_commit: "e".repeat(40),
      registry,
      images: { api: img("api"), web: img("web"), worker: img("worker"), sandbox: Object.fromEntries(SANDBOX_REPOS.map((s) => [s, img(`sandbox-${s}`)])) },
    });
    const b64 = Buffer.from(manifest).toString("base64");
    expect(b64).toMatch(new RegExp(p.allowedPattern));
    expect(b64.length).toBeLessThanOrEqual(p.maxChars);
  });
});

describe("the deploy role trusts exactly one GitHub subject", () => {
  it("is the immutable subject of main, with no environment and no wildcard", () => {
    expect(GITHUB_SUB).toBe(`repo:DhruvGoyal404@151380878/codejudge@1418599693:ref:${GITHUB_REF}`);
    expect(GITHUB_SUB).not.toMatch(/[*?]|:environment:/);
  });
});

describe("the deploy document runs under /bin/sh", () => {
  // SSM's aws:runShellScript writes runCommand to _script.sh and runs it with
  // sh (dash on Ubuntu). The first deploy died on "set -euo pipefail".
  const doc = () => resources("AWS::SSM::Document")[0][1].Properties.Content;
  const lines = (): string[] => doc().mainSteps[0].inputs.runCommand;

  it("uses only POSIX sh outside the embedded script, and runs deploy.sh with bash", () => {
    const outer = lines().map((l) => l.split("\n")[0]); // the heredoc body is data, not commands
    for (const l of outer) expect(l, l).not.toMatch(/pipefail|\[\[|\bsource\b|<<<|\bfunction\b|\$\(\(|&>/);
    expect(outer[0]).toBe("set -eu");
    expect(lines().at(-1)).toBe("exec /bin/bash /opt/codejudge/bin/deploy.sh '{{ Manifest }}'");
    expect(lines().join("\n")).toContain("<<'CODEJUDGE_DEPLOY'"); // quoted: nothing expands inside
  });

  it("can never be broken out of by the parameter", () => {
    const p = doc().parameters.Manifest;
    expect(lines().join("\n").match(/\{\{ *Manifest *\}\}/g)).toEqual(["{{ Manifest }}"]); // used once, single-quoted
    for (const bad of ["a'b", "a b", "$(id)", "`id`", "a;b", "a\nb"]) expect(bad).not.toMatch(new RegExp(p.allowedPattern));
  });

  it("is updated in place: a new version of the same named document", () => {
    t.hasResourceProperties("AWS::SSM::Document", { Name: "CodeJudge-Deploy", UpdateMethod: "NewVersion" });
  });
});

describe("budget", () => {
  it("alerts (does not cap) at 50/80/100% of about Rs 500 a month, and on the forecast", () => {
    expect(BUDGET_USD).toBeGreaterThan(5);
    expect(BUDGET_USD).toBeLessThan(6.5); // Rs 500 at Rs 80-100 to the dollar
    const [[, b]] = resources("AWS::Budgets::Budget");
    expect(b.Properties.Budget).toMatchObject({ BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: { Amount: BUDGET_USD, Unit: "USD" } });
    const n = b.Properties.NotificationsWithSubscribers.map((x: any) => `${x.Notification.NotificationType} ${x.Notification.Threshold}`);
    expect(n).toEqual(["ACTUAL 50", "ACTUAL 80", "ACTUAL 100", "FORECASTED 100"]);
    for (const x of b.Properties.NotificationsWithSubscribers) {
      expect(x.Subscribers).toEqual([{ SubscriptionType: "EMAIL", Address: "budget@example.invalid" }]);
    }
    expect(resources("AWS::Budgets::Budget", hjson)).toHaveLength(0); // stays while down
  });
});
