import type { IndexedPositionRow, MarketTrade, RisexMarket } from '../types/risex.ts';
import { nsToMs } from './format.ts';
import { LIQUIDATION_ALERT_PCT, liquidationDistancePct } from './liquidationRisk.ts';

export type ExplorerRiskCandidate = IndexedPositionRow & { distancePct: number };

/** Live market oracle marks are preferred to indexed wallet mark snapshots. */
export function deriveLiveLiquidationRisk(
  candidates: ExplorerRiskCandidate[],
  markets: Pick<RisexMarket, 'market_id' | 'mark_price' | 'last_price'>[],
  limit = 100
): ExplorerRiskCandidate[] {
  const marks = new Map<string, number>();
  for (const market of markets) {
    const mark = Number(market.mark_price || market.last_price);
    if (mark > 0 && Number.isFinite(mark)) marks.set(String(market.market_id), mark);
  }
  const rows: ExplorerRiskCandidate[] = [];
  for (const candidate of candidates) {
    const markPrice = marks.get(String(candidate.marketId)) || candidate.markPrice;
    const distancePct = liquidationDistancePct(markPrice, candidate.liquidationPrice);
    if (distancePct === null || distancePct >= LIQUIDATION_ALERT_PCT) continue;
    rows.push({ ...candidate, markPrice, distancePct });
  }
  return rows.sort((a, b) => a.distancePct - b.distancePct).slice(0, limit);
}

/** Add the shared WS trade feed to REST bootstrap, without duplicates or polling-only updates. */
export function mergeExplorerTradeTape(socketTrades: MarketTrade[], restTrades: MarketTrade[], limit = 80): MarketTrade[] {
  const unique = new Map<string, MarketTrade>();
  for (const trade of [...socketTrades, ...restTrades]) {
    const id = `${trade.market_id || 'unknown'}:${trade.id || `${trade.time}:${trade.price}:${trade.size}:${trade.log_index}`}`;
    if (!unique.has(id)) unique.set(id, trade);
  }
  return [...unique.values()]
    .sort((a, b) => nsToMs(b.time) - nsToMs(a.time))
    .slice(0, limit);
}
