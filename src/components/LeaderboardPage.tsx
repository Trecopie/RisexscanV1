import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownUp,
  Crown,
  ExternalLink,
  Eye,
  Filter,
  Loader2,
  Search,
  Trophy,
} from 'lucide-react';
import type { IndexedTrader, LeaderboardResponse, TimeframeKey } from '../types/risex';
import { formatPct, formatSignedUsd, formatUsd, shortAddress } from '../utils/format';
import { TraderAvatar } from './TraderAvatar';

type SortKey =
  | 'pnl'
  | 'realized'
  | 'unrealized'
  | 'roi'
  | 'accountValue'
  | 'volume'
  | 'winRate'
  | 'sharpe';

type CohortFilter = 'all' | 'enriched' | 'positions' | 'whales' | 'profitable';

export const LeaderboardPage: React.FC<{
  onSelectWallet: (address: string) => void;
  onPeekTrader: (address: string, trader?: IndexedTrader) => void;
}> = ({ onSelectWallet, onPeekTrader }) => {
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [timeframe, setTimeframe] = useState<TimeframeKey>('all');
  const [cohort, setCohort] = useState<CohortFilter>('all');
  const [sortBy, setSortBy] = useState<SortKey>('pnl');
  const [sortDesc, setSortDesc] = useState(true);
  const [search, setSearch] = useState('');
  const [pageSize, setPageSize] = useState(50);

  const loadLeaderboard = () => {
    fetch('/api/leaderboard')
      .then((r) => r.json())
      .then((d: LeaderboardResponse) => {
        if (d?.traders) setData(d);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadLeaderboard();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadLeaderboard();
      }
    }, 15000);
    return () => clearInterval(t);
  }, []);

  const getPeriodPnl = (t: IndexedTrader): number => {
    if (timeframe === '24h') return t.pnl24h ?? 0;
    if (timeframe === '7d') return t.pnl7d ?? 0;
    if (timeframe === '30d') return t.pnl30d ?? 0;
    return t.totalPnlAll;
  };

  const getPeriodRoi = (t: IndexedTrader): number | null => {
    if (timeframe === '24h') return t.roi24hPct;
    if (timeframe === '7d') return t.roi7dPct;
    if (timeframe === '30d') return t.roi30dPct;
    return t.roiAllPct;
  };

  const getPeriodVol = (t: IndexedTrader): number => {
    if (timeframe === '24h') return t.volume24h;
    if (timeframe === '7d') return t.volume7d;
    if (timeframe === '30d') return t.volume30d;
    return t.volumeAll;
  };

  const filteredAndSorted = useMemo(() => {
    const raw = data?.traders || [];
    const q = search.trim().toLowerCase();

    const filtered = raw.filter((t) => {
      if (q) {
        const hitAddr = t.address.toLowerCase().includes(q);
        const hitUser = t.username?.toLowerCase().includes(q);
        const hitX = t.xHandle?.toLowerCase().includes(q);
        if (!hitAddr && !hitUser && !hitX) return false;
      }
      if (cohort === 'enriched' && !t.portfolioEnriched) return false;
      if (cohort === 'positions' && t.openPositionsCount === 0) return false;
      if (cohort === 'whales' && t.accountValue < 10000) return false;
      if (cohort === 'profitable' && getPeriodPnl(t) <= 0) return false;
      return true;
    });

    const getVal = (t: IndexedTrader): number => {
      switch (sortBy) {
        case 'pnl':
          return getPeriodPnl(t);
        case 'realized':
          return t.realizedPnlAll;
        case 'unrealized':
          return t.unrealizedPnl;
        case 'roi':
          return getPeriodRoi(t) ?? -999999;
        case 'accountValue':
          return t.accountValue;
        case 'volume':
          return getPeriodVol(t);
        case 'winRate':
          return t.winRate ?? -1;
        case 'sharpe':
          return t.sharpeRatio ?? -999;
      }
    };

    return [...filtered].sort((a, b) => {
      const av = getVal(a);
      const bv = getVal(b);
      return sortDesc ? bv - av : av - bv;
    });
  }, [data, search, cohort, sortBy, sortDesc, timeframe]);

  const toggleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDesc((d) => !d);
    } else {
      setSortBy(key);
      setSortDesc(true);
    }
  };

  const podiumTraders = filteredAndSorted.slice(0, 3);
  const podiumOrder =
    podiumTraders.length === 3
      ? [
          { trader: podiumTraders[1], rank: 2 },
          { trader: podiumTraders[0], rank: 1 },
          { trader: podiumTraders[2], rank: 3 },
        ]
      : podiumTraders.map((trader, idx) => ({ trader, rank: idx + 1 }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-mono text-[#ffb02e]">
            <Trophy className="h-3.5 w-3.5" />
            RISEx SMART-MONEY LEADERBOARD
          </div>
          <h1 className="mt-1 font-display text-2xl sm:text-3xl font-bold text-[#e8edfb]">
            Traders by PnL, ROI & Realized Performance
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            Showing RISEx account usernames where set ·{' '}
            <span className="font-mono text-slate-200">{data?.totalDiscovered?.toLocaleString() || 0}</span> discovered ·{' '}
            <span className="font-mono text-[#22e0a1]">{data?.totalEnriched?.toLocaleString() || 0}</span> full portfolios enriched
            {data?.indexingInProgress && (
              <span className="ml-2 inline-flex items-center gap-1 text-[#ffb02e]">
                <Loader2 className="h-3 w-3 animate-spin" /> indexing live…
              </span>
            )}
          </p>
        </div>

        {/* Timeframe Switcher */}
        <div className="flex items-center gap-1 rounded-xl border border-slate-700/50 bg-[#090e1a] p-1">
          {(['24h', '7d', '30d', 'all'] as TimeframeKey[]).map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => setTimeframe(tf)}
              className={`rounded-lg px-3 py-1.5 text-xs font-mono font-semibold uppercase transition-all ${
                timeframe === tf
                  ? 'sunrise-gradient-btn'
                  : 'text-slate-400 hover:text-[#e8edfb]'
              }`}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      {/* Top 3 Podium */}
      {!loading && podiumOrder.length > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3 md:items-end">
          {podiumOrder.map(({ trader, rank }) => {
            const periodPnl = getPeriodPnl(trader);
            const periodRoi = getPeriodRoi(trader);
            const isFirst = rank === 1;
            return (
              <div
                key={trader.address}
                onClick={() => onSelectWallet(trader.address)}
                className={`sunrise-card cursor-pointer rounded-2xl p-5 transition-all hover:translate-y-[-2px] ${
                  rank === 1 ? 'order-1 md:order-2' : rank === 2 ? 'order-2 md:order-1' : 'order-3'
                } ${
                  isFirst
                    ? 'border-[#ffb02e]/60 shadow-[0_0_32px_rgba(255,176,46,0.14)] md:pb-7'
                    : 'border-slate-700/45'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <TraderAvatar
                      address={trader.address}
                      avatarUrl={trader.avatarUrl}
                      username={trader.username}
                      size={isFirst ? 44 : 38}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono font-bold ${
                            rank === 1
                              ? 'bg-[#ffb02e]/20 text-[#ffb02e]'
                              : rank === 2
                                ? 'bg-slate-400/20 text-slate-200'
                                : 'bg-[#ff6a3d]/20 text-[#ff6a3d]'
                          }`}
                        >
                          {rank === 1 && <Crown className="h-3 w-3" />}
                          #{rank}
                        </span>
                        <span className="truncate font-display text-base font-bold text-[#e8edfb]">
                          {trader.username || shortAddress(trader.address)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] font-mono text-slate-400">
                        <span>{shortAddress(trader.address, 6, 4)}</span>
                        {trader.xHandle && (
                          <span className="text-[#46a6ff]">@{trader.xHandle}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPeekTrader(trader.address, trader);
                    }}
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-[#ffb02e]"
                    title="Quick Peek"
                  >
                    <Eye className="h-4 w-4" />
                  </button>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2 border-t border-slate-800/70 pt-3 font-mono tabular-nums">
                  <div>
                    <div className="text-[10px] uppercase text-slate-500">{timeframe.toUpperCase()} PnL</div>
                    <div className={`text-sm font-bold ${periodPnl >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}`}>
                      {formatSignedUsd(periodPnl, true)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase text-slate-500">ROI</div>
                    <div className={`text-sm font-semibold ${(periodRoi ?? 0) >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}`}>
                      {periodRoi !== null ? formatPct(periodRoi) : '—'}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] uppercase text-slate-500">Acct Value</div>
                    <div className="text-sm font-semibold text-[#e8edfb]">
                      {trader.accountValue > 0 ? formatUsd(trader.accountValue, true) : '—'}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Controls Bar */}
      <div className="sunrise-card flex flex-col gap-3 rounded-2xl p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 inline-flex items-center gap-1 text-xs text-slate-400">
            <Filter className="h-3.5 w-3.5" /> Cohort:
          </span>
          {(
            [
              { id: 'all', label: 'All Discovered' },
              { id: 'enriched', label: 'Full Portfolios' },
              { id: 'positions', label: 'Active Positions' },
              { id: 'whales', label: 'Whales ($10K+)' },
              { id: 'profitable', label: 'Profitable' },
            ] as { id: CohortFilter; label: string }[]
          ).map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCohort(c.id)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                cohort === c.id
                  ? 'bg-[#ffb02e]/15 text-[#ffb02e] border border-[#ffb02e]/40'
                  : 'bg-[#090e1a] text-slate-400 border border-slate-800 hover:text-slate-200'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter RISEx username or 0x…"
              className="w-full rounded-xl border border-slate-700/60 bg-[#090e1a] py-1.5 pl-8 pr-3 text-xs text-[#e8edfb] placeholder:text-slate-500 focus:border-[#ffb02e] focus:outline-none"
            />
          </div>
          <select
            value={sortBy}
            onChange={(e) => {
              setSortBy(e.target.value as SortKey);
              setSortDesc(true);
            }}
            className="rounded-xl border border-slate-700/60 bg-[#090e1a] px-3 py-1.5 text-xs text-[#e8edfb] focus:border-[#ffb02e] focus:outline-none"
          >
            <option value="pnl">Sort: {timeframe.toUpperCase()} PnL</option>
            <option value="realized">Sort: Realized PnL</option>
            <option value="unrealized">Sort: Unrealized PnL</option>
            <option value="roi">Sort: ROI %</option>
            <option value="accountValue">Sort: Account Value</option>
            <option value="volume">Sort: Volume</option>
            <option value="winRate">Sort: Win Rate</option>
            <option value="sharpe">Sort: Sharpe Ratio</option>
          </select>
        </div>
      </div>

      {/* Main Table */}
      <div className="sunrise-card overflow-hidden rounded-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-800/90 bg-[#090e1a]/80 text-[11px] uppercase tracking-wider text-slate-400">
              <tr>
                <th className="py-3 pl-4 pr-2">Rank</th>
                <th className="py-3 px-2">RISEx Trader</th>
                <th className="py-3 px-2 text-right cursor-pointer hover:text-[#ffb02e]" onClick={() => toggleSort('accountValue')}>
                  <span className="inline-flex items-center gap-1">Acct Value <ArrowDownUp className="h-3 w-3" /></span>
                </th>
                <th className="py-3 px-2 text-right cursor-pointer hover:text-[#ffb02e]" onClick={() => toggleSort('realized')}>
                  <span className="inline-flex items-center gap-1">Realized PnL <ArrowDownUp className="h-3 w-3" /></span>
                </th>
                <th className="py-3 px-2 text-right cursor-pointer hover:text-[#ffb02e]" onClick={() => toggleSort('unrealized')}>
                  <span className="inline-flex items-center gap-1">Unrealized <ArrowDownUp className="h-3 w-3" /></span>
                </th>
                <th className="py-3 px-2 text-right cursor-pointer hover:text-[#ffb02e]" onClick={() => toggleSort('pnl')}>
                  <span className="inline-flex items-center gap-1">{timeframe.toUpperCase()} PnL <ArrowDownUp className="h-3 w-3" /></span>
                </th>
                <th className="py-3 px-2 text-right cursor-pointer hover:text-[#ffb02e]" onClick={() => toggleSort('roi')}>
                  <span className="inline-flex items-center gap-1">ROI % <ArrowDownUp className="h-3 w-3" /></span>
                </th>
                <th className="py-3 px-2 text-right cursor-pointer hover:text-[#ffb02e]" onClick={() => toggleSort('volume')}>
                  <span className="inline-flex items-center gap-1">Volume <ArrowDownUp className="h-3 w-3" /></span>
                </th>
                <th className="py-3 px-2 text-right cursor-pointer hover:text-[#ffb02e]" onClick={() => toggleSort('winRate')}>
                  Win %
                </th>
                <th className="py-3 px-2 text-center">Pos</th>
                <th className="py-3 pl-2 pr-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 tabular-nums">
              {loading && (
                <tr>
                  <td colSpan={11} className="py-12 text-center text-slate-400">
                    <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin text-[#ffb02e]" />
                    Indexing RISEx traders & usernames…
                  </td>
                </tr>
              )}
              {!loading &&
                filteredAndSorted.slice(0, pageSize).map((t, idx) => {
                  const periodPnl = getPeriodPnl(t);
                  const periodRoi = getPeriodRoi(t);
                  const periodVol = getPeriodVol(t);
                  return (
                    <tr
                      key={t.address}
                      onClick={() => onSelectWallet(t.address)}
                      className="cursor-pointer hover:bg-[#131c31]/70 transition-colors"
                    >
                      <td className="py-3 pl-4 pr-2 font-mono text-slate-400">#{idx + 1}</td>
                      <td className="py-3 px-2">
                        <div className="flex items-center gap-2.5">
                          <TraderAvatar
                            address={t.address}
                            avatarUrl={t.avatarUrl}
                            username={t.username}
                            size={28}
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate font-semibold text-[#e8edfb] max-w-[160px]">
                                {t.username || shortAddress(t.address)}
                              </span>
                              {t.xHandle && (
                                <a
                                  href={`https://x.com/${t.xHandle}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="inline-flex items-center gap-0.5 text-[10px] font-mono text-[#46a6ff] hover:underline"
                                >
                                  @{t.xHandle}
                                  <ExternalLink className="h-2.5 w-2.5" />
                                </a>
                              )}
                            </div>
                            <div className="font-mono text-[10px] text-slate-500">
                              {shortAddress(t.address, 8, 5)}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-2 text-right font-mono text-slate-200">
                        {t.accountValue > 0 ? formatUsd(t.accountValue, true) : '—'}
                      </td>
                      <td
                        className={`py-3 px-2 text-right font-mono font-medium ${
                          t.realizedPnlAll >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                        }`}
                      >
                        {formatSignedUsd(t.realizedPnlAll, true)}
                      </td>
                      <td
                        className={`py-3 px-2 text-right font-mono ${
                          t.unrealizedPnl > 0
                            ? 'text-[#22e0a1]'
                            : t.unrealizedPnl < 0
                              ? 'text-[#ff4d6d]'
                              : 'text-slate-500'
                        }`}
                      >
                        {t.portfolioEnriched ? formatSignedUsd(t.unrealizedPnl, true) : '—'}
                      </td>
                      <td
                        className={`py-3 px-2 text-right font-mono font-semibold ${
                          periodPnl >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                        }`}
                      >
                        {formatSignedUsd(periodPnl, true)}
                      </td>
                      <td
                        className={`py-3 px-2 text-right font-mono ${
                          (periodRoi ?? 0) >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                        }`}
                      >
                        {periodRoi !== null ? formatPct(periodRoi) : '—'}
                      </td>
                      <td className="py-3 px-2 text-right font-mono text-slate-300">
                        {periodVol > 0 ? formatUsd(periodVol, true) : '—'}
                      </td>
                      <td className="py-3 px-2 text-right font-mono text-slate-300">
                        {t.winRate !== null ? formatPct(t.winRate, false) : '—'}
                      </td>
                      <td className="py-3 px-2 text-center font-mono">
                        {t.openPositionsCount > 0 ? (
                          <span className="rounded bg-[#ffb02e]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#ffb02e]">
                            {t.openPositionsCount}
                          </span>
                        ) : (
                          <span className="text-slate-600">0</span>
                        )}
                      </td>
                      <td className="py-3 pl-2 pr-4 text-right">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onPeekTrader(t.address, t);
                          }}
                          className="rounded-lg border border-slate-700/60 bg-[#090e1a] p-1.5 text-slate-300 hover:border-[#ffb02e]/60 hover:text-[#ffb02e]"
                          title="Quick peek"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              {!loading && filteredAndSorted.length === 0 && (
                <tr>
                  <td colSpan={11} className="py-12 text-center text-slate-400">
                    No traders match the active search or cohort filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {filteredAndSorted.length > pageSize && (
          <div className="flex items-center justify-between border-t border-slate-800/80 px-4 py-3 text-xs text-slate-400">
            <span>
              Showing {Math.min(pageSize, filteredAndSorted.length)} of {filteredAndSorted.length} matching traders
            </span>
            <button
              type="button"
              onClick={() => setPageSize((p) => p + 50)}
              className="rounded-lg border border-slate-700 bg-[#090e1a] px-3 py-1.5 font-medium text-[#e8edfb] hover:border-[#ffb02e]"
            >
              Load 50 More
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
