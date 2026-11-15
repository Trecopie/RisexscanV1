import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  BarChart3,
  Blocks,
  Eye,
  Flame,
  Layers,
  LayoutGrid,
  Plus,
  Search,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Trophy,
  Users,
  X,
  Zap,
} from 'lucide-react';
import type {
  DefiLlamaTvlPoint,
  IndexedTrader,
  MarketTrade,
  OverviewBundleResponse,
  RisexMarket,
} from '../types/risex';
import {
  calcMarketChangePct,
  formatPct,
  formatPrice,
  formatSignedUsd,
  formatTimeShort,
  formatUsd,
  shortAddress,
} from '../utils/format';
import {
  buildFundingHeatmap,
  buildMarketDashboard,
  buildMarketSectors,
  buildOpenInterestLeaders,
  buildVolumeHeatmap,
  cleanBaseSymbol,
  computeTakerFlow,
  type DashboardSectorFilter,
} from '../utils/overviewAnalytics';
import type { NavTab } from './Navbar';
import { MarketMoveMeter } from './Charts';
import { RisexSymbol } from './RisexSymbol';
import { TokenBadge, TraderAvatar } from './TraderAvatar';
import { useMarketStream } from '../context/MarketWebSocketContext';

const WATCHLIST_KEY = 'risexscan_watchlist_v1';
const OVERVIEW_CACHE_KEY = 'risexscan_overview_bundle_v2';

let memoryOverviewBundle: OverviewBundleResponse | null = null;

function readCachedOverview(): OverviewBundleResponse | null {
  if (memoryOverviewBundle) return memoryOverviewBundle;
  try {
    const raw = sessionStorage.getItem(OVERVIEW_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OverviewBundleResponse;
    if (parsed && Array.isArray(parsed.markets)) {
      memoryOverviewBundle = parsed;
      return parsed;
    }
  } catch {
    // ignore storage read error
  }
  return null;
}

const DefiLlamaTvlChart: React.FC<{
  points: DefiLlamaTvlPoint[];
  currentTvl: number;
  chainTvl: number;
  changePct: number;
  sharePct: number;
}> = ({ points, currentTvl, chainTvl, changePct, sharePct }) => {
  const [windowDays, setWindowDays] = useState<'14D' | '30D' | '90D' | 'ALL'>('30D');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const visiblePoints = useMemo(() => {
    if (!points || points.length === 0) return [];
    if (windowDays === '14D') return points.slice(-14);
    if (windowDays === '30D') return points.slice(-30);
    if (windowDays === '90D') return points.slice(-90);
    return points;
  }, [points, windowDays]);

  const width = 640;
  const height = 186;
  const padL = 8;
  const padR = 64;
  const padT = 14;
  const padB = 24;
  const cW = width - padL - padR;
  const cH = height - padT - padB;

  const minVal = visiblePoints.length > 0 ? Math.min(...visiblePoints.map((p) => p.tvl)) * 0.94 : 0;
  const maxVal = visiblePoints.length > 0 ? Math.max(...visiblePoints.map((p) => p.tvl)) * 1.03 : 1;
  const range = Math.max(1, maxVal - minVal);
  const denom = Math.max(1, visiblePoints.length - 1);

  const getX = (i: number) => padL + (i / denom) * cW;
  const getY = (v: number) => padT + ((maxVal - v) / range) * cH;

  const linePath = visiblePoints
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${getX(i).toFixed(1)} ${getY(p.tvl).toFixed(1)}`)
    .join(' ');
  const areaPath =
    visiblePoints.length > 1
      ? `${linePath} L ${getX(visiblePoints.length - 1).toFixed(1)} ${(padT + cH).toFixed(1)} L ${getX(0).toFixed(1)} ${(padT + cH).toFixed(1)} Z`
      : '';

  const activePoint =
    hoverIdx !== null && visiblePoints[hoverIdx]
      ? visiblePoints[hoverIdx]
      : visiblePoints[visiblePoints.length - 1];

  const yTicks = [0, 0.5, 1].map((t) => maxVal - t * range);

  return (
    <div className="sunrise-card rounded-2xl p-4 sm:p-5 flex flex-col justify-between h-full">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-[#03DE82]">
            <ShieldCheck className="h-3.5 w-3.5" />
            DefiLlama Verified TVL · RISE Chain
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-2.5">
            <span className="font-mono text-2xl font-bold tabular-nums text-[#e8edfb]">
              {activePoint ? formatUsd(activePoint.tvl, true) : formatUsd(currentTvl, true)}
            </span>
            <span
              className={`font-mono text-xs font-semibold tabular-nums ${
                changePct >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
              }`}
            >
              {formatPct(changePct)} 24h
            </span>
            {chainTvl > 0 && (
              <span className="font-mono text-[11px] text-slate-400">
                {sharePct.toFixed(1)}% of RISE Chain ({formatUsd(chainTvl, true)})
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#080d18] p-0.5">
          {(['14D', '30D', '90D', 'ALL'] as const).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWindowDays(w)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-mono font-semibold transition-colors ${
                windowDays === w
                  ? 'bg-[#03DE82] text-[#041a11]'
                  : 'text-slate-400 hover:text-[#e8edfb]'
              }`}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3">
        {visiblePoints.length > 1 ? (
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="w-full h-auto block select-none"
            onMouseLeave={() => setHoverIdx(null)}
          >
            <defs>
              <linearGradient id="tvlAreaGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#03DE82" stopOpacity="0.34" />
                <stop offset="100%" stopColor="#03DE82" stopOpacity="0.01" />
              </linearGradient>
            </defs>

            {yTicks.map((tick, idx) => {
              const y = getY(tick);
              return (
                <g key={idx}>
                  <line
                    x1={padL}
                    x2={width - padR}
                    y1={y}
                    y2={y}
                    stroke="rgba(148,163,205,0.12)"
                    strokeDasharray="3 3"
                    strokeWidth={1}
                  />
                  <text
                    x={width - padR + 8}
                    y={y + 3.5}
                    fill="#7c8bb0"
                    fontSize="10"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {formatUsd(tick, true)}
                  </text>
                </g>
              );
            })}

            <path d={areaPath} fill="url(#tvlAreaGrad)" />
            <path d={linePath} fill="none" stroke="#03DE82" strokeWidth={2.2} strokeLinejoin="round" />

            {hoverIdx !== null && visiblePoints[hoverIdx] && (
              <g pointerEvents="none">
                <line
                  x1={getX(hoverIdx)}
                  x2={getX(hoverIdx)}
                  y1={padT}
                  y2={padT + cH}
                  stroke="#ffb02e"
                  strokeOpacity={0.6}
                  strokeDasharray="3 3"
                />
                <circle
                  cx={getX(hoverIdx)}
                  cy={getY(visiblePoints[hoverIdx].tvl)}
                  r={4}
                  fill="#03DE82"
                  stroke="#060911"
                  strokeWidth={2}
                />
              </g>
            )}

            {visiblePoints.map((p, i) => {
              const sliceW = cW / visiblePoints.length;
              return (
                <rect
                  key={p.date}
                  x={getX(i) - sliceW / 2}
                  y={padT}
                  width={Math.max(4, sliceW)}
                  height={cH}
                  fill="transparent"
                  onMouseEnter={() => setHoverIdx(i)}
                />
              );
            })}

            {[0, Math.floor(visiblePoints.length / 2), visiblePoints.length - 1].map((idx) => {
              const pt = visiblePoints[idx];
              if (!pt) return null;
              const d = new Date(pt.date);
              const label = `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()}`;
              return (
                <text
                  key={idx}
                  x={getX(idx)}
                  y={height - 6}
                  fill="#5d6987"
                  fontSize="10"
                  textAnchor={idx === 0 ? 'start' : idx === visiblePoints.length - 1 ? 'end' : 'middle'}
                  fontFamily="JetBrains Mono, monospace"
                >
                  {label}
                </text>
              );
            })}
          </svg>
        ) : (
          <div className="flex h-[160px] items-center justify-center rounded-xl border border-slate-800/70 bg-[#080d18] text-xs font-mono text-slate-500">
            Syncing DefiLlama TVL history…
          </div>
        )}
      </div>

      {activePoint && (
        <div className="mt-2 flex items-center justify-between border-t border-slate-800/70 pt-2 text-[11px] font-mono text-slate-400">
          <span>
            Date:{' '}
            <strong className="text-slate-200">
              {new Date(activePoint.date).toISOString().slice(0, 10)}
            </strong>
          </span>
          <span>
            Protocol Deposit TVL: <strong className="text-[#03DE82]">{formatUsd(activePoint.tvl)}</strong>
          </span>
        </div>
      )}
    </div>
  );
};

export const OverviewPage: React.FC<{
  onSelectWallet: (address: string) => void;
  onSelectMarket: (marketId: string) => void;
  onNavigateTab: (tab: NavTab) => void;
  onPeekTrader: (address: string, trader?: IndexedTrader) => void;
}> = ({ onSelectWallet, onSelectMarket, onNavigateTab, onPeekTrader }) => {
  const [bundle, setBundle] = useState<OverviewBundleResponse | null>(() => readCachedOverview());
  const [liveTrades, setLiveTrades] = useState<MarketTrade[]>(() => readCachedOverview()?.recentTrades || []);
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
  const [dashFilter, setDashFilter] = useState<DashboardSectorFilter>('all');

  const { markets: wsMarkets, recentTrades: wsTrades, connectionState } = useMarketStream();
  const loadControllerRef = React.useRef<AbortController | null>(null);
  const markets = useMemo(() => {
    if (wsMarkets.length > 0) return wsMarkets;
    return bundle?.markets || [];
  }, [wsMarkets, bundle?.markets]);

  const loadOverviewBundle = async () => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    try {
      const r = await fetch('/api/overview', { signal: controller.signal });
      if (!r.ok || controller.signal.aborted) return;
      const data = (await r.json()) as OverviewBundleResponse;
      if (!data || (data as any).error || controller.signal.aborted) return;

      memoryOverviewBundle = data;
      setBundle(data);
      try {
        sessionStorage.setItem(OVERVIEW_CACHE_KEY, JSON.stringify(data));
      } catch {
        // ignore quota limits
      }

      if (Array.isArray(data.markets) && data.markets.length > 0) {
        setWatchlistIds((prev) => {
          if (prev.length > 0) return prev;
          const defaults = ['BTC', 'ETH', 'SOL', 'XAU']
            .map((sym) => data.markets.find((m) => cleanBaseSymbol(m.base_asset_symbol) === sym))
            .filter((m): m is RisexMarket => Boolean(m))
            .map((m) => String(m.market_id));
          return defaults.length > 0
            ? defaults
            : data.markets.slice(0, 4).map((m) => String(m.market_id));
        });
      }

      if (Array.isArray(data.recentTrades) && data.recentTrades.length > 0) {
        setLiveTrades((prev) => {
          if (prev.length === 0) return data.recentTrades;
          const seen = new Set(data.recentTrades.map((t) => t.id));
          const extra = prev.filter((t) => !seen.has(t.id));
          return [...extra, ...data.recentTrades].slice(0, 30);
        });
      }
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
    loadOverviewBundle();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadOverviewBundle();
      }
    }, 30000);
    return () => {
      loadControllerRef.current?.abort();
      clearInterval(timer);
    };
  }, []);

  // Merge live WebSocket trades pushed by MarketWebSocketProvider
  useEffect(() => {
    if (wsTrades.length === 0) return;
    setLiveTrades((prev) => {
      const seen = new Set(prev.map((p) => p.id));
      const fresh = wsTrades.filter((t) => !seen.has(t.id));
      if (fresh.length === 0) return prev;
      return [...fresh, ...prev].slice(0, 30);
    });
  }, [wsTrades]);

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

  const sectorData = useMemo(() => buildMarketSectors(markets), [markets]);
  const oiLeaders = useMemo(() => buildOpenInterestLeaders(markets, 10), [markets]);
  const fundingHeatmap = useMemo(() => buildFundingHeatmap(markets, 20), [markets]);
  const volumeHeatmap = useMemo(() => buildVolumeHeatmap(markets, 16), [markets]);
  const takerFlow = useMemo(() => computeTakerFlow(liveTrades), [liveTrades]);

  const dashboardData = useMemo(
    () => buildMarketDashboard(markets, dashFilter, 6),
    [markets, dashFilter]
  );

  const topTraders = bundle?.topTraders || [];
  const prof = bundle?.profitability;
  const tvl = bundle?.defiLlama;

  const marketMetaById = useMemo(() => {
    const map = new Map<string, RisexMarket>();
    for (const m of markets) map.set(String(m.market_id), m);
    return map;
  }, [markets]);

  const handleWalletJump = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = walletInput.trim();
    if (trimmed) onSelectWallet(trimmed);
  };

  const perpVolShare =
    sectorData.totalVolume24h > 0 ? (sectorData.perpVolume24h / sectorData.totalVolume24h) * 100 : 100;
  const perpOiShare =
    sectorData.totalOpenInterestUsd > 0 ? (sectorData.perpOiUsd / sectorData.totalOpenInterestUsd) * 100 : 100;

  return (
    <div className="space-y-6">
      {/* Header Strip */}
      <section className="sunrise-card rounded-xl p-5 sm:p-6">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 lg:items-center">
          <div className="lg:col-span-7 space-y-2.5">
            <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-[#03DE82]">
              <RisexSymbol className="h-3.5 w-3.5 text-[#03DE82]" />
              RISEx Mainnet · RISE Chain 4153
            </div>
            <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-[#e8edfb]">
              Perpetuals, RWA &amp; On-Chain Orderflow Intelligence
            </h1>
            <p className="max-w-xl text-xs sm:text-sm text-slate-400">
              Real-time DefiLlama TVL, Crypto &amp; RWA market structure, funding heatmaps, cohort bias, and realized settlement feeds.
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => onNavigateTab('cohorts')}
                className="sunrise-gradient-btn inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors"
              >
                <Users className="h-3.5 w-3.5" />
                Cohort Tracker
              </button>
              <button
                type="button"
                onClick={() => onNavigateTab('leaderboard')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/70 bg-[#070b14] px-3.5 py-2 text-xs font-medium text-[#e8edfb] hover:border-[#ffb02e]/50 transition-colors"
              >
                <Trophy className="h-3.5 w-3.5 text-[#ffb02e]" />
                Leaderboard
              </button>
              <button
                type="button"
                onClick={() => onNavigateTab('markets')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/70 bg-[#070b14] px-3.5 py-2 text-xs font-medium text-slate-300 hover:border-[#ffb02e]/50 hover:text-[#e8edfb] transition-colors"
              >
                {bundle?.totalMarketsCount || markets.length || 54} Markets
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onNavigateTab('explorer')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/70 bg-[#070b14] px-3.5 py-2 text-xs font-medium text-slate-300 hover:border-[#46a6ff]/50 hover:text-[#e8edfb] transition-colors"
              >
                <Blocks className="h-3.5 w-3.5" />
                Block Explorer
              </button>
            </div>
          </div>

          <div className="lg:col-span-5">
            <form
              onSubmit={handleWalletJump}
              className="rounded-xl border border-slate-700/50 bg-[#090e1a]/90 p-4 space-y-2.5"
            >
              <div className="text-xs font-medium text-slate-300">
                Inspect Any RISEx Account or Wallet
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={walletInput}
                  onChange={(e) => setWalletInput(e.target.value)}
                  placeholder="Enter RISEx username (e.g. sqalf, yeff) or 0x wallet…"
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

      {/* 6-Stat Executive KPI Strip */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="sunrise-card rounded-xl p-3.5 border-t-2 border-t-[#03DE82]/60">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Protocol TVL</div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-[#03DE82]">
            {tvl?.protocolTvl ? formatUsd(tvl.protocolTvl, true) : '—'}
          </div>
          <div className="mt-0.5 text-[10px] font-mono text-slate-400">
            {tvl ? `${formatPct(tvl.tvl24hChangePct)} 24h` : 'DefiLlama'}
          </div>
        </div>
        <div className="sunrise-card rounded-xl p-3.5 border-t-2 border-t-[#e8edfb]/30">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">24h Volume</div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-[#e8edfb]">
            {bundle ? formatUsd(bundle.totalVolume24h, true) : '—'}
          </div>
          <div className="mt-0.5 text-[10px] font-mono text-slate-400">
            {perpVolShare.toFixed(0)}% Perp · {(100 - perpVolShare).toFixed(0)}% RWA
          </div>
        </div>
        <div className="sunrise-card rounded-xl p-3.5 border-t-2 border-t-[#ffb02e]/60">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Open Interest</div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-[#ffb02e]">
            {bundle ? formatUsd(bundle.totalOpenInterestUsd, true) : '—'}
          </div>
          <div className="mt-0.5 text-[10px] font-mono text-slate-400">
            {prof ? `${prof.longOiSharePct.toFixed(0)}% Long OI` : 'Live Contracts'}
          </div>
        </div>
        <div className="sunrise-card rounded-xl p-3.5 border-t-2 border-t-[#22e0a1]/50">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Indexed Accounts</div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-[#22e0a1]">
            {bundle ? bundle.totalDiscoveredCount.toLocaleString() : '—'}
          </div>
          <div className="mt-0.5 text-[10px] font-mono text-slate-400">
            {prof ? `${prof.profitabilityPct.toFixed(1)}% in Profit` : 'Discovered'}
          </div>
        </div>
        <div className="sunrise-card rounded-xl p-3.5 border-t-2 border-t-[#8b7bff]/50">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Active Markets</div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-[#e8edfb]">
            {bundle ? `${bundle.activeMarketsCount}/${bundle.totalMarketsCount}` : '—'}
          </div>
          <div className="mt-0.5 text-[10px] font-mono text-slate-400">
            {sectorData.perpCount} Crypto · {sectorData.rwaCount} RWA
          </div>
        </div>
        <div className="sunrise-card rounded-xl p-3.5 border-t-2 border-t-[#46a6ff]/60">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">RISE Block</div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-[#46a6ff]">
            {bundle?.blockNumber ? `#${bundle.blockNumber.toLocaleString()}` : '—'}
          </div>
          <div className="mt-0.5 text-[10px] font-mono text-slate-400">
            Chain ID {bundle?.chainId || '4153'}
          </div>
        </div>
      </section>

      {/* Multi-Column Market Dashboard Widget */}
      <section className="sunrise-card rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <LayoutGrid className="h-4 w-4 text-[#ffb02e]" />
              <h2 className="font-display text-base sm:text-lg font-bold tracking-tight text-[#e8edfb]">
                Market Dashboard
              </h2>
            </div>
            <div className="font-mono text-[11px] tabular-nums text-slate-400">
              {dashboardData.marketCount} Active Markets · 24h Vol{' '}
              <span className="text-[#e8edfb] font-semibold">{formatUsd(dashboardData.totalVolume24h, true)}</span> · OI{' '}
              <span className="text-[#ffb02e] font-semibold">{formatUsd(dashboardData.totalOpenInterestUsd, true)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] tabular-nums">
              <span className="text-[#22e0a1]">{dashboardData.advancers} advancing</span>
              <span className="text-[#ff4d6d]">{dashboardData.decliners} declining</span>
              {dashboardData.unchanged > 0 && <span className="text-slate-400">{dashboardData.unchanged} unchanged</span>}
              <span className="text-slate-600">·</span>
              <span className={connectionState === 'connected' ? 'text-[#22e0a1]' : 'text-[#ffb02e]'}>
                {connectionState === 'connected' ? 'Oracle WS connected' : 'Oracle WS reconnecting'}
              </span>
              <span className="text-slate-500">· 24h volume/OI via REST snapshots</span>
            </div>
            <div
              className="flex h-1 max-w-[400px] overflow-hidden rounded-full bg-slate-800"
              role="img"
              aria-label={`Market breadth: ${dashboardData.advancers} advancing, ${dashboardData.decliners} declining, ${dashboardData.unchanged} unchanged`}
            >
              <div className="bg-[#22e0a1] transition-[width] duration-300" style={{ width: `${dashboardData.advancersPct}%` }} />
              <div className="bg-[#ff4d6d] transition-[width] duration-300" style={{ width: `${dashboardData.marketCount > 0 ? dashboardData.decliners / dashboardData.marketCount * 100 : 0}%` }} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="Filter Market Dashboard by asset universe"
              className="inline-flex items-center rounded-lg border border-slate-800 bg-[#070b14] p-0.5"
            >
              {(
                [
                  { id: 'all', label: 'All Markets' },
                  { id: 'crypto', label: 'Crypto Perps' },
                  { id: 'rwa', label: 'RWA' },
                ] as const
              ).map((tab) => {
                const active = dashFilter === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setDashFilter(tab.id)}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-mono font-semibold whitespace-nowrap shrink-0 transition-colors ${
                      active
                        ? 'bg-[#ffb02e] text-[#160a02]'
                        : 'text-slate-400 hover:text-[#e8edfb]'
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => onNavigateTab('markets')}
              className="rounded-lg border border-slate-800 bg-[#080d18] px-2.5 py-1.5 text-[11px] font-mono text-[#ffb02e] whitespace-nowrap shrink-0 hover:border-[#ffb02e]/50 transition-colors"
            >
              Screener →
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Column 1: 24h Volume */}
          <div className="rounded-xl border border-slate-800/80 bg-[#070b14] p-3.5 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-md border border-[#ffb02e]/30 bg-[#ffb02e]/12 text-[#ffb02e]">
                  <Zap className="h-3.5 w-3.5" />
                </span>
                <h3 className="font-display text-sm font-bold text-[#e8edfb]">24h Volume</h3>
              </div>
              <span className="font-mono text-[10px] uppercase tracking-wider text-[#ffb02e]">Liquidity</span>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {dashboardData.topVolume.map((entry, idx) => {
                const up = entry.changePct >= 0;
                return (
                  <button
                    key={entry.marketId}
                    type="button"
                    onClick={() => onSelectMarket(entry.marketId)}
                    className="group flex flex-col justify-between gap-2 rounded-lg border border-[#ffb02e]/20 bg-[#0b1120] p-2.5 text-left hover:border-[#ffb02e]/55 hover:bg-[#111a30] transition-colors min-w-0"
                  >
                    <div className="flex items-center justify-between gap-1.5 w-full min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <TokenBadge symbol={entry.symbol} category={entry.sector} size={20} />
                        <span className="font-display text-xs font-bold text-[#e8edfb] truncate group-hover:text-[#ffb02e] transition-colors">
                          {entry.symbol}
                        </span>
                        <span className="font-mono text-[9px] text-slate-500">#{idx + 1}</span>
                      </div>
                      <MarketMoveMeter changePct={entry.changePct} width={36} height={14} />
                    </div>

                    <div className="flex items-end justify-between gap-1.5 w-full">
                      <div className="min-w-0">
                        <div className="font-mono text-[11px] font-semibold tabular-nums text-[#e8edfb] truncate">
                          {formatPrice(entry.markPrice)}
                        </div>
                        <div className="font-mono text-[9px] tabular-nums text-slate-400 truncate">
                          OI {formatUsd(entry.openInterestUsd, true)}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="rounded border border-[#ffb02e]/30 bg-[#ffb02e]/14 px-1.5 py-0.5 font-mono text-[11px] font-bold tabular-nums text-[#ffb02e]">
                          {formatUsd(entry.volume24h, true)}
                        </div>
                        <div
                          className={`mt-0.5 font-mono text-[9px] font-semibold tabular-nums ${
                            up ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                          }`}
                        >
                          {up ? '▲' : '▼'} {formatPct(entry.changePct)}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Column 2: Top Gainers */}
          <div className="rounded-xl border border-slate-800/80 bg-[#070b14] p-3.5 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-md border border-[#22e0a1]/30 bg-[#22e0a1]/12 text-[#22e0a1]">
                  <TrendingUp className="h-3.5 w-3.5" />
                </span>
                <h3 className="font-display text-sm font-bold text-[#e8edfb]">Top Gainers</h3>
              </div>
              <span className="font-mono text-[10px] uppercase tracking-wider text-[#22e0a1]">24h Leaders</span>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {dashboardData.gainers.length === 0 && (
                <div className="px-3 py-5 text-center text-xs text-slate-500">No markets advancing in this group.</div>
              )}
              {dashboardData.gainers.map((entry, idx) => {
                const up = entry.changePct >= 0;
                return (
                  <button
                    key={entry.marketId}
                    type="button"
                    onClick={() => onSelectMarket(entry.marketId)}
                    className={`group flex flex-col justify-between gap-2 rounded-lg border p-2.5 text-left transition-colors min-w-0 ${
                      up
                        ? 'border-[#22e0a1]/22 bg-[#0a141d] hover:border-[#22e0a1]/55 hover:bg-[#0e1f29]'
                        : 'border-slate-800/90 bg-[#0b1120] hover:border-slate-600 hover:bg-[#11192e]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1.5 w-full min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <TokenBadge symbol={entry.symbol} category={entry.sector} size={20} />
                        <span className="font-display text-xs font-bold text-[#e8edfb] truncate group-hover:text-[#22e0a1] transition-colors">
                          {entry.symbol}
                        </span>
                        <span className="font-mono text-[9px] text-slate-500">#{idx + 1}</span>
                      </div>
                      <MarketMoveMeter changePct={entry.changePct} width={36} height={14} />
                    </div>

                    <div className="flex items-end justify-between gap-1.5 w-full">
                      <div className="min-w-0">
                        <div className="font-mono text-[11px] font-semibold tabular-nums text-[#e8edfb] truncate">
                          {formatPrice(entry.markPrice)}
                        </div>
                        <div className="font-mono text-[9px] tabular-nums text-slate-400 truncate">
                          Vol {formatUsd(entry.volume24h, true)}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div
                          className={`inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 font-mono text-[11px] font-bold tabular-nums ${
                            up
                              ? 'border-[#22e0a1]/35 bg-[#22e0a1]/16 text-[#22e0a1]'
                              : 'border-[#ff4d6d]/35 bg-[#ff4d6d]/16 text-[#ff4d6d]'
                          }`}
                        >
                          <span aria-hidden="true" className="text-[8px]">
                            {up ? '▲' : '▼'}
                          </span>
                          {formatPct(entry.changePct)}
                        </div>
                        <div className="mt-0.5 font-mono text-[9px] tabular-nums text-slate-400">
                          {entry.maxLeverage}x · {entry.group}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Column 3: Top Losers */}
          <div className="rounded-xl border border-slate-800/80 bg-[#070b14] p-3.5 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-md border border-[#ff4d6d]/30 bg-[#ff4d6d]/12 text-[#ff4d6d]">
                  <TrendingDown className="h-3.5 w-3.5" />
                </span>
                <h3 className="font-display text-sm font-bold text-[#e8edfb]">Top Losers</h3>
              </div>
              <span className="font-mono text-[10px] uppercase tracking-wider text-[#ff4d6d]">24h Laggards</span>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {dashboardData.losers.length === 0 && (
                <div className="px-3 py-5 text-center text-xs text-slate-500">No markets declining in this group.</div>
              )}
              {dashboardData.losers.map((entry, idx) => {
                const up = entry.changePct >= 0;
                return (
                  <button
                    key={entry.marketId}
                    type="button"
                    onClick={() => onSelectMarket(entry.marketId)}
                    className={`group flex flex-col justify-between gap-2 rounded-lg border p-2.5 text-left transition-colors min-w-0 ${
                      !up
                        ? 'border-[#ff4d6d]/22 bg-[#140c16] hover:border-[#ff4d6d]/55 hover:bg-[#1e1020]'
                        : 'border-slate-800/90 bg-[#0b1120] hover:border-slate-600 hover:bg-[#11192e]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1.5 w-full min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <TokenBadge symbol={entry.symbol} category={entry.sector} size={20} />
                        <span className="font-display text-xs font-bold text-[#e8edfb] truncate group-hover:text-[#ff4d6d] transition-colors">
                          {entry.symbol}
                        </span>
                        <span className="font-mono text-[9px] text-slate-500">#{idx + 1}</span>
                      </div>
                      <MarketMoveMeter changePct={entry.changePct} width={36} height={14} />
                    </div>

                    <div className="flex items-end justify-between gap-1.5 w-full">
                      <div className="min-w-0">
                        <div className="font-mono text-[11px] font-semibold tabular-nums text-[#e8edfb] truncate">
                          {formatPrice(entry.markPrice)}
                        </div>
                        <div className="font-mono text-[9px] tabular-nums text-slate-400 truncate">
                          Vol {formatUsd(entry.volume24h, true)}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div
                          className={`inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 font-mono text-[11px] font-bold tabular-nums ${
                            up
                              ? 'border-[#22e0a1]/35 bg-[#22e0a1]/16 text-[#22e0a1]'
                              : 'border-[#ff4d6d]/35 bg-[#ff4d6d]/16 text-[#ff4d6d]'
                          }`}
                        >
                          <span aria-hidden="true" className="text-[8px]">
                            {up ? '▲' : '▼'}
                          </span>
                          {formatPct(entry.changePct)}
                        </div>
                        <div className="mt-0.5 font-mono text-[9px] tabular-nums text-slate-400">
                          {entry.maxLeverage}x · {entry.group}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* Analytical Visualization Row 1: DefiLlama TVL Chart + Perps vs RWA Sector Breakdown */}
      <section className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <DefiLlamaTvlChart
            points={tvl?.tvlHistory || []}
            currentTvl={tvl?.protocolTvl || 0}
            chainTvl={tvl?.chainTvl || 0}
            changePct={tvl?.tvl24hChangePct || 0}
            sharePct={tvl?.risexShareOfChainPct || 0}
          />
        </div>

        {/* Perps vs RWA & Sector Composition */}
        <div className="sunrise-card rounded-2xl p-4 sm:p-5 lg:col-span-5 flex flex-col justify-between space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-[#ffb02e]" />
              <h2 className="font-display text-base font-bold text-[#e8edfb]">
                Perps vs RWA Breakdown
              </h2>
            </div>
            <button
              type="button"
              onClick={() => onNavigateTab('markets')}
              className="text-xs font-mono text-[#ffb02e] hover:underline"
            >
              All Sectors →
            </button>
          </div>

          {/* Stacked Proportion Bars */}
          <div className="space-y-3 rounded-xl border border-slate-800/80 bg-[#080d18] p-3">
            <div>
              <div className="mb-1 flex justify-between text-[11px] font-mono">
                <span className="text-[#22e0a1]">Crypto Perps {perpVolShare.toFixed(1)}% Vol</span>
                <span className="text-[#46a6ff]">RWA {(100 - perpVolShare).toFixed(1)}% Vol</span>
              </div>
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-800">
                <div className="bg-[#22e0a1]" style={{ width: `${perpVolShare}%` }} />
                <div className="bg-[#46a6ff]" style={{ width: `${100 - perpVolShare}%` }} />
              </div>
            </div>
            <div>
              <div className="mb-1 flex justify-between text-[11px] font-mono">
                <span className="text-[#ffb02e]">Crypto Perps {perpOiShare.toFixed(1)}% OI</span>
                <span className="text-[#8b7bff]">RWA {(100 - perpOiShare).toFixed(1)}% OI</span>
              </div>
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-800">
                <div className="bg-[#ffb02e]" style={{ width: `${perpOiShare}%` }} />
                <div className="bg-[#8b7bff]" style={{ width: `${100 - perpOiShare}%` }} />
              </div>
            </div>
          </div>

          {/* 4 Sector Cards */}
          <div className="grid grid-cols-2 gap-2.5">
            {sectorData.sectors.map((sec) => {
              const accent =
                sec.id === 'crypto'
                  ? 'border-[#22e0a1]/30'
                  : sec.id === 'stocks'
                    ? 'border-[#46a6ff]/30'
                    : sec.id === 'commodity'
                      ? 'border-[#facc15]/30'
                      : 'border-[#8b7bff]/30';
              return (
                <button
                  key={sec.id}
                  type="button"
                  onClick={() =>
                    sec.topMarketId ? onSelectMarket(sec.topMarketId) : onNavigateTab('markets')
                  }
                  className={`rounded-xl border ${accent} bg-[#090e1a] p-3 text-left hover:bg-[#11192e] transition-colors`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-display text-xs font-bold text-[#e8edfb]">{sec.label}</span>
                    <span className="font-mono text-[10px] text-slate-400">{sec.count} mkts</span>
                  </div>
                  <div className="mt-2 font-mono text-sm font-bold tabular-nums text-[#ffb02e]">
                    {formatUsd(sec.volume24h, true)}
                    <span className="ml-1.5 text-[10px] font-normal text-slate-400">
                      ({sec.volumeSharePct.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[10px] font-mono text-slate-400">
                    <span>OI {formatUsd(sec.openInterestUsd, true)}</span>
                    <span className={sec.avgFundingAprPct >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}>
                      {sec.avgFundingAprPct >= 0 ? '+' : ''}
                      {sec.avgFundingAprPct.toFixed(1)}% APR
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Analytical Row 2: Exchange Profitability + Long/Short OI + Live Taker Flow */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {/* Trader Profitability */}
        <div className="sunrise-card rounded-2xl p-4 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-display font-bold text-[#e8edfb]">Indexed Trader Profitability</span>
            <span className="font-mono text-xs font-bold text-[#22e0a1]">
              {prof ? `${prof.profitabilityPct.toFixed(1)}% Win` : '—'}
            </span>
          </div>
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className="bg-[#22e0a1]"
              style={{ width: `${prof?.profitabilityPct ?? 50}%` }}
            />
            <div
              className="bg-[#ff4d6d]"
              style={{ width: `${100 - (prof?.profitabilityPct ?? 50)}%` }}
            />
          </div>
          <div className="flex items-center justify-between font-mono text-[11px] tabular-nums text-slate-400">
            <span className="text-[#22e0a1]">{prof?.inProfitCount.toLocaleString() || '0'} In Profit</span>
            <span className="text-slate-300">Eq {formatUsd(prof?.totalEquityUsd, true)}</span>
            <span className="text-[#ff4d6d]">{prof?.atLossCount.toLocaleString() || '0'} At Loss</span>
          </div>
        </div>

        {/* Long vs Short OI Bias */}
        <div className="sunrise-card rounded-2xl p-4 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-display font-bold text-[#e8edfb]">Indexed Open Interest Bias</span>
            <span className="font-mono text-xs font-bold text-[#ffb02e]">
              {prof ? `${prof.longOiSharePct.toFixed(1)}% Long` : '—'}
            </span>
          </div>
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className="bg-[#22e0a1]"
              style={{ width: `${prof?.longOiSharePct ?? 50}%` }}
            />
            <div
              className="bg-[#ff4d6d]"
              style={{ width: `${100 - (prof?.longOiSharePct ?? 50)}%` }}
            />
          </div>
          <div className="flex items-center justify-between font-mono text-[11px] tabular-nums text-slate-400">
            <span className="text-[#22e0a1]">
              {formatUsd(prof?.longOiUsd, true)} ({prof?.longPositionsCount || 0}L)
            </span>
            <span className="text-[#ff4d6d]">
              {formatUsd(prof?.shortOiUsd, true)} ({prof?.shortPositionsCount || 0}S)
            </span>
          </div>
        </div>

        {/* Live Taker Orderflow Ratio */}
        <div className="sunrise-card rounded-2xl p-4 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-display font-bold text-[#e8edfb]">Live Taker Flow (Tape)</span>
            <span className="font-mono text-xs font-bold text-[#46a6ff]">
              {takerFlow.buySharePct.toFixed(1)}% Buy
            </span>
          </div>
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div className="bg-[#22e0a1]" style={{ width: `${takerFlow.buySharePct}%` }} />
            <div className="bg-[#ff4d6d]" style={{ width: `${takerFlow.sellSharePct}%` }} />
          </div>
          <div className="flex items-center justify-between font-mono text-[11px] tabular-nums text-slate-400">
            <span className="text-[#22e0a1]">
              {formatUsd(takerFlow.buyUsd, true)} ({takerFlow.buyCount})
            </span>
            <span className="text-[#ff4d6d]">
              {formatUsd(takerFlow.sellUsd, true)} ({takerFlow.sellCount})
            </span>
          </div>
        </div>
      </section>

      {/* Analytical Row 3: Open Interest Leaders (Top 10 Tiles) & Funding APR Heatmap */}
      <section className="grid grid-cols-1 gap-5 lg:grid-cols-12 items-start">
        {/* OI Leaders */}
        <div className="sunrise-card rounded-2xl p-4 sm:p-5 lg:col-span-6 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-[#ffb02e]" />
              <h2 className="font-display text-base font-bold text-[#e8edfb]">
                Open Interest Leaders
              </h2>
            </div>
            <span className="font-mono text-[11px] text-slate-400">
              Total {formatUsd(bundle?.totalOpenInterestUsd, true)}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {oiLeaders.map((item, idx) => (
              <button
                key={item.marketId}
                type="button"
                onClick={() => onSelectMarket(item.marketId)}
                className="group rounded-xl border border-slate-800/80 bg-[#090e1a] p-2.5 text-left hover:border-[#ffb02e]/45 hover:bg-[#11192e] transition-all"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-[10px] text-slate-500 w-4">#{idx + 1}</span>
                    <TokenBadge symbol={item.symbol} category={item.category} size={22} />
                    <span className="font-display text-xs font-bold text-[#e8edfb] truncate group-hover:text-[#ffb02e]">
                      {item.symbol}
                    </span>
                  </div>
                  <div className="text-right font-mono tabular-nums">
                    <div className="text-xs font-bold text-[#e8edfb]">
                      {formatUsd(item.openInterestUsd, true)}
                    </div>
                    <div className="text-[10px] text-slate-400">{item.sharePct.toFixed(1)}%</div>
                  </div>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[#ffb02e] to-[#22e0a1]"
                    style={{ width: `${Math.max(4, item.relTopPct)}%` }}
                  />
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Funding APR Heatmap */}
        <div className="sunrise-card rounded-2xl p-4 sm:p-5 lg:col-span-6 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Flame className="h-4 w-4 text-[#ff6a3d]" />
              <h2 className="font-display text-base font-bold text-[#e8edfb]">
                Funding APR Heatmap
              </h2>
            </div>
            <div className="flex items-center gap-3 font-mono text-[10px]">
              <span className="text-[#22e0a1]">+ Shorts Earn</span>
              <span className="text-[#ff4d6d]">− Longs Earn</span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {fundingHeatmap.map((item) => {
              const isPos = item.aprPct >= 0;
              const intensity = Math.min(1, Math.abs(item.aprPct) / 65);
              return (
                <button
                  key={item.marketId}
                  type="button"
                  onClick={() => onSelectMarket(item.marketId)}
                  style={{
                    backgroundColor: isPos
                      ? `rgba(34, 224, 161, ${0.07 + intensity * 0.16})`
                      : `rgba(255, 77, 109, ${0.07 + intensity * 0.16})`,
                  }}
                  className={`rounded-xl border p-2.5 text-left transition-transform hover:scale-[1.02] ${
                    isPos ? 'border-[#22e0a1]/30' : 'border-[#ff4d6d]/30'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <TokenBadge symbol={item.symbol} category={item.category} size={18} />
                    <span className="font-display text-[11px] font-bold text-[#e8edfb] truncate">
                      {item.symbol}
                    </span>
                  </div>
                  <div
                    className={`mt-2 font-mono text-xs font-bold tabular-nums ${
                      isPos ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                    }`}
                  >
                    {item.aprPct >= 0 ? '+' : ''}
                    {item.aprPct.toFixed(1)}%
                  </div>
                  <div className="font-mono text-[9px] text-slate-400">
                    {item.rate1hPct >= 0 ? '+' : ''}
                    {item.rate1hPct.toFixed(4)}%/h
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Market Volume Heatmap Grid */}
      <section className="sunrise-card rounded-2xl p-4 sm:p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-[#46a6ff]" />
            <h2 className="font-display text-base font-bold text-[#e8edfb]">
              24h Market Volume Heatmap
            </h2>
          </div>
          <button
            type="button"
            onClick={() => onNavigateTab('markets')}
            className="text-xs font-mono text-[#ffb02e] hover:underline"
          >
            Full Screener →
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {volumeHeatmap.map((item, idx) => {
            const up = item.changePct >= 0;
            return (
              <button
                key={item.marketId}
                type="button"
                onClick={() => onSelectMarket(item.marketId)}
                className={`rounded-xl border p-2.5 text-left transition-all hover:border-[#ffb02e]/55 ${
                  up
                    ? 'border-[#22e0a1]/25 bg-gradient-to-b from-[#22e0a1]/[0.08] to-[#080d18]'
                    : 'border-[#ff4d6d]/25 bg-gradient-to-b from-[#ff4d6d]/[0.08] to-[#080d18]'
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <TokenBadge symbol={item.symbol} category={item.category} size={18} />
                  <span className="font-mono text-[10px] text-slate-500">#{idx + 1}</span>
                </div>
                <div className="mt-1.5 font-display text-xs font-bold text-[#e8edfb] truncate">
                  {item.symbol}
                </div>
                <div className="mt-0.5 font-mono text-xs font-bold tabular-nums text-[#ffb02e]">
                  {formatUsd(item.volume24h, true)}
                </div>
                <div className="mt-0.5 flex items-center justify-between font-mono text-[10px] tabular-nums">
                  <span className={up ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}>
                    {formatPct(item.changePct)}
                  </span>
                  <span className="text-slate-500">{item.sharePct.toFixed(1)}%</span>
                </div>
              </button>
            );
          })}
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
                      <span className="flex items-center gap-2 font-medium text-[#e8edfb]">
                        <TokenBadge symbol={m.base_asset_symbol} category={m.category} size={18} />
                        {m.display_name}
                      </span>
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
                    <TokenBadge symbol={m.base_asset_symbol} category={m.category} size={30} />
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
                    <div
                      className={`font-mono text-xs font-semibold tabular-nums ${
                        chg >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                      }`}
                    >
                      {formatPct(chg)}
                    </div>
                  </div>
                  <MarketMoveMeter changePct={chg} />
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
                {liveTrades.slice(0, 10).map((tr, i) => {
                  const isBuy = tr.maker_side?.toLowerCase().includes('buy') || tr.maker_side === '0';
                  const usd = Number(tr.price) * Number(tr.size);
                  const mk = tr.market_id ? marketMetaById.get(String(tr.market_id)) : undefined;
                  return (
                    <tr
                      key={`${tr.id}-${i}`}
                      onClick={() => tr.market_id && onSelectMarket(String(tr.market_id))}
                      className="cursor-pointer hover:bg-[#131c31]/60 transition-colors"
                    >
                      <td className="py-2 pr-2 font-sans font-medium text-[#e8edfb]">
                        <div className="flex items-center gap-2">
                          <TokenBadge
                            symbol={mk?.base_asset_symbol || tr.market_name || 'RISE'}
                            category={mk?.category}
                            size={18}
                          />
                          <span>{tr.market_name || `MKT-${tr.market_id}`}</span>
                        </div>
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
                {liveTrades.length === 0 && (
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
    </div>
  );
};
