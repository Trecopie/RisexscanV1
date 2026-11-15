/**
 * Zero-cost, bounded and restart-safe raw on-chain event backfill.
 *
 * Only verified RISEx contract addresses, verified contract creation blocks,
 * confirmed chain 4153, and successful exact log ranges are checkpointed.
 * These are RAW contract events, NOT decoded fills, wallet PnL or venue totals.
 */
import {Pool} from 'pg';

const API='https://api.rise.trade';
const EXPLORER='https://explorer.risechain.com/api/v2';
const RPC=process.env.RISE_CHAIN_RPC || 'https://rpc.risechain.com/';
const NETWORK_ID=4153;
const MAX_LOGS=900; // RISE Blockscout legacy API limits responses to 1000 logs
const MAX_WINDOWS=65;
const DEADLINE_MS=5*60_000;
const STORAGE_SOFT_STOP_BYTES=550_000_000;
const CONFIRMATIONS=16;
const REORG_RESCAN_BLOCKS=16;
const CONTRACTS=[
  {role:'perps_manager',address:'0x53f10facfc8965750494e6965f5d6da39b41d852'},
  {role:'collateral_manager',address:'0x2c03c7d7e2974c6599b6b108879109281ef3f818'},
] as const;

type Json=Record<string,any>;
type RpcLog={address:string;blockNumber:string;blockHash:string;
  transactionHash:string;logIndex:string;topics:string[];data:string;removed?:boolean};
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function int(value:unknown):number {
  if(typeof value==='string' && /^0x[0-9a-f]+$/i.test(value))return parseInt(value,16);
  return Number(value);
}
function hex(block:number):string{return '0x'+block.toString(16);}
function validAddress(v:unknown):v is string{
  return typeof v==='string'&&/^0x[0-9a-f]{40}$/i.test(v);
}

async function fetchJson(url:string,body?:Json):Promise<any>{
  let failure='unavailable';
  for(let attempt=0;attempt<3;attempt++){
    const abort=new AbortController();
    const timer=setTimeout(()=>abort.abort(),12_000);
    try{
      const res=await fetch(url,{method:body?'POST':'GET',
        headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},
        body:body?JSON.stringify(body):undefined,signal:abort.signal});
      if(!res.ok)throw Error('HTTP '+res.status);
      return await res.json();
    }catch(err){
      failure=String(err).slice(0,160);
      if(attempt<2)await delay(850*(attempt+1));
    }finally{clearTimeout(timer);}
  }
  throw Error('Public upstream failed: '+failure);
}
async function rpc(method:string,params:unknown[]):Promise<any>{
  const result=await fetchJson(RPC,{jsonrpc:'2.0',id:1,method,params});
  if(result?.error)throw Error('RPC '+method+' error '+String(result.error.message).slice(0,150));
  if(result?.result===undefined)throw Error('RPC '+method+' missing result');
  return result.result;
}
function currentContractInConfig(config:unknown,contract:string):boolean{
  // The issuer's own public system/config must identify the monitored contract.
  // Do not scan unrelated addresses merely because they were listed in an issue.
  const s=JSON.stringify(config??{}).toLowerCase();
  return s.includes(contract.toLowerCase());
}
async function verifiedDeployment(role:string,address:string,systemConfig:unknown):
  Promise<{start:number;creationHash:string}|null>{
  if(!validAddress(address)||!currentContractInConfig(systemConfig,address)){
    console.log(role+': address not present in RISEx public system/config; skipped.');
    return null;
  }
  const latestCode=await rpc('eth_getCode',[address,'latest']);
  if(typeof latestCode!=='string'||latestCode==='0x'){
    console.warn(role+': no deployed code on RISE; skipped.');
    return null;
  }
  const info=await fetchJson(EXPLORER+'/addresses/'+address);
  if(info?.is_contract===false){
    console.warn(role+': Blockscout does not recognize this as a contract; skipped.');
    return null;
  }
  const creationHash=info?.creation_tx_hash;
  if(typeof creationHash!=='string'||!/^0x[0-9a-f]{64}$/i.test(creationHash)){
    console.warn(role+': creation transaction not verifiable via free explorer; skipped.');
    return null;
  }
  const tx=await fetchJson(EXPLORER+'/transactions/'+creationHash);
  const created=tx?.created_contract?.hash;
  if(created && String(created).toLowerCase()!==address.toLowerCase()){
    console.warn(role+': contract creation mismatch; skipped.');
    return null;
  }
  const start=int(tx?.block??tx?.block_number);
  if(!Number.isSafeInteger(start)||start<1){
    console.warn(role+': no verified deployment block; skipped.');
    return null;
  }
  return {start,creationHash};
}

async function initialize(pool:Pool):Promise<void>{
  await pool.query(
    'CREATE TABLE IF NOT EXISTS risexscan_chain_event_logs ('+
    'chain_id INTEGER NOT NULL DEFAULT 4153,'+
    'contract_address TEXT NOT NULL,tx_hash TEXT NOT NULL,'+
    'log_index INTEGER NOT NULL,block_number BIGINT NOT NULL,'+
    'block_hash TEXT NOT NULL,topics JSONB NOT NULL,data TEXT NOT NULL,'+
    'PRIMARY KEY(chain_id,contract_address,tx_hash,log_index))'
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS risexscan_chain_logs_block'+
    ' ON risexscan_chain_event_logs(contract_address,block_number)'
  );
  await pool.query(
    'CREATE TABLE IF NOT EXISTS risexscan_chain_scan_state ('+
    'chain_id INTEGER NOT NULL,contract_address TEXT NOT NULL,'+
    'deployment_block BIGINT NOT NULL,creation_tx_hash TEXT NOT NULL,'+
    'next_block BIGINT NOT NULL,latest_scanned_block BIGINT NOT NULL,'+
    'scanned_windows BIGINT NOT NULL DEFAULT 0,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),'+
    'PRIMARY KEY(chain_id,contract_address))'
  );
}
async function storageOkay(pool:Pool):Promise<boolean>{
  const r=await pool.query('SELECT pg_database_size(current_database()) AS bytes');
  return int(r.rows[0]?.bytes)<STORAGE_SOFT_STOP_BYTES;
}
async function nextStart(pool:Pool,address:string,deployment:number,creationHash:string):Promise<number>{
  const r=await pool.query(
    'SELECT deployment_block,creation_tx_hash,next_block FROM risexscan_chain_scan_state'+
    ' WHERE chain_id=$1 AND contract_address=$2',
    [NETWORK_ID,address]
  );
  if(!r.rows.length)return deployment;
  const old=r.rows[0];
  if(int(old.deployment_block)!==deployment||
    old.creation_tx_hash?.toLowerCase()!==creationHash.toLowerCase()){
    throw Error('Verified contract creation changed; manual review required');
  }
  return Math.max(deployment,int(old.next_block)-REORG_RESCAN_BLOCKS);
}
function decodeLog(entry:RpcLog,lower:string,from:number,to:number){
  const block=int(entry.blockNumber),index=int(entry.logIndex);
  if(entry.removed || entry.address?.toLowerCase()!==lower ||
    !Number.isSafeInteger(block)||block<from||block>to||
    !Number.isSafeInteger(index)||index<0 ||
    !/^0x[0-9a-f]{64}$/i.test(entry.blockHash??'')||
    !/^0x[0-9a-f]{64}$/i.test(entry.transactionHash??'')||
    !Array.isArray(entry.topics)||!entry.topics.every(t=>/^0x[0-9a-f]{64}$/i.test(t))||
    typeof entry.data!=='string'||!/^0x[0-9a-f]*$/i.test(entry.data)){
    throw Error('Unverifiable log in returned range (no checkpoint)');
  }
  return {block,index,hash:entry.transactionHash.toLowerCase(),
    blockHash:entry.blockHash.toLowerCase(),topics:entry.topics,data:entry.data};
}
async function readSafeRange(address:string,from:number,proposedTo:number):
  Promise<{to:number;logs:ReturnType<typeof decodeLog>[]}>{
  let to=proposedTo;
  while(to>=from){
    try{
      const rows=await rpc('eth_getLogs',[{address,fromBlock:hex(from),toBlock:hex(to)}]);
      if(!Array.isArray(rows))throw Error('RPC returned no log array');
      if(rows.length>=MAX_LOGS){
        if(to===from)throw Error('Single block exceeds safe event-result threshold');
        to=from+Math.floor((to-from)/2);
        continue;
      }
      return {to,logs:rows.map(x=>decodeLog(x,address.toLowerCase(),from,to))};
    }catch(err){
      if(to===from)throw err;
      // Public RPC may enforce smaller block ranges or event response caps.
      to=from+Math.floor((to-from)/2);
    }
  }
  throw Error('No readable block range');
}
async function commitRange(pool:Pool,address:string,origin:number,creationHash:string,
  from:number,to:number,logs:ReturnType<typeof decodeLog>[]):Promise<void>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    // Reorg overlap: delete old fork logs in the exact rescanned range.
    await client.query('DELETE FROM risexscan_chain_event_logs WHERE chain_id=$1'+
      ' AND contract_address=$2 AND block_number BETWEEN $3 AND $4',
      [NETWORK_ID,address,from,to]);
    for(const log of logs){
      await client.query(
        'INSERT INTO risexscan_chain_event_logs'+
        '(chain_id,contract_address,tx_hash,log_index,block_number,block_hash,topics,data)'+
        ' VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)'+
        ' ON CONFLICT DO NOTHING',
        [NETWORK_ID,address,log.hash,log.index,log.block,log.blockHash,
          JSON.stringify(log.topics),log.data]
      );
    }
    await client.query(
      'INSERT INTO risexscan_chain_scan_state'+
      '(chain_id,contract_address,deployment_block,creation_tx_hash,next_block,latest_scanned_block,scanned_windows)'+
      ' VALUES($1,$2,$3,$4,$5,$6,1)'+
      ' ON CONFLICT(chain_id,contract_address) DO UPDATE SET'+
      ' next_block=GREATEST(risexscan_chain_scan_state.next_block,EXCLUDED.next_block),'+
      ' latest_scanned_block=GREATEST(risexscan_chain_scan_state.latest_scanned_block,EXCLUDED.latest_scanned_block),'+
      ' scanned_windows=risexscan_chain_scan_state.scanned_windows+1,updated_at=now()',
      [NETWORK_ID,address,origin,creationHash,to+1,to]
    );
    await client.query('COMMIT');
  }catch(err){await client.query('ROLLBACK');throw err;}
  finally{client.release();}
}

async function main():Promise<void>{
  if(!process.env.DATABASE_URL){
    console.log('SKIP: DATABASE_URL Actions secret not available; no writes.');
    return;
  }
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2,
    connectionTimeoutMillis:9_000,idleTimeoutMillis:10_000});
  try{
    const id=int(await rpc('eth_chainId',[]));
    if(id!==NETWORK_ID)throw Error('RPC chain-id does not match RISE 4153');
    if(!await storageOkay(pool)){
      console.log('SKIP: Neon storage guard reached, no writes.');
      return;
    }
    const configRaw=await fetchJson(API+'/v1/system/config');
    const config=configRaw?.data??configRaw;
    const tip=int(await rpc('eth_blockNumber',[]))-CONFIRMATIONS;
    if(!Number.isSafeInteger(tip)||tip<0)throw Error('Unverifiable chain tip');
    await initialize(pool);
    const stopAt=Date.now()+DEADLINE_MS;
    let verifiedContracts=0;
    let committedRanges=0;
    for(const item of CONTRACTS){
      if(Date.now()>=stopAt)break;
      const verified=await verifiedDeployment(item.role,item.address,config)
        .catch(err=>{console.warn(item.role+': deployment verification unavailable: '+
          String(err).slice(0,130));return null;});
      if(!verified)continue;
      verifiedContracts++;
      let from=await nextStart(pool,item.address,verified.start,verified.creationHash);
      let scans=0,events=0;
      while(from<=tip&&scans<MAX_WINDOWS&&Date.now()<stopAt){
        if(!await storageOkay(pool)){
          console.warn('Neon storage guard reached, stopping scans.');
          break;
        }
        const to=Math.min(tip,from+1999);
        const page=await readSafeRange(item.address,from,to);
        await commitRange(pool,item.address,verified.start,verified.creationHash,
          from,page.to,page.logs);
        scans++;committedRanges++;events+=page.logs.length;
        from=page.to+1;
        await delay(250);
      }
      console.log(item.role+': verified creation block '+verified.start+
        ', committed '+scans+' exact ranges, '+events+' RAW events; next block '+from+
        ', finality-tip '+tip+'. Not yet full history.');
    }
    if(verifiedContracts===0){
      throw Error('No monitored contract verified. Check RISEx system/config, Blockscout creation_tx_hash and creation transaction; ZERO history scanned.');
    }
    // A fully scanned database can have no new ranges. For first-time setup,
    // an empty checkpoint means nothing was indexed even if the Action ran green.
    if(committedRanges===0){
      const progress=await pool.query('SELECT COUNT(*)::integer AS count FROM risexscan_chain_scan_state WHERE chain_id=$1',[NETWORK_ID]);
      if(!Number(progress.rows[0]?.count)){
        throw Error('Contracts verified, but no historical block range was checkpointed. Check upstream RPC ranges and archive access.');
      }
    }
    console.log('Verified contracts: '+verifiedContracts+
      ', exact ranges committed this run: '+committedRanges+
      '. Raw events are not decoded fills, PnL or complete venue coverage.');
  }finally{await pool.end();}
}
main().catch(err=>{
  console.error('Chain event scan halted safely:',String(err).slice(0,200));
  process.exitCode=1;
});
