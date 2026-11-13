import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calcBollingerBands,
  calcEMA,
  calcMACD,
  calcRSI,
  calcSMA,
  calcVWAP,
  mergeLiveTradeIntoBars,
  normalizeCandles,
  type NormalizedBar,
} from './indicators.ts';

function makeBars(closes: number[], startSec = 1_794_500_000, stepSec = 3600): NormalizedBar[] {
  return closes.map((c, idx) => ({
    time: startSec + idx * stepSec,
    open: idx === 0 ? c : closes[idx - 1],
    high: c + 2,
    low: Math.max(1, c - 2),
    close: c,
    volume: 100 + idx * 10,
  }));
}

test('normalizeCandles sorts ascending, deduplicates timestamps, and merges volume', () => {
  const raw = [
    { time: 1794503600000, open: 100, high: 105, low: 99, close: 103, volume: 10 },
    { time: 1794500000000, open: 95, high: 101, low: 94, close: 100, volume: 8 },
    { time: 1794503600000, open: 103, high: 108, low: 102, close: 106, volume: 5 },
  ];
  const bars = normalizeCandles(raw);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].time, 1794500000);
  assert.equal(bars[1].time, 1794503600);
  assert.equal(bars[1].high, 108);
  assert.equal(bars[1].close, 106);
  assert.equal(bars[1].volume, 15);
});

test('mergeLiveTradeIntoBars updates current candle or opens next bucket cleanly', () => {
  const base = makeBars([100, 102], 1_794_499_200, 3600);
  const sameBucket = mergeLiveTradeIntoBars(
    base,
    { price: 109, size: 25, timeMs: (1_794_499_200 + 3600 + 420) * 1000 },
    '1H'
  );
  assert.equal(sameBucket.length, 2);
  assert.equal(sameBucket[1].close, 109);
  assert.equal(sameBucket[1].high, 109);
  assert.equal(sameBucket[1].volume, base[1].volume + 25);

  const nextBucket = mergeLiveTradeIntoBars(
    sameBucket,
    { price: 107, size: 12, timeMs: (1_794_499_200 + 7200 + 10) * 1000 },
    '1H'
  );
  assert.equal(nextBucket.length, 3);
  assert.equal(nextBucket[2].open, 109);
  assert.equal(nextBucket[2].close, 107);
  assert.equal(nextBucket[2].volume, 12);
});

test('calcSMA, calcEMA, calcBollingerBands, and calcVWAP compute accurate series', () => {
  const bars = makeBars([10, 12, 14, 16, 18, 20, 22, 24, 26, 28]);
  const sma3 = calcSMA(bars, 3);
  assert.equal(sma3.length, 8);
  assert.equal(sma3[0].value, 12);
  assert.equal(sma3[sma3.length - 1].value, 26);

  const ema3 = calcEMA(bars, 3);
  assert.equal(ema3.length, 8);
  assert.equal(ema3[0].value, 12);
  assert.ok(ema3[ema3.length - 1].value > 25);

  const bb = calcBollingerBands(bars, 5, 2);
  assert.equal(bb.middle.length, 6);
  assert.ok(bb.upper[0].value > bb.middle[0].value);
  assert.ok(bb.lower[0].value < bb.middle[0].value);

  const vwap = calcVWAP(bars, '1H');
  assert.equal(vwap.length, 10);
  assert.ok(vwap.every((p) => Number.isFinite(p.value) && p.value > 0));
});

test('calcRSI and calcMACD stay within expected bounds and lengths', () => {
  const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i * 0.4) * 10 + i * 0.5);
  const bars = makeBars(closes);

  const rsi = calcRSI(bars, 14);
  assert.equal(rsi.length, closes.length - 14);
  assert.ok(rsi.every((p) => p.value >= 0 && p.value <= 100));

  const macd = calcMACD(bars, 12, 26, 9);
  assert.ok(macd.macd.length > 0);
  assert.equal(macd.signal.length, macd.macd.length);
  assert.equal(macd.histogram.length, macd.macd.length);
});
