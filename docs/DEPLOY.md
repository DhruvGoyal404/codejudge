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
`judge.dhruvgoyal.tech  A  <PublicIp>`, TTL 300. Caddy requests the
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
put domain               '<domain>'
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

**7. GitHub repository variables** (`DhruvGoyal404/codejudge` → Settings →
Secrets and variables → Actions → Variables): `AWS_DEPLOY_ROLE_ARN` =
`DeployRoleArn`, `CODEJUDGE_INSTANCE_ID` = `InstanceId`, `ECR_REGISTRY` =
`Registry`. The `PROBLEMS_DEPLOY_KEY` secret CI already uses is reused to pin
the hidden tests' commit. No AWS keys are stored anywhere.

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
3. **Tear down**: `npx cdk destroy --profile codejudge` from `infra/`. The
   ECR repositories are emptied and deleted; the backup bucket is retained on
   purpose: empty and delete it after step 1
   (`aws s3 rb s3://<BackupBucket> --force`). Delete the SSM parameters
   (`aws ssm delete-parameters --names ...`), the DNS record, and the GitHub
   repository variables (the Deploy workflow then skips again).

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
