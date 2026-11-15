# RISExScan: ₹0 / $0 free-tier deployment (November 2026)

**No credit card, upgrade, or paid PostgreSQL service is required by RISExScan's code.** Free plan availability and quotas are controlled by the providers; always check their dashboards. We cannot create a Neon database, store its credential, or connect Render/GitHub Secrets without the owner's explicit setup.

## Recommended all-free components

| Purpose | Choice | What it costs | Known limitation |
|---|---|---|---|
| Existing Express + Vite RISExScan app | Render Free web service | ₹0 if within free allotments | Sleeps after 15 minutes of no inbound traffic; cold starts and ephemeral filesystem |
| Durable relational database | **Neon Free PostgreSQL** | ₹0 while within plan | 1 GB/project storage, 100 compute-unit-hours/month, 5 GB outgoing transfer/project; suspends at limits |
| Scheduling independent of Render | **GitHub Actions** on this public repository | Standard runners free | Scheduled tasks can be late/skipped; public repos auto-disable scheduled workflows after 60 days without activity |
| Public market and on-chain data | RISEx REST/WS + RISE RPC/Blockscout | Public read API | Latency, rate limits and historical endpoint caps |

Official free-plan references:
- Neon: https://neon.com/docs/introduction/pro-plan#free-plan and https://neon.com/blog/neon-free-plan-1-gb-per-project
- Render: https://render.com/docs/free
- GitHub Actions: https://docs.github.com/en/actions/concepts/billing-and-usage
- GitHub scheduled workflows: https://docs.github.com/en/actions/reference/events-that-trigger-workflows

Avoid using **Render Free PostgreSQL** as the only durable history store: Render's Free Postgres databases expire after 30 days. Neon Free scales to zero instead.

## Free setup (owner action required, no secret ever in code)

1. Visit **https://neon.com** and create a **Free** project named `risexscan`. Confirm the plan is Free ($0), and check whether it requests any payment method; do not choose paid features. Keep the project on the smallest auto-scaling settings supported by Free.
2. In the Neon dashboard choose **Connect**, copy the PostgreSQL connection string, preferably the **pooled** connection string. It starts with `postgresql://...` and normally includes `sslmode=require`. Treat it like a password.
3. In the **Render Dashboard → risexscan service → Environment** set `DATABASE_URL` to that exact secret. Also set `RISEX_DB_SOFT_LIMIT_BYTES=700000000` (700 MB). Never use a `VITE_` prefix or expose `DATABASE_URL` in browser JavaScript.
4. In **GitHub → Trecopie/RisexscanV1 → Settings → Secrets and variables → Actions → New repository secret**, add the **same** connection string as a secret named `DATABASE_URL`. There is **no need to paste it into ChatGPT**.
5. Review and merge PR #6 to `main`. Scheduled workflows run only from the **default branch**, so the schedule will not run while the PR is unmerged.
6. Check GitHub **Actions → Free RISEx market history sampler → Run workflow** once manually. After that the job is scheduled every 15 minutes (at :07, :22, :37, :52 UTC). It uses a bounded REST sample and stops automatically if the 700 MB soft trade-storage guard is reached.
7. Redeploy Render. Visit `/api/health`, `/api/data/freshness` and `/api/analytics/history` on the **actual deployed site address**. Verify `databaseConnected=true`. Never infer a site URL from the GitHub repo name.
8. Under **Overview → Historical Market Observatory**, actual OI history and deduplicated *observed* volumes/fees should appear once the database contains enough samples. The data quality banner shows missing history rather than filling gaps with fabricated values.

## 0-cost protections

- The PostgreSQL write guard stops inserting raw trades once its measured database size reaches **700 MB** (configurable through the environment variable); it never silently deletes historical data.
- No paid compute, persistent disk, add-ons, hosted logging, or billing plan is activated by repository code.
- The scheduled job caps public market discovery at **100 markets**, recent trade sampling at **250 trades per market per run**, with 4 concurrent requests and two attempts per failed call.
- Data from GitHub Actions and the live Render WebSocket collector writes into the same deduplicated `(market_id,trade_id)` primary key, avoiding duplicated trade notional.
- The site explicitly distinguishes missing fees from zero fees.
- If the Neon free plan suspends at a quota limit, market data can still load from RISEx; historical persistence will temporarily be unavailable. Disable the sampler before making large backfills if close to quota.

## What cannot be guaranteed at ₹0

**The live chart and Explorer can be near-real-time in a browser without 24/7 paid compute.** They connect to RISEx public WS / RISE RPC when a visitor is using the page.

**But a continuously complete historical archive cannot be guaranteed with free tiers, intermittent workers and bounded upstream endpoints.** Scheduled jobs may be late/skipped; a high-volume market can produce more than 250 fills between polls; public REST windows and wallet fill limits can omit earlier events. Persisting an incomplete series does not transform it into an all-time exchange record.

RISExScan's `Historical Market Observatory` presents **observed volume/fees (not all-time venue totals)** and OI snapshots. Completed trader lifecycles remain verified only where the full opening-through-close fill sequence was actually available. **Do not remove** the completeness warnings or present discovered accounts as all historical traders.

A future, truly complete historical implementation needs a canonical trade/settlement event backfill from the RISEx deployment block, reorg-safe event IDs, gap auditing and reconciliation of each trader's fills and realized PnL with official totals. Whether that can be done at $0 depends on access to archival RPC/event data and historical trade records.

## Monitoring and free-tier troubleshooting

The site-wide **Data & latency** strip includes source freshness, DB connectivity, storage size and whether the raw-trade budget guard has paused writes. GitHub's scheduled workflow logs show if a market has hit the recent-trades cap and must not be interpreted as a full archive. All scripts intentionally avoid printing secrets.

GitHub may disable scheduled workflows after 60 days without activity on a public repo. If the schedule stops, re-enable it in Actions; missing observations remain gaps. This approach improves durability and coverage but is a **best-effort** free solution, not a financial/trading-grade uptime guarantee.

Alternative: Cloudflare D1's free tier provides up to 5 GB of storage, but the current code uses PostgreSQL and would need a storage-adapter rewrite. Cloudflare's free row read/write quotas are enforced. Use Neon with the existing tested code first.
