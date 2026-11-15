import test from 'node:test';
import assert from 'node:assert/strict';
import { isNearLiquidation, LIQUIDATION_ALERT_PCT, liquidationDistancePct } from './liquidationRisk.ts';
import { deriveLiveLiquidationRisk, mergeExplorerTradeTape } from './explorerLive.ts';
import type { IndexedPositionRow, MarketTrade, RisexMarket } from '../types/risex.ts';

test('strict <5% liquidation threshold and invalid mark rejection', () => {
  assert.equal(LIQUIDATION_ALERT_PCT, 5);
  assert.equal(isNearLiquidation(100, 104.99), true);
  assert.equal(isNearLiquidation(100, 105), false);
  assert.equal(isNearLiquidation(100, 95.01), true);
  assert.equal(isNearLiquidation(100, 95), false);
  assert.equal(isNearLiquidation(0, 100), false);
  assert.equal(liquidationDistancePct('bad', 100), null);
});

const position = (id:string, marketId:string, markPrice:number, liquidationPrice:number): IndexedPositionRow => ({
  address:id, marketId, marketName:'BTC', side:'LONG', markPrice, liquidationPrice,
  notionalUsd:1000, size:10, entryPrice:100, leverage:5, unrealizedPnl:0, roiPct:0,
  portfolioValue:1000, accountLeverage:5, marginBalance:200, marginMode:'Cross',
} as IndexedPositionRow);

test('Explorer live oracle marks can bring previously safe candidates inside the <5% radar', () => {
  const candidate = {...position('wallet','1',100,108),distancePct:8};
  const market = [{market_id:'1', mark_price:'105', last_price:'105'}] as RisexMarket[];
  const rows=deriveLiveLiquidationRisk([candidate],market);
  assert.equal(rows.length,1);
  assert.equal(rows[0].markPrice,105);
  assert.ok(rows[0].distancePct < 5);
  assert.equal(deriveLiveLiquidationRisk([candidate],[{market_id:'1',mark_price:'100',last_price:'100'}] as RisexMarket[]).length,0);
});

test('Explorer trade tape deduplicates WS and REST updates and sorts by timestamp', () => {
  const mk=(id:string,time:string):MarketTrade=>({id,market_id:'1',time,price:'100',size:'1',maker_side:'buy',block_number:'42',log_index:'0'});
  const merged=mergeExplorerTradeTape([mk('b','1700000002000000000'),mk('a','1700000001000000000')],[mk('a','1700000001000000000'),mk('c','1700000000000000000')]);
  assert.deepEqual(merged.map(x=>x.id),['b','a','c']);
});
