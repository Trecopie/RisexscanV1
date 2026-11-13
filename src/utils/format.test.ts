import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calcMarketChangePct,
  formatDateOnly,
  formatDuration,
  formatPct,
  formatPrice,
  formatSignedUsd,
  formatUsd,
  isValidAddress,
  isValidTxHash,
  nsToMs,
  shortAddress,
} from './format';

test('formatUsd handles compact and full values safely', () => {
  assert.equal(formatUsd(1250000, true), '$1.25M');
  assert.equal(formatUsd(-1500, true), '-$1.50K');
  assert.equal(formatUsd(1234.56), '$1,235');
  assert.equal(formatUsd(null), '—');
  assert.equal(formatUsd(Number.NaN), '—');
});

test('formatSignedUsd adds explicit + or - signs', () => {
  assert.equal(formatSignedUsd(250, true), '+$250.00');
  assert.equal(formatSignedUsd(2500, true), '+$2.50K');
  assert.equal(formatSignedUsd(-42.5), '-$42.50');
  assert.equal(formatSignedUsd(0), '$0.0000');
});

test('formatPrice scales decimals across price magnitudes', () => {
  assert.equal(formatPrice(0), '$0.00');
  assert.equal(formatPrice(92450.25), '$92,450.25');
  assert.equal(formatPrice(142.345), '$142.345');
  assert.equal(formatPrice(0.004567), '$0.004567');
});

test('formatPct, calcMarketChangePct, and formatDuration handle valid and empty values', () => {
  assert.equal(formatPct(12.345), '+12.35%');
  assert.equal(formatPct(-3.2), '-3.20%');
  assert.equal(formatPct(65.4, false), '65.40%');
  assert.ok(Math.abs(calcMarketChangePct('68882.18', '-2967.2') - -4.1297) < 0.01);
  assert.ok(Math.abs(calcMarketChangePct('72.524', '1.342') - 1.8853) < 0.01);
  assert.equal(calcMarketChangePct('0', '10'), 0);
  assert.equal(formatDuration(90060), '1d 1h');
  assert.equal(formatDuration(3720), '1h 2m');
  assert.equal(formatDuration(0), '—');
});

test('nsToMs normalizes nanoseconds, milliseconds, seconds, and ISO strings', () => {
  assert.equal(nsToMs('1700000000000000000'), 1700000000000);
  assert.equal(nsToMs('1700000000000'), 1700000000000);
  assert.equal(nsToMs('1700000000'), 1700000000000);
  assert.equal(nsToMs('2026-01-01T00:00:00Z'), Date.UTC(2026, 0, 1));
  assert.equal(formatDateOnly('2026-01-01T00:00:00Z'), 'Jan 1, 2026');
  assert.equal(nsToMs('bad-ts'), 0);
});

test('address and tx hash validators enforce hex lengths', () => {
  const addr = '0x1234567890abcdef1234567890abcdef12345678';
  const tx = '0x' + 'a'.repeat(64);
  assert.equal(isValidAddress(addr), true);
  assert.equal(isValidAddress('0x1234'), false);
  assert.equal(isValidTxHash(tx), true);
  assert.equal(isValidTxHash(addr), false);
  assert.equal(shortAddress(addr, 6, 4), '0x1234…5678');
});
