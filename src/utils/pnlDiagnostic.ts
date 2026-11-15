import { nsToMs } from './format.ts';
import { computeRolling24hPnl, normalizeCalendarAndPeriodMetrics } from './portfolioCurves.ts';
import { safeNum } from './tradeLifecycle.ts';

export type SyncDiagnosticStatus =
  | 'SYNCED'
  | 'STALE_SNAPSHOT'
  | 'POST_HOUR_ACTIVITY'
  | 'UNENRICHED'
  | 'NOT_IN_INDEX';

export interface DiagnosticSnapshotSummary {
  inIndex: boolean;
  portfolioEnriched: boolean;
  address: string;
  username: string | null;
  lastUpdatedMs: number;
  snapshotAgeSec: number | null;
  sources: string[];
  pnl24h: number | null;
  pnl7d: number | null;
  pnl30d: number | null;
  realizedPnlAll: number;
  unrealizedPnl: number;
  totalPnlAll: number;
  accountValue: number;
  openPositionsCount: number;
}

export interface DiagnosticLiveSummary {
  accountValue: number;
  realizedPnlAll: number;
  unrealizedPnl: number;
  totalPnlAll: number;
  openPositionsCount: number;
  chart1DPnl24h: number | null;
  chart1DPointsCount: number;
  chart1DFirstTsMs: number | null;
  chart1DLastTsMs: number | null;
  events24hRealizedPnl: number;
  events24hFundingPnl: number;
  events24hNetPnl: number;
  events24hCount: number;
  realizedStreamTruncated: boolean;
  postHourFillsCount: number;
  postHourFillsNetPnl: number;
  calendarTodayPnl: number | null;
  calendar7dPnl: number;
  calendar30dPnl: number;
  recommended24hPnl: number;
}

export interface DiagnosticDriftMetrics {
  drift24hVsRecommended: number | null;
  drift24hVsEventLog: number | null;
  drift7dVsLive: number | null;
  drift30dVsLive: number | null;
  driftTotalAllVsLive: number | null;
  chart1DVsEventLogDiff: number | null;
}

export interface DiagnosticRealizedEventRow {
  timestampMs: number;
  marketId: string;
  marketName: string;
  side: string;
  size: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  funding: number;
  netPnl: number;
  within24h: boolean;
  afterLastChartBucket: boolean;
}

export interface DiagnosticTradeFillRow {
  id: string;
  timeMs: number;
  marketId: string;
  marketName: string;
  side: string;
  price: number;
  size: number;
  fee: number;
  txHash: string | null;
  blockNumber: string | null;
}

export interface DiagnosticOnChainTxRow {
  hash: string;
  blockNumber: number;
  timestamp: string;
  method: string;
  toAddress: string | null;
  toName: string | null;
  status: string;
}

export interface SyncDiagnosticReport {
  query: string;
  resolvedAddress: string;
  username: string | null;
  avatarUrl: string | null;
  xHandle: string | null;
  generatedAtMs: number;
  status: SyncDiagnosticStatus;
  reasons: string[];
  snapshot: DiagnosticSnapshotSummary;
  live: DiagnosticLiveSummary;
  drift: DiagnosticDriftMetrics;
  recentRealizedEvents: DiagnosticRealizedEventRow[];
  recentTrades: DiagnosticTradeFillRow[];
  recentOnChainTxs: DiagnosticOnChainTxRow[];
}

export interface DiagnosticSnapshotInput {
  address: string;
  username: string | null;
  portfolioEnriched: boolean;
  lastUpdated: number;
  sources: string[];
  pnl24h: number | null;
  pnl7d: number | null;
  pnl30d: number | null;
  realizedPnlAll: number;
  unrealizedPnl: number;
  totalPnlAll: number;
  accountValue: number;
  openPositionsCount: number;
}

export interface BuildDiagnosticInput {
  query: string;
  resolvedAddress: string;
  username: string | null;
  avatarUrl: string | null;
  xHandle: string | null;
  snapshot: DiagnosticSnapshotInput | null;
  detailsSummary: any | null;
  openPositionsCount: number;
  chart1DPoints: any[];
  calDays: { date: string; pnl: string }[];
  realizedEvents: any[];
  realizedTotalFetched?: number;
  recentTrades: any[];
  onChainTxs: any[];
  markets: { market_id: string | number; display_name?: string }[];
  nowMs?: number;
}

export function buildTraderSyncDiagnostic(input: BuildDiagnosticInput): SyncDiagnosticReport {
  const nowMs = input.nowMs ?? Date.now();
  const marketNameMap = new Map<string, string>();
  for (const m of input.markets || []) {
    if (m?.display_name) marketNameMap.set(String(m.market_id), m.display_name);
  }

  const snapshot: DiagnosticSnapshotSummary = input.snapshot
    ? {
        inIndex: true,
        portfolioEnriched: input.snapshot.portfolioEnriched,
        address: input.snapshot.address,
        username: input.snapshot.username,
        lastUpdatedMs: input.snapshot.lastUpdated,
        snapshotAgeSec:
          input.snapshot.lastUpdated > 0
            ? Math.max(0, Math.round((nowMs - input.snapshot.lastUpdated) / 1000))
            : null,
        sources: input.snapshot.sources || [],
        pnl24h: input.snapshot.pnl24h,
        pnl7d: input.snapshot.pnl7d,
        pnl30d: input.snapshot.pnl30d,
        realizedPnlAll: input.snapshot.realizedPnlAll,
        unrealizedPnl: input.snapshot.unrealizedPnl,
        totalPnlAll: input.snapshot.totalPnlAll,
        accountValue: input.snapshot.accountValue,
        openPositionsCount: input.snapshot.openPositionsCount,
      }
    : {
        inIndex: false,
        portfolioEnriched: false,
        address: input.resolvedAddress,
        username: input.username,
        lastUpdatedMs: 0,
        snapshotAgeSec: null,
        sources: [],
        pnl24h: null,
        pnl7d: null,
        pnl30d: null,
        realizedPnlAll: 0,
        unrealizedPnl: 0,
        totalPnlAll: 0,
        accountValue: 0,
        openPositionsCount: 0,
      };

  const liveAccountValue = safeNum(input.detailsSummary?.total_account_value);
  const liveRealizedAll = safeNum(input.detailsSummary?.realized_pnl);
  const liveUnrealized = safeNum(input.detailsSummary?.total_unrealized_pnl);
  const liveTotalAll = liveRealizedAll + liveUnrealized;

  const sortedChart1D = (input.chart1DPoints || [])
    .map((p) => ({ ts: nsToMs(p.timestamp), val: safeNum(p.value) }))
    .filter((p) => p.ts > 0)
    .sort((a, b) => a.ts - b.ts);

  const chart1DPnl24h =
    sortedChart1D.length >= 2
      ? sortedChart1D[sortedChart1D.length - 1].val - sortedChart1D[0].val
      : null;
  const chart1DFirstTsMs = sortedChart1D.length > 0 ? sortedChart1D[0].ts : null;
  const chart1DLastTsMs =
    sortedChart1D.length > 0 ? sortedChart1D[sortedChart1D.length - 1].ts : null;

  const cutoff24h = nowMs - 86_400_000;
  let events24hRealizedPnl = 0;
  let events24hFundingPnl = 0;
  let events24hCount = 0;
  let postHourFillsCount = 0;
  let postHourFillsNetPnl = 0;

  const parsedEvents: DiagnosticRealizedEventRow[] = (input.realizedEvents || [])
    .map((ev) => {
      const timestampMs = nsToMs(ev.timestamp);
      const mId = String(ev.market_id || '');
      const pnl = safeNum(ev.pnl);
      const funding = safeNum(ev.funding);
      const netPnl = pnl + funding;
      const within24h = timestampMs >= cutoff24h && timestampMs <= nowMs + 60_000;
      const afterLastChartBucket = chart1DLastTsMs !== null && timestampMs > chart1DLastTsMs;
      if (within24h) {
        events24hRealizedPnl += pnl;
        events24hFundingPnl += funding;
        events24hCount += 1;
      }
      if (afterLastChartBucket) {
        postHourFillsCount += 1;
        postHourFillsNetPnl += netPnl;
      }
      return {
        timestampMs,
        marketId: mId,
        marketName: marketNameMap.get(mId) || `Market #${mId}`,
        side: String(ev.side || '').toUpperCase() || '—',
        size: safeNum(ev.size),
        entryPrice: safeNum(ev.entry_price),
        exitPrice: safeNum(ev.exit_price),
        pnl,
        funding,
        netPnl,
        within24h,
        afterLastChartBucket,
      };
    })
    .filter((e) => e.timestampMs > 0)
    .sort((a, b) => b.timestampMs - a.timestampMs);

  const events24hNetPnl = events24hRealizedPnl + events24hFundingPnl;
  const normalizedCal = normalizeCalendarAndPeriodMetrics(
    input.calDays || [],
    input.realizedEvents || [],
    nowMs
  );
  const todayUtcKey = new Date(nowMs).toISOString().slice(0, 10);
  const todayCal = normalizedCal.days.find((d) => d.date.slice(0, 10) === todayUtcKey);
  const calendarTodayPnl = todayCal ? safeNum(todayCal.pnl) : null;

  const recommended24hPnl = computeRolling24hPnl({
    upstreamPnl1D: input.chart1DPoints || [],
    realizedEvents: input.realizedEvents || [],
    calDays: normalizedCal.days,
    nowMs,
  });

  const live: DiagnosticLiveSummary = {
    accountValue: liveAccountValue,
    realizedPnlAll: liveRealizedAll,
    unrealizedPnl: liveUnrealized,
    totalPnlAll: liveTotalAll,
    openPositionsCount: input.openPositionsCount,
    chart1DPnl24h,
    chart1DPointsCount: sortedChart1D.length,
    chart1DFirstTsMs,
    chart1DLastTsMs,
    events24hRealizedPnl,
    events24hFundingPnl,
    events24hNetPnl,
    events24hCount,
    realizedStreamTruncated: (input.realizedTotalFetched ?? parsedEvents.length) >= 2000,
    postHourFillsCount,
    postHourFillsNetPnl,
    calendarTodayPnl,
    calendar7dPnl: normalizedCal.periodTotals['7d'],
    calendar30dPnl: normalizedCal.periodTotals['30d'],
    recommended24hPnl,
  };

  const drift: DiagnosticDriftMetrics = {
    drift24hVsRecommended:
      snapshot.inIndex && snapshot.pnl24h !== null ? snapshot.pnl24h - recommended24hPnl : null,
    drift24hVsEventLog:
      snapshot.inIndex && snapshot.pnl24h !== null ? snapshot.pnl24h - events24hNetPnl : null,
    drift7dVsLive:
      snapshot.inIndex && snapshot.pnl7d !== null
        ? snapshot.pnl7d - live.calendar7dPnl
        : null,
    drift30dVsLive:
      snapshot.inIndex && snapshot.pnl30d !== null
        ? snapshot.pnl30d - live.calendar30dPnl
        : null,
    driftTotalAllVsLive: snapshot.inIndex ? snapshot.totalPnlAll - liveTotalAll : null,
    chart1DVsEventLogDiff:
      chart1DPnl24h !== null ? chart1DPnl24h - events24hNetPnl : null,
  };

  const reasons: string[] = [];
  let status: SyncDiagnosticStatus = 'SYNCED';

  if (!snapshot.inIndex) {
    status = 'NOT_IN_INDEX';
    reasons.push('Wallet is not in tradersMap yet — missed background discovery sources.');
  } else if (!snapshot.portfolioEnriched) {
    status = 'UNENRICHED';
    reasons.push(
      'Wallet was discovered but full portfolio metrics (24h/7d/30d PnL, positions) have not yet been enriched by the background queue.'
    );
  } else {
    const abs24hDrift = Math.abs(drift.drift24hVsRecommended ?? 0);
    const absTotalDrift = Math.abs(drift.driftTotalAllVsLive ?? 0);
    const ageSec = snapshot.snapshotAgeSec ?? 0;

    if (abs24hDrift > 25 || absTotalDrift > 25 || ageSec > 600) {
      status = 'STALE_SNAPSHOT';
      if (abs24hDrift > 25) {
        reasons.push(
          `Cached 24h PnL ($${snapshot.pnl24h?.toFixed(2)}) differs from live recommended 24h PnL ($${recommended24hPnl.toFixed(2)}) by $${(drift.drift24hVsRecommended ?? 0).toFixed(2)}.`
        );
      }
      if (absTotalDrift > 25) {
        reasons.push(
          `Cached total PnL ($${snapshot.totalPnlAll.toFixed(2)}) differs from live portfolio details ($${liveTotalAll.toFixed(2)}) by $${(drift.driftTotalAllVsLive ?? 0).toFixed(2)}.`
        );
      }
      if (ageSec > 600) {
        reasons.push(`Cached snapshot is ${Math.round(ageSec / 60)}m old (queued for refresh).`);
      }
    }

    if (postHourFillsCount > 0 && Math.abs(postHourFillsNetPnl) > 1) {
      if (status === 'SYNCED') status = 'POST_HOUR_ACTIVITY';
      reasons.push(
        `${postHourFillsCount} realized event(s) ($${postHourFillsNetPnl.toFixed(2)}) settled after the latest hourly 1D chart bucket.`
      );
    }

    if (drift.chart1DVsEventLogDiff !== null && Math.abs(drift.chart1DVsEventLogDiff) > 100) {
      reasons.push(
        `Hourly equity curve delta ($${chart1DPnl24h!.toFixed(2)}) differs from rolling 24h realized-only events ($${events24hNetPnl.toFixed(2)}) due to open position unrealized MTM movement.`
      );
    }

    if (reasons.length === 0) {
      reasons.push('Cached snapshot matches live RISEx API and realized event streams within $25 tolerance.');
    }
  }

  const recentTrades: DiagnosticTradeFillRow[] = (input.recentTrades || [])
    .map((t) => {
      const mId = String(t.market_id || '');
      return {
        id: String(t.id || ''),
        timeMs: nsToMs(t.time),
        marketId: mId,
        marketName: marketNameMap.get(mId) || `Market #${mId}`,
        side: String(t.side || '').toUpperCase() || '—',
        price: safeNum(t.price),
        size: safeNum(t.size),
        fee: safeNum(t.fee),
        txHash: t.blockchain_data?.tx_hash || null,
        blockNumber: t.blockchain_data?.block_number ? String(t.blockchain_data.block_number) : null,
      };
    })
    .filter((t) => t.timeMs > 0)
    .slice(0, 18);

  const recentOnChainTxs: DiagnosticOnChainTxRow[] = (input.onChainTxs || [])
    .filter((tx) => tx?.hash)
    .slice(0, 12)
    .map((tx) => ({
      hash: tx.hash,
      blockNumber: Number(tx.block_number || 0),
      timestamp: String(tx.timestamp || ''),
      method: String(tx.method || 'tx'),
      toAddress: tx.to?.hash || null,
      toName: tx.to?.name || null,
      status: String(tx.status || 'ok'),
    }));

  return {
    query: input.query,
    resolvedAddress: input.resolvedAddress,
    username: input.username,
    avatarUrl: input.avatarUrl,
    xHandle: input.xHandle,
    generatedAtMs: nowMs,
    status,
    reasons,
    snapshot,
    live,
    drift,
    recentRealizedEvents: parsedEvents.slice(0, 30),
    recentTrades,
    recentOnChainTxs,
  };
}
