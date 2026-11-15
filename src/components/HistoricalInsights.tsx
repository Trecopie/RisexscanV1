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
  dailyTrades:Array<{day:number;volumeUsd:number;reportedFeesUsd:number;tradeCount:number}>;
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
        : <div className="mt-4 flex h-[100px] items-center justify-center text-xs text-slate-500">Awaiting at least two recorded observations.</div>}
      {values.length>0 && <div className="flex justify-between text-[10px] font-mono text-slate-500">
        <span>{new Date(values[0].time).toLocaleDateString()}</span>
        <span>{new Date(values[values.length-1].time).toLocaleDateString()}</span>
      </div>}
    </div>;
  };

export const HistoricalInsights:React.FC=()=>{
  const [data,setData]=useState<History|null>(null);
  const [failed,setFailed]=useState(false);
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
    void fetchIt();
    const timer=setInterval(fetchIt,60000);
    return()=>{controller.abort();clearInterval(timer);};
  },[]);
  const parsed=useMemo(()=>{
    const daily=data?.dailyTrades??[];
    let volume=0,fees=0;
    const cumulativeVolume:ChartPoint[]=[],cumulativeFees:ChartPoint[]=[];
    for(const d of daily){
      volume+=d.volumeUsd;
      fees+=d.reportedFeesUsd;
      cumulativeVolume.push({time:d.day,value:volume});
      cumulativeFees.push({time:d.day,value:fees});
    }
    const oi=data?.oiSnapshots.map(d=>({time:d.time,value:d.openInterestUsd}))??[];
    return {cumulativeVolume,cumulativeFees,oi};
  },[data]);
  return <section className="sunrise-card space-y-3 rounded-2xl p-4 sm:p-5" aria-label="Historical market observations">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="font-display text-base font-bold text-[#e8edfb]">Historical Market Observatory</h2>
        <p className="mt-1 text-xs text-slate-400">Verifiable hourly OI snapshots and deduplicated public trade observations. Not reconstructed all-time statistics.</p>
      </div>
      <span className={data?.liveCollector?.connected?'text-[#22e0a1] text-xs font-mono':'text-[#ffb02e] text-xs font-mono'}>
        {data?.liveCollector?.connected?'● Collector connected':'○ Collector not connected'}
      </span>
    </div>
    {!data?.coverage?.databaseConnected ? (
      <div className="rounded-xl border border-[#ffb02e]/25 bg-[#ffb02e]/[0.04] p-4 text-xs text-slate-400">
        {failed ? 'Historical feed is temporarily unavailable. ' : ''}
        Persistent market history requires DATABASE_URL and an always-running collector.
        Markets and live prices still work without PostgreSQL. See deployment instructions for setup.
      </div>
    ) : <>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <HistorySeries title="Recorded Open Interest" subtitle="Hourly official REST OI snapshots · USD" color="#ffb02e" values={parsed.oi}/>
        <HistorySeries title="Cumulative Observed Volume" subtitle="Deduplicated WS executions since collector start" color="#22e0a1" values={parsed.cumulativeVolume}/>
        <HistorySeries title="Cumulative Reported Fees" subtitle="Observed maker + taker + liquidation fees · USDC" color="#46a6ff" values={parsed.cumulativeFees}/>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-800 pt-2 text-[10px] font-mono text-slate-400">
        <span>Observed trade events {data.coverage.observedTrades.toLocaleString()}</span>
        <span>First recorded {data.coverage.firstTradeAt ? new Date(data.coverage.firstTradeAt).toLocaleString() : 'not yet'}</span>
        <span>OI history begins {data.coverage.firstSnapshotAt ? new Date(data.coverage.firstSnapshotAt).toLocaleString() : 'not yet'}</span>
      </div>
      <p className="text-[10px] text-[#ffb02e]">
        Partial coverage: earlier history, collector downtime and any dropped events are not represented.
        Hourly REST OI samples and observed trade totals have different data origins and must not be equated.
      </p>
    </>}
  </section>;
};
