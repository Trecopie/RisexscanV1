import React, { useMemo, useState } from 'react';
import { Layers3 } from 'lucide-react';
import type { RisexMarket } from '../types/risex';
import { normalizeMarketSector, type MarketSectorId } from '../utils/overviewAnalytics';
import { calcMarketChangePct, formatPct, formatPrice, formatUsd } from '../utils/format';
import { TokenBadge } from './TraderAvatar';

type Sector = 'all' | Exclude<MarketSectorId, 'crypto'>;
const filters: { id: Sector; label: string }[] = [
  { id: 'all', label: 'All RWA' },
  { id: 'stocks', label: 'Equities' },
  { id: 'commodity', label: 'Commodities' },
  { id: 'index_etf', label: 'Index ETFs' },
];

export const RwaMarketsWidget: React.FC<{
  markets: RisexMarket[];
  onSelectMarket: (id: string) => void;
}> = ({ markets, onSelectMarket }) => {
  const [sector, setSector] = useState<Sector>('all');
  const rows = useMemo(() => markets.filter((m) => {
    const key = normalizeMarketSector(m.category, m.base_asset_symbol);
    return key !== 'crypto' && (sector === 'all' || key === sector);
  }).sort((a, b) => Number(b.quote_volume_24h || 0) - Number(a.quote_volume_24h || 0)), [markets, sector]);

  const volume = rows.reduce((sum, m) => sum + Number(m.quote_volume_24h || 0), 0);
  const oi = rows.reduce((sum, m) => sum + Number(m.open_interest || 0) * Number(m.mark_price || m.last_price || 0), 0);

  return (
    <section className="sunrise-card rounded-2xl overflow-hidden" aria-label="Real world asset perpetual markets">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 sm:px-5">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-[#03DE82]">
            <Layers3 className="h-4 w-4" /> Real World Assets · RISEx
          </div>
          <h2 className="mt-1 text-lg font-semibold text-[#e8edfb]">RWA Market Intelligence</h2>
          <p className="mt-1 text-xs text-slate-400">
            Underlying-linked perpetual markets. Volume and open interest are derivative metrics, not tokenized asset TVL.
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {filters.map((f) => <button key={f.id} type="button" onClick={() => setSector(f.id)}
            aria-pressed={sector === f.id}
            className={`rounded-md border px-2.5 py-1.5 text-[11px] font-mono transition-colors ${sector === f.id ? 'border-[#03DE82]/50 bg-[#03DE82]/10 text-[#03DE82]' : 'border-slate-800 text-slate-400 hover:text-slate-100'}`}>
            {f.label}
          </button>)}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4 sm:px-5">
        <div className="rounded-lg border border-slate-800 p-3"><div className="text-[10px] uppercase text-slate-500">RWA Markets</div><div className="mt-1 font-mono text-lg font-semibold">{rows.length}</div></div>
        <div className="rounded-lg border border-slate-800 p-3"><div className="text-[10px] uppercase text-slate-500">24h Volume</div><div className="mt-1 font-mono text-lg font-semibold">{formatUsd(volume, true)}</div></div>
        <div className="rounded-lg border border-slate-800 p-3"><div className="text-[10px] uppercase text-slate-500">Open Interest (USD)</div><div className="mt-1 font-mono text-lg font-semibold">{formatUsd(oi, true)}</div></div>
        <div className="rounded-lg border border-slate-800 p-3"><div className="text-[10px] uppercase text-slate-500">Underlying Assets TVL</div><div className="mt-1 font-mono text-lg font-semibold text-slate-400">Not reported</div></div>
      </div>
      <div className="overflow-x-auto border-t border-slate-800">
        <table className="w-full text-left text-xs">
          <thead><tr className="text-[10px] uppercase text-slate-500">
            <th className="px-4 py-3">Market</th><th className="px-3 py-3 text-right">Mark</th>
            <th className="px-3 py-3 text-right">24h Change</th>
            <th className="px-3 py-3 text-right">24h Volume</th>
            <th className="px-4 py-3 text-right">OI USD</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-800/60">
            {rows.slice(0, 12).map((m) => {
              const mark = Number(m.mark_price || m.last_price || 0);
              const pct = calcMarketChangePct(mark, m.change_24h);
              return <tr key={m.market_id} onClick={() => onSelectMarket(String(m.market_id))}
                className="cursor-pointer hover:bg-[#131c31]">
                <td className="px-4 py-2"><div className="flex items-center gap-2"><TokenBadge symbol={m.base_asset_symbol} category={m.category} size={24}/><span className="font-semibold">{m.display_name}</span></div></td>
                <td className="px-3 py-2 text-right font-mono">{formatPrice(mark)}</td>
                <td className={`px-3 py-2 text-right font-mono ${pct >= 0 ? 'text-[#03DE82]' : 'text-[#ff4d6d]'}`}>{formatPct(pct)}</td>
                <td className="px-3 py-2 text-right font-mono">{formatUsd(m.quote_volume_24h, true)}</td>
                <td className="px-4 py-2 text-right font-mono">{formatUsd(Number(m.open_interest || 0) * mark, true)}</td>
              </tr>;
            })}
            {rows.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">No RWA markets in this category.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-3 text-[11px] text-slate-500">
        TVL is intentionally unavailable here: DefiLlama's RISEx protocol TVL is not attributable to individual underlying RWA markets.
        The Overview page reports separately verified protocol TVL.
      </p>
    </section>
  );
};
