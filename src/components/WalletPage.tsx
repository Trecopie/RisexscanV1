import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownUp,
  Award,
  Calendar,
  ExternalLink,
  Loader2,
  Search,
  ShieldAlert,
  TrendingUp,
} from 'lucide-react';
import type {
  IndexedTrader,
  RisexMarket,
  TimeframeKey,
  WalletProfileData,
} from '../types/risex';
import {
  formatDateOnly,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPct,
  formatPrice,
  formatSignedUsd,
  formatUsd,
  nsToMs,
  shortAddress,
} from '../utils/format';
import { normalizeRealizedSide, summarizeRealizedEvents } from '../utils/tradeLifecycle';
import { AreaPerformanceChart, DailyBars30D, PnlCalendarHeatmap } from './Charts';
import { CopyBtn, LiqDistanceBadge, TokenBadge, TraderAvatar } from './TraderAvatar';

type WalletTab =
  | 'positions'
  | 'realized'
  | 'fills'
  | 'orders'
  | 'funding'
  | 'transfers';

type RealizedSortKey = 'pnl' | 'time' | 'size' | 'funding';

export const WalletPage: React.FC<{
  initialAddress: string | null;
  onSelectWallet: (address: string) => void;
  onSelectMarket: (marketId: string) => void;
  onInspectTx: (txHash: string) => void;
}> = ({ initialAddress, onSelectWallet, onSelectMarket, onInspectTx }) => {
  const [lookupInput, setLookupInput] = useState(initialAddress || '');
  const [activeQuery, setActiveQuery] = useState<string | null>(initialAddress);
  const [data, setData] = useState<WalletProfileData | null>(null);
  const [markets, setMarkets] = useState<RisexMarket[]>([]);
  const [topSuggestions, setTopSuggestions] = useState<IndexedTrader[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [chartWindow, setChartWindow] = useState<'1D' | '1W' | '1M' | 'ALL'>('1M');
  const [activeTab, setActiveTab] = useState<WalletTab>('positions');

  // Realized PnL tab filters & sorting
  const [rzViewMode, setRzViewMode] = useState<'events' | 'cycles'>('events');
  const [rzTimeframe, setRzTimeframe] = useState<TimeframeKey>('all');
  const [rzMarketFilter, setRzMarketFilter] = useState<string>('ALL');
  const [rzSideFilter, setRzSideFilter] = useState<'ALL' | 'LONG' | 'SHORT'>('ALL');
  const [rzOutcomeFilter, setRzOutcomeFilter] = useState<'ALL' | 'WIN' | 'LOSS'>('ALL');
  const [rzSortBy, setRzSortBy] = useState<RealizedSortKey>('pnl');
  const [rzSortDesc, setRzSortDesc] = useState<boolean>(true);
  const [rzShowAll, setRzShowAll] = useState<boolean>(false);

  useEffect(() => {
    fetch('/api/markets')
      .then((r) => r.json())
      .then((d) => d?.markets && setMarkets(d.markets))
      .catch(() => {});

    fetch('/api/leaderboard?limit=6')
      .then((r) => r.json())
      .then((d) => {
        if (d?.traders) {
          const sorted = [...d.traders]
            .sort((a: IndexedTrader, b: IndexedTrader) => b.totalPnlAll - a.totalPnlAll)
            .slice(0, 6);
          setTopSuggestions(sorted);
          if (!initialAddress && !activeQuery && sorted[0]) {
            setActiveQuery(sorted[0].address);
            setLookupInput(sorted[0].username || sorted[0].address);
          }
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (initialAddress) {
      setActiveQuery(initialAddress);
      setLookupInput(initialAddress);
    }
  }, [initialAddress]);

  useEffect(() => {
    if (!activeQuery) return;
    let cancelled = false;
    let activeController: AbortController | null = null;

    const fetchProfile = (showLoader: boolean) => {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      if (showLoader) {
        setLoading(true);
        setError(null);
      }
      fetch(`/api/wallet/${encodeURIComponent(activeQuery)}`, { signal: controller.signal })
        .then(async (r) => {
          const json = await r.json();
          if (!r.ok || json.error) throw new Error(json.error || 'Failed to load wallet');
          return json as WalletProfileData;
        })
        .then((d) => {
          if (!cancelled) {
            setData(d);
            setError(null);
            if (showLoader) {
              const pts1M = d.pnlChart?.['1M'] || [];
              const has1MActivity = pts1M.some((p) => Math.abs(Number(p.value)) > 0.01);
              const ptsAll = d.pnlChart?.['ALL'] || [];
              const hasAllActivity = ptsAll.some((p) => Math.abs(Number(p.value)) > 0.01);
              setChartWindow(!has1MActivity && hasAllActivity ? 'ALL' : '1M');
            }
          }
        })
        .catch((err) => {
          if (err?.name === 'AbortError') return;
          if (!cancelled && showLoader) setError(err.message);
        })
        .finally(() => {
          if (!cancelled && showLoader && !controller.signal.aborted) setLoading(false);
        });
    };

    fetchProfile(true);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchProfile(false);
      }
    }, 45000);
    return () => {
      cancelled = true;
      activeController?.abort();
      clearInterval(timer);
    };
  }, [activeQuery]);

  const marketMetaById = useMemo(() => {
    const map = new Map<string, RisexMarket>();
    for (const m of markets) map.set(String(m.market_id), m);
    return map;
  }, [markets]);

  const marketNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of markets) map.set(String(m.market_id), m.display_name);
    return map;
  }, [markets]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = lookupInput.trim();
    if (!q) return;
    setActiveQuery(q);
    onSelectWallet(q);
  };

  interface UnifiedRealizedRow {
    id: string;
    marketId: string;
    marketName: string;
    side: 'LONG' | 'SHORT';
    size: number;
    entryPrice: number;
    exitPrice: number;
    openTime: string | null;
    closeTime: string;
    fillsCount: number | null;
    funding: number;
    realizedPnl: number;
  }

  const allRealizedRows = useMemo<UnifiedRealizedRow[]>(() => {
    if (rzViewMode === 'cycles') {
      return (data?.closedTrades || []).map((ct) => ({
        id: ct.id,
        marketId: ct.marketId,
        marketName: ct.marketName,
        side: ct.side,
        size: ct.maxSize,
        entryPrice: ct.entryPrice,
        exitPrice: ct.exitPrice,
        openTime: ct.openTime,
        closeTime: ct.closeTime,
        fillsCount: ct.fillsCount,
        funding: ct.funding,
        realizedPnl: ct.realizedPnl,
      }));
    }

    return (data?.realizedPnlHistory || []).map((ev, idx) => {
      const mId = String(ev.market_id);
      return {
        id: `${mId}-${ev.timestamp}-${idx}`,
        marketId: mId,
        marketName: marketNameById.get(mId) || `Market #${mId}`,
        side: normalizeRealizedSide(ev.side),
        size: Number(ev.size || 0),
        entryPrice: Number(ev.entry_price || 0),
        exitPrice: Number(ev.exit_price || 0),
        openTime: null,
        closeTime: ev.timestamp,
        fillsCount: null,
        funding: Number(ev.funding || 0),
        realizedPnl: Number(ev.pnl || 0),
      };
    });
  }, [rzViewMode, data?.closedTrades, data?.realizedPnlHistory, marketNameById]);

  const filteredRealized = useMemo(() => {
    if (allRealizedRows.length === 0) return [];

    const anchorMs = Math.max(...allRealizedRows.map((r) => nsToMs(r.closeTime)), Date.now());
    const cutoffMs =
      rzTimeframe === '24h'
        ? anchorMs - 86400 * 1000
        : rzTimeframe === '7d'
          ? anchorMs - 7 * 86400 * 1000
          : rzTimeframe === '30d'
            ? anchorMs - 30 * 86400 * 1000
            : 0;

    return allRealizedRows.filter((row) => {
      const ms = nsToMs(row.closeTime);
      if (cutoffMs > 0 && ms < cutoffMs) return false;
      if (rzMarketFilter !== 'ALL' && row.marketId !== rzMarketFilter) return false;
      if (rzSideFilter !== 'ALL' && row.side !== rzSideFilter) return false;
      if (rzOutcomeFilter === 'WIN' && row.realizedPnl <= 0) return false;
      if (rzOutcomeFilter === 'LOSS' && row.realizedPnl >= 0) return false;
      return true;
    });
  }, [allRealizedRows, rzTimeframe, rzMarketFilter, rzSideFilter, rzOutcomeFilter]);

  const realizedStats = useMemo(() => {
    const s = summarizeRealizedEvents(filteredRealized);
    return {
      count: s.totalEvents,
      netPnl: s.netRealizedPnl,
      grossProfit: s.grossProfit,
      grossLoss: s.grossLoss,
      totalFunding: s.totalFunding,
      wins: s.wins,
      losses: s.losses,
      winRate: s.winRatePct,
      profitFactor: s.profitFactor === null ? Infinity : s.profitFactor,
      bestClose: s.bestClose,
      worstClose: s.worstClose,
    };
  }, [filteredRealized]);

  const cumulativeRealizedCurve = useMemo(() => {
    const asc = [...filteredRealized].sort((a, b) => nsToMs(a.closeTime) - nsToMs(b.closeTime));
    let running = 0;
    return asc.map((ct) => {
      running += ct.realizedPnl;
      return { timestamp: ct.closeTime, value: String(running) };
    });
  }, [filteredRealized]);

  const dailyRealizedBars = useMemo(() => {
    const map = new Map<string, number>();
    for (const ct of filteredRealized) {
      const ms = nsToMs(ct.closeTime);
      if (!ms) continue;
      const dKey = new Date(ms).toISOString().slice(0, 10);
      map.set(dKey, (map.get(dKey) || 0) + ct.realizedPnl);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-30)
      .map(([label, value]) => ({ label: label.slice(5), value }));
  }, [filteredRealized]);

  const sortedRealizedRows = useMemo(() => {
    const list = [...filteredRealized];
    list.sort((a, b) => {
      let av = 0;
      let bv = 0;
      if (rzSortBy === 'pnl') {
        av = a.realizedPnl;
        bv = b.realizedPnl;
      } else if (rzSortBy === 'size') {
        av = a.size * (a.exitPrice || a.entryPrice || 0);
        bv = b.size * (b.exitPrice || b.entryPrice || 0);
      } else if (rzSortBy === 'funding') {
        av = a.funding;
        bv = b.funding;
      } else {
        av = nsToMs(a.closeTime);
        bv = nsToMs(b.closeTime);
      }
      return rzSortDesc ? bv - av : av - bv;
    });
    return list;
  }, [filteredRealized, rzSortBy, rzSortDesc]);

  const toggleRzSort = (key: RealizedSortKey) => {
    if (rzSortBy === key) setRzSortDesc((d) => !d);
    else {
      setRzSortBy(key);
      setRzSortDesc(true);
    }
  };

  const uniqueRealizedMarkets = useMemo(() => {
    const set = new Set<string>();
    for (const row of allRealizedRows) set.add(row.marketId);
    return Array.from(set);
  }, [allRealizedRows]);

  const username = data?.profile?.username || null;
  const avatarUrl =
    data?.profile?.avatar_url || data?.profile?.x_account?.profile_image_url || null;
  const xHandle = data?.profile?.x_account?.username || null;
  const summary = data?.summary;

  const periodCards: {
    key: TimeframeKey;
    title: string;
    metric: WalletProfileData['periodMetrics']['24h'] | undefined;
    statsKey: '7d' | '30d' | 'all' | null;
  }[] = [
    { key: '24h', title: '24H Performance', metric: data?.periodMetrics?.['24h'], statsKey: null },
    { key: '7d', title: '7D Performance', metric: data?.periodMetrics?.['7d'], statsKey: '7d' },
    { key: '30d', title: '30D Performance', metric: data?.periodMetrics?.['30d'], statsKey: '30d' },
    { key: 'all', title: 'All-Time Performance', metric: data?.periodMetrics?.['all'], statsKey: 'all' },
  ];

  return (
    <div className="space-y-6">
      {/* Wallet / Username Lookup Bar */}
      <div className="sunrise-card rounded-2xl p-4 space-y-3">
        <form onSubmit={handleSearchSubmit} className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={lookupInput}
              onChange={(e) => setLookupInput(e.target.value)}
              placeholder="Enter 0x wallet address OR RISEx username (e.g. yeff, Bits, Tieta)…"
              className="w-full rounded-xl border border-slate-700/60 bg-[#090e1a] py-2.5 pl-9 pr-3 text-xs font-mono text-[#e8edfb] placeholder:text-slate-500 focus:border-[#ffb02e] focus:outline-none"
            />
          </div>
          <button
            type="submit"
            className="sunrise-gradient-btn rounded-xl px-5 py-2.5 text-xs font-semibold transition-all"
          >
            Load Wallet Profile
          </button>
        </form>

        {topSuggestions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-[11px] uppercase tracking-wider text-slate-500 mr-1">Quick Pick:</span>
            {topSuggestions.map((t) => (
              <button
                key={t.address}
                type="button"
                onClick={() => {
                  setLookupInput(t.username || t.address);
                  setActiveQuery(t.address);
                  onSelectWallet(t.address);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-[#090e1a] px-2.5 py-1 text-[11px] font-mono text-slate-300 hover:border-[#ffb02e]/50 hover:text-[#ffb02e]"
              >
                <TraderAvatar address={t.address} avatarUrl={t.avatarUrl} username={t.username} size={16} />
                <span>{t.username || shortAddress(t.address, 5, 4)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {loading && !data && (
        <div className="sunrise-card flex flex-col items-center justify-center rounded-2xl py-16 text-slate-400">
          <Loader2 className="mb-3 h-7 w-7 animate-spin text-[#ffb02e]" />
          <div className="text-sm font-medium text-[#e8edfb]">Loading RISEx trader profile…</div>
        </div>
      )}

      {loading && data && (
        <div className="flex items-center justify-between rounded-xl border border-[#ffb02e]/30 bg-[#ffb02e]/10 px-4 py-2 text-xs font-mono text-[#ffb02e]">
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Fetching {activeQuery} performance &amp; funding history…
          </span>
        </div>
      )}

      {error && !loading && (
        <div className="rounded-2xl border border-[#ff4d6d]/40 bg-[#ff4d6d]/10 p-5 text-sm text-[#ff4d6d]">
          {error}
        </div>
      )}

      {data && (!error || loading) && (
        <div className={`space-y-6 transition-opacity duration-200 ${loading ? 'opacity-60 pointer-events-none' : ''}`}>
          {/* Trader Header & Primary Balances */}
          <div className="sunrise-card rounded-2xl p-5 space-y-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="flex items-center gap-4 min-w-0">
                <TraderAvatar
                  address={data.address}
                  avatarUrl={avatarUrl}
                  username={username}
                  size={56}
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="font-display text-2xl font-bold text-[#e8edfb] truncate">
                      {username || shortAddress(data.address, 8, 6)}
                    </h1>
                    {xHandle && (
                      <a
                        href={`https://x.com/${xHandle}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-lg bg-[#46a6ff]/15 px-2 py-0.5 text-xs font-mono text-[#46a6ff] hover:bg-[#46a6ff]/25"
                      >
                        @{xHandle}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    {summary?.in_liquidation && (
                      <span className="inline-flex items-center gap-1 rounded-lg bg-[#ff4d6d]/20 px-2 py-0.5 text-xs font-mono font-semibold text-[#ff4d6d]">
                        <ShieldAlert className="h-3.5 w-3.5" /> IN LIQUIDATION
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs font-mono text-slate-400">
                    <span>{data.address}</span>
                    <CopyBtn text={data.address} />
                    <a
                      href={`https://explorer.risechain.com/address/${data.address}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[#ffb02e] hover:underline"
                    >
                      Blockscout <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {Number(data.profile?.best_rank) > 0 && (
                  <div className="rounded-xl border border-[#ffb02e]/35 bg-[#ffb02e]/10 px-3 py-1.5 text-xs font-mono text-[#ffb02e]">
                    <Award className="mr-1 inline h-3.5 w-3.5" />
                    Best Comp Rank #{data.profile!.best_rank}
                  </div>
                )}
                <div className="rounded-xl border border-slate-800 bg-[#090e1a] px-3 py-1.5 text-xs font-mono text-slate-300">
                  Risk: <strong className="text-[#e8edfb]">{summary?.risk_level || 'NORMAL'}</strong>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <div className="rounded-xl border border-slate-800/80 bg-[#090e1a] p-3">
                <div className="text-[11px] uppercase text-slate-400">Account Value</div>
                <div className="mt-1 font-mono text-lg font-bold tabular-nums text-[#e8edfb]">
                  {formatUsd(summary?.total_account_value)}
                </div>
              </div>
              <div className="rounded-xl border border-slate-800/80 bg-[#090e1a] p-3">
                <div className="text-[11px] uppercase text-slate-400">Unrealized PnL</div>
                <div
                  className={`mt-1 font-mono text-lg font-bold tabular-nums ${
                    Number(summary?.total_unrealized_pnl || 0) >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                  }`}
                >
                  {formatSignedUsd(summary?.total_unrealized_pnl)}
                </div>
              </div>
              <div className="rounded-xl border border-slate-800/80 bg-[#090e1a] p-3">
                <div className="text-[11px] uppercase text-slate-400">Realized PnL</div>
                <div
                  className={`mt-1 font-mono text-lg font-bold tabular-nums ${
                    (summary ? Number(summary.realized_pnl || 0) : data.realizedSummary.netRealizedPnl) >= 0
                      ? 'text-[#22e0a1]'
                      : 'text-[#ff4d6d]'
                  }`}
                >
                  {formatSignedUsd(summary ? summary.realized_pnl : data.realizedSummary.netRealizedPnl)}
                </div>
              </div>
              <div className="rounded-xl border border-slate-800/80 bg-[#090e1a] p-3">
                <div className="text-[11px] uppercase text-slate-400">Free Collateral</div>
                <div className="mt-1 font-mono text-base font-semibold tabular-nums text-slate-200">
                  {formatUsd(summary?.free_collateral)}
                </div>
              </div>
              <div className="rounded-xl border border-slate-800/80 bg-[#090e1a] p-3">
                <div className="text-[11px] uppercase text-slate-400">Total Notional</div>
                <div className="mt-1 font-mono text-base font-semibold tabular-nums text-slate-200">
                  {formatUsd(summary?.total_notional, true)}
                </div>
              </div>
              <div className="rounded-xl border border-slate-800/80 bg-[#090e1a] p-3">
                <div className="text-[11px] uppercase text-slate-400">Acct Leverage / Margin</div>
                <div className="mt-1 font-mono text-base font-semibold tabular-nums text-[#ffb02e]">
                  {Number(summary?.account_leverage || 0).toFixed(2)}x ·{' '}
                  {(Number(summary?.margin_usage || 0) * 100).toFixed(1)}%
                </div>
              </div>
            </div>
          </div>

          {/* All 4 Timeframe Performance Cards Visible Side-by-Side (24h / 7d / 30d / All) */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {periodCards.map((card) => {
              const pnl = card.metric?.pnl ?? 0;
              const roi = card.metric?.roiPct;
              const vol = card.metric?.volume ?? 0;
              const rank = card.metric?.rank ?? 0;
              const pStats = card.statsKey ? data.statsByPeriod?.[card.statsKey] : null;
              return (
                <div key={card.key} className="sunrise-card rounded-2xl p-4 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-display font-bold uppercase tracking-wider text-slate-300">
                      {card.title}
                    </span>
                    {rank > 0 && (
                      <span className="rounded bg-[#ffb02e]/15 px-1.5 py-0.5 text-[10px] font-mono text-[#ffb02e]">
                        Rank #{rank.toLocaleString()}
                      </span>
                    )}
                  </div>
                  <div className="flex items-baseline justify-between font-mono tabular-nums">
                    <span className={`text-xl font-bold ${pnl >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}`}>
                      {formatSignedUsd(pnl, true)}
                    </span>
                    <span
                      className={`text-xs font-semibold ${
                        (roi ?? 0) >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                      }`}
                    >
                      {roi !== null && roi !== undefined ? formatPct(roi) : '—'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between border-t border-slate-800/70 pt-2 text-[11px] font-mono text-slate-400 tabular-nums">
                    <span>Vol: <strong className="text-slate-200">{formatUsd(vol, true)}</strong></span>
                    {pStats?.performance?.win_rate ? (
                      <span>
                        WR: <strong className="text-slate-200">{(Number(pStats.performance.win_rate) * 100).toFixed(1)}%</strong>
                      </span>
                    ) : (
                      <span>Exp: <strong className="text-slate-200">{formatUsd(card.metric?.exposure, true)}</strong></span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* 2-Column Side-by-Side PnL & Account Equity Charts (Previous Version Layout) */}
          <div className="sunrise-card rounded-2xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-[#ffb02e]" />
                <h2 className="font-display text-base font-bold text-[#e8edfb]">
                  PnL & Account Equity History
                </h2>
              </div>
              <div className="flex items-center gap-1 rounded-xl border border-slate-800 bg-[#090e1a] p-1">
                {(['1D', '1W', '1M', 'ALL'] as const).map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setChartWindow(w)}
                    className={`rounded-lg px-3 py-1 text-xs font-mono font-semibold transition-all ${
                      chartWindow === w ? 'sunrise-gradient-btn' : 'text-slate-400 hover:text-[#e8edfb]'
                    }`}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <AreaPerformanceChart
                points={data.pnlChart[chartWindow]}
                label={`PnL (${chartWindow})`}
                signed
                height={230}
              />
              <AreaPerformanceChart
                points={data.equityChart[chartWindow]}
                label={`Account Equity (${chartWindow})`}
                signed={false}
                height={230}
              />
            </div>
          </div>

          {/* Daily PnL Calendar Heatmap + Risk & Performance Breakdown (Always Visible!) */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
            <div className="sunrise-card rounded-2xl p-4 lg:col-span-7 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-[#ffb02e]" />
                  <h2 className="font-display text-base font-bold text-[#e8edfb]">
                    Daily PnL Calendar
                  </h2>
                </div>
                {data.pnlCalendar?.best_day && (
                  <span className="text-xs font-mono text-slate-400">
                    Best Day:{' '}
                    <strong className="text-[#22e0a1]">{formatSignedUsd(data.pnlCalendar.best_day.pnl)}</strong>
                    <span className="ml-1.5 text-[11px] text-slate-500">
                      ({formatDateOnly(data.pnlCalendar.best_day.date)})
                    </span>
                  </span>
                )}
              </div>
              <PnlCalendarHeatmap
                days={data.pnlCalendar?.days || []}
                winDays={data.pnlCalendar?.win_days}
              />
            </div>

            <div className="sunrise-card rounded-2xl p-4 lg:col-span-5 space-y-3">
              <h2 className="font-display text-base font-bold text-[#e8edfb]">
                Performance & Risk Breakdown
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono tabular-nums">
                  <thead className="border-b border-slate-800 text-[10px] uppercase text-slate-400">
                    <tr>
                      <th className="py-2 pr-2 font-sans">Metric</th>
                      <th className="py-2 px-2 text-right">7D</th>
                      <th className="py-2 px-2 text-right">30D</th>
                      <th className="py-2 pl-2 text-right">All</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    <tr>
                      <td className="py-2.5 pr-2 font-sans text-slate-400">Win Rate</td>
                      <td className="py-2.5 px-2 text-right text-slate-200">
                        {data.statsByPeriod?.['7d']?.performance?.win_rate
                          ? `${(Number(data.statsByPeriod['7d'].performance.win_rate) * 100).toFixed(1)}%`
                          : '—'}
                      </td>
                      <td className="py-2.5 px-2 text-right text-slate-200">
                        {data.statsByPeriod?.['30d']?.performance?.win_rate
                          ? `${(Number(data.statsByPeriod['30d'].performance.win_rate) * 100).toFixed(1)}%`
                          : '—'}
                      </td>
                      <td className="py-2.5 pl-2 text-right text-[#22e0a1]">
                        {data.statsByPeriod?.['all']?.performance?.win_rate
                          ? `${(Number(data.statsByPeriod['all'].performance.win_rate) * 100).toFixed(1)}%`
                          : '—'}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2.5 pr-2 font-sans text-slate-400">Profit Factor</td>
                      <td className="py-2.5 px-2 text-right text-slate-200">
                        {data.statsByPeriod?.['7d']?.performance?.profit_factor
                          ? Number(data.statsByPeriod['7d'].performance.profit_factor).toFixed(2)
                          : '—'}
                      </td>
                      <td className="py-2.5 px-2 text-right text-slate-200">
                        {data.statsByPeriod?.['30d']?.performance?.profit_factor
                          ? Number(data.statsByPeriod['30d'].performance.profit_factor).toFixed(2)
                          : '—'}
                      </td>
                      <td className="py-2.5 pl-2 text-right text-[#ffb02e]">
                        {data.statsByPeriod?.['all']?.performance?.profit_factor
                          ? Number(data.statsByPeriod['all'].performance.profit_factor).toFixed(2)
                          : '—'}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2.5 pr-2 font-sans text-slate-400">Sharpe Ratio</td>
                      <td className="py-2.5 px-2 text-right text-slate-200">
                        {data.statsByPeriod?.['7d']?.performance?.sharpe_ratio
                          ? Number(data.statsByPeriod['7d'].performance.sharpe_ratio).toFixed(2)
                          : '—'}
                      </td>
                      <td className="py-2.5 px-2 text-right text-slate-200">
                        {data.statsByPeriod?.['30d']?.performance?.sharpe_ratio
                          ? Number(data.statsByPeriod['30d'].performance.sharpe_ratio).toFixed(2)
                          : '—'}
                      </td>
                      <td className="py-2.5 pl-2 text-right text-slate-100">
                        {data.statsByPeriod?.['all']?.performance?.sharpe_ratio
                          ? Number(data.statsByPeriod['all'].performance.sharpe_ratio).toFixed(2)
                          : '—'}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2.5 pr-2 font-sans text-slate-400">Max Drawdown</td>
                      <td className="py-2.5 px-2 text-right text-[#ff4d6d]">
                        {data.statsByPeriod?.['7d']?.performance?.max_drawdown
                          ? `${(Number(data.statsByPeriod['7d'].performance.max_drawdown) * 100).toFixed(1)}%`
                          : '—'}
                      </td>
                      <td className="py-2.5 px-2 text-right text-[#ff4d6d]">
                        {data.statsByPeriod?.['30d']?.performance?.max_drawdown
                          ? `${(Number(data.statsByPeriod['30d'].performance.max_drawdown) * 100).toFixed(1)}%`
                          : '—'}
                      </td>
                      <td className="py-2.5 pl-2 text-right text-[#ff4d6d]">
                        {data.statsByPeriod?.['all']?.performance?.max_drawdown
                          ? `${(Number(data.statsByPeriod['all'].performance.max_drawdown) * 100).toFixed(1)}%`
                          : '—'}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2.5 pr-2 font-sans text-slate-400">Avg Duration</td>
                      <td className="py-2.5 px-2 text-right text-slate-300">
                        {formatDuration(data.statsByPeriod?.['7d']?.analytics?.avg_trade_duration_seconds)}
                      </td>
                      <td className="py-2.5 px-2 text-right text-slate-300">
                        {formatDuration(data.statsByPeriod?.['30d']?.analytics?.avg_trade_duration_seconds)}
                      </td>
                      <td className="py-2.5 pl-2 text-right text-slate-200">
                        {formatDuration(data.statsByPeriod?.['all']?.analytics?.avg_trade_duration_seconds)}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2.5 pr-2 font-sans text-slate-400">Win Streak</td>
                      <td className="py-2.5 px-2 text-right text-slate-300">
                        {data.statsByPeriod?.['7d']?.analytics?.longest_win_streak || '—'}
                      </td>
                      <td className="py-2.5 px-2 text-right text-slate-300">
                        {data.statsByPeriod?.['30d']?.analytics?.longest_win_streak || '—'}
                      </td>
                      <td className="py-2.5 pl-2 text-right text-[#22e0a1]">
                        {data.statsByPeriod?.['all']?.analytics?.longest_win_streak || '—'}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {data.profile?.history && data.profile.history.length > 0 && (
                <div className="border-t border-slate-800/80 pt-3">
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    Challenge Placements
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {data.profile.history.slice(0, 6).map((h) => (
                      <span
                        key={h.slug}
                        className="rounded-lg border border-slate-800 bg-[#090e1a] px-2 py-1 text-[11px] text-slate-300"
                      >
                        {h.name} · <strong className="font-mono text-[#ffb02e]">#{h.rank}</strong>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Section Tabs */}
          <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-800/80 pb-3">
            {(
              [
                { id: 'positions', label: `Open Positions (${data.positions.length})` },
                {
                  id: 'realized',
                  label: `Realized PnL (${(data.realizedPnlHistory?.length || data.closedTrades.length).toLocaleString()})`,
                },
                { id: 'fills', label: `Trade Fills (${data.trades.length})` },
                { id: 'orders', label: `Orders (${data.openOrders.length} open / ${data.orderHistory.length})` },
                { id: 'funding', label: `Funding Payments (${data.fundingPayments.length})` },
                { id: 'transfers', label: `Transfers (${data.transfers.length})` },
              ] as { id: WalletTab; label: string }[]
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={`rounded-xl px-3.5 py-2 text-xs font-semibold transition-all ${
                  activeTab === t.id
                    ? 'sunrise-gradient-btn'
                    : 'border border-slate-800 bg-[#090e1a] text-slate-400 hover:text-[#e8edfb]'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* TAB 1: OPEN POSITIONS */}
          {activeTab === 'positions' && (
            <div className="sunrise-card overflow-hidden rounded-2xl">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-800 bg-[#090e1a]/80 text-[11px] uppercase tracking-wider text-slate-400">
                    <tr>
                      <th className="py-3 pl-4 pr-2">Market</th>
                      <th className="py-3 px-2">Side</th>
                      <th className="py-3 px-2 text-right">Size / Notional</th>
                      <th className="py-3 px-2 text-right">Entry</th>
                      <th className="py-3 px-2 text-right">Mark</th>
                      <th className="py-3 px-2 text-right">Liq. Price & Risk</th>
                      <th className="py-3 px-2 text-right">Unrealized PnL</th>
                      <th className="py-3 px-2 text-right">Realized PnL</th>
                      <th className="py-3 pl-2 pr-4 text-right">ROI %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
                    {data.positions.map((p, i) => {
                      const openRpnl = p.realizedPnl ?? 0;
                      return (
                        <tr
                          key={i}
                          onClick={() => onSelectMarket(p.marketId)}
                          className="cursor-pointer hover:bg-[#131c31]/60"
                        >
                          <td className="py-3 pl-4 pr-2 font-sans font-semibold text-[#e8edfb]">
                            {p.marketName}
                            <span className="ml-2 text-[10px] font-mono text-slate-500">{p.marginMode}</span>
                          </td>
                          <td className="py-3 px-2">
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                p.side === 'LONG' ? 'bg-[#22e0a1]/15 text-[#22e0a1]' : 'bg-[#ff4d6d]/15 text-[#ff4d6d]'
                              }`}
                            >
                              {p.side} {p.leverage.toFixed(1)}x
                            </span>
                          </td>
                          <td className="py-3 px-2 text-right">
                            <div className="text-[#e8edfb]">{formatUsd(p.notionalUsd, true)}</div>
                            <div className="text-[10px] text-slate-400">{formatNumber(p.size, 4)}</div>
                          </td>
                          <td className="py-3 px-2 text-right text-slate-300">{formatPrice(p.entryPrice)}</td>
                          <td className="py-3 px-2 text-right text-slate-200">{formatPrice(p.markPrice)}</td>
                          <td className="py-3 px-2 text-right">
                            <div>{p.liquidationPrice > 0 ? formatPrice(p.liquidationPrice) : '—'}</div>
                            <div className="mt-0.5 flex justify-end">
                              <LiqDistanceBadge
                                markPrice={p.markPrice}
                                liquidationPrice={p.liquidationPrice}
                                side={p.side}
                              />
                            </div>
                          </td>
                          <td
                            className={`py-3 px-2 text-right font-semibold ${
                              p.unrealizedPnl >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                            }`}
                          >
                            {formatSignedUsd(p.unrealizedPnl)}
                          </td>
                          <td
                            className={`py-3 px-2 text-right font-semibold ${
                              openRpnl > 0
                                ? 'text-[#22e0a1]'
                                : openRpnl < 0
                                  ? 'text-[#ff4d6d]'
                                  : 'text-slate-500'
                            }`}
                          >
                            {formatSignedUsd(openRpnl)}
                          </td>
                          <td
                            className={`py-3 pl-2 pr-4 text-right font-semibold ${
                              p.roiPct >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                            }`}
                          >
                            {formatPct(p.roiPct)}
                          </td>
                        </tr>
                      );
                    })}
                    {data.positions.length === 0 && (
                      <tr>
                        <td colSpan={9} className="py-10 text-center font-sans text-slate-400">
                          No open perpetual positions on this account.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 2: REALIZED PNL (Official Realized Events by Default + Closed Cycles View) */}
          {activeTab === 'realized' && (
            <div className="space-y-5">
              {/* Filter & Sort Controls */}
              <div className="sunrise-card flex flex-wrap items-center justify-between gap-3 rounded-2xl p-4">
                <div className="flex flex-wrap items-center gap-2">
                  {/* View Switcher: Official Events vs Reconstructed Full Position Cycles */}
                  <div className="flex items-center gap-1 rounded-xl border border-slate-800 bg-[#090e1a] p-1">
                    <button
                      type="button"
                      onClick={() => {
                        setRzViewMode('events');
                        setRzMarketFilter('ALL');
                        setRzShowAll(false);
                      }}
                      className={`rounded-lg px-2.5 py-1 text-xs font-mono transition-colors ${
                        rzViewMode === 'events'
                          ? 'bg-[#22e0a1] font-semibold text-[#041b12]'
                          : 'text-slate-400 hover:text-[#e8edfb]'
                      }`}
                    >
                      Realized Events ({(data.realizedPnlHistory?.length || 0).toLocaleString()})
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRzViewMode('cycles');
                        setRzMarketFilter('ALL');
                        setRzShowAll(false);
                      }}
                      className={`rounded-lg px-2.5 py-1 text-xs font-mono transition-colors ${
                        rzViewMode === 'cycles'
                          ? 'bg-[#ffb02e] font-semibold text-[#1f0e03]'
                          : 'text-slate-400 hover:text-[#e8edfb]'
                      }`}
                    >
                      Closed Cycles ({data.closedTrades.length.toLocaleString()})
                    </button>
                  </div>

                  <div className="flex items-center gap-1 rounded-xl border border-slate-800 bg-[#090e1a] p-1">
                    {(['24h', '7d', '30d', 'all'] as TimeframeKey[]).map((tf) => (
                      <button
                        key={tf}
                        type="button"
                        onClick={() => setRzTimeframe(tf)}
                        className={`rounded-lg px-2.5 py-1 text-xs font-mono uppercase ${
                          rzTimeframe === tf ? 'bg-[#ffb02e] font-semibold text-[#1f0e03]' : 'text-slate-400'
                        }`}
                      >
                        {tf}
                      </button>
                    ))}
                  </div>
                  <select
                    value={rzMarketFilter}
                    onChange={(e) => setRzMarketFilter(e.target.value)}
                    className="rounded-xl border border-slate-700/60 bg-[#090e1a] px-3 py-1.5 text-xs text-[#e8edfb]"
                  >
                    <option value="ALL">All Markets</option>
                    {uniqueRealizedMarkets.map((id) => (
                      <option key={id} value={id}>
                        {marketNameById.get(id) || `Market #${id}`}
                      </option>
                    ))}
                  </select>
                  <select
                    value={rzSideFilter}
                    onChange={(e) => setRzSideFilter(e.target.value as 'ALL' | 'LONG' | 'SHORT')}
                    className="rounded-xl border border-slate-700/60 bg-[#090e1a] px-3 py-1.5 text-xs text-[#e8edfb]"
                  >
                    <option value="ALL">All Sides</option>
                    <option value="LONG">Long Only</option>
                    <option value="SHORT">Short Only</option>
                  </select>
                  <select
                    value={rzOutcomeFilter}
                    onChange={(e) => setRzOutcomeFilter(e.target.value as 'ALL' | 'WIN' | 'LOSS')}
                    className="rounded-xl border border-slate-700/60 bg-[#090e1a] px-3 py-1.5 text-xs text-[#e8edfb]"
                  >
                    <option value="ALL">Wins & Losses</option>
                    <option value="WIN">Winning Closes</option>
                    <option value="LOSS">Losing Closes</option>
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <select
                    value={`${rzSortBy}:${rzSortDesc ? 'desc' : 'asc'}`}
                    onChange={(e) => {
                      const [k, dir] = e.target.value.split(':');
                      setRzSortBy(k as RealizedSortKey);
                      setRzSortDesc(dir === 'desc');
                    }}
                    className="rounded-xl border border-slate-700/60 bg-[#090e1a] px-3 py-1.5 text-xs text-[#e8edfb]"
                  >
                    <option value="pnl:desc">Sort: Realized PnL (Highest First)</option>
                    <option value="pnl:asc">Sort: Realized PnL (Lowest First)</option>
                    <option value="time:desc">Sort: Latest Closed</option>
                    <option value="time:asc">Sort: Oldest Closed</option>
                    <option value="size:desc">Sort: Largest Position</option>
                    <option value="funding:desc">Sort: Funding Received</option>
                  </select>
                </div>
              </div>

              {/* Realized PnL Summary Cards */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <div className="sunrise-card rounded-xl p-3.5">
                  <div className="text-[11px] uppercase text-slate-400">Net Realized PnL</div>
                  <div
                    className={`mt-1 font-mono text-lg font-bold tabular-nums ${
                      realizedStats.netPnl >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                    }`}
                  >
                    {formatSignedUsd(realizedStats.netPnl)}
                  </div>
                  <div className="text-[10px] font-mono text-slate-400">
                    {realizedStats.count.toLocaleString()} {rzViewMode === 'events' ? 'realized events' : 'closed cycles'}
                    {rzViewMode === 'cycles' && data.tradesCapped && ' (1,600-fill window)'}
                  </div>
                </div>
                <div className="sunrise-card rounded-xl p-3.5">
                  <div className="text-[11px] uppercase text-slate-400">Gross Profit</div>
                  <div className="mt-1 font-mono text-lg font-bold tabular-nums text-[#22e0a1]">
                    {formatSignedUsd(realizedStats.grossProfit)}
                  </div>
                  <div className="text-[10px] font-mono text-slate-400">{realizedStats.wins.toLocaleString()} wins</div>
                </div>
                <div className="sunrise-card rounded-xl p-3.5">
                  <div className="text-[11px] uppercase text-slate-400">Gross Loss</div>
                  <div className="mt-1 font-mono text-lg font-bold tabular-nums text-[#ff4d6d]">
                    {formatSignedUsd(realizedStats.grossLoss)}
                  </div>
                  <div className="text-[10px] font-mono text-slate-400">{realizedStats.losses.toLocaleString()} losses</div>
                </div>
                <div className="sunrise-card rounded-xl p-3.5">
                  <div className="text-[11px] uppercase text-slate-400">Net Funding</div>
                  <div
                    className={`mt-1 font-mono text-lg font-bold tabular-nums ${
                      realizedStats.totalFunding >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                    }`}
                  >
                    {formatSignedUsd(realizedStats.totalFunding)}
                  </div>
                </div>
                <div className="sunrise-card rounded-xl p-3.5">
                  <div className="text-[11px] uppercase text-slate-400">Win Rate &amp; PF</div>
                  <div className="mt-1 font-mono text-base font-bold tabular-nums text-[#ffb02e]">
                    {realizedStats.winRate.toFixed(1)}% ·{' '}
                    {realizedStats.profitFactor === Infinity
                      ? '∞'
                      : realizedStats.profitFactor.toFixed(2)}
                  </div>
                </div>
                <div className="sunrise-card rounded-xl p-3.5">
                  <div className="text-[11px] uppercase text-slate-400">Best / Worst Close</div>
                  <div className="mt-1 font-mono text-xs font-semibold tabular-nums">
                    <div className="text-[#22e0a1]">{formatSignedUsd(realizedStats.bestClose, true)}</div>
                    <div className="text-[#ff4d6d]">{formatSignedUsd(realizedStats.worstClose, true)}</div>
                  </div>
                </div>
              </div>

              {/* Cumulative Curve + 30D Daily Bars */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <AreaPerformanceChart
                  points={cumulativeRealizedCurve}
                  label="Cumulative Realized PnL"
                  signed
                  height={210}
                />
                <DailyBars30D items={dailyRealizedBars} height={210} />
              </div>

              {/* Realized PnL Table with Clickable Sort */}
              <div className="sunrise-card overflow-hidden rounded-2xl">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-800 bg-[#090e1a]/80 text-[11px] uppercase tracking-wider text-slate-400">
                      <tr>
                        <th
                          onClick={() => toggleRzSort('time')}
                          className="cursor-pointer py-3 pl-4 pr-2 hover:text-[#ffb02e]"
                        >
                          <span className="inline-flex items-center gap-1">
                            Closed Time <ArrowDownUp className="h-3 w-3" />
                          </span>
                        </th>
                        <th className="py-3 px-2">Market</th>
                        <th className="py-3 px-2">Side</th>
                        <th
                          onClick={() => toggleRzSort('size')}
                          className="cursor-pointer py-3 px-2 text-right hover:text-[#ffb02e]"
                        >
                          <span className="inline-flex items-center gap-1">
                            Size <ArrowDownUp className="h-3 w-3" />
                          </span>
                        </th>
                        <th className="py-3 px-2 text-right">Entry</th>
                        <th className="py-3 px-2 text-right">Exit</th>
                        <th
                          onClick={() => toggleRzSort('funding')}
                          className="cursor-pointer py-3 px-2 text-right hover:text-[#ffb02e]"
                        >
                          <span className="inline-flex items-center gap-1">
                            Funding <ArrowDownUp className="h-3 w-3" />
                          </span>
                        </th>
                        <th
                          onClick={() => toggleRzSort('pnl')}
                          className={`cursor-pointer py-3 pl-2 pr-4 text-right hover:text-[#ffb02e] ${
                            rzSortBy === 'pnl' ? 'text-[#ffb02e]' : ''
                          }`}
                        >
                          <span className="inline-flex items-center gap-1">
                            Realized PnL <ArrowDownUp className="h-3 w-3" />
                          </span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
                      {(rzShowAll ? sortedRealizedRows : sortedRealizedRows.slice(0, 200)).map((ct) => {
                        const mk = marketMetaById.get(ct.marketId);
                        return (
                          <tr
                            key={ct.id}
                            onClick={() => onSelectMarket(ct.marketId)}
                            className="cursor-pointer hover:bg-[#131c31]/60"
                          >
                            <td className="py-2.5 pl-4 pr-2 text-slate-400">
                              <div>{formatDateTime(ct.closeTime)}</div>
                              {ct.openTime && ct.fillsCount !== null && (
                                <div className="text-[10px] text-slate-500">
                                  Opened {formatDateTime(ct.openTime)} · {ct.fillsCount} fills
                                </div>
                              )}
                            </td>
                            <td className="py-2.5 px-2 font-sans font-semibold text-[#e8edfb]">
                              <div className="flex items-center gap-2">
                                <TokenBadge
                                  symbol={mk?.base_asset_symbol || ct.marketName}
                                  category={mk?.category}
                                  size={20}
                                />
                                <span>{ct.marketName}</span>
                              </div>
                            </td>
                            <td className="py-2.5 px-2">
                              <span
                                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                  ct.side === 'LONG' ? 'bg-[#22e0a1]/15 text-[#22e0a1]' : 'bg-[#ff4d6d]/15 text-[#ff4d6d]'
                                }`}
                              >
                                {ct.side}
                              </span>
                            </td>
                            <td className="py-2.5 px-2 text-right text-slate-300">
                              {formatNumber(ct.size, 4)}
                            </td>
                            <td className="py-2.5 px-2 text-right text-slate-300">{formatPrice(ct.entryPrice)}</td>
                            <td className="py-2.5 px-2 text-right text-slate-200">{formatPrice(ct.exitPrice)}</td>
                            <td className={`py-2.5 px-2 text-right ${ct.funding >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}`}>
                              {formatSignedUsd(ct.funding)}
                            </td>
                            <td className={`py-2.5 pl-2 pr-4 text-right font-semibold ${ct.realizedPnl >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}`}>
                              {formatSignedUsd(ct.realizedPnl)}
                            </td>
                          </tr>
                        );
                      })}
                      {sortedRealizedRows.length === 0 && (
                        <tr>
                          <td colSpan={8} className="py-10 text-center font-sans text-slate-400">
                            {rzViewMode === 'cycles'
                              ? 'No complete 0→0 position cycles fit in the latest 1,600 fills. Switch to Realized Events to see all settlement closes.'
                              : 'No realized PnL events match the active filters.'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {sortedRealizedRows.length > 200 && (
                  <div className="flex items-center justify-between border-t border-slate-800/80 bg-[#090e1a]/70 px-4 py-2.5 text-xs text-slate-400">
                    <span className="font-mono">
                      Showing {rzShowAll ? sortedRealizedRows.length.toLocaleString() : '200'} of{' '}
                      {sortedRealizedRows.length.toLocaleString()} events
                    </span>
                    <button
                      type="button"
                      onClick={() => setRzShowAll((v) => !v)}
                      className="rounded-lg border border-slate-700/70 bg-[#0e1526] px-3 py-1 font-mono text-xs text-[#ffb02e] hover:border-[#ffb02e]/60"
                    >
                      {rzShowAll ? 'Collapse to 200' : `Show All ${sortedRealizedRows.length.toLocaleString()}`}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: TRADE FILLS */}
          {activeTab === 'fills' && (
            <div className="sunrise-card overflow-hidden rounded-2xl">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-800 bg-[#090e1a]/80 text-[11px] uppercase tracking-wider text-slate-400">
                    <tr>
                      <th className="py-3 pl-4 pr-2">Time</th>
                      <th className="py-3 px-2">Market</th>
                      <th className="py-3 px-2">Side</th>
                      <th className="py-3 px-2">Liquidity</th>
                      <th className="py-3 px-2 text-right">Price</th>
                      <th className="py-3 px-2 text-right">Size</th>
                      <th className="py-3 px-2 text-right">Fee</th>
                      <th className="py-3 pl-2 pr-4 text-right">Tx</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
                    {data.trades.map((tr) => {
                      const isBuy = String(tr.side).toLowerCase().includes('buy') || tr.side === '0';
                      const txHash = tr.blockchain_data?.tx_hash;
                      return (
                        <tr key={tr.id} className="hover:bg-[#131c31]/50">
                          <td className="py-2.5 pl-4 pr-2 text-slate-400">{formatDateTime(tr.time)}</td>
                          <td
                            onClick={() => onSelectMarket(String(tr.market_id))}
                            className="cursor-pointer py-2.5 px-2 font-sans font-semibold text-[#e8edfb] hover:text-[#ffb02e]"
                          >
                            {marketNameById.get(String(tr.market_id)) || `MKT-${tr.market_id}`}
                          </td>
                          <td className={`py-2.5 px-2 font-semibold ${isBuy ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}`}>
                            {isBuy ? 'BUY' : 'SELL'}
                          </td>
                          <td className="py-2.5 px-2 text-slate-400">{tr.liquidity_indicator || '—'}</td>
                          <td className="py-2.5 px-2 text-right text-slate-200">{formatPrice(tr.price)}</td>
                          <td className="py-2.5 px-2 text-right text-slate-300">{formatNumber(tr.size, 4)}</td>
                          <td className="py-2.5 px-2 text-right text-slate-400">{formatUsd(tr.fee)}</td>
                          <td className="py-2.5 pl-2 pr-4 text-right">
                            {txHash ? (
                              <button
                                type="button"
                                onClick={() => onInspectTx(txHash)}
                                className="text-[#46a6ff] hover:underline"
                              >
                                {shortAddress(txHash, 6, 4)}
                              </button>
                            ) : (
                              '—'
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {data.trades.length === 0 && (
                      <tr>
                        <td colSpan={8} className="py-10 text-center font-sans text-slate-400">
                          No trade fills recorded for this account.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 4: ORDERS */}
          {activeTab === 'orders' && (
            <div className="space-y-4">
              <div className="sunrise-card overflow-hidden rounded-2xl p-4">
                <h3 className="mb-3 font-display text-sm font-bold text-[#e8edfb]">
                  Open Orders ({data.openOrders.length})
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs font-mono tabular-nums">
                    <thead className="border-b border-slate-800 text-[11px] uppercase text-slate-400">
                      <tr>
                        <th className="py-2 pr-2">Market</th>
                        <th className="py-2 px-2">Side</th>
                        <th className="py-2 px-2 text-right">Limit Price</th>
                        <th className="py-2 px-2 text-right">Size</th>
                        <th className="py-2 pl-2 text-right">Flags</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {data.openOrders.map((o) => (
                        <tr key={o.id}>
                          <td className="py-2 pr-2 font-sans font-semibold text-[#e8edfb]">
                            {marketNameById.get(String(o.market_id)) || `MKT-${o.market_id}`}
                          </td>
                          <td className="py-2 px-2 text-slate-200">{String(o.side)}</td>
                          <td className="py-2 px-2 text-right text-slate-200">{formatPrice(o.price)}</td>
                          <td className="py-2 px-2 text-right text-slate-300">{formatNumber(o.size, 4)}</td>
                          <td className="py-2 pl-2 text-right text-slate-400">
                            {[o.post_only && 'POST', o.reduce_only && 'REDUCE'].filter(Boolean).join(' · ') || 'STANDARD'}
                          </td>
                        </tr>
                      ))}
                      {data.openOrders.length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-6 text-center font-sans text-slate-400">
                            No resting open orders.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="sunrise-card overflow-hidden rounded-2xl p-4">
                <h3 className="mb-3 font-display text-sm font-bold text-[#e8edfb]">
                  Order History ({data.orderHistory.length})
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs font-mono tabular-nums">
                    <thead className="border-b border-slate-800 text-[11px] uppercase text-slate-400">
                      <tr>
                        <th className="py-2 pr-2">Created</th>
                        <th className="py-2 px-2">Market</th>
                        <th className="py-2 px-2">Side</th>
                        <th className="py-2 px-2 text-right">Price</th>
                        <th className="py-2 px-2 text-right">Filled / Size</th>
                        <th className="py-2 pl-2 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {data.orderHistory.slice(0, 60).map((o) => (
                        <tr key={o.id}>
                          <td className="py-2 pr-2 text-slate-400">{formatDateTime(o.created_at)}</td>
                          <td className="py-2 px-2 font-sans font-semibold text-[#e8edfb]">
                            {marketNameById.get(String(o.market_id)) || `MKT-${o.market_id}`}
                          </td>
                          <td className="py-2 px-2 text-slate-200">{String(o.side)}</td>
                          <td className="py-2 px-2 text-right text-slate-200">{formatPrice(o.avg_price || o.price)}</td>
                          <td className="py-2 px-2 text-right text-slate-300">
                            {formatNumber(o.filled_size || 0, 3)} / {formatNumber(o.size, 3)}
                          </td>
                          <td className="py-2 pl-2 text-right text-slate-400">{o.status || '—'}</td>
                        </tr>
                      ))}
                      {data.orderHistory.length === 0 && (
                        <tr>
                          <td colSpan={6} className="py-6 text-center font-sans text-slate-400">
                            No historical orders recorded.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: FUNDING PAYMENTS */}
          {activeTab === 'funding' && (
            <div className="sunrise-card overflow-hidden rounded-2xl p-4">
              <h3 className="mb-3 font-display text-sm font-bold text-[#e8edfb]">
                Funding Payments ({data.fundingPayments.length})
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono tabular-nums">
                  <thead className="border-b border-slate-800 text-[11px] uppercase text-slate-400">
                    <tr>
                      <th className="py-2 pr-2">Time</th>
                      <th className="py-2 px-2">Market</th>
                      <th className="py-2 px-2 text-right">Position Size</th>
                      <th className="py-2 px-2 text-right">Funding Rate</th>
                      <th className="py-2 pl-2 text-right">Payment</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {data.fundingPayments.map((f, i) => {
                      const val = Number(f.funding_payment || 0);
                      return (
                        <tr key={i}>
                          <td className="py-2 pr-2 text-slate-400">{formatDateTime(f.block_time)}</td>
                          <td className="py-2 px-2 font-sans text-[#e8edfb]">
                            {marketNameById.get(String(f.market_id)) || `MKT-${f.market_id}`}
                          </td>
                          <td className="py-2 px-2 text-right text-slate-300">{formatNumber(f.position_size, 4)}</td>
                          <td className="py-2 px-2 text-right text-slate-400">
                            {(Number(f.funding_rate || 0) * 100).toFixed(4)}%
                          </td>
                          <td className={`py-2 pl-2 text-right ${val >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}`}>
                            {formatSignedUsd(val)}
                          </td>
                        </tr>
                      );
                    })}
                    {data.fundingPayments.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-8 text-center font-sans text-slate-400">
                          No funding payments recorded.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 6: TRANSFERS */}
          {activeTab === 'transfers' && (
            <div className="sunrise-card overflow-hidden rounded-2xl p-4">
              <h3 className="mb-3 font-display text-sm font-bold text-[#e8edfb]">
                Deposits & Withdrawals ({data.transfers.length})
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono tabular-nums">
                  <thead className="border-b border-slate-800 text-[11px] uppercase text-slate-400">
                    <tr>
                      <th className="py-2 pr-2">Time</th>
                      <th className="py-2 px-2">Type</th>
                      <th className="py-2 px-2 text-right">Amount</th>
                      <th className="py-2 px-2 text-right">Block</th>
                      <th className="py-2 pl-2 text-right">Tx</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {data.transfers.map((tr, i) => (
                      <tr key={i}>
                        <td className="py-2 pr-2 text-slate-400">{formatDateTime(tr.block_time)}</td>
                        <td className="py-2 px-2 text-slate-200">{tr.type}</td>
                        <td className="py-2 px-2 text-right text-[#ffb02e]">{formatUsd(tr.amount)}</td>
                        <td className="py-2 px-2 text-right text-slate-400">#{tr.block_number}</td>
                        <td className="py-2 pl-2 text-right">
                          <button
                            type="button"
                            onClick={() => onInspectTx(tr.transaction_hash)}
                            className="text-[#46a6ff] hover:underline"
                          >
                            {shortAddress(tr.transaction_hash, 6, 4)}
                          </button>
                        </td>
                      </tr>
                    ))}
                    {data.transfers.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-8 text-center font-sans text-slate-400">
                          No deposits or withdrawals recorded.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
