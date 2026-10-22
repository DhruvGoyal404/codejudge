# Production runbooks (AWS, ap-south-1)

Everything lives in one stack, `CodeJudgeProd` ([infra/](../infra/)):

| What | Where |
|---|---|
| Host | one EC2 t3.small, Ubuntu 24.04, Elastic IP, no SSH: shell access is SSM Session Manager only |
| Secrets | SSM Parameter Store `/codejudge/prod/*` (SecureString), rendered at deploy time into `/etc/codejudge/*` (0640 root:codejudge) |
| Images | ECR `codejudge/{api,web,worker}` and `codejudge/sandbox-*`, tagged with the commit, deployed by digest |
| Releases on the host | `/opt/codejudge/releases/<commit>` (last 3), `/opt/codejudge/current` → the live one |
| Deploy state | `/opt/codejudge/state/current.json`, `previous.json` (the manifests, with every digest) |
| Hidden tests | `/opt/codejudge/problems-private` (read-only deploy key, pinned commit per release) |
| Backups | nightly `pg_dump` → `s3://<BackupBucket>/codejudge/pg/`, expired after 14 days |
| Alarms | SNS topic `AlarmTopicArn`: CPU surplus credits charged > 0; system status check failed (the instance is recovered automatically) |

Commands below assume an AWS CLI profile named **`codejudge`** (IAM Identity
Center / SSO) and region `ap-south-1`:

```sh
export AWS_PROFILE=codejudge AWS_REGION=ap-south-1
aws sso login
```

A shell on the host (needs the Session Manager plugin for the AWS CLI):

```sh
aws ssm start-session --target <InstanceId>
sudo -i
```

On the host, `dc` below is shorthand for the production compose project:

```sh
dc() { sudo docker compose -f /opt/codejudge/current/app/deploy/compose.prod.yaml --env-file /etc/codejudge/prod.env "$@"; }
```

---

## 1. First deploy

One time, in this order.

**1. AWS CLI SSO profile.** Create an Identity Center user with
AdministratorAccess on the account, then run `aws configure sso`: profile
name `codejudge`, region `ap-south-1`, output `json`. Check it with
`aws sts get-caller-identity --profile codejudge`.

**2. CDK bootstrap and deploy** (from `infra/`):

```sh
cd infra && npm ci
npx cdk bootstrap aws://<ACCOUNT_ID>/ap-south-1 --profile codejudge
npx cdk diff   --profile codejudge -c alarmEmail=<you@example.com>
npx cdk deploy --profile codejudge -c alarmEmail=<you@example.com>
```

`-c alarmEmail` subscribes an address to the alarms; confirm the email AWS
sends. If the account already has a GitHub OIDC provider, also pass
`-c existingOidcProviderArn=arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com`.
Note the outputs: `InstanceId`, `PublicIp`, `BackupBucket`, `Registry`,
`DeployRoleArn`.

The host bootstraps itself from user data (Docker, gVisor, swap, layout,
units). Check it: `sudo tail -n 20 /var/log/cloud-init-output.log` should end with
`bootstrap: done`.

**3. DNS.** An `A` record `<domain>` → `PublicIp`, e.g.
`codejudge.dhruvgoyal.tech  A  <PublicIp>`, TTL 300. Caddy requests the
certificate on the first deploy, so the record must resolve before then.

**4. GitHub OAuth app** (github.com → Settings → Developer settings → OAuth Apps → New):
Homepage URL `https://<domain>`, Authorization callback URL
`https://<domain>/api/auth/github/callback`. Generate a client secret.

**5. Deploy key for the hidden tests**:

```sh
ssh-keygen -t ed25519 -N "" -C codejudge-prod -f ./codejudge-prod-deploy
```

Add `codejudge-prod-deploy.pub` to `DhruvGoyal404/codejudge-problems` →
Settings → Deploy keys, **read-only**. The private half goes into SSM (next
step), then delete both local files.

**6. Parameters** (all SecureString, standard tier). The passwords must be
24+ alphanumeric characters (they end up in connection URLs):

```sh
P=/codejudge/prod
put() { aws ssm put-parameter --name "$P/$1" --type SecureString --value "$2" --overwrite >/dev/null; }
put domain               'codejudge.dhruvgoyal.tech'   # the only place the domain is set
put acme_email           '<you@example.com>'
put pg_password          "$(openssl rand -hex 24)"
put valkey_password      "$(openssl rand -hex 24)"
put github_client_id     '<OAuth app client id>'
put github_client_secret '<OAuth app client secret>'
put problems_deploy_key  "$(cat ./codejudge-prod-deploy)"
rm -f ./codejudge-prod-deploy ./codejudge-prod-deploy.pub
aws ssm get-parameters-by-path --path "$P/" --query 'Parameters[].Name'   # names only
```

`backup_bucket` (String) is created by the stack. Sessions need no secret:
session tokens are random and stored only as SHA-256 hashes.

**7. GitHub repository secrets** (`DhruvGoyal404/codejudge` → Settings →
Secrets and variables → Actions → Secrets): `AWS_DEPLOY_ROLE_ARN` =
`DeployRoleArn`, `CODEJUDGE_INSTANCE_ID` = `InstanceId`, `ECR_REGISTRY` =
`Registry`. None is a credential, but together they identify the AWS account
and the host; as secrets they are masked in every log line (run logs are public
once the repository is), and the Deploy job masks the account ID first. The `PROBLEMS_DEPLOY_KEY` secret CI already uses is reused to pin
the hidden tests' commit. No AWS keys are stored anywhere.

If a run fails at "Configure AWS credentials" with `Not authorized to perform
sts:AssumeRoleWithWebIdentity`, compare the token's `sub` claim with
`GITHUB_SUB` in `infra/lib/codejudge-stack.ts` (the role trusts exactly that
string). To read the claim, restore the one-off "OIDC claims" diagnostic
workflow from git history (`git log --all -- .github/workflows/oidc-claims.yml`)
on a branch, run it by hand, and delete it again. This repository issues immutable subjects
(`repo:DhruvGoyal404@151380878/codejudge@1418599693:ref:refs/heads/main`).

**8. Deploy.** Actions → Deploy → Run workflow (branch `main`). From now
on every green CI run on `main` deploys by itself. Check
`https://<domain>`, sign in with GitHub, submit a solution.

## 2. What a deploy does

[.github/workflows/deploy.yml](../.github/workflows/deploy.yml) builds the
nine images, pushes them tagged with the commit and sends a manifest (every
image by digest plus the hidden tests' commit) to the `CodeJudge-Deploy`
document. On the host, [deploy/host/deploy.sh](../deploy/host/deploy.sh):

1. pulls all images by digest and extracts the worker release;
2. renders `/etc/codejudge/{prod,worker,backup}.env` from SSM;
3. syncs the hidden tests to the pinned commit and checks them against the release (`judge-admin check`);
4. switches `/opt/codejudge/current`, `compose up --wait`, runs the dbmate migrations, imports the problems, restarts the worker (it finishes in-flight submissions first);
5. smoke test: Caddy redirects to HTTPS, the API is healthy, the worker is active, one real C++ submission is Accepted (and deleted);
6. on success records the manifest in `state/current.json` (the old one becomes `previous.json`); on any failure in steps 4–5 it redeploys the release in `current.json` and the workflow fails.

Output of a run: the workflow log, or
`aws ssm list-command-invocations --details --max-items 1`.

**`deploy/host/deploy.sh` ships inside the SSM document, not the release.**
A push updates the images and everything under `deploy/` in the worker image,
but the host runs the copy of deploy.sh embedded in `CodeJudge-Deploy`, which
only `cdk deploy` (in `infra/`) replaces. After changing deploy.sh, run
`cdk diff` (it should show only the document's new version) and `cdk deploy`,
both with `-c alarmEmail=<you@example.com>` (without it, the deploy removes the
alarm email subscription),
before relying on the change. deploy.sh logs its own SHA-256, and the Deploy
workflow warns ("The host ran a deploy.sh that differs …") when it isn't this
commit's.

## 3. Rollback

**Automatic.** A deploy that fails after the switch rolls back by itself
to the release that was live. The workflow fails with
`rolled back to <commit>; release <commit> was NOT deployed`.

**To the previous release by hand** (e.g. a bug found after a good deploy):

```sh
sudo /opt/codejudge/bin/deploy.sh --rollback
```

This swaps `current` and `previous`; running it again rolls forward.

**To an older commit**: re-run that commit's Deploy run in Actions ("Re-run
all jobs"). Its images are still in ECR (the last 10 per repo) and are reused
by digest.

**Migrations are not rolled back.** Every migration must work with the
previous release too (add columns and tables first, drop them in a later
release). If a migration itself must be undone, restore the database (§4).

**If the rollback fails** (`ROLLBACK FAILED`): open a session and look at
`sudo journalctl -u judge-worker -n 200`, `dc ps`,
`dc logs --tail 100`. The manifests in
`/opt/codejudge/state/` name every image digest; any of them can be
redeployed with `sudo /opt/codejudge/bin/deploy.sh "$(base64 -w0 <manifest>)"`.

## 4. Restore from S3

Dumps: `aws s3 ls s3://<BackupBucket>/codejudge/pg/`. On the host:

```sh
sudo -u codejudge bash -c 'set -a; . /etc/codejudge/backup.env; /opt/codejudge/current/app/deploy/backup/pg-restore.sh latest'
```

That restores into a **new** database `codejudge_restore_<timestamp>` and
prints row counts next to the live ones: nothing live changes. To replace
the live database:

```sh
dc stop api
sudo systemctl stop judge-worker
sudo -u codejudge bash -c 'set -a; . /etc/codejudge/backup.env; /opt/codejudge/current/app/deploy/backup/pg-restore.sh s3://<BackupBucket>/codejudge/pg/<dump> --into-live'
dc start api
sudo systemctl start judge-worker
```

It asks you to type the database name. A backup on demand:
`sudo systemctl start pg-backup.service`.

## 5. Rotating secrets

Change the parameter, then redeploy the live release so the files are
rendered again:

```sh
sudo /opt/codejudge/bin/deploy.sh "$(sudo base64 -w0 /opt/codejudge/state/current.json)"
```

(or re-run the latest Deploy workflow run). Redeploying the live release
keeps `previous.json` as it was.

| Parameter | How |
|---|---|
| `github_client_secret` | Generate a second secret in the OAuth app, `put github_client_secret`, redeploy, then delete the old secret in GitHub. |
| `github_client_id` | Only with a new OAuth app; same procedure. |
| `valkey_password` | `put valkey_password "$(openssl rand -hex 24)"`, redeploy (Valkey, the API and the worker restart with it). Queued submissions survive (AOF). |
| `pg_password` | The password also lives inside Postgres: see below. |
| `problems_deploy_key` | New key pair (§1 step 5), add the new public key to codejudge-problems, `put problems_deploy_key`, redeploy, remove the old deploy key. |
| Sessions | Nothing to rotate. To sign everyone out: `dc exec postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U codejudge -c "DELETE FROM sessions"'`. |
| AWS credentials | None exist: the host uses its instance role, GitHub uses OIDC (temporary credentials per run). |

**`pg_password`**: set the new value in SSM from your machine, then apply it
inside Postgres from the host (which reads it from SSM, so it never shows on
screen), then redeploy at once (until then new API connections fail):

```sh
# locally
aws ssm put-parameter --name /codejudge/prod/pg_password --type SecureString --overwrite --value "$(openssl rand -hex 24)"
# on the host
NEW=$(aws ssm get-parameter --region ap-south-1 --name /codejudge/prod/pg_password --with-decryption --query Parameter.Value --output text)
echo "ALTER ROLE codejudge PASSWORD '$NEW';" | dc exec -T postgres   sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U codejudge -d codejudge -v ON_ERROR_STOP=1'
unset NEW
sudo /opt/codejudge/bin/deploy.sh "$(sudo base64 -w0 /opt/codejudge/state/current.json)"
```

## 6. AWS Free plan end-of-life

The account is on the AWS Free plan: it ends when the credits run out or
the plan's time ends (Billing and Cost Management → Free plan shows both).
Before that date:

1. **Final backup**, copied off AWS:

   ```sh
   # on the host
   sudo systemctl start pg-backup.service && journalctl -u pg-backup -n 5
   # locally
   B=s3://<BackupBucket>/codejudge/pg
   latest=$(aws s3 ls "$B/" | awk '/\.dump$/ {print $4}' | sort | tail -1)
   aws s3 cp "$B/$latest" ./codejudge-final/
   ```

   Keep the dump and its SHA-256 (object metadata `sha256`:
   `aws s3api head-object --bucket <BackupBucket> --key codejudge/pg/<dump>`).
   Also export the parameter **names** (the values you can regenerate; keep
   the OAuth app).
2. **Record a demo** while it is live: landing page, problem list with
   filters, a problem with Run on custom input, an Accepted and a Wrong
   Answer submission, the submission history, the mobile view.
3. **Tear down.** From `infra/`, run `npx cdk destroy --profile codejudge`. Destroy removes everything the stack created:

   | Resource | On `cdk destroy` |
   |---|---|
   | EC2 instance and its 20 GB root volume | Terminated; the volume is deleted with it (`DeleteOnTermination`). |
   | Elastic IP and its association | Released. |
   | Launch template, security group, instance role and profile | Deleted. |
   | The 10 ECR repositories | Emptied (`EmptyOnDelete`: every image goes) and deleted. |
   | SNS topic and email subscription, both CloudWatch alarms | Deleted. |
   | SSM document `CodeJudge-Deploy`, SSM parameter `/codejudge/prod/backup_bucket` | Deleted. |
   | GitHub OIDC provider and deploy role | Deleted. This is a native `AWS::IAM::OIDCProvider`, so there is no custom-resource Lambda and no log group. |
   | **S3 backup bucket** | **Kept** (`DeletionPolicy: Retain`, on purpose: backups survive an accidental destroy). |

   The stack creates no Lambda functions, custom resources or CloudWatch log groups. A CDK assertion test enforces that, and that only the bucket is retained.

   **Delete these by hand** (after step 1 has copied the final dump off AWS):

   ```sh
   export AWS_PROFILE=codejudge AWS_REGION=ap-south-1
   # 1. The retained backup bucket (versioning is off, so --force removes everything)
   aws s3 rb s3://<BackupBucket> --force
   # 2. The SecureString parameters you created by hand (the stack never owned them)
   aws ssm delete-parameters --names /codejudge/prod/domain /codejudge/prod/acme_email \
     /codejudge/prod/pg_password /codejudge/prod/valkey_password /codejudge/prod/github_client_id \
     /codejudge/prod/github_client_secret /codejudge/prod/problems_deploy_key
   # 3. The CDK bootstrap stack, if nothing else in the account uses CDK. Its
   #    staging bucket is retained and versioned, so empty it first (console:
   #    S3 -> the bucket -> Empty), then:
   aws s3api delete-bucket --bucket cdk-hnb659fds-assets-<ACCOUNT_ID>-ap-south-1
   aws ecr delete-repository --force --repository-name cdk-hnb659fds-container-assets-<ACCOUNT_ID>-ap-south-1
   aws cloudformation delete-stack --stack-name CDKToolkit
   ```

   Outside AWS, also delete:
   - the DNS `A` record;
   - the GitHub repository variables (the Deploy workflow then skips again);
   - the deploy key on codejudge-problems;
   - the OAuth app, if it will not be reused.

   An OIDC provider passed in with `-c existingOidcProviderArn=...` was never the stack's own, so it stays.

   **Check that nothing is left** (each command should print an empty list, or only things that are not CodeJudge's):

   ```sh
   aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE DELETE_FAILED --query 'StackSummaries[].StackName'
   aws ec2 describe-instances --filters Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId'
   aws ec2 describe-addresses --query 'Addresses[].PublicIp'
   aws ec2 describe-volumes --query 'Volumes[].VolumeId'
   aws ec2 describe-snapshots --owner-ids self --query 'Snapshots[].SnapshotId'
   aws ecr describe-repositories --query 'repositories[].repositoryName'
   aws s3 ls
   aws ssm describe-parameters --query 'Parameters[].Name'
   aws logs describe-log-groups --query 'logGroups[].logGroupName'
   aws sns list-topics --query 'Topics[].TopicArn'
   ```

   A day later, Billing → Bills should show no running charges for EC2, EBS, the public IPv4 address, ECR, S3 or CloudWatch.

**Redeploying elsewhere** (any Ubuntu 24.04 VM with 2 GiB RAM and ports 80/443):

1. `sudo deploy/host/bootstrap.sh --no-aws` from a checkout.
2. Push the images to any registry you can log in to on the host (e.g.
   GHCR), and write a `release.json` as the Deploy workflow does.
3. Put the parameters in a JSON file, mode 0600, with the same names as in
   SSM (`{"domain": ..., "pg_password": ..., "problems_deploy_key": ...,
   "backup_bucket": ...}`), then
   `sudo DEPLOY_SSM_JSON=/root/params.json DEPLOY_SKIP_ECR_LOGIN=1 AWS_REGION=none deploy/host/deploy.sh "$(base64 -w0 release.json)"`
   after a `docker login` to that registry. (The CI job `host-deploy` runs
   exactly this against a local registry.)
4. Restore the final dump: `BACKUP_DEST=file:///root/codejudge-final deploy/backup/pg-restore.sh latest --into-live`.
5. Backups: point `BACKUP_DEST` in `/etc/codejudge/backup.env` at an
   S3-compatible bucket, or a `file:///` path you copy off the host.

## 7. The host's AMI, and what would replace the host

**The AMI is pinned.** `infra/cdk.json` context `codejudge:hostAmi` is the image the host was launched from: `ami-065d2b03fb493085a`. That is Canonical's Ubuntu 24.04 LTS amd64, `hvm:ebs-ssd-gp3`, serial 20261004, in ap-south-1, taken from cloud-images.ubuntu.com/locator. The stack passes it to CloudFormation as a literal `ImageId`. A CDK test fails if it ever becomes an SSM parameter resolved at deploy time; such a parameter would change with every Ubuntu release and make the next `cdk deploy` replace the host, and with it the on-box Postgres.

Before the first deploy, check once that the image is Canonical's (owner `099720109477`):

```sh
aws ec2 describe-images --image-ids ami-065d2b03fb493085a --profile codejudge --region ap-south-1 \
  --query 'Images[0].[OwnerId,Name,State]'
```

**OS updates happen on the host, not through new AMIs.**
- `bootstrap.sh` installs `unattended-upgrades` and enables the daily security run (`/etc/apt/apt.conf.d/20auto-upgrades`).
- The Docker packages are on `apt-mark hold`, so upgrades never move them.
- Kernel updates need a reboot, and unattended-upgrades does not reboot by itself. Check now and then in a quiet hour: `[ -f /var/run/reboot-required ] && sudo reboot` (SSM session). Everything comes back on its own: Docker restarts the compose services, and `judge-worker` is enabled.

**What CloudFormation would do to the instance:**

| Change | Effect |
|---|---|
| `codejudge:hostAmi`, the subnet / availability zone, the root volume's size, type or encryption, the launch template (IMDS settings) | **Replaces the instance** |
| User data (`bootstrap.sh`) | Stop and start only (`userDataCausesReplacement: false`; a test pins the instance's logical ID). User data runs only on first boot, so the change has no effect on the running host anyway: re-run `bootstrap.sh` in an SSM session instead. |
| The instance type | Stop and start only |
| The security group, the role's policies, tags, alarms | No interruption |

**Before every `cdk deploy`, read `cdk diff`.** If `CodeJudgeProd/Host` shows `[-]` / `[+]` (or "requires replacement"), stop.

**To move to a newer AMI deliberately:**
1. Take a backup (§4, `systemctl start pg-backup.service`).
2. Change the pin.
3. Deploy (a new host; the Elastic IP moves with it).
4. Run the Deploy workflow.
5. Restore the dump into the live database (§4).


## 8. Time-limit calibration on the host

Time limits are measured on the production host, in the production sandbox
(runsc, the release's images and seccomp profile), through the deploy path
only; nobody logs in to the host.

0. The calibration hook is part of deploy.sh, which ships in the SSM document
   (§2): the document must be current (`cdk deploy -c alarmEmail=…`). Otherwise the request
   is silently ignored, and the Deploy run warns that the host's deploy.sh
   is stale.
1. At a quiet time: **Actions → Deploy → Run workflow**, branch `main`, tick
   **calibrate**. The deploy runs as usual; once the release is live, deploy.sh
   starts `deploy/host/calibrate.sh` in a transient unit
   (`codejudge-calibrate`) and returns.
2. The calibration judges every private `ref.*` and `slow*.*` solution with
   `judge-run`, three passes over the catalogue, then submits 20 C++
   references each for `ledger-total` and the problem with the most test
   data through the real queue and worker (`judge-admin smoke`), measuring
   submit-to-verdict from Postgres (`finished_at - created_at`). It runs
   beside the live worker (one more sandbox at a time) and changes nothing.
   Expect one to two hours. The t3.small runs in unlimited-credit mode, so
   it isn't throttled; the surplus CPU costs a few cents.
3. Any later deploy (a push to main, or Run workflow without the tick)
   reports it: "running … judgements so far", or the summary in the job
   summary under **Time-limit calibration**, with these columns:
   - `slug`, `file`, `limit_ms` (effective, after the language multiplier);
   - `worst_cpu_ms` over all passes, `pct` of the limit, and every verdict seen;
   - latency rows: n, p50, p95 and max in ms.

   Raw results stay on the host under `/opt/codejudge/state/calibration/`.
4. Don't deploy a different problems commit while a calibration runs: the
   private checkout it reads would change under it.

The acceptance rule is that every reference uses at most 50% of its limit in
every pass, and every slow solution is TLE.
