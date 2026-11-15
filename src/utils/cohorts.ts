import type {
  CohortPositionRow,
  CohortSummaryRow,
  CohortTierId,
  CohortsAnalyticsResponse,
  IndexedPositionRow,
  MarketCohortRow,
  PerformanceCohortRow,
} from '../types/risex.ts';
import { safeNum } from './tradeLifecycle.ts';
import { LIQUIDATION_ALERT_PCT, liquidationDistancePct } from './liquidationRisk.ts';

export interface CohortTraderInput {
  address: string;
  username?: string | null;
  avatarUrl?: string | null;
  accountValue: number;
  totalNotional: number;
  accountLeverage: number;
  unrealizedPnl: number;
  totalPnlAll: number;
  portfolioEnriched: boolean;
  positions: IndexedPositionRow[];
}

export interface CohortMarketInput {
  market_id: string | number;
  base_asset_symbol?: string;
  display_name?: string;
  mark_price?: string | number;
  last_price?: string | number;
  quote_volume_24h?: string | number;
  open_interest?: string | number;
  current_funding_rate?: string | number;
  funding_rate_8h?: string | number;
  active?: boolean;
}

export const COHORT_DEFINITIONS: {
  id: CohortTierId;
  label: string;
  thresholdDesc: string;
}[] = [
  { id: 'whale', label: 'Whales', thresholdDesc: '$100K+ Equity or $500K+ OI' },
  { id: 'shark', label: 'Sharks', thresholdDesc: '$25K – $100K Equity' },
  { id: 'dolphin', label: 'Dolphins', thresholdDesc: '$5K – $25K Equity' },
  { id: 'fish', label: 'Fish', thresholdDesc: '$1K – $5K Equity' },
  { id: 'shrimp', label: 'Shrimp', thresholdDesc: '<$1K Equity' },
];

export function classifyTraderCohort(accountValue: number, totalNotional: number): CohortTierId {
  if (accountValue >= 100_000 || totalNotional >= 500_000) return 'whale';
  if (accountValue >= 25_000) return 'shark';
  if (accountValue >= 5_000) return 'dolphin';
  if (accountValue >= 1_000) return 'fish';
  return 'shrimp';
}

export function getCohortLabel(tier: CohortTierId): string {
  return COHORT_DEFINITIONS.find((d) => d.id === tier)?.label || 'Shrimp';
}

function calcBiasPct(longNotional: number, shortNotional: number): number {
  const total = longNotional + shortNotional;
  if (total <= 0) return 0;
  return ((longNotional - shortNotional) / total) * 100;
}

function getBiasLabel(biasPct: number): 'NET LONG' | 'NET SHORT' | 'NEUTRAL' {
  if (biasPct >= 10) return 'NET LONG';
  if (biasPct <= -10) return 'NET SHORT';
  return 'NEUTRAL';
}

export function buildCohortsAnalytics(
  traders: CohortTraderInput[],
  markets: CohortMarketInput[],
  nowMs = Date.now()
): CohortsAnalyticsResponse {
  const enriched = traders.filter((t) => t.portfolioEnriched);

  const sizeBuckets = new Map<
    CohortTierId,
    {
      tradersCount: number;
      activeTradersCount: number;
      totalEquity: number;
      longNotional: number;
      shortNotional: number;
      weightedLevSum: number;
      equityWithPosSum: number;
      netUnrealizedPnl: number;
      netTotalPnl: number;
      profitableCount: number;
    }
  >();
  for (const def of COHORT_DEFINITIONS) {
    sizeBuckets.set(def.id, {
      tradersCount: 0,
      activeTradersCount: 0,
      totalEquity: 0,
      longNotional: 0,
      shortNotional: 0,
      weightedLevSum: 0,
      equityWithPosSum: 0,
      netUnrealizedPnl: 0,
      netTotalPnl: 0,
      profitableCount: 0,
    });
  }

  const perfDefs: { id: PerformanceCohortRow['id']; label: string; ruleDesc: string }[] = [
    { id: 'top-winners', label: 'Smart Money', ruleDesc: 'Total PnL >= +$10K' },
    { id: 'profitable', label: 'Profitable', ruleDesc: '$0 < Total PnL < +$10K' },
    { id: 'flat', label: 'Flat / Inactive', ruleDesc: '-$100 <= Total PnL <= $0' },
    { id: 'underwater', label: 'Underwater', ruleDesc: 'Total PnL < -$100' },
  ];
  const perfBuckets = new Map<
    PerformanceCohortRow['id'],
    {
      tradersCount: number;
      activeTradersCount: number;
      totalEquity: number;
      longNotional: number;
      shortNotional: number;
      weightedLevSum: number;
      equityWithPosSum: number;
      netUnrealizedPnl: number;
    }
  >();
  for (const def of perfDefs) {
    perfBuckets.set(def.id, {
      tradersCount: 0,
      activeTradersCount: 0,
      totalEquity: 0,
      longNotional: 0,
      shortNotional: 0,
      weightedLevSum: 0,
      equityWithPosSum: 0,
      netUnrealizedPnl: 0,
    });
  }

  const marketAccum = new Map<
    string,
    {
      longNotional: number;
      shortNotional: number;
      whaleLong: number;
      whaleShort: number;
      dolphinLong: number;
      dolphinShort: number;
      retailLong: number;
      retailShort: number;
      positionsCount: number;
    }
  >();

  const liveMarks = new Map<string, number>();
  for (const m of markets) {
    const mark = safeNum(m.mark_price || m.last_price);
    if (mark > 0) liveMarks.set(String(m.market_id), mark);
  }
  const allCohortPositions: CohortPositionRow[] = [];
  let activeTradersWithPositions = 0;
  let totalIndexedEquity = 0;
  let totalIndexedNotional = 0;
  let totalLongNotional = 0;
  let totalShortNotional = 0;

  for (const t of enriched) {
    const isMeaningful =
      t.accountValue > 0 || t.totalNotional > 0 || t.positions.length > 0 || Math.abs(t.totalPnlAll) > 0;
    if (!isMeaningful) continue;

    const tier = classifyTraderCohort(t.accountValue, t.totalNotional);
    const sb = sizeBuckets.get(tier)!;

    const perfId: PerformanceCohortRow['id'] =
      t.totalPnlAll >= 10_000
        ? 'top-winners'
        : t.totalPnlAll > 0
          ? 'profitable'
          : t.totalPnlAll >= -100
            ? 'flat'
            : 'underwater';
    const pb = perfBuckets.get(perfId)!;

    let traderLong = 0;
    let traderShort = 0;
    for (const p of t.positions) {
      const notl = safeNum(p.notionalUsd);
      if (notl <= 0) continue;
      if (p.side === 'LONG') traderLong += notl;
      else traderShort += notl;

      const mId = String(p.marketId);
      let ma = marketAccum.get(mId);
      if (!ma) {
        ma = {
          longNotional: 0,
          shortNotional: 0,
          whaleLong: 0,
          whaleShort: 0,
          dolphinLong: 0,
          dolphinShort: 0,
          retailLong: 0,
          retailShort: 0,
          positionsCount: 0,
        };
        marketAccum.set(mId, ma);
      }
      ma.positionsCount += 1;
      if (p.side === 'LONG') {
        ma.longNotional += notl;
        if (tier === 'whale' || tier === 'shark') ma.whaleLong += notl;
        else if (tier === 'dolphin') ma.dolphinLong += notl;
        else ma.retailLong += notl;
      } else {
        ma.shortNotional += notl;
        if (tier === 'whale' || tier === 'shark') ma.whaleShort += notl;
        else if (tier === 'dolphin') ma.dolphinShort += notl;
        else ma.retailShort += notl;
      }

      const liveMarkPrice = liveMarks.get(p.marketId) || p.markPrice;
      const distLiq = liquidationDistancePct(liveMarkPrice, p.liquidationPrice);

      allCohortPositions.push({
        ...p,
        markPrice: liveMarkPrice,
        username: p.username ?? t.username ?? null,
        avatarUrl: p.avatarUrl ?? t.avatarUrl ?? null,
        portfolioValue: t.accountValue,
        accountLeverage: t.accountLeverage,
        cohort: tier,
        cohortLabel: getCohortLabel(tier),
        distanceToLiqPct: distLiq,
      });
    }

    const traderNotl = traderLong + traderShort;
    const hasOpen = t.positions.length > 0 && traderNotl > 0;
    if (hasOpen) activeTradersWithPositions += 1;

    totalIndexedEquity += Math.max(0, t.accountValue);
    totalIndexedNotional += traderNotl;
    totalLongNotional += traderLong;
    totalShortNotional += traderShort;

    sb.tradersCount += 1;
    sb.totalEquity += Math.max(0, t.accountValue);
    sb.longNotional += traderLong;
    sb.shortNotional += traderShort;
    sb.netUnrealizedPnl += t.unrealizedPnl;
    sb.netTotalPnl += t.totalPnlAll;
    if (t.totalPnlAll > 0) sb.profitableCount += 1;
    if (hasOpen) {
      sb.activeTradersCount += 1;
      const weight = Math.max(1, t.accountValue);
      sb.weightedLevSum += t.accountLeverage * weight;
      sb.equityWithPosSum += weight;
    }

    pb.tradersCount += 1;
    pb.totalEquity += Math.max(0, t.accountValue);
    pb.longNotional += traderLong;
    pb.shortNotional += traderShort;
    pb.netUnrealizedPnl += t.unrealizedPnl;
    if (hasOpen) {
      pb.activeTradersCount += 1;
      const weight = Math.max(1, t.accountValue);
      pb.weightedLevSum += t.accountLeverage * weight;
      pb.equityWithPosSum += weight;
    }
  }

  const sizeCohorts: CohortSummaryRow[] = COHORT_DEFINITIONS.map((def) => {
    const b = sizeBuckets.get(def.id)!;
    const totalNotl = b.longNotional + b.shortNotional;
    const biasPct = calcBiasPct(b.longNotional, b.shortNotional);
    return {
      id: def.id,
      label: def.label,
      thresholdDesc: def.thresholdDesc,
      tradersCount: b.tradersCount,
      activeTradersCount: b.activeTradersCount,
      totalEquity: b.totalEquity,
      totalNotional: totalNotl,
      longNotional: b.longNotional,
      shortNotional: b.shortNotional,
      biasPct,
      biasLabel: getBiasLabel(biasPct),
      avgLeverage: b.equityWithPosSum > 0 ? b.weightedLevSum / b.equityWithPosSum : 0,
      netUnrealizedPnl: b.netUnrealizedPnl,
      netTotalPnl: b.netTotalPnl,
      pctInProfit: b.tradersCount > 0 ? (b.profitableCount / b.tradersCount) * 100 : 0,
    };
  });

  const performanceCohorts: PerformanceCohortRow[] = perfDefs.map((def) => {
    const b = perfBuckets.get(def.id)!;
    return {
      id: def.id,
      label: def.label,
      ruleDesc: def.ruleDesc,
      tradersCount: b.tradersCount,
      activeTradersCount: b.activeTradersCount,
      totalEquity: b.totalEquity,
      longNotional: b.longNotional,
      shortNotional: b.shortNotional,
      biasPct: calcBiasPct(b.longNotional, b.shortNotional),
      avgLeverage: b.equityWithPosSum > 0 ? b.weightedLevSum / b.equityWithPosSum : 0,
      netUnrealizedPnl: b.netUnrealizedPnl,
    };
  });

  let totalMarketOiUsd = 0;
  let totalMarketVolume24h = 0;

  const marketCohorts: MarketCohortRow[] = (markets || [])
    .filter((m) => m.active !== false)
    .map((m) => {
      const mId = String(m.market_id);
      const mark = safeNum(m.mark_price || m.last_price);
      const oiUsd = safeNum(m.open_interest) * mark;
      const vol24 = safeNum(m.quote_volume_24h);
      totalMarketOiUsd += oiUsd;
      totalMarketVolume24h += vol24;

      const rate1h = safeNum(m.current_funding_rate);
      const fundingRate1hPct = rate1h * 100;
      const fundingAprPct = rate1h * 24 * 365 * 100;

      const ma = marketAccum.get(mId);
      const longNotl = ma?.longNotional || 0;
      const shortNotl = ma?.shortNotional || 0;
      const whaleLong = ma?.whaleLong || 0;
      const whaleShort = ma?.whaleShort || 0;
      const whaleBiasPct = calcBiasPct(whaleLong, whaleShort);
      const dolphinBiasPct = calcBiasPct(ma?.dolphinLong || 0, ma?.dolphinShort || 0);
      const retailLong = ma?.retailLong || 0;
      const retailShort = ma?.retailShort || 0;
      const retailBiasPct = calcBiasPct(retailLong, retailShort);

      return {
        marketId: mId,
        symbol: m.base_asset_symbol || m.display_name || mId,
        displayName: m.display_name || `${m.base_asset_symbol || mId}/USDC`,
        markPrice: mark,
        volume24h: vol24,
        openInterestUsd: oiUsd,
        fundingRate1hPct,
        fundingAprPct,
        totalIndexedNotional: longNotl + shortNotl,
        overallBiasPct: calcBiasPct(longNotl, shortNotl),
        whaleLong,
        whaleShort,
        whaleBiasPct,
        dolphinBiasPct,
        retailLong,
        retailShort,
        retailBiasPct,
        divergencePct: whaleBiasPct - retailBiasPct,
        positionsCount: ma?.positionsCount || 0,
      };
    })
    .sort((a, b) => b.openInterestUsd - a.openInterestUsd);

  const topPositions = [...allCohortPositions]
    .sort((a, b) => b.notionalUsd - a.notionalUsd)
    .slice(0, 120);

  const liquidationRadar = [...allCohortPositions]
    .filter((p) => p.distanceToLiqPct !== null && p.distanceToLiqPct < LIQUIDATION_ALERT_PCT)
    .sort((a, b) => (a.distanceToLiqPct ?? 999) - (b.distanceToLiqPct ?? 999))
    .slice(0, 60);

  return {
    summary: {
      enrichedTraders: sizeCohorts.reduce((s, c) => s + c.tradersCount, 0),
      activeTradersWithPositions,
      totalIndexedEquity,
      totalIndexedNotional,
      totalLongNotional,
      totalShortNotional,
      globalBiasPct: calcBiasPct(totalLongNotional, totalShortNotional),
      totalMarketOiUsd,
      totalMarketVolume24h,
    },
    sizeCohorts,
    performanceCohorts,
    marketCohorts,
    topPositions,
    liquidationRadar,
    updatedAt: nowMs,
  };
}
