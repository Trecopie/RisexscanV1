import React,{useEffect,useMemo,useState} from 'react';
import {useMarketStream} from '../context/MarketWebSocketContext';
import {deriveLiveLiquidationRisk,type ExplorerRiskCandidate} from '../utils/explorerLive';
import {formatPct,formatPrice,formatUsd} from '../utils/format';
import {TokenBadge} from './TraderAvatar';

const STORAGE='risexscan_watchlist_risk_v1';
const read=():string[]=>{
  try{const parsed=JSON.parse(localStorage.getItem(STORAGE)||'[]');return Array.isArray(parsed)?parsed.filter(v=>typeof v==='string').slice(0,18):[];}catch{return[];}
};
export const FundingRiskWatchlist:React.FC<{onSelectMarket:(id:string)=>void}> = ({onSelectMarket})=>{
  const {markets,connectionState,lastOracleAt}=useMarketStream();
  const [selected,setSelected]=useState<string[]>(read);
  const [marketToAdd,setMarketToAdd]=useState('');
  const [fundingThreshold,setFundingThreshold]=useState(20);
  const [candidates,setCandidates]=useState<ExplorerRiskCandidate[]>([]);
  const [riskFetchedAt,setRiskFetchedAt]=useState<number|null>(null);
  useEffect(()=>{
    try{localStorage.setItem(STORAGE,JSON.stringify(selected));}catch{/* unavailable storage */}
  },[selected]);
  useEffect(()=>{
    const controller=new AbortController();
    const refresh=async()=>{
      if(document.visibilityState==='hidden')return;
      try{
        const resp=await fetch('/api/liquidations',{signal:controller.signal,cache:'no-store'});
        if(!resp.ok) return;
        const data=await resp.json();
        if(!controller.signal.aborted){
          setCandidates(Array.isArray(data.candidates)?data.candidates:[]);
          setRiskFetchedAt(Date.now());
        }
      }catch{/* fall back to previous indexed positions with stale warning */}
    };
    void refresh();
    const timer=setInterval(refresh,20000);
    return()=>{clearInterval(timer);controller.abort();};
  },[]);
  const byId=useMemo(()=>new Map(markets.map(m=>[String(m.market_id),m])),[markets]);
  const selectedMarkets=useMemo(()=>selected.map(id=>byId.get(id)).filter((m):m is typeof markets[number]=>!!m),[selected,byId]);
  const affectedPositions=useMemo(()=>deriveLiveLiquidationRisk(candidates,markets,500).filter(p=>selected.includes(p.marketId)),[candidates,markets,selected]);
  const interesting=selectedMarkets.filter(m=>Math.abs(Number(m.current_funding_rate||0)*24*365*100)>=fundingThreshold);
  const freshness=(lastOracleAt!==null && Date.now()-lastOracleAt<20000 && connectionState==='connected');
  return <section className="sunrise-card rounded-xl p-4 sm:p-5 space-y-3" aria-label="Funding and liquidation watchlist">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="font-display text-base font-bold text-[#e8edfb]">Funding & Liquidation Watchlist</h2>
        <p className="mt-1 text-xs text-slate-400">Your selected RISEx markets · current funding APR and tracked positions within 5% of liquidation.</p>
      </div>
      <span className={freshness?'font-mono text-[10px] text-[#22e0a1]':'font-mono text-[10px] text-[#ffb02e]'}>
        {freshness?'● Oracle current':'○ Oracle / indexed fallback'}
      </span>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={marketToAdd}
        onChange={e=>setMarketToAdd(e.target.value)}
        className="max-w-[280px] rounded-lg border border-slate-700 bg-[#080d18] px-2 py-1.5 text-xs text-slate-300"
        aria-label="Select market to watch"
      >
        <option value="">Select a market…</option>
        {markets.filter(m=>m.active!==false && !selected.includes(String(m.market_id))).map(m=>
          <option key={m.market_id} value={String(m.market_id)}>{m.display_name}</option>)}
      </select>
      <button
        type="button"
        disabled={!marketToAdd || selected.length>=18}
        onClick={()=>{
          if(marketToAdd && !selected.includes(marketToAdd))setSelected(prev=>[...prev,marketToAdd].slice(0,18));
          setMarketToAdd('');
        }}
        className="rounded-lg border border-[#ffb02e]/40 px-3 py-1.5 text-xs text-[#ffb02e] disabled:opacity-40"
      >+ Watch</button>
      <label className="flex items-center gap-2 text-[11px] font-mono text-slate-400">
        Alert APR ≥
        <select
          value={fundingThreshold}
          onChange={e=>setFundingThreshold(Number(e.target.value))}
          className="rounded-lg border border-slate-700 bg-[#080d18] px-2 py-1 text-slate-300"
        >
          {[10,20,50,100].map(n=><option key={n} value={n}>{n}%</option>)}
        </select>
      </label>
    </div>
    {!selectedMarkets.length
      ? <div className="rounded-lg border border-slate-800 bg-[#080d18] p-5 text-center text-xs text-slate-500">Choose a market to build a local on-page watchlist. No orders or notifications are sent.</div>
      : <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        {selectedMarkets.map(m=>{
          const apr=Number(m.current_funding_rate||0)*24*365*100;
          const high=interesting.some(item=>String(item.market_id)===String(m.market_id));
          const risk=affectedPositions.filter(p=>p.marketId===String(m.market_id));
          return <div key={m.market_id} className="rounded-xl border border-slate-800 bg-[#080d18] p-3">
            <div className="flex items-center justify-between gap-2">
              <button type="button" onClick={()=>onSelectMarket(String(m.market_id))} className="flex items-center gap-2 text-xs font-semibold text-[#e8edfb] hover:text-[#ffb02e]">
                <TokenBadge symbol={m.base_asset_symbol} category={m.category} size={24}/>{m.display_name}
              </button>
              <button type="button" onClick={()=>setSelected(v=>v.filter(id=>id!==String(m.market_id)))} className="px-1 text-slate-500 hover:text-[#ff4d6d]" aria-label={`Remove ${m.display_name} from watchlist`}>×</button>
            </div>
            <div className="mt-3 flex items-center justify-between gap-2 font-mono text-xs tabular-nums">
              <span className="text-slate-400">Mark {formatPrice(m.mark_price)}</span>
              <span className={high?'text-[#ffb02e] font-bold':apr>=0?'text-[#22e0a1]':'text-[#ff4d6d]'}>
                {formatPct(apr)} APR
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between text-[10px] font-mono">
              <span className="text-slate-500">Tracked &lt;5% liq positions</span>
              <span className={risk.length?'text-[#ff4d6d] font-bold':'text-slate-400'}>{risk.length}</span>
            </div>
          </div>;
        })}
      </div>}
    <p className="text-[10px] text-slate-500">
      Funding APR is annualized from the current hourly rate (not guaranteed future yield).
      Liquidation distances use current available marks with cached indexed positions. Last risk refresh {riskFetchedAt ? new Date(riskFetchedAt).toLocaleTimeString():'not available'}.
      Alerts are visual only while this page is open, not browser push notifications.
    </p>
  </section>;
};
