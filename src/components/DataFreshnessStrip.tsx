import React, {useEffect,useState} from 'react';
import {useMarketStream} from '../context/MarketWebSocketContext';

interface Freshness {
  fetchedAt:number;
  marketsRestUpdatedAt:number|null;
  walletIndexCompletedAt:number|null;
  indexedTraders:number;
  enrichedTraders:number;
  databaseConnected:boolean;
  tradesWsConnected:boolean;
  lastObservedTradeAt:number|null;
  tradeEventsDropped:number;
  historicalCoverageComplete:boolean;
}
interface LatencyRow { route:string; requests:number; p50Ms:number; p95Ms:number; errorRatePct:number;sampleSize:number }

const age=(time:number|null,now:number) => {
  if (!time) return 'not available';
  const secs=Math.max(0,Math.floor((now-time)/1000));
  if (secs<60)return `${secs}s ago`;
  if (secs<3600)return `${Math.floor(secs/60)}m ago`;
  return `${Math.floor(secs/3600)}h ago`;
};

/** Source freshness and sampling are explicit; WS connection alone does not
 * prove oracle ticks have arrived recently. */
export const DataFreshnessStrip:React.FC = () => {
  const {connectionState,lastOracleAt}=useMarketStream();
  const [details,setDetails]=useState(false);
  const [snapshot,setSnapshot]=useState<Freshness|null>(null);
  const [metrics,setMetrics]=useState<LatencyRow[]>([]);
  const [now,setNow]=useState(Date.now());

  useEffect(() => {
    const controller=new AbortController();
    const get=async()=>{
      if(document.visibilityState !== 'visible')return;
      try {
        const res=await fetch('/api/data/freshness',{signal:controller.signal,cache:'no-store'});
        if(res.ok && !controller.signal.aborted)setSnapshot(await res.json());
      } catch {/* temporary backend error doesn't blank the UI */}
    };
    void get();
    const ticker=setInterval(()=>setNow(Date.now()),2000);
    const refresh=setInterval(get,20000);
    return()=>{controller.abort();clearInterval(ticker);clearInterval(refresh);};
  },[]);

  useEffect(()=>{
    if(!details)return;
    const controller=new AbortController();
    const get=async()=>{
      try{
        const res=await fetch('/api/monitoring/performance',{signal:controller.signal,cache:'no-store'});
        if(res.ok && !controller.signal.aborted)setMetrics((await res.json()).metrics || []);
      }catch{/* no intrusive error on diagnostics */}
    };
    void get();
    const timer=setInterval(get,20000);
    return()=>{controller.abort();clearInterval(timer);};
  },[details]);

  const oracleFresh=connectionState==='connected' && lastOracleAt!==null && now-lastOracleAt < 12000;
  return (
    <div className="relative z-10 border-b border-slate-800/60 bg-[#070b14]/95">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-2 px-4 py-1.5 text-[10px] font-mono sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-400">
          <span className={oracleFresh ? 'text-[#22e0a1]' : 'text-[#ffb02e]'}>
            {oracleFresh ? '● Oracle live' : connectionState==='connected' ? '○ Oracle idle' : '○ Oracle reconnecting'}
            {lastOracleAt && ` · ${age(lastOracleAt,now)}`}
          </span>
          <span>Markets REST {age(snapshot?.marketsRestUpdatedAt ?? null,now)}</span>
          <span>Wallet index {age(snapshot?.walletIndexCompletedAt ?? null,now)}</span>
          <span className={snapshot?.databaseConnected ? 'text-[#22e0a1]' : 'text-[#ffb02e]'}>
            History {snapshot?.databaseConnected ? 'PostgreSQL' : 'ephemeral'}
          </span>
          <span className="text-slate-500">Indexed accounts ≠ all-time venue coverage</span>
        </div>
        <button
          type="button"
          onClick={()=>setDetails(v=>!v)}
          aria-expanded={details}
          className="shrink-0 rounded border border-slate-800 px-2 py-0.5 text-slate-300 hover:border-[#ffb02e]/40 hover:text-[#ffb02e]"
        >{details?'Hide diagnostics':'Data & latency'}</button>
      </div>
      {details && (
        <div className="mx-auto max-w-[1440px] space-y-2 border-t border-slate-800/50 px-4 py-3 text-xs text-slate-400 sm:px-6">
          <p>
            {snapshot?.enrichedTraders.toLocaleString() || '—'} enriched / {snapshot?.indexedTraders.toLocaleString() || '—'} discovered accounts.
            Historical wallet and trade coverage is incomplete. Live observed trades {snapshot?.tradesWsConnected?'connected':'disconnected'}.
            {snapshot?.tradeEventsDropped ? ` ${snapshot.tradeEventsDropped} events dropped in this process.` : ''}
          </p>
          {metrics.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full max-w-2xl text-left font-mono text-[10px] tabular-nums">
                <thead><tr className="text-slate-500"><th className="py-1">API</th><th>p50</th><th>p95</th><th>Errors</th><th>Samples</th></tr></thead>
                <tbody>{metrics.slice(0,8).map(m=><tr key={m.route} className="border-t border-slate-800/40">
                  <td className="py-1 pr-3">{m.route}</td>
                  <td>{m.p50Ms}ms</td><td>{m.p95Ms}ms</td><td>{m.errorRatePct}%</td><td>{m.sampleSize}</td>
                </tr>)}</tbody>
              </table>
              <p className="mt-1 text-[10px] text-slate-500">In-process sample only; resets after server restart. It measures backend handling, not browser paint latency.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
