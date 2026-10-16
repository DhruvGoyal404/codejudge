import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
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
/** Every SSM parameter the host may read lives under this prefix. */
export const PARAM_PREFIX = "/codejudge/prod/";
export const APP_REPOS = ["api", "web", "worker"] as const;
export const SANDBOX_REPOS = ["cpp-compile", "cpp-run", "python", "java-compile", "java-run", "node"] as const;
export const DEPLOY_DOCUMENT = "CodeJudge-Deploy";
/** Where pg-backup.sh writes (deploy.sh renders BACKUP_DEST from the bucket name). */
export const BACKUP_PREFIX = "codejudge/pg/";

export interface CodeJudgeStackProps extends StackProps {
  /**
   * Synthesise without AWS credentials (CI, tests): a placeholder stands in
   * for the default VPC, which real deploys look up. Never deploy offline.
   */
  offline?: boolean;
  /** Email for alarm notifications (optional; confirm the SNS subscription). */
  alarmEmail?: string;
  /** Set if the account already has GitHub's OIDC provider (only one per URL). */
  existingOidcProviderArn?: string;
}

/**
 * CodeJudge production: one EC2 host (Docker + gVisor, reached only through
 * SSM), its backup bucket, the image registries, and the GitHub OIDC deploy
 * role. See docs/DEPLOY.md.
 */
export class CodeJudgeStack extends Stack {
  constructor(scope: Construct, id: string, props: CodeJudgeStackProps = {}) {
    super(scope, id, props);

    const vpc = props.offline
      ? ec2.Vpc.fromVpcAttributes(this, "DefaultVpc", {
          vpcId: "vpc-00000000000000000",
          availabilityZones: ["ap-south-1a"],
          publicSubnetIds: ["subnet-00000000000000000"],
          publicSubnetRouteTableIds: ["rtb-00000000000000000"],
        })
      : ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    // --- Image registries ---------------------------------------------------------
    const repos = [...APP_REPOS, ...SANDBOX_REPOS.map((s) => `sandbox-${s}`)].map(
      (name) =>
        new ecr.Repository(this, `Repo-${name}`, {
          repositoryName: `codejudge/${name}`,
          imageScanOnPush: true,
          imageTagMutability: ecr.TagMutability.IMMUTABLE,
          encryption: ecr.RepositoryEncryption.AES_256,
          lifecycleRules: [{ description: "keep the last 10 images", maxImageCount: 10 }],
          // Images are rebuilt from git: nothing is lost when the stack goes.
          removalPolicy: RemovalPolicy.DESTROY,
          emptyOnDelete: true,
        }),
    );

    // --- Backup bucket ------------------------------------------------------------
    const backups = new s3.Bucket(this, "Backups", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ id: "expire-after-14-days", expiration: Duration.days(14), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      // Backups outlive the stack: delete the bucket by hand after the final export.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Non-secret configuration the host reads with the secrets.
    new ssm.StringParameter(this, "BackupBucketParam", {
      parameterName: `${PARAM_PREFIX}backup_bucket`,
      stringValue: backups.bucketName,
      description: "S3 bucket for the nightly database dumps (written by deploy.sh into backup.env)",
    });

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
        resources: repos.map((r) => r.repositoryArn),
      }),
    );
    // GetAuthorizationToken has no resource-level permissions.
    role.addToPolicy(new iam.PolicyStatement({ sid: "RegistryLogin", actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }));

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
      machineImage: ec2.MachineImage.fromSsmParameter("/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id", {
        os: ec2.OperatingSystemType.LINUX,
      }),
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
    const eip = new ec2.CfnEIP(this, "Eip", { domain: "vpc", tags: [{ key: "Name", value: "codejudge" }] });
    new ec2.CfnEIPAssociation(this, "EipAssociation", { allocationId: eip.attrAllocationId, instanceId: host.instanceId });

    // --- Alarms ------------------------------------------------------------------
    const topic = new sns.Topic(this, "Alarms", { displayName: "CodeJudge alarms" });
    if (props.alarmEmail) topic.addSubscription(new snsSubs.EmailSubscription(props.alarmEmail));
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
            allowedPattern: "^[A-Za-z0-9+/=]{1,4000}$",
          },
        },
        mainSteps: [
          {
            action: "aws:runShellScript",
            name: "deploy",
            inputs: {
              // The worker restart waits for in-flight submissions (up to 45 min).
              timeoutSeconds: "3600",
              runCommand: [
                "set -euo pipefail",
                "install -d -m 0755 /opt/codejudge/bin",
                `cat > /opt/codejudge/bin/deploy.sh <<'CODEJUDGE_DEPLOY'\n${deployScript}CODEJUDGE_DEPLOY`,
                "chmod 0755 /opt/codejudge/bin/deploy.sh",
                "/opt/codejudge/bin/deploy.sh '{{ Manifest }}'",
              ],
            },
          },
        ],
      },
    });

    // --- GitHub OIDC deploy role ---------------------------------------------------------
    const provider = props.existingOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, "GitHubOidc", props.existingOidcProviderArn)
      : new iam.OpenIdConnectProvider(this, "GitHubOidc", { url: "https://token.actions.githubusercontent.com", clientIds: ["sts.amazonaws.com"] });
    const deployRole = new iam.Role(this, "DeployRole", {
      roleName: "codejudge-github-deploy",
      description: `GitHub Actions in ${GITHUB_REPO} on ${GITHUB_REF}: push images, run the deploy document`,
      maxSessionDuration: Duration.hours(2),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": `repo:${GITHUB_REPO}:ref:${GITHUB_REF}`,
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
        resources: repos.map((r) => r.repositoryArn),
      }),
    );
    deployRole.addToPolicy(new iam.PolicyStatement({ sid: "RegistryLogin", actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }));
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "RunDeployDocumentOnHost",
        actions: ["ssm:SendCommand"],
        resources: [
          this.formatArn({ service: "ec2", resource: "instance", resourceName: host.instanceId }),
          this.formatArn({ service: "ssm", resource: "document", resourceName: doc.ref }),
        ],
      }),
    );
    // Reading the command's outcome has no resource-level permissions.
    deployRole.addToPolicy(
      new iam.PolicyStatement({ sid: "ReadDeployOutcome", actions: ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"], resources: ["*"] }),
    );

    // --- Outputs (values for the GitHub repository variables) ---------------------------
    new CfnOutput(this, "InstanceId", { value: host.instanceId });
    new CfnOutput(this, "PublicIp", { value: eip.ref, description: "point the DNS A record here" });
    new CfnOutput(this, "BackupBucket", { value: backups.bucketName });
    new CfnOutput(this, "Registry", { value: `${this.account}.dkr.ecr.${this.region}.amazonaws.com` });
    new CfnOutput(this, "DeployRoleArn", { value: deployRole.roleArn });
    new CfnOutput(this, "DeployDocumentName", { value: DEPLOY_DOCUMENT });
    new CfnOutput(this, "AlarmTopicArn", { value: topic.topicArn });
  }
}
