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
  databaseStorageBytes:number|null;
  databaseSoftLimitBytes:number|null;
  databaseTradeWritesPaused:boolean;
}
interface LatencyRow { route:string; requests:number; p50Ms:number; p95Ms:number; errorRatePct:number;sampleSize:number }
interface BrowserPerf {
  ttfbMs:number|null;
  firstContentfulPaintMs:number|null;
  lcpMs:number|null;
  apiResourceSamples:number;
  apiRequestP95Ms:number|null;
}
const browserPerformance = (lcp:number|null):BrowserPerf => {
  const nav=performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming|undefined;
  const fcp=performance.getEntriesByName('first-contentful-paint')[0] as PerformanceEntry|undefined;
  const resourceDurations=performance.getEntriesByType('resource')
    .filter((entry)=>entry.name.includes('/api/'))
    .map((entry)=>entry.duration).filter(Number.isFinite).sort((a,b)=>a-b);
  const p95=resourceDurations.length>0
    ? resourceDurations[Math.ceil(resourceDurations.length*.95)-1] : null;
  return {
    ttfbMs:nav?Math.round(nav.responseStart-nav.requestStart):null,
    firstContentfulPaintMs:fcp?Math.round(fcp.startTime):null,
    lcpMs:lcp!==null?Math.round(lcp):null,
    apiResourceSamples:resourceDurations.length,
    apiRequestP95Ms:p95!==null?Math.round(p95):null,
  };
};


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
  const [browserPerf,setBrowserPerf]=useState<BrowserPerf|null>(null);
  const [latestLcp,setLatestLcp]=useState<number|null>(null);
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

  useEffect(()=>{
    if(!details)return;
    let observer:PerformanceObserver|null=null;
    try {
      observer=new PerformanceObserver((entryList)=>{
        const last=entryList.getEntries().at(-1);
        if(last)setLatestLcp(last.startTime);
      });
      observer.observe({type:'largest-contentful-paint',buffered:true});
    } catch { /* LCP unsupported in some embedded browsers */ }
    const tick=()=>setBrowserPerf(browserPerformance(latestLcp));
    tick();
    const interval=setInterval(tick,5000);
    return()=>{observer?.disconnect();clearInterval(interval);};
  },[details,latestLcp]);

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
          {snapshot?.databaseConnected && (
            <p className={snapshot.databaseTradeWritesPaused?'text-[#ffb02e]':'text-slate-400'}>
              Free Postgres storage: {snapshot.databaseStorageBytes!==null && snapshot.databaseStorageBytes!==undefined ? (snapshot.databaseStorageBytes/1_000_000).toFixed(0)+' MB' : 'unavailable'}
              {snapshot.databaseSoftLimitBytes ? ` / ${(snapshot.databaseSoftLimitBytes/1_000_000).toFixed(0)} MB soft limit` : ''}.
              {snapshot.databaseTradeWritesPaused ? ' Raw trade capture paused to protect free quota; existing records retained.' : ' Raw-fill quota guard active.'}
            </p>
          )}
          {browserPerf && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[10px] font-mono text-slate-400">
              <span>Browser TTFB {browserPerf.ttfbMs===null?'—':`${browserPerf.ttfbMs}ms`}</span>
              <span>FCP {browserPerf.firstContentfulPaintMs===null?'—':`${browserPerf.firstContentfulPaintMs}ms`}</span>
              <span>LCP {browserPerf.lcpMs===null?'—':`${browserPerf.lcpMs}ms`}</span>
              <span>API network p95 {browserPerf.apiRequestP95Ms===null?'—':`${browserPerf.apiRequestP95Ms}ms`} ({browserPerf.apiResourceSamples} requests)</span>
              <span className="text-slate-500">Browser-local; not uploaded or compared across users</span>
            </div>
          )}
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
