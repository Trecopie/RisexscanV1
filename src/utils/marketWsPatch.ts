import type { MarketTrade, RisexMarket } from '../types/risex';

export interface MarketWithStats extends RisexMarket {
  indexedStats?: {
    count: number;
    longNotional: number;
    shortNotional: number;
  };
}

export interface OrderbookLevelsState {
  bids: Map<number, number>;
  asks: Map<number, number>;
}

export type OrderbookCache = Map<string, OrderbookLevelsState>;

export interface ParsedWsTradeFrame {
  kind: 'trade';
  marketId: string;
  trade: MarketTrade;
  price: number;
  size: number;
}

export interface ParsedWsOrderbookFrame {
  kind: 'orderbook';
  marketId: string;
  isSnapshot: boolean;
  bids: { price: number; quantity: number }[];
  asks: { price: number; quantity: number }[];
}

export interface ParsedWsOracleFrame {
  kind: 'oracle';
  marketId: string;
  markPrice?: number;
  indexPrice?: number;
}

export interface ParsedWsFundingFrame {
  kind: 'funding';
  marketId: string;
  fundingRate: number;
  fundingRate8h?: number;
}

export type ParsedWsMarketFrame =
  | ParsedWsTradeFrame
  | ParsedWsOrderbookFrame
  | ParsedWsFundingFrame
  | ParsedWsOracleFrame;

function toFinite(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Oracle prices arrive as unsigned 18-decimal integer strings (not trade decimals). */
export function parseOracleWei(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return undefined;
  const price = Number(raw) / 1e18;
  return Number.isFinite(price) && price > 0 ? price : undefined;
}

/** RISEx WebSocket L2 price and quantity fields are *both* 18-decimal wei
 * integers. Do not reuse the decimal-string REST/trades decoding path here. */
function decodeOrderbookWei(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw) / 1e18;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseBookLevels(raw: unknown): { price: number; quantity: number }[] {
  if (!Array.isArray(raw)) return [];
  const out: { price: number; quantity: number }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    const price = decodeOrderbookWei(value.price);
    const quantity = decodeOrderbookWei(value.quantity ?? value.size);
    if (price !== null && price > 0 && quantity !== null) {
      // A zero quantity is valid: it removes a level on incremental updates.
      out.push({ price, quantity });
    }
  }
  return out;
}

/**
 * Parses a raw JSON message from wss://ws.rise.trade/ws into normalized frames.
 */
export function parseWsMarketMessage(raw: unknown): ParsedWsMarketFrame[] {
  if (!raw || typeof raw !== 'object') return [];
  const msg = raw as Record<string, any>;
  if (msg.type === 'subscribed' || msg.type === 'unsubscribed' || msg.type === 'pong') {
    return [];
  }

  const channel = String(msg.channel || '').toLowerCase();
  const payload = msg.data;
  if (!payload) return [];

  if (channel === 'oracle') {
    const prices = payload.prices;
    if (!prices || typeof prices !== 'object' || Array.isArray(prices)) return [];
    const frames: ParsedWsOracleFrame[] = [];
    for (const [marketId, entry] of Object.entries(prices)) {
      if (!/^\d+$/.test(marketId) || !entry || typeof entry !== 'object') continue;
      const price = entry as Record<string, unknown>;
      const markPrice = parseOracleWei(price.mark_price);
      const indexPrice = parseOracleWei(price.index_price);
      if (markPrice !== undefined || indexPrice !== undefined) {
        frames.push({ kind: 'oracle', marketId, markPrice, indexPrice });
      }
    }
    return frames;
  }

  if (channel === 'trades') {
    const items = Array.isArray(payload) ? payload : payload.trades || [payload];
    const frames: ParsedWsTradeFrame[] = [];
    for (const t of items) {
      if (!t || typeof t !== 'object') continue;
      const marketId = String(t.market_id ?? msg.market_id ?? '');
      const price = Number(t.price);
      const size = Number(t.size);
      if (!marketId || !Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0) {
        continue;
      }
      frames.push({
        kind: 'trade',
        marketId,
        price,
        size,
        trade: {
          id: String(t.id || `${marketId}-${t.time || Date.now()}-${price}-${size}`),
          maker_side: String(t.maker_side ?? t.side ?? ''),
          price: String(t.price),
          size: String(t.size),
          time: String(t.time ?? t.block_timestamp ?? msg.block_timestamp ?? msg.worker_timestamp ?? msg.timestamp ?? `${Date.now()}000000`),
          block_number: String(t.block_number ?? msg.block_number ?? ''),
          log_index: String(t.log_index ?? msg.log_index ?? ''),
          market_id: marketId,
        },
      });
    }
    return frames;
  }

  if (channel === 'orderbook') {
    const marketId = String(payload.market_id ?? msg.market_id ?? '');
    if (!marketId) return [];
    const isSnapshot = msg.type === 'snapshot';
    const bids = parseBookLevels(payload.bids);
    const asks = parseBookLevels(payload.asks);
    if (bids.length === 0 && asks.length === 0) return [];
    return [
      {
        kind: 'orderbook',
        marketId,
        isSnapshot,
        bids,
        asks,
      },
    ];
  }

  if (channel === 'funding') {
    const items = Array.isArray(payload) ? payload : [payload];
    const frames: ParsedWsFundingFrame[] = [];
    for (const f of items) {
      if (!f || typeof f !== 'object') continue;
      const marketId = String(f.market_id ?? msg.market_id ?? '');
      const rateRaw = f.funding_rate ?? f.current_funding_rate ?? f.predicted_funding_rate;
      const rate = Number(rateRaw);
      if (!marketId || !Number.isFinite(rate)) continue;
      const rate8h = Number(f.funding_rate_8h);
      frames.push({
        kind: 'funding',
        marketId,
        fundingRate: rate,
        fundingRate8h: Number.isFinite(rate8h) ? rate8h : undefined,
      });
    }
    return frames;
  }

  return [];
}

/**
 * Updates top-of-book state from an orderbook snapshot or delta update and returns the new mid-price if valid.
 */
export function updateOrderbookAndGetMid(
  bookCache: OrderbookCache,
  frame: ParsedWsOrderbookFrame
): number | null {
  let state = bookCache.get(frame.marketId);
  if (!state || frame.isSnapshot) {
    state = { bids: new Map(), asks: new Map() };
    bookCache.set(frame.marketId, state);
  }

  for (const lvl of frame.bids) {
    if (lvl.quantity <= 0) state.bids.delete(lvl.price);
    else state.bids.set(lvl.price, lvl.quantity);
  }
  for (const lvl of frame.asks) {
    if (lvl.quantity <= 0) state.asks.delete(lvl.price);
    else state.asks.set(lvl.price, lvl.quantity);
  }

  if (state.bids.size === 0 || state.asks.size === 0) return null;

  let bestBid = -Infinity;
  for (const p of state.bids.keys()) {
    if (p > bestBid) bestBid = p;
  }
  let bestAsk = Infinity;
  for (const p of state.asks.keys()) {
    if (p < bestAsk) bestAsk = p;
  }

  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) {
    return null;
  }
  if (bestAsk < bestBid) return null;
  return (bestBid + bestAsk) / 2;
}

/**
 * Applies a live price update to a RisexMarket while preserving its 24h open baseline for exact % change.
 */
export function applyMarketPricePatch<T extends RisexMarket>(
  market: T,
  opts: {
    markPrice?: number;
    indexPrice?: number;
    lastPrice?: number;
    fundingRate?: number;
    fundingRate8h?: number;
  }
): T {
  const prevMark = toFinite(market.mark_price || market.last_price);
  const prevChange = toFinite(market.change_24h);
  const open24h = prevMark > 0 ? prevMark - prevChange : 0;

  const nextMark =
    opts.markPrice && Number.isFinite(opts.markPrice) && opts.markPrice > 0
      ? opts.markPrice
      : prevMark;
  const nextLast =
    opts.lastPrice && Number.isFinite(opts.lastPrice) && opts.lastPrice > 0
      ? opts.lastPrice
      : toFinite(market.last_price);

  const effectivePrice = nextMark > 0 ? nextMark : nextLast;
  const nextChange24h =
    open24h > 0 && effectivePrice > 0 ? String(effectivePrice - open24h) : market.change_24h;

  // The official 24h high/low and rolling quote volume must come from RISEx REST.
  // Oracle mark ticks and matched trade notional do not safely reconstruct those
  // rolling aggregates (and adding trades to a refreshed total double-counts).

  const nextFunding =
    opts.fundingRate !== undefined && Number.isFinite(opts.fundingRate)
      ? String(opts.fundingRate)
      : market.current_funding_rate;

  const nextFunding8h =
    opts.fundingRate8h !== undefined && Number.isFinite(opts.fundingRate8h)
      ? String(opts.fundingRate8h)
      : market.funding_rate_8h;

  return {
    ...market,
    mark_price: nextMark > 0 ? String(nextMark) : market.mark_price,
    index_price: opts.indexPrice !== undefined && Number.isFinite(opts.indexPrice) && opts.indexPrice > 0
      ? String(opts.indexPrice) : market.index_price,
    last_price: nextLast > 0 ? String(nextLast) : market.last_price,
    change_24h: nextChange24h,
    current_funding_rate: nextFunding,
    funding_rate_8h: nextFunding8h,
  };
}

/**
 * Applies a queued batch of parsed WebSocket frames across the markets array in O(markets + frames).
 * Returns the original markets array reference if no market was modified.
 */
export function applyWsBatchToMarkets<T extends RisexMarket>(
  markets: T[],
  bookCache: OrderbookCache,
  frames: ParsedWsMarketFrame[]
): { markets: T[]; trades: MarketTrade[]; changed: boolean } {
  if (markets.length === 0 || frames.length === 0) {
    return { markets, trades: [], changed: false };
  }

  const patches = new Map<
    string,
    {
      markPrice?: number;
      indexPrice?: number;
      lastPrice?: number;
      fundingRate?: number;
      fundingRate8h?: number;
    }
  >();
  const newTrades: MarketTrade[] = [];
  const marketNameById = new Map<string, string>();
  for (const m of markets) {
    marketNameById.set(String(m.market_id), m.display_name || `MKT-${m.market_id}`);
  }

  for (const frame of frames) {
    const id = frame.marketId;
    if (!marketNameById.has(id)) continue;

    const cur: NonNullable<ReturnType<typeof patches.get>> = patches.get(id) ?? {};
    if (frame.kind === 'trade') {
      cur.lastPrice = frame.price;
      // A trade price is last execution, not the oracle mark price.
      // Keep these separate, including batches without an oracle frame.
      newTrades.push({
        ...frame.trade,
        market_name: marketNameById.get(id),
      });
    } else if (frame.kind === 'orderbook') {
      // The orderbook midpoint is also not the official RISEx mark price.
      updateOrderbookAndGetMid(bookCache, frame);
    } else if (frame.kind === 'oracle') {
      if (frame.markPrice !== undefined) cur.markPrice = frame.markPrice;
      if (frame.indexPrice !== undefined) cur.indexPrice = frame.indexPrice;
    } else if (frame.kind === 'funding') {
      cur.fundingRate = frame.fundingRate;
      if (frame.fundingRate8h !== undefined) {
        cur.fundingRate8h = frame.fundingRate8h;
      }
    }
    patches.set(id, cur);
  }

  if (patches.size === 0) {
    return { markets, trades: newTrades, changed: false };
  }

  let anyChanged = false;
  const nextMarkets = markets.map((m) => {
    const patch = patches.get(String(m.market_id));
    if (!patch) return m;
    if (
      patch.markPrice === undefined &&
      patch.indexPrice === undefined &&
      patch.lastPrice === undefined &&
      patch.fundingRate === undefined
    ) {
      return m;
    }
    const updated = applyMarketPricePatch(m, patch);
    if (
      updated.mark_price === m.mark_price &&
      updated.index_price === m.index_price &&
      updated.last_price === m.last_price &&
      updated.change_24h === m.change_24h &&
      updated.current_funding_rate === m.current_funding_rate &&
      updated.funding_rate_8h === m.funding_rate_8h
    ) return m;
    anyChanged = true;
    return updated;
  });

  return {
    markets: anyChanged ? nextMarkets : markets,
    trades: newTrades,
    changed: anyChanged,
  };
}

/** Timestamped oracle overlay to prevent old REST snapshots from visibly
 * reversing a newer WS mark/index quote. Never carry a quote forever. */
export interface TimedOracleQuote {
  receivedAt: number;
  markPrice?: number;
  indexPrice?: number;
}

export function mergeSnapshotWithRecentOracle<T extends RisexMarket>(
  snapshot: T[],
  oracleQuotes: ReadonlyMap<string, TimedOracleQuote>,
  now = Date.now(),
  freshnessMs = 20_000
): T[] {
  return snapshot.map((market) => {
    const quote = oracleQuotes.get(String(market.market_id));
    if (!quote || quote.receivedAt > now || now - quote.receivedAt > freshnessMs) return market;
    if (quote.markPrice === undefined && quote.indexPrice === undefined) return market;
    return applyMarketPricePatch(market, { markPrice: quote.markPrice, indexPrice: quote.indexPrice });
  });
}
