import React,{useMemo} from 'react';
import type {MiniPriceSeries} from '../hooks/useMarketSparklines';
import {MarketMoveMeter} from './Charts';

export interface MiniPricePoint {time:number;price:number}
export function realPricePath(points:MiniPricePoint[],width:number,height:number):string {
  const sorted=[...points].filter(p=>Number.isFinite(p.time) && Number.isFinite(p.price) && p.price>0)
    .sort((a,b)=>a.time-b.time);
  if(sorted.length<2 || sorted[0].time===sorted[sorted.length-1].time)return '';
  const prices=sorted.map(p=>p.price);
  const low=Math.min(...prices),high=Math.max(...prices);
  const range=Math.max(1e-12,high-low);
  const origin=sorted[0].time,span=sorted[sorted.length-1].time-origin;
  return sorted.map((p,i)=>`${i===0?'M':'L'} ${(2+(p.time-origin)/span*(width-4)).toFixed(2)} ${(height-3-(p.price-low)/range*(height-6)).toFixed(2)}`).join(' ');
}

export const MarketMiniChart:React.FC<{
  series?:MiniPriceSeries;
  changePct:number;
  width?:number;
  height?:number;
}> = ({series,changePct,width=76,height=24})=>{
  const pts=series?.points||[];
  const path=useMemo(()=>realPricePath(pts,width,height),[pts,width,height]);
  if(!path)return <MarketMoveMeter changePct={changePct} width={width} height={height}/>;
  const first=pts[0].price,last=pts[pts.length-1].price;
  const rising=last>=first;
  return <svg
    role="img"
    aria-label={`Actual RISEx 1-hour OHLCV closes over up to 24 hours; ${pts.length} observations, from ${first} to ${last}`}
    viewBox={`0 0 ${width} ${height}`}
    width={width}
    height={height}
    className="shrink-0 overflow-visible"
  >
    <title>Real RISEx hourly prices · latest candle {series?.lastCandleAt ? new Date(series.lastCandleAt).toLocaleString() : 'unknown'}</title>
    <path d={path} fill="none" stroke={rising?'#22e0a1':'#ff4d6d'} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"/>
  </svg>;
};
