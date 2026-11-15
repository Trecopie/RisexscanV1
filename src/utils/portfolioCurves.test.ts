import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConsistentPnlSeries,
  buildUtcMonthCalendar,
  computeRolling24hPnl,
  computeUtcPeriodPnl,
  normalizeCalendarAndPeriodMetrics,
  reconstructAccountEquitySeries,
} from './portfolioCurves';

test('computeUtcPeriodPnl returns 0 for inactive wallets whose last trade was weeks ago', () => {
  const nowMs = Date.UTC(2026, 10, 13, 18, 0, 0); // 2026-11-13
  const days = [
    { date: String(Date.UTC(2026, 8, 27)), pnl: '1444.21' }, // Sep 27 (47d ago)
    { date: String(Date.UTC(2026, 8, 20)), pnl: '2200.00' }, // Sep 20
    { date: String(Date.UTC(2026, 7, 3)), pnl: '9742.60' },  // Aug 3
  ];

  const res = computeUtcPeriodPnl(days, [], nowMs);
  assert.equal(res.pnl24h, 0);
  assert.equal(res.pnl7d, 0);
  assert.equal(res.pnl30d, 0);
});

test('normalizeCalendarAndPeriodMetrics aligns calendar days and 24h/7d/30d metrics precisely', () => {
  const nowMs = Date.UTC(2026, 10, 13, 18, 0, 0); // Nov 13
  const days = [
    { date: String(Date.UTC(2026, 9, 10)), pnl: '1000' },  // Oct 10 (outside 30d)
    { date: String(Date.UTC(2026, 9, 25)), pnl: '2000' },  // Oct 25 (inside 30d)
    { date: String(Date.UTC(2026, 10, 10)), pnl: '500' },  // Nov 10 (inside 7d)
  ];
  // Simulate today Nov 13 close in realizedEvents before pnl-calendar updates
  const realizedEvents = [
    { timestamp: String(Date.UTC(2026, 10, 13, 12, 0, 0)), pnl: '300' },
  ];

  const norm = normalizeCalendarAndPeriodMetrics(days, realizedEvents, nowMs);
  assert.equal(norm.periodTotals['24h'], 300);
  assert.equal(norm.periodTotals['7d'], 800);
  assert.equal(norm.periodTotals['30d'], 2800);
  assert.equal(norm.periodTotals.all, 3800);
  assert.equal(norm.win_days, 4);
  assert.equal(norm.best_day?.pnl, '2000');

  const res = computeUtcPeriodPnl(days, realizedEvents, nowMs);
  assert.equal(res.pnl24h, norm.periodTotals['24h']);
  assert.equal(res.pnl7d, norm.periodTotals['7d']);
  assert.equal(res.pnl30d, norm.periodTotals['30d']);
});

test('reconstructAccountEquitySeries handles deposits, realized PnL, and unsettled funding payments accurately', () => {
  const jul21 = Date.UTC(2026, 6, 21, 10, 0, 0);
  const jul22 = Date.UTC(2026, 6, 22, 10, 0, 0);
  const sep27 = Date.UTC(2026, 8, 27, 14, 0, 0);
  const sep29 = Date.UTC(2026, 8, 29, 14, 0, 0);
  const nowMs = Date.UTC(2026, 10, 13, 18, 0, 0);

  const transfers = [
    { type: 'DEPOSIT', amount: '7517', block_time: String(jul21) },
    { type: 'WITHDRAW', amount: '25175.04', block_time: String(sep29) },
  ];
  const realizedEvents = [
    { timestamp: String(jul21 + 3600_000), pnl: '2721.90' },
    { timestamp: String(sep27), pnl: '14936.15' },
  ];
  const calDays = [
    { date: String(Date.UTC(2026, 6, 21)), pnl: '2721.90' },
    { date: String(Date.UTC(2026, 8, 27)), pnl: '14936.15' },
  ];
  const fundingPayments = [
    // Settled funding already covered by realizedEvents -> must not double count
    { funding_payment: '500', block_time: String(jul21 + 7200_000), is_settled: true },
    // Unsettled funding accrual between closes -> reflected cleanly
    { funding_payment: '250', block_time: String(jul22), is_settled: false },
  ];

  const series = reconstructAccountEquitySeries({
    transfers,
    realizedEvents,
    calDays,
    fundingPayments,
    currentAccountValue: 250.01,
    unrealizedPnl: 0,
    transfersComplete: true,
    nowMs,
  });

  const allVals = series['ALL'].map((p) => Number(p.value));
  assert.ok(allVals.every((v) => v >= 0), 'ALL equity points must never be negative');
  assert.ok(allVals.some((v) => Math.abs(v - 10488.9) < 0.1), 'Unsettled funding reflected at jul22');
  assert.equal(Number(series['ALL'][series['ALL'].length - 1].value), 250.01);
  assert.equal(Number(series['1M'][series['1M'].length - 1].value), 250.01);
});

test('reconstructAccountEquitySeries handles >10k realized events via hybrid mode without negative dip', () => {
  const nowMs = Date.UTC(2026, 10, 13, 18, 0, 0);
  const oct8 = Date.UTC(2026, 9, 8, 12, 0, 0);
  const nov5 = Date.UTC(2026, 10, 5, 12, 0, 0);

  const realizedEvents = Array.from({ length: 10000 }, (_, i) => ({
    timestamp: String(Date.UTC(2026, 10, 2, 0, 0, 0) + i * 1000),
    pnl: '1',
  }));
  const calDays = [
    { date: String(Date.UTC(2026, 9, 8)), pnl: '20000' },
    { date: String(Date.UTC(2026, 10, 2)), pnl: '2000' },
    { date: String(Date.UTC(2026, 10, 3)), pnl: '8000' },
  ];
  const transfers = [
    { type: 'DEPOSIT', amount: '50000', block_time: String(oct8 - 3600_000) },
    { type: 'WITHDRAW', amount: '60000', block_time: String(nov5) },
  ];

  const series = reconstructAccountEquitySeries({
    transfers,
    realizedEvents,
    calDays,
    currentAccountValue: 25000,
    unrealizedPnl: 5000,
    transfersComplete: true,
    nowMs,
  });

  const allVals = series['ALL'].map((p) => Number(p.value));
  assert.ok(allVals.every((v) => v >= 0), 'Hybrid equity reconstruction must remain non-negative');
  assert.equal(Number(series['ALL'][series['ALL'].length - 1].value), 25000);
});

test('buildConsistentPnlSeries matches 1D/1W/1M/ALL endpoints to period KPIs', () => {
  const nowMs = Date.UTC(2026, 10, 13, 18, 0, 0);
  const calDays = [
    { date: String(Date.UTC(2026, 9, 8)), pnl: '10000' },
    { date: String(Date.UTC(2026, 10, 10)), pnl: '5000' },
    { date: String(Date.UTC(2026, 10, 13)), pnl: '2000' },
  ];

  const pnlSeries = buildConsistentPnlSeries({
    calDays,
    realizedEvents: [],
    totalRealizedPnl: 17000,
    unrealizedPnl: 3000,
    periodPnl: { '24h': 2000, '7d': 7000, '30d': 7000, all: 20000 },
    nowMs,
  });

  assert.equal(Number(pnlSeries['1D'][0].value), 0);
  assert.equal(Number(pnlSeries['1D'][pnlSeries['1D'].length - 1].value), 2000);
  assert.equal(Number(pnlSeries['1W'][0].value), 0);
  assert.equal(Number(pnlSeries['1W'][pnlSeries['1W'].length - 1].value), 7000);
  assert.equal(Number(pnlSeries['1M'][0].value), 0);
  assert.equal(Number(pnlSeries['1M'][pnlSeries['1M'].length - 1].value), 7000);
  assert.equal(Number(pnlSeries['ALL'][0].value), 0);
  assert.equal(Number(pnlSeries['ALL'][pnlSeries['ALL'].length - 1].value), 20000);
});

test('buildUtcMonthCalendar aligns UTC weekdays, tracks month navigation, and computes win counts cleanly', () => {
  const days = [
    { date: String(Date.UTC(2026, 6, 21)), pnl: '1200' },
    { date: String(Date.UTC(2026, 7, 3)), pnl: '9742.6' },
    { date: String(Date.UTC(2026, 8, 1)), pnl: '-300' },
    { date: String(Date.UTC(2026, 8, 27)), pnl: '1444.2' },
  ];

  const sep = buildUtcMonthCalendar(days);
  assert.equal(sep.monthKey, '2026-09');
  assert.equal(sep.monthLabel, 'Sep 2026');
  assert.equal(sep.firstWeekday, 2);
  assert.equal(sep.cells.length, 30);
  assert.equal(sep.monthWinDays, 1);
  assert.equal(sep.monthActiveDays, 2);
  assert.equal(sep.allTimeWinDays, 3);
  assert.equal(sep.allTimeActiveDays, 4);
  assert.deepEqual(sep.availableMonths, ['2026-07', '2026-08', '2026-09']);

  const aug = buildUtcMonthCalendar(days, '2026-08');
  assert.equal(aug.monthKey, '2026-08');
  assert.equal(aug.cells.length, 31);
  assert.equal(aug.monthTotalPnl, 9742.6);
});

test('reconstructAccountEquitySeries uses clean 1D/1W mark-to-market equity while overriding corrupted negative 1M/ALL curves', () => {
  const nowMs = Date.UTC(2026, 10, 13, 18, 0, 0);
  const series = reconstructAccountEquitySeries({
    transfers: [{ type: 'DEPOSIT', amount: '10000', block_time: String(nowMs - 40 * 86_400_000) }],
    realizedEvents: [],
    calDays: [{ date: String(Date.UTC(2026, 9, 20)), pnl: '5000' }],
    currentAccountValue: 18000,
    unrealizedPnl: 3000,
    transfersComplete: true,
    upstreamEquityByWindow: {
      '1D': [
        { timestamp: String(nowMs - 18 * 3600_000), value: '16500' },
        { timestamp: String(nowMs - 12 * 3600_000), value: '17000' },
        { timestamp: String(nowMs - 6 * 3600_000), value: '17400' },
        { timestamp: String(nowMs - 3600_000), value: '17900' },
      ],
      '1W': [
        { timestamp: String(nowMs - 6 * 86_400_000), value: '15000' },
        { timestamp: String(nowMs - 4 * 86_400_000), value: '16000' },
        { timestamp: String(nowMs - 2 * 86_400_000), value: '17200' },
        { timestamp: String(nowMs - 3600_000), value: '17950' },
      ],
      '1M': [
        { timestamp: String(nowMs - 20 * 86_400_000), value: '-25000' },
        { timestamp: String(nowMs - 3600_000), value: '18000' },
      ],
      'ALL': [
        { timestamp: String(nowMs - 40 * 86_400_000), value: '-10000' },
        { timestamp: String(nowMs - 3600_000), value: '18000' },
      ],
    },
    nowMs,
  });

  // Clean 1D mark-to-market starts near 16500 instead of dropping to settled cash 15000
  assert.equal(Number(series['1D'][0].value), 16500);
  assert.equal(Number(series['1D'][series['1D'].length - 1].value), 18000);
  assert.equal(Number(series['1W'][0].value), 15000);
  // Corrupted negative 1M and ALL fall back to reconstructed non-negative timeline
  assert.ok(series['1M'].every((p) => Number(p.value) >= 0));
  assert.ok(series['ALL'].every((p) => Number(p.value) >= 0));
});

test('computeRolling24hPnl matches RISEx rolling 24h chart across UTC midnight instead of truncating to UTC today', () => {
  const nowMs = Date.UTC(2026, 10, 15, 4, 30, 0); // 04:30 UTC Nov 15
  // Upstream 1D chart starts at Nov 14 04:30 UTC and ends at Nov 15 04:30 UTC with delta +138897.08
  const upstreamPnl1D = [
    { timestamp: String(nowMs - 86_400_000), value: '10000.00' },
    { timestamp: String(nowMs - 43_200_000), value: '124085.82' },
    { timestamp: String(nowMs), value: '148897.08' },
  ];
  const realizedEvents = [
    { timestamp: String(Date.UTC(2026, 10, 14, 15, 0, 0)), pnl: '114085.82' },
    { timestamp: String(Date.UTC(2026, 10, 15, 2, 0, 0)), pnl: '24811.26' },
  ];
  const calDays = [
    { date: String(Date.UTC(2026, 10, 14)), pnl: '114085.82' },
    { date: String(Date.UTC(2026, 10, 15)), pnl: '24811.26' },
  ];

  const rolling24h = computeRolling24hPnl({
    upstreamPnl1D,
    realizedEvents,
    calDays,
    nowMs,
  });
  assert.ok(Math.abs(rolling24h - 138897.08) < 0.01);

  // Even without upstream 1D chart, rolling 24h uses realized events in [now - 24h .. now]
  const fallbackRolling = computeRolling24hPnl({
    upstreamPnl1D: [],
    realizedEvents,
    calDays,
    nowMs,
  });
  assert.ok(Math.abs(fallbackRolling - 138897.08) < 0.01);
});


