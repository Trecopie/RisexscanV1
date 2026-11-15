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
  fromTime:number;toTime:number;
  previousNetUsd:number;currentNetUsd:number;
  deltaNetUsd:number;
  currentLongUsd:number;currentShortUsd:number;
  positionCount:number;
}

export interface ObservedTradeRecord {
  marketId: string;
  tradeId: string;
  timestampMs: number;
  notionalUsd: number;
  feeUsd: number | null;
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
  dailyTrades: Array<{day: number; volumeUsd: number; reportedFeesUsd: number; tradeCount: number}>;
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
  constructor(url = process.env.DATABASE_URL || '') {
    if (url) this.pool = new Pool({connectionString:url,max:5,connectionTimeoutMillis:5000,idleTimeoutMillis:30000});
  }
  get configured(): boolean {return this.pool !== null;}

  async initialize(): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS risexscan_traders(
          address TEXT PRIMARY KEY,
          payload JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
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

  async upsertTraders(rows:Array<{address:string}>):Promise<void> {
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
    `,[json]);
  }

  async recordTrades(trades:ObservedTradeRecord[]):Promise<void>{
    if(!this.ready || !this.pool || !trades.length)return;
    for(let i=0;i<trades.length;i+=300){
      const chunk=JSON.stringify(trades.slice(i,i+300).map((trade)=>({
        market_id:trade.marketId,
        trade_id:trade.tradeId,
        time_ms:Math.round(trade.timestampMs),
        notional_usd:trade.notionalUsd,
        reported_fee_usd:trade.feeUsd,
      })));
      await this.pool.query(`
        INSERT INTO risexscan_observed_trades(market_id,trade_id,time_ms,notional_usd,reported_fee_usd)
        SELECT market_id,trade_id,time_ms,notional_usd,reported_fee_usd
        FROM jsonb_to_recordset($1::jsonb) AS r(market_id TEXT,trade_id TEXT,time_ms BIGINT,notional_usd DOUBLE PRECISION,reported_fee_usd DOUBLE PRECISION)
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

  async getPositionChanges():Promise<{completeHistory:false;fromTime:number|null;toTime:number|null;changes:PositionChange[]}>{
    const empty={completeHistory:false as const,fromTime:null,toTime:null,changes:[] as PositionChange[]};
    if(!this.ready || !this.pool)return empty;
    const hours=await this.pool.query(`
      SELECT DISTINCT bucket_ms FROM risexscan_cohort_snapshots ORDER BY bucket_ms DESC LIMIT 2
    `);
    if(hours.rows.length<2)return {
      ...empty,toTime:hours.rows[0] ? Number(hours.rows[0].bucket_ms) : null,
    };
    const toTime=Number(hours.rows[0].bucket_ms),fromTime=Number(hours.rows[1].bucket_ms);
    const data=await this.pool.query(`
      SELECT n.market_id,n.cohort,n.long_usd,n.short_usd,n.position_count,
        COALESCE(p.long_usd,0) AS old_long,
        COALESCE(p.short_usd,0) AS old_short
      FROM risexscan_cohort_snapshots n
      LEFT JOIN risexscan_cohort_snapshots p
      ON p.market_id=n.market_id AND p.cohort=n.cohort AND p.bucket_ms=$1
      WHERE n.bucket_ms=$2
    `,[fromTime,toTime]);
    const changes=data.rows.map(v=>({
      marketId:v.market_id,cohort:v.cohort,fromTime,toTime,
      previousNetUsd:Number(v.old_long)-Number(v.old_short),
      currentNetUsd:Number(v.long_usd)-Number(v.short_usd),
      deltaNetUsd:Number(v.long_usd)-Number(v.short_usd)-Number(v.old_long)+Number(v.old_short),
      currentLongUsd:Number(v.long_usd),currentShortUsd:Number(v.short_usd),
      positionCount:Number(v.position_count),
    }));
    changes.sort((a,b)=>Math.abs(b.deltaNetUsd)-Math.abs(a.deltaNetUsd));
    return {completeHistory:false,fromTime,toTime,changes:changes.slice(0,60)};
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
          SUM(notional_usd) AS volume, SUM(COALESCE(reported_fee_usd,0)) AS fees, COUNT(*) AS count
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
        day:Number(row.day),volumeUsd:Number(row.volume),reportedFeesUsd:Number(row.fees),tradeCount:Number(row.count),
      })),
      oiSnapshots:snapshots.rows.reverse().map(row=>({
        time:Number(row.time),openInterestUsd:Number(row.oi),volume24hUsd:Number(row.volume),marketCount:Number(row.markets),
      })),
    };
  }

  async close():Promise<void> { await this.pool?.end(); }
}
