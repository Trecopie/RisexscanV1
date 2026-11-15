# RISExScanV1 security review before changing GitHub repository visibility
Date: 15 November 2026
Scope: `Trecopie/RisexscanV1` main and PR #6 (`feature/chain-live-history-ob-2026-11-15`).

## Decision

**Conditionally suitable for publication after PR #6 CI passes and owner reviews GitHub settings.** No live GitHub/API/Neon secret was identified in the available source and commit-diff scans, but this is **not** a guarantee that no sensitive data ever existed in a Git object, release attachment, logs, GitHub Action artifact or inaccessible history.

The repository is **still private**. This audit does not change its visibility.

## Checks completed

- Inspected the tracked-file trees on `main` and the feature branch (the PR branch currently includes about 84 tracked files, including ~82 text files and two binary favicon files).
- Scanned current text files (including `bun.lock`, source, workflows, docs, examples and scripts) for common GitHub/OpenAI/Google/AWS token formats, PostgreSQL URLs containing passwords, PEM private-key markers, `eval`/unsafe HTML patterns and process execution call sites.
- Inspected diffs from all 96 currently returned commits on `main` and the PR #6 commit history, including added/deleted file paths. Pattern hits were only:
  - `.env.example`: clearly fictional `USER:PASSWORD@HOST` PostgreSQL format.
  - `.github/workflows/verify.yml`: disposable `risexscan:local_ci_password` used by the GitHub runner's temporary local PostgreSQL test service.
  Neither is a production credential.
- `.gitignore` excludes `.env*` (except documented `.env.example`) and `.risex-index-cache.json`; neither file was found as a committed secret path in checked main history.
- Audited public Express route handling, proxy-based IP throttling, the opt-in read-only REST/WS collectors, CI workflow triggers and the new Neon schema/connection use.
- Verified PR #6's scheduled secret-bearing sampler has only `schedule` and `workflow_dispatch` triggers and `permissions: contents: read`; forked pull requests do not invoke that sampler with production `DATABASE_URL`.
- GitHub CI verification explicitly requests read-only repo token permissions, runs TypeScript, tests, production boot smoke and (added in this review) production dependency advisory audit.
- Confirmed the Neon organization subscription is Free, the existing project is reused, and no live Neon credentials are committed. Database schema and indexes were initialized directly through the authorized Neon connection.

## Improvements made in PR #6

1. Limited expensive anonymous `/api/leaderboard/diagnostic/:addressOrUsername` requests: 8 diagnostics/minute/IP, and at most 2 forced `?resync=1` requests per 10 minutes/IP. Both retain the existing global 240 requests/minute/IP limit.
2. Added numeric market-ID parameter validation (1–6 digits) before upstream URL interpolation and limited username/address parameters to 120 characters.
3. Reduced JSON body acceptance from Express's default to 32 KB, although the current public API is read-only GET routes.
4. Added `npm audit --omit=dev --audit-level=high` to CI as an advisory gate for production dependencies; review the CI result before merge.
5. Earlier in PR #6: constrained the verification workflow's GitHub token to `contents: read`.

## Remaining security considerations and manual account checks

| Area | Observation / remaining action | Risk |
| --- | --- | --- |
| Supply chain | `package.json` uses version ranges; `bun.lock` is present but `npm install` does not enforce an npm lock in current deploy. Production dependencies need ongoing advisory monitoring and reproducible dependency pinning. | Medium |
| Public API exhaustion | A process-local 240 req/minute/IP limiter and dedicated diagnostic limiter reduce but do not eliminate distributed request abuse or Render Free resource exhaustion. No CDN/WAF or durable distributed rate limit is configured. | Medium |
| Dev preview hostname | `vite.config.ts` contains `server.allowedHosts: true` and listens on `0.0.0.0` for Google AI Studio preview compatibility. It should **not be exposed as a public development server**. Production Express serves Vite's built static files, not this preview server. | Medium outside production |
| GitHub Actions secrets | Verify `DATABASE_URL` is in GitHub Actions *Secrets* only. A workflow on the default branch can access it when manually run or scheduled. Never approve unfamiliar PRs/workflow modifications blindly. | High if misconfigured |
| Neon credential | Keep `DATABASE_URL` only in Render Environment + GitHub Actions Secrets. A repository becoming public does not expose those values automatically. Avoid `VITE_DATABASE_URL` and never paste the password into chat. | High if leaked |
| Git history completeness | Pattern/diff scanning cannot inspect inaccessible Git objects, missing patches, old release binaries, private Actions artifacts, or future commits. Perform an independent full `gitleaks git` scan on a local clone and enable GitHub secret scanning / push protection. | Residual |
| Frontend XSS | No obvious `dangerouslySetInnerHTML` or direct `eval` detected in current text files. External avatar and CDN image resources remain third-party dependencies. | Low / requires browser QA |
| Response headers | MIME sniffing and strict referrer controls present. Dedicated Content Security Policy / HSTS and automated penetration testing remain open; don't add a restrictive CSP without testing Risex/TradingView/WebSocket/CDN compatibility. | Defense in depth |
| Public repo licensing | No `LICENSE` file found on main. Public code can be viewed/forked, but users shouldn't assume it is open-source licensed. | Product decision |
| Runtime & logs | Source audit alone does not inspect currently deployed Render environment variables, build artifacts, Live API rate limits or logs. Inspect those separately before a public-facing release. | Open |

## Recommended owner steps before clicking "Change visibility"

1. Merge PR #6 **after all GitHub Actions checks pass**; do not merge failing dependency audits.
2. GitHub repository **Settings → Security**: enable secret scanning, push protection and Dependabot alerts if available; run independent Git-history secret scanner (for example Gitleaks) on a full clone.
3. **Settings → Branches / Rulesets**: require pull-request review/checks for `main`; review workflow-file changes especially carefully.
4. Ensure `DATABASE_URL` is added only through **GitHub → Settings → Secrets and variables → Actions** and **Render → Environment**; never in README, screenshots, console logs or a committed `.env` file.
5. Review third-party image/logo licensing and decide whether to include a source-code LICENSE file.
6. Only then change visibility to public using the GitHub UI. Assume previous history and future commits will be accessible to anyone.

A change from private to public improves *standard GitHub-hosted Actions runner* costs but does not remove Neon quotas, upstream API rate limits or Render sleep. The 2-hour recovery sampler should be left in place until the service has measured database growth and trade-history truncation rates, even if Actions runner minutes become free.
