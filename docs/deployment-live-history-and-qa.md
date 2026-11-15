# RISExScan V1 live-data, PostgreSQL and historical analytics deployment

## What's implemented

- RPC-derived RISE chain tip and recent block headers refreshed every ~2s while Explorer Blocks tab is visible, with Blockscout's indexed transaction feed retained separately. Indexer lag is genuine and unavoidable; don't pretend Blockscout is already at the RPC head.
- RISEx WS oracle marks, trades and L2 books; ticker L2 checksum verification against **exact 18-decimal wei strings** with snapshot/delta updates and resubscription after checksum mismatch. 100ms market price coalescing, 120ms L2 render coalescing.
- Lightweight Charts candle/indicator updates without whole-chart rebuild every new bar, with separate mark and last-execution price semantics.
- Bounded, deduplicated server-side public trade collector, hour-bucket snapshots for official OI/24h volume/funding, and indexed whale/shark/dolphin/fish/shrimp positioning changes.
- Optional PostgreSQL durability for indexed trader data, auth/collateral history cursors, recorded trades including maker/taker and exact price/size, and OI/position history snapshots.
- Real 24h mini OHLCV price traces with actual source timestamps; honest 24h percentage-change meter fallback when no history.
- Page-wide data freshness widget, backend p50/p95/error counts and browser-local TTFB/FCP/LCP/resource-request p95.
- Local, interactive Funding & Liquidation Watchlist with <5% proximity from current available mark and previously indexed liquidation levels, plus configurable absolute annualized funding thresholds.
- Curated known asset logos with original vector fallbacks for missing/unlicensed/unknown assets.

## PostgreSQL setup and Render deployment

1. Create a PostgreSQL database on a provider you choose. Neon/Supabase managed PostgreSQL are options, but **free quotas, sleeping behavior, and availability change**. Confirm the active plan terms with the provider before choosing.
2. Copy its full server-side connection string (normally `postgresql://...`, often `?sslmode=require`).
3. In Render > your RISExScan web service > Environment, add secret environment variable `DATABASE_URL` containing the connection string. Never commit credentials, and **do not** use a `VITE_` prefix: this is a server-side secret.
4. Keep `NODE_ENV=production`; deploy branch `main` after merging PR and running CI. Run `npm install --no-audit --no-fund && npm run lint && npm run build`, and start with `npm run start`.
5. No manual DDL migration is required for a new database: server initialization creates tables and indexes (using `CREATE TABLE IF NOT EXISTS`) and adds newer trade-detail columns with `ALTER TABLE IF NOT EXISTS`. This means the DB account needs DDL permissions on its own schema.
6. The service can import its previous `.risex-index-cache.json` file on first PostgreSQL startup **if that file is still present**. A fresh free-tier container probably cannot access a cache from a prior wiped instance, so it must rediscover/backfill traders.
7. Check `/api/health`, `/api/data/freshness`, `/api/analytics/history`, `/api/analytics/position-changes`, `/api/chain/live`, and `/api/monitoring/performance` after deploying. Verify `databaseConnected:true` and test whether the collector is actively receiving events.
8. Back up the DB periodically and protect its secret. A database removes process-restart data loss but not source gaps due to downtime or missed WS messages.

**Critical hosting limitation:** Render's free web plan can sleep or restart, and a dormant app cannot continually collect WebSocket events. Free static CDN/Vercel alone cannot host an always-running Node/Express trader indexer. For continuous no-gap live collection, use an **always-on server or managed ingestion service**, potentially paid. You can still host the frontend statically for free, but you must operate a continuously available backend for all indexer features.

## What "historical" actually means

| Feature | Implemented source | Coverage |
| --- | --- | --- |
| Indexed wallet list and cursor progress | RISEx leaderboard/competition/contract/Auth discovery, persisted PostgreSQL | Progressive, **not all historical traders** |
| Full individual completed trade cycles | Latest RISEx wallet fills and official realized settlements in existing profiler | **Only provable 0→0 cycles with adequate opening fills**; hard caps remain |
| Grouped realized PnL | Official wallet settlement events, grouped by market+side | Accurate for **fetched** events; not individual completed trades |
| All-time PnL account total | RISEx `summary.realized_pnl` | RISEx official total, not proof of per-position event coverage |
| Historical OI | Hourly official market REST snapshots, stored from first connected sample | Point samples; missing hours during downtime; not reconstructed history back to launch |
| Cumulative volume/fees | Deduplicated public WS trade executions stored in PostgreSQL | **Only while collector connected**, no all-time guarantee; maker+taker+liquidation fees when reported |
| Whale/retail changes | Differences between two hourly indexed position snapshots | Indexed sample, not confirmed executed trades, can change due to mark prices or sample coverage |
| Latest chain blocks | RISE RPC `eth_getBlockByNumber` | Near-real-time (~2s poll + RPC/cache), distinct from Blockscout's indexed tx view |

**To truly cover every historical trading account and closed cycle** requires a separate historical archive/indexing phase. Scan *all* deployment-to-head RISE events from canonical RISEx contracts, support chain reorg rollback, persist (blockNumber, txHash, logIndex) idempotent event IDs, reconstruct order fills and settlement funding on both sides, and reconcile per-address trade/funding/transfer histories against RISEx official totals. A Postgres table by itself does not supply those missing historical events.

The existing on-demand `/api/wallet/:id` and real-time collector can continue working while this backfill is developed. Do not label coverage as exhaustive until `indexed_start_block`, `indexed_tip_block`, event gaps and sum-to-official-account reconciliations all pass.

## Correctness and latency acceptance checks

Run `npm run lint`, `npx tsx --test src/utils/*.test.ts src/components/*.test.tsx`, `npm run build`, then production Express startup smoke in GitHub Actions.

After deployment, compare the **same market, same clock time** in RISEx and RISExScan:
- BTC, ETH, XAU mark/index/last execution; do not compare a candle close to an oracle mark as if the prices must be identical.
- Initial L2 full snapshot, at least five delta updates and several zero-size deletes; checksum must match or trigger refresh. Confirm price/quantity 18-decimal conversion and spread.
- 1m and 1H OHLCV chart, live fills and technical indicator updates; pan/zoom preserved as a candle rolls.
- RPC head and five recent RISE blocks, distinguish different Blockscout index height.
- `sqalf`, `yeff`, `tbsp` official total/realized/unrealized PnL, event coverage, and UTC calendar time windows. Reconciling all-time trade cycles requires the historical ingestion phase above.
- Multiple browser sessions on desktop/mobile and background-tab recovery. Measure cold/warm page loads, p50/p95 and WebSocket age. Error-free CI alone does **not** establish network latency parity or visual browser correctness.
- PostgreSQL restart test: newly discovered wallets and historical series should survive a redeploy without local disk, and unique WS trade IDs should not double-count.

## Operational risks

- Public trade feeds are not guaranteed replayable: if upstream disconnects, collector gaps exist. The API and UI disclose this rather than invent totals.
- The Node process and REST server share an indexer and source rate budget; large public traffic may still require independent workers, read replicas, Redis, compression and persistent job queues.
- Book checksums detect corruption but cannot eliminate external feed latency. RISEx documents orderbook updates can be throttled and occasionally skipped during chain catch-up.
- Not all symbols have verifiable public logos. Unknown symbols retain RISExScan's custom vector emblem, not arbitrary third-party lookalikes.
- Persistent store and UI are optional; a missing `DATABASE_URL` leaves live market data functioning, but no durable historical charts can be promised.

## Final correctness refinements from PR review

- Newly opened OHLCV candles start at **the first actual execution price** in their interval. Never substitute the previous bar's closing price, which fabricates OHLC when the first fill gaps from the prior bar.
- Ticker WebSocket subscriptions persist across timeframe changes; the current timeframe is applied via a mutable ref, and REST candles reconcile about every 20 seconds or immediately after a WebSocket reconnection. After a REST history repair, Lightweight Charts refreshes full OHLCV and indicator series **in place** so pan/zoom and drawings are preserved.
- The active ticker order book shows price, size, **cumulative USD depth**, bid/ask spread and 10/20/30/50 adjustable levels. RISEx update frames require a valid raw-wei CRC32; a snapshot can legitimately omit checksum. On mismatch, RISExScan re-subscribes and uses REST fallback while the book resynchronizes.
- Ticker header explicitly distinguishes the latest executed trade from the official oracle mark. Chart candles follow executions, whereas the mark is an oracle calculation; a small difference is not necessarily stream lag.
- Genuine OHLCV mini-chart requests are split into six-market batches and render incrementally rather than blocking all thirty symbols behind one slow response.
- GitHub Actions provisions a temporary PostgreSQL 16 service and verifies trader rows, persistent crawl cursor state, deduplicated trade observations, hourly OI, and fully exited indexed cohorts with real SQL queries. This checks database plumbing, **not** completeness of upstream historical records.
