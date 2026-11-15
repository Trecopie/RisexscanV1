/**
 * Free-tier-safe, restart-independent REST recovery sampler.
 * Runs for a bounded period in GitHub Actions; no server or private key needed.
 *
 * IMPORTANT: RISEx only exposes a bounded recent trade-history window through
 * this public query. Missing runs, high-volume markets, and API truncation can
 * leave gaps. Never advertise these observations as lifetime exchange totals.
 */
import { HistoryStore } from '../src/utils/historyStore.ts';
import {
  normalizeObservedPublicTrade,
  normalizePublicMarketSample,
  FREE_CATCHUP_PER_MARKET_LIMIT,
  FREE_SAMPLER_MAX_MARKETS,
} from '../src/utils/freeHistorySampler.ts';

const API='https://api.rise.trade';
const TIMEOUT_MS=8000;

async function getJson(url:string):Promise<any>{
  let lastError:unknown;
  for(let attempt=0;attempt<2;attempt++){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
    try{
      const response=await fetch(url,{signal:controller.signal,headers:{Accept:'application/json'}});
      if(!response.ok)throw Error(`RISEx HTTP ${response.status}`);
      return await response.json();
    }catch(err){
      lastError=err;
      if(attempt===0)await new Promise(resolve=>setTimeout(resolve,1500));
    }finally{clearTimeout(timer);}
  }
  throw lastError;
}

async function main():Promise<void>{
  if(!process.env.DATABASE_URL){
    console.log('SKIP: DATABASE_URL GitHub Actions secret has not been configured. No secrets required to build RISExScan.');
    return;
  }
  const store=new HistoryStore();
  try{
    await store.initialize();
    if(!store.ready)throw Error('Cannot initialize zero-cost PostgreSQL history store');
    const response=await getJson(`${API}/v1/markets`);
    const listed=response?.data?.markets;
    if(!Array.isArray(listed) || listed.length===0)throw Error('RISEx markets API returned no markets');
    const timestamp=Date.now();
    const selected=listed
      .filter((m:any)=>m?.active!==false && /^\d+$/.test(String(m?.market_id??'')))
      .slice(0,FREE_SAMPLER_MAX_MARKETS);
    const samples=selected.map((market:unknown)=>normalizePublicMarketSample(market,timestamp))
      .filter((market):market is NonNullable<typeof market>=>market!==null);
    if(samples.length>0)await store.recordMarketSamples(samples);
    console.log(`Market samples: ${samples.length} of ${selected.length} active markets`);

    let cursor=0,success=0,failed=0,records=0,empty=0;
    const worker=async()=>{
      while(cursor<selected.length){
        const index=cursor++;
        const market=selected[index];
        const marketId=String(market.market_id);
        try{
          const raw=await getJson(`${API}/v1/markets/id/${marketId}/trade-history?limit=${FREE_CATCHUP_PER_MARKET_LIMIT}`);
          const list=raw?.data?.trades ?? raw?.data?.fills ?? raw?.trades;
          if(!Array.isArray(list))throw Error('missing trade-history list');
          const parsed=list.map((x:unknown)=>normalizeObservedPublicTrade(x,marketId))
            .filter((trade):trade is NonNullable<typeof trade>=>trade!==null);
          if(parsed.length)await store.recordTrades(parsed);
          records+=parsed.length;
          if(list.length>=FREE_CATCHUP_PER_MARKET_LIMIT) {
            // A capped response may be missing more trades than can be recovered.
            console.warn(`Coverage warning: market ${marketId} reached public history cap (${list.length}).`);
          }
          if(!list.length)empty++;
          success++;
        }catch(err){
          failed++;
          console.error(`Market ${marketId}: bounded REST catchup failed`,String(err).slice(0,160));
        }
      }
    };
    await Promise.all(Array.from({length:4},()=>worker()));
    const dbState=await store.storageStatus();
    console.log(`Observed recent fills ${records}; market history requests success=${success} failed=${failed} empty=${empty}.`);
    console.log(`Database usage ${dbState.usedBytes} bytes, soft limit ${dbState.limitBytes}, inserts paused: ${dbState.writeLimited}`);
    console.log('Coverage remains incomplete: sampled REST results do not provide a canonical gapless history.');
    if(failed>Math.max(3,Math.floor(selected.length*.15)))process.exitCode=1;
  }finally{
    await store.close();
  }
}

main().catch(err=>{
  console.error('RISEx free history sampler failed:',String(err).slice(0,260));
  process.exitCode=1;
});
