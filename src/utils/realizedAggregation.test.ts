import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRealizedByMarketSide, type RealizedAggregationInput } from './realizedAggregation.ts';

const item = (id: string, marketId: string, side: 'LONG' | 'SHORT', pnl: number, funding: number, timestamp: string): RealizedAggregationInput => ({
  id, marketId, marketName: marketId === '1' ? 'BTC' : 'ETH', side,
  size: 1, entryPrice: 100, exitPrice: 120, openTime: null,
  closeTime: timestamp, fillsCount: null, funding, realizedPnl: pnl,
});

test('market+side summary preserves all official settlement PnL including partial closes on open positions', () => {
  const rows = [
    item('a', '1', 'LONG', 5, -1, '1700000000'),
    item('b', '1', 'LONG', 7, 0.5, '1700000100'),
    item('c', '1', 'SHORT', -4, 0.25, '1700000200'),
    item('d', '2', 'LONG', 10, 0, '1700000300'),
  ];
  const grouped = aggregateRealizedByMarketSide(rows);
  assert.equal(grouped.length, 3);
  const btcLong = grouped.find((x) => x.marketId === '1' && x.side === 'LONG')!;
  assert.equal(btcLong.realizedPnl, 12);
  assert.equal(btcLong.funding, -0.5);
  assert.equal(btcLong.size, 2);
  assert.equal(btcLong.fillsCount, 2);
  assert.equal(btcLong.closeTime, '1700000100');
  assert.equal(grouped.reduce((sum,x)=>sum+x.realizedPnl,0), 18);
  assert.equal(rows.reduce((sum,x)=>sum+x.realizedPnl,0), 18);
  assert.equal(grouped.reduce((sum,x)=>sum+x.funding,0), rows.reduce((sum,x)=>sum+x.funding,0));
});

test('aggregation is independent of event order; unknown entry prices are not invented', () => {
  const rows = [
    item('a','1','LONG',25,0,'1700000300'),
    item('b','1','LONG',-5,0,'1700000000'),
  ];
  const g=aggregateRealizedByMarketSide(rows.reverse());
  assert.equal(g[0].realizedPnl, 20);
  assert.equal(g[0].closeTime,'1700000300');
  assert.equal(g[0].entryPrice,0);
  assert.equal(g[0].exitPrice,0);
  assert.equal(g[0].openTime,null);
});
