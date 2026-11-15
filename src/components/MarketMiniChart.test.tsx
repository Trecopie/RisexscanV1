import test from 'node:test';
import assert from 'node:assert/strict';
import {realPricePath} from './MarketMiniChart.tsx';

test('mini chart uses actual OHLCV timestamp positions not synthetic named-ticker seeds',()=>{
  const d=realPricePath([{time:1000,price:100},{time:2000,price:150},{time:4000,price:120}],100,30);
  assert.equal(d,'M 2.00 27.00 L 34.00 3.00 L 98.00 17.40');
});
test('missing one-candle history draws no invented line',()=>{
  assert.equal(realPricePath([{time:1000,price:100}],100,30),'');
  assert.equal(realPricePath([{time:1000,price:100},{time:1000,price:101}],100,30),'');
});
