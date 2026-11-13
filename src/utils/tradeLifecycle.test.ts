import test from 'node:test';
import assert from 'node:assert/strict';
import { calcRoiPct, reconstructTradeLifecycles, safeNum } from './tradeLifecycle';

test('safeNum and calcRoiPct compute safe numeric bounds', () => {
  assert.equal(safeNum('123.45'), 123.45);
  assert.equal(safeNum('not-a-number'), 0);
  assert.ok(Math.abs(calcRoiPct(200, 1200) - 20) < 1e-9);
  assert.equal(calcRoiPct(5, 5), 0);
});

test('reconstructTradeLifecycles builds closed long trade with weighted entry, exit, and funding', () => {
  const markets = [{ market_id: 1, display_name: 'BTC-USD' }];
  const trades = [
    { market_id: 1, side: 'BUY', size: '1', price: '100', time: '1700000000000000000', fee: '1', realized_pnl: '-1' },
    { market_id: 1, side: 'BUY', size: '1', price: '120', time: '1700000100000000000', fee: '1', realized_pnl: '-1' },
    { market_id: 1, side: 'SELL', size: '2', price: '130', time: '1700000200000000000', fee: '2', realized_pnl: '38' },
  ];
  const realizedEvents = [
    { market_id: 1, timestamp: '1700000150000000000', funding: '4.5' },
  ];

  const { openRealizedByMarket, closedTrades } = reconstructTradeLifecycles([], trades, realizedEvents, markets);
  assert.equal(openRealizedByMarket.size, 0);
  assert.equal(closedTrades.length, 1);
  assert.equal(closedTrades[0].marketName, 'BTC-USD');
  assert.equal(closedTrades[0].side, 'LONG');
  assert.equal(closedTrades[0].maxSize, 2);
  assert.equal(closedTrades[0].entryPrice, 110);
  assert.equal(closedTrades[0].exitPrice, 130);
  assert.equal(closedTrades[0].funding, 4.5);
  assert.equal(closedTrades[0].realizedPnl, 36);
});

test('reconstructTradeLifecycles attributes partial realized PnL to currently open positions', () => {
  const markets = [{ market_id: 2, display_name: 'ETH-USD' }];
  const rawOpen = [{ market_id: 2, size: '1.5' }];
  const trades = [
    { market_id: 2, side: 'BUY', size: '2.5', price: '2000', time: '1700000000000000000', fee: '2', realized_pnl: '-2' },
    { market_id: 2, side: 'SELL', size: '1.0', price: '2200', time: '1700000500000000000', fee: '1', realized_pnl: '199' },
  ];

  const { openRealizedByMarket, closedTrades } = reconstructTradeLifecycles(rawOpen, trades, [], markets);
  assert.equal(closedTrades.length, 0);
  assert.equal(openRealizedByMarket.get('2'), 197);
});

test('reconstructTradeLifecycles splits single fill flipping position from LONG to SHORT and handles ISO dates', () => {
  const markets = [{ market_id: 3, display_name: 'SOL-USD' }];
  const rawOpen = [{ market_id: 3, size: '-2' }];
  const trades = [
    { market_id: 3, side: 'BUY', size: '3', price: '100', time: '2026-01-01T00:00:00Z', fee: '1', realized_pnl: '-1' },
    { market_id: 3, side: 'SELL', size: '5', price: '110', time: '2026-01-01T01:00:00Z', fee: '5', realized_pnl: '25' },
  ];

  const { openRealizedByMarket, closedTrades } = reconstructTradeLifecycles(rawOpen, trades, [], markets);
  assert.equal(closedTrades.length, 1);
  assert.equal(closedTrades[0].side, 'LONG');
  assert.equal(closedTrades[0].closedSize, 3);
  assert.equal(closedTrades[0].entryPrice, 100);
  assert.equal(closedTrades[0].exitPrice, 110);
  assert.equal(openRealizedByMarket.get('3'), -2);
});
