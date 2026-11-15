# RISExScan zero-cost feature status and release gates — 15 November 2026

This report is based on inspected GitHub PR #6 code, previous merged PRs, GitHub Actions verification, RISEx official API documentation, and current free-tier provider terms. It is **not** a completed remote-browser comparison of the user's published site.

## Requested features — implementation audit

| Requested improvement | Implementation | Limits and activation |
| --- | --- | --- |
| Explorer live instead of behind N blocks | **Implemented in PR #6:** current RISE RPC block tip and latest recent block headers poll ~2s while Explorer Blocks is visible. | Blockscout remains asynchronous; its indexed transactions can still lag. Separate source labels make that truthful |
| Every historical trader and all 0→0 completed positions | **Not complete.** Progressively discovered traders and cursors can persist in PostgreSQL. On-demand wallet profiles reconstruct completed cycles only when opening/closing fills are present. | Cannot guarantee full account universe or every lifetime trade from public bounded history endpoints. Requires canonical from-deployment event backfill + settlement joins + reorg/gap reconciliation |
| RiseScreener-equivalent historical cumulative volume, OI and fees | **Partial, improved.** Official REST hourly OI; deduplicated WS/REST-observed trade volumes and only fees explicitly reported. | Observations start when active; missed jobs/high-throughput truncated history remain gaps. 90 observed day chart window, not lifetime. Unknown fee totals stay null |
| Curated authentic ticker logos + fallback | **Implemented:** known crypto logos and equity brand icons from curated CDN locations, existing vector marks when unavailable. | Not every token has a verified asset logo, and external CDNs can fail. Reduced-motion-aware hover added |
| Free persistent PostgreSQL | **Implementation ready in PR #6**, real Postgres 16 integration test added. Neon Free supports ₹0 plans. | Owner must create free project, set private `DATABASE_URL` in Render and GitHub Actions, then merge/redeploy. 700 MB safe budget, 1 GB provider limit |
| Independent collector when Render sleeps | **New improvement:** scheduled GitHub Actions public REST sampling every 15 minutes into Neon | Only after PR merged to main; the job is inert until Actions secret exists. Missed schedules/trade-history cap prevent gapless history |
| Data freshness indicators | **Implemented:** oracle WS, REST, wallet indexer, database status, trade collector and quota guard | Connection status does not guarantee that the exchange emitted a trade this second |
| Real 24h mini OHLCV | **Implemented:** actual RISEx hourly candles batched/cached, with 24h change meter fallback | 1h bars and cache can be minutes old; not a second-by-second micro-price stream |
| API/browser performance monitoring | **Implemented:** backend bounded p50/p95/error counters, browser-local TTFB/FCP/LCP and resource p95 | Production simultaneous-load tests and device-side waterfall still outstanding |
| Whale/smart-money positioning changes | **Implemented:** successive hourly indexed cohort snapshots including fully exited positions | Not an exchange-wide ledger; mark-price and discovery changes may affect deltas |
| Funding and <5% liquidation watchlist | **Implemented:** selected markets, displayed funding APR and indexed liquidation candidates | Local on-page watchlist; no external push alerts or guarantee of every venue liquidation |
| Streaming chart price + live order book | **Improved:** trade WS-driven OHLCV, chart/indicator in-place reconciliation, oracle mark kept separate, L2 snapshot/deltas with exact wei CRC32 checks and REST fallback | Exchange price/mark legitimately differ; full production price+depth comparison at matching timestamps still needs deployment/browser test |
| RISEx-like orderbook readability | **Improved:** spread/bps, 10/20/30/50 levels, cumulative USD depth, freshness/status warnings | Custom RISExScan visual styling, not an exact copy of RISEx's proprietary trading UI |
| Site-wide regression check | **GitHub Actions:** TypeScript, unit/integration, Vite production build, Express startup/health smoke. Manual published-site API parity workflow added. | No authenticated browser testing or exact live parity verdict until owner provides actual deployed HTTPS site URL |

## Zero-cost owner setup

Follow [the step-by-step guide](zero-cost-deployment.md). Use Neon **Free**, Render **Free** and free standard GitHub Actions on the **public** repository. Add `DATABASE_URL` as a private environment secret in both hosting and GitHub Actions. Never post it in chat or commit it.

## Release acceptance

1. Latest PR #6 GitHub Actions green, including Postgres integration and production Express smoke.
2. Deployment points to the PR's merged `main` commit, not a stale Render version.
3. `/api/data/freshness` says `databaseConnected: true`, and storage usage is below its free budget.
4. GitHub Actions **Free RISEx market history sampler** manually triggered once, then confirm scheduled executions.
5. Deployed Explorer shows the RPC block tip; Blockscout indexing is independently labeled.
6. Compare BTC/ETH/XAU **last trade, mark/index, OI, 24h volume, 1m OHLCV, and multiple live L2 deltas** against RISEx at the same time (not a stale screenshot).
7. Open indexed wallets with thousands of settlements; official wallet PnL and completed trade-cycle totals must be distinguished.
8. GitHub Actions **Live deployed-site parity audit** can be run with the actual public site URL; this is only a read-only smoke test. A true p95 concurrency/load test remains separately necessary.

**Bottom line:** This release makes the product significantly better and works within a documented ₹0 stack. It does **not** provide a proven full canonical historical trading archive or production-level latency guarantee. Those should not be represented as complete until authoritative source coverage and live benchmarks demonstrate them.
