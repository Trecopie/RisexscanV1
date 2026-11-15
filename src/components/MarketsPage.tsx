import React, { useMemo, useState } from 'react';
import { ArrowDownUp, BarChart3, Search } from 'lucide-react';
import { useMarketStream } from '../context/MarketWebSocketContext';
import type { MarketWithStats } from '../utils/marketWsPatch';
import { calcMarketChangePct, formatPct, formatPrice, formatUsd } from '../utils/format';
import { MiniSparkline } from './Charts';
import { TokenBadge } from './TraderAvatar';

type MarketSortKey = 'volume' | 'oi' | 'change' | 'funding' | 'price' | 'positions';

export const MarketsPage: React.FC<{
  onSelectMarket: (marketId: string) => void;
}> = ({ onSelectMarket }) => {
  const { markets, loading, error, refreshSnapshot } = useMarketStream();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('ALL');
  const [sortBy, setSortBy] = useState<MarketSortKey>('volume');
  const [sortDesc, setSortDesc] = useState(true);

  const categories = useMemo(() => {
    const set = new Set<string>(['ALL']);
    for (const m of markets) {
      if (m.category) set.add(m.category.toUpperCase());
    }
    return Array.from(set);
  }, [markets]);

  const filteredAndSorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = markets.filter((m) => {
      if (category !== 'ALL' && (m.category || '').toUpperCase() !== category) return false;
      if (q) {
        const hit =
          m.display_name.toLowerCase().includes(q) ||
          m.base_asset_symbol.toLowerCase().includes(q) ||
          (m.search_tags || []).some((t) => t.toLowerCase().includes(q));
        if (!hit) return false;
      }
      return true;
    });

    const getVal = (m: MarketWithStats): number => {
      const mark = Number(m.mark_price || m.last_price || 0);
      switch (sortBy) {
        case 'volume':
          return Number(m.quote_volume_24h || 0);
        case 'oi':
          return Number(m.open_interest || 0) * mark;
        case 'change':
          return calcMarketChangePct(mark, m.change_24h);
        case 'funding':
          return Number(m.current_funding_rate || 0) * 100;
        case 'price':
          return mark;
        case 'positions':
          return m.indexedStats?.count || 0;
      }
    };

    return [...list].sort((a, b) => {
      const diff = getVal(b) - getVal(a);
      return sortDesc ? diff : -diff;
    });
  }, [markets, search, category, sortBy, sortDesc]);

  const toggleSort = (k: MarketSortKey) => {
    if (sortBy === k) setSortDesc((d) => !d);
    else {
      setSortBy(k);
      setSortDesc(true);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-mono text-[#ffb02e]">
            <BarChart3 className="h-3.5 w-3.5" />
            RISEx PERPETUAL MARKETS ({markets.length})
          </div>
          <h1 className="mt-1 font-display text-2xl sm:text-3xl font-bold text-[#e8edfb]">
            All Markets & Live Positioning
          </h1>
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter ticker (BTC, ETH, NVDA, XAU…)"
            className="w-full rounded-xl border border-slate-700/60 bg-[#090e1a] py-2 pl-9 pr-3 text-xs text-[#e8edfb] placeholder:text-slate-500 focus:border-[#ffb02e] focus:outline-none"
          />
        </div>
      </div>

      {/* Category Filter */}
      <div className="flex flex-wrap items-center gap-1.5">
        {categories.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setCategory(cat)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              category === cat
                ? 'sunrise-gradient-btn font-semibold'
                : 'border border-slate-800 bg-[#090e1a] text-slate-400 hover:text-[#e8edfb]'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {error && markets.length === 0 && (
        <div className="flex items-center justify-between rounded-xl border border-[#ff4d6d]/40 bg-[#ff4d6d]/10 px-4 py-3 text-xs text-[#ff4d6d]">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => {
              void refreshSnapshot();
            }}
            className="rounded-lg border border-[#ff4d6d]/40 px-3 py-1 font-mono hover:bg-[#ff4d6d]/20"
          >
            Retry
          </button>
        </div>
      )}

      {/* Markets Table */}
      <div className="sunrise-card overflow-hidden rounded-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-800 bg-[#090e1a]/80 text-[11px] uppercase tracking-wider text-slate-400">
              <tr>
                <th className="py-3 pl-4 pr-2">Ticker</th>
                <th className="py-3 px-2 text-right cursor-pointer hover:text-[#ffb02e]" onClick={() => toggleSort('price')}>
                  <span className="inline-flex items-center gap-1">Mark Price <ArrowDownUp className="h-3 w-3" /></span>
                </th>
                <th className="py-3 px-2 text-right cursor-pointer hover:text-[#ffb02e]" onClick={() => toggleSort('change')}>
                  <span className="inline-flex items-center gap-1">24h % <ArrowDownUp className="h-3 w-3" /></span>
                </th>
                <th className="py-3 px-2 text-center">Trend</th>
                <th className="py-3 px-2 text-right cursor-pointer hover:text-[#ffb02e]" onClick={() => toggleSort('volume')}>
                  <span className="inline-flex items-center gap-1">24h Volume <ArrowDownUp className="h-3 w-3" /></span>
                </th>
                <th className="py-3 px-2 text-right cursor-pointer hover:text-[#ffb02e]" onClick={() => toggleSort('oi')}>
                  <span className="inline-flex items-center gap-1">Open Interest <ArrowDownUp className="h-3 w-3" /></span>
                </th>
                <th className="py-3 px-2 text-right cursor-pointer hover:text-[#ffb02e]" onClick={() => toggleSort('funding')}>
                  <span className="inline-flex items-center gap-1">Funding (1h) <ArrowDownUp className="h-3 w-3" /></span>
                </th>
                <th className="py-3 px-2 text-right">Max Lev</th>
                <th className="py-3 pl-2 pr-4 text-right cursor-pointer hover:text-[#ffb02e]" onClick={() => toggleSort('positions')}>
                  Indexed Pos
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 tabular-nums">
              {loading && (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-slate-400">
                    Loading RISEx markets…
                  </td>
                </tr>
              )}
              {!loading &&
                filteredAndSorted.map((m) => {
                  const mark = Number(m.mark_price || m.last_price || 0);
                  const chg = calcMarketChangePct(mark, m.change_24h);
                  const oiUsd = Number(m.open_interest || 0) * mark;
                  const fundingPct = Number(m.current_funding_rate || 0) * 100;
                  return (
                    <tr
                      key={m.market_id}
                      onClick={() => onSelectMarket(String(m.market_id))}
                      className="cursor-pointer hover:bg-[#131c31]/70 transition-colors"
                    >
                      <td className="py-3 pl-4 pr-2">
                        <div className="flex items-center gap-2.5">
                          <TokenBadge symbol={m.base_asset_symbol} category={m.category} size={26} />
                          <div>
                            <div className="flex items-center gap-1.5">
                              <span className="font-display text-sm font-semibold text-[#e8edfb]">
                                {m.display_name}
                              </span>
                              {m.is_new && (
                                <span className="rounded bg-[#ffb02e]/20 px-1 py-0.5 text-[9px] font-mono font-bold text-[#ffb02e]">
                                  NEW
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] font-mono text-slate-500">
                              ID #{m.market_id} · {m.category || 'PERP'}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-2 text-right font-mono font-medium text-[#e8edfb]">
                        {formatPrice(mark)}
                      </td>
                      <td
                        className={`py-3 px-2 text-right font-mono font-semibold ${
                          chg >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                        }`}
                      >
                        {formatPct(chg)}
                      </td>
                      <td className="py-3 px-2">
                        <div className="flex justify-center">
                          <MiniSparkline seed={m.display_name} changePct={chg} width={64} height={22} />
                        </div>
                      </td>
                      <td className="py-3 px-2 text-right font-mono text-slate-200">
                        {formatUsd(m.quote_volume_24h, true)}
                      </td>
                      <td className="py-3 px-2 text-right font-mono text-[#ffb02e]">
                        {formatUsd(oiUsd, true)}
                      </td>
                      <td
                        className={`py-3 px-2 text-right font-mono ${
                          fundingPct >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
                        }`}
                      >
                        {fundingPct >= 0 ? '+' : ''}
                        {fundingPct.toFixed(4)}%
                      </td>
                      <td className="py-3 px-2 text-right font-mono text-slate-300">
                        {m.config?.max_leverage || '—'}x
                      </td>
                      <td className="py-3 pl-2 pr-4 text-right font-mono">
                        {m.indexedStats && m.indexedStats.count > 0 ? (
                          <span className="rounded bg-[#46a6ff]/15 px-2 py-0.5 text-[11px] text-[#46a6ff]">
                            {m.indexedStats.count}
                          </span>
                        ) : (
                          <span className="text-slate-600">0</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              {!loading && filteredAndSorted.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-400">
                    No RISEx markets match the active search or category filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
