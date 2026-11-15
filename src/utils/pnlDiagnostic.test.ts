import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTraderSyncDiagnostic } from './pnlDiagnostic.ts';

const NOW = Date.UTC(2026, 6, 15, 14, 30, 0);
const HR = 3600 * 1000;
const DAY = 86400 * 1000;

function toNsStr(ms: number): string {
  return String(BigInt(Math.round(ms)) * 1_000_000n);
}

test('flags UNENRICHED wallet when discovered without portfolio metrics', () => {
  const report = buildTraderSyncDiagnostic({
    query: 'sqalf',
    resolvedAddress: '0x123400000000000000000000000000000000abcd',
    username: 'sqalf',
    avatarUrl: null,
    xHandle: null,
    snapshot: {
      address: '0x123400000000000000000000000000000000abcd',
      username: 'sqalf',
      portfolioEnriched: false,
      lastUpdated: 0,
      sources: ['auth-registry'],
      pnl24h: null,
      pnl7d: null,
      pnl30d: null,
      realizedPnlAll: 0,
      unrealizedPnl: 0,
      totalPnlAll: 0,
      accountValue: 0,
      openPositionsCount: 0,
    },
    detailsSummary: {
      total_account_value: '250000',
      realized_pnl: '140000',
      total_unrealized_pnl: '5000',
    },
    openPositionsCount: 2,
    chart1DPoints: [
      { timestamp: toNsStr(NOW - DAY), value: '10000' },
      { timestamp: toNsStr(NOW - 1800 * 1000), value: '148900' },
    ],
    calDays: [{ date: '2026-07-15T00:00:00Z', pnl: '138900' }],
    realizedEvents: [
      {
        timestamp: toNsStr(NOW - 3 * HR),
        market_id: '1',
        side: 'long',
        entry_price: '3000',
        exit_price: '3200',
        size: '100',
        pnl: '138000',
        funding: '900',
      },
    ],
    recentTrades: [],
    onChainTxs: [],
    markets: [{ market_id: '1', display_name: 'ETH/USDC' }],
    nowMs: NOW,
  });

  assert.equal(report.status, 'UNENRICHED');
  assert.equal(report.snapshot.portfolioEnriched, false);
  assert.equal(Math.round(report.live.events24hNetPnl), 138900);
  assert.equal(Math.round(report.live.recommended24hPnl), 138900);
  assert.equal(report.recentRealizedEvents[0].marketName, 'ETH/USDC');
});

test('flags STALE_SNAPSHOT when cached 24h PnL lags live chart delta', () => {
  const report = buildTraderSyncDiagnostic({
    query: 'tbsp',
    resolvedAddress: '0xabcd000000000000000000000000000000001234',
    username: 'tbsp',
    avatarUrl: null,
    xHandle: null,
    snapshot: {
      address: '0xabcd000000000000000000000000000000001234',
      username: 'tbsp',
      portfolioEnriched: true,
      lastUpdated: NOW - 900 * 1000,
      sources: ['vol-24h'],
      pnl24h: 120000,
      pnl7d: 150000,
      pnl30d: 200000,
      realizedPnlAll: 300000,
      unrealizedPnl: 1000,
      totalPnlAll: 301000,
      accountValue: 500000,
      openPositionsCount: 1,
    },
    detailsSummary: {
      total_account_value: '550000',
      realized_pnl: '350000',
      total_unrealized_pnl: '0',
    },
    openPositionsCount: 0,
    chart1DPoints: [
      { timestamp: toNsStr(NOW - DAY), value: '10000' },
      { timestamp: toNsStr(NOW - 30 * 60 * 1000), value: '179110' },
    ],
    calDays: [{ date: '2026-07-15T00:00:00Z', pnl: '169110' }],
    realizedEvents: [
      {
        timestamp: toNsStr(NOW - 15 * 60 * 1000),
        market_id: '2',
        side: 'short',
        entry_price: '90000',
        exit_price: '88000',
        size: '5',
        pnl: '10000',
        funding: '0',
      },
    ],
    recentTrades: [],
    onChainTxs: [],
    markets: [{ market_id: '2', display_name: 'BTC/USDC' }],
    nowMs: NOW,
  });

  assert.equal(report.status, 'STALE_SNAPSHOT');
  assert.ok(Math.abs((report.drift.drift24hVsRecommended ?? 0) - -49110) < 1);
  assert.equal(report.live.postHourFillsCount, 1);
  assert.equal(Math.round(report.live.postHourFillsNetPnl), 10000);
});

test('reports SYNCED when snapshot matches live curve and realized events closely', () => {
  const report = buildTraderSyncDiagnostic({
    query: 'sqalf',
    resolvedAddress: '0x123400000000000000000000000000000000abcd',
    username: 'sqalf',
    avatarUrl: null,
    xHandle: null,
    snapshot: {
      address: '0x123400000000000000000000000000000000abcd',
      username: 'sqalf',
      portfolioEnriched: true,
      lastUpdated: NOW - 30 * 1000,
      sources: ['indexer'],
      pnl24h: 138900,
      pnl7d: 138900,
      pnl30d: 138900,
      realizedPnlAll: 138900,
      unrealizedPnl: 0,
      totalPnlAll: 138900,
      accountValue: 250000,
      openPositionsCount: 0,
    },
    detailsSummary: {
      total_account_value: '250000',
      realized_pnl: '138900',
      total_unrealized_pnl: '0',
    },
    openPositionsCount: 0,
    chart1DPoints: [
      { timestamp: toNsStr(NOW - DAY), value: '0' },
      { timestamp: toNsStr(NOW - 5 * 60 * 1000), value: '138900' },
    ],
    calDays: [{ date: '2026-07-15T00:00:00Z', pnl: '138900' }],
    realizedEvents: [
      {
        timestamp: toNsStr(NOW - 10 * 60 * 1000),
        market_id: '1',
        side: 'long',
        entry_price: '3000',
        exit_price: '3200',
        size: '100',
        pnl: '138900',
        funding: '0',
      },
    ],
    recentTrades: [],
    onChainTxs: [],
    markets: [{ market_id: '1', display_name: 'ETH/USDC' }],
    nowMs: NOW,
  });

  assert.equal(report.status, 'SYNCED');
  assert.equal(Math.round(report.drift.drift24hVsRecommended ?? 999), 0);
  assert.equal(Math.round(report.drift.drift24hVsEventLog ?? 999), 0);
});

test('keeps status SYNCED with explanatory note when MTM differs from realized-only stream', () => {
  const report = buildTraderSyncDiagnostic({
    query: 'sqalf',
    resolvedAddress: '0x123400000000000000000000000000000000abcd',
    username: 'sqalf',
    avatarUrl: null,
    xHandle: null,
    snapshot: {
      address: '0x123400000000000000000000000000000000abcd',
      username: 'sqalf',
      portfolioEnriched: true,
      lastUpdated: NOW - 10 * 1000,
      sources: ['diagnostic-resync'],
      pnl24h: 138900,
      pnl7d: 138900,
      pnl30d: 138900,
      realizedPnlAll: 138400,
      unrealizedPnl: 500,
      totalPnlAll: 138900,
      accountValue: 250000,
      openPositionsCount: 1,
    },
    detailsSummary: {
      total_account_value: '250000',
      realized_pnl: '138400',
      total_unrealized_pnl: '500',
    },
    openPositionsCount: 1,
    chart1DPoints: [
      { timestamp: toNsStr(NOW - DAY), value: '0' },
      { timestamp: toNsStr(NOW - 5 * 60 * 1000), value: '138900' },
    ],
    calDays: [{ date: '2026-07-15T00:00:00Z', pnl: '138400' }],
    realizedEvents: [
      {
        timestamp: toNsStr(NOW - 20 * 60 * 1000),
        market_id: '1',
        side: 'long',
        entry_price: '3000',
        exit_price: '3200',
        size: '100',
        pnl: '138400',
        funding: '0',
      },
    ],
    recentTrades: [],
    onChainTxs: [],
    markets: [{ market_id: '1', display_name: 'ETH/USDC' }],
    nowMs: NOW,
  });

  assert.equal(report.status, 'SYNCED');
  assert.ok(report.reasons.some((r) => r.includes('unrealized MTM')));
});

