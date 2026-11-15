# RISExScan V1 — Data, performance and product audit (2026-11-15)

> Scope: GitHub `main` at `62cda794` plus fixes in this branch, compared against the supplied Google AI Studio request history and the public RiseScreener overview. This is a **repository/CI audit**, not an authenticated production-browser load test. It does not guarantee zero bugs.

## Requirement-by-requirement disposition

| Requirement | Finding | Notes |
|---|---|---|
| Read-only Hyperdash/Hypurrscan-like analytics | Implemented | Overview, Markets, ticker details, Wallet, Leaderboard, Cohorts, Explorer; no trading terminal |
| Crypto/RWA market categorization | Implemented, evolved | Current Markets page deliberately has one category-aware table and matching metrics; Overview has distinct Crypto/RWA summary |
| WebSocket-based price and trade updates | Implemented; correctness fixed in this PR | Shared RISEx oracle/trades/funding/orderbook feed, 250ms batched React updates, REST as price fallback and for volume/OI metadata |
| 5 EMAs, RSI, Supertrend, chart drawing toolbar | Implemented | TradingView lightweight charts, indicator editing/visibility, left-side drawing controls |
| L2 D3 liquidity heatmap | Implemented | **Visible current orderbook only**, not historical resting-liquidity heatmap |
| Colored rectangle top-volume/gainers/losers | Implemented | Existing Overview Market Dashboard: volume, gainers, losers with icon marks and filters. PR fixes sign ranking and replaces misleading synthetic microcharts |
| RISEx usernames/avatars | Implemented with fallback | Indexed profile metadata, on-demand lookups; rendered symbol marks are **original approximations**, not guaranteed licensed official logos |
| Trader profile + 24h/7d/30d/all charts/calendar | Implemented; needs independent live parity tests | UTC normalization/unit tests. Upstream market/account history may lag |
| Realized PnL: group partial settlements into fully closed trades | Partial | Verified Trades reconstruct 0→0 cycles **only when historical fills suffice**. Market PnL Summary groups official events by market+side; **not** a completed-trade ledger |
| Open position realized + unrealized PnL | Implemented with coverage flags | Missing origin fills can make partial realized totals incomplete |
| All historical wallets | **Not achieved** | Discovery/enrichment in server memory and disk cache is progressive; no persistent historical event index, and endpoint pagination limits remain |
| Leaderboard sync diagnostic | Implemented | Cross-checks cached and live metrics per wallet; completeness still limited to indexed accounts |
| Explorer live data | Partial real time | Live WS trades + oracle prices; blocks/contract txs are periodically fetched and Blockscout indexes asynchronously |
| Liquidation warning <5% | Implemented | Strict price-distance cutoff in Explorer and Cohorts. Fresh market marks; indexed position sizes/liquidation levels can lag |
| DefiLlama TVL | Implemented | RISEx protocol TVL and RISE chain TVL; **not** per-underlying RWA TVL |
| RiseScreener cumulative volume, fees, historical OI, volatility/correlation | Not equivalent yet | Requires verifiable historical snapshots, transaction fee event accounting, or documented analytics endpoints |

## Correctness issues fixed in this PR

1. **Wrong taker flow direction:** RISEx transmits `maker_side`, so taker is opposite. A maker BUY represents taker SELL; a maker SELL represents taker BUY. Unknown maker side is not assigned arbitrary sell volume. Verified against official RISEx Trades Channel documentation.
2. **Wrong mark-price source:** execution prices and L2 midpoints were being assigned to `mark_price` when no oracle frame arrived in that render batch. Oracle mark/index remain distinct; execution updates `last_price`.
3. **Rolling volume double counting:** adding individual trade notional to a REST-reported rolling 24h total can overstate volume, especially after a REST snapshot already includes the trade. Volume and high/low now remain RISEx snapshot fields.
4. **Stale REST overwriting newer oracle prices:** recent WS mark/index overlay now survives REST reconciliation with 20s expiry.
5. **Incomplete trade time metadata:** public WS Trade Channel puts block number, log index and worker timestamp in the outer message; ticker-detail and shared stream now use the same parser.
6. **Synthetic sparkline deception:** deterministic sine-wave `MiniSparkline` paths did not represent actual market history. Replaced with signed real 24h percent-change meters; real history charts remain in ticker detail.
7. **Incorrect mover names:** Top Gainers now requires `changePct > 0`, Top Losers requires `changePct < 0`. A rising asset can no longer be a 'Top Loser' when all markets are up.
8. **Inactive markets in live totals:** Markets page now excludes `active === false` by default, with an explicit `Include inactive` control.
9. **Avoidable UI work:** repeated identical oracle frames no longer replace React market arrays; hidden tabs pause shared WS subscriptions/reconnect work; Overview's slower REST bundle is refreshed every 30s, while WS price ticks remain independent.
10. **Additional grounded analytics:** display category-aware advancing/declining market breadth with actual RISEx 24h changes and explicit WS versus REST provenance.
11. **Live L2 depth:** subscribe the currently viewed ticker to RISEx's L2 WS snapshot/delta feed, not 20 unneeded global order books. Decode both price and quantity from the documented 18-decimal wei strings, including `quantity=0` level deletions. Coalesce depth UI updates to 120ms, use cached REST fallback when the ticker WS is down. **Book checksum validation and forced resync on gap/CRC mismatch remain production hardening tasks.**

## Source contracts and non-interchangeable measurements

- RISEx market mark/index price: oracle channel, 18 decimals. Its last trade/market mid are **not** interchangeable with mark.
- RISEx recent executions: trade channel, decimal prices, maker side 0=buy/1=sell; taker side opposite.
- RISEx 24h quote volume, funding, open interest and high/low: REST snapshots, typically slower than every-block price ticks.
- Open interest USD = upstream open-interest quantity × official mark price, assuming the market's OI field is denominated in underlying units.
- DefiLlama RISEx protocol TVL is **not** an attributed value of RWA collateral by underlying ticker.
- Wallet realized events, market+side aggregation and completed position cycles have three different semantics. Do not compare their counts as if interchangeable.
- Leaderboard and cohort statistics are indexed-account samples. Do not label as complete venue population until a historical backfill is persisted.

## Verification available

Run from the repository root:

```bash
npm install --no-audit --no-fund
npm run lint
npx tsx --test src/utils/*.test.ts
npm run build
```

CI runs these for pull requests. New regression tests cover maker/taker inversion, no fabricated rolling volume, oracle precedence/REST reconciliation, WS envelope metadata, unchanged tick render suppression, market breadth, positive/negative rankings, and inactive-market handling.

**Not proven by CI:** live API response parity at the same timestamp, authenticated AI Studio published-site performance, end-to-end screen sizes/browser console, quote-to-paint latency distributions, WebSocket outage/recovery under network loss, long-duration indexing and multi-user load limits. The public AI Studio URL was not accessible to the audit tools; RiseScreener text and current website source could be inspected but not a synchronized side-by-side speed benchmark.

## Before announcing production-ready: acceptance matrix

- [ ] **Overview:** compare BTC/ETH/XAU marks, official 24h change, 24h volume and OI against RISEx at the same timestamp; verify taker direction using a known maker-side trade.
- [ ] **Markets:** compare `ALL/CRYPTO/COMMODITY/STOCKS/INDEX_ETF` counts and totals with their exact visible table rows, including inactive toggle and symbol search.
- [ ] **Ticker:** inspect 1m/1H candles, a full fresh L2 snapshot, bids/asks and real trades; verify indicator toggle/drawing actions survive time-range changes.
- [ ] **Wallet (sqalf, yeff, tbsp):** compare official header PnL and live positions; distinguish Market Summary from completed trade cycles; verify funding/cashflows and UTC calendar dates.
- [ ] **Leaderboard:** compare rolling 24h PnL with fresh upstream 1D chart and event fallbacks, especially after UTC midnight; trigger Sync Diagnostic.
- [ ] **Cohorts:** confirm indexed denominator, current mark repricing, and <5% risk classification on long and short positions.
- [ ] **Explorer:** check live trade timestamps, market IDs, block tip/index lag, transaction decoder, and connection-loss recovery.
- [ ] **Performance:** compare cold/warm page load, API p50/p95, and server CPU/network with 1/10/50 concurrent visitors; test throttled 3G mobile and narrow screens.
- [ ] **Resilience:** upstream 429/5xx, WebSocket disconnect, hidden tab recovery, redeploy/cold-start loss of in-memory index and cache.
- [ ] **Data integrity:** test a price source dropping to zero, expired oracle quote, halted market, missing candles, unsigned maker-side and missing wallet settlement pages.

## Product recommendations, in order

1. **Persistent indexing**: PostgreSQL + dedicated RPC/event ingester with resume cursors, reorg handling, idempotent event IDs, and per-trader lifecycle ledger. Required for trustworthy all-time, complete-wallet and full closed-trade analytics.
2. **Data quality/freshness UI**: timestamps and clear source status for oracle, market snapshots, wallet snapshots, Blockscout, DefiLlama; a 'historical coverage incomplete' label when page limits are hit.
3. **Real mini price charts**: fetch/cache 24h OHLCV for only visible/top markets and render authentic sparklines; use current signed change meters until then.
4. **Historical time series**: store hourly total OI and daily volume/fees from verified sources before adding RiseScreener-like cumulative graphs; offer rolling 24h volatility and correlations computed from synchronized OHLCV.
5. **Fast first paint**: pre-render/cache a small public overview JSON at the edge, split heavy account history from lightweight wallet peek, and benchmark chart rendering before further decoration.
6. **Confidence-tagged wallets**: show completeness percentage, enriched-at timestamps and coverage counts. Keep indexed-cohort metrics clearly labeled.
7. **Unique differentiators**: cross-market whale positioning divergence, funding/mark dislocations, realized vs unrealized PnL reconciliation timeline, and funding-carry alerts — all with explicit sources.

References:
- https://developer.rise.trade/reference/trades-channel
- https://developer.rise.trade/reference/oracle-channel
- https://developer.rise.trade/reference/general-information
- https://risescreener.com/overview
- https://api.llama.fi/protocol/risex
