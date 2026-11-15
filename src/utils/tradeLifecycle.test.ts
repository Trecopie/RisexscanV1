import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRealizedSide, summarizeRealizedEvents, reconstructTradeLifecycles } from './tradeLifecycle.ts';

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

const trade = (time: number, side: 'BUY' | 'SELL', size: number, price: number, market_id = '1') => ({
  market_id, time: String(time), side, size: String(size), price: String(price), fee: '0',
});
const event = (time: number, pnl: number, funding = 0, market_id = '1') => ({
  market_id, timestamp: String(time), pnl: String(pnl), funding: String(funding),
});

test('aggregates multiple partial exits into one completed cycle, keeping active partials separate', () => {
  const trades = [
    trade(1700000500, 'SELL', 1, 205),
    trade(1700000400, 'BUY', 4, 200),
    trade(1700000300, 'SELL', 5, 120),
    trade(1700000200, 'SELL', 2, 105),
    trade(1700000100, 'SELL', 3, 110),
    trade(1700000000, 'BUY', 10, 100),
  ];
  const realizedEvents = [
    event(1700000500, 5),
    event(1700000300, 100, -1),
    event(1700000200, 10, 0.5),
    event(1700000100, 30, -0.5),
  ];
  const result = reconstructTradeLifecycles(
    [{ market_id: '1', size: '3', market_name: 'BTC/USDC' }],
    trades, realizedEvents, [{ market_id: '1', display_name: 'BTC/USDC' }]
  );
  assert.equal(result.closedTrades.length, 1);
  assert.equal(result.closedTrades[0].side, 'LONG');
  assert.equal(result.closedTrades[0].closedSize, 10);
  assert.equal(result.closedTrades[0].officialEventCount, 3);
  assert.equal(result.closedTrades[0].realizedPnl, 140);
  assert.equal(result.closedTrades[0].funding, -1);
  assert.equal(result.openRealizedByMarket.get('1'), 5);
  assert.equal(result.openRealizedCompleteByMarket.get('1'), true);
  assert.equal(result.unattributedEventCount, 0);
});

test('a reversing fill creates two distinct closed trades and assigns a flip settlement once', () => {
  const result = reconstructTradeLifecycles([], [
    trade(1700000300, 'BUY', 3, 90),
    trade(1700000200, 'SELL', 13, 110),
    trade(1700000100, 'BUY', 10, 100),
  ], [event(1700000200, 100), event(1700000300, 60)], [{ market_id: '1', display_name: 'BTC/USDC' }]);
  assert.equal(result.closedTrades.length, 2);
  const long = result.closedTrades.find((x) => x.side === 'LONG');
  const short = result.closedTrades.find((x) => x.side === 'SHORT');
  assert.equal(long?.realizedPnl, 100);
  assert.equal(short?.realizedPnl, 60);
  assert.equal(long?.officialEventCount, 1);
  assert.equal(short?.officialEventCount, 1);
  assert.equal(result.unattributedEventCount, 0);
});

test('truncated fills do not falsely claim complete realized PnL for an open position', () => {
  const result = reconstructTradeLifecycles(
    [{ market_id: '1', size: '3' }],
    [trade(1700000500, 'SELL', 1, 205)],
    [event(1700000500, 5)],
    [{ market_id: '1', display_name: 'BTC/USDC' }]
  );
  assert.equal(result.openRealizedCompleteByMarket.get('1'), false);
  assert.equal(result.openRealizedByMarket.get('1'), 5);
  const missing = reconstructTradeLifecycles(
    [{ market_id: '1', size: '3' }],
    [trade(1700000500, 'SELL', 1, 205)],
    [], []
  );
  assert.equal(missing.openRealizedByMarket.get('1'), null);
});

test('unknown events are not assigned to a completed trade just to inflate totals', () => {
  const result = reconstructTradeLifecycles([], [
    trade(1700000300, 'SELL', 2, 120),
    trade(1700000100, 'BUY', 2, 100),
  ], [event(1700000300, 40), event(1600000000, 500)], [{ market_id: '1', display_name: 'BTC/USDC' }]);
  assert.equal(result.closedTrades.length, 1);
  assert.equal(result.closedTrades[0].realizedPnl, 40);
  assert.equal(result.closedTrades[0].officialEventCount, 1);
  assert.equal(result.unattributedEventCount, 1);
});
