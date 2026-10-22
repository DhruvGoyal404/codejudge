# Maintenance

What keeps CodeJudge running, and what a person has to do. Details are in
[docs/DEPLOY.md](docs/DEPLOY.md). Commands are for PowerShell with the AWS
CLI profile `codejudge` (ap-south-1).

## Runs by itself

| What | How | Where to look |
|---|---|---|
| Deploy | Every green CI run on `main` triggers the Deploy workflow: build, push to ECR, run the `CodeJudge-Deploy` SSM document. The host smoke-tests and rolls back by itself on failure. | Actions → Deploy |
| OS security updates | `unattended-upgrades`, daily (`/etc/apt/apt.conf.d/20auto-upgrades`, set by `bootstrap.sh`). Kernel updates need a reboot, which is **not** automatic. | `/var/log/unattended-upgrades/` |
| TLS certificate | Caddy obtains and renews the Let's Encrypt certificate itself, starting about 30 days before expiry. The certificate is stored in the `caddy_data` volume, so deploys don't reissue it. | `docker logs codejudge-prod-caddy-1` |
| Database backup | `pg-backup.timer` runs at 03:30 UTC every day: `pg_dump`, checked, uploaded to S3 with its SHA-256. S3 deletes dumps after 14 days. | `journalctl -u pg-backup` |
| Disk hygiene | Docker logs are capped (`json-file`, 10 MB × 3 per container). deploy.sh keeps the last 3 releases and the images of the current and previous release. journald uses Ubuntu's default cap (10% of the disk). | `df -h /` |
| Host recovery | A failed system status check makes the CloudWatch alarm recover the instance. | CloudWatch alarms |
| Security scanning | CodeQL on every push. Secret scanning with push protection. Dependabot alerts, and Dependabot PRs for security fixes. | Security tab |

## Needs a person

| When | What |
|---|---|
| When it appears | **Dependabot security PRs:** review, let CI run, merge (merging deploys). |
| Monthly | **Reboot if a kernel update is waiting.** In a quiet hour, in a host session: `if [ -f /var/run/reboot-required ]; then sudo reboot; fi`. |
| Monthly | **Cost check:** Billing → Bills, and Free Tier usage. The "surplus CPU credits charged" alarm emails you if the t3.small bursts on paid credits. |
| Quarterly | **Test a restore:** `sudo -u codejudge bash -c 'set -a; . /etc/codejudge/backup.env; /opt/codejudge/current/app/deploy/backup/pg-restore.sh latest'` restores into a new `codejudge_restore_<ts>` database and prints its row counts next to the live ones. Then drop that database. |
| Twice a year | **AMI bump:** pick a newer Ubuntu 24.04 image and update `codejudge:hostAmi` in `infra/cdk.json`. This **replaces the host**, including the on-box Postgres, so follow docs/DEPLOY.md § 7 (backup first, then restore). |
| Before expiry | **Domain renewal** for `dhruvgoyal.tech` at the registrar. If it lapses, the site and certificate renewal both stop. |
| After 19 Dec 2026 | **One-time check that the certificate renewed** (the first one expires 19 Jan 2027): `curl -vI https://codejudge.dhruvgoyal.tech 2>&1 \| grep "expire date"` should show a date in 2027-03 or later. |
| After changing `deploy/host/deploy.sh` | Run `npx cdk deploy` with `-c alarmEmail` (the script ships inside the SSM document). The Deploy workflow warns if the host's copy is stale. |

## Commands

```powershell
# AWS login (SSO), and check who you are
aws sso login --profile codejudge
aws sts get-caller-identity --profile codejudge

# Stack outputs: InstanceId, DeployRoleArn, Registry, ...
aws cloudformation describe-stacks --stack-name CodeJudgeProd --profile codejudge --region ap-south-1 --query "Stacks[0].Outputs"

# Shell on the host (no SSH; Session Manager)
aws ssm start-session --target <InstanceId> --profile codejudge --region ap-south-1

# Deploy: push to main (CI green => Deploy), or by hand:
gh workflow run Deploy --ref main -R DhruvGoyal404/codejudge

# Infrastructure changes (from infra/). ALWAYS pass alarmEmail: without it the
# deploy removes the alarm email subscription.
npx cdk diff   --profile codejudge -c alarmEmail=<you@example.com>
npx cdk deploy --profile codejudge -c alarmEmail=<you@example.com>
```

```sh
# Rollback (in the host session): swap to the previous release; again = roll forward
sudo /opt/codejudge/bin/deploy.sh --rollback
```

An older release can be redeployed by re-running that commit's Deploy run in
Actions; its images stay in ECR (the last 10 per repository).
