import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMarketHeatmap} from './marketHeatmap';
import type {RisexMarket} from '../types/risex';
const row=(id:string,base:string,volume:string,high:string,low:string,active=true):RisexMarket=>({
  market_id:id,base_asset_symbol:base,display_name:base+'/USDC',
  quote_volume_24h:volume,high_24h:high,low_24h:low,
  change_24h:'10',mark_price:'110',active,category:base==='SPY'?'index_etf':'crypto',
} as RisexMarket);
test('heatmap uses actual market price high/low, volume, and active flags',()=>{
  const cells=buildMarketHeatmap([
    row('1','BTC','1000','120','100'),row('2','SPY','100','115','105'),
    row('3','ETH','9999','110','100',false),
  ]);
  assert.equal(cells.length,2);
  assert.equal(cells[0].symbol,'BTC');
  assert.equal(cells[1].sector,'rwa');
  assert.ok(Math.abs(cells[0].rangePct!-18.181818)<.001);
  assert.ok(Math.abs(cells.reduce((s,c)=>s+c.sharePct,0)-100)<.000001);
  assert.ok(cells[0].intensity>=cells[1].intensity);
  assert.ok(cells.every(c=>c.intensity>=.12&&c.intensity<=1));
});
test('missing range does not create imaginary volatility',()=>{
  const c=buildMarketHeatmap([row('1','BTC','0','0','0')])[0];
  assert.equal(c.rangePct,null);
  assert.equal(c.sharePct,0);
});
