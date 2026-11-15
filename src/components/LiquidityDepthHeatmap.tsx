import React, { useMemo } from 'react';
import { scaleSequential } from 'd3-scale';
import { interpolateRgb } from 'd3-interpolate';
import type { OrderbookLevel } from '../types/risex';
import { formatPrice, formatUsd } from '../utils/format';

interface DepthCell { price: number; size: number; notional: number; side: 'bid' | 'ask' }
const finitePositive = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** The heatmap represents currently resting visible L2 liquidity, not historical liquidity. */
export const LiquidityDepthHeatmap: React.FC<{
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  markPrice: number;
  baseSymbol?: string;
}> = ({ bids, asks, markPrice, baseSymbol }) => {
  const { bidRows, askRows, maxNotional, bidTotal, askTotal } = useMemo(() => {
    const convert = (levels: OrderbookLevel[], side: 'bid' | 'ask'): DepthCell[] => {
      const best = new Map<number, number>();
      for (const level of levels) {
        const price = finitePositive(level.price), size = finitePositive(level.size);
        if (price && size) best.set(price, (best.get(price) || 0) + size);
      }
      return [...best.entries()].map(([price, size]) => ({
        price, size, notional: price * size, side,
      })).sort((a, b) => side === 'bid' ? b.price - a.price : a.price - b.price).slice(0, 35);
    };
    const bidRows = convert(bids, 'bid');
    const askRows = convert(asks, 'ask');
    return {
      bidRows, askRows,
      maxNotional: Math.max(1, ...bidRows.map((x) => x.notional), ...askRows.map((x) => x.notional)),
      bidTotal: bidRows.reduce((sum, row) => sum + row.notional, 0),
      askTotal: askRows.reduce((sum, row) => sum + row.notional, 0),
    };
  }, [bids, asks]);

  const bidScale = useMemo(() => scaleSequential(interpolateRgb('#0b1720', '#03de82')).domain([0, maxNotional]), [maxNotional]);
  const askScale = useMemo(() => scaleSequential(interpolateRgb('#1a1120', '#ff4d6d')).domain([0, maxNotional]), [maxNotional]);
  const row = (cell: DepthCell) => {
    const pct = Math.min(100, cell.notional / maxNotional * 100);
    const color = cell.side === 'bid' ? bidScale(cell.notional) : askScale(cell.notional);
    return <div key={cell.side + cell.price} className="grid grid-cols-[70px_minmax(65px,1fr)_70px] items-center gap-2 py-1 text-[11px] font-mono tabular-nums" title={`${cell.side.toUpperCase()} at ${cell.price}: ${cell.size} ${baseSymbol || 'units'} · ${formatUsd(cell.notional)}`}>
      <span className={cell.side === 'bid' ? 'text-[#03de82]' : 'text-[#ff4d6d]'}>{formatPrice(cell.price)}</span>
      <div className="h-4 overflow-hidden rounded-sm bg-[#090e1a]">
        <div style={{ width: `${Math.max(1, pct)}%`, backgroundColor: color }} className="h-full transition-[width,background-color] duration-200"/>
      </div>
      <span className="text-right text-slate-300">{formatUsd(cell.notional, true)}</span>
    </div>;
  };

  return <section aria-label="Visible order book liquidity depth heat map" className="sunrise-card rounded-2xl p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="font-display text-base font-bold text-[#e8edfb]">Liquidity Depth · L2 Heatmap</h2>
        <p className="mt-1 text-xs text-slate-400">Current resting order concentration by price level · D3 color intensity scaled by USD notional</p>
      </div>
      <span className="text-xs font-mono text-slate-400">Mark {formatPrice(markPrice)}</span>
    </div>
    {bidRows.length + askRows.length === 0
      ? <div className="py-10 text-center text-xs text-slate-400">Order book data unavailable for this market.</div>
      : <>
        <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div>
            <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-[#03de82]"><span>Bids · Buy liquidity</span><span className="font-mono">{formatUsd(bidTotal, true)}</span></div>
            {bidRows.map(row)}
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-[#ff4d6d]"><span>Asks · Sell liquidity</span><span className="font-mono">{formatUsd(askTotal, true)}</span></div>
            {askRows.map(row)}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-3 text-[11px] text-slate-400">
          <span>Top {bidRows.length} bid / {askRows.length} ask levels · visible book only</span>
          <span>Lower liquidity <span className="text-slate-200">→</span> Brighter = higher liquidity</span>
        </div>
        <p className="mt-1 text-[10px] text-slate-500">Not a historical orderbook heatmap or a forecast. Off-book/hidden liquidity is not represented.</p>
      </>}
  </section>;
};
