import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Blocks,
  Eye,
  Plus,
  Search,
  TrendingDown,
  TrendingUp,
  Trophy,
  Users,
  X,
  Zap,
} from 'lucide-react';
import type { IndexedTrader, MarketTrade, RisexMarket } from '../types/risex';
import { calcMarketChangePct, formatPct, formatPrice, formatSignedUsd, formatTimeShort, formatUsd, shortAddress } from '../utils/format';
import type { NavTab } from './Navbar';
import { MiniSparkline } from './Charts';
import { RisexSymbol } from './RisexSymbol';
import { TokenBadge, TraderAvatar } from './TraderAvatar';

interface OverviewResponse {
  totalVolume24h: number;
  totalOpenInterestUsd: number;
  activeMarketsCount: number;
  totalMarketsCount: number;
  totalDiscoveredCount: number;
  indexedTradersCount: number;
  totalEquityTracked: number;
  totalOpenPositions: number;
  blockNumber: number | null;
  chainName: string;
  chainId: string;
  indexingInProgress: boolean;
}

const WATCHLIST_KEY = 'risexscan_watchlist_v1';

export const OverviewPage: React.FC<{
  onSelectWallet: (address: string) => void;
  onSelectMarket: (marketId: string) => void;
  onNavigateTab: (tab: NavTab) => void;
  onPeekTrader: (address: string, trader?: IndexedTrader) => void;
}> = ({ onSelectWallet, onSelectMarket, onNavigateTab, onPeekTrader }) => {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [markets, setMarkets] = useState<RisexMarket[]>([]);
  const [topTraders, setTopTraders] = useState<IndexedTrader[]>([]);
  const [recentTrades, setRecentTrades] = useState<MarketTrade[]>([]);
  const [walletInput, setWalletInput] = useState('');
  const [watchlistIds, setWatchlistIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(WATCHLIST_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [addWatchOpen, setAddWatchOpen] = useState(false);

  const loadOverviewData = async () => {
    try {
      const [ovRes, mkRes, lbRes, trRes] = await Promise.all([
        fetch('/api/overview').then((r) => r.json()),
        fetch('/api/markets').then((r) => r.json()),
        fetch('/api/leaderboard?limit=15').then((r) => r.json()),
        fetch('/api/trades/recent').then((r) => r.json()),
      ]);
      if (ovRes && !ovRes.error) setOverview(ovRes);
      if (mkRes?.markets) {
        setMarkets(mkRes.markets);
        setWatchlistIds((prev) => {
          if (prev.length > 0) return prev;
          const defaults = ['BTC', 'ETH', 'SOL', 'RISE']
            .map((sym) => mkRes.markets.find((m: RisexMarket) => m.base_asset_symbol.toUpperCase() === sym))
            .filter(Boolean)
            .map((m: RisexMarket) => String(m.market_id));
          return defaults.length > 0
            ? defaults
            : mkRes.markets.slice(0, 4).map((m: RisexMarket) => String(m.market_id));
        });
      }
      if (lbRes?.traders) {
        const sorted = [...lbRes.traders].sort((a, b) => b.totalPnlAll - a.totalPnlAll);
        setTopTraders(sorted.slice(0, 10));
      }
      if (trRes?.trades) setRecentTrades(trRes.trades.slice(0, 18));
    } catch {
      // handled gracefully
    }
  };

  const watchMenuRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (watchMenuRef.current && !watchMenuRef.current.contains(e.target as Node)) {
        setAddWatchOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  useEffect(() => {
    loadOverviewData();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadOverviewData();
      }
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  // Live RISEx WebSocket stream for global fills with reconnect backoff
  useEffect(() => {
    if (markets.length === 0) return;
    const topIds = [...markets]
      .sort((a, b) => Number(b.quote_volume_24h || 0) - Number(a.quote_volume_24h || 0))
      .slice(0, 6)
      .map((m) => Number(m.market_id));

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      try {
        ws = new WebSocket('wss://ws.rise.trade/ws');
        ws.onopen = () => {
          attempt = 0;
          ws?.send(
            JSON.stringify({
              method: 'subscribe',
              params: { channel: 'trades', market_ids: topIds },
            })
          );
        };
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            const payload = msg?.data;
            if (!payload) return;
            const items = Array.isArray(payload) ? payload : payload.trades || [payload];
            const mapped: MarketTrade[] = items
              .filter((t: any) => t && t.price && t.size)
              .map((t: any) => {
                const mId = String(t.market_id || msg.market_id || '');
                const mk = markets.find((m) => String(m.market_id) === mId);
                return {
                  id: String(t.id || `${Date.now()}-${Math.random()}`),
                  maker_side: String(t.maker_side || t.side || 'buy'),
                  price: String(t.price),
                  size: String(t.size),
                  time: String(t.time || Date.now()),
                  block_number: String(t.block_number || ''),
                  log_index: String(t.log_index || ''),
                  market_id: mId,
                  market_name: mk?.display_name || `MKT-${mId}`,
                };
              });
            if (mapped.length > 0) {
              setRecentTrades((prev) => {
                const seen = new Set(prev.map((p) => p.id));
                const fresh = mapped.filter((m) => !seen.has(m.id));
                return [...fresh, ...prev].slice(0, 20);
              });
            }
          } catch {
            // ignore malformed ws message
          }
        };
        ws.onclose = () => {
          if (disposed) return;
          const delay = Math.min(30000, 1500 * Math.pow(2, attempt++));
          reconnectTimer = setTimeout(connect, delay);
        };
        ws.onerror = () => {
          ws?.close();
        };
      } catch {
        // ignore ws errors
      }
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        // ignore
      }
    };
  }, [markets.length]);

  const updateWatchlist = (next: string[]) => {
    setWatchlistIds(next);
    try {
      localStorage.setItem(WATCHLIST_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  const watchlistMarkets = useMemo(
    () =>
      watchlistIds
        .map((id) => markets.find((m) => String(m.market_id) === id))
        .filter((m): m is RisexMarket => Boolean(m)),
    [watchlistIds, markets]
  );

  const gainers = useMemo(
    () =>
      [...markets]
        .filter((m) => m.active)
        .sort(
          (a, b) =>
            calcMarketChangePct(b.mark_price || b.last_price, b.change_24h) -
            calcMarketChangePct(a.mark_price || a.last_price, a.change_24h)
        )
        .slice(0, 6),
    [markets]
  );

  const losers = useMemo(
    () =>
      [...markets]
        .filter((m) => m.active)
        .sort(
          (a, b) =>
            calcMarketChangePct(a.mark_price || a.last_price, a.change_24h) -
            calcMarketChangePct(b.mark_price || b.last_price, b.change_24h)
        )
        .slice(0, 6),
    [markets]
  );

  const highestVol = useMemo(
    () =>
      [...markets]
        .filter((m) => m.active)
        .sort((a, b) => Number(b.quote_volume_24h || 0) - Number(a.quote_volume_24h || 0))
        .slice(0, 6),
    [markets]
  );

  const handleWalletJump = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = walletInput.trim();
    if (trimmed) onSelectWallet(trimmed);
  };

  return (
    <div className="space-y-6">
      {/* Hero Banner */}
      <section className="sunrise-card relative overflow-hidden rounded-2xl p-6 sm:p-8">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-center">
          <div className="lg:col-span-7 space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#03DE82]/30 bg-[#03DE82]/10 px-3 py-1 text-[11px] font-mono text-[#03DE82]">
              <RisexSymbol className="h-3.5 w-3.5 text-[#03DE82]" />
              RISEx Mainnet Perpetuals & On-Chain Explorer
            </div>
            <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-[#e8edfb]">
              Every RISE pair. Every trader. <span className="sunrise-gradient-text">Live.</span>
            </h1>
            <p className="max-w-2xl text-sm text-slate-300 leading-relaxed">
              Track RISEx usernames, aggregated Realized PnL, open positions sorted by liquidation distance, and real-time RISE Chain blocks without a trading terminal.
            </p>
            <div className="flex flex-wrap items-center gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => onNavigateTab('leaderboard')}
                className="sunrise-gradient-btn inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold transition-all"
              >
                <Trophy className="h-3.5 w-3.5" />
                Trader Leaderboard
              </button>
              <button
                type="button"
                onClick={() => onNavigateTab('markets')}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700/60 bg-[#0e1526] px-4 py-2 text-xs font-medium text-[#e8edfb] hover:border-[#ffb02e]/50 transition-colors"
              >
                Browse {overview?.totalMarketsCount || markets.length || 54} Markets
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onNavigateTab('explorer')}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700/60 bg-[#0e1526] px-4 py-2 text-xs font-medium text-slate-300 hover:border-[#46a6ff]/50 hover:text-[#e8edfb] transition-colors"
              >
                <Blocks className="h-3.5 w-3.5" />
                Block & Risk Explorer
              </button>
            </div>
          </div>

          <div className="lg:col-span-5">
            <form onSubmit={handleWalletJump} className="rounded-xl border border-slate-700/50 bg-[#090e1a]/90 p-4 space-y-2.5">
              <div className="text-xs font-medium text-slate-300">
                Inspect Any RISEx Account or Wallet
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={walletInput}
                  onChange={(e) => setWalletInput(e.target.value)}
                  placeholder="Enter RISEx username (e.g. yeff) or 0x wallet…"
                  className="w-full rounded-xl border border-slate-700/60 bg-[#05070d] py-2.5 pl-9 pr-20 text-xs font-mono text-[#e8edfb] placeholder:text-slate-500 focus:border-[#ffb02e] focus:outline-none"
                />
                <button
                  type="submit"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg bg-[#ffb02e] px-3 py-1 text-xs font-semibold text-[#1f0e03] hover:brightness-110"
                >
                  Inspect
                </button>
              </div>
              {topTraders.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500">Top:</span>
                  {topTraders.slice(0, 4).map((t) => (
                    <button
                      key={t.address}
                      type="button"
                      onClick={() => onSelectWallet(t.address)}
                      className="rounded-md border border-slate-800 bg-[#0e1526] px-2 py-0.5 text-[11px] font-mono text-slate-300 hover:border-[#ffb02e]/50 hover:text-[#ffb02e]"
                    >
                      {t.username || shortAddress(t.address, 5, 4)}
                    </button>
                  ))}
                </div>
              )}
            </form>
          </div>
        </div>
      </section>

      {/* 6-Stat KPI Strip */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="sunrise-card rounded-xl p-3.5">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">24h Volume</div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-[#e8edfb]">
            {overview ? formatUsd(overview.totalVolume24h, true) : '—'}
          </div>
        </div>
        <div className="sunrise-card rounded-xl p-3.5">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Open Interest</div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-[#ffb02e]">
            {overview ? formatUsd(overview.totalOpenInterestUsd, true) : '—'}
          </div>
        </div>
        <div className="sunrise-card rounded-xl p-3.5">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">RISE Block</div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-[#46a6ff]">
            {overview?.blockNumber ? `#${overview.blockNumber.toLocaleString()}` : '—'}
          </div>
        </div>
        <div className="sunrise-card rounded-xl p-3.5">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Discovered Traders</div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-[#22e0a1]">
            {overview ? overview.totalDiscoveredCount.toLocaleString() : '—'}
          </div>
        </div>
        <div className="sunrise-card rounded-xl p-3.5">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Active Markets</div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-[#e8edfb]">
            {overview ? `${overview.activeMarketsCount}/${overview.totalMarketsCount}` : '—'}
          </div>
        </div>
        <div className="sunrise-card rounded-xl p-3.5">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Indexed Equity</div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-[#e8edfb]">
            {overview ? formatUsd(overview.totalEquityTracked, true) : '—'}
          </div>
        </div>
      </section>

      {/* Persistent Watchlist Strip */}
      <section className="space-y-2.5">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-slate-300">
            Market Watchlist
          </h2>
          <div ref={watchMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setAddWatchOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-700/60 bg-[#0e1526] px-2.5 py-1 text-xs text-slate-300 hover:border-[#ffb02e]/50 hover:text-[#ffb02e]"
            >
              <Plus className="h-3.5 w-3.5" />
              Customize
            </button>
            {addWatchOpen && (
              <div className="absolute right-0 top-full z-20 mt-1.5 max-h-64 w-64 overflow-y-auto rounded-xl border border-slate-700 bg-[#090e1a] p-2 shadow-2xl">
                {markets.map((m) => {
                  const id = String(m.market_id);
                  const checked = watchlistIds.includes(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        if (checked) {
                          updateWatchlist(watchlistIds.filter((x) => x !== id));
                        } else {
                          updateWatchlist([...watchlistIds, id].slice(0, 8));
                        }
                      }}
                      className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs hover:bg-[#131c31]"
                    >
                      <span className="font-medium text-[#e8edfb]">{m.display_name}</span>
                      <span className={checked ? 'text-[#22e0a1] font-mono' : 'text-slate-500 font-mono'}>
                        {checked ? 'PINNED' : '+ ADD'}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {watchlistMarkets.map((m) => {
            const mark = Number(m.mark_price || m.last_price || 0);
            const chg = calcMarketChangePct(mark, m.change_24h);
            const oiUsd = Number(m.open_interest || 0) * mark;
            return (
              <div
                key={m.market_id}
                onClick={() => onSelectMarket(String(m.market_id))}
                className="sunrise-card group cursor-pointer rounded-xl p-4 hover:border-[#ffb02e]/45 transition-all"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2.5">
                    <TokenBadge symbol={m.base_asset_symbol} size={28} />
                    <div>
                      <div className="font-display text-sm font-bold text-[#e8edfb] group-hover:text-[#ffb02e] transition-colors">
                        {m.display_name}
                      </div>
                      <div className="text-[10px] font-mono text-slate-400">
                        OI {formatUsd(oiUsd, true)} · {m.config?.max_leverage}x
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateWatchlist(watchlistIds.filter((x) => x !== String(m.market_id)));
                    }}
                    className="rounded p-0.5 text-slate-500 opacity-0 group-hover:opacity-100 hover:bg-slate-800 hover:text-slate-200"
                    title="Remove from watchlist"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-3 flex items-end justify-between">
                  <div>
                    <div className="font-mono text-base font-bold tabular-nums text-[#e8edfb]">
                      {formatPrice(mark)}
                    </div>
                    <div className={`font-mono text-xs font-semibold tabular-nums ${chg >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}`}>
                      {formatPct(chg)}
                    </div>
                  </div>
                  <MiniSparkline seed={m.display_name} changePct={chg} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Split: Live Fills + Top PnL Traders */}
      <section className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Live Fills */}
        <div className="sunrise-card rounded-2xl p-4 lg:col-span-6">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-[#22e0a1]" />
              <h2 className="font-display text-base font-bold text-[#e8edfb]">Live Market Fills</h2>
            </div>
            <button
              type="button"
              onClick={() => onNavigateTab('explorer')}
              className="text-xs text-[#ffb02e] hover:underline"
            >
              Explorer Feed →
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="py-2 pr-2">Market</th>
                  <th className="py-2 px-2">Side</th>
                  <th className="py-2 px-2 text-right">Price</th>
                  <th className="py-2 px-2 text-right">Value</th>
                  <th className="py-2 pl-2 text-right">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
                {recentTrades.slice(0, 10).map((tr, i) => {
                  const isBuy = tr.maker_side?.toLowerCase().includes('buy') || tr.maker_side === '0';
                  const usd = Number(tr.price) * Number(tr.size);
                  return (
                    <tr
                      key={`${tr.id}-${i}`}
                      onClick={() => tr.market_id && onSelectMarket(String(tr.market_id))}
                      className="cursor-pointer hover:bg-[#131c31]/60 transition-colors"
                    >
                      <td className="py-2 pr-2 font-sans font-medium text-[#e8edfb]">
                        {tr.market_name || `MKT-${tr.market_id}`}
                      </td>
                      <td className="py-2 px-2">
                        <span className={isBuy ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}>
                          {isBuy ? 'BUY' : 'SELL'}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-right text-slate-200">{formatPrice(tr.price)}</td>
                      <td className="py-2 px-2 text-right text-slate-300">{formatUsd(usd, true)}</td>
                      <td className="py-2 pl-2 text-right text-slate-500">{formatTimeShort(tr.time)}</td>
                    </tr>
                  );
                })}
                {recentTrades.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-8 text-center font-sans text-slate-500">
                      Streaming live fills from RISEx…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Top PnL Traders */}
        <div className="sunrise-card rounded-2xl p-4 lg:col-span-6">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-[#ffb02e]" />
              <h2 className="font-display text-base font-bold text-[#e8edfb]">Top Traders by PnL</h2>
            </div>
            <button
              type="button"
              onClick={() => onNavigateTab('leaderboard')}
              className="text-xs text-[#ffb02e] hover:underline"
            >
              Full Leaderboard →
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="py-2 pr-2">#</th>
                  <th className="py-2 px-2">Trader</th>
                  <th className="py-2 px-2 text-right">Acct Value</th>
                  <th className="py-2 px-2 text-right">Total PnL</th>
                  <th className="py-2 pl-2 text-right">Peek</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 tabular-nums">
                {topTraders.slice(0, 10).map((t, idx) => (
                  <tr
                    key={t.address}
                    onClick={() => onSelectWallet(t.address)}
                    className="cursor-pointer hover:bg-[#131c31]/60 transition-colors"
                  >
                    <td className="py-2 pr-2 font-mono text-slate-400">{idx + 1}</td>
                    <td className="py-2 px-2">
                      <div className="flex items-center gap-2">
                        <TraderAvatar
                          address={t.address}
                          avatarUrl={t.avatarUrl}
                          username={t.username}
                          size={24}
                        />
                        <div className="min-w-0">
                          <div className="truncate font-medium text-[#e8edfb] max-w-[150px]">
                            {t.username || shortAddress(t.address)}
                          </div>
                          <div className="font-mono text-[10px] text-slate-500">
                            {shortAddress(t.address, 6, 4)}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="py-2 px-2 text-right font-mono text-slate-200">
                      {t.accountValue > 0 ? formatUsd(t.accountValue, true) : '—'}
                    </td>
                    <td
                      className={`py-2 px-2 text-right font-mono font-semibold ${
                        t.totalPnlAll >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                      }`}
                    >
                      {formatSignedUsd(t.totalPnlAll, true)}
                    </td>
                    <td className="py-2 pl-2 text-right">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onPeekTrader(t.address, t);
                        }}
                        title="Quick peek trader"
                        className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-[#ffb02e]"
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
      </section>

      {/* 3-Column Market Movers */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {[
          {
            title: '24h Top Gainers',
            icon: <TrendingUp className="h-4 w-4 text-[#22e0a1]" />,
            list: gainers,
            mode: 'chg',
          },
          {
            title: '24h Top Losers',
            icon: <TrendingDown className="h-4 w-4 text-[#ff4d6d]" />,
            list: losers,
            mode: 'chg',
          },
          {
            title: 'Highest 24h Volume',
            icon: <Zap className="h-4 w-4 text-[#ffb02e]" />,
            list: highestVol,
            mode: 'vol',
          },
        ].map((col) => (
          <div key={col.title} className="sunrise-card rounded-2xl p-4">
            <div className="mb-3 flex items-center gap-2">
              {col.icon}
              <h3 className="font-display text-sm font-bold text-[#e8edfb]">{col.title}</h3>
            </div>
            <div className="space-y-1.5">
              {col.list.map((m) => {
                const chg = calcMarketChangePct(m.mark_price || m.last_price, m.change_24h);
                return (
                  <button
                    key={m.market_id}
                    type="button"
                    onClick={() => onSelectMarket(String(m.market_id))}
                    className="flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-xs hover:bg-[#131c31]/70 transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      <TokenBadge symbol={m.base_asset_symbol} size={22} />
                      <div className="text-left">
                        <div className="font-semibold text-[#e8edfb]">{m.display_name}</div>
                        <div className="font-mono text-[10px] text-slate-400">
                          {formatPrice(m.mark_price || m.last_price)}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <MiniSparkline seed={m.display_name} changePct={chg} width={52} height={20} />
                      <div className="text-right font-mono tabular-nums min-w-[66px]">
                        {col.mode === 'vol' ? (
                          <span className="text-[#ffb02e] font-semibold">
                            {formatUsd(m.quote_volume_24h, true)}
                          </span>
                        ) : (
                          <span className={chg >= 0 ? 'text-[#22e0a1] font-semibold' : 'text-[#ff4d6d] font-semibold'}>
                            {formatPct(chg)}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
};
