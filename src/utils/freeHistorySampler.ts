import type { ObservedTradeRecord, PersistedMarketSnapshot } from './historyStore.ts';

const num=(v:unknown):number|null=>{
  if(v===null || v===undefined || v==='')return null;
  const n=Number(v);
  return Number.isFinite(n) ? n : null;
};
const address=(v:unknown):string|null=>{
  const text=String(v||'');
  return /^0x[a-f0-9]{40}$/i.test(text) ? text.toLowerCase() : null;
};
/** The public RISEx REST trade-history timestamp is nanoseconds. */
export function publicTradeMs(raw:unknown):number|null {
  if (typeof raw!=='string' && typeof raw!=='number')return null;
  const str=String(raw);
  if(!/^\d{10,20}$/.test(str))return null;
  try{
    const rawValue=BigInt(str);
    const ms=str.length>=17?Number(rawValue/1000000n):str.length>=13?Number(rawValue):Number(rawValue*1000n);
    return Number.isFinite(ms) && ms>=1_500_000_000_000 && ms<=Date.now()+300_000?ms:null;
  }catch{return null;}
}
export function normalizeObservedPublicTrade(raw:unknown,marketId:string):ObservedTradeRecord|null {
  if(!raw || typeof raw!=='object')return null;
  const v=raw as Record<string,unknown>;
  const price=num(v.price),size=num(v.size);
  const time=publicTradeMs(v.time ?? v.timestamp ?? v.worker_timestamp);
  const id=String(v.id ?? '');
  if(!/^\d+$/.test(marketId) || !id || id.length>300 || !price || price<=0 || !size || size<=0 || time===null)return null;
  const feeParts=[v.fee_maker,v.fee_taker,v.fee_liquidation].filter(value=>value!==null && value!==undefined && value!=='');
  const validFees=feeParts.map(num);
  return {
    marketId,tradeId:id,timestampMs:time,notionalUsd:price*size,
    feeUsd:validFees.length>0 && validFees.every(v=>v!==null)?validFees.reduce<number>((sum,n)=>sum+(n??0),0):null,
    maker:address(v.maker),taker:address(v.taker),
    makerSide:v.maker_side==='0'||v.maker_side===0?0:v.maker_side==='1'||v.maker_side===1?1:null,
    price:String(v.price),size:String(v.size),
  };
}

export function normalizePublicMarketSample(raw:unknown,observedAt=Date.now()):PersistedMarketSnapshot|null {
  if(!raw || typeof raw!=='object')return null;
  const market=raw as Record<string,unknown>;
  const marketId=String(market.market_id??'');
  const markPrice=num(market.mark_price),oi=num(market.open_interest),volume=num(market.quote_volume_24h);
  const funding=num(market.current_funding_rate);
  if (!/^\d+$/.test(marketId) || market.active===false ||
      markPrice===null || markPrice<=0 || oi===null || oi<0 ||
      volume===null || volume<0 || funding===null) return null;
  return {
    marketId,observedAt,markPrice,
    openInterestUsd:oi*markPrice,
    volume24hUsd:volume,
    fundingRate:funding,
  };
}

/** Explicitly bounded public REST catchup: not an exchange-wide archive. */
export const FREE_CATCHUP_PER_MARKET_LIMIT=250;
export const FREE_SAMPLER_MAX_MARKETS=100;
