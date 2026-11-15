import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { MarketCandle, ChartPoint, PnlCalendarDay } from '../types/risex';
import { formatDateOnly, formatDateTime, formatPrice, formatSignedUsd, formatUsd, nsToMs } from '../utils/format';
import { buildUtcMonthCalendar } from '../utils/portfolioCurves';

export const CandlestickChart: React.FC<{
  candles: MarketCandle[];
  height?: number;
  mode?: 'candle' | 'line';
}> = ({ candles, height = 340, mode = 'candle' }) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!candles || candles.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-slate-800/80 bg-[#090e1a] text-xs text-slate-400"
        style={{ height }}
      >
        No candle data available for this interval.
      </div>
    );
  }

  const width = 920;
  const padL = 12;
  const padR = 76;
  const padT = 18;
  const padB = 34;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;
  const priceH = chartH * 0.78;
  const volH = chartH * 0.18;

  const minPrice = Math.min(...candles.map((c) => c.low));
  const maxPrice = Math.max(...candles.map((c) => c.high));
  const priceRange = maxPrice - minPrice || maxPrice * 0.01 || 1;
  const maxVol = Math.max(...candles.map((c) => c.volume), 1e-9);

  const yPrice = (p: number) => padT + ((maxPrice - p) / priceRange) * priceH;
  const stepX = chartW / candles.length;
  const barW = Math.max(2, Math.min(10, stepX * 0.66));

  const activeCandle = hoverIdx !== null && candles[hoverIdx] ? candles[hoverIdx] : candles[candles.length - 1];
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => maxPrice - t * priceRange);

  const linePath = candles
    .map((c, i) => {
      const x = padL + i * stepX + stepX / 2;
      const y = yPrice(c.close);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  const lineBaseY = padT + priceH;
  const firstX = padL + stepX / 2;
  const lastX = padL + (candles.length - 1) * stepX + stepX / 2;
  const areaPath = `${linePath} L ${lastX.toFixed(1)} ${lineBaseY.toFixed(1)} L ${firstX.toFixed(1)} ${lineBaseY.toFixed(1)} Z`;

  return (
    <div className="relative select-none rounded-xl border border-slate-800/80 bg-[#090e1a] p-3">
      {/* Top OHLCV readout */}
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-mono tabular-nums text-slate-400">
        <span className="text-slate-300">{formatDateTime(activeCandle.time)}</span>
        <span>O: <strong className="text-[#e8edfb]">{formatPrice(activeCandle.open)}</strong></span>
        <span>H: <strong className="text-[#22e0a1]">{formatPrice(activeCandle.high)}</strong></span>
        <span>L: <strong className="text-[#ff4d6d]">{formatPrice(activeCandle.low)}</strong></span>
        <span>
          C:{' '}
          <strong className={activeCandle.close >= activeCandle.open ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}>
            {formatPrice(activeCandle.close)}
          </strong>
        </span>
        <span>Vol: <strong className="text-[#ffb02e]">{activeCandle.volume.toFixed(3)}</strong></span>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto block"
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="candleLineGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffb02e" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#ffb02e" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {/* Gridlines & Price Axis */}
        {yTicks.map((tick, idx) => {
          const y = yPrice(tick);
          return (
            <g key={idx}>
              <line x1={padL} x2={width - padR} y1={y} y2={y} stroke="rgba(148,163,205,0.12)" strokeDasharray="3 3" strokeWidth={1} />
              <text x={width - padR + 8} y={y + 4} fill="#95a3c5" fontSize="10" fontFamily="JetBrains Mono, monospace">
                {tick >= 1000 ? tick.toFixed(1) : tick >= 1 ? tick.toFixed(2) : tick.toPrecision(4)}
              </text>
            </g>
          );
        })}

        {mode === 'line' && (
          <>
            <path d={areaPath} fill="url(#candleLineGrad)" />
            <path d={linePath} fill="none" stroke="#ffb02e" strokeWidth={2} />
          </>
        )}

        {/* Candles + Volume */}
        {candles.map((c, i) => {
          const xCenter = padL + i * stepX + stepX / 2;
          const isUp = c.close >= c.open;
          const color = isUp ? '#22e0a1' : '#ff4d6d';
          const yTop = yPrice(Math.max(c.open, c.close));
          const yBot = yPrice(Math.min(c.open, c.close));
          const bodyH = Math.max(1.5, yBot - yTop);
          const vH = (c.volume / maxVol) * volH;
          const vY = padT + chartH - vH;

          return (
            <g key={i} onMouseEnter={() => setHoverIdx(i)}>
              <rect x={padL + i * stepX} y={padT} width={stepX} height={chartH} fill="transparent" />
              <rect x={xCenter - barW / 2} y={vY} width={barW} height={vH} fill={color} opacity={0.28} />
              {mode === 'candle' && (
                <>
                  <line x1={xCenter} x2={xCenter} y1={yPrice(c.high)} y2={yPrice(c.low)} stroke={color} strokeWidth={1.2} />
                  <rect x={xCenter - barW / 2} y={yTop} width={barW} height={bodyH} fill={color} rx={0.5} />
                </>
              )}
            </g>
          );
        })}

        {/* Crosshair */}
        {hoverIdx !== null && candles[hoverIdx] && (
          <g pointerEvents="none">
            <line
              x1={padL + hoverIdx * stepX + stepX / 2}
              x2={padL + hoverIdx * stepX + stepX / 2}
              y1={padT}
              y2={padT + chartH}
              stroke="#ffb02e"
              strokeOpacity={0.55}
              strokeDasharray="3 3"
              strokeWidth={1}
            />
            <line
              x1={padL}
              x2={width - padR}
              y1={yPrice(candles[hoverIdx].close)}
              y2={yPrice(candles[hoverIdx].close)}
              stroke="#ffb02e"
              strokeOpacity={0.55}
              strokeDasharray="3 3"
              strokeWidth={1}
            />
          </g>
        )}

        {/* X Axis timestamps */}
        {[0, Math.floor(candles.length / 2), candles.length - 1].map((idx) => {
          const c = candles[idx];
          if (!c) return null;
          const x = padL + idx * stepX + stepX / 2;
          return (
            <text
              key={idx}
              x={x}
              y={height - 10}
              fill="#5d6987"
              fontSize="10"
              textAnchor={idx === 0 ? 'start' : idx === candles.length - 1 ? 'end' : 'middle'}
              fontFamily="JetBrains Mono, monospace"
            >
              {formatDateTime(c.time)}
            </text>
          );
        })}
      </svg>
    </div>
  );
};

export const AreaPerformanceChart: React.FC<{
  points: ChartPoint[];
  label: string;
  height?: number;
  signed?: boolean;
}> = ({ points, label, height = 240, signed = true }) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const parsed = (points || [])
    .map((p) => ({ time: nsToMs(p.timestamp), value: Number(p.value) }))
    .filter((p) => Number.isFinite(p.value) && p.time > 0)
    .sort((a, b) => a.time - b.time);

  if (parsed.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-slate-800/80 bg-[#090e1a] text-xs text-slate-400"
        style={{ height }}
      >
        No historical {label.toLowerCase()} points recorded for this period.
      </div>
    );
  }

  const width = 760;
  const padL = 14;
  const padR = 76;
  const padT = 18;
  const padB = 30;
  const cW = width - padL - padR;
  const cH = height - padT - padB;

  const rawMin = Math.min(...parsed.map((p) => p.value));
  const rawMax = Math.max(...parsed.map((p) => p.value));
  let minVal = signed ? Math.min(rawMin, 0) : rawMin;
  let maxVal = signed ? Math.max(rawMax, 0) : rawMax;

  if (Math.abs(maxVal - minVal) < 1e-4) {
    if (signed) {
      const pad = Math.max(Math.abs(maxVal) * 0.1, 10);
      minVal = minVal - pad;
      maxVal = maxVal + pad;
    } else {
      minVal = 0;
      maxVal = Math.max(maxVal * 1.25, 1);
    }
  }
  const range = maxVal - minVal || 1;
  const minTime = parsed[0].time;
  const maxTime = parsed[parsed.length - 1].time;
  const timeSpan = maxTime - minTime;

  const getX = (i: number) =>
    padL + (timeSpan <= 0 ? cW / 2 : ((parsed[i].time - minTime) / timeSpan) * cW);
  const getY = (v: number) => padT + ((maxVal - v) / range) * cH;

  const lastVal = parsed[parsed.length - 1].value;
  const isPositive = signed ? lastVal >= 0 : lastVal >= parsed[0].value;
  const strokeColor = isPositive ? '#22e0a1' : '#ff4d6d';

  const linePath = parsed
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${getX(i).toFixed(1)} ${getY(p.value).toFixed(1)}`)
    .join(' ');
  const baseY = signed ? Math.min(padT + cH, Math.max(padT, getY(0))) : padT + cH;
  const areaPath = `${linePath} L ${getX(parsed.length - 1).toFixed(1)} ${baseY.toFixed(1)} L ${getX(0).toFixed(1)} ${baseY.toFixed(1)} Z`;

  const activePoint = hoverIdx !== null && parsed[hoverIdx] ? parsed[hoverIdx] : parsed[parsed.length - 1];
  const gradId = `grad-${label.replace(/[^a-zA-Z0-9]/g, '')}`;

  return (
    <div className="rounded-xl border border-slate-800/80 bg-[#090e1a] p-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="text-slate-400">
          {label} · <span className="font-mono text-slate-300">{formatDateOnly(activePoint.time)}</span>
        </span>
        <span className={`font-mono font-semibold tabular-nums ${activePoint.value >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}`}>
          {signed ? formatSignedUsd(activePoint.value) : formatUsd(activePoint.value)}
        </span>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto block" onMouseLeave={() => setHoverIdx(null)}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeColor} stopOpacity="0.28" />
            <stop offset="100%" stopColor={strokeColor} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {[0, 0.5, 1].map((t, idx) => {
          const val = maxVal - t * range;
          const cleanTick = Math.abs(val) < 1e-6 ? 0 : val;
          const y = getY(val);
          return (
            <g key={idx}>
              <line x1={padL} x2={width - padR} y1={y} y2={y} stroke="rgba(148,163,205,0.12)" strokeDasharray="3 3" />
              <text x={width - padR + 8} y={y + 4} fill="#95a3c5" fontSize="10" fontFamily="JetBrains Mono, monospace">
                {formatUsd(cleanTick, true)}
              </text>
            </g>
          );
        })}

        {signed && minVal < 0 && maxVal > 0 && (
          <line x1={padL} x2={width - padR} y1={getY(0)} y2={getY(0)} stroke="rgba(148,163,205,0.3)" strokeWidth={1} />
        )}

        <path d={areaPath} fill={`url(#${gradId})`} />
        <path d={linePath} fill="none" stroke={strokeColor} strokeWidth={2} />

        {parsed.map((_p, i) => {
          const xCur = getX(i);
          const xPrev = i > 0 ? getX(i - 1) : padL;
          const xNext = i < parsed.length - 1 ? getX(i + 1) : padL + cW;
          const xLeft = i === 0 ? padL : (xPrev + xCur) / 2;
          const xRight = i === parsed.length - 1 ? padL + cW : (xCur + xNext) / 2;
          const rectW = Math.max(1, xRight - xLeft);
          return (
            <rect
              key={i}
              x={xLeft}
              y={padT}
              width={rectW}
              height={cH}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(i)}
            />
          );
        })}

        {hoverIdx !== null && parsed[hoverIdx] && (
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
            <circle cx={getX(hoverIdx)} cy={getY(parsed[hoverIdx].value)} r={4} fill={strokeColor} stroke="#05070d" strokeWidth={1.5} />
          </g>
        )}

        {[0, parsed.length - 1].map((idx) => {
          const p = parsed[idx];
          if (!p) return null;
          return (
            <text
              key={idx}
              x={getX(idx)}
              y={height - 8}
              fill="#5d6987"
              fontSize="10"
              textAnchor={idx === 0 ? 'start' : 'end'}
              fontFamily="JetBrains Mono, monospace"
            >
              {formatDateOnly(p.time)}
            </text>
          );
        })}
      </svg>
    </div>
  );
};

export const DailyBars30D: React.FC<{
  items: { label: string; value: number }[];
  height?: number;
}> = ({ items, height = 160 }) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!items || items.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-slate-800/80 bg-[#090e1a] text-xs text-slate-400"
        style={{ height }}
      >
        No daily closed-trade PnL bars in this filter window.
      </div>
    );
  }

  const width = 760;
  const padX = 12;
  const padY = 18;
  const cW = width - padX * 2;
  const cH = height - padY * 2;
  const midY = padY + cH / 2;
  const maxAbs = Math.max(...items.map((d) => Math.abs(d.value)), 1);
  const stepW = cW / items.length;
  const barW = Math.max(4, stepW * 0.65);

  const active = hoverIdx !== null ? items[hoverIdx] : items[items.length - 1];

  return (
    <div className="rounded-xl border border-slate-800/80 bg-[#090e1a] p-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="text-slate-400">Daily Realized PnL Distribution ({items.length} days)</span>
        <span className={`font-mono font-semibold tabular-nums ${active.value >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}`}>
          {active.label}: {formatSignedUsd(active.value)}
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto block" onMouseLeave={() => setHoverIdx(null)}>
        <line x1={padX} x2={width - padX} y1={midY} y2={midY} stroke="rgba(148,163,205,0.25)" strokeWidth={1} />
        {items.map((d, i) => {
          const h = Math.max(2, (Math.abs(d.value) / maxAbs) * (cH / 2 - 4));
          const x = padX + i * stepW + (stepW - barW) / 2;
          const y = d.value >= 0 ? midY - h : midY;
          const color = d.value >= 0 ? '#22e0a1' : '#ff4d6d';
          return (
            <g key={i} onMouseEnter={() => setHoverIdx(i)}>
              <rect x={padX + i * stepW} y={padY} width={stepW} height={cH} fill="transparent" />
              <rect
                x={x}
                y={y}
                width={barW}
                height={h}
                rx={1.5}
                fill={color}
                opacity={hoverIdx === i ? 1 : 0.8}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
};

export const PnlCalendarHeatmap: React.FC<{
  days: PnlCalendarDay[];
  winDays?: number;
}> = ({ days }) => {
  const [selectedMonth, setSelectedMonth] = useState<string | undefined>(undefined);
  const [hovered, setHovered] = useState<{ dateKey: string; pnl: number } | null>(null);

  useEffect(() => {
    setSelectedMonth(undefined);
    setHovered(null);
  }, [days]);

  const cal = useMemo(() => buildUtcMonthCalendar(days, selectedMonth), [days, selectedMonth]);

  if (!days || days.length === 0) {
    return (
      <div className="flex h-[240px] items-center justify-center rounded-xl border border-slate-800/80 bg-[#090e1a] text-xs text-slate-400">
        No daily PnL calendar records for this wallet.
      </div>
    );
  }

  const curIdx = cal.availableMonths.indexOf(cal.monthKey);
  const canPrev = curIdx > 0;
  const canNext = curIdx >= 0 && curIdx < cal.availableMonths.length - 1;

  return (
    <div className="rounded-xl border border-slate-800/80 bg-[#090e1a] p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#060913] px-1 py-0.5">
            <button
              type="button"
              aria-label="Previous month"
              disabled={!canPrev}
              onClick={() => canPrev && setSelectedMonth(cal.availableMonths[curIdx - 1])}
              className="rounded p-1 text-slate-300 hover:bg-slate-800 disabled:opacity-30 disabled:pointer-events-none"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="min-w-[74px] text-center font-mono text-[11px] font-semibold text-[#e8edfb]">
              {cal.monthLabel}
            </span>
            <button
              type="button"
              aria-label="Next month"
              disabled={!canNext}
              onClick={() => canNext && setSelectedMonth(cal.availableMonths[curIdx + 1])}
              className="rounded p-1 text-slate-300 hover:bg-slate-800 disabled:opacity-30 disabled:pointer-events-none"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <span className="text-[11px] text-slate-400">
            <span className="font-mono text-slate-200">
              {cal.monthWinDays}/{cal.monthActiveDays}
            </span>{' '}
            win days · All:{' '}
            <span className="font-mono text-slate-300">
              {cal.allTimeWinDays}/{cal.allTimeActiveDays}
            </span>
          </span>
        </div>

        <span
          className={`font-mono font-semibold tabular-nums ${
            (hovered ? hovered.pnl : cal.monthTotalPnl) >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'
          }`}
        >
          {hovered
            ? `${formatDateOnly(`${hovered.dateKey}T00:00:00Z`)}: ${formatSignedUsd(hovered.pnl)}`
            : `${cal.monthLabel}: ${formatSignedUsd(cal.monthTotalPnl)}`}
        </span>
      </div>

      {/* UTC Weekday Headers */}
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-mono uppercase tracking-wider text-slate-500">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((w) => (
          <div key={w} className="py-0.5">
            {w}
          </div>
        ))}
      </div>

      {/* Aligned UTC Month Grid */}
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: cal.firstWeekday }).map((_, idx) => (
          <div key={`blank-${idx}`} className="h-11 rounded-lg bg-transparent" />
        ))}

        {cal.cells.map((cell) => {
          if (cell.pnl === null) {
            return (
              <div
                key={cell.dateKey}
                className="flex h-11 flex-col items-center justify-center rounded-lg border border-slate-800/40 bg-[#0d1424]/60 px-1 text-slate-600"
              >
                <span className="text-[10px] font-mono">{cell.dayNumber}</span>
                <span className="text-[9px] font-mono text-slate-700">—</span>
              </div>
            );
          }

          const intensity = Math.min(0.88, Math.max(0.22, Math.abs(cell.pnl) / cal.maxAbsMonth));
          const bg =
            cell.pnl > 0
              ? `rgba(34, 224, 161, ${intensity.toFixed(2)})`
              : cell.pnl < 0
                ? `rgba(255, 77, 109, ${intensity.toFixed(2)})`
                : 'rgba(51, 65, 85, 0.35)';

          const compactPnl =
            cell.pnl === 0
              ? '$0'
              : `${cell.pnl > 0 ? '+' : '-'}$${
                  Math.abs(cell.pnl) >= 1000
                    ? `${(Math.abs(cell.pnl) / 1000).toFixed(1)}k`
                    : Math.abs(cell.pnl).toFixed(0)
                }`;

          return (
            <div
              key={cell.dateKey}
              onMouseEnter={() => setHovered({ dateKey: cell.dateKey, pnl: cell.pnl! })}
              onMouseLeave={() => setHovered(null)}
              className="flex h-11 flex-col items-center justify-center rounded-lg border border-slate-800/80 px-1 transition-transform hover:scale-[1.03] cursor-default"
              style={{ backgroundColor: bg }}
            >
              <span className="text-[10px] font-mono text-slate-100/85">{cell.dayNumber}</span>
              <span className="text-[10px] font-mono font-semibold tabular-nums text-white truncate max-w-full">
                {compactPnl}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const LongShortBiasBar: React.FC<{
  longNotional: number;
  shortNotional: number;
  longCount: number;
  shortCount: number;
}> = ({ longNotional, shortNotional, longCount, shortCount }) => {
  const total = longNotional + shortNotional;
  const longPct = total > 0 ? (longNotional / total) * 100 : 50;
  const shortPct = 100 - longPct;

  return (
    <div className="sunrise-card rounded-xl p-4">
      <div className="mb-2 flex items-center justify-between text-xs">
        <div className="font-mono tabular-nums">
          <span className="text-[#22e0a1] font-semibold">LONG {longPct.toFixed(1)}%</span>
          <span className="text-slate-400 ml-2">
            {formatUsd(longNotional, true)} · {longCount} traders
          </span>
        </div>
        <div className="font-mono tabular-nums text-right">
          <span className="text-slate-400 mr-2">
            {shortCount} traders · {formatUsd(shortNotional, true)}
          </span>
          <span className="text-[#ff4d6d] font-semibold">SHORT {shortPct.toFixed(1)}%</span>
        </div>
      </div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-800/80">
        <div className="bg-[#22e0a1] transition-all duration-200" style={{ width: `${longPct}%` }} />
        <div className="bg-[#ff4d6d] transition-all duration-200" style={{ width: `${shortPct}%` }} />
      </div>
    </div>
  );
};

/**
 * Honest, compact 24h *change meter* (NOT a historical sparkline).
 * The position and width reflect the actual RISEx 24h % change. A time-series
 * line would require OHLCV history; never synthesize one from a ticker name.
 */
export const MarketMoveMeter: React.FC<{
  changePct: number;
  width?: number;
  height?: number;
}> = ({ changePct, width = 76, height = 24 }) => {
  const pct = Number.isFinite(changePct) ? changePct : 0;
  const center = width / 2;
  const range = Math.max(10, Math.abs(pct));
  const extent = Math.min(center - 3, (Math.abs(pct) / range) * (center - 3));
  const positive = pct >= 0;
  const color = positive ? '#22e0a1' : '#ff4d6d';
  const barWidth = pct === 0 ? 0 : Math.max(1.4, extent);
  const y = Math.max(2, (height - 7) / 2);
  const label = `24h change ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%. This is a change meter, not price history.`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <rect x={1} y={y} width={width - 2} height={7} rx={3.5} fill="#131c31" />
      <line x1={center} y1={y - 2} x2={center} y2={y + 9} stroke="#8492ad" strokeWidth={1} />
      {barWidth > 0 && (
        <rect
          x={positive ? center : center - barWidth}
          y={y + 1}
          width={barWidth}
          height={5}
          rx={2.5}
          fill={color}
        />
      )}
    </svg>
  );
};
