/**
 * Manual, read-only deployment audit. Requires SITE_URL from the repository
 * owner (the published URL cannot be guessed from a repository name).
 * Runs from a GitHub-hosted runner at no cost for a public repository.
 */
type Probe={endpoint:string;latenciesMs:number[];status:string};
const baseText=String(process.env.SITE_URL||'').replace(/\/+$/,'');
if(!baseText)throw Error('Set SITE_URL to your actual HTTPS RISExScan deployment address');
const site=new URL(baseText);
if(site.protocol!=='https:' || site.username || site.password || site.port){
  throw Error('SITE_URL must be a public HTTPS URL without credentials/explicit ports');
}
const api='https://api.rise.trade';
const awaitJson=async(path:string,timeoutMs=30000):Promise<{data:any;ms:number;status:number}>=>{
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  const start=performance.now();
  try{
    const r=await fetch(path,{cache:'no-store',signal:controller.signal});
    const ms=Math.round(performance.now()-start);
    if(!r.ok)throw Error(`HTTP ${r.status} ${path}`);
    return {data:await r.json(),ms,status:r.status};
  }finally{clearTimeout(timer);}
};
const probes:Probe[]=[];
for(const endpoint of ['/api/health','/api/markets','/api/chain/live','/api/data/freshness']){
  const measurements:number[]=[];
  let status='success';
  for(let i=0;i<3;i++){
    try{
      const result=await awaitJson(site.origin+endpoint,i===0?120000:20000);
      measurements.push(result.ms);
      if(endpoint==='/api/health' && result.data?.ok!==true)throw Error('Health check reported not ok');
    }catch(err){status=String(err);break;}
  }
  probes.push({endpoint,latenciesMs:measurements,status});
}
let parity:Array<{market:string;markDiffPct:number;oiDiffPct:number|null}>=[];
try{
  const [local,upstream]=await Promise.all([
    awaitJson(site.origin+'/api/markets'),
    awaitJson(api+'/v1/markets'),
  ]);
  const localMarkets:Array<any>=local.data?.markets||[];
  const upstreamMarkets:Array<any>=upstream.data?.data?.markets||[];
  const srcById=new Map(upstreamMarkets.map(m=>[String(m.market_id),m]));
  parity=localMarkets.filter(m=>m.active!==false && srcById.has(String(m.market_id)))
    .map(m=>{
      const origin=srcById.get(String(m.market_id));
      const mark=Number(m.mark_price),remoteMark=Number(origin.mark_price);
      const oi=Number(m.open_interest),remoteOi=Number(origin.open_interest);
      return {
        market:String(m.display_name||m.market_id),
        markDiffPct:mark>0&&remoteMark>0?Math.abs(mark-remoteMark)/remoteMark*100:NaN,
        oiDiffPct:Number.isFinite(oi)&&remoteOi>0?Math.abs(oi-remoteOi)/remoteOi*100:null,
      };
    });
}catch(err){
  console.warn('Could not compare simultaneous public market responses:',String(err));
}
type EndpointCheck={name:string;ms:number;status:'success'|'failure';reason?:string};
const checks:EndpointCheck[]=[];
const check=async(name:string,path:string,validate:(v:any)=>boolean=()=>true,optional=false)=>{
  try{
    const result=await awaitJson(site.origin+path,45000);
    if(!validate(result.data))throw Error('unexpected response shape/data');
    checks.push({name,ms:result.ms,status:'success'});
  }catch(err){
    checks.push({name,ms:0,status:optional?'success':'failure',reason:String(err).slice(0,220)});
  }
};
// Verify the public SPA's most-used API paths once; this is intentionally
// lightweight for the free host, not a load test.
const overview=await awaitJson(site.origin+'/api/overview',45000).catch(()=>null);
if(overview){
  const d=overview.data;
  const valid=Number.isFinite(d?.activeMarketsCount)&&
    Number.isFinite(d?.totalMarketsCount)&&d.activeMarketsCount<=d.totalMarketsCount&&
    Array.isArray(d?.topTraders)&&d.topTraders.length<=15 &&
    d.topTraders.every((t:any,i:number,a:any[])=>i===0||Number(a[i-1].totalPnlAll)>=Number(t.totalPnlAll));
  checks.push({name:'Overview totals and top-trader ordering',ms:overview.ms,
    status:valid?'success':'failure',reason:valid?undefined:'invalid counts or nonmonotonic PnL rankings'});
}else checks.push({name:'Overview totals and top-trader ordering',ms:0,status:'failure',reason:'overview unavailable'});
await check('History and database connection','/api/analytics/history',d=>
  d?.coverage && Array.isArray(d.dailyTrades)&&Array.isArray(d.oiSnapshots)&&Array.isArray(d.hourlyFees));
await check('Position changes','/api/analytics/position-changes',d=>
  Array.isArray(d?.changes)&&['current','changes','unavailable'].includes(d?.mode)&&
  (d.mode!=='current'||d.changes.every((p:any)=>p.deltaNetUsd===null)));
await check('Live cohorts','/api/cohorts',d=>!!d);
await check('Leaderboard','/api/leaderboard',d=>!!d);
await check('Latest public trades','/api/trades/recent',d=>!!d);
await check('Explorer index','/api/explorer/overview',d=>!!d);
await check('DefiLlama protocol TVL','/api/analytics/protocol-tvl',d=>
  Array.isArray(d?.tvlHistory),true);
const firstMarket=parity[0]?.market;
const pickedId=(()=> {
  try {
    const d=overview?.data?.markets;
    return Array.isArray(d)?String(d.find((m:any)=>m.active!==false)?.market_id||''):'';
  }catch{return '';}
})();
if(/^\\d{1,6}$/.test(pickedId)){
  await check('Selected market orderbook','/api/markets/'+pickedId+'/orderbook',
    d=>Array.isArray(d?.bids)&&Array.isArray(d?.asks),true);
  await check('Selected market candles','/api/markets/'+pickedId+'/candles?resolution=1H',
    d=>Array.isArray(d?.candles),true);
  await check('Selected market trading activity','/api/markets/'+pickedId+'/trades?limit=10',
    d=>Array.isArray(d?.trades),true);
}
for(const item of checks){
  console.log('CHECK '+item.name+': '+item.status+
    (item.reason?' ('+item.reason+')':' ('+item.ms+'ms)'));
}

const percentile=(rows:number[],p:number)=>rows.length
  ?[...rows].sort((a,b)=>a-b)[Math.ceil(rows.length*p)-1]:null;
for(const p of probes){
  console.log(`${p.endpoint}: ${p.status}; cold=${p.latenciesMs[0]??'—'}ms, warm-p50=${percentile(p.latenciesMs.slice(1),.5)??'—'}ms, warm-p95=${percentile(p.latenciesMs.slice(1),.95)??'—'}ms`);
}
const sortedParity=[...parity].sort((a,b)=>b.markDiffPct-a.markDiffPct);
console.log('Market parity checked: '+parity.length+
  ' of the currently active RISEx markets');
for(const p of sortedParity.slice(0,12)){
  console.log(`${p.market}: mark difference ${p.markDiffPct.toFixed(4)}%, OI difference ${p.oiDiffPct===null?'n/a':p.oiDiffPct.toFixed(2)+'%'}`);
}
console.log('This is a lightweight multi-request smoke check, NOT a production load test or exact-tick parity guarantee.');
if(probes.some(p=>p.status!=='success'))process.exitCode=1;
if(checks.some(c=>c.status==='failure'))process.exitCode=1;
if(parity.some(p=>!Number.isFinite(p.markDiffPct)||p.markDiffPct>5)) {
  console.warn('One or more markets differ >5% from sequential official REST snapshots; inspect data source and timestamps.');
  process.exitCode=1;
}
