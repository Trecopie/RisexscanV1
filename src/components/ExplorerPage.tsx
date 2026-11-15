import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Blocks,
  ExternalLink,
  Loader2,
  Percent,
  Search,
  ShieldAlert,
  Terminal,
} from 'lucide-react';
import type {
  ExplorerBlock,
  ExplorerTx,
  IndexedPositionRow,
  MarketTrade,
  RisexMarket,
  SystemConfig,
} from '../types/risex';
import {
  formatDateTime,
  formatNumber,
  formatPrice,
  formatSignedUsd,
  formatTimeShort,
  formatUsd,
  shortAddress,
} from '../utils/format';
import { CopyBtn, LiqDistanceBadge, TokenBadge, TraderAvatar } from './TraderAvatar';
import { useMarketStream } from '../context/MarketWebSocketContext';
import { deriveLiveLiquidationRisk, mergeExplorerTradeTape, type ExplorerRiskCandidate } from '../utils/explorerLive';

export type ExplorerSubTab = 'blocks' | 'trades' | 'liquidations' | 'funding' | 'decoder';

export const ExplorerPage: React.FC<{
  initialTxHash: string | null;
  onSelectWallet: (address: string) => void;
  onSelectMarket: (marketId: string) => void;
}> = ({ initialTxHash, onSelectWallet, onSelectMarket }) => {
  const { markets: streamedMarkets, recentTrades: socketTrades, connectionState } = useMarketStream();
  const [subTab, setSubTab] = useState<ExplorerSubTab>(initialTxHash ? 'decoder' : 'blocks');
  const [blocks, setBlocks] = useState<ExplorerBlock[]>([]);
  const [txs, setTxs] = useState<ExplorerTx[]>([]);
  const [systemConfig, setSystemConfig] = useState<SystemConfig | null>(null);
  const [recentTrades, setRecentTrades] = useState<MarketTrade[]>([]);
  const [riskCandidates, setRiskCandidates] = useState<ExplorerRiskCandidate[]>([]);
  const [chainHead, setChainHead] = useState<number | null>(null);
  const [explorerFetchedAt, setExplorerFetchedAt] = useState<number | null>(null);
  const [blocksAvailable, setBlocksAvailable] = useState(true);
  const [markets, setMarkets] = useState<RisexMarket[]>([]);
  const [loading, setLoading] = useState(true);

  const [txInput, setTxInput] = useState(initialTxHash || '');
  const [txResult, setTxResult] = useState<any>(null);
  const [txLoading, setTxLoading] = useState(false);

  const abortRef = React.useRef<AbortController | null>(null);
  const txAbortRef = React.useRef<AbortController | null>(null);

  const loadExplorer = async () => {
    // Keep an in-flight Blockscout request alive. Aborting it on each interval
    // made slow explorer responses appear permanently frozen.
    if (abortRef.current && !abortRef.current.signal.aborted) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const safeJson = async (url: string) => {
      const r = await fetch(url, { signal: controller.signal });
      if (!r.ok) return null;
      return r.json();
    };
    try {
      const [ovRes, trRes, liqRes, mkRes] = await Promise.allSettled([
        safeJson('/api/explorer/overview'),
        safeJson('/api/trades/recent'),
        safeJson('/api/liquidations'),
        safeJson('/api/markets'),
      ]);
      if (controller.signal.aborted) return;
      if (ovRes.status === 'fulfilled' && ovRes.value) {
        const overview = ovRes.value;
        if (overview.sourceStatus?.blocks === true && Array.isArray(overview.blocks)) {
          setBlocks(overview.blocks);
          setBlocksAvailable(true);
        } else if (overview.sourceStatus?.blocks === false) setBlocksAvailable(false);
        if (Array.isArray(overview.transactions) && overview.sourceStatus?.transactions !== false) setTxs(overview.transactions);
        if (overview.systemConfig) setSystemConfig(overview.systemConfig);
        if (typeof overview.chainHead === 'number') setChainHead(overview.chainHead);
        if (typeof overview.fetchedAt === 'number') setExplorerFetchedAt(overview.fetchedAt);
      }
      if (trRes.status === 'fulfilled' && trRes.value?.trades) setRecentTrades(trRes.value.trades);
      if (liqRes.status === 'fulfilled' && liqRes.value) {
        setRiskCandidates(liqRes.value.candidates || liqRes.value.atRisk || []);
      }
      if (mkRes.status === 'fulfilled' && mkRes.value?.markets) setMarkets(mkRes.value.markets);
    } catch {
      // ignore
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  useEffect(() => {
    loadExplorer();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadExplorer();
      }
    }, 8000);
    return () => {
      abortRef.current?.abort();
      txAbortRef.current?.abort();
      clearInterval(timer);
    };
  }, []);

  const inspectHash = async (hash: string) => {
    const clean = hash.trim();
    if (!clean) return;
    txAbortRef.current?.abort();
    const controller = new AbortController();
    txAbortRef.current = controller;
    setTxInput(clean);
    setSubTab('decoder');
    setTxLoading(true);
    try {
      const r = await fetch(`/api/explorer/tx/${encodeURIComponent(clean)}`, { signal: controller.signal });
      const res = await r.json();
      if (!controller.signal.aborted) setTxResult(res);
    } catch (err: any) {
      if (err?.name !== 'AbortError') setTxResult({ error: err.message });
    } finally {
      if (!controller.signal.aborted) setTxLoading(false);
    }
  };

  useEffect(() => {
    if (initialTxHash) {
      inspectHash(initialTxHash);
    }
  }, [initialTxHash]);

  const liveMarkets = streamedMarkets.length > 0 ? streamedMarkets : markets;
  const atRisk = useMemo(() => deriveLiveLiquidationRisk(riskCandidates, liveMarkets), [riskCandidates, liveMarkets]);
  const tradeTape = useMemo(() => mergeExplorerTradeTape(socketTrades, recentTrades), [socketTrades, recentTrades]);
  const indexedHead = Number(blocks[0]?.height || 0);
  const blockLag = chainHead !== null && indexedHead > 0 ? Math.max(0, chainHead - indexedHead) : null;

  const sortedFundingMarkets = [...liveMarkets].sort(
    (a, b) => Math.abs(Number(b.current_funding_rate || 0)) - Math.abs(Number(a.current_funding_rate || 0))
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-mono text-[#46a6ff]">
            <Blocks className="h-3.5 w-3.5" />
            RISE MAINNET · CHAIN ID {systemConfig?.chain?.chain_id || '4153'}
          </div>
          <h1 className="mt-1 font-display text-2xl sm:text-3xl font-bold text-[#e8edfb]">
            RISEx On-Chain Block & Risk Explorer
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] font-mono text-slate-400" aria-live="polite">
            <span className={connectionState === 'connected' ? 'text-[#22e0a1]' : 'text-[#ffb02e]'}>
              {connectionState === 'connected' ? '● Market trades live via WebSocket' : '○ Market stream reconnecting'}
            </span>
            {chainHead !== null && <span>· RPC head #{chainHead.toLocaleString()}</span>}
            {blockLag !== null && <span className={blockLag > 6 ? 'text-[#ffb02e]' : ''}>
              · Explorer index {blockLag} blocks behind
            </span>}
            {explorerFetchedAt !== null && <span>· Fetched {new Date(explorerFetchedAt).toLocaleTimeString()}</span>}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-800 bg-[#090e1a] p-1">
          {(
            [
              { id: 'blocks', label: 'Blocks & Txs', icon: <Blocks className="h-3.5 w-3.5" /> },
              { id: 'trades', label: 'Live Trades', icon: <Activity className="h-3.5 w-3.5" /> },
              { id: 'liquidations', label: `Liq Risk (${atRisk.length})`, icon: <ShieldAlert className="h-3.5 w-3.5" /> },
              { id: 'funding', label: 'Funding Rates', icon: <Percent className="h-3.5 w-3.5" /> },
              { id: 'decoder', label: 'Tx Decoder & Contracts', icon: <Terminal className="h-3.5 w-3.5" /> },
            ] as { id: ExplorerSubTab; label: string; icon: React.ReactNode }[]
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                subTab === t.id ? 'sunrise-gradient-btn font-semibold' : 'text-slate-400 hover:text-[#e8edfb]'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* SUBTAB 1: BLOCKS & TXS */}
      {subTab === 'blocks' && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          <div className="sunrise-card rounded-2xl p-4 lg:col-span-5">
            <h2 className="mb-3 font-display text-base font-bold text-[#e8edfb]">Latest RISE Blocks</h2>
            {!blocksAvailable && (
              <div className="mb-2 text-[11px] text-[#ffb02e]">Block explorer is temporarily unavailable; showing the last successful snapshot.</div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono tabular-nums">
                <thead className="border-b border-slate-800 text-[11px] uppercase text-slate-400">
                  <tr>
                    <th className="py-2 pr-2">Height</th>
                    <th className="py-2 px-2 text-right">Txs</th>
                    <th className="py-2 px-2 text-right">Gas Used</th>
                    <th className="py-2 pl-2 text-right">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {loading && (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-slate-400">
                        Loading blocks…
                      </td>
                    </tr>
                  )}
                  {blocks.map((b) => (
                    <tr key={b.height} className="hover:bg-[#131c31]/50">
                      <td className="py-2.5 pr-2 font-semibold text-[#46a6ff]">
                        <a
                          href={`https://explorer.risechain.com/block/${b.height}`}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline"
                        >
                          #{b.height.toLocaleString()}
                        </a>
                      </td>
                      <td className="py-2.5 px-2 text-right text-slate-200">
                        {b.transactions_count ?? b.tx_count ?? 0}
                      </td>
                      <td className="py-2.5 px-2 text-right text-slate-400">
                        {Number(b.gas_used || 0).toLocaleString()}
                      </td>
                      <td className="py-2.5 pl-2 text-right text-slate-400">{formatTimeShort(b.timestamp)}</td>
                    </tr>
                  ))}
                  {!loading && blocks.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-8 text-center font-sans text-slate-400">
                        No recent RISE blocks available.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="sunrise-card rounded-2xl p-4 lg:col-span-7">
            <h2 className="mb-3 font-display text-base font-bold text-[#e8edfb]">
              Recent RISEx Protocol Transactions
            </h2>
            <p className="mb-2 text-[11px] text-slate-400">
              Transactions touching monitored RISEx contracts; this list can stay unchanged even while new RISE blocks arrive.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono tabular-nums">
                <thead className="border-b border-slate-800 text-[11px] uppercase text-slate-400">
                  <tr>
                    <th className="py-2 pr-2">Tx Hash</th>
                    <th className="py-2 px-2">Method</th>
                    <th className="py-2 px-2">From Wallet</th>
                    <th className="py-2 px-2">Block</th>
                    <th className="py-2 pl-2 text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {txs.map((tx) => (
                    <tr key={tx.hash} className="hover:bg-[#131c31]/50">
                      <td className="py-2.5 pr-2">
                        <button
                          type="button"
                          onClick={() => inspectHash(tx.hash)}
                          className="text-[#46a6ff] hover:underline"
                        >
                          {shortAddress(tx.hash, 8, 6)}
                        </button>
                      </td>
                      <td className="py-2.5 px-2 text-[#ffb02e]">{tx.method || 'call'}</td>
                      <td className="py-2.5 px-2">
                        <button
                          type="button"
                          onClick={() => tx.from?.hash && onSelectWallet(tx.from.hash)}
                          className="text-slate-300 hover:text-[#ffb02e]"
                        >
                          {shortAddress(tx.from?.hash || '')}
                        </button>
                      </td>
                      <td className="py-2.5 px-2 text-slate-400">#{tx.block_number}</td>
                      <td className="py-2.5 pl-2 text-right">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] ${
                            tx.status === 'ok'
                              ? 'bg-[#22e0a1]/15 text-[#22e0a1]'
                              : 'bg-[#ff4d6d]/15 text-[#ff4d6d]'
                          }`}
                        >
                          {tx.status?.toUpperCase() || 'OK'}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {!loading && txs.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-8 text-center font-sans text-slate-400">
                        No recent protocol transactions found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* SUBTAB 2: LIVE TRADES */}
      {subTab === 'trades' && (
        <div className="sunrise-card overflow-hidden rounded-2xl p-4">
          <h2 className="mb-3 font-display text-base font-bold text-[#e8edfb]">
            Global RISEx Trade Tape ({tradeTape.length})
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono tabular-nums">
              <thead className="border-b border-slate-800 text-[11px] uppercase text-slate-400">
                <tr>
                  <th className="py-2 pr-2">Time</th>
                  <th className="py-2 px-2">Market</th>
                  <th className="py-2 px-2">Maker Side</th>
                  <th className="py-2 px-2 text-right">Price</th>
                  <th className="py-2 px-2 text-right">Size</th>
                  <th className="py-2 px-2 text-right">Notional</th>
                  <th className="py-2 pl-2 text-right">Block</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {tradeTape.map((tr, i) => {
                  const isBuy = tr.maker_side?.toLowerCase().includes('buy') || tr.maker_side === '0';
                  const usd = Number(tr.price) * Number(tr.size);
                  return (
                    <tr
                      key={`${tr.id}-${i}`}
                      onClick={() => tr.market_id && onSelectMarket(String(tr.market_id))}
                      className="cursor-pointer hover:bg-[#131c31]/60"
                    >
                      <td className="py-2 pr-2 text-slate-400">{formatTimeShort(tr.time)}</td>
                      <td className="py-2 px-2 font-sans font-semibold text-[#e8edfb]">
                        {tr.market_name || `MKT-${tr.market_id}`}
                      </td>
                      <td className={`py-2 px-2 font-semibold ${isBuy ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}`}>
                        {isBuy ? 'BUY' : 'SELL'}
                      </td>
                      <td className="py-2 px-2 text-right text-slate-200">{formatPrice(tr.price)}</td>
                      <td className="py-2 px-2 text-right text-slate-300">{formatNumber(tr.size, 4)}</td>
                      <td className="py-2 px-2 text-right text-[#ffb02e]">{formatUsd(usd, true)}</td>
                      <td className="py-2 pl-2 text-right text-slate-500">#{tr.block_number || '—'}</td>
                    </tr>
                  );
                })}
                {!loading && tradeTape.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-10 text-center font-sans text-slate-400">
                      No recent trades available right now.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUBTAB 3: LIQUIDATION RISK */}
      {subTab === 'liquidations' && (
        <div className="sunrise-card overflow-hidden rounded-2xl p-4">
          <div className="mb-3">
            <h2 className="font-display text-base font-bold text-[#e8edfb]">
              Positions Near Liquidation (&lt;5% Distance)
            </h2>
            <p className="text-xs text-slate-400">
              Uses live oracle mark prices, with cached indexed positions. Strictly less than 5% distance; account positions may lag the underlying indexer.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-800 text-[11px] uppercase text-slate-400">
                <tr>
                  <th className="py-2 pr-2">Trader</th>
                  <th className="py-2 px-2">Market</th>
                  <th className="py-2 px-2">Side</th>
                  <th className="py-2 px-2 text-right">Notional</th>
                  <th className="py-2 px-2 text-right">Mark Price</th>
                  <th className="py-2 px-2 text-right">Liq. Price</th>
                  <th className="py-2 px-2 text-right">Risk</th>
                  <th className="py-2 pl-2 text-right">Unrealized PnL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 tabular-nums">
                {atRisk.map((p, i) => (
                  <tr
                    key={`${p.address}-${p.marketId}-${i}`}
                    onClick={() => onSelectWallet(p.address)}
                    className="cursor-pointer hover:bg-[#131c31]/60"
                  >
                    <td className="py-2.5 pr-2">
                      <div className="flex items-center gap-2">
                        <TraderAvatar address={p.address} avatarUrl={p.avatarUrl} username={p.username} size={24} />
                        <div>
                          <div className="font-semibold text-[#e8edfb]">{p.username || shortAddress(p.address)}</div>
                          <div className="font-mono text-[10px] text-slate-500">{shortAddress(p.address)}</div>
                        </div>
                      </div>
                    </td>
                    <td
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectMarket(p.marketId);
                      }}
                      className="py-2.5 px-2 font-semibold text-[#ffb02e] hover:underline"
                    >
                      {p.marketName}
                    </td>
                    <td className="py-2.5 px-2 font-mono">
                      <span className={p.side === 'LONG' ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}>
                        {p.side} {p.leverage.toFixed(1)}x
                      </span>
                    </td>
                    <td className="py-2.5 px-2 text-right font-mono text-slate-200">{formatUsd(p.notionalUsd, true)}</td>
                    <td className="py-2.5 px-2 text-right font-mono text-slate-300">{formatPrice(p.markPrice)}</td>
                    <td className="py-2.5 px-2 text-right font-mono text-[#ff4d6d]">{formatPrice(p.liquidationPrice)}</td>
                    <td className="py-2.5 px-2 text-right">
                      <LiqDistanceBadge markPrice={p.markPrice} liquidationPrice={p.liquidationPrice} side={p.side} />
                    </td>
                    <td className={`py-2.5 pl-2 text-right font-mono ${p.unrealizedPnl >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}`}>
                      {formatSignedUsd(p.unrealizedPnl, true)}
                    </td>
                  </tr>
                ))}
                {atRisk.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-10 text-center text-slate-400">
                      No indexed open positions currently within 5% of liquidation.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUBTAB 4: FUNDING RATES */}
      {subTab === 'funding' && (
        <div className="sunrise-card overflow-hidden rounded-2xl p-4">
          <div className="mb-3 flex items-center gap-2">
            <Percent className="h-4 w-4 text-[#ffb02e]" />
            <h2 className="font-display text-base font-bold text-[#e8edfb]">
              Live Funding Rates & Annualized Yield ({sortedFundingMarkets.length} Markets)
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono tabular-nums">
              <thead className="border-b border-slate-800 text-[11px] uppercase text-slate-400">
                <tr>
                  <th className="py-2 pr-2">Market</th>
                  <th className="py-2 px-2 text-right">1h Funding</th>
                  <th className="py-2 px-2 text-right">8h Equiv</th>
                  <th className="py-2 px-2 text-right">Annualized APR</th>
                  <th className="py-2 px-2 text-right">Open Interest</th>
                  <th className="py-2 pl-2 text-right">24h Volume</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {sortedFundingMarkets.map((m) => {
                  const r1 = Number(m.current_funding_rate || 0) * 100;
                  const r8 = r1 * 8;
                  const apr = r1 * 24 * 365;
                  const mark = Number(m.mark_price || m.last_price || 0);
                  return (
                    <tr
                      key={m.market_id}
                      onClick={() => onSelectMarket(String(m.market_id))}
                      className="cursor-pointer hover:bg-[#131c31]/60"
                    >
                      <td className="py-2.5 pr-2 font-sans">
                        <div className="flex items-center gap-2">
                          <TokenBadge symbol={m.base_asset_symbol} size={20} />
                          <span className="font-semibold text-[#e8edfb]">{m.display_name}</span>
                        </div>
                      </td>
                      <td className={`py-2.5 px-2 text-right font-semibold ${r1 >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}`}>
                        {r1 >= 0 ? '+' : ''}
                        {r1.toFixed(4)}%
                      </td>
                      <td className={`py-2.5 px-2 text-right ${r8 >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}`}>
                        {r8 >= 0 ? '+' : ''}
                        {r8.toFixed(4)}%
                      </td>
                      <td className={`py-2.5 px-2 text-right font-semibold ${apr >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}`}>
                        {apr >= 0 ? '+' : ''}
                        {apr.toFixed(1)}%
                      </td>
                      <td className="py-2.5 px-2 text-right text-[#ffb02e]">
                        {formatUsd(Number(m.open_interest || 0) * mark, true)}
                      </td>
                      <td className="py-2.5 pl-2 text-right text-slate-300">
                        {formatUsd(m.quote_volume_24h, true)}
                      </td>
                    </tr>
                  );
                })}
                {!loading && sortedFundingMarkets.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-10 text-center font-sans text-slate-400">
                      No market funding rates available right now.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUBTAB 5: TX DECODER & CONTRACTS */}
      {subTab === 'decoder' && (
        <div className="space-y-5">
          <div className="sunrise-card rounded-2xl p-4 space-y-4">
            <h2 className="font-display text-base font-bold text-[#e8edfb]">
              RISEx Transaction & Revert Decoder
            </h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                inspectHash(txInput);
              }}
              className="flex flex-col gap-2 sm:flex-row"
            >
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={txInput}
                  onChange={(e) => setTxInput(e.target.value)}
                  placeholder="Paste 0x transaction hash (64 hex chars)…"
                  className="w-full rounded-xl border border-slate-700/60 bg-[#090e1a] py-2 pl-9 pr-3 text-xs font-mono text-[#e8edfb] placeholder:text-slate-500 focus:border-[#ffb02e] focus:outline-none"
                />
              </div>
              <button type="submit" className="sunrise-gradient-btn rounded-xl px-5 py-2 text-xs font-semibold">
                Decode Tx
              </button>
            </form>

            {txLoading && (
              <div className="flex items-center gap-2 text-xs text-[#ffb02e]">
                <Loader2 className="h-4 w-4 animate-spin" /> Fetching RISEx & Blockscout trace…
              </div>
            )}

            {txResult && !txLoading && (
              <div className="rounded-xl border border-slate-800 bg-[#090e1a] p-4 space-y-3 text-xs font-mono">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-slate-300 break-all">Tx: {txResult.hash || txInput}</span>
                  <a
                    href={`https://explorer.risechain.com/tx/${txResult.hash || txInput}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[#46a6ff] hover:underline"
                  >
                    Open in Blockscout <ExternalLink className="h-3 w-3" />
                  </a>
                </div>

                {txResult.error && (
                  <div className="rounded-lg border border-[#ff4d6d]/40 bg-[#ff4d6d]/10 px-3 py-2 text-[#ff4d6d]">
                    {txResult.error}
                  </div>
                )}

                {txResult.explorerTx && (
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                    <div className="rounded-lg border border-slate-800/80 bg-[#05070d] p-2.5">
                      <div className="text-[10px] uppercase text-slate-500">Status</div>
                      <div className={`mt-0.5 font-semibold ${txResult.explorerTx.status === 'ok' ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}`}>
                        {String(txResult.explorerTx.status || 'UNKNOWN').toUpperCase()}
                      </div>
                    </div>
                    <div className="rounded-lg border border-slate-800/80 bg-[#05070d] p-2.5">
                      <div className="text-[10px] uppercase text-slate-500">Block</div>
                      <div className="mt-0.5 text-slate-200">
                        {txResult.explorerTx.block_number ? `#${Number(txResult.explorerTx.block_number).toLocaleString()}` : '—'}
                      </div>
                    </div>
                    <div className="rounded-lg border border-slate-800/80 bg-[#05070d] p-2.5">
                      <div className="text-[10px] uppercase text-slate-500">Method</div>
                      <div className="mt-0.5 text-[#ffb02e] truncate">
                        {txResult.explorerTx.method || txResult.decoded?.action || 'call'}
                      </div>
                    </div>
                    <div className="rounded-lg border border-slate-800/80 bg-[#05070d] p-2.5">
                      <div className="text-[10px] uppercase text-slate-500">From</div>
                      <div className="mt-0.5">
                        {txResult.explorerTx.from?.hash ? (
                          <button
                            type="button"
                            onClick={() => onSelectWallet(txResult.explorerTx.from.hash)}
                            className="text-[#46a6ff] hover:underline"
                          >
                            {shortAddress(txResult.explorerTx.from.hash, 8, 6)}
                          </button>
                        ) : (
                          '—'
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <pre className="max-h-72 overflow-auto rounded-lg bg-[#05070d] p-3 text-[11px] text-slate-300">
                  {JSON.stringify(txResult, null, 2)}
                </pre>
              </div>
            )}
          </div>

          {systemConfig?.addresses && (
            <div className="sunrise-card rounded-2xl p-4">
              <h3 className="mb-3 font-display text-sm font-bold text-[#e8edfb]">
                RISEx Mainnet Contract Registry
              </h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {Object.entries(systemConfig.addresses).map(([name, addr]) => (
                  <div
                    key={name}
                    className="flex items-center justify-between rounded-xl border border-slate-800/80 bg-[#090e1a] px-3 py-2 text-xs font-mono"
                  >
                    <span className="text-slate-400">{name}</span>
                    <div className="flex items-center gap-1.5">
                      <a
                        href={`https://explorer.risechain.com/address/${addr}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[#46a6ff] hover:underline"
                      >
                        {shortAddress(addr, 8, 6)}
                      </a>
                      <CopyBtn text={addr} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
