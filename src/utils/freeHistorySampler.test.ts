import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeObservedPublicTrade,normalizePublicMarketSample,publicTradeMs} from './freeHistorySampler.ts';

test('public trade timestamp decoder accepts RISEx nanosecond strings but rejects unknown units',()=>{
  const ms=Date.now()-20000;
  assert.equal(publicTradeMs((BigInt(ms)*1000000n).toString()),ms);
  assert.equal(publicTradeMs(String(ms)),ms);
  assert.equal(publicTradeMs(String(Math.floor(ms/1000))),Math.floor(ms/1000)*1000);
  assert.equal(publicTradeMs('1799.023'),null);
  assert.equal(publicTradeMs('too old'),null);
});
test('bounded REST trade conversion stores decimal notional, IDs and only reported fees',()=>{
  const ms=Date.now()-35000;
  const rec=normalizeObservedPublicTrade({
    id:'abc-def',price:'50250.25',size:'0.1',time:(BigInt(ms)*1000000n).toString(),
    maker_side:0,maker:'0x'+'1'.repeat(40),taker:'0x'+'2'.repeat(40),
    fee_maker:'0.012',fee_taker:'0.023',fee_liquidation:'0',
  },'4')!;
  assert.ok(rec);assert.equal(rec.notionalUsd,5025.025);assert.equal(rec.feeUsd,0.035);
  assert.equal(rec.makerSide,0);
  assert.equal(rec.maker,'0x'+'1'.repeat(40));
  assert.equal(normalizeObservedPublicTrade({...rec,time:'0'},'4'),null);
  const missingFee=normalizeObservedPublicTrade({
    id:'next',price:'100',size:'2',time:(BigInt(ms)*1000000n).toString(),
  },'4');
  assert.equal(missingFee?.feeUsd,null);
});
test('never create invented market OI or volume when official fields are absent',()=>{
  const source={market_id:7,active:true,mark_price:'65000',open_interest:'2',quote_volume_24h:'150000',current_funding_rate:'0'};
  assert.deepEqual(normalizePublicMarketSample(source,1234),{
    marketId:'7',observedAt:1234,markPrice:65000,openInterestUsd:130000,volume24hUsd:150000,fundingRate:0,
  });
  assert.equal(normalizePublicMarketSample({...source,mark_price:''}),null);
  assert.equal(normalizePublicMarketSample({...source,open_interest:undefined}),null);
  assert.equal(normalizePublicMarketSample({...source,active:false}),null);
});
