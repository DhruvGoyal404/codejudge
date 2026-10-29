import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubs from "aws-cdk-lib/aws-sns-subscriptions";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
/** A host script as LF text (a Windows checkout may have CRLF; the host must not). */
const hostScript = (name: string) => readFileSync(`${REPO}deploy/host/${name}`, "utf8").replace(/\r\n/g, "\n");

/** GitHub repository and branch allowed to deploy (OIDC "sub" claim). */
export const GITHUB_REPO = "DhruvGoyal404/codejudge";
export const GITHUB_REF = "refs/heads/main";
/**
 * The OIDC "sub" claim GitHub issues for this repository's main branch. The
 * repository uses immutable subjects (GitHub API
 * repos/DhruvGoyal404/codejudge/actions/oidc/customization/sub:
 * use_immutable_subject = true), which carry the owner's and the repository's
 * numeric IDs: a renamed or re-created repository of the same name does not
 * match. Read from a real token (docs/DEPLOY.md, first deploy, step 7).
 */
export const GITHUB_OWNER_ID = "151380878";
export const GITHUB_REPO_ID = "1418599693";
export const GITHUB_SUB = `repo:DhruvGoyal404@${GITHUB_OWNER_ID}/codejudge@${GITHUB_REPO_ID}:ref:${GITHUB_REF}`;
/** Every SSM parameter the host may read lives under this prefix. */
export const PARAM_PREFIX = "/codejudge/prod/";
export const APP_REPOS = ["api", "web", "worker"] as const;
export const SANDBOX_REPOS = ["cpp-compile", "cpp-run", "python", "java-compile", "java-run", "node", "go-compile"] as const;
export const DEPLOY_DOCUMENT = "CodeJudge-Deploy";
/** Longest base64 release manifest the deploy document accepts (one today is ~2.5 KB). */
export const MANIFEST_MAX_CHARS = 4000;
/** CloudWatch namespace of the host's own metrics (deploy/backup/pg-backup.sh). */
export const HOST_METRIC_NAMESPACE = "CodeJudge";
/** The deploy document's runCommand lines (run by SSM with /bin/sh). */
export const DEPLOY_RUN_COMMAND = (deployScript: string) => [
  "set -eu",
  "install -d -m 0755 /opt/codejudge/bin",
  `cat > /opt/codejudge/bin/deploy.sh.new <<'CODEJUDGE_DEPLOY'\n${deployScript}CODEJUDGE_DEPLOY`,
  "chmod 0755 /opt/codejudge/bin/deploy.sh.new",
  "mv -f /opt/codejudge/bin/deploy.sh.new /opt/codejudge/bin/deploy.sh",
  "exec /bin/bash /opt/codejudge/bin/deploy.sh '{{ Manifest }}'",
];
/** Where pg-backup.sh writes (deploy.sh renders BACKUP_DEST from the bucket name). */
export const BACKUP_PREFIX = "codejudge/pg/";
export const HOST_REGION = "ap-south-1";
/** The tag that marks the running host: the Deploy workflow finds it by this tag. */
export const HOST_TAG = { key: "codejudge:host", value: "prod" } as const;
/**
 * Monthly cost alert, in USD (the account bills in USD): about Rs 500 at
 * Rs 88 to the dollar. An alert, not a cap: AWS keeps billing past it.
 */
export const BUDGET_USD = 5.7;
/** An EC2 AMI ID. */
export const AMI_ID = /^ami-[0-9a-f]{8,17}$/;

export interface CodeJudgeStackProps extends StackProps {
  /** Email for alarm notifications (optional; confirm the SNS subscription). */
  alarmEmail?: string;
  /** Email for the monthly budget alert (defaults to alarmEmail). */
  budgetEmail?: string;
  /** Set if the account already has GitHub's OIDC provider (only one per URL). */
  existingOidcProviderArn?: string;
}

export interface CodeJudgeHostStackProps extends StackProps {
  /** The persistent stack: backup bucket and alarm topic. */
  persistent: CodeJudgeStack;
  /**
   * Synthesise without AWS credentials (CI, tests): a placeholder stands in
   * for the default VPC, which real deploys look up. Never deploy offline.
   */
  offline?: boolean;
  /**
   * The host's AMI, pinned (cdk.json context "codejudge:hostAmi"). A literal ID
   * keeps the instance's ImageId fixed: resolving an SSM "current" parameter at
   * deploy time would change it on every Ubuntu release and REPLACE the host
   * (and its on-box Postgres). OS updates happen on the host (unattended-upgrades).
   */
  hostAmi: string;
}

/**
 * CodeJudge's persistent parts, which stay while the site is down: the backup
 * bucket, the image registries (current + previous release), the alarm topic
 * and backup alarm, the deploy document, the GitHub OIDC deploy role and the
 * budget. Idle, only the registries cost anything (~$0.25/month). The host and
 * its address live in CodeJudgeHostStack, which codejudge-down.sh destroys. See MAINTENANCE.md, "Up and down".
 */
export class CodeJudgeStack extends Stack {
  readonly backups: s3.Bucket;
  readonly topic: sns.Topic;
  readonly repos: ecr.Repository[];

  constructor(scope: Construct, id: string, props: CodeJudgeStackProps) {
    super(scope, id, props);

    // --- Backup bucket ------------------------------------------------------------
    const backups = new s3.Bucket(this, "Backups", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // Nightly dumps (codejudge/pg/) expire; codejudge/final/ (written by
      // codejudge-down.sh, pruned to the newest few) never does, so a long
      // down never loses the data.
      lifecycleRules: [
        { id: "expire-after-14-days", prefix: BACKUP_PREFIX, expiration: Duration.days(14), abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
      // Backups outlive the stack: delete the bucket by hand after the final export.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.backups = backups;
    // Non-secret configuration the host reads with the secrets.
    new ssm.StringParameter(this, "BackupBucketParam", {
      parameterName: `${PARAM_PREFIX}backup_bucket`,
      stringValue: backups.bucketName,
      description: "S3 bucket for the nightly database dumps (written by deploy.sh into backup.env)",
    });

    // --- Alarms ------------------------------------------------------------------
    const topic = new sns.Topic(this, "Alarms", { displayName: "CodeJudge alarms" });
    this.topic = topic;
    if (props.alarmEmail) topic.addSubscription(new snsSubs.EmailSubscription(props.alarmEmail));
    // No successful backup in 26 hours. pg-backup.sh publishes
    // CodeJudge/BackupSucceeded=1 once per nightly upload (03:30 UTC + up to
    // 10 min). Hourly periods: with a period of at least an hour, CloudWatch
    // allows an evaluation range of up to 7 days, so 26 x 1 h is valid. Every
    // one of the 26 hourly sums must be below 1 (missing counts as breaching),
    // so a normal daily cadence (gaps of about 24 h) never fires it.
    // codejudge-down.sh disables its actions while the host is gone, and
    // codejudge-up.sh re-enables them after a fresh backup.
    const backupMissing = new cloudwatch.Alarm(this, "BackupMissing", {
      alarmDescription: "No successful database backup in 26 hours (CodeJudge/BackupSucceeded): see MAINTENANCE.md, Backups",
      metric: new cloudwatch.Metric({
        namespace: HOST_METRIC_NAMESPACE,
        metricName: "BackupSucceeded",
        statistic: "Sum",
        period: Duration.hours(1),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 26,
      datapointsToAlarm: 26,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    backupMissing.addAlarmAction(new cwActions.SnsAction(topic));

    // --- Budget (an alert, not a cap) ----------------------------------------------
    const budgetEmail = props.budgetEmail ?? props.alarmEmail;
    if (budgetEmail) {
      const email = [{ subscriptionType: "EMAIL", address: budgetEmail }];
      new budgets.CfnBudget(this, "MonthlyBudget", {
        budget: { budgetName: "codejudge-monthly", budgetType: "COST", timeUnit: "MONTHLY", budgetLimit: { amount: BUDGET_USD, unit: "USD" } },
        notificationsWithSubscribers: [
          ...[50, 80, 100].map((threshold) => ({
            notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold, thresholdType: "PERCENTAGE" },
            subscribers: email,
          })),
          {
            notification: { notificationType: "FORECASTED", comparisonOperator: "GREATER_THAN", threshold: 100, thresholdType: "PERCENTAGE" },
            subscribers: email,
          },
        ],
      });
    }

    // --- Image registries ---------------------------------------------------------
    // Kept while the site is down: codejudge-up.sh redeploys the saved release
    // from here without rebuilding (MAINTENANCE.md, "Up and down"). Only the
    // current and the previous release (rollback) are kept: ~2.5 GB, ~$0.25/month.
    const repos = [...APP_REPOS, ...SANDBOX_REPOS.map((s) => `sandbox-${s}`)].map(
      (name) =>
        new ecr.Repository(this, `Repo-${name}`, {
          repositoryName: `codejudge/${name}`,
          imageScanOnPush: true,
          imageTagMutability: ecr.TagMutability.IMMUTABLE,
          encryption: ecr.RepositoryEncryption.AES_256,
          lifecycleRules: [{ description: "keep the current and the previous release", maxImageCount: 2 }],
          // Images are rebuilt from git (codejudge-up.sh --build): nothing is lost when the stack goes.
          removalPolicy: RemovalPolicy.DESTROY,
          emptyOnDelete: true,
        }),
    );
    this.repos = repos;

    // --- Deploy document -------------------------------------------------------------
    const deployScript = hostScript("deploy.sh");
    const doc = new ssm.CfnDocument(this, "DeployDocument", {
      name: DEPLOY_DOCUMENT,
      documentType: "Command",
      documentFormat: "JSON",
      updateMethod: "NewVersion",
      content: {
        schemaVersion: "2.2",
        description: "Deploy a CodeJudge release (images pinned by digest); rolls back on failure. See docs/DEPLOY.md.",
        parameters: {
          Manifest: {
            type: "String",
            description: "base64 of release.json",
            // SSM checks allowedPattern with RE2, whose repeat counts stop at
            // 1000: the character set goes in the pattern, the length in maxChars.
            allowedPattern: "^[A-Za-z0-9+/=]+$",
            maxChars: MANIFEST_MAX_CHARS,
          },
        },
        mainSteps: [
          {
            action: "aws:runShellScript",
            name: "deploy",
            inputs: {
              // The worker restart waits for in-flight submissions (up to 45 min).
              timeoutSeconds: "3600",
              // SSM runs these lines with /bin/sh (dash on Ubuntu): POSIX only
              // here, then exec bash for deploy.sh. {{ Manifest }} is pasted in
              // textually; its allowedPattern (base64 characters) keeps it from
              // ever containing a quote, so the single quotes cannot be broken.
              // CI runs exactly these lines with sh (scripts/ci-deploy-e2e.sh).
              runCommand: DEPLOY_RUN_COMMAND(deployScript),
            },
          },
        ],
      },
    });

    // --- GitHub OIDC deploy role ---------------------------------------------------------
    // Native AWS::IAM::OIDCProvider, not iam.OpenIdConnectProvider: that one is a
    // custom resource whose Lambda leaves a log group behind after cdk destroy.
    const providerArn =
      props.existingOidcProviderArn ??
      new iam.CfnOIDCProvider(this, "GitHubOidc", {
        url: "https://token.actions.githubusercontent.com",
        clientIdList: ["sts.amazonaws.com"],
        // IAM validates GitHub's certificate chain itself; the list is kept for
        // compatibility with older account settings.
        thumbprintList: ["6938fd4d98bab03faadb97b34396831e3780aea1", "1c58a3a8518e8759bf075b76b750d4f2df264fcd"],
      }).attrArn;
    const deployRole = new iam.Role(this, "DeployRole", {
      roleName: "codejudge-github-deploy",
      description: `GitHub Actions in ${GITHUB_REPO} on ${GITHUB_REF}: push images, run the deploy document`,
      maxSessionDuration: Duration.hours(2),
      assumedBy: new iam.WebIdentityPrincipal(providerArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": GITHUB_SUB,
        },
      }),
    });
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "PushOwnImages",
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:CompleteLayerUpload",
          "ecr:DescribeImages",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ],
        // The repositories come and go with the host stack: name them by pattern.
        resources: [this.formatArn({ service: "ecr", resource: "repository", resourceName: "codejudge/*" })],
      }),
    );
    deployRole.addToPolicy(new iam.PolicyStatement({ sid: "RegistryLogin", actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }));
    // SendCommand needs both the document and the instance. The host is new on
    // every up, so instances are allowed by tag (a separate statement: the
    // document carries no such tag).
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "RunDeployDocument",
        actions: ["ssm:SendCommand"],
        resources: [this.formatArn({ service: "ssm", resource: "document", resourceName: doc.ref })],
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "RunOnTaggedHost",
        actions: ["ssm:SendCommand"],
        resources: [this.formatArn({ service: "ec2", resource: "instance", resourceName: "*" })],
        conditions: { StringEquals: { [`ssm:resourceTag/${HOST_TAG.key}`]: HOST_TAG.value } },
      }),
    );
    // Finding the host (and failing fast when it is down) has no resource-level permissions.
    deployRole.addToPolicy(new iam.PolicyStatement({ sid: "FindHost", actions: ["ec2:DescribeInstances"], resources: ["*"] }));
    // Reading the command's outcome has no resource-level permissions.
    deployRole.addToPolicy(
      new iam.PolicyStatement({ sid: "ReadDeployOutcome", actions: ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"], resources: ["*"] }),
    );

    // --- Outputs (values for the GitHub repository variables) ---------------------------
    new CfnOutput(this, "BackupBucket", { value: backups.bucketName });
    new CfnOutput(this, "Registry", { value: `${this.account}.dkr.ecr.${this.region}.amazonaws.com` });
    new CfnOutput(this, "DeployRoleArn", { value: deployRole.roleArn });
    new CfnOutput(this, "DeployDocumentName", { value: DEPLOY_DOCUMENT });
    new CfnOutput(this, "AlarmTopicArn", { value: topic.topicArn });
  }
}

/**
 * The parts that bill while idle and are rebuilt on every up: the EC2 host,
 * its EBS volume, the Elastic IP and the alarms on the instance. codejudge-down.sh destroys this stack (after a verified backup).
 */
export class CodeJudgeHostStack extends Stack {
  constructor(scope: Construct, id: string, props: CodeJudgeHostStackProps) {
    super(scope, id, props);
    if (!AMI_ID.test(props.hostAmi ?? "")) {
      throw new Error(`hostAmi must be a pinned AMI ID (cdk.json context "codejudge:hostAmi"), got ${JSON.stringify(props.hostAmi)}`);
    }

    const vpc = props.offline
      ? ec2.Vpc.fromVpcAttributes(this, "DefaultVpc", {
          vpcId: "vpc-00000000000000000",
          availabilityZones: ["ap-south-1a"],
          publicSubnetIds: ["subnet-00000000000000000"],
          publicSubnetRouteTableIds: ["rtb-00000000000000000"],
        })
      : ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    const backups = props.persistent.backups;

    // --- Instance role (least privilege) --------------------------------------------
    const role = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "CodeJudge host: SSM agent, own parameters, backup prefix, image pulls",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });
    const paramArn = this.formatArn({ service: "ssm", resource: "parameter", resourceName: PARAM_PREFIX.slice(1) + "*" });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadOwnParameters",
        actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"],
        resources: [paramArn, this.formatArn({ service: "ssm", resource: "parameter", resourceName: PARAM_PREFIX.slice(1, -1) })],
      }),
    );
    // SecureStrings use the AWS-managed aws/ssm key: decrypt only through SSM,
    // and only for our parameters.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DecryptOwnParameters",
        actions: ["kms:Decrypt"],
        resources: [this.formatArn({ service: "kms", resource: "key", resourceName: "*" })],
        conditions: {
          StringEquals: { "kms:ViaService": `ssm.${this.region}.amazonaws.com` },
          StringLike: { "kms:EncryptionContext:PARAMETER_ARN": paramArn },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "BackupPrefixObjects",
        actions: ["s3:PutObject", "s3:GetObject"],
        resources: [backups.arnForObjects(`${BACKUP_PREFIX}*`)],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "BackupPrefixList",
        actions: ["s3:ListBucket"],
        resources: [backups.bucketArn],
        conditions: { StringLike: { "s3:prefix": [`${BACKUP_PREFIX}*`] } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "PullOwnImages",
        actions: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"],
        resources: props.persistent.repos.map((r) => r.repositoryArn),
      }),
    );
    // GetAuthorizationToken has no resource-level permissions.
    role.addToPolicy(new iam.PolicyStatement({ sid: "RegistryLogin", actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }));
    // pg-backup.sh publishes CodeJudge/BackupSucceeded after each upload.
    // PutMetricData has no resource ARNs; the namespace condition scopes it.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "HostMetrics",
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: { StringEquals: { "cloudwatch:namespace": HOST_METRIC_NAMESPACE } },
      }),
    );

    // --- Host --------------------------------------------------------------------
    const sg = new ec2.SecurityGroup(this, "HostSg", {
      vpc,
      description: "CodeJudge host: HTTP and HTTPS only (no SSH; access via SSM)",
      allowAllOutbound: true,
    });
    for (const peer of [ec2.Peer.anyIpv4(), ec2.Peer.anyIpv6()]) {
      sg.addIngressRule(peer, ec2.Port.tcp(80), "HTTP (redirects to HTTPS, ACME)");
      sg.addIngressRule(peer, ec2.Port.tcp(443), "HTTPS");
      sg.addIngressRule(peer, ec2.Port.udp(443), "HTTP/3");
    }

    const userData = ec2.UserData.forLinux();
    // No secrets here: the bootstrap only installs software. deploy.sh fetches
    // secrets from SSM at deploy time.
    userData.addCommands(
      "set -euo pipefail",
      "install -d -m 0755 /opt/codejudge/bootstrap",
      `cat > /opt/codejudge/bootstrap/bootstrap.sh <<'CODEJUDGE_BOOTSTRAP'\n${hostScript("bootstrap.sh")}CODEJUDGE_BOOTSTRAP`,
      "chmod 0755 /opt/codejudge/bootstrap/bootstrap.sh",
      "/opt/codejudge/bootstrap/bootstrap.sh",
    );

    const host = new ec2.Instance(this, "Host", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.genericLinux({ [HOST_REGION]: props.hostAmi }),
      role,
      securityGroup: sg,
      requireImdsv2: true,
      creditSpecification: ec2.CpuCredits.UNLIMITED,
      blockDevices: [
        { deviceName: "/dev/sda1", volume: ec2.BlockDeviceVolume.ebs(20, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true, deleteOnTermination: true }) },
      ],
      userData,
      userDataCausesReplacement: false,
      detailedMonitoring: false,
    });
    // The Deploy workflow and the up/down scripts find the host by this tag,
    // and the deploy role may run commands only on instances that carry it.
    Tags.of(host).add(HOST_TAG.key, HOST_TAG.value);
    const eip = new ec2.CfnEIP(this, "Eip", { domain: "vpc", tags: [{ key: "Name", value: "codejudge" }] });
    new ec2.CfnEIPAssociation(this, "EipAssociation", { allocationId: eip.attrAllocationId, instanceId: host.instanceId });

    // --- Instance alarms (deleted with the host) ----------------------------------
    const topic = props.persistent.topic;
    const recover = new cloudwatch.Alarm(this, "SystemStatusRecover", {
      alarmDescription: "Underlying hardware failed: recover the instance onto healthy hardware (same id, EIP and volume)",
      metric: new cloudwatch.Metric({
        namespace: "AWS/EC2",
        metricName: "StatusCheckFailed_System",
        dimensionsMap: { InstanceId: host.instanceId },
        statistic: "Maximum",
        period: Duration.minutes(1),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.MISSING,
    });
    recover.addAlarmAction(new cwActions.Ec2Action(cwActions.Ec2InstanceAction.RECOVER));
    recover.addAlarmAction(new cwActions.SnsAction(topic));
    const credits = new cloudwatch.Alarm(this, "SurplusCreditsCharged", {
      alarmDescription: "Unlimited mode is being billed for surplus CPU credits (sustained load above the t3.small baseline)",
      metric: new cloudwatch.Metric({
        namespace: "AWS/EC2",
        metricName: "CPUSurplusCreditsCharged",
        dimensionsMap: { InstanceId: host.instanceId },
        statistic: "Maximum",
        period: Duration.minutes(5),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    credits.addAlarmAction(new cwActions.SnsAction(topic));

    new CfnOutput(this, "InstanceId", { value: host.instanceId });
    new CfnOutput(this, "PublicIp", { value: eip.ref, description: "the DNS A record points here while up" });
  }
}
