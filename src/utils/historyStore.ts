import { Pool } from 'pg';

export interface PersistedMarketSnapshot {
  marketId: string;
  observedAt: number;
  openInterestUsd: number;
  volume24hUsd: number;
  fundingRate: number;
  markPrice: number;
}

export interface CohortSnapshot {
  marketId:string;
  cohort:'whale'|'shark'|'dolphin'|'fish'|'shrimp';
  observedAt:number;
  longUsd:number;
  shortUsd:number;
  positions:number;
}
export interface PositionChange {
  marketId:string;cohort:string;
  fromTime:number|null;toTime:number;
  previousNetUsd:number|null;currentNetUsd:number;
  deltaNetUsd:number|null;
  currentLongUsd:number;currentShortUsd:number;
  positionCount:number;
}

export interface ObservedTradeRecord {
  marketId: string;
  tradeId: string;
  timestampMs: number;
  notionalUsd: number;
  feeUsd: number | null;
  maker?: string | null;
  taker?: string | null;
  makerSide?: number | null;
  price?: string | null;
  size?: string | null;
}

export interface HistoricalAnalyticsPayload {
  coverage: {
    source: 'post-startup public RISEx WS observations + hourly REST samples';
    completeHistory: false;
    databaseConnected: boolean;
    firstTradeAt: number | null;
    lastTradeAt: number | null;
    firstSnapshotAt: number | null;
    lastSnapshotAt: number | null;
    observedTrades: number;
    note: string;
  };
  dailyTrades: Array<{day: number; volumeUsd: number; reportedFeesUsd: number | null; feeEventCount: number; tradeCount: number}>;
  oiSnapshots: Array<{time: number; openInterestUsd: number; volume24hUsd: number; marketCount: number}>;
}

/**
 * Optional PostgreSQL backing store. This is intentionally not a declaration
 * of 100% historical coverage: observed live trades start when this service
 * first connects, and hourly REST snapshots are not equivalent to a
 * reconstructed historical volume or fee event index.
 */
export class HistoryStore {
  private pool: Pool | null = null;
  ready = false;
  private latestStorageCheck=0;
  private storageBytes=0;
  private storageCapBytes=Number(process.env.RISEX_DB_SOFT_LIMIT_BYTES||700_000_000);
  private storageLimited=false;
  constructor(url = process.env.DATABASE_URL || '') {
    if (url) this.pool = new Pool({connectionString:url,max:5,connectionTimeoutMillis:5000,idleTimeoutMillis:30000});
  }
  get configured(): boolean {return this.pool !== null;}

  /** Reserve free-tier headroom: refuse unbounded raw fills before exhausting
   * the 1 GB free Neon project allocation. Data is never silently deleted. */
  async storageStatus(force=false):Promise<{usedBytes:number;limitBytes:number;writeLimited:boolean}>{
    if(!this.ready || !this.pool)return {usedBytes:0,limitBytes:this.storageCapBytes,writeLimited:false};
    if(force || Date.now()-this.latestStorageCheck>300_000){
      const result=await this.pool.query('SELECT pg_database_size(current_database()) AS bytes');
      this.storageBytes=Number(result.rows[0]?.bytes||0);
      this.storageLimited=this.storageBytes>=this.storageCapBytes;
      this.latestStorageCheck=Date.now();
    }
    return {usedBytes:this.storageBytes,limitBytes:this.storageCapBytes,writeLimited:this.storageLimited};
  }

  async initialize(): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS risexscan_traders(
          address TEXT PRIMARY KEY,
          payload JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS risexscan_trader_updated_at
          ON risexscan_traders(updated_at,address);
        CREATE TABLE IF NOT EXISTS risexscan_state(
          key TEXT PRIMARY KEY,
          payload JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS risexscan_market_snapshots(
          market_id TEXT NOT NULL,
          bucket_ms BIGINT NOT NULL,
          observed_at_ms BIGINT NOT NULL,
          oi_usd DOUBLE PRECISION NOT NULL,
          volume_24h_usd DOUBLE PRECISION NOT NULL,
          funding_rate DOUBLE PRECISION NOT NULL,
          mark_price DOUBLE PRECISION NOT NULL,
          PRIMARY KEY(market_id,bucket_ms)
        );
        CREATE TABLE IF NOT EXISTS risexscan_observed_trades(
          market_id TEXT NOT NULL,
          trade_id TEXT NOT NULL,
          time_ms BIGINT NOT NULL,
          notional_usd DOUBLE PRECISION NOT NULL,
          reported_fee_usd DOUBLE PRECISION,
          PRIMARY KEY(market_id,trade_id)
        );
        CREATE TABLE IF NOT EXISTS risexscan_cohort_snapshots(
          market_id TEXT NOT NULL,
          cohort TEXT NOT NULL,
          bucket_ms BIGINT NOT NULL,
          long_usd DOUBLE PRECISION NOT NULL,
          short_usd DOUBLE PRECISION NOT NULL,
          position_count INTEGER NOT NULL,
          PRIMARY KEY(market_id,cohort,bucket_ms)
        );
        CREATE INDEX IF NOT EXISTS risexscan_cohort_time ON risexscan_cohort_snapshots(bucket_ms);
        ALTER TABLE risexscan_observed_trades ADD COLUMN IF NOT EXISTS maker_address TEXT;
        ALTER TABLE risexscan_observed_trades ADD COLUMN IF NOT EXISTS taker_address TEXT;
        ALTER TABLE risexscan_observed_trades ADD COLUMN IF NOT EXISTS maker_side SMALLINT;
        ALTER TABLE risexscan_observed_trades ADD COLUMN IF NOT EXISTS price_text TEXT;
        ALTER TABLE risexscan_observed_trades ADD COLUMN IF NOT EXISTS size_text TEXT;
        CREATE INDEX IF NOT EXISTS risexscan_trade_time ON risexscan_observed_trades(time_ms);
        CREATE INDEX IF NOT EXISTS risexscan_snapshot_time ON risexscan_market_snapshots(bucket_ms);
      `);
      this.ready = true;
    } catch(err) {
      this.ready = false;
      console.error('Postgres index unavailable; in-memory/disk fallback:',err);
    }
  }

  async loadState():Promise<any | null> {
    if (!this.ready || !this.pool) return null;
    const res=await this.pool.query('SELECT payload FROM risexscan_state WHERE key=$1',['indexer']);
    return res.rows[0]?.payload ?? null;
  }

  async loadTraders(onBatch:(rows:any[])=>void):Promise<number> {
    if (!this.ready || !this.pool) return 0;
    // Keyset pagination avoids expensive OFFSET scans and bounds memory use.
    let after='';
    let count=0;
    for(let page=0;page<300;page++){
      const res=await this.pool.query(
        'SELECT address,payload FROM risexscan_traders WHERE address>$1 ORDER BY address LIMIT 1000',
        [after]
      );
      if(res.rowCount === 0)break;
      onBatch(res.rows.map((row)=>row.payload));
      count+=res.rows.length;
      after=res.rows[res.rows.length-1].address;
      if(res.rows.length<1000)break;
    }
    return count;
  }

  /** Pull only durable backfill updates since the last cursor into the live indexer.
   * Timestamp + address keyset means equal update timestamps cannot skip rows.
   */
  async loadWalletBackfillUpdates(cursorTime:string,cursorAddress:string,limit=1000):
    Promise<{records:any[];cursorTime:string;cursorAddress:string}> {
    const empty={records:[] as any[],cursorTime,cursorAddress};
    if(!this.ready || !this.pool)return empty;
    const page=await this.pool.query(`
      SELECT address,payload,updated_at::text AS updated_at_text
      FROM risexscan_traders
      WHERE (updated_at,address) > ($1::timestamptz,$2::text)
        AND payload ? 'backfillWorkerAt'
      ORDER BY updated_at ASC,address ASC
      LIMIT $3
    `,[cursorTime,cursorAddress,Math.max(1,Math.min(2000,limit))]);
    const last=page.rows.at(-1);
    return {
      records:page.rows.map(row=>row.payload),
      cursorTime:last?.updated_at_text??cursorTime,
      cursorAddress:last?.address??cursorAddress,
    };
  }

  async upsertTraders<T extends {address:string}>(rows:T[]):Promise<void> {
    if(!this.ready || !this.pool || !rows.length)return;
    for(let start=0;start<rows.length;start+=250){
      await this.pool.query(`
        INSERT INTO risexscan_traders(address,payload)
        SELECT lower(record.address),record.value
        FROM jsonb_to_recordset($1::jsonb) AS record(address TEXT, value JSONB)
        ON CONFLICT(address) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()
      `,[JSON.stringify(rows.slice(start,start+250).map((v)=>({address:v.address,value:v})))]);
    }
  }

  async saveState(payload:unknown):Promise<void> {
    if(!this.ready || !this.pool)return;
    await this.pool.query(`
      INSERT INTO risexscan_state(key,payload) VALUES('indexer',$1::jsonb)
      ON CONFLICT(key) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()
    `,[JSON.stringify(payload)]);
  }

  async recordMarketSamples(markets:PersistedMarketSnapshot[]):Promise<void> {
    if(!this.ready || !this.pool || !markets.length)return;
    const json=JSON.stringify(markets.map((m)=>({
      market_id:m.marketId,
      bucket_ms:Math.floor(m.observedAt/3600000)*3600000,
      observed_at_ms:m.observedAt,
      oi_usd:m.openInterestUsd,
      volume_24h_usd:m.volume24hUsd,
      funding_rate:m.fundingRate,
      mark_price:m.markPrice,
    })));
    await this.pool.query(`
      INSERT INTO risexscan_market_snapshots(market_id,bucket_ms,observed_at_ms,oi_usd,volume_24h_usd,funding_rate,mark_price)
      SELECT market_id,bucket_ms,observed_at_ms,oi_usd,volume_24h_usd,funding_rate,mark_price
      FROM jsonb_to_recordset($1::jsonb) AS r(market_id TEXT,bucket_ms BIGINT,observed_at_ms BIGINT,oi_usd DOUBLE PRECISION,volume_24h_usd DOUBLE PRECISION,funding_rate DOUBLE PRECISION,mark_price DOUBLE PRECISION)
      ON CONFLICT (market_id,bucket_ms) DO UPDATE SET
        observed_at_ms=EXCLUDED.observed_at_ms,
        oi_usd=EXCLUDED.oi_usd,
        volume_24h_usd=EXCLUDED.volume_24h_usd,
        funding_rate=EXCLUDED.funding_rate,
        mark_price=EXCLUDED.mark_price
      WHERE EXCLUDED.observed_at_ms >= risexscan_market_snapshots.observed_at_ms
    `,[json]);
  }

  async recordTrades(trades:ObservedTradeRecord[]):Promise<void>{
    if(!this.ready || !this.pool || !trades.length)return;
    const storage=await this.storageStatus();
    if(storage.writeLimited){
      throw new Error('PostgreSQL soft storage limit reached: raw fill capture paused; existing data preserved');
    }
    for(let i=0;i<trades.length;i+=300){
      const chunk=JSON.stringify(trades.slice(i,i+300).map((trade)=>({
        market_id:trade.marketId,
        trade_id:trade.tradeId,
        time_ms:Math.round(trade.timestampMs),
        notional_usd:trade.notionalUsd,
        reported_fee_usd:trade.feeUsd,
        maker_address:trade.maker||null,taker_address:trade.taker||null,
        maker_side:trade.makerSide??null,price_text:trade.price||null,size_text:trade.size||null,
      })));
      await this.pool.query(`
        INSERT INTO risexscan_observed_trades(market_id,trade_id,time_ms,notional_usd,reported_fee_usd,maker_address,taker_address,maker_side,price_text,size_text)
        SELECT market_id,trade_id,time_ms,notional_usd,reported_fee_usd,maker_address,taker_address,maker_side,price_text,size_text
        FROM jsonb_to_recordset($1::jsonb) AS r(
          market_id TEXT,trade_id TEXT,time_ms BIGINT,notional_usd DOUBLE PRECISION,
          reported_fee_usd DOUBLE PRECISION,maker_address TEXT,taker_address TEXT,
          maker_side SMALLINT,price_text TEXT,size_text TEXT
        )
        ON CONFLICT DO NOTHING
      `,[chunk]);
    }
  }

  async recordCohortSnapshots(rows:CohortSnapshot[]):Promise<void>{
    if(!this.ready || !this.pool || !rows.length)return;
    const json=JSON.stringify(rows.map(x=>({
      market_id:x.marketId,cohort:x.cohort,
      bucket_ms:Math.floor(x.observedAt/3600000)*3600000,
      long_usd:x.longUsd,short_usd:x.shortUsd,position_count:x.positions,
    })));
    await this.pool.query(`
      INSERT INTO risexscan_cohort_snapshots(market_id,cohort,bucket_ms,long_usd,short_usd,position_count)
      SELECT market_id,cohort,bucket_ms,long_usd,short_usd,position_count
      FROM jsonb_to_recordset($1::jsonb) AS r(
        market_id TEXT,cohort TEXT,bucket_ms BIGINT,long_usd DOUBLE PRECISION,
        short_usd DOUBLE PRECISION,position_count INTEGER
      )
      ON CONFLICT(market_id,cohort,bucket_ms) DO UPDATE SET
        long_usd=EXCLUDED.long_usd,short_usd=EXCLUDED.short_usd,position_count=EXCLUDED.position_count
    `,[json]);
  }

  async getPositionChanges():Promise<{completeHistory:false;fromTime:number|null;toTime:number|null;mode:'unavailable'|'current'|'changes';changes:PositionChange[]}>{
    const empty={completeHistory:false as const,fromTime:null,toTime:null,mode:'unavailable' as const,changes:[] as PositionChange[]};
    if(!this.ready || !this.pool)return empty;
    const hours=await this.pool.query(`
      SELECT DISTINCT bucket_ms FROM risexscan_cohort_snapshots ORDER BY bucket_ms DESC LIMIT 2
    `);
    if(hours.rows.length===0)return empty;
    // A single hourly bucket has current exposure, not evidence of a change.
    // Do not treat a missing previous sample as zero positions.
    if(hours.rows.length===1){
      const toTime=Number(hours.rows[0].bucket_ms);
      const current=await this.pool.query(`
        SELECT market_id,cohort,long_usd,short_usd,position_count
        FROM risexscan_cohort_snapshots WHERE bucket_ms=$1
        ORDER BY ABS(long_usd-short_usd) DESC LIMIT 60
      `,[toTime]);
      const changes:PositionChange[]=current.rows.map(v=>({
        marketId:v.market_id,cohort:v.cohort,fromTime:null,toTime,
        previousNetUsd:null,currentNetUsd:Number(v.long_usd)-Number(v.short_usd),deltaNetUsd:null,
        currentLongUsd:Number(v.long_usd),currentShortUsd:Number(v.short_usd),
        positionCount:Number(v.position_count),
      }));
      return {completeHistory:false,fromTime:null,toTime,mode:'current',changes};
    }
    const toTime=Number(hours.rows[0].bucket_ms),fromTime=Number(hours.rows[1].bucket_ms);
    const data=await this.pool.query(`
      SELECT COALESCE(n.market_id,p.market_id) AS market_id,
        COALESCE(n.cohort,p.cohort) AS cohort,
        COALESCE(n.long_usd,0) AS long_usd,
        COALESCE(n.short_usd,0) AS short_usd,
        COALESCE(n.position_count,0) AS position_count,
        COALESCE(p.long_usd,0) AS old_long,
        COALESCE(p.short_usd,0) AS old_short
      FROM (SELECT * FROM risexscan_cohort_snapshots WHERE bucket_ms=$2) n
      FULL OUTER JOIN (SELECT * FROM risexscan_cohort_snapshots WHERE bucket_ms=$1) p
      ON p.market_id=n.market_id AND p.cohort=n.cohort
    `,[fromTime,toTime]);
    const changes:PositionChange[]=data.rows.map(v=>({
      marketId:v.market_id,cohort:v.cohort,fromTime,toTime,
      previousNetUsd:Number(v.old_long)-Number(v.old_short),
      currentNetUsd:Number(v.long_usd)-Number(v.short_usd),
      deltaNetUsd:Number(v.long_usd)-Number(v.short_usd)-Number(v.old_long)+Number(v.old_short),
      currentLongUsd:Number(v.long_usd),currentShortUsd:Number(v.short_usd),
      positionCount:Number(v.position_count),
    }));
    changes.sort((a,b)=>Math.abs(b.deltaNetUsd??0)-Math.abs(a.deltaNetUsd??0));
    return {completeHistory:false,fromTime,toTime,mode:'changes',changes:changes.slice(0,60)};
  }

  async getHistoricalAnalytics():Promise<HistoricalAnalyticsPayload>{
    const unavailable:HistoricalAnalyticsPayload={
      coverage:{
        source:'post-startup public RISEx WS observations + hourly REST samples',
        completeHistory:false,databaseConnected:this.ready,
        firstTradeAt:null,lastTradeAt:null,firstSnapshotAt:null,lastSnapshotAt:null,
        observedTrades:0,
        note:'Observed data is incomplete before the collector was online and during any disconnection; no all-time claims.',
      },
      dailyTrades:[],oiSnapshots:[],
    };
    if(!this.ready || !this.pool)return unavailable;
    const [trades,snapshots,range] = await Promise.all([
      this.pool.query(`
        SELECT (time_ms/86400000)*86400000 AS day,
          SUM(notional_usd) AS volume, SUM(reported_fee_usd) AS fees,
          COUNT(reported_fee_usd) AS fee_count, COUNT(*) AS count
        FROM risexscan_observed_trades
        GROUP BY day ORDER BY day DESC LIMIT 90
      `),
      this.pool.query(`
        SELECT bucket_ms AS time,SUM(oi_usd) AS oi,SUM(volume_24h_usd) AS volume,
          COUNT(*) AS markets
        FROM risexscan_market_snapshots GROUP BY bucket_ms ORDER BY bucket_ms DESC LIMIT 168
      `),
      this.pool.query(`
        SELECT
          (SELECT MIN(time_ms) FROM risexscan_observed_trades) AS first_trade,
          (SELECT MAX(time_ms) FROM risexscan_observed_trades) AS last_trade,
          (SELECT COUNT(*) FROM risexscan_observed_trades) AS trade_count,
          (SELECT MIN(bucket_ms) FROM risexscan_market_snapshots) AS first_sample,
          (SELECT MAX(bucket_ms) FROM risexscan_market_snapshots) AS last_sample
      `),
    ]);
    const rangeRow=range.rows[0]||{};
    return {
      coverage:{
        ...unavailable.coverage,
        firstTradeAt:rangeRow.first_trade === null ? null :Number(rangeRow.first_trade),
        lastTradeAt:rangeRow.last_trade === null ? null :Number(rangeRow.last_trade),
        firstSnapshotAt:rangeRow.first_sample === null ? null :Number(rangeRow.first_sample),
        lastSnapshotAt:rangeRow.last_sample === null ? null :Number(rangeRow.last_sample),
        observedTrades:Number(rangeRow.trade_count||0),
      },
      dailyTrades:trades.rows.reverse().map(row=>({
        day:Number(row.day),volumeUsd:Number(row.volume),
        reportedFeesUsd:row.fees === null ? null :Number(row.fees),
        feeEventCount:Number(row.fee_count),tradeCount:Number(row.count),
      })),
      oiSnapshots:snapshots.rows.reverse().map(row=>({
        time:Number(row.time),openInterestUsd:Number(row.oi),volume24hUsd:Number(row.volume),marketCount:Number(row.markets),
      })),
    };
  }

  async close():Promise<void> { await this.pool?.end(); }
}
