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
    .slice(0,8).map(m=>{
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
const percentile=(rows:number[],p:number)=>rows.length
  ?[...rows].sort((a,b)=>a-b)[Math.ceil(rows.length*p)-1]:null;
for(const p of probes){
  console.log(`${p.endpoint}: ${p.status}; cold=${p.latenciesMs[0]??'—'}ms, warm-p50=${percentile(p.latenciesMs.slice(1),.5)??'—'}ms, warm-p95=${percentile(p.latenciesMs.slice(1),.95)??'—'}ms`);
}
for(const p of parity){
  console.log(`${p.market}: mark difference ${p.markDiffPct.toFixed(4)}%, OI difference ${p.oiDiffPct===null?'n/a':p.oiDiffPct.toFixed(2)+'%'}`);
}
console.log('This is a lightweight multi-request smoke check, NOT a production load test or exact-tick parity guarantee.');
if(probes.some(p=>p.status!=='success'))process.exitCode=1;
if(parity.some(p=>!Number.isFinite(p.markDiffPct)||p.markDiffPct>1)) {
  console.warn('Some prices differ >1% between sequential public snapshots; inspect timestamps/source freshness.');
  process.exitCode=1;
}
