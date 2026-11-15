import { nsToMs } from './format.ts';

/**
 * Official settlement-event summary, NOT a reconstructed 0→0 trade lifecycle.
 * This intentionally works without complete historical fills (important for
 * RISEx high-frequency accounts whose fill histories are truncated).
 */
export interface RealizedAggregationInput {
  id: string;
  marketId: string;
  marketName: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  exitPrice: number;
  openTime: string | null;
  closeTime: string;
  fillsCount: number | null;
  funding: number;
  realizedPnl: number;
}

export function aggregateRealizedByMarketSide<T extends RealizedAggregationInput>(
  events: T[]
): RealizedAggregationInput[] {
  const groups = new Map<string, RealizedAggregationInput>();
  for (const event of events) {
    const key = `${event.marketId}:${event.side}`;
    const size = Number.isFinite(event.size) && event.size > 0 ? event.size : 0;
    const pnl = Number.isFinite(event.realizedPnl) ? event.realizedPnl : 0;
    const funding = Number.isFinite(event.funding) ? event.funding : 0;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        ...event,
        id: `market-summary:${key}`,
        size,
        entryPrice: 0,
        exitPrice: 0,
        openTime: null,
        fillsCount: 1,
        funding,
        realizedPnl: pnl,
      });
    } else {
      group.size += size;
      group.funding += funding;
      group.realizedPnl += pnl;
      group.fillsCount = (group.fillsCount || 0) + 1;
      if (nsToMs(event.closeTime) > nsToMs(group.closeTime)) {
        group.closeTime = event.closeTime;
      }
    }
  }
  return [...groups.values()];
}
