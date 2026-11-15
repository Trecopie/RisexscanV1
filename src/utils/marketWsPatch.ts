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

export interface ParsedWsFundingFrame {
  kind: 'funding';
  marketId: string;
  fundingRate: number;
  fundingRate8h?: number;
}

export type ParsedWsMarketFrame =
  | ParsedWsTradeFrame
  | ParsedWsOrderbookFrame
  | ParsedWsFundingFrame;

function toFinite(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseBookLevels(raw: unknown): { price: number; quantity: number }[] {
  if (!Array.isArray(raw)) return [];
  const out: { price: number; quantity: number }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const price = Number((item as any).price);
    const quantity = Number((item as any).quantity ?? (item as any).size ?? 0);
    if (Number.isFinite(price) && price > 0 && Number.isFinite(quantity) && quantity >= 0) {
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
          maker_side: String(t.maker_side || t.side || 'buy'),
          price: String(t.price),
          size: String(t.size),
          time: String(t.time || Date.now()),
          block_number: String(t.block_number || ''),
          log_index: String(t.log_index || ''),
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
    lastPrice?: number;
    tradeVolumeUsd?: number;
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

  const prevHigh = toFinite(market.high_24h);
  const prevLow = toFinite(market.low_24h);
  const nextHigh =
    effectivePrice > 0 && (prevHigh <= 0 || effectivePrice > prevHigh)
      ? String(effectivePrice)
      : market.high_24h;
  const nextLow =
    effectivePrice > 0 && (prevLow <= 0 || effectivePrice < prevLow)
      ? String(effectivePrice)
      : market.low_24h;

  const nextVolume =
    opts.tradeVolumeUsd && Number.isFinite(opts.tradeVolumeUsd) && opts.tradeVolumeUsd > 0
      ? String(toFinite(market.quote_volume_24h) + opts.tradeVolumeUsd)
      : market.quote_volume_24h;

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
    last_price: nextLast > 0 ? String(nextLast) : market.last_price,
    change_24h: nextChange24h,
    high_24h: nextHigh,
    low_24h: nextLow,
    quote_volume_24h: nextVolume,
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
      lastPrice?: number;
      tradeVolumeUsd: number;
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

    const cur = patches.get(id) || { tradeVolumeUsd: 0 };
    if (frame.kind === 'trade') {
      cur.lastPrice = frame.price;
      cur.markPrice = frame.price;
      cur.tradeVolumeUsd += frame.price * frame.size;
      newTrades.push({
        ...frame.trade,
        market_name: marketNameById.get(id),
      });
    } else if (frame.kind === 'orderbook') {
      const mid = updateOrderbookAndGetMid(bookCache, frame);
      if (mid !== null) {
        cur.markPrice = mid;
      }
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
      patch.lastPrice === undefined &&
      patch.tradeVolumeUsd === 0 &&
      patch.fundingRate === undefined
    ) {
      return m;
    }
    anyChanged = true;
    return applyMarketPricePatch(m, patch);
  });

  return {
    markets: anyChanged ? nextMarkets : markets,
    trades: newTrades,
    changed: anyChanged,
  };
}
