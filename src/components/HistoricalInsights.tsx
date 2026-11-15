import React,{useEffect,useMemo,useState} from 'react';
import {formatUsd} from '../utils/format';

interface ChartPoint {time:number;value:number}
interface History {
  coverage:{
    source:string;completeHistory:false;databaseConnected:boolean;
    firstTradeAt:number|null;lastTradeAt:number|null;
    firstSnapshotAt:number|null;lastSnapshotAt:number|null;
    observedTrades:number;note:string;
  };
  liveCollector:{connected:boolean;lastTradeAt:number|null;droppedInMemory:number};
  dailyTrades:Array<{day:number;volumeUsd:number;reportedFeesUsd:number|null;feeEventCount:number;tradeCount:number}>;
  hourlyFees:Array<{time:number;reportedFeesUsd:number;feeEventCount:number}>;
  oiSnapshots:Array<{time:number;openInterestUsd:number;volume24hUsd:number;marketCount:number}>;
}

const actualLine=(values:ChartPoint[],width=460,height=110):string => {
  if(values.length<2)return '';
  const t0=values[0].time,t1=values[values.length-1].time;
  const min=Math.min(...values.map(v=>v.value)),max=Math.max(...values.map(v=>v.value));
  const range=Math.max(1e-9,max-min),timeRange=Math.max(1,t1-t0);
  return values.map((v,i) =>
    `${i===0?'M':'L'} ${(8+(v.time-t0)/timeRange*(width-16)).toFixed(1)} ${(height-10-(v.value-min)/range*(height-20)).toFixed(1)}`
  ).join(' ');
};

const HistorySeries:React.FC<{title:string;subtitle:string;values:ChartPoint[];color:string;unit?:'usd'|'count'}> =
  ({title,subtitle,values,color,unit='usd'})=>{
    const last=values[values.length-1]?.value??0;
    return <div className="rounded-xl border border-slate-800/80 bg-[#080d18] p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><div className="text-xs font-display font-semibold text-[#e8edfb]">{title}</div>
          <div className="mt-1 text-[10px] font-mono text-slate-500">{subtitle}</div></div>
        <span className="font-mono font-bold tabular-nums" style={{color}}>{values.length ? unit==='usd'? formatUsd(last,true):last.toLocaleString():'—'}</span>
      </div>
      {values.length>=2 ?
        <svg viewBox="0 0 460 110" className="mt-3 h-[100px] w-full" role="img" aria-label={`Recorded values of ${title}, ${values.length} points`} preserveAspectRatio="none">
          <path d={actualLine(values)} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
        </svg>
        : values.length===1 ?
          <div className="mt-3 flex h-[100px] flex-col items-center justify-center gap-2 text-xs text-slate-400" role="status">
            <span className="h-2.5 w-2.5 rounded-full" style={{backgroundColor:color}} aria-hidden="true"/>
            <span>Latest observation · trend building</span>
          </div>
        : <div className="mt-4 flex h-[100px] items-center justify-center text-xs text-slate-500">No observations recorded yet.</div>}
      {values.length>0 && <div className="flex justify-between text-[10px] font-mono text-slate-500">
        <span>{new Date(values[0].time).toLocaleDateString()}</span>
        {values.length>1 && <span>{new Date(values[values.length-1].time).toLocaleDateString()}</span>}
      </div>}
    </div>;
  };

export const HistoricalInsights:React.FC=()=>{
  const [data,setData]=useState<History|null>(null);
  const [failed,setFailed]=useState(false);
  const [protocolTvl,setProtocolTvl]=useState<ChartPoint[]>([]);
  useEffect(()=>{
    const controller=new AbortController();
    const fetchIt=async()=>{
      if(document.visibilityState==='hidden')return;
      try{
        const response=await fetch('/api/analytics/history',{signal:controller.signal});
        if(!response.ok)throw Error('history service unavailable');
        if(!controller.signal.aborted){setData(await response.json());setFailed(false);}
      }catch{if(!controller.signal.aborted)setFailed(true);}
    };
    const fetchTvl=async()=>{
      try{
        const res=await fetch('/api/analytics/protocol-tvl',{signal:controller.signal});
        if(!res.ok)return;
        const json=await res.json();
        if(!controller.signal.aborted && Array.isArray(json.tvlHistory)){
          setProtocolTvl(json.tvlHistory
            .filter((v:any)=>Number.isFinite(v.date)&&Number.isFinite(v.tvl)&&v.tvl>=0)
            .map((v:any)=>({time:v.date,value:v.tvl})));
        }
      }catch{/* Keep verified RISEx charts when DefiLlama is unavailable. */}
    };
    void fetchIt();
    void fetchTvl();
    const timer=setInterval(fetchIt,60000);
    const tvlTimer=setInterval(fetchTvl,180000);
    return()=>{controller.abort();clearInterval(timer);clearInterval(tvlTimer);};
  },[]);
  const parsed=useMemo(()=>{
    const daily=data?.dailyTrades??[];
    let volume=0,fees=0,reportedFeeEvents=0,observedTradeEvents=0;
    const cumulativeVolume:ChartPoint[]=[],cumulativeFees:ChartPoint[]=[];
    for(const d of daily){
      volume+=d.volumeUsd;
      observedTradeEvents+=d.tradeCount;
      cumulativeVolume.push({time:d.day,value:volume});
      reportedFeeEvents+=d.feeEventCount;
    }
    // Hourly reported fees are real observed trade-fee events, not daily
    // fabricated interpolation or all-time venue fees.
    for(const hour of data?.hourlyFees??[]){
      fees+=hour.reportedFeesUsd;
      cumulativeFees.push({time:hour.time,value:fees});
    }
    /* end hourly fee series */
    const oi=data?.oiSnapshots.map(d=>({time:d.time,value:d.openInterestUsd}))??[];
    return {cumulativeVolume,cumulativeFees,oi,reportedFeeEvents,observedTradeEvents};
  },[data]);
  return <section className="sunrise-card space-y-3 rounded-2xl p-4 sm:p-5" aria-label="Historical market observations">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="font-display text-base font-bold text-[#e8edfb]">Market History</h2>
        <p className="mt-1 text-xs text-slate-400">RISEx observations and independently sourced protocol TVL.</p>
      </div>
      <div className="flex items-center gap-3">
        <span className={data?.liveCollector?.connected?'text-[#22e0a1] text-[11px] font-mono':'text-[#ffb02e] text-[11px] font-mono'}>
          {data?.liveCollector?.connected?'● Live':'○ Reconnecting'}
        </span>
        <details className="relative text-xs text-slate-400">
          <summary className="cursor-pointer list-none rounded border border-slate-800 px-2 py-1 hover:text-white" title="Source definitions and limitations">Sources <span aria-hidden="true">ⓘ</span></summary>
          <div className="absolute right-0 top-full z-20 mt-2 w-72 rounded-xl border border-slate-700 bg-[#0c1323] p-3 text-[11px] leading-relaxed text-slate-300 shadow-xl sm:w-96">
            <p><strong>TVL</strong> — DefiLlama protocol historical series, not open interest.</p>
            <p className="mt-1"><strong>OI</strong> — RISEx market REST snapshots, recorded hourly.</p>
            <p className="mt-1"><strong>Volume / fees</strong> — deduplicated RISEx trades collected by WebSocket and REST; partial coverage, not exchange lifetime totals. Fees include only reported values.</p>
            <a className="mt-2 inline-block text-[#46a6ff] underline" href="https://defillama.com/protocol/risex" target="_blank" rel="noopener noreferrer">DefiLlama source</a>
          </div>
        </details>
      </div>
    </div>
    {!data?.coverage?.databaseConnected ? (
      <div className="rounded-xl border border-[#ffb02e]/25 bg-[#ffb02e]/[0.04] p-4 text-xs text-slate-400">
        {failed?'Historical feed temporarily unavailable. ':'Neon history is disconnected. '}
        Live market prices remain available.
      </div>
    ) : (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <HistorySeries title="Protocol TVL" subtitle="DefiLlama · Historical" color="#9a8bff" values={protocolTvl}/>
        <HistorySeries title="Open Interest" subtitle="RISEx · Hourly samples" color="#ffb02e" values={parsed.oi}/>
        <HistorySeries title="Observed Volume" subtitle="RISEx · Sampled cumulative" color="#22e0a1" values={parsed.cumulativeVolume}/>
        <HistorySeries title="Reported Fees" subtitle="RISEx · Sampled cumulative · Hourly" color="#46a6ff" values={parsed.cumulativeFees}/>
      </div>
    )}
  </section>;
};