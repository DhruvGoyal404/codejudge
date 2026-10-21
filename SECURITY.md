# Security policy

CodeJudge runs untrusted code, so security reports are very welcome.

## Reporting a vulnerability

Please report privately. **Do not open a public issue, pull request or
discussion** for a security problem.

Use GitHub's private reporting: on this repository, open the **Security** tab
and choose **Report a vulnerability**. Only the maintainer can see the report.

Useful details:

- what an attacker can do, and against what: the sandbox, the API, the web
  app, the deploy pipeline;
- steps or a proof of concept, with the language and the submission you used;
- what you expected to happen instead.

You can expect an acknowledgement within a few days. Please give a reasonable
time to fix the problem before you disclose it. Credit is given in the fix
unless you'd rather stay anonymous.

## Scope

In scope: this repository's code and the live site
(https://codejudge.dhruvgoyal.tech). For example: escaping or weakening the
judge sandbox, reading hidden tests or other users' submissions, bypassing
authentication or rate limits, XSS, CSRF.

Out of scope: denial of service by volume, social engineering, reports from
automated scanners with no demonstrated impact, and issues in third-party
services (GitHub, AWS) themselves.

Please don't test against the live site in a way that degrades it for others:
no load testing, and no programs meant to exhaust the host.

If you find a vulnerability in gVisor, Docker or another upstream component,
report it to that project.
