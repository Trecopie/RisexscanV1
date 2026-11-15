/**
 * Bounded, resumable RISEx Auth-registry wallet discovery + portfolio enrichment.
 * Runs in GitHub Actions independently of an idle web host.
 * A registered address is NOT proof of a trading account.
 * This does NOT reconstruct all historical order fills or guarantee completeness.
 */
import { Pool } from 'pg';

const API = 'https://api.rise.trade';
const EXPLORER = 'https://explorer.risechain.com/api/v2';
const AUTH_CONTRACT = '0x0d919daa3f12ae715744eb648c00066c5dbd66f0';
const REGISTRY_METHODS = new Set(['0x8a10cb9e', '0xf8219d90']);
const JOB_BUDGET_MS = 6 * 60_000;
const MAX_HISTORY_PAGES = 30;
const MAX_ENRICHMENTS = 110;
const DATABASE_SAFETY_BYTES = 600_000_000;
const CURSOR_KEY = 'wallet_auth_backfill_v1';
const delay = (ms:number) => new Promise<void>(resolve => setTimeout(resolve,ms));
const number = (n:unknown):number => {
  const value=Number(n);
  return Number.isFinite(value)?value:0;
};

interface CursorState {
  cursor:Record<string,string>|null;
  complete:boolean;
  pages:number;
}
type TraderJson=Record<string,any>;

async function getJson(url:string):Promise<any>{
  let previous:unknown;
  for(let retry=0;retry<2;retry++){
    const abort=new AbortController();
    const timeout=setTimeout(()=>abort.abort(),8_000);
    try{
      const result=await fetch(url,{signal:abort.signal,headers:{Accept:'application/json'}});
      if(!result.ok)throw Error('External RISEx API HTTP '+result.status);
      return await result.json();
    }catch(err){
      previous=err;
      if(retry===0)await delay(1_500);
    }finally{clearTimeout(timeout);}
  }
  throw previous;
}

function registryAddress(tx:any):string|null {
  const input=String(tx?.raw_input||'');
  const method=String(tx?.method||'').toLowerCase();
  if(input.length<74 || (!REGISTRY_METHODS.has(method) &&
     !REGISTRY_METHODS.has(input.slice(0,10).toLowerCase())))return null;
  const address=('0x'+input.slice(34,74)).toLowerCase();
  if(!/^0x[0-9a-f]{40}$/.test(address) || /^0x0{40}$/.test(address))return null;
  return address;
}

function defaultTrader(address:string):TraderJson{
  return {
    address,username:null,avatarUrl:null,xHandle:null,accountValue:0,usdcBalance:0,
    totalNotional:0,accountLeverage:0,marginUsagePct:0,unrealizedPnl:0,
    realizedPnlAll:0,totalPnlAll:0,roiAllPct:0,
    pnl24h:null,pnl7d:null,pnl30d:null,roi24hPct:null,roi7dPct:null,roi30dPct:null,
    volume24h:0,volume7d:0,volume30d:0,volumeAll:0,volumeRank24h:0,volumeRankAll:0,
    winRate:null,sharpeRatio:null,maxDrawdown:null,profitFactor:null,
    openPositionsCount:0,positions:[],riskLevel:'NORMAL',inLiquidation:false,
    portfolioEnriched:false,lastUpdated:0,sources:['auth-registry-backfill'],
    backfillWorkerAt:Date.now(),
  };
}

async function saveDiscovered(pool:Pool,rows:any[]):Promise<number>{
  const unique=[...new Set(rows.map(registryAddress).filter((a):a is string=>Boolean(a)))];
  if(!unique.length)return 0;
  const records=unique.map(address=>({address,payload:defaultTrader(address)}));
  const result=await pool.query(
    'INSERT INTO risexscan_traders(address,payload) '+
    'SELECT lower(item.address),item.payload FROM jsonb_to_recordset($1::jsonb) '+
    'AS item(address TEXT,payload JSONB) '+
    'ON CONFLICT(address) DO NOTHING',
    [JSON.stringify(records)]
  );
  return result.rowCount??0;
}

async function readCursor(pool:Pool):Promise<CursorState>{
  const row=await pool.query('SELECT payload FROM risexscan_state WHERE key=$1',[CURSOR_KEY]);
  const state=row.rows[0]?.payload||{};
  return {
    cursor:state.cursor&&typeof state.cursor==='object'?state.cursor:null,
    complete:Boolean(state.complete),
    pages:number(state.pages),
  };
}
async function writeCursor(pool:Pool,state:CursorState):Promise<void>{
  await pool.query(
    'INSERT INTO risexscan_state(key,payload) VALUES($1,$2::jsonb) '+
    'ON CONFLICT(key) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()',
    [CURSOR_KEY,JSON.stringify(state)]
  );
}
function addressUrl(cursor:Record<string,string>|null):string{
  const url=new URL(EXPLORER+'/addresses/'+AUTH_CONTRACT+'/transactions');
  if(cursor)for(const [key,value] of Object.entries(cursor)){
    if(value!==null && value!==undefined)url.searchParams.set(key,String(value));
  }
  return url.toString();
}
async function visitRegistryPage(pool:Pool,cursor:Record<string,string>|null):Promise<{
  next:Record<string,string>|null;newWallets:number
}>{
  const response=await getJson(addressUrl(cursor));
  if(!Array.isArray(response?.items))throw Error('Blockscout returned no transaction list');
  const created=await saveDiscovered(pool,response.items);
  const next=response.next_page_params&&typeof response.next_page_params==='object'
    ? response.next_page_params as Record<string,string>:null;
  return {next,newWallets:created};
}

async function indexRegistry(pool:Pool,deadline:number):Promise<{pages:number,created:number,complete:boolean}>{
  let state=await readCursor(pool);
  let created=0,pages=0;
  // Always refresh newest registrations, including once historical backfill is done.
  let head:Record<string,string>|null=null;
  for(let i=0;i<2 && Date.now()<deadline;i++){
    const page=await visitRegistryPage(pool,head);
    created+=page.newWallets;pages++;
    if(!page.next)break;
    head=page.next;
    await delay(250);
  }

  while(!state.complete && pages<MAX_HISTORY_PAGES && Date.now()<deadline){
    const page=await visitRegistryPage(pool,state.cursor);
    state={cursor:page.next,complete:!page.next,pages:state.pages+1};
    await writeCursor(pool,state); // Durable checkpoint after EVERY successful page.
    created+=page.newWallets;pages++;
    await delay(350);
  }
  return {pages,created,complete:state.complete};
}

function positionsFromDetails(raw:any[],account:string,username:string|null,avatarUrl:string|null,equity:number,leverage:number):any[]{
  const results:any[]=[];
  for(const p of raw){
    const sz=number(p?.size);
    if(!sz)continue;
    const mark=number(p?.mark_price);
    const notional=Math.abs(sz)*mark;
    const lev=number(p?.leverage);
    const margin=number(p?.margin_balance)||(lev>0?notional/lev:notional);
    const unrealized=number(p?.unrealized_pnl);
    results.push({
      address:account,username,avatarUrl,portfolioValue:equity,accountLeverage:leverage,
      marketId:String(p?.market_id||''),marketName:p?.market_name||'Market '+String(p?.market_id||''),
      side:sz>0?'LONG':'SHORT',size:Math.abs(sz),notionalUsd:notional,
      entryPrice:number(p?.avg_entry_price),markPrice:mark,liquidationPrice:number(p?.liquidation_price),
      leverage:lev,unrealizedPnl:unrealized,roiPct:margin>0?unrealized/margin*100:0,
      marginBalance:margin,marginMode:p?.margin_mode===1?'Isolated':'Cross',
    });
  }
  return results;
}

async function setRetry(pool:Pool,address:string,hours:number):Promise<void>{
  await pool.query(
    "UPDATE risexscan_traders SET payload=jsonb_set(payload,'{backfillRetryAt}',"+
    'to_jsonb($2::bigint),true),updated_at=now() '+
    "WHERE address=$1 AND COALESCE(payload->>'portfolioEnriched','false')<>'true'",
    [address,Date.now()+hours*3600_000]
  );
}
async function enrichOne(pool:Pool,address:string,existing:TraderJson):Promise<'enriched'|'inactive'|'skipped'>{
  const detailsResponse=await getJson(API+'/v1/portfolio/details?account='+encodeURIComponent(address));
  const details=detailsResponse?.data;
  if(!details?.summary){
    await setRetry(pool,address,24); // Registrations may never open a trading portfolio.
    return 'inactive';
  }
  const [h,s,prof]=await Promise.allSettled([
    getJson(API+'/v1/portfolio/header?account='+encodeURIComponent(address)),
    getJson(API+'/v1/portfolio/stats?account='+encodeURIComponent(address)+'&period=30d'),
    existing?.username?Promise.resolve(null):getJson(API+'/v1/traders/'+encodeURIComponent(address)),
  ]);
  const header=h.status==='fulfilled'?h.value?.data:null;
  const stats=s.status==='fulfilled'?s.value?.data:null;
  const profile=prof.status==='fulfilled'?prof.value?.data:null;
  const summary=details.summary;
  const username=profile?.username||existing?.username||null;
  const avatarUrl=profile?.avatar_url||profile?.x_account?.profile_image_url||existing?.avatarUrl||null;
  const account=String(details.account||address);
  const equity=number(summary.total_account_value);
  const lev=number(summary.account_leverage);
  const unrealized=number(summary.total_unrealized_pnl);
  const realized=number(summary.realized_pnl);
  const pnl=realized+unrealized;
  const perf=stats?.performance;
  const sources=[...new Set([...(Array.isArray(existing?.sources)?existing.sources:[]),'github-backfill'])];
  const positions=positionsFromDetails(details.positions||[],account,username,avatarUrl,equity,lev);
  const patch={
    username,avatarUrl,xHandle:profile?.x_account?.username||existing?.xHandle||null,
    accountValue:equity,usdcBalance:number(summary.usdc_balance),
    totalNotional:number(summary.total_notional),accountLeverage:lev,
    marginUsagePct:number(summary.margin_usage)*100,
    unrealizedPnl:unrealized,realizedPnlAll:realized,totalPnlAll:pnl,
    roiAllPct:equity>0?pnl/equity*100:0,
    volume24h:number(header?.h24?.volume),volume7d:number(header?.d7?.volume),
    volume30d:number(header?.d30?.volume),
    volumeAll:Math.max(number(header?.all_time?.volume),number(existing?.volumeAll)),
    volumeRank24h:number(header?.h24?.volume_rank),
    volumeRankAll:number(header?.all_time?.volume_rank),
    winRate:perf?.win_rate!==undefined?number(perf.win_rate)*100:existing?.winRate??null,
    sharpeRatio:perf?.sharpe_ratio!==undefined?number(perf.sharpe_ratio):null,
    maxDrawdown:perf?.max_drawdown!==undefined?number(perf.max_drawdown)*100:null,
    profitFactor:perf?.profit_factor && perf.profit_factor!=='Infinity'?number(perf.profit_factor):null,
    openPositionsCount:positions.length,positions,
    riskLevel:summary.risk_level||'NORMAL',inLiquidation:Boolean(summary.in_liquidation),
    portfolioEnriched:true,lastUpdated:Date.now(),sources,backfillRetryAt:0,
    backfillWorkerAt:Date.now(),
  };
  // Never overwrite a richer record concurrently enriched by the live server.
  const result=await pool.query(
    'UPDATE risexscan_traders SET payload=payload||$2::jsonb,updated_at=now() '+
    "WHERE address=$1 AND COALESCE(payload->>'portfolioEnriched','false')<>'true'",
    [address,JSON.stringify(patch)]
  );
  return result.rowCount?'enriched':'skipped';
}

async function enrichPending(pool:Pool,deadline:number):Promise<{enriched:number,inactive:number,errors:number}>{
  // Bound query + remote API work so the free Actions job stays within its budget.
  const result=await pool.query(
    "SELECT address,payload FROM risexscan_traders "+
    "WHERE COALESCE(payload->>'portfolioEnriched','false')<>'true' "+
    "AND COALESCE((payload->>'backfillRetryAt')::bigint,0)<=$1 "+
    'ORDER BY updated_at ASC LIMIT 500',
    [Date.now()]
  );
  // Active accounts discovered via leaderboards are more valuable than inactive registrations.
  const candidates=(result.rows as {address:string,payload:TraderJson}[]).sort((a,b)=>
    Math.max(number(b.payload?.volumeAll),Math.abs(number(b.payload?.realizedPnlAll)))-
    Math.max(number(a.payload?.volumeAll),Math.abs(number(a.payload?.realizedPnlAll)))
  ).slice(0,MAX_ENRICHMENTS);
  let enriched=0,inactive=0,errors=0;
  let cursor=0;
  const runner=async()=>{
    while(cursor<candidates.length && Date.now()<deadline){
      const item=candidates[cursor++];
      try{
        const status=await enrichOne(pool,item.address,item.payload);
        if(status==='enriched')enriched++;
        else if(status==='inactive')inactive++;
      }catch{
        errors++;
        await setRetry(pool,item.address,1).catch(()=>{});
      }
      await delay(900);
    }
  };
  await Promise.all([runner(),runner()]);
  return {enriched,inactive,errors};
}

async function main():Promise<void>{
  if(!process.env.DATABASE_URL){
    console.log('SKIP: GitHub Actions DATABASE_URL secret not configured.');
    return;
  }
  const pool=new Pool({
    connectionString:process.env.DATABASE_URL,
    max:3,connectionTimeoutMillis:8_000,idleTimeoutMillis:15_000,
  });
  const started=Date.now();
  const deadline=started+JOB_BUDGET_MS;
  try{
    const size=await pool.query('SELECT pg_database_size(current_database()) AS bytes');
    if(number(size.rows[0]?.bytes)>=DATABASE_SAFETY_BYTES){
      console.warn('SKIP: database storage guard protects remaining free-tier headroom.');
      return;
    }
    const discovery=await indexRegistry(pool,deadline-120_000);
    const enrichment=await enrichPending(pool,deadline-10_000);
    console.log('Resumable wallet discovery: pages='+discovery.pages+
      ', newly stored='+discovery.created+', history complete='+discovery.complete);
    console.log('Bounded wallet enrichment: completed='+enrichment.enriched+
      ', no portfolio='+enrichment.inactive+', API errors='+enrichment.errors);
    console.log('Coverage remains partial; discovered registry signers are not necessarily active traders.');
    if(enrichment.errors>MAX_ENRICHMENTS/2)process.exitCode=1;
  }finally{await pool.end();}
}
main().catch(err=>{
  console.error('Wallet backfill interrupted:',String(err).slice(0,180));
  process.exitCode=1;
});
