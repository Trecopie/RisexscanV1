import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import type { SyncDiagnosticReport, SyncDiagnosticStatus } from '../types/risex';
import {
  formatDateTime,
  formatNumber,
  formatPrice,
  formatSignedUsd,
  formatTimeShort,
  formatUsd,
  shortAddress,
} from '../utils/format';
import { TraderAvatar } from './TraderAvatar';

const PRESET_TRADERS = ['sqalf', 'tbsp', 'GCR', 'yeff'];

function statusMeta(status: SyncDiagnosticStatus): {
  label: string;
  badgeClass: string;
  borderClass: string;
} {
  switch (status) {
    case 'SYNCED':
      return {
        label: 'SYNCED',
        badgeClass: 'bg-[#22e0a1]/15 text-[#22e0a1] border-[#22e0a1]/40',
        borderClass: 'border-[#22e0a1]/35',
      };
    case 'POST_HOUR_ACTIVITY':
      return {
        label: 'POST-HOUR ACTIVITY',
        badgeClass: 'bg-[#46a6ff]/15 text-[#46a6ff] border-[#46a6ff]/40',
        borderClass: 'border-[#46a6ff]/35',
      };
    case 'STALE_SNAPSHOT':
      return {
        label: 'STALE SNAPSHOT',
        badgeClass: 'bg-[#ffb02e]/15 text-[#ffb02e] border-[#ffb02e]/40',
        borderClass: 'border-[#ffb02e]/40',
      };
    case 'UNENRICHED':
      return {
        label: 'UNENRICHED',
        badgeClass: 'bg-[#ff4d6d]/15 text-[#ff4d6d] border-[#ff4d6d]/40',
        borderClass: 'border-[#ff4d6d]/40',
      };
    case 'NOT_IN_INDEX':
      return {
        label: 'NOT IN INDEX',
        badgeClass: 'bg-[#ff4d6d]/15 text-[#ff4d6d] border-[#ff4d6d]/40',
        borderClass: 'border-[#ff4d6d]/40',
      };
  }
}

function formatAge(sec: number | null): string {
  if (sec === null) return 'Never enriched';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s ago`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m ago`;
}

export const LeaderboardSyncDiagnostic: React.FC<{
  targetTrader: string;
  onTargetChange: (query: string) => void;
  onClose: () => void;
  onSelectWallet: (address: string) => void;
  onResynced?: () => void;
}> = ({ targetTrader, onTargetChange, onClose, onSelectWallet, onResynced }) => {
  const [input, setInput] = useState(targetTrader || 'sqalf');
  const [report, setReport] = useState<(SyncDiagnosticReport & { resynced?: boolean }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamTab, setStreamTab] = useState<'realized' | 'trades' | 'onchain'>('realized');
  const controllerRef = useRef<AbortController | null>(null);

  const runDiagnostic = async (query: string, resync = false) => {
    const q = query.trim();
    if (!q) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    if (resync) setResyncing(true);
    else setLoading(true);
    setError(null);

    try {
      const url = `/api/leaderboard/diagnostic/${encodeURIComponent(q)}${resync ? '?resync=1' : ''}`;
      const res = await fetch(url, { signal: controller.signal });
      const json = await res.json();
      if (!res.ok || json.error) {
        throw new Error(json.error || `Diagnostic failed (${res.status})`);
      }
      setReport(json);
      if (resync && json.resynced && onResynced) {
        onResynced();
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      setError(err.message || 'Failed to inspect trader synchronization');
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setResyncing(false);
      }
    }
  };

  useEffect(() => {
    const q = targetTrader || 'sqalf';
    setInput(q);
    runDiagnostic(q, false);
    return () => controllerRef.current?.abort();
  }, [targetTrader]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = input.trim();
    if (!q) return;
    if (q !== targetTrader) {
      onTargetChange(q);
    } else {
      runDiagnostic(q, false);
    }
  };

  const meta = report ? statusMeta(report.status) : null;

  return (
    <section
      aria-label="Leaderboard Sync Diagnostic"
      className="sunrise-card rounded-2xl border border-slate-700/70 bg-[#090e1a] p-4 sm:p-5 space-y-4"
    >
      {/* Top Diagnostic Header & Query Controls */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-[#46a6ff]">
            <Activity className="h-3.5 w-3.5" />
            Leaderboard Snapshot vs Live Event Log Diagnostic
          </div>
          <h2 className="mt-0.5 font-display text-base font-bold text-[#e8edfb]">
            Inspect Real-Time PnL Streams, Hourly Buckets &amp; Sync Drift
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            {PRESET_TRADERS.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => {
                  setInput(name);
                  if (name !== targetTrader) onTargetChange(name);
                  else runDiagnostic(name, false);
                }}
                className={`rounded-md border px-2 py-1 text-[11px] font-mono transition-colors ${
                  targetTrader.toLowerCase() === name.toLowerCase()
                    ? 'border-[#ffb02e]/60 bg-[#ffb02e]/15 text-[#ffb02e]'
                    : 'border-slate-800 bg-[#05070d] text-slate-400 hover:text-[#e8edfb]'
                }`}
              >
                {name}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="flex items-center gap-1.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Username or 0x wallet…"
                aria-label="Trader username or wallet address for diagnostic"
                className="w-48 rounded-lg border border-slate-700/60 bg-[#05070d] py-1.5 pl-8 pr-2.5 text-xs font-mono text-[#e8edfb] placeholder:text-slate-500 focus:border-[#ffb02e] focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={loading || resyncing}
              className="sunrise-gradient-btn rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
            >
              Audit
            </button>
          </form>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close Sync Diagnostic"
            className="rounded-lg border border-slate-800 bg-[#05070d] p-1.5 text-slate-400 hover:border-slate-700 hover:text-[#e8edfb]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Loading & Error States */}
      {loading && !report && (
        <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-[#05070d] p-4 text-xs font-mono text-[#ffb02e]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Querying cached snapshot, live realized-PnL event stream &amp; RISE Blockscout transactions…
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-[#ff4d6d]/40 bg-[#ff4d6d]/10 px-4 py-3 text-xs text-[#ff4d6d]">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => runDiagnostic(input, false)}
            className="rounded-md border border-[#ff4d6d]/40 px-2.5 py-1 font-mono text-[11px] hover:bg-[#ff4d6d]/20"
          >
            Retry
          </button>
        </div>
      )}

      {report && meta && (
        <div className={`space-y-4 ${loading ? 'opacity-70 transition-opacity' : ''}`}>
          {/* Identity & Status Banner */}
          <div
            className={`flex flex-col gap-3 rounded-xl border bg-[#05070d] p-3.5 md:flex-row md:items-center md:justify-between ${meta.borderClass}`}
          >
            <div className="flex items-start gap-3 min-w-0">
              <TraderAvatar
                address={report.resolvedAddress}
                avatarUrl={report.avatarUrl}
                username={report.username}
                size={36}
              />
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-sm font-bold text-[#e8edfb]">
                    {report.username || shortAddress(report.resolvedAddress, 8, 6)}
                  </span>
                  <span
                    className={`rounded border px-2 py-0.5 text-[10px] font-mono font-bold ${meta.badgeClass}`}
                  >
                    {meta.label}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[11px] font-mono text-slate-400">
                    <Clock className="h-3 w-3" />
                    Snapshot: {formatAge(report.snapshot.snapshotAgeSec)}
                  </span>
                  {report.resynced && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-mono text-[#22e0a1]">
                      <CheckCircle2 className="h-3 w-3" /> Re-synced
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-slate-500">
                  <span>{report.resolvedAddress}</span>
                  <span>·</span>
                  <span>
                    Sources:{' '}
                    <strong className="text-slate-300">
                      {report.snapshot.sources.length > 0 ? report.snapshot.sources.join(', ') : 'none'}
                    </strong>
                  </span>
                </div>

                <ul className="space-y-0.5 pt-0.5 text-xs text-slate-300">
                  {report.reasons.map((r, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[#ffb02e]" />
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => runDiagnostic(report.resolvedAddress, true)}
                disabled={resyncing || loading}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#ffb02e]/50 bg-[#ffb02e]/12 px-3 py-1.5 text-xs font-mono font-semibold text-[#ffb02e] hover:bg-[#ffb02e]/20 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${resyncing ? 'animate-spin' : ''}`} />
                {resyncing ? 'Syncing…' : 'Re-sync Snapshot'}
              </button>
              <button
                type="button"
                onClick={() => onSelectWallet(report.resolvedAddress)}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-[#0e1526] px-3 py-1.5 text-xs font-medium text-[#e8edfb] hover:border-slate-500"
              >
                Full Wallet
                <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Snapshot vs Live Comparison Table */}
          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-[#05070d]">
            <table className="w-full text-left text-xs font-mono tabular-nums">
              <thead className="border-b border-slate-800 bg-[#070b14] text-[10px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="py-2.5 pl-3.5 pr-2">Metric</th>
                  <th className="py-2.5 px-2 text-right">Cached Snapshot</th>
                  <th className="py-2.5 px-2 text-right">Live Hourly / API</th>
                  <th className="py-2.5 px-2 text-right">Live 24h Event Log</th>
                  <th className="py-2.5 pl-2 pr-3.5 text-right">Sync Drift (Cache − Live)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                <tr>
                  <td className="py-2 pl-3.5 pr-2 font-sans font-semibold text-slate-200">24h PnL</td>
                  <td className="py-2 px-2 text-right text-slate-200">
                    {report.snapshot.pnl24h !== null ? formatSignedUsd(report.snapshot.pnl24h) : '—'}
                  </td>
                  <td className="py-2 px-2 text-right text-[#e8edfb]">
                    {formatSignedUsd(report.live.recommended24hPnl)}
                    {report.live.chart1DPnl24h !== null && (
                      <div className="text-[10px] text-slate-500">
                        1D Chart ({report.live.chart1DPointsCount} pts): {formatSignedUsd(report.live.chart1DPnl24h)}
                      </div>
                    )}
                  </td>
                  <td className="py-2 px-2 text-right text-[#e8edfb]">
                    {formatSignedUsd(report.live.events24hNetPnl)}
                    <div className="text-[10px] text-slate-500">
                      {report.live.events24hCount} events
                      {report.live.postHourFillsCount > 0 && (
                        <span className="text-[#46a6ff]"> · +{report.live.postHourFillsCount} post-hr</span>
                      )}
                    </div>
                  </td>
                  <td
                    className={`py-2 pl-2 pr-3.5 text-right font-semibold ${
                      report.drift.drift24hVsRecommended === null
                        ? 'text-slate-500'
                        : Math.abs(report.drift.drift24hVsRecommended) > 25
                          ? 'text-[#ffb02e]'
                          : 'text-[#22e0a1]'
                    }`}
                  >
                    {report.drift.drift24hVsRecommended !== null
                      ? formatSignedUsd(report.drift.drift24hVsRecommended)
                      : 'UNSYNCED'}
                  </td>
                </tr>

                <tr>
                  <td className="py-2 pl-3.5 pr-2 font-sans font-semibold text-slate-200">7d / 30d PnL</td>
                  <td className="py-2 px-2 text-right text-slate-200">
                    {report.snapshot.pnl7d !== null ? formatSignedUsd(report.snapshot.pnl7d, true) : '—'} /{' '}
                    {report.snapshot.pnl30d !== null ? formatSignedUsd(report.snapshot.pnl30d, true) : '—'}
                  </td>
                  <td className="py-2 px-2 text-right text-[#e8edfb]">
                    {formatSignedUsd(report.live.calendar7dPnl, true)} /{' '}
                    {formatSignedUsd(report.live.calendar30dPnl, true)}
                  </td>
                  <td className="py-2 px-2 text-right text-slate-400">
                    Today UTC: {report.live.calendarTodayPnl !== null ? formatSignedUsd(report.live.calendarTodayPnl) : '—'}
                  </td>
                  <td
                    className={`py-2 pl-2 pr-3.5 text-right ${
                      report.drift.drift7dVsLive === null
                        ? 'text-slate-500'
                        : Math.abs(report.drift.drift7dVsLive) > 25
                          ? 'text-[#ffb02e]'
                          : 'text-[#22e0a1]'
                    }`}
                  >
                    {report.drift.drift7dVsLive !== null ? formatSignedUsd(report.drift.drift7dVsLive) : '—'}
                  </td>
                </tr>

                <tr>
                  <td className="py-2 pl-3.5 pr-2 font-sans font-semibold text-slate-200">
                    Realized / Unrealized / Total
                  </td>
                  <td className="py-2 px-2 text-right text-slate-200">
                    {formatSignedUsd(report.snapshot.totalPnlAll)}
                    <div className="text-[10px] text-slate-500">
                      Rz {formatSignedUsd(report.snapshot.realizedPnlAll, true)} · uPnL{' '}
                      {formatSignedUsd(report.snapshot.unrealizedPnl, true)}
                    </div>
                  </td>
                  <td className="py-2 px-2 text-right text-[#e8edfb]">
                    {formatSignedUsd(report.live.totalPnlAll)}
                    <div className="text-[10px] text-slate-500">
                      Rz {formatSignedUsd(report.live.realizedPnlAll, true)} · uPnL{' '}
                      {formatSignedUsd(report.live.unrealizedPnl, true)}
                    </div>
                  </td>
                  <td className="py-2 px-2 text-right text-slate-400">
                    {report.live.postHourFillsCount > 0
                      ? `Post-hr net ${formatSignedUsd(report.live.postHourFillsNetPnl)}`
                      : 'No post-hour fills'}
                  </td>
                  <td
                    className={`py-2 pl-2 pr-3.5 text-right font-semibold ${
                      report.drift.driftTotalAllVsLive === null
                        ? 'text-slate-500'
                        : Math.abs(report.drift.driftTotalAllVsLive) > 25
                          ? 'text-[#ffb02e]'
                          : 'text-[#22e0a1]'
                    }`}
                  >
                    {report.drift.driftTotalAllVsLive !== null
                      ? formatSignedUsd(report.drift.driftTotalAllVsLive)
                      : '—'}
                  </td>
                </tr>

                <tr>
                  <td className="py-2 pl-3.5 pr-2 font-sans font-semibold text-slate-200">
                    Account Value &amp; Open Pos
                  </td>
                  <td className="py-2 px-2 text-right text-slate-200">
                    {report.snapshot.accountValue > 0 ? formatUsd(report.snapshot.accountValue) : '—'} (
                    {report.snapshot.openPositionsCount} pos)
                  </td>
                  <td className="py-2 px-2 text-right text-[#e8edfb]">
                    {formatUsd(report.live.accountValue)} ({report.live.openPositionsCount} pos)
                  </td>
                  <td className="py-2 px-2 text-right text-slate-400">
                    {report.live.realizedStreamTruncated ? 'Stream >=2,000 events' : 'Full 24h log captured'}
                  </td>
                  <td className="py-2 pl-2 pr-3.5 text-right text-slate-400">
                    {formatSignedUsd(report.snapshot.accountValue - report.live.accountValue)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Live Event Logs / Trade Fills / On-Chain Txs */}
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#05070d] p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setStreamTab('realized')}
                  className={`rounded-md px-2.5 py-1 font-mono ${
                    streamTab === 'realized' ? 'bg-[#131c31] text-[#ffb02e]' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Realized-PnL Events ({report.recentRealizedEvents.length})
                </button>
                <button
                  type="button"
                  onClick={() => setStreamTab('trades')}
                  className={`rounded-md px-2.5 py-1 font-mono ${
                    streamTab === 'trades' ? 'bg-[#131c31] text-[#ffb02e]' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Recent Fills ({report.recentTrades.length})
                </button>
                <button
                  type="button"
                  onClick={() => setStreamTab('onchain')}
                  className={`rounded-md px-2.5 py-1 font-mono ${
                    streamTab === 'onchain' ? 'bg-[#131c31] text-[#ffb02e]' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  RISE Chain Txs ({report.recentOnChainTxs.length})
                </button>
              </div>
              {report.live.chart1DLastTsMs && (
                <span className="text-[11px] font-mono text-slate-500">
                  Latest 1D Chart Bucket: {formatDateTime(report.live.chart1DLastTsMs)}
                </span>
              )}
            </div>

            {streamTab === 'realized' && (
              <div className="max-h-64 overflow-auto rounded-xl border border-slate-800 bg-[#05070d]">
                <table className="w-full text-left text-xs font-mono tabular-nums">
                  <thead className="sticky top-0 border-b border-slate-800 bg-[#070b14] text-[10px] uppercase text-slate-400">
                    <tr>
                      <th className="py-2 pl-3 pr-2">Timestamp</th>
                      <th className="py-2 px-2">Market</th>
                      <th className="py-2 px-2">Side</th>
                      <th className="py-2 px-2 text-right">Size</th>
                      <th className="py-2 px-2 text-right">Entry → Exit</th>
                      <th className="py-2 px-2 text-right">Funding</th>
                      <th className="py-2 px-2 text-right">Net PnL</th>
                      <th className="py-2 pl-2 pr-3 text-right">Window</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {report.recentRealizedEvents.map((ev, i) => (
                      <tr key={`${ev.timestampMs}-${ev.marketId}-${i}`} className="hover:bg-[#0e1526]/70">
                        <td className="py-1.5 pl-3 pr-2 text-slate-400">{formatDateTime(ev.timestampMs)}</td>
                        <td className="py-1.5 px-2 font-sans font-medium text-[#e8edfb]">{ev.marketName}</td>
                        <td
                          className={`py-1.5 px-2 font-semibold ${
                            ev.side.includes('LONG') || ev.side.includes('BUY') ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                          }`}
                        >
                          {ev.side}
                        </td>
                        <td className="py-1.5 px-2 text-right text-slate-300">{formatNumber(ev.size, 4)}</td>
                        <td className="py-1.5 px-2 text-right text-slate-400">
                          {formatPrice(ev.entryPrice)} → {formatPrice(ev.exitPrice)}
                        </td>
                        <td
                          className={`py-1.5 px-2 text-right ${
                            ev.funding >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                          }`}
                        >
                          {formatSignedUsd(ev.funding)}
                        </td>
                        <td
                          className={`py-1.5 px-2 text-right font-semibold ${
                            ev.netPnl >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                          }`}
                        >
                          {formatSignedUsd(ev.netPnl)}
                        </td>
                        <td className="py-1.5 pl-2 pr-3 text-right">
                          {ev.afterLastChartBucket ? (
                            <span className="rounded bg-[#46a6ff]/15 px-1.5 py-0.5 text-[10px] text-[#46a6ff]">
                              POST-HR
                            </span>
                          ) : ev.within24h ? (
                            <span className="rounded bg-[#22e0a1]/15 px-1.5 py-0.5 text-[10px] text-[#22e0a1]">
                              24H
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-500">OLDER</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {report.recentRealizedEvents.length === 0 && (
                      <tr>
                        <td colSpan={8} className="py-6 text-center font-sans text-slate-400">
                          No realized-PnL settlement events returned for this wallet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {streamTab === 'trades' && (
              <div className="max-h-64 overflow-auto rounded-xl border border-slate-800 bg-[#05070d]">
                <table className="w-full text-left text-xs font-mono tabular-nums">
                  <thead className="sticky top-0 border-b border-slate-800 bg-[#070b14] text-[10px] uppercase text-slate-400">
                    <tr>
                      <th className="py-2 pl-3 pr-2">Time</th>
                      <th className="py-2 px-2">Market</th>
                      <th className="py-2 px-2">Side</th>
                      <th className="py-2 px-2 text-right">Price</th>
                      <th className="py-2 px-2 text-right">Size</th>
                      <th className="py-2 px-2 text-right">Fee</th>
                      <th className="py-2 pl-2 pr-3 text-right">Settlement Tx</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {report.recentTrades.map((tr, i) => (
                      <tr key={`${tr.id}-${i}`} className="hover:bg-[#0e1526]/70">
                        <td className="py-1.5 pl-3 pr-2 text-slate-400">{formatDateTime(tr.timeMs)}</td>
                        <td className="py-1.5 px-2 font-sans font-medium text-[#e8edfb]">{tr.marketName}</td>
                        <td className={tr.side.includes('BUY') || tr.side === '0' ? 'py-1.5 px-2 text-[#22e0a1]' : 'py-1.5 px-2 text-[#ff4d6d]'}>
                          {tr.side === '0' ? 'BUY' : tr.side === '1' ? 'SELL' : tr.side}
                        </td>
                        <td className="py-1.5 px-2 text-right text-slate-200">{formatPrice(tr.price)}</td>
                        <td className="py-1.5 px-2 text-right text-slate-300">{formatNumber(tr.size, 4)}</td>
                        <td className="py-1.5 px-2 text-right text-slate-400">{formatUsd(tr.fee)}</td>
                        <td className="py-1.5 pl-2 pr-3 text-right">
                          {tr.txHash ? (
                            <a
                              href={`https://explorer.risechain.com/tx/${tr.txHash}`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-[#46a6ff] hover:underline"
                            >
                              {shortAddress(tr.txHash, 6, 4)}
                              <ExternalLink className="h-2.5 w-2.5" />
                            </a>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    ))}
                    {report.recentTrades.length === 0 && (
                      <tr>
                        <td colSpan={7} className="py-6 text-center font-sans text-slate-400">
                          No recent execution fills found for this wallet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {streamTab === 'onchain' && (
              <div className="max-h-64 overflow-auto rounded-xl border border-slate-800 bg-[#05070d]">
                <table className="w-full text-left text-xs font-mono tabular-nums">
                  <thead className="sticky top-0 border-b border-slate-800 bg-[#070b14] text-[10px] uppercase text-slate-400">
                    <tr>
                      <th className="py-2 pl-3 pr-2">Time</th>
                      <th className="py-2 px-2">Tx Hash</th>
                      <th className="py-2 px-2">Method</th>
                      <th className="py-2 px-2">Target Contract</th>
                      <th className="py-2 px-2 text-right">Block</th>
                      <th className="py-2 pl-2 pr-3 text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {report.recentOnChainTxs.map((tx) => (
                      <tr key={tx.hash} className="hover:bg-[#0e1526]/70">
                        <td className="py-1.5 pl-3 pr-2 text-slate-400">{formatTimeShort(tx.timestamp)}</td>
                        <td className="py-1.5 px-2">
                          <a
                            href={`https://explorer.risechain.com/tx/${tx.hash}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-[#46a6ff] hover:underline"
                          >
                            {shortAddress(tx.hash, 8, 6)}
                            <ExternalLink className="h-2.5 w-2.5" />
                          </a>
                        </td>
                        <td className="py-1.5 px-2 text-[#ffb02e]">{tx.method}</td>
                        <td className="py-1.5 px-2 text-slate-300">
                          {tx.toName || (tx.toAddress ? shortAddress(tx.toAddress, 6, 4) : '—')}
                        </td>
                        <td className="py-1.5 px-2 text-right text-slate-400">#{tx.blockNumber.toLocaleString()}</td>
                        <td className="py-1.5 pl-2 pr-3 text-right">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] ${
                              tx.status === 'ok' ? 'bg-[#22e0a1]/15 text-[#22e0a1]' : 'bg-[#ff4d6d]/15 text-[#ff4d6d]'
                            }`}
                          >
                            {tx.status.toUpperCase()}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {report.recentOnChainTxs.length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-6 text-center font-sans text-slate-400">
                          No direct EOA transactions found (wallet likely uses session/operator relayer).
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
