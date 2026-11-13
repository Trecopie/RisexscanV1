import type { MarketCandle } from '../types/risex.ts';

export interface NormalizedBar {
  time: number; // UNIX timestamp in seconds (strictly ascending)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface LineDataPoint {
  time: number;
  value: number;
}

export interface HistogramDataPoint {
  time: number;
  value: number;
  color?: string;
}

export interface BollingerResult {
  upper: LineDataPoint[];
  middle: LineDataPoint[];
  lower: LineDataPoint[];
}

export interface MacdResult {
  macd: LineDataPoint[];
  signal: LineDataPoint[];
  histogram: HistogramDataPoint[];
}

const RESOLUTION_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1H': 3600,
  '4H': 14400,
  '1D': 86400,
};

export function getResolutionSeconds(resolution: string): number {
  return RESOLUTION_SECONDS[resolution] || 3600;
}

/**
 * Normalizes raw candles into strictly ascending UNIX-second OHLCV bars for TradingView Lightweight Charts.
 */
export function normalizeCandles(candles: MarketCandle[]): NormalizedBar[] {
  if (!candles || candles.length === 0) return [];
  const bySec = new Map<number, NormalizedBar>();
  for (const c of candles) {
    const rawMs = Number(c.time);
    if (!Number.isFinite(rawMs) || rawMs <= 0) continue;
    const sec = rawMs > 1e11 ? Math.floor(rawMs / 1000) : Math.floor(rawMs);
    const open = Number(c.open);
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);
    const volume = Math.max(0, Number(c.volume) || 0);
    if (![open, high, low, close].every(Number.isFinite)) continue;
    const prev = bySec.get(sec);
    if (!prev) {
      bySec.set(sec, { time: sec, open, high, low, close, volume });
    } else {
      prev.high = Math.max(prev.high, high);
      prev.low = Math.min(prev.low, low);
      prev.close = close;
      prev.volume += volume;
    }
  }
  return Array.from(bySec.values()).sort((a, b) => a.time - b.time);
}

/**
 * Merges a live WebSocket trade tick into the current normalized candle array.
 */
export function mergeLiveTradeIntoBars(
  bars: NormalizedBar[],
  trade: { price: number; size: number; timeMs: number },
  resolution: string
): NormalizedBar[] {
  if (!Number.isFinite(trade.price) || trade.price <= 0 || !Number.isFinite(trade.timeMs)) {
    return bars;
  }
  const bucketSec = getResolutionSeconds(resolution);
  const tradeSec = Math.floor(trade.timeMs / 1000);
  const barTime = Math.floor(tradeSec / bucketSec) * bucketSec;
  const vol = Math.max(0, Number(trade.size) || 0);

  if (bars.length === 0) {
    return [
      {
        time: barTime,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: vol,
      },
    ];
  }

  const last = bars[bars.length - 1];
  if (barTime < last.time) {
    return bars;
  }
  if (barTime === last.time) {
    const updated: NormalizedBar = {
      time: last.time,
      open: last.open,
      high: Math.max(last.high, trade.price),
      low: Math.min(last.low, trade.price),
      close: trade.price,
      volume: last.volume + vol,
    };
    return [...bars.slice(0, -1), updated];
  }

  return [
    ...bars,
    {
      time: barTime,
      open: last.close,
      high: Math.max(last.close, trade.price),
      low: Math.min(last.close, trade.price),
      close: trade.price,
      volume: vol,
    },
  ];
}

export function calcSMA(bars: NormalizedBar[], period: number): LineDataPoint[] {
  if (period <= 0 || bars.length < period) return [];
  const out: LineDataPoint[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= period) sum -= bars[i - period].close;
    if (i >= period - 1) {
      out.push({ time: bars[i].time, value: sum / period });
    }
  }
  return out;
}

export function calcEMA(bars: NormalizedBar[], period: number): LineDataPoint[] {
  if (period <= 0 || bars.length < period) return [];
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += bars[i].close;
  let ema = sum / period;
  const out: LineDataPoint[] = [{ time: bars[period - 1].time, value: ema }];
  for (let i = period; i < bars.length; i++) {
    ema = bars[i].close * k + ema * (1 - k);
    out.push({ time: bars[i].time, value: ema });
  }
  return out;
}

export function calcBollingerBands(
  bars: NormalizedBar[],
  period = 20,
  stdDevMult = 2
): BollingerResult {
  if (period <= 1 || bars.length < period) {
    return { upper: [], middle: [], lower: [] };
  }
  const upper: LineDataPoint[] = [];
  const middle: LineDataPoint[] = [];
  const lower: LineDataPoint[] = [];

  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += bars[j].close;
    const mean = sum / period;
    let sqDiff = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = bars[j].close - mean;
      sqDiff += diff * diff;
    }
    const sd = Math.sqrt(sqDiff / period);
    const t = bars[i].time;
    middle.push({ time: t, value: mean });
    upper.push({ time: t, value: mean + stdDevMult * sd });
    lower.push({ time: t, value: mean - stdDevMult * sd });
  }

  return { upper, middle, lower };
}

/**
 * Session VWAP anchored per UTC day for intraday timeframes (<= 4H), or cumulative on 1D.
 */
export function calcVWAP(bars: NormalizedBar[], resolution = '1H'): LineDataPoint[] {
  if (bars.length === 0) return [];
  const resetDaily = resolution !== '1D';
  let currentDay = -1;
  let cumPV = 0;
  let cumV = 0;
  const out: LineDataPoint[] = [];

  for (const b of bars) {
    const day = Math.floor(b.time / 86400);
    if (resetDaily && day !== currentDay) {
      currentDay = day;
      cumPV = 0;
      cumV = 0;
    }
    const typical = (b.high + b.low + b.close) / 3;
    const v = b.volume > 0 ? b.volume : 1;
    cumPV += typical * v;
    cumV += v;
    out.push({ time: b.time, value: cumPV / cumV });
  }
  return out;
}

export function calcRSI(bars: NormalizedBar[], period = 14): LineDataPoint[] {
  if (period <= 0 || bars.length <= period) return [];
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const delta = bars[i].close - bars[i - 1].close;
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const toRsi = (ag: number, al: number) => (al === 0 ? 100 : 100 - 100 / (1 + ag / al));

  const out: LineDataPoint[] = [{ time: bars[period].time, value: toRsi(avgGain, avgLoss) }];
  for (let i = period + 1; i < bars.length; i++) {
    const delta = bars[i].close - bars[i - 1].close;
    const g = delta > 0 ? delta : 0;
    const l = delta < 0 ? Math.abs(delta) : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out.push({ time: bars[i].time, value: toRsi(avgGain, avgLoss) });
  }
  return out;
}

export function calcMACD(
  bars: NormalizedBar[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): MacdResult {
  if (bars.length < slowPeriod + signalPeriod) {
    return { macd: [], signal: [], histogram: [] };
  }
  const fastEma = calcEMA(bars, fastPeriod);
  const slowEma = calcEMA(bars, slowPeriod);
  const fastMap = new Map(fastEma.map((p) => [p.time, p.value]));

  const macdLine: LineDataPoint[] = [];
  for (const s of slowEma) {
    const f = fastMap.get(s.time);
    if (f !== undefined) {
      macdLine.push({ time: s.time, value: f - s.value });
    }
  }
  if (macdLine.length < signalPeriod) {
    return { macd: [], signal: [], histogram: [] };
  }

  const k = 2 / (signalPeriod + 1);
  let sum = 0;
  for (let i = 0; i < signalPeriod; i++) sum += macdLine[i].value;
  let sig = sum / signalPeriod;

  const macdOut: LineDataPoint[] = [];
  const signalOut: LineDataPoint[] = [];
  const histOut: HistogramDataPoint[] = [];

  for (let i = signalPeriod - 1; i < macdLine.length; i++) {
    if (i > signalPeriod - 1) {
      sig = macdLine[i].value * k + sig * (1 - k);
    }
    const mVal = macdLine[i].value;
    const hVal = mVal - sig;
    const t = macdLine[i].time;
    macdOut.push({ time: t, value: mVal });
    signalOut.push({ time: t, value: sig });
    histOut.push({
      time: t,
      value: hVal,
      color: hVal >= 0 ? 'rgba(34, 224, 161, 0.55)' : 'rgba(255, 77, 109, 0.55)',
    });
  }

  return { macd: macdOut, signal: signalOut, histogram: histOut };
}
