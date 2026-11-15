import React,{useMemo,useState} from 'react';
import {Activity,ArrowUpRight} from 'lucide-react';
import type {RisexMarket} from '../types/risex';
import {TokenBadge} from './TokenBadge';
import {buildMarketHeatmap} from '../utils/marketHeatmap';
import {formatUsd} from '../utils/format';

type MarketGroup='all'|'crypto'|'rwa';
export const MarketHeatmap:React.FC<{
  markets:RisexMarket[];
  onSelectMarket:(id:string)=>void;
  onAllMarkets:()=>void;
}>=({markets,onSelectMarket,onAllMarkets})=>{
  const [group,setGroup]=useState<MarketGroup>('all');
  const tiles=useMemo(()=>buildMarketHeatmap(markets),[markets]);
  const marketById=useMemo(()=>new Map(markets.map(m=>[String(m.market_id),m])),[markets]);
  const visible=useMemo(()=>tiles.filter(t=>group==='all'||t.sector===group),[tiles,group]);
  const up=visible.filter(t=>t.changePct>0).length;
  const down=visible.filter(t=>t.changePct<0).length;
  return <section className="sunrise-card rounded-2xl p-4 sm:p-5" aria-label="Live market heatmap">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-[#46a6ff]"/>
          <h2 className="font-display text-base font-bold text-[#e8edfb]">Market Heatmap</h2>
          <span className="rounded bg-[#22e0a1]/10 px-2 py-0.5 text-[10px] font-mono text-[#22e0a1]">LIVE</span>
        </div>
        <p className="text-[11px] text-slate-400">
          24h price move · high/low range · market volume. Tile size and brightness reflect activity.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Heatmap markets" className="flex rounded-lg border border-slate-800 bg-[#070b14] p-0.5">
          {([['all','All'],['crypto','Crypto'],['rwa','RWA']] as const).map(([key,label])=>
            <button key={key} type="button" aria-pressed={group===key} onClick={()=>setGroup(key)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-mono ${group===key?'bg-[#ffb02e] font-semibold text-[#1d1205]':'text-slate-400 hover:text-white'}`}>{label}</button>)}
        </div>
        <button onClick={onAllMarkets} type="button" className="inline-flex items-center gap-1 text-xs font-mono text-[#ffb02e] hover:underline">
          Screener <ArrowUpRight className="h-3.5 w-3.5"/>
        </button>
      </div>
    </div>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono tabular-nums text-slate-400">
      <span>{visible.length} active markets · <strong className="text-[#22e0a1]">{up} up</strong> · <strong className="text-[#ff4d6d]">{down} down</strong></span>
      <span className="flex items-center gap-1.5"><span className="text-[#ff4d6d]">−</span>
        <span className="h-2 w-14 rounded bg-gradient-to-r from-[#ff4d6d] via-[#64748b] to-[#22e0a1]"/>
        <span className="text-[#22e0a1]">+</span> · brightness = volume
      </span>
    </div>
    <div className="grid auto-rows-[70px] grid-flow-row-dense grid-cols-3 gap-1.5 sm:grid-cols-5 lg:grid-cols-9 xl:grid-cols-12" role="list">
      {visible.map((t,i)=>{
        const positive=t.changePct>0,negative=t.changePct<0;
        const rgb=positive?'34,224,161':negative?'255,77,109':'100,116,139';
        const alpha=.13+.48*t.intensity;
        const enlarged=(group==='all'&&i<3);
        return <button key={t.id} role="listitem" type="button"
          className={`market-heat-tile group relative flex min-w-0 flex-col justify-between overflow-hidden rounded-lg border p-2 text-left shadow-sm transition-all duration-200 hover:z-10 hover:scale-[1.025] hover:ring-1 hover:ring-[#ffb02e]/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ffb02e] ${enlarged?'sm:col-span-2 sm:row-span-2':''}`}
          style={{backgroundColor:`rgba(${rgb},${alpha.toFixed(3)})`,
            borderColor:`rgba(${rgb},${(.29+.4*t.intensity).toFixed(3)})`}}
          onClick={()=>onSelectMarket(t.id)}
          aria-label={`${t.symbol}, 24h move ${t.changePct.toFixed(2)} percent, 24h high-low range ${t.rangePct===null?'unknown':t.rangePct.toFixed(2)+' percent'}, volume ${formatUsd(t.volumeUsd)}`}
          title={`${t.symbol} · 24h move ${t.changePct>=0?'+':''}${t.changePct.toFixed(2)}% · High/low range ${t.rangePct===null?'n/a':t.rangePct.toFixed(2)+'%'} · 24h volume ${formatUsd(t.volumeUsd)}`}>
          <div className="flex w-full items-start justify-between gap-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <TokenBadge symbol={t.symbol} category={marketById.get(t.id)?.category} size={enlarged?23:18}/>
              <span className={`truncate font-display font-bold text-[#e8edfb] ${enlarged?'text-sm':'text-[11px]'}`}>{t.symbol}</span>
            </span>
            {enlarged&&<ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-slate-300 opacity-60"/>}
          </div>
          <div className="min-w-0">
            <span className={`block font-mono font-bold tabular-nums ${enlarged?'text-base':'text-xs'} ${positive?'text-[#62ffcc]':negative?'text-[#ff8ea2]':'text-slate-200'}`}>
              {t.changePct>=0?'+':''}{t.changePct.toFixed(2)}%
            </span>
            <div className="flex items-end justify-between gap-1 font-mono text-[10px] text-slate-200">
              <span className="truncate">{formatUsd(t.volumeUsd,true)}</span>
              {enlarged&&<span className="whitespace-nowrap text-[9px] text-slate-300">RNG {t.rangePct===null?'—':t.rangePct.toFixed(1)+'%'}</span>}
            </div>
          </div>
        </button>;
      })}
    </div>
    {!visible.length&&<p className="py-8 text-center text-xs text-slate-400">Waiting for the public RISEx markets feed.</p>}
    <p className="mt-2 text-[10px] text-slate-500">Live 24h high/low range is a price-movement proxy, not statistical realized volatility.</p>
  </section>;
};
