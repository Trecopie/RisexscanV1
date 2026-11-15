import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calcBollingerBands,
  calcEMA,
  calcMACD,
  calcRSI,
  calcSMA,
  calcSupertrend,
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
  assert.equal(nextBucket[2].open, 107);
  assert.equal(nextBucket[2].high, 107);
  assert.equal(nextBucket[2].low, 107);
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

test('calcSupertrend tracks trend flips and outputs mutually exclusive upLine/downLine segments', () => {
  // Construct rally followed by sharp selloff to force bullish -> bearish flip
  const closes = [
    100, 102, 104, 106, 108, 110, 113, 116, 119, 122, 125, 128, 130, 132,
    120, 112, 105, 98, 92, 88, 85, 82,
  ];
  const bars = makeBars(closes);
  const st = calcSupertrend(bars, 10, 2);

  assert.equal(st.points.length, closes.length - 10);
  assert.equal(st.upLine.length, st.points.length);
  assert.equal(st.downLine.length, st.points.length);

  const hasUp = st.points.some((p) => p.direction === 'up');
  const hasDown = st.points.some((p) => p.direction === 'down');
  assert.ok(hasUp && hasDown, 'Supertrend must detect both bullish and bearish regimes');

  for (let i = 0; i < st.points.length; i++) {
    const upHasVal = 'value' in st.upLine[i];
    const downHasVal = 'value' in st.downLine[i];
    assert.notEqual(upHasVal, downHasVal, 'Each bar must plot on either upLine or downLine, not both');
  }
});


test('gapped 1m trade candle never invents previous-close execution', () => {
  const baseline: NormalizedBar[]=[{
    time: 1_799_000_000,open:100,high:101,low:99,close:100,volume:3,
  }];
  const frame=mergeLiveTradeIntoBars(baseline, {
    price: 95, size: 1.5, timeMs: (1_799_000_000 + 3600) * 1000,
  }, '1m');
  const bar=frame.at(-1)!;
  assert.deepEqual({open:bar.open,high:bar.high,low:bar.low,close:bar.close,volume:bar.volume},
    {open:95,high:95,low:95,close:95,volume:1.5});
});
