import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRealizedSide, summarizeRealizedEvents } from './tradeLifecycle.ts';

test('normalizeRealizedSide maps BUY->LONG and SELL->SHORT reliably', () => {
  assert.equal(normalizeRealizedSide('BUY'), 'LONG');
  assert.equal(normalizeRealizedSide('LONG'), 'LONG');
  assert.equal(normalizeRealizedSide('0'), 'LONG');
  assert.equal(normalizeRealizedSide('SELL'), 'SHORT');
  assert.equal(normalizeRealizedSide('SHORT'), 'SHORT');
  assert.equal(normalizeRealizedSide('1'), 'SHORT');
});

test('summarizeRealizedEvents aggregates net realized PnL, gross profit/loss, win rate and funding', () => {
  const summary = summarizeRealizedEvents([
    { pnl: '125.50', funding: '-2.50' },
    { pnl: '-25.50', funding: '1.00' },
    { pnl: '50.00', funding: '0' },
    { pnl: '0', funding: '0' },
  ]);

  assert.equal(summary.totalEvents, 4);
  assert.equal(summary.netRealizedPnl, 150);
  assert.equal(summary.grossProfit, 175.5);
  assert.equal(summary.grossLoss, -25.5);
  assert.equal(summary.totalFunding, -1.5);
  assert.equal(summary.wins, 2);
  assert.equal(summary.losses, 1);
  assert.ok(Math.abs(summary.winRatePct - 66.666666) < 0.01);
  assert.ok(summary.profitFactor !== null && Math.abs(summary.profitFactor - 175.5 / 25.5) < 0.01);
  assert.equal(summary.bestClose, 125.5);
  assert.equal(summary.worstClose, -25.5);
});
