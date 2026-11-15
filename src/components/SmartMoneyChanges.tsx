import React,{useEffect,useMemo,useState} from 'react';
import {formatSignedUsd,formatUsd} from '../utils/format';
import {TokenBadge} from './TraderAvatar';

type Change={
  marketId:string;cohort:string;fromTime:number;toTime:number;
  previousNetUsd:number;currentNetUsd:number;deltaNetUsd:number;
  currentLongUsd:number;currentShortUsd:number;positionCount:number;
};
interface Response {
  completeHistory:false;fromTime:number|null;toTime:number|null;changes:Change[];
  indexedTraders:number;note:string;
}
const tiers=['all','whale','shark','dolphin','fish','shrimp'] as const;

/** Position deltas from successive indexed snapshots, NOT trade executions.
 * Only tracked accounts are included; this is intentionally a separate panel. */
export const SmartMoneyChanges:React.FC<{
  marketNames?:Record<string,string>;
  onSelectMarket:(id:string)=>void;
}> = ({marketNames={},onSelectMarket})=>{
  const [data,setData]=useState<Response|null>(null);
  const [tier,setTier]=useState<string>('all');
  const [error,setError]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();
    const refresh=async()=>{
      if(document.visibilityState==='hidden')return;
      try{
        const res=await fetch('/api/analytics/position-changes',{signal:controller.signal});
        if(!res.ok)throw Error('Position change feed unavailable');
        if(!controller.signal.aborted){setData(await res.json());setError(false);}
      }catch{if(!controller.signal.aborted)setError(true);}
    };
    void refresh();
    const timer=setInterval(refresh,60000);
    return()=>{clearInterval(timer);controller.abort();};
  },[]);
  const rows=useMemo(()=>data?.changes.filter(row=>tier==='all'||row.cohort===tier).slice(0,12) || [],[data,tier]);
  return <section className="sunrise-card rounded-xl p-4 sm:p-5 space-y-3">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="font-display text-base font-bold text-[#e8edfb]">Smart Money · Positioning Changes</h2>
        <p className="mt-1 text-xs text-slate-400">Hourly changes in indexed trader long/short notional, grouped by account-size cohort.</p>
      </div>
      <div role="group" aria-label="Trader cohort to inspect" className="flex flex-wrap gap-1">
        {tiers.map(id=><button
          key={id}
          type="button"
          onClick={()=>setTier(id)}
          className={`rounded-lg border px-2.5 py-1 text-[10px] font-mono capitalize transition-colors ${tier===id?'border-[#ffb02e] bg-[#ffb02e]/15 text-[#ffb02e]':'border-slate-800 text-slate-400 hover:text-white'}`}
        >{id}</button>)}
      </div>
    </div>
    {!data?.fromTime||!data?.toTime ? (
      <div className="rounded-lg border border-slate-800 bg-[#080d18] px-4 py-6 text-center text-xs text-slate-400">
        {error?'Could not load position change history. ':'Waiting for two complete hourly PostgreSQL snapshots. '}
        Indexed snapshots require the optional persistent history service.
      </div>
    ):<>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono text-slate-500">
        <span>From {new Date(data.fromTime).toLocaleString()}</span>
        <span>To {new Date(data.toTime).toLocaleString()}</span>
        <span>{data.indexedTraders.toLocaleString()} discovered accounts (not all enriched)</span>
      </div>
      {rows.length===0 ? <div className="py-5 text-center text-xs text-slate-500">No comparable positioning changes for this cohort.</div> :
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[11px] font-mono tabular-nums">
            <thead className="text-slate-500 uppercase">
              <tr><th className="py-2">Market</th><th>Cohort</th><th className="text-right">Net Δ</th><th className="text-right">Long</th><th className="text-right">Short</th><th className="text-right">Indexed pos.</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">{rows.map(row=><tr key={row.marketId+row.cohort} className="hover:bg-[#131c31]/40">
              <td className="py-2"><button type="button" className="flex items-center gap-2 text-[#e8edfb] hover:text-[#ffb02e]" onClick={()=>onSelectMarket(row.marketId)}>
                <TokenBadge symbol={marketNames[row.marketId]||row.marketId} size={19}/>
                {marketNames[row.marketId] || `Market #${row.marketId}`}
              </button></td>
              <td className="py-2 capitalize text-slate-300">{row.cohort}</td>
              <td className={`py-2 text-right font-semibold ${row.deltaNetUsd>=0?'text-[#22e0a1]':'text-[#ff4d6d]'}`}>{formatSignedUsd(row.deltaNetUsd,true)}</td>
              <td className="py-2 text-right text-[#22e0a1]">{formatUsd(row.currentLongUsd,true)}</td>
              <td className="py-2 text-right text-[#ff4d6d]">{formatUsd(row.currentShortUsd,true)}</td>
              <td className="py-2 text-right text-slate-400">{row.positionCount}</td>
            </tr>)}</tbody>
          </table>
        </div>}
      <p className="text-[10px] text-[#ffb02e]">These are successive samples of indexed account positions—not confirmed new buys/sells or an exchange-wide flow measure. Missing wallet updates and mark-price changes can affect reported differences.</p>
    </>}
  </section>;
};
