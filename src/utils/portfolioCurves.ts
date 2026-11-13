import { nsToMs } from './format.ts';

export const DAY_MS = 86_400_000;

export interface ChartPointData {
  timestamp: string;
  value: string;
}

export interface PnlCalendarDayInput {
  date: string;
  pnl: string;
}

export interface TransferInput {
  type: string;
  amount: string;
  block_time: string;
}

export interface RealizedPnlInput {
  timestamp: string;
  pnl: string;
}

export interface FundingPaymentInput {
  funding_payment: string;
  block_time: string;
  is_settled?: boolean;
}

export interface NormalizedCalendarPayload {
  days: PnlCalendarDayInput[];
  win_days: number;
  best_day?: PnlCalendarDayInput;
  periodTotals: {
    '24h': number;
    '7d': number;
    '30d': number;
    all: number;
  };
}

function safeFloat(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function getUtcDayStartMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function toUtcDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Generates normalized UTC daily calendar data anchored to `nowMs` and computes
 * 24h / 7d / 30d / all totals from the exact same daily UTC buckets so calendar
 * heatmap cells and period performance metrics always agree to the cent.
 */
export function normalizeCalendarAndPeriodMetrics(
  calDays: PnlCalendarDayInput[],
  realizedEvents: RealizedPnlInput[] = [],
  nowMs = Date.now()
): NormalizedCalendarPayload {
  const dailyMap = new Map<number, number>();

  for (const day of calDays || []) {
    const ms = nsToMs(day.date);
    if (!ms) continue;
    const dayStart = getUtcDayStartMs(ms);
    dailyMap.set(dayStart, (dailyMap.get(dayStart) || 0) + safeFloat(day.pnl));
  }

  // Reconcile UTC today if recent realized-pnl fills exist that haven't hit upstream pnl-calendar yet
  const todayStart = getUtcDayStartMs(nowMs);
  let todayRpnlSum = 0;
  let hasTodayRpnlEvent = false;
  for (const ev of realizedEvents || []) {
    const ms = nsToMs(ev.timestamp);
    if (!ms) continue;
    if (getUtcDayStartMs(ms) === todayStart) {
      hasTodayRpnlEvent = true;
      todayRpnlSum += safeFloat(ev.pnl);
    }
  }
  if (hasTodayRpnlEvent) {
    const existingToday = dailyMap.get(todayStart);
    if (existingToday === undefined) {
      dailyMap.set(todayStart, todayRpnlSum);
    } else if (Math.abs(todayRpnlSum - existingToday) > 0.01 && realizedEvents.length < 10000) {
      // Complete realized events list diverges from cached cal entry for today -> use fresher realized events
      dailyMap.set(todayStart, todayRpnlSum);
    }
  }

  const cutoff7d = todayStart - 6 * DAY_MS;
  const cutoff30d = todayStart - 29 * DAY_MS;

  let pnl24h = 0;
  let pnl7d = 0;
  let pnl30d = 0;
  let pnlAll = 0;
  let winDays = 0;
  let bestDay: PnlCalendarDayInput | undefined;
  let bestVal = -Infinity;

  const sortedEntries = Array.from(dailyMap.entries()).sort((a, b) => a[0] - b[0]);
  const days: PnlCalendarDayInput[] = [];

  for (const [dayStart, pnl] of sortedEntries) {
    if (dayStart === todayStart) pnl24h += pnl;
    if (dayStart >= cutoff7d && dayStart <= todayStart) pnl7d += pnl;
    if (dayStart >= cutoff30d && dayStart <= todayStart) pnl30d += pnl;
    pnlAll += pnl;
    if (pnl > 0) winDays++;

    const entry: PnlCalendarDayInput = {
      date: String(dayStart),
      pnl: String(pnl),
    };
    days.push(entry);

    if (pnl > bestVal) {
      bestVal = pnl;
      bestDay = entry;
    }
  }

  return {
    days,
    win_days: winDays,
    best_day: bestDay,
    periodTotals: {
      '24h': pnl24h,
      '7d': pnl7d,
      '30d': pnl30d,
      all: pnlAll,
    },
  };
}

/**
 * Computes UTC-now anchored 24h / 7d / 30d realized PnL matching the normalized calendar buckets.
 */
export function computeUtcPeriodPnl(
  days: PnlCalendarDayInput[],
  realizedEvents: RealizedPnlInput[] = [],
  nowMs = Date.now()
): { pnl24h: number; pnl7d: number; pnl30d: number } {
  const normalized = normalizeCalendarAndPeriodMetrics(days, realizedEvents, nowMs);
  return {
    pnl24h: normalized.periodTotals['24h'],
    pnl7d: normalized.periodTotals['7d'],
    pnl30d: normalized.periodTotals['30d'],
  };
}

function toChartPoint(ms: number, value: number): ChartPointData {
  const clean = Math.abs(value) < 1e-6 ? 0 : value;
  return {
    timestamp: String(Math.round(ms)),
    value: String(clean),
  };
}

/**
 * Downsamples dense step/curve points across equal time intervals while preserving
 * local min/max extrema and exact first/last endpoints.
 */
function downsampleWithExtrema(
  pts: { ms: number; value: number }[],
  maxPoints = 140
): { ms: number; value: number }[] {
  if (pts.length <= maxPoints) return pts;

  const first = pts[0];
  const last = pts[pts.length - 1];
  const spanMs = last.ms - first.ms;
  if (spanMs <= 0) return [first, last];

  const buckets = Math.max(1, Math.floor((maxPoints - 2) / 2));
  const out: { ms: number; value: number }[] = [first];
  const inner = pts.slice(1, -1);

  let idx = 0;
  for (let b = 0; b < buckets && idx < inner.length; b++) {
    const bucketEndMs = first.ms + ((b + 1) / buckets) * spanMs;
    if (inner[idx].ms > bucketEndMs) continue;

    let minPt = inner[idx];
    let maxPt = inner[idx];
    idx++;
    while (idx < inner.length && inner[idx].ms <= bucketEndMs) {
      if (inner[idx].value < minPt.value) minPt = inner[idx];
      if (inner[idx].value > maxPt.value) maxPt = inner[idx];
      idx++;
    }

    if (minPt === maxPt) {
      out.push(minPt);
    } else if (minPt.ms <= maxPt.ms) {
      out.push(minPt, maxPt);
    } else {
      out.push(maxPt, minPt);
    }
  }

  while (idx < inner.length) {
    out.push(inner[idx++]);
  }

  out.push(last);
  return out;
}

function sliceTimelineWindow(
  timeline: { ms: number; value: number }[],
  windowStartMs: number,
  nowMs: number,
  currentEndValue: number,
  clampNonNegative: boolean
): ChartPointData[] {
  if (timeline.length === 0) {
    const val = clampNonNegative ? Math.max(0, currentEndValue) : currentEndValue;
    return [toChartPoint(windowStartMs, val), toChartPoint(nowMs, val)];
  }

  let startVal = timeline[0].value;
  for (const pt of timeline) {
    if (pt.ms <= windowStartMs) {
      startVal = pt.value;
    } else {
      break;
    }
  }

  if (timeline[0].ms > windowStartMs) {
    startVal = timeline[0].value;
  }

  const inWindow = timeline.filter((pt) => pt.ms > windowStartMs && pt.ms < nowMs);
  const combined: { ms: number; value: number }[] = [
    { ms: Math.max(windowStartMs, timeline[0].ms <= windowStartMs ? windowStartMs : timeline[0].ms), value: startVal },
    ...inWindow,
    { ms: nowMs, value: clampNonNegative ? Math.max(0, currentEndValue) : currentEndValue },
  ];

  const coalesced: { ms: number; value: number }[] = [];
  for (const pt of combined) {
    const last = coalesced[coalesced.length - 1];
    if (last && last.ms === pt.ms) {
      last.value = pt.value;
    } else {
      coalesced.push({ ms: pt.ms, value: pt.value });
    }
  }

  return downsampleWithExtrema(coalesced).map((p) =>
    toChartPoint(p.ms, clampNonNegative ? Math.max(0, p.value) : p.value)
  );
}

/**
 * Reconstructs accurate non-negative historical account equity across
 * 1D / 1W / 1M / ALL by combining deposit/withdraw cashflows, realized PnL
 * (including settled funding), and accruing unsettled funding payments,
 * anchored at live total_account_value.
 */
export function reconstructAccountEquitySeries(params: {
  transfers: TransferInput[];
  realizedEvents: RealizedPnlInput[];
  calDays: PnlCalendarDayInput[];
  fundingPayments?: FundingPaymentInput[];
  currentAccountValue: number;
  unrealizedPnl: number;
  transfersComplete: boolean;
  upstreamEquityByWindow?: Record<'1D' | '1W' | '1M' | 'ALL', ChartPointData[]>;
  nowMs?: number;
}): Record<'1D' | '1W' | '1M' | 'ALL', ChartPointData[]> {
  const {
    transfers,
    realizedEvents,
    calDays,
    fundingPayments = [],
    currentAccountValue,
    unrealizedPnl,
    transfersComplete,
    upstreamEquityByWindow,
    nowMs = Date.now(),
  } = params;

  const hasNegativeUpstream = (pts?: ChartPointData[]) =>
    (pts || []).some((p) => safeFloat(p.value) < -1);

  if (!transfersComplete && upstreamEquityByWindow) {
    const allClean = (['1D', '1W', '1M', 'ALL'] as const).every(
      (w) => (upstreamEquityByWindow[w] || []).length > 0 && !hasNegativeUpstream(upstreamEquityByWindow[w])
    );
    if (allClean) {
      return upstreamEquityByWindow;
    }
  }

  type CashflowEvent = { ms: number; delta: number; order: number };
  const events: CashflowEvent[] = [];

  for (const t of transfers || []) {
    const ms = nsToMs(t.block_time);
    const amt = Math.abs(safeFloat(t.amount));
    if (!ms || amt === 0) continue;
    const upperType = String(t.type || '').toUpperCase();
    if (upperType === 'DEPOSIT') {
      events.push({ ms, delta: amt, order: 0 });
    } else if (upperType === 'WITHDRAW') {
      events.push({ ms, delta: -amt, order: 2 });
    }
  }

  const parsedRpnl = (realizedEvents || [])
    .map((r) => ({ ms: nsToMs(r.timestamp), pnl: safeFloat(r.pnl) }))
    .filter((r) => r.ms > 0 && Number.isFinite(r.pnl));

  const parsedCal = (calDays || [])
    .map((c) => ({ ms: nsToMs(c.date), pnl: safeFloat(c.pnl) }))
    .filter((c) => c.ms > 0 && Number.isFinite(c.pnl));

  const calTotal = parsedCal.reduce((s, c) => s + c.pnl, 0);
  const rpnlTotal = parsedRpnl.reduce((s, r) => s + r.pnl, 0);
  const rpnlMatchesCalClosely =
    parsedRpnl.length > 0 &&
    parsedRpnl.length < 10000 &&
    (parsedCal.length === 0 || Math.abs(rpnlTotal - calTotal) <= Math.max(25, Math.abs(calTotal) * 0.02));

  if (rpnlMatchesCalClosely) {
    for (const r of parsedRpnl) {
      events.push({ ms: r.ms, delta: r.pnl, order: 1 });
    }
  } else if (parsedRpnl.length > 0 && parsedCal.length > 0) {
    const earliestRpnlMs = Math.min(...parsedRpnl.map((r) => r.ms));
    const fullRpnlStartMs = getUtcDayStartMs(earliestRpnlMs) + DAY_MS;

    for (const c of parsedCal) {
      if (getUtcDayStartMs(c.ms) < fullRpnlStartMs) {
        events.push({ ms: getUtcDayStartMs(c.ms) + DAY_MS / 2, delta: c.pnl, order: 1 });
      }
    }
    for (const r of parsedRpnl) {
      if (r.ms >= fullRpnlStartMs) {
        events.push({ ms: r.ms, delta: r.pnl, order: 1 });
      }
    }
  } else {
    for (const c of parsedCal) {
      events.push({ ms: getUtcDayStartMs(c.ms) + DAY_MS / 2, delta: c.pnl, order: 1 });
    }
  }

  // Include unsettled funding accruals on active open positions (settled funding is already in realized_pnl / calDays)
  for (const fp of fundingPayments || []) {
    if (fp.is_settled !== false) continue;
    const ms = nsToMs(fp.block_time);
    const val = safeFloat(fp.funding_payment);
    if (!ms || val === 0) continue;
    events.push({ ms, delta: val, order: 1 });
  }

  events.sort((a, b) => (a.ms !== b.ms ? a.ms - b.ms : a.order - b.order));

  const safeLiveVal = Math.max(0, currentAccountValue);
  let timeline: { ms: number; value: number }[] = [];

  if (transfersComplete && events.length > 0) {
    const firstMs = events[0].ms;
    timeline.push({ ms: firstMs - 3_600_000, value: 0 });
    let bal = 0;
    for (const ev of events) {
      bal += ev.delta;
      timeline.push({ ms: ev.ms, value: Math.max(0, bal) });
    }
    timeline.push({ ms: nowMs, value: safeLiveVal });
  } else if (!transfersComplete && events.length > 0) {
    const settledCashNow = Math.max(0, currentAccountValue - unrealizedPnl);
    let bal = settledCashNow;
    const rev: { ms: number; value: number }[] = [{ ms: nowMs, value: safeLiveVal }];
    for (let i = events.length - 1; i >= 0; i--) {
      rev.push({ ms: events[i].ms, value: Math.max(0, bal) });
      bal -= events[i].delta;
    }
    rev.push({ ms: events[0].ms - 3_600_000, value: Math.max(0, bal) });
    timeline = rev.reverse();
  }

  const todayStart = getUtcDayStartMs(nowMs);
  const tryCleanUpstreamWindow = (w: '1D' | '1W'): ChartPointData[] | null => {
    const pts = upstreamEquityByWindow?.[w];
    if (!pts || pts.length < 4 || hasNegativeUpstream(pts)) return null;
    const parsed = pts
      .map((p) => ({ ms: nsToMs(p.timestamp), value: Math.max(0, safeFloat(p.value)) }))
      .filter((p) => p.ms > 0)
      .sort((a, b) => a.ms - b.ms);
    if (parsed.length < 4) return null;
    const lastVal = parsed[parsed.length - 1].value;
    if (Math.abs(lastVal - safeLiveVal) > Math.max(500, safeLiveVal * 0.25)) return null;
    const merged = [...parsed, { ms: nowMs, value: safeLiveVal }];
    return downsampleWithExtrema(merged).map((p) => toChartPoint(p.ms, p.value));
  };

  return {
    '1D': tryCleanUpstreamWindow('1D') || sliceTimelineWindow(timeline, todayStart, nowMs, safeLiveVal, true),
    '1W': tryCleanUpstreamWindow('1W') || sliceTimelineWindow(timeline, todayStart - 6 * DAY_MS, nowMs, safeLiveVal, true),
    '1M': sliceTimelineWindow(timeline, todayStart - 29 * DAY_MS, nowMs, safeLiveVal, true),
    'ALL': sliceTimelineWindow(
      timeline,
      timeline.length > 0 ? timeline[0].ms : todayStart - 29 * DAY_MS,
      nowMs,
      safeLiveVal,
      true
    ),
  };
}

/**
 * Builds consistent cumulative PnL series for 1D / 1W / 1M / ALL:
 * - 1D starts at $0 at UTC today open and ends at periodPnl['24h'] (today's calendar value).
 * - 1W / 1M start at $0 at window open and end at the exact calendar sum for 7d / 30d.
 * - ALL starts at $0 at inception and ends at totalPnlAll (realized + unrealized).
 */
export function buildConsistentPnlSeries(params: {
  calDays: PnlCalendarDayInput[];
  realizedEvents: RealizedPnlInput[];
  upstreamPnl1D?: ChartPointData[];
  totalRealizedPnl: number;
  unrealizedPnl: number;
  periodPnl: { '24h': number; '7d': number; '30d': number; all: number };
  nowMs?: number;
}): Record<'1D' | '1W' | '1M' | 'ALL', ChartPointData[]> {
  const {
    calDays,
    realizedEvents,
    upstreamPnl1D = [],
    totalRealizedPnl,
    unrealizedPnl,
    periodPnl,
    nowMs = Date.now(),
  } = params;

  const todayStart = getUtcDayStartMs(nowMs);
  const parsedCal = (calDays || [])
    .map((c) => ({ ms: getUtcDayStartMs(nsToMs(c.date)), pnl: safeFloat(c.pnl) }))
    .filter((c) => c.ms > 0)
    .sort((a, b) => a.ms - b.ms);

  const parsedRpnl = (realizedEvents || [])
    .map((r) => ({ ms: nsToMs(r.timestamp), pnl: safeFloat(r.pnl) }))
    .filter((r) => r.ms > 0)
    .sort((a, b) => a.ms - b.ms);

  const build1D = (): ChartPointData[] => {
    const todayRpnl = parsedRpnl.filter((r) => r.ms >= todayStart && r.ms <= nowMs);
    if (todayRpnl.length > 0) {
      const pts: { ms: number; value: number }[] = [{ ms: todayStart, value: 0 }];
      let cum = 0;
      for (const r of todayRpnl) {
        cum += r.pnl;
        pts.push({ ms: r.ms, value: cum });
      }
      pts.push({ ms: nowMs, value: periodPnl['24h'] });
      return downsampleWithExtrema(pts).map((p) => toChartPoint(p.ms, p.value));
    }

    const valid = upstreamPnl1D
      .map((p) => ({ ms: nsToMs(p.timestamp), val: safeFloat(p.value) }))
      .filter((p) => p.ms >= todayStart)
      .sort((a, b) => a.ms - b.ms);
    if (valid.length >= 2) {
      const base = valid[0].val;
      const rebased = valid.map((p) => ({ ms: p.ms, value: p.val - base }));
      rebased.push({ ms: nowMs, value: periodPnl['24h'] });
      return downsampleWithExtrema(rebased).map((p) => toChartPoint(p.ms, p.value));
    }
    return [toChartPoint(todayStart, 0), toChartPoint(nowMs, periodPnl['24h'])];
  };

  const buildRelativeWindow = (windowStartMs: number, targetEndPnl: number): ChartPointData[] => {
    const useRpnl =
      parsedRpnl.length > 0 && (parsedRpnl.length < 10000 || parsedRpnl[0].ms <= windowStartMs);

    const srcEvents = useRpnl
      ? parsedRpnl.filter((r) => r.ms >= windowStartMs && r.ms <= nowMs)
      : parsedCal
          .filter((c) => c.ms >= windowStartMs && c.ms <= nowMs)
          .map((c) => ({ ms: Math.min(nowMs - 1000, c.ms + DAY_MS - 1000), pnl: c.pnl }));

    const pts: { ms: number; value: number }[] = [{ ms: windowStartMs, value: 0 }];
    let cum = 0;
    for (const ev of srcEvents) {
      cum += ev.pnl;
      pts.push({ ms: ev.ms, value: cum });
    }
    pts.push({ ms: nowMs, value: targetEndPnl });
    return downsampleWithExtrema(pts).map((p) => toChartPoint(p.ms, p.value));
  };

  const buildAll = (): ChartPointData[] => {
    const pts: { ms: number; value: number }[] = [];
    const calSum = parsedCal.reduce((s, c) => s + c.pnl, 0);
    const rpnlSum = parsedRpnl.reduce((s, r) => s + r.pnl, 0);
    const useExactRpnl =
      parsedRpnl.length > 0 &&
      parsedRpnl.length < 10000 &&
      (parsedCal.length === 0 || Math.abs(rpnlSum - calSum) <= Math.max(25, Math.abs(calSum) * 0.02));

    if (useExactRpnl) {
      pts.push({ ms: parsedRpnl[0].ms - 3_600_000, value: 0 });
      let cum = 0;
      for (const r of parsedRpnl) {
        cum += r.pnl;
        pts.push({ ms: r.ms, value: cum });
      }
    } else if (parsedCal.length > 0) {
      pts.push({ ms: parsedCal[0].ms - DAY_MS, value: 0 });
      let cum = 0;
      for (const c of parsedCal) {
        cum += c.pnl;
        pts.push({ ms: Math.min(nowMs - 1000, c.ms + DAY_MS - 1000), value: cum });
      }
    } else {
      pts.push({ ms: todayStart - 29 * DAY_MS, value: 0 });
      if (totalRealizedPnl !== 0) {
        pts.push({ ms: nowMs - 1000, value: totalRealizedPnl });
      }
    }

    pts.push({ ms: nowMs, value: totalRealizedPnl + unrealizedPnl });
    return downsampleWithExtrema(pts).map((p) => toChartPoint(p.ms, p.value));
  };

  return {
    '1D': build1D(),
    '1W': buildRelativeWindow(todayStart - 6 * DAY_MS, periodPnl['7d']),
    '1M': buildRelativeWindow(todayStart - 29 * DAY_MS, periodPnl['30d']),
    'ALL': buildAll(),
  };
}

export interface UtcCalendarCell {
  dayNumber: number;
  dateKey: string;
  pnl: number | null;
}

export interface UtcMonthCalendarData {
  monthKey: string;
  monthLabel: string;
  firstWeekday: number;
  cells: UtcCalendarCell[];
  monthTotalPnl: number;
  monthWinDays: number;
  monthActiveDays: number;
  allTimeWinDays: number;
  allTimeActiveDays: number;
  maxAbsMonth: number;
  availableMonths: string[];
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function buildUtcMonthCalendar(
  days: PnlCalendarDayInput[],
  requestedMonthKey?: string
): UtcMonthCalendarData {
  const dailyMap = new Map<string, number>();
  const monthsSet = new Set<string>();

  for (const d of days || []) {
    const ms = nsToMs(d.date);
    const val = safeFloat(d.pnl);
    if (!ms || !Number.isFinite(val)) continue;
    const key = toUtcDateKey(ms);
    dailyMap.set(key, (dailyMap.get(key) || 0) + val);
    monthsSet.add(key.slice(0, 7));
  }

  let allTimeWinDays = 0;
  let allTimeActiveDays = 0;
  for (const v of dailyMap.values()) {
    allTimeActiveDays++;
    if (v > 0) allTimeWinDays++;
  }

  const availableMonths = Array.from(monthsSet).sort();
  if (availableMonths.length === 0) {
    const now = new Date();
    const fallbackKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    return {
      monthKey: fallbackKey,
      monthLabel: `${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`,
      firstWeekday: 0,
      cells: [],
      monthTotalPnl: 0,
      monthWinDays: 0,
      monthActiveDays: 0,
      allTimeWinDays: 0,
      allTimeActiveDays: 0,
      maxAbsMonth: 1,
      availableMonths: [fallbackKey],
    };
  }

  const firstYM = availableMonths[0];
  const lastYM = availableMonths[availableMonths.length - 1];
  const [fy, fm] = firstYM.split('-').map(Number);
  const [ly, lm] = lastYM.split('-').map(Number);
  const spannedMonths: string[] = [];
  let cy = fy;
  let cm = fm;
  while (cy < ly || (cy === ly && cm <= lm)) {
    spannedMonths.push(`${cy}-${String(cm).padStart(2, '0')}`);
    cm++;
    if (cm > 12) {
      cm = 1;
      cy++;
    }
  }

  const activeMonth =
    requestedMonthKey && spannedMonths.includes(requestedMonthKey)
      ? requestedMonthKey
      : spannedMonths[spannedMonths.length - 1];

  const [year, month] = activeMonth.split('-').map(Number);
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const cells: UtcCalendarCell[] = [];
  let monthTotalPnl = 0;
  let monthWinDays = 0;
  let monthActiveDays = 0;
  let maxAbsMonth = 1;

  for (let day = 1; day <= daysInMonth; day++) {
    const dateKey = `${activeMonth}-${String(day).padStart(2, '0')}`;
    const pnl = dailyMap.has(dateKey) ? dailyMap.get(dateKey)! : null;
    if (pnl !== null) {
      monthActiveDays++;
      monthTotalPnl += pnl;
      if (pnl > 0) monthWinDays++;
      if (Math.abs(pnl) > maxAbsMonth) maxAbsMonth = Math.abs(pnl);
    }
    cells.push({ dayNumber: day, dateKey, pnl });
  }

  return {
    monthKey: activeMonth,
    monthLabel: `${MONTH_NAMES[month - 1]} ${year}`,
    firstWeekday,
    cells,
    monthTotalPnl,
    monthWinDays,
    monthActiveDays,
    allTimeWinDays,
    allTimeActiveDays,
    maxAbsMonth,
    availableMonths: spannedMonths,
  };
}
