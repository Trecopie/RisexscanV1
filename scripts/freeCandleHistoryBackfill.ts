/**
 * Free, bounded recovery of historical market observations from the public
 * RISEx 1-day OHLCV API. Delisted/non-published markets may still be missing.
 *
 * Database columns are explicitly CANDLE-DERIVED ESTIMATES, not venue total
 * lifetime volume or audited account fees. Calibrate volume unit against
 * official last-24h USD quote volume before writing any USD rows.
 */
import 'dotenv/config';
import {Pool} from 'pg';
import {
  calibrateCandleVolume,dailyVolumeEstimate,normalizeDailyCandle,
  type DailyRisexCandle,
} from '../src/utils/historicalCandleVolume.ts';

const API='https://api.rise.trade';
const DATABASE_SOFT_LIMIT=600_000_000;
const BUDGET_MS=6*60_000;
const DAY=86_400_000;
const started=Date.now();
const deadline=started+BUDGET_MS;
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));

async function requestJson(url:string):Promise<any>{
  for(let attempt=0;attempt<2;attempt++){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),11_000);
    try{
      const res=await fetch(url,{headers:{Accept:'application/json'},signal:controller.signal});
      if(!res.ok)throw Error('Upstream HTTP '+res.status);
      return await res.json();
    }catch(err){
      if(attempt)throw err;
      await sleep(850);
    }finally{clearTimeout(timer);}
  }
}

async function main(){
  if(!process.env.DATABASE_URL){console.log('SKIP: DATABASE_URL unavailable');return;}
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:3,
    connectionTimeoutMillis:7000,idleTimeoutMillis:15000});
  try{
    const size=await pool.query('SELECT pg_database_size(current_database()) AS bytes');
    if(Number(size.rows[0]?.bytes)>=DATABASE_SOFT_LIMIT){
      console.warn('SKIP: Neon free storage safety threshold reached');return;
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS risexscan_candle_daily(
        market_id TEXT NOT NULL,
        day_ms BIGINT NOT NULL,
        estimated_volume_usd DOUBLE PRECISION NOT NULL,
        volume_mode TEXT NOT NULL CHECK(volume_mode IN ('base','quote')),
        source TEXT NOT NULL DEFAULT 'RISEx 1D OHLCV',
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(market_id,day_ms)
      );
      CREATE INDEX IF NOT EXISTS risexscan_candle_daily_day
        ON risexscan_candle_daily(day_ms);
    `);
    const m=await requestJson(API+'/v1/markets');
    const markets:Array<any>=(m?.data?.markets||[]).filter((x:any)=>
      /^\d{1,6}$/.test(String(x.market_id))&&
      Number(x.mark_price||x.last_price)>0);
    const toNs=(BigInt(Date.now())*1_000_000n).toString();
    // Covers RISEx's early mainnet life, while avoiding imaginary pre-launch rows.
    const fromNs=(BigInt(Date.UTC(2025,0,1))*1_000_000n).toString();
    let next=0,rows=0,verified=0,unknown=0,failed=0;
    const perMarket:Array<string>=[];
    const runner=async()=>{
      while(next<markets.length&&Date.now()<deadline-20_000){
        const market=markets[next++];
        const id=String(market.market_id);
        try{
          const url=API+'/v1/markets/id/'+id+'/trading-view-data?interval=86400000000000&from='+fromNs+'&to='+toNs;
          const response=await requestJson(url);
          const raw:any[]=response?.data?.data||[];
          const dailyMap=new Map<number,DailyRisexCandle>();
          for(const value of raw){
            const candle=normalizeDailyCandle(value);
            if(candle&&candle.time<=Date.now()+DAY&&candle.time>=Date.UTC(2025,0,1))
              dailyMap.set(candle.time,candle);
          }
          const candles=[...dailyMap.values()].sort((a,b)=>a.time-b.time);
          const officialUsd=Number(market.quote_volume_24h||0);
          const calibrated=calibrateCandleVolume(candles,officialUsd,Date.now());
          if(calibrated.mode==='unverified'){
            unknown++;
            perMarket.push(id+': unverified unit; no USD records written');
            continue;
          }
          const mode=calibrated.mode;
          // Persist confirmed-mode candle estimates. Latest partial day is
          // never counted as a complete historical daily volume.
          const cutoff=Math.floor(Date.now()/DAY)*DAY;
          const eligible=candles.filter(candle=>candle.time<cutoff)
            .map(candle=>({day:candle.time,usd:dailyVolumeEstimate(candle,mode)}))
            .filter(row=>row.usd>=0&&Number.isFinite(row.usd));
          let added=0;
          // Batch UPSERT: one Neon round-trip per <=250 candle rows.
          // A per-candle query would exhaust free GitHub Actions minutes.
          for(let at=0;at<eligible.length&&Date.now()<deadline-10000;at+=250){
            const batch=eligible.slice(at,at+250);
            const params:Array<string|number>=[];
            const values=batch.map((row,i)=>{
              params.push(id,row.day,row.usd,mode);
              const p=i*4;
              return '('+[1,2,3,4].map(j=>'$'+(p+j)).join(',')+')';
            });
            await pool.query(
              'INSERT INTO risexscan_candle_daily(market_id,day_ms,estimated_volume_usd,volume_mode) VALUES '+
              values.join(',')+
              ' ON CONFLICT(market_id,day_ms) DO UPDATE SET estimated_volume_usd=EXCLUDED.estimated_volume_usd, '+
              'volume_mode=EXCLUDED.volume_mode,fetched_at=now()',
              params
            );
            added+=batch.length;rows+=batch.length;
          }
          verified++;
          perMarket.push(id+': '+mode+' '+added+' UTC days; live24h comparison difference '+Math.round((calibrated.relativeDifference||0)*100)+'%');
        }catch(err){
          failed++;
          perMarket.push(id+': unavailable ('+String(err).slice(0,100)+')');
        }
      }
    };
    await Promise.all([runner(),runner(),runner(),runner()]);
    console.log('Candle-derived history: markets='+markets.length+' calibrated='+verified+
      ' unverified='+unknown+' failed='+failed+' persistedMarketDays='+rows+
      ' durationMs='+(Date.now()-started));
    for(const line of perMarket.slice(0,130))console.log(line);
    if(!verified)throw Error('No market passed currency-unit calibration; no historical volume claimed');
  }finally{await pool.end();}
}
main().catch(err=>{console.error('Historical candle sampler stopped:',String(err));process.exitCode=1;});
