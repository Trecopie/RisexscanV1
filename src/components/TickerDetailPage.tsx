import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownUp,
  ArrowLeft,
  Clock,
  Eye,
  Filter,
  Loader2,
  Search,
} from 'lucide-react';
import type {
  FundingRateRecord,
  IndexedPositionRow,
  MarketCandle,
  MarketTrade,
  OrderbookLevel,
  RisexMarket,
} from '../types/risex';
import {
  calcMarketChangePct,
  formatDateTime,
  formatNumber,
  formatPct,
  formatPrice,
  formatSignedUsd,
  formatTimeShort,
  formatUsd,
  nsToMs,
  shortAddress,
} from '../utils/format';
import { mergeLiveTradeIntoBars, normalizeCandles } from '../utils/indicators';
import { LongShortBiasBar } from './Charts';
import { TradingViewChart } from './TradingViewChart';
import { LiquidityDepthHeatmap } from './LiquidityDepthHeatmap';
import { useMarketStream } from '../context/MarketWebSocketContext';
import { parseWsMarketMessage, updateOrderbookAndGetMid, type OrderbookCache } from '../utils/marketWsPatch';
import { calcLiqDistancePct, LiqDistanceBadge, TokenBadge, TraderAvatar } from './TraderAvatar';

interface TickerAnalyticsResponse {
  market: RisexMarket;
  positioning: {
    totalPositions: number;
    longCount: number;
    shortCount: number;
    longNotional: number;
    shortNotional: number;
    avgLongEntry: number;
    avgShortEntry: number;
    longUnrealizedPnl: number;
    shortUnrealizedPnl: number;
  };
  positions: IndexedPositionRow[];
  indexedTradersCount: number;
}

type PosSortKey = 'pnl' | 'roi' | 'portfolioValue' | 'notional' | 'size' | 'leverage' | 'liqDist';

export const TickerDetailPage: React.FC<{
  marketId: string;
  onBack: () => void;
  onSelectMarket: (marketId: string) => void;
  onSelectWallet: (address: string) => void;
  onPeekTrader: (address: string) => void;
}> = ({ marketId, onBack, onSelectMarket, onSelectWallet, onPeekTrader }) => {
  const { markets: streamedMarkets } = useMarketStream();
  const [analytics, setAnalytics] = useState<TickerAnalyticsResponse | null>(null);
  const [allMarkets, setAllMarkets] = useState<RisexMarket[]>([]);
  const [candles, setCandles] = useState<MarketCandle[]>([]);
  const [resolution, setResolution] = useState('1H');
  const [orderbook, setOrderbook] = useState<{ bids: OrderbookLevel[]; asks: OrderbookLevel[] }>({
    bids: [],
    asks: [],
  });
  const [trades, setTrades] = useState<MarketTrade[]>([]);
  const [fundingHistory, setFundingHistory] = useState<FundingRateRecord[]>([]);
  const [bookTab, setBookTab] = useState<'book' | 'trades'>('book');
  const [bookIsLive, setBookIsLive] = useState(false);
  const bookLiveRef = React.useRef(false);
  const [loading, setLoading] = useState(true);

  const [posSort, setPosSort] = useState<PosSortKey>('pnl');
  const [posDesc, setPosDesc] = useState(true);
  const [sideFilter, setSideFilter] = useState<'ALL' | 'LONG' | 'SHORT'>('ALL');
  const [posSearch, setPosSearch] = useState('');

  const marketAbortRef = React.useRef<AbortController | null>(null);
  const candleAbortRef = React.useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/markets', { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.markets && setAllMarkets(d.markets))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const loadMarketData = async (showLoader = false) => {
    marketAbortRef.current?.abort();
    const controller = new AbortController();
    marketAbortRef.current = controller;
    if (showLoader) setLoading(true);
    const safeJson = async (url: string) => {
      const r = await fetch(url, { signal: controller.signal });
      if (!r.ok) return null;
      return r.json();
    };
    try {
      const [anRes, obRes, trRes, fnRes] = await Promise.allSettled([
        safeJson(`/api/ticker/${marketId}/analytics`),
        safeJson(`/api/markets/${marketId}/orderbook`),
        safeJson(`/api/markets/${marketId}/trades?limit=60`),
        safeJson(`/api/markets/${marketId}/funding`),
      ]);
      if (controller.signal.aborted) return;
      if (anRes.status === 'fulfilled' && anRes.value && !anRes.value.error) setAnalytics(anRes.value);
      if (obRes.status === 'fulfilled' && obRes.value && !obRes.value.error && !bookLiveRef.current) {
        setOrderbook({ bids: obRes.value.bids || [], asks: obRes.value.asks || [] });
      }
      if (trRes.status === 'fulfilled' && trRes.value?.trades) setTrades(trRes.value.trades);
      if (fnRes.status === 'fulfilled' && fnRes.value?.records) setFundingHistory(fnRes.value.records);
    } catch {
      // ignore
    } finally {
      if (showLoader && !controller.signal.aborted) setLoading(false);
    }
  };

  const loadCandles = () => {
    candleAbortRef.current?.abort();
    const controller = new AbortController();
    candleAbortRef.current = controller;
    fetch(`/api/markets/${marketId}/candles?resolution=${resolution}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!controller.signal.aborted && d?.candles) setCandles(d.candles);
      })
      .catch(() => {});
  };

  useEffect(() => {
    loadMarketData(true);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadMarketData(false);
      }
    }, 12000);
    return () => {
      marketAbortRef.current?.abort();
      clearInterval(timer);
    };
  }, [marketId]);

  useEffect(() => {
    loadCandles();
    return () => candleAbortRef.current?.abort();
  }, [marketId, resolution]);

  // Live WS trades and L2 depth for only the selected ticker.
  // Coalesce orderbook deltas so they don't rerender the full ticker on every level.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let bookUpdateTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;
    const bookCache: OrderbookCache = new Map();
    bookLiveRef.current = false;
    setBookIsLive(false);

    const flushBook = () => {
      bookUpdateTimer = null;
      const state = bookCache.get(String(marketId));
      if (!state || disposed) return;
      const bids = [...state.bids].sort((a, b) => b[0] - a[0]).slice(0, 50)
        .map(([price, size]) => ({ price: String(price), size: String(size) }));
      const asks = [...state.asks].sort((a, b) => a[0] - b[0]).slice(0, 50)
        .map(([price, size]) => ({ price: String(price), size: String(size) }));
      if (bids.length === 0 || asks.length === 0) return;
      bookLiveRef.current = true;
      setBookIsLive(true);
      setOrderbook({ bids, asks });
    };

    const connect = () => {
      if (disposed || document.visibilityState === 'hidden') return;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      try {
        ws = new WebSocket('wss://ws.rise.trade/ws');
        ws.onopen = () => {
          attempt = 0;
          ws?.send(JSON.stringify({method:'subscribe',params:{channel:'trades',market_ids:[Number(marketId)]}}));
          ws?.send(JSON.stringify({method:'subscribe',params:{channel:'orderbook',market_ids:[Number(marketId)]}}));
        };
        ws.onmessage = (ev) => {
          if (disposed || document.visibilityState === 'hidden') return;
          try {
            // Share the same validated RISEx WS decoder as the market-wide feed.
            // RISEx sends market ID, block and timestamp in the message envelope,
            // not necessarily inside its trade data object.
            const frames = parseWsMarketMessage(JSON.parse(String(ev.data)));
            for (const frame of frames) {
              if (frame.kind !== 'orderbook' || frame.marketId !== String(marketId)) continue;
              updateOrderbookAndGetMid(bookCache, frame);
              if (!bookUpdateTimer) bookUpdateTimer = setTimeout(flushBook, 120);
            }
            const fresh: MarketTrade[] = frames
              .filter((frame) => frame.kind === 'trade' && frame.marketId === String(marketId))
              .map((frame) => frame.kind === 'trade' ? frame.trade : null)
              .filter((trade): trade is MarketTrade => trade !== null);
            if (fresh.length > 0) {
              setTrades((prev) => {
                const seen = new Set(prev.map((x) => x.id));
                return [...fresh.filter((x) => !seen.has(x.id)), ...prev].slice(0, 60);
              });
              setCandles((prev) => {
                if (prev.length === 0) return prev;
                let bars = normalizeCandles(prev);
                for (const tr of fresh) {
                  bars = mergeLiveTradeIntoBars(
                    bars,
                    {
                      price: Number(tr.price),
                      size: Number(tr.size),
                      timeMs: nsToMs(tr.time) || Date.now(),
                    },
                    resolution
                  );
                }
                return bars.map((b) => ({
                  time: b.time * 1000,
                  open: b.open,
                  high: b.high,
                  low: b.low,
                  close: b.close,
                  volume: b.volume,
                }));
              });
            }
          } catch {
            // ignore
          }
        };
        ws.onclose = () => {
          ws = null;
          bookLiveRef.current = false;
          if (disposed) return;
          setBookIsLive(false);
          if (document.visibilityState === 'hidden') return;
          const delay = Math.min(30000, 1500 * Math.pow(2, attempt++));
          reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
        };
        ws.onerror = () => {
          ws?.close();
        };
      } catch {
        if (!disposed) {
          const delay = Math.min(30000, 1500 * Math.pow(2, attempt++));
          reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
        }
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') ws?.close();
      else {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    connect();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (bookUpdateTimer) clearTimeout(bookUpdateTimer);
      bookLiveRef.current = false;
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        // ignore
      }
    };
  }, [marketId, resolution]);

  const sortedPositions = useMemo(() => {
    const raw = analytics?.positions || [];
    const q = posSearch.trim().toLowerCase();
    const filtered = raw.filter((p) => {
      if (sideFilter !== 'ALL' && p.side !== sideFilter) return false;
      if (q) {
        const hitAddr = p.address.toLowerCase().includes(q);
        const hitUser = p.username?.toLowerCase().includes(q);
        if (!hitAddr && !hitUser) return false;
      }
      return true;
    });

    const getVal = (p: IndexedPositionRow): number => {
      switch (posSort) {
        case 'pnl':
          return p.unrealizedPnl;
        case 'roi':
          return p.roiPct;
        case 'portfolioValue':
          return p.portfolioValue;
        case 'notional':
          return p.notionalUsd;
        case 'size':
          return p.size;
        case 'leverage':
          return p.leverage;
        case 'liqDist': {
          const d = calcLiqDistancePct(p.markPrice, p.liquidationPrice, p.side);
          return d === null ? 9999 : -d; // descending puts lowest (closest to liq) first
        }
      }
    };

    return [...filtered].sort((a, b) => {
      const diff = getVal(b) - getVal(a);
      return posDesc ? diff : -diff;
    });
  }, [analytics, sideFilter, posSearch, posSort, posDesc]);

  const togglePosSort = (k: PosSortKey) => {
    if (posSort === k) setPosDesc((d) => !d);
    else {
      setPosSort(k);
      setPosDesc(true);
    }
  };

  // Shared oracle prices update each block while analytics supplies position snapshots.
  const liveMarket = streamedMarkets.find((m) => String(m.market_id) === String(marketId));
  const market = liveMarket || analytics?.market;
  const markPrice = Number(market?.mark_price || market?.last_price || 0);
  const chg24h = calcMarketChangePct(markPrice, market?.change_24h);
  const oiUsd = Number(market?.open_interest || 0) * markPrice;
  const funding1hPct = Number(market?.current_funding_rate || 0) * 100;
  const fundingApr = funding1hPct * 24 * 365;

  const topAsks = useMemo(() => [...orderbook.asks].slice(0, 10).reverse(), [orderbook.asks]);
  const topBids = useMemo(() => [...orderbook.bids].slice(0, 10), [orderbook.bids]);
  const maxBookSize = useMemo(
    () =>
      Math.max(
        ...topAsks.map((a) => Number(a.size || 0)),
        ...topBids.map((b) => Number(b.size || 0)),
        1e-9
      ),
    [topAsks, topBids]
  );

  return (
    <div className="space-y-6">
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700/60 bg-[#090e1a] px-3 py-1.5 text-xs text-slate-300 hover:border-[#ffb02e]/60 hover:text-[#e8edfb]"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            All Markets
          </button>
          {market && (
            <div className="flex items-center gap-2.5">
              <TokenBadge symbol={market.base_asset_symbol} size={32} />
              <div>
                <h1 className="font-display text-xl sm:text-2xl font-bold text-[#e8edfb]">
                  {market.display_name}
                </h1>
                <div className="text-[11px] font-mono text-slate-400">
                  Market #{market.market_id} · Max {market.config?.max_leverage}x · {market.category || 'PERP'}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Market Switcher */}
        {allMarkets.length > 0 && (
          <select
            value={marketId}
            onChange={(e) => onSelectMarket(e.target.value)}
            className="rounded-xl border border-slate-700/60 bg-[#090e1a] px-3 py-1.5 text-xs font-mono text-[#e8edfb] focus:border-[#ffb02e] focus:outline-none"
          >
            {allMarkets.map((m) => (
              <option key={m.market_id} value={String(m.market_id)}>
                {m.display_name} — {formatPrice(m.mark_price || m.last_price)}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Market Stats Strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="sunrise-card rounded-xl p-3.5">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Mark Price</div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-[#e8edfb]">
            {formatPrice(markPrice)}
          </div>
          <div className={`font-mono text-xs tabular-nums ${chg24h >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}`}>
            {formatPct(chg24h)} (24h)
          </div>
        </div>
        <div className="sunrise-card rounded-xl p-3.5">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Index Price</div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-slate-200">
            {formatPrice(market?.index_price)}
          </div>
          <div className="font-mono text-[11px] text-slate-400">
            H {formatPrice(market?.high_24h)} / L {formatPrice(market?.low_24h)}
          </div>
        </div>
        <div className="sunrise-card rounded-xl p-3.5">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">24h Volume</div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-[#e8edfb]">
            {formatUsd(market?.quote_volume_24h, true)}
          </div>
        </div>
        <div className="sunrise-card rounded-xl p-3.5">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Open Interest</div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-[#ffb02e]">
            {formatUsd(oiUsd, true)}
          </div>
          <div className="font-mono text-[11px] text-slate-400">
            {formatNumber(market?.open_interest, 2)} {market?.base_asset_symbol}
          </div>
        </div>
        <div className="sunrise-card rounded-xl p-3.5">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Funding (1h / APR)</div>
          <div className={`mt-1 font-mono text-base font-bold tabular-nums ${funding1hPct >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}`}>
            {funding1hPct >= 0 ? '+' : ''}
            {funding1hPct.toFixed(4)}%
          </div>
          <div className="font-mono text-[11px] text-slate-400">
            {fundingApr >= 0 ? '+' : ''}
            {fundingApr.toFixed(1)}% APR
          </div>
        </div>
        <div className="sunrise-card rounded-xl p-3.5">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Indexed Positions</div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-[#46a6ff]">
            {analytics?.positioning?.totalPositions ?? 0}
          </div>
          <div className="font-mono text-[11px] text-slate-400">
            Across {analytics?.indexedTradersCount ?? 0} traders
          </div>
        </div>
      </div>

      {/* Chart + Orderbook / Trades (stretched full-height row) */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 items-stretch">
        <div className="sunrise-card rounded-2xl p-4 lg:col-span-8 flex flex-col min-h-[540px]">
          <TradingViewChart
            marketId={marketId}
            symbol={market?.display_name}
            candles={candles}
            resolution={resolution}
            onResolutionChange={setResolution}
            liveMarkPrice={markPrice}
          />
        </div>

        {/* Orderbook + Recent Trades */}
        <div className="sunrise-card rounded-2xl p-4 lg:col-span-4 flex flex-col min-h-[540px]">
          <div className="mb-3 flex items-center gap-1 rounded-xl border border-slate-800 bg-[#090e1a] p-1">
            <button
              type="button"
              onClick={() => setBookTab('book')}
              className={`flex-1 rounded-lg py-1.5 text-xs font-medium transition-colors ${
                bookTab === 'book' ? 'bg-[#131c31] text-[#ffb02e]' : 'text-slate-400'
              }`}
            >
              L2 Orderbook {bookIsLive && <span className="ml-1 text-[#22e0a1]" title="Live orderbook stream">●</span>}
            </button>
            <button
              type="button"
              onClick={() => setBookTab('trades')}
              className={`flex-1 rounded-lg py-1.5 text-xs font-medium transition-colors ${
                bookTab === 'trades' ? 'bg-[#131c31] text-[#ffb02e]' : 'text-slate-400'
              }`}
            >
              Recent Fills ({trades.length})
            </button>
          </div>

          {bookTab === 'book' ? (
            <div className="flex-1 flex flex-col justify-between text-xs font-mono tabular-nums">
              <div className="mb-1 flex justify-between text-[10px] uppercase text-slate-500">
                <span>Price</span>
                <span>Size ({market?.base_asset_symbol})</span>
              </div>
              <div className="space-y-0.5">
                {topAsks.map((a, idx) => {
                  const pct = (Number(a.size || 0) / maxBookSize) * 100;
                  return (
                    <div key={idx} className="relative flex justify-between rounded px-2 py-1 overflow-hidden">
                      <div
                        className="pointer-events-none absolute right-0 top-0 bottom-0 bg-[#ff4d6d]/14"
                        style={{ width: `${Math.min(100, pct)}%` }}
                      />
                      <span className="relative text-[#ff4d6d]">{formatPrice(a.price)}</span>
                      <span className="relative text-slate-300">{formatNumber(a.size, 3)}</span>
                    </div>
                  );
                })}
              </div>

              <div className="my-2 flex items-center justify-between rounded-lg border border-slate-800 bg-[#090e1a] px-3 py-1.5">
                <span className="text-[11px] text-slate-400">Mark</span>
                <span className="font-bold text-[#ffb02e]">{formatPrice(markPrice)}</span>
              </div>

              <div className="space-y-0.5">
                {topBids.map((b, idx) => {
                  const pct = (Number(b.size || 0) / maxBookSize) * 100;
                  return (
                    <div key={idx} className="relative flex justify-between rounded px-2 py-1 overflow-hidden">
                      <div
                        className="pointer-events-none absolute right-0 top-0 bottom-0 bg-[#22e0a1]/14"
                        style={{ width: `${Math.min(100, pct)}%` }}
                      />
                      <span className="relative text-[#22e0a1]">{formatPrice(b.price)}</span>
                      <span className="relative text-slate-300">{formatNumber(b.size, 3)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex-1 max-h-[480px] overflow-y-auto space-y-1 text-xs font-mono tabular-nums">
              {trades.map((tr, i) => {
                const isBuy = tr.maker_side?.toLowerCase().includes('buy') || tr.maker_side === '0';
                return (
                  <div key={`${tr.id}-${i}`} className="flex items-center justify-between rounded px-2 py-1 hover:bg-[#131c31]/60">
                    <span className={isBuy ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}>{formatPrice(tr.price)}</span>
                    <span className="text-slate-300">{formatNumber(tr.size, 3)}</span>
                    <span className="text-slate-500">{formatTimeShort(tr.time)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <LiquidityDepthHeatmap
        bids={orderbook.bids}
        asks={orderbook.asks}
        markPrice={markPrice}
        baseSymbol={market?.base_asset_symbol}
      />

      {/* Market Positioning Bias */}
      {analytics && (
        <div className="space-y-3">
          <LongShortBiasBar
            longNotional={analytics.positioning.longNotional}
            shortNotional={analytics.positioning.shortNotional}
            longCount={analytics.positioning.longCount}
            shortCount={analytics.positioning.shortCount}
          />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="sunrise-card rounded-xl p-3">
              <div className="text-[11px] uppercase text-slate-400">Avg Long Entry</div>
              <div className="mt-1 font-mono text-sm font-bold text-[#22e0a1]">
                {analytics.positioning.avgLongEntry > 0 ? formatPrice(analytics.positioning.avgLongEntry) : '—'}
              </div>
            </div>
            <div className="sunrise-card rounded-xl p-3">
              <div className="text-[11px] uppercase text-slate-400">Avg Short Entry</div>
              <div className="mt-1 font-mono text-sm font-bold text-[#ff4d6d]">
                {analytics.positioning.avgShortEntry > 0 ? formatPrice(analytics.positioning.avgShortEntry) : '—'}
              </div>
            </div>
            <div className="sunrise-card rounded-xl p-3">
              <div className="text-[11px] uppercase text-slate-400">Longs Unrealized PnL</div>
              <div
                className={`mt-1 font-mono text-sm font-bold ${
                  analytics.positioning.longUnrealizedPnl >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                }`}
              >
                {formatSignedUsd(analytics.positioning.longUnrealizedPnl, true)}
              </div>
            </div>
            <div className="sunrise-card rounded-xl p-3">
              <div className="text-[11px] uppercase text-slate-400">Shorts Unrealized PnL</div>
              <div
                className={`mt-1 font-mono text-sm font-bold ${
                  analytics.positioning.shortUnrealizedPnl >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                }`}
              >
                {formatSignedUsd(analytics.positioning.shortUnrealizedPnl, true)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Open Positions on this Market (Sortable by PnL, ROI, Portfolio Value, Liq Distance) */}
      <div className="sunrise-card overflow-hidden rounded-2xl">
        <div className="flex flex-col gap-3 border-b border-slate-800/80 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="font-display text-base font-bold text-[#e8edfb]">
              Open Positions on {market?.display_name || `Market #${marketId}`} ({sortedPositions.length})
            </h2>
            <p className="text-xs text-slate-400">
              Sort live trader positions by Unrealized PnL, ROI %, Portfolio Value, Notional Size, or Liquidation Proximity
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-xl border border-slate-800 bg-[#090e1a] p-1 text-xs">
              <Filter className="ml-1.5 h-3 w-3 text-slate-400" />
              {(['ALL', 'LONG', 'SHORT'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSideFilter(s)}
                  className={`rounded-lg px-2.5 py-1 font-mono ${
                    sideFilter === s ? 'bg-[#ffb02e]/20 text-[#ffb02e]' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={posSearch}
                onChange={(e) => setPosSearch(e.target.value)}
                placeholder="Filter username or 0x…"
                className="rounded-xl border border-slate-700/60 bg-[#090e1a] py-1.5 pl-8 pr-3 text-xs text-[#e8edfb] placeholder:text-slate-500 focus:border-[#ffb02e] focus:outline-none"
              />
            </div>
            <select
              value={posSort}
              onChange={(e) => {
                setPosSort(e.target.value as PosSortKey);
                setPosDesc(true);
              }}
              className="rounded-xl border border-slate-700/60 bg-[#090e1a] px-3 py-1.5 text-xs text-[#e8edfb] focus:border-[#ffb02e] focus:outline-none"
            >
              <option value="pnl">Sort: Unrealized PnL</option>
              <option value="roi">Sort: ROI %</option>
              <option value="portfolioValue">Sort: Portfolio Value</option>
              <option value="notional">Sort: Position Value</option>
              <option value="size">Sort: Position Size</option>
              <option value="liqDist">Sort: Near Liquidation</option>
              <option value="leverage">Sort: Leverage</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-800 bg-[#090e1a]/80 text-[11px] uppercase tracking-wider text-slate-400">
              <tr>
                <th className="py-3 pl-4 pr-2">Trader</th>
                <th className="py-3 px-2">Side</th>
                <th className="py-3 px-2 text-right cursor-pointer hover:text-[#ffb02e]" onClick={() => togglePosSort('notional')}>
                  <span className="inline-flex items-center gap-1">Position Value <ArrowDownUp className="h-3 w-3" /></span>
                </th>
                <th className="py-3 px-2 text-right">Entry</th>
                <th className="py-3 px-2 text-right cursor-pointer hover:text-[#ffb02e]" onClick={() => togglePosSort('liqDist')}>
                  <span className="inline-flex items-center gap-1">Liq. Price & Risk <ArrowDownUp className="h-3 w-3" /></span>
                </th>
                <th className="py-3 px-2 text-right cursor-pointer hover:text-[#ffb02e]" onClick={() => togglePosSort('pnl')}>
                  <span className="inline-flex items-center gap-1">Unrealized PnL <ArrowDownUp className="h-3 w-3" /></span>
                </th>
                <th className="py-3 px-2 text-right cursor-pointer hover:text-[#ffb02e]" onClick={() => togglePosSort('roi')}>
                  <span className="inline-flex items-center gap-1">ROI % <ArrowDownUp className="h-3 w-3" /></span>
                </th>
                <th className="py-3 px-2 text-right cursor-pointer hover:text-[#ffb02e]" onClick={() => togglePosSort('portfolioValue')}>
                  <span className="inline-flex items-center gap-1">Portfolio Value <ArrowDownUp className="h-3 w-3" /></span>
                </th>
                <th className="py-3 pl-2 pr-4 text-right">Peek</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 tabular-nums">
              {loading && (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-slate-400">
                    <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin text-[#ffb02e]" />
                    Loading trader positions…
                  </td>
                </tr>
              )}
              {!loading && sortedPositions.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-slate-400">
                    No open positions currently indexed for this ticker filter.
                  </td>
                </tr>
              )}
              {!loading &&
                sortedPositions.map((p, idx) => (
                  <tr
                    key={`${p.address}-${idx}`}
                    onClick={() => onSelectWallet(p.address)}
                    className="cursor-pointer hover:bg-[#131c31]/70 transition-colors"
                  >
                    <td className="py-3 pl-4 pr-2">
                      <div className="flex items-center gap-2.5">
                        <TraderAvatar
                          address={p.address}
                          avatarUrl={p.avatarUrl}
                          username={p.username}
                          size={26}
                        />
                        <div className="min-w-0">
                          <div className="truncate font-semibold text-[#e8edfb] max-w-[140px]">
                            {p.username || shortAddress(p.address)}
                          </div>
                          <div className="font-mono text-[10px] text-slate-500">
                            {shortAddress(p.address, 6, 4)}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-mono font-semibold ${
                          p.side === 'LONG'
                            ? 'bg-[#22e0a1]/15 text-[#22e0a1]'
                            : 'bg-[#ff4d6d]/15 text-[#ff4d6d]'
                        }`}
                      >
                        {p.side} {p.leverage.toFixed(1)}x
                      </span>
                    </td>
                    <td className="py-3 px-2 text-right font-mono">
                      <div className="font-semibold text-[#e8edfb]">{formatUsd(p.notionalUsd, true)}</div>
                      <div className="text-[10px] text-slate-400">{formatNumber(p.size, 3)} {market?.base_asset_symbol}</div>
                    </td>
                    <td className="py-3 px-2 text-right font-mono text-slate-300">
                      {formatPrice(p.entryPrice)}
                    </td>
                    <td className="py-3 px-2 text-right font-mono">
                      <div className="text-slate-300">{p.liquidationPrice > 0 ? formatPrice(p.liquidationPrice) : '—'}</div>
                      <div className="mt-0.5 flex justify-end">
                        <LiqDistanceBadge
                          markPrice={p.markPrice}
                          liquidationPrice={p.liquidationPrice}
                          side={p.side}
                        />
                      </div>
                    </td>
                    <td
                      className={`py-3 px-2 text-right font-mono font-semibold ${
                        p.unrealizedPnl >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                      }`}
                    >
                      {formatSignedUsd(p.unrealizedPnl, true)}
                    </td>
                    <td
                      className={`py-3 px-2 text-right font-mono font-semibold ${
                        p.roiPct >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                      }`}
                    >
                      {formatPct(p.roiPct)}
                    </td>
                    <td className="py-3 px-2 text-right font-mono text-slate-200">
                      {formatUsd(p.portfolioValue, true)}
                    </td>
                    <td className="py-3 pl-2 pr-4 text-right">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onPeekTrader(p.address);
                        }}
                        className="rounded-lg border border-slate-700/60 bg-[#090e1a] p-1.5 text-slate-300 hover:border-[#ffb02e]/60 hover:text-[#ffb02e]"
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent Funding Settlements */}
      {fundingHistory.length > 0 && (
        <div className="sunrise-card rounded-2xl p-4">
          <div className="mb-3 flex items-center gap-2">
            <Clock className="h-4 w-4 text-[#ffb02e]" />
            <h3 className="font-display text-sm font-bold text-[#e8edfb]">Recent Funding Rate Settlements</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono tabular-nums">
              <thead className="border-b border-slate-800 text-[11px] uppercase text-slate-400">
                <tr>
                  <th className="py-2 pr-3">Settlement Time</th>
                  <th className="py-2 px-3 text-right">1h Rate</th>
                  <th className="py-2 px-3 text-right">8h Rate</th>
                  <th className="py-2 pl-3 text-right">Index Price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {fundingHistory.slice(0, 12).map((f, i) => {
                  const r1 = Number(f.funding_rate || 0) * 100;
                  const r8 = Number(f.funding_rate_8h || 0) * 100;
                  return (
                    <tr key={i}>
                      <td className="py-2 pr-3 text-slate-300">{formatDateTime(f.time || f.block_time)}</td>
                      <td className={`py-2 px-3 text-right ${r1 >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}`}>
                        {r1 >= 0 ? '+' : ''}
                        {r1.toFixed(5)}%
                      </td>
                      <td className={`py-2 px-3 text-right ${r8 >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}`}>
                        {r8 >= 0 ? '+' : ''}
                        {r8.toFixed(4)}%
                      </td>
                      <td className="py-2 pl-3 text-right text-slate-200">{formatPrice(f.index_price)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
