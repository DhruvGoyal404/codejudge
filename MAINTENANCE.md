# Maintenance

What keeps CodeJudge running, and what a person has to do. Details are in
[docs/DEPLOY.md](docs/DEPLOY.md). Commands are for PowerShell with the AWS
CLI profile `codejudge` (ap-south-1).

## Up and down

The site runs only when needed (before an interview, a demo). Normally it is
**down**, and nothing bills.

| | Command | Measured (2026-10-30) |
|---|---|---|
| Bring it up | `./codejudge-up.sh` | 19 min 3 s from fully down (10 min 48 s of it is the Deploy workflow rebuilding the images) |
| Take it down | `./codejudge-down.sh` | 7 min (about 3.5 min of it is the audit) |

Both are for Git Bash on Windows (or Linux), with the AWS CLI (profile
`codejudge`; an expired SSO session opens the browser), `gh` (logged in),
`jq`, Node (for the CDK) and `git`. Both are safe to run again after a
failed run: every step checks first.

**What `codejudge-down.sh` does**
1. On the host: a fresh database backup, then a **restore drill** from it
   (restore into a new database; every table's row count must equal the live
   one; the copy is dropped), then a backup of Caddy's data (certificates and
   the ACME account). Any failure stops here: nothing is removed.
2. Copies both into `s3://<bucket>/codejudge/final/` (checksums verified),
   with the row counts beside the dump. That prefix never expires (only the
   nightly `codejudge/pg/` does, after 14 days); the newest 5 are kept.
3. Disables the `BackupMissing` alarm's actions (the budget alert stays) and
   points `codejudge.dhruvgoyal.tech` at 192.0.2.1 (never routable), so the
   name never follows a released IP.
4. Destroys the `CodeJudgeHost` stack: EC2, its EBS volume, the Elastic IP,
   the security group, the instance role and all ECR registries.
5. Audits everything that can bill (EC2, EBS volumes and snapshots, Elastic
   IPs, public IPv4, NAT, load balancers, ECR, S3, Secrets Manager, KMS,
   CloudWatch alarms and logs, and instances/IPs/volumes in every other
   region). Anything left prints **STILL BILLING** and exits 1.

**What `codejudge-up.sh` does**
1. Deploys `CodeJudgeHost` (and keeps `CodeJudgeProd` current).
2. Waits for the host's bootstrap.
3. Restores Caddy's data **before Caddy first starts**: the existing
   certificate is reused (Let's Encrypt allows only 5 duplicate certificates
   a week).
4. Runs the GitHub **Deploy** workflow: it builds every image in GitHub
   Actions, pushes them to the new registries, and deploys by digest through
   the `CodeJudge-Deploy` document. The deploy role reaches the new host by
   its tag (`codejudge:host=prod`).
5. Restores the newest backup into the live database, then migrates and
   re-imports the problems. The users, submissions and test-result counts
   must equal the counts recorded at the final backup. Only then does DNS
   move to the new IP: no request reaches an empty app. Then a fresh backup,
   and the `BackupMissing` alarm's actions back on.
6. Checks: health on the IP with the domain's certificate, health on the
   domain (DNS, valid certificate), GitHub OAuth (only a registered app's
   authorize page names the app), the hidden-tests deploy key (`git
   ls-remote`), S3, ECR, and a real submission that must be Accepted.
   It ends with a box: URL, a hosts-file fallback line, cost per hour.

While down, the Deploy workflow (after every push to `main`) fails at once
with "site is down, run codejudge-up.sh first".

**Cost** (ap-south-1 on-demand, from the AWS Pricing API; account billed in USD)

| State | Cost |
|---|---|
| Up, per hour | ~$0.030 (~Rs 2.6): t3.small $0.0224 + 20 GB gp3 $0.0025 + public IPv4 $0.005 |
| Up for a month (down forgotten) | ~$22 (~Rs 1,950), plus ECR storage as images pile up |
| Down, per month | ~$0: about 1.5 MB of S3 backups (<$0.001), SSM parameters (free), one alarm and one budget (free) |

The `codejudge-monthly` budget emails you at 50/80/100% of $5.70 (about
Rs 500) and when the forecast passes it. **It is an alert, not a cap.**

**Setup it needs (already done)**: SSM parameters `/codejudge/ops/cloudflare-token`
(SecureString: a Cloudflare token with Zone:Read and DNS:Edit on
dhruvgoyal.tech), `/codejudge/ops/alarm_email` and `/codejudge/ops/budget_email`.
To replace the token, in Git Bash:
`read -rsp "Cloudflare token: " t && echo && MSYS_NO_PATHCONV=1 aws ssm put-parameter --profile codejudge --region ap-south-1 --name /codejudge/ops/cloudflare-token --type SecureString --value "$t" --overwrite >/dev/null && unset t && echo stored`

## Runs by itself (while up)

| What | How | Where to look |
|---|---|---|
| Deploy | Every green CI run on `main` triggers the Deploy workflow (it fails fast while down): build, push to ECR, run the `CodeJudge-Deploy` SSM document. The host smoke-tests and rolls back by itself on failure. | Actions → Deploy |
| OS security updates | `unattended-upgrades`, daily (`/etc/apt/apt.conf.d/20auto-upgrades`, set by `bootstrap.sh`). Kernel updates need a reboot, which is **not** automatic. | `/var/log/unattended-upgrades/` |
| TLS certificate | Caddy obtains and renews the Let's Encrypt certificate itself, starting about 30 days before expiry. The certificate is stored in the `caddy_data` volume, so deploys don't reissue it. | `docker logs codejudge-prod-caddy-1` |
| Database backup | `pg-backup.timer` runs at 03:30 UTC every day: `pg_dump`, checked, uploaded to S3 with its SHA-256, then `CodeJudge/BackupSucceeded=1` is published. S3 deletes dumps after 14 days. The `BackupMissing` alarm emails you if no backup succeeds for 26 hours. | `sudo journalctl -u pg-backup`, `systemctl list-timers pg-backup.timer` |
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
| Quarterly | Last restore test: 2026-10-23, passed; next due Jan 2027. |
| Twice a year | **AMI bump:** pick a newer Ubuntu 24.04 image and update `codejudge:hostAmi` in `infra/cdk.json`. This **replaces the host**, including the on-box Postgres, so follow docs/DEPLOY.md § 7 (backup first, then restore). |
| Before expiry | **Domain renewal** for `dhruvgoyal.tech` at the registrar. If it lapses, the site and certificate renewal both stop. |
| After 19 Dec 2026 | **One-time check that the certificate renewed** (the first one expires 19 Jan 2027): `curl -vI https://codejudge.dhruvgoyal.tech 2>&1 \| grep "expire date"` should show a date in 2027-03 or later. |
| Within 3 days of a `cdk deploy` that creates or recreates the alarm subscription | **Confirm the alarm email.** Click the link in the message from no-reply@sns.amazonaws.com; AWS deletes subscriptions left unconfirmed for 3 days, and until then no alarm reaches you. Then check that the subscription shows an ARN, not `PendingConfirmation`: `aws sns list-subscriptions --profile codejudge --region ap-south-1 --query "Subscriptions[?Protocol=='email'].[Endpoint,SubscriptionArn]" --output table` |
| After changing `deploy/host/deploy.sh` | Run `npx cdk deploy` with `-c alarmEmail` (the script ships inside the SSM document). The Deploy workflow warns if the host's copy is stale. |

## Incident notes: going to up/down (2026-10-30)

- The first `codejudge-down.sh` was also the migration: it turned the old
  all-in-one `CodeJudgeProd` stack into the persistent stack, removing the
  original host only after its backup and restore drill had passed.
- The first up stopped at step 4 (native `git` could not use a Git Bash path
  with `MSYS_NO_PATHCONV` set) with DNS still parked. A rerun of the same
  script continued from where it stopped.
- Up's checks first failed on the scripts themselves, not the site: native
  `curl` cannot write `-o /dev/null` under `MSYS_NO_PATHCONV` (exit 23), and
  `curl | grep -q` broke curl under `pipefail`. A rerun also restored the
  newest dump (one taken by that same up) over the live data. Now a host that
  has been restored is never restored again, and it keeps the counts it was
  checked against.
- The full cycle then passed: down (7 min 20 s), up (19 min 3 s, every check
  ok, counts equal to the final backup: users 4, submissions 11,
  submission_tests 395), down (7 min, audit clean). The site was left down.

## Incident: no backups until 2026-10-22

Production ran from 2026-10-20 to 2026-10-22 without a single database backup.
`install-units.sh` enabled `pg-backup.timer` with `systemctl enable` but never
started it (`enable` only starts a timer at the next boot, and the host had not
rebooted), and it discarded the command's output. CI only checked that the timer
was *enabled*. It was found during a pre-close maintenance check: the S3 bucket
was empty and `systemctl list-timers` showed no next run. The fix:
- `install-units.sh` now runs `enable --now` for every timer and fails the deploy
  unless each one is active; the deploy smoke test also checks
  `pg-backup.timer`.
- CI requires every timer to be active after bootstrap and after every deploy,
  and runs `pg-backup.service` under systemd.
- Each backup publishes `CodeJudge/BackupSucceeded`, and the `BackupMissing`
  alarm fires after 26 hours without one.

The first production backup was taken on 2026-10-22 (`codejudge-20261022T215328Z.dump`).

## Restore test, 2026-10-23: passed

The 2026-10-22 production dump (54,510 bytes) was restored with
`deploy/backup/pg-restore.sh` into a throwaway local container: production's
`postgres:18.6-alpine` digest, no network. Checks:
- SHA-256 matched the value recorded in S3.
- All 7 tables were present.
- `schema_migrations` was at the latest migration (`20261017000001`, 9 rows).
- Row counts equalled production's at dump time: users 4, submissions 11,
  submission_tests 395, problems 100. Also present: sessions 5,
  problem_samples 200, and no orphaned test results.

The container, its volume and the dump were deleted afterwards.

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
