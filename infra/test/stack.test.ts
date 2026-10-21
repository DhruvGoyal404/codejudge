import { readFileSync } from "node:fs";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";

import { AMI_ID, APP_REPOS, BACKUP_PREFIX, CodeJudgeStack, GITHUB_REF, GITHUB_REPO, MANIFEST_MAX_CHARS, PARAM_PREFIX, SANDBOX_REPOS } from "../lib/codejudge-stack.ts";

// The committed pin, exactly as `cdk deploy` reads it.
const HOST_AMI: string = JSON.parse(readFileSync(new URL("../cdk.json", import.meta.url), "utf8")).context["codejudge:hostAmi"];

let t: Template;
let json: Record<string, any>;

beforeAll(() => {
  const app = new App();
  const stack = new CodeJudgeStack(app, "Test", { env: { account: "123456789012", region: "ap-south-1" }, offline: true, hostAmi: HOST_AMI });
  t = Template.fromStack(stack);
  json = t.toJSON();
}, 120_000);

const resources = (type: string) => Object.entries(json.Resources as Record<string, any>).filter(([, r]) => r.Type === type);
/** Every policy statement of every inline policy attached to the role with this logical-id prefix. */
function statementsOf(rolePrefix: string): any[] {
  return resources("AWS::IAM::Policy")
    .filter(([, p]) => p.Properties.Roles.some((r: any) => JSON.stringify(r).includes(rolePrefix)))
    .flatMap(([, p]) => p.Properties.PolicyDocument.Statement);
}
const asList = <T>(x: T | T[]) => (Array.isArray(x) ? x : [x]);

describe("network exposure", () => {
  it("never opens port 22, and opens only 80/443 to the world", () => {
    for (const [, sg] of resources("AWS::EC2::SecurityGroup")) {
      for (const rule of sg.Properties.SecurityGroupIngress ?? []) {
        expect(rule.FromPort <= 22 && rule.ToPort >= 22, JSON.stringify(rule)).toBe(false);
        expect([80, 443]).toContain(rule.FromPort);
        expect(rule.ToPort).toBe(rule.FromPort);
      }
    }
    expect(resources("AWS::EC2::SecurityGroupIngress")).toHaveLength(0); // no rules added elsewhere
  });

  it("has an Elastic IP associated with the instance", () => {
    t.resourceCountIs("AWS::EC2::EIP", 1);
    t.hasResourceProperties("AWS::EC2::EIPAssociation", { InstanceId: Match.anyValue(), AllocationId: Match.anyValue() });
  });
});

describe("instance", () => {
  it("is a t3.small with credits UNLIMITED", () => {
    t.hasResourceProperties("AWS::EC2::Instance", { InstanceType: "t3.small", CreditSpecification: { CPUCredits: "unlimited" } });
  });

  it("requires IMDSv2", () => {
    t.hasResourceProperties("AWS::EC2::LaunchTemplate", {
      LaunchTemplateData: { MetadataOptions: { HttpTokens: "required" } },
    });
  });

  it("has a 20 GB encrypted gp3 root volume", () => {
    t.hasResourceProperties("AWS::EC2::Instance", {
      BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { VolumeSize: 20, VolumeType: "gp3", Encrypted: true } }],
    });
  });

  it("its user data runs the bootstrap and carries no secrets", () => {
    const [[, inst]] = resources("AWS::EC2::Instance");
    const userData = JSON.stringify(inst.Properties.UserData);
    expect(userData).toContain("bootstrap.sh");
    expect(userData).not.toContain("\\r"); // LF only, even when synthesised from a Windows checkout
    for (const word of ["password", "client_secret", "client_id", "private key", "deploy_key", "get-parameter", "/codejudge/prod/"]) {
      expect(userData.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it("recovers on a failed system status check and alarms on surplus credit charges", () => {
    const recover = resources("AWS::CloudWatch::Alarm").find(([, a]) => a.Properties.MetricName === "StatusCheckFailed_System")![1];
    expect(JSON.stringify(recover.Properties.AlarmActions)).toContain(":automate:ap-south-1:ec2:recover");
    t.hasResourceProperties("AWS::CloudWatch::Alarm", { MetricName: "CPUSurplusCreditsCharged", Threshold: 0, ComparisonOperator: "GreaterThanThreshold" });
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
  });

  it("one ECR repo per image, each keeping the last 10 images", () => {
    const repos = resources("AWS::ECR::Repository");
    expect(repos.map(([, r]) => r.Properties.RepositoryName).sort()).toEqual(
      [...APP_REPOS, ...SANDBOX_REPOS.map((s) => `sandbox-${s}`)].map((n) => `codejudge/${n}`).sort(),
    );
    for (const [, r] of repos) {
      const policy = JSON.parse(r.Properties.LifecyclePolicy.LifecyclePolicyText);
      expect(policy.rules).toEqual([expect.objectContaining({ selection: expect.objectContaining({ countType: "imageCountMoreThan", countNumber: 10 }) })]);
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
                "token.actions.githubusercontent.com:sub": `repo:${GITHUB_REPO}:ref:${GITHUB_REF}`,
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
  const UNSCOPABLE = new Set(["ecr:GetAuthorizationToken", "ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]);

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
    t.hasResourceProperties("AWS::IAM::Role", {
      ManagedPolicyArns: [Match.objectLike({ "Fn::Join": Match.arrayWith([Match.arrayWith([":iam::aws:policy/AmazonSSMManagedInstanceCore"])]) })],
    });
  });

  it("deploy role: SendCommand only to this instance with our document; push only to our repos", () => {
    const s = statementsOf("DeployRole");
    const send = s.find((x) => x.Sid === "RunDeployDocumentOnHost")!;
    expect(asList(send.Action)).toEqual(["ssm:SendCommand"]);
    const res = JSON.stringify(send.Resource);
    expect(res).toContain(":instance/");
    expect(res).toContain(":document/");
    expect(asList(send.Resource)).toHaveLength(2);
    const push = s.find((x) => x.Sid === "PushOwnImages")!;
    expect(asList(push.Resource)).toHaveLength(APP_REPOS.length + SANDBOX_REPOS.length);
    const actions = s.flatMap((x) => asList(x.Action));
    expect(actions.filter((a: string) => !a.startsWith("ecr:") && !a.startsWith("ssm:")), "only ECR + deploy").toEqual([]);
    expect(actions.filter((a: string) => a.startsWith("ssm:")).sort()).toEqual(["ssm:GetCommandInvocation", "ssm:ListCommandInvocations", "ssm:SendCommand"]);
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
    const [[, inst]] = resources("AWS::EC2::Instance");
    expect(inst.Properties.ImageId).toBe(HOST_AMI); // a string, not { Ref: <SSM parameter> }
    // No image ID resolved at deploy time. (CDK's own BootstrapVersion
    // parameter is also read from SSM, but it is a version number, not an AMI.)
    const params = Object.values((json.Parameters ?? {}) as Record<string, any>);
    expect(params.filter((p) => String(p.Type).includes("AWS::EC2::Image::Id"))).toEqual([]);
    expect(JSON.stringify(json)).not.toContain("/aws/service/canonical/");
  });

  it("keeps a stable logical ID (a new ID means a new instance)", () => {
    // userDataCausesReplacement: false, so user-data edits do not alter the
    // logical ID; CloudFormation applies UserData changes with a stop/start.
    expect(resources("AWS::EC2::Instance").map(([id]) => id)).toEqual(["HostB4E45AD7"]);
  });

  it("refuses to synthesise without a pinned AMI", () => {
    for (const bad of [undefined, "", "ami-", "resolve:ssm:/aws/service/canonical/x", "ami-XYZ"]) {
      expect(() => new CodeJudgeStack(new App(), "Bad", { env: { account: "123456789012", region: "ap-south-1" }, offline: true, hostAmi: bad as string })).toThrow(/pinned AMI/);
    }
  });
});

describe("cdk destroy leaves nothing behind", () => {
  it("creates no custom resources or Lambdas (their log groups would outlive the stack)", () => {
    const types = Object.values(json.Resources as Record<string, any>).map((r) => r.Type as string);
    expect(types.filter((x) => x.startsWith("Custom::") || x.startsWith("AWS::Lambda::") || x === "AWS::Logs::LogGroup")).toEqual([]);
    t.resourceCountIs("AWS::IAM::OIDCProvider", 1);
  });

  it("retains only the backup bucket; everything else is deleted with the stack", () => {
    const retained = Object.entries(json.Resources as Record<string, any>)
      .filter(([, r]) => r.DeletionPolicy === "Retain" || r.DeletionPolicy === "RetainExceptOnCreate" || r.UpdateReplacePolicy === "Retain")
      .map(([, r]) => r.Type);
    expect(retained).toEqual(["AWS::S3::Bucket"]);
  });

  it("empties the image repositories and releases the address and the volume", () => {
    for (const [, r] of resources("AWS::ECR::Repository")) expect(r.Properties.EmptyOnDelete).toBe(true);
    const [[, inst]] = resources("AWS::EC2::Instance");
    expect(inst.Properties.BlockDeviceMappings[0].Ebs.DeleteOnTermination).toBe(true);
    t.resourceCountIs("AWS::EC2::EIP", 1); // released when the stack deletes it
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
