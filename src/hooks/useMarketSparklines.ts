import {useEffect,useState} from 'react';
export interface MiniPricePoint {time:number;price:number}
export interface MiniPriceSeries {points:MiniPricePoint[];lastCandleAt:number|null}

const cache=new Map<string,{expiresAt:number;data:MiniPriceSeries}>();

/** Batched, cached real hourly RISEx candles. Falls back to genuine 24h move
 * meters while historical candles are loading/unavailable, never fake lines. */
export function useMarketSparklines(ids:string[]):Record<string,MiniPriceSeries> {
  const key=[...new Set(ids.filter(id=>/^\d{1,6}$/.test(id)))].sort((a,b)=>Number(a)-Number(b)).slice(0,30).join(',');
  const [result,setResult]=useState<Record<string,MiniPriceSeries>>({});
  useEffect(()=>{
    if(!key)return;
    const controller=new AbortController();
    const now=Date.now();
    const needed=key.split(',').filter(id=>!cache.get(id) || cache.get(id)!.expiresAt<=now);
    const cached:Record<string,MiniPriceSeries>={};
    for(const id of key.split(',')){const item=cache.get(id);if(item && item.expiresAt>now)cached[id]=item.data;}
    setResult(prev=>({...prev,...cached}));
    // Let leading visible market cards paint genuine OHLCV as each small
    // batch resolves, rather than awaiting up to 30 upstream requests in one
    // monolithic response. Cached percent-change meters remain the fallback.
    for(let offset=0;offset<needed.length;offset+=6){
      const batch=needed.slice(offset,offset+6);
      fetch(`/api/markets/sparklines?ids=${batch.join(',')}`,{signal:controller.signal})
        .then(response=>response.ok ? response.json() : null)
        .then(data=>{
          if(controller.signal.aborted || !data?.series)return;
          const fetched:Record<string,MiniPriceSeries>={};
          for(const [id,series] of Object.entries(data.series as Record<string,MiniPriceSeries>)) {
            if(!Array.isArray(series?.points))continue;
            cache.set(id,{data:series,expiresAt:Date.now()+300000});
            fetched[id]=series;
          }
          setResult(prev=>({...prev,...fetched}));
        }).catch(()=>{});
    }
    return()=>controller.abort();
  },[key]);
  return result;
}
