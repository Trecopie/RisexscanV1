import React,{useEffect,useMemo,useState} from 'react';
import {formatUsd} from '../utils/format';

type Period='24H'|'7D'|'30D'|'90D'|'ALL';
type Point={time:number;value:number};
interface History {
  coverage:{source:string;completeHistory:false;databaseConnected:boolean;
    firstTradeAt:number|null;lastTradeAt:number|null;
    firstSnapshotAt:number|null;lastSnapshotAt:number|null;
    observedTrades:number;note:string};
  liveCollector:{connected:boolean;lastTradeAt:number|null;droppedInMemory:number};
  dailyTrades:Array<{day:number;volumeUsd:number;reportedFeesUsd:number|null;feeEventCount:number;tradeCount:number}>;
  hourlyFees:Array<{time:number;reportedFeesUsd:number;feeEventCount:number}>;
  oiSnapshots:Array<{time:number;openInterestUsd:number;volume24hUsd:number;marketCount:number}>;
  marketCandles?:{
    daily:Array<{time:number;value:number;marketCount:number}>;
    firstDay:number|null;lastDay:number|null;latestFetchedAt:number|null;
    distinctMarkets:number;completeHistory:false;source:string;
  };
  defillamaOi?:{source:string;completeHistory:false;points:Point[]};
}
const PERIODS:Period[]=['24H','7D','30D','90D','ALL'];
const PERIOD_DAYS:Record<Exclude<Period,'ALL'>,number>={'24H':1,'7D':7,'30D':30,'90D':90};
const shortTime=(ms:number,withHour:boolean)=>{
  const d=new Date(ms);
  return withHour?d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):
    d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
};
const ChartCard:React.FC<{title:string;source:string;color:string;points:Point[];period:Period;unit?:'usd'|'count'}> =
({title,source,color,points,period,unit='usd'})=>{
  const pretty=(value:number)=>unit==='count'?Math.max(0,Math.round(value)).toLocaleString():formatUsd(value,true);
  // Cumulative values are calculated over the entire observed history first;
  // filtering only trims the viewport and never resets the running total.
  const cutoff=period==='ALL'?Number.NEGATIVE_INFINITY:period==='24H'?
    (points.at(-1)?.time??Date.now())-86_400_000:
    Date.now()-PERIOD_DAYS[period]*86_400_000;
  const values=points.filter(p=>Number.isFinite(p.time)&&Number.isFinite(p.value)&&p.time>=cutoff)
    .sort((a,b)=>a.time-b.time);
  const first=values[0],last=values.at(-1),n=values.length;
  const low=n?Math.min(...values.map(p=>p.value)):0;
  const high=n?Math.max(...values.map(p=>p.value)):1;
  const spread=Math.max(1e-9,high-low);
  const padding=spread*0.12;
  const minY=low-padding,maxY=high+padding;
  const x0=22,x1=365,yTop=18,yBottom=111;
  const timeSpan=Math.max(1,(last?.time??0)-(first?.time??0));
  const x=(t:number)=>x0+(t-(first?.time??0))/timeSpan*(x1-x0);
  const y=(v:number)=>yBottom-(v-minY)/(maxY-minY)*(yBottom-yTop);
  const line=n>=2?values.map((p,i)=>
    (i?'L':'M')+x(p.time).toFixed(2)+','+y(p.value).toFixed(2)).join(' '):'';
  const area=line+' L '+x1+','+yBottom+' L '+x0+','+yBottom+' Z';
  const withHour=n>=2 && (last!.time-first!.time)<2*86400000;
  const ticks=[0,1,2,3].map(i=>({y:yTop+i*(yBottom-yTop)/3,
    value:maxY-i*(maxY-minY)/3}));
  return <div className="rounded-xl border border-slate-800 bg-[#080d18] p-4" aria-label={title}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h3 className="font-display text-sm font-semibold text-[#e8edfb]">{title}</h3>
        <p className="mt-1 font-mono text-[10px] text-slate-500">{source}</p>
      </div>
      <span className="font-mono text-lg font-bold tabular-nums" style={{color}}>
        {last?pretty(last.value):'—'}
      </span>
    </div>
    {n>1?<svg className="mt-3 h-[170px] w-full" viewBox="0 0 460 130"
      preserveAspectRatio="none" role="img"
      aria-label={`${title}, ${n} recorded points from ${shortTime(first.time,false)} to ${shortTime(last!.time,false)}`}>
      {ticks.map((t,i)=><g key={i}>
        <line x1={x0} x2={x1} y1={t.y} y2={t.y} stroke="#243147" strokeDasharray="3 4" strokeWidth=".7"/>
        <text x="452" y={t.y+3} textAnchor="end" fill="#64748b" fontSize="10">{pretty(t.value)}</text>
      </g>)}
      <path d={area} fill={color} opacity=".12"/>
      <path d={line} fill="none" stroke={color} strokeWidth="2.5"
        vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx={x(last!.time)} cy={y(last!.value)} r="3" fill={color}/>
    </svg>:<div className="mt-3 flex h-[170px] flex-col items-center justify-center gap-2 text-xs text-slate-400">
      {n===1?<><span className="h-2.5 w-2.5 rounded-full" style={{background:color}}/>
        <span>First recorded point · trend building</span></>:<span>No verified samples in this range</span>}
    </div>}
    <div className="mt-1 flex items-center justify-between gap-2 font-mono text-[10px] text-slate-500">
      <span>{first?shortTime(first.time,withHour):'No earlier data'}</span>
      <span>{n>1?shortTime(last!.time,withHour):`${n} point${n===1?'':'s'}`}</span>
    </div>
  </div>;
};

export const HistoricalInsights:React.FC=()=>{
  const [period,setPeriod]=useState<Period>('30D');
  const [history,setHistory]=useState<History|null>(null);
  const [historyError,setHistoryError]=useState(false);

  useEffect(()=>{
    const controller=new AbortController();
    const getHistory=async()=>{
      if(document.visibilityState==='hidden')return;
      try{
        const r=await fetch('/api/analytics/history',{signal:controller.signal});
        if(!r.ok)throw Error('History unavailable');
        const payload=await r.json();
        if(!controller.signal.aborted){setHistory(payload);setHistoryError(false);}
      }catch{if(!controller.signal.aborted)setHistoryError(true);}
    };
    void getHistory();
    const onVisibility=()=>{if(document.visibilityState==='visible')void getHistory();};
    document.addEventListener('visibilitychange',onVisibility);
    const a=setInterval(getHistory,60000);
    return()=>{controller.abort();clearInterval(a);
      document.removeEventListener('visibilitychange',onVisibility);};
  },[]);

  const charts=useMemo(()=>{
    const daily=history?.dailyTrades??[];
    let volume=0,fees=0;
    const cumulativeVolume:Point[]=[];
    for(const d of daily){volume+=d.volumeUsd;cumulativeVolume.push({time:d.day,value:volume});}
    const cumulativeFees:Point[]=[];
    for(const h of history?.hourlyFees??[]){fees+=h.reportedFeesUsd;
      cumulativeFees.push({time:h.time,value:fees});}
    const candleRecords=(history?.marketCandles?.daily??[])
      .filter(p=>Number.isFinite(p.time)&&Number.isFinite(p.value)&&p.value>=0)
      .sort((a,b)=>a.time-b.time);
    const oiFromDefiLlama=(history?.defillamaOi?.points??[])
      .filter(p=>Number.isFinite(p.time)&&Number.isFinite(p.value)&&p.value>=0)
      .sort((a,b)=>a.time-b.time);
    let derivedTotal=0;
    const reconstructedCumulative=candleRecords.map(p=>{
      derivedTotal+=p.value;return {time:p.time,value:derivedTotal};
    });
    return {
      hasCandleHistory:candleRecords.length>0,
      hasOiHistory:oiFromDefiLlama.length>0,
      oi:oiFromDefiLlama.length?oiFromDefiLlama:
        (history?.oiSnapshots??[]).map(d=>({time:d.time,value:d.openInterestUsd})),
      daily:candleRecords.length?candleRecords:daily.map(d=>({time:d.day,value:d.volumeUsd})),
      dailyTrades:daily.map(d=>({time:d.day,value:d.tradeCount})),
      cumulativeVolume:candleRecords.length?reconstructedCumulative:cumulativeVolume,
      cumulativeFees
    };
  },[history]);

  return <section className="sunrise-card space-y-4 rounded-2xl p-4 sm:p-5" aria-label="Historical market analytics">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="font-display text-lg font-bold text-[#e8edfb]">Historical Market Analytics</h2>
        <p className="mt-1 text-xs text-slate-400">Public RISEx OHLCV + DefiLlama OI, with separately labeled observed trades</p>
      </div>
      <div className="flex items-center gap-2">
        <div role="group" aria-label="History time range" className="flex rounded-lg border border-slate-800 bg-[#070b14] p-0.5">
          {PERIODS.map(p=><button key={p} type="button" onClick={()=>setPeriod(p)}
            aria-pressed={period===p}
            className={`rounded-md px-3 py-1.5 text-xs font-mono transition-colors ${period===p?'bg-[#ffb02e] font-bold text-[#130d04]':'text-slate-400 hover:text-white'}`}>
            {p}</button>)}
        </div>
        <details className="relative">
          <summary className="cursor-pointer list-none rounded-md border border-slate-800 px-2 py-1.5 text-[11px] text-slate-400 hover:text-white">Sources ⓘ</summary>
          <div className="absolute right-0 top-full z-20 mt-2 w-72 rounded-xl border border-slate-700 bg-[#101727] p-3 text-[11px] leading-relaxed text-slate-300 shadow-xl sm:w-96">
            <p><strong>Historical OI:</strong> DefiLlama venue observations where available; otherwise hourly RISEx snapshots. They are not TVL.</p>
            <p className="mt-1"><strong>Daily/cumulative volume:</strong> archived public RISEx 1D candles, only for markets whose volume units passed a comparison against RISEx 24h USD volume. USD estimates exclude unsupported and delisted markets; not an independently certified venue lifetime total.</p>
            <p className="mt-1"><strong>Observed volume/fees:</strong> deduplicated public trades saved since collection began. Not complete venue-wide lifetime totals.</p>
            <p className="mt-1"><strong>TVL:</strong> The single, full-range DefiLlama chart appears in the Protocol TVL section below.</p>
            <a href="https://defillama.com/protocol/risex" target="_blank" rel="noopener noreferrer"
              className="mt-2 inline-block text-[#46a6ff] underline">DefiLlama reference</a>
          </div>
        </details>
      </div>
    </div>
    {historyError&&<p className="text-xs text-[#ffb02e]">Latest RISEx history refresh failed; showing previously loaded observations.</p>}
    {charts.hasCandleHistory&&<p className="rounded-lg border border-[#46a6ff]/25 bg-[#46a6ff]/5 px-3 py-2 text-[11px] text-slate-300">
      <strong className="text-[#46a6ff]">Verified-source reconstruction, partial coverage:</strong>{' '}
      {history?.marketCandles?.distinctMarkets??0} market IDs, from{' '}
      {history?.marketCandles?.firstDay?shortTime(history.marketCandles.firstDay,false):'unknown'} through{' '}
      {history?.marketCandles?.lastDay?shortTime(history.marketCandles.lastDay,false):'unknown'}.
      Missing/de-listed markets and unverified volume units are excluded; ALL means all available verified observations, not protocol inception completeness.
      {period==='24H'?' 24H displays the latest recorded UTC-day observation, not synthetic intraday data.':''}
    </p>}
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <ChartCard title="Open Interest History"
        source={charts.hasOiHistory?'DefiLlama · Historical RISEx OI':'RISEx · Hourly OI samples (partial)'}
        color="#ffb02e" points={charts.oi} period={period}/>
      <ChartCard title={charts.hasCandleHistory?'Historical Daily Volume':'Observed Daily Volume'}
        source={charts.hasCandleHistory?'RISEx · Calibrated 1D OHLCV USD estimate':'RISEx · Recorded trades only'}
        color="#22e0a1" points={charts.daily} period={period}/>
      <ChartCard title={charts.hasCandleHistory?'Cumulative Reconstructed Volume':'Cumulative Observed Volume'}
        source={charts.hasCandleHistory?'RISEx · Available validated candles only; not venue lifetime':'RISEx · Incomplete recorded history'}
        color="#46a6ff" points={charts.cumulativeVolume} period={period}/>
    </div>
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <ChartCard title="Recorded Trade Count" source="RISEx · Distinct recorded trade IDs"
        color="#8b7bff" points={charts.dailyTrades} period={period} unit="count"/>
      <ChartCard title="Reported Trading Fees" source="RISEx · Recorded fees only"
        color="#20c5aa" points={charts.cumulativeFees} period={period}/>
    </div>
    {history?.coverage?.databaseConnected===false &&<p className="text-xs text-[#ffb02e]">
      Local RISEx history unavailable; the independent Protocol TVL chart remains available below.
    </p>}
  </section>;
};
