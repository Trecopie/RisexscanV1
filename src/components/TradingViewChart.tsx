import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts';
import { Activity, BarChart2, ChevronDown, Maximize2, SlidersHorizontal, TrendingUp } from 'lucide-react';
import type { MarketCandle } from '../types/risex';
import { formatDateTime, formatPrice } from '../utils/format';
import {
  calcBollingerBands,
  calcEMA,
  calcMACD,
  calcRSI,
  calcSMA,
  calcVWAP,
  normalizeCandles,
  type NormalizedBar,
} from '../utils/indicators';

export type IndicatorId =
  | 'volume'
  | 'ema9'
  | 'ema21'
  | 'ema50'
  | 'sma20'
  | 'bb'
  | 'vwap'
  | 'rsi'
  | 'macd';

interface IndicatorMeta {
  id: IndicatorId;
  label: string;
  short: string;
  color: string;
  group: 'overlay' | 'pane';
}

const INDICATORS: IndicatorMeta[] = [
  { id: 'ema9', label: 'EMA 9', short: 'EMA9', color: '#ffb02e', group: 'overlay' },
  { id: 'ema21', label: 'EMA 21', short: 'EMA21', color: '#46a6ff', group: 'overlay' },
  { id: 'ema50', label: 'EMA 50', short: 'EMA50', color: '#c084fc', group: 'overlay' },
  { id: 'sma20', label: 'SMA 20', short: 'SMA20', color: '#e2e8f0', group: 'overlay' },
  { id: 'bb', label: 'Bollinger Bands (20, 2)', short: 'BB', color: '#38bdf8', group: 'overlay' },
  { id: 'vwap', label: 'VWAP (Session)', short: 'VWAP', color: '#f472b6', group: 'overlay' },
  { id: 'volume', label: 'Volume Histogram', short: 'Vol', color: '#64748b', group: 'pane' },
  { id: 'rsi', label: 'RSI (14)', short: 'RSI', color: '#a78bfa', group: 'pane' },
  { id: 'macd', label: 'MACD (12, 26, 9)', short: 'MACD', color: '#22e0a1', group: 'pane' },
];

function formatAxisPrice(p: number): string {
  if (!Number.isFinite(p)) return '0';
  if (Math.abs(p) >= 1000) return p.toFixed(1);
  if (Math.abs(p) >= 1) return p.toFixed(3);
  if (Math.abs(p) >= 0.01) return p.toFixed(4);
  return p.toPrecision(4);
}

function getPricePrecision(bars: NormalizedBar[]): { precision: number; minMove: number } {
  const ref = bars.length > 0 ? Math.abs(bars[bars.length - 1].close) : 1;
  if (ref >= 1000) return { precision: 2, minMove: 0.01 };
  if (ref >= 10) return { precision: 3, minMove: 0.001 };
  if (ref >= 0.1) return { precision: 4, minMove: 0.0001 };
  return { precision: 6, minMove: 0.000001 };
}

export const TradingViewChart: React.FC<{
  marketId: string;
  symbol?: string;
  candles: MarketCandle[];
  resolution: string;
  onResolutionChange: (res: string) => void;
  liveMarkPrice?: number;
}> = ({ marketId, symbol, candles, resolution, onResolutionChange, liveMarkPrice }) => {
  const [chartMode, setChartMode] = useState<'candle' | 'area'>('candle');
  const [scaleMode, setScaleMode] = useState<'normal' | 'log'>('normal');
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeIndicators, setActiveIndicators] = useState<Set<IndicatorId>>(
    () => new Set<IndicatorId>(['volume', 'ema9', 'ema21'])
  );
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainSeriesRef = useRef<ISeriesApi<any> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<any> | null>(null);
  const lastDatasetSigRef = useRef<string>('');

  const bars = useMemo(() => normalizeCandles(candles), [candles]);
  const indicatorData = useMemo(() => {
    return {
      ema9: activeIndicators.has('ema9') ? calcEMA(bars, 9) : [],
      ema21: activeIndicators.has('ema21') ? calcEMA(bars, 21) : [],
      ema50: activeIndicators.has('ema50') ? calcEMA(bars, 50) : [],
      sma20: activeIndicators.has('sma20') ? calcSMA(bars, 20) : [],
      bb: activeIndicators.has('bb')
        ? calcBollingerBands(bars, 20, 2)
        : { upper: [], middle: [], lower: [] },
      vwap: activeIndicators.has('vwap') ? calcVWAP(bars, resolution) : [],
      rsi: activeIndicators.has('rsi') ? calcRSI(bars, 14) : [],
      macd: activeIndicators.has('macd')
        ? calcMACD(bars, 12, 26, 9)
        : { macd: [], signal: [], histogram: [] },
    };
  }, [bars, activeIndicators, resolution]);

  const toggleIndicator = (id: IndicatorId) => {
    setActiveIndicators((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Close indicator dropdown on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (ev: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(ev.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const indicatorKey = useMemo(
    () => Array.from(activeIndicators).sort().join(','),
    [activeIndicators]
  );

  // Build / rebuild chart when structural mode or indicators change, and populate series
  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container) return;

    const initW = Math.max(300, container.clientWidth || 720);
    const initH = Math.max(420, container.clientHeight || 480);

    const chart = createChart(container, {
      width: initW,
      height: initH,
      layout: {
        background: { type: ColorType.Solid, color: '#090e1a' },
        textColor: '#95a3c5',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
        panes: {
          separatorColor: 'rgba(148, 163, 205, 0.16)',
          separatorHoverColor: 'rgba(255, 176, 46, 0.45)',
          enableResize: true,
        },
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 205, 0.08)' },
        horzLines: { color: 'rgba(148, 163, 205, 0.08)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: 'rgba(255, 176, 46, 0.55)',
          style: LineStyle.Dashed,
          labelBackgroundColor: '#1e293b',
        },
        horzLine: {
          color: 'rgba(255, 176, 46, 0.55)',
          style: LineStyle.Dashed,
          labelBackgroundColor: '#1e293b',
        },
      },
      rightPriceScale: {
        borderColor: 'rgba(148, 163, 205, 0.14)',
        mode: scaleMode === 'log' ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
        scaleMargins: {
          top: 0.08,
          bottom: activeIndicators.has('volume') ? 0.22 : 0.08,
        },
      },
      timeScale: {
        borderColor: 'rgba(148, 163, 205, 0.14)',
        timeVisible: true,
        secondsVisible: resolution === '1m',
        rightOffset: 6,
      },
      localization: {
        priceFormatter: (p: number) => formatAxisPrice(p),
      },
      handleScroll: true,
      handleScale: true,
    });

    chartRef.current = chart;
    const { precision, minMove } = getPricePrecision(bars);

    // Main price series in Pane 0
    const mainSeries =
      chartMode === 'candle'
        ? chart.addSeries(CandlestickSeries, {
            upColor: '#22e0a1',
            downColor: '#ff4d6d',
            borderUpColor: '#22e0a1',
            borderDownColor: '#ff4d6d',
            wickUpColor: '#22e0a1',
            wickDownColor: '#ff4d6d',
            priceFormat: { type: 'price', precision, minMove },
          })
        : chart.addSeries(AreaSeries, {
            lineColor: '#ffb02e',
            topColor: 'rgba(255, 176, 46, 0.30)',
            bottomColor: 'rgba(255, 176, 46, 0.02)',
            lineWidth: 2,
            priceFormat: { type: 'price', precision, minMove },
          });

    mainSeriesRef.current = mainSeries;

    if (bars.length > 0) {
      if (chartMode === 'candle') {
        mainSeries.setData(
          bars.map((b) => ({
            time: b.time as Time,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
          }))
        );
      } else {
        mainSeries.setData(
          bars.map((b) => ({
            time: b.time as Time,
            value: b.close,
          }))
        );
      }
    }

    // Volume overlay on Pane 0 bottom margin
    if (activeIndicators.has('volume')) {
      const volSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale('volume').applyOptions({
        scaleMargins: { top: 0.80, bottom: 0 },
      });
      volSeries.setData(
        bars.map((b) => ({
          time: b.time as Time,
          value: b.volume,
          color: b.close >= b.open ? 'rgba(34, 224, 161, 0.32)' : 'rgba(255, 77, 109, 0.32)',
        }))
      );
      volumeSeriesRef.current = volSeries;
    } else {
      volumeSeriesRef.current = null;
    }

    const addLineOverlay = (data: { time: number; value: number }[], color: string, dashed = false) => {
      if (data.length === 0) return;
      const line = chart.addSeries(LineSeries, {
        color,
        lineWidth: 1.5 as any,
        lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      line.setData(data.map((d) => ({ time: d.time as Time, value: d.value })));
    };

    if (activeIndicators.has('ema9')) addLineOverlay(indicatorData.ema9, '#ffb02e');
    if (activeIndicators.has('ema21')) addLineOverlay(indicatorData.ema21, '#46a6ff');
    if (activeIndicators.has('ema50')) addLineOverlay(indicatorData.ema50, '#c084fc');
    if (activeIndicators.has('sma20')) addLineOverlay(indicatorData.sma20, '#e2e8f0');
    if (activeIndicators.has('vwap')) addLineOverlay(indicatorData.vwap, '#f472b6');
    if (activeIndicators.has('bb')) {
      addLineOverlay(indicatorData.bb.upper, 'rgba(56, 189, 248, 0.8)');
      addLineOverlay(indicatorData.bb.middle, 'rgba(56, 189, 248, 0.45)', true);
      addLineOverlay(indicatorData.bb.lower, 'rgba(56, 189, 248, 0.8)');
    }

    const hasRsi = activeIndicators.has('rsi') && indicatorData.rsi.length > 0;
    const hasMacd = activeIndicators.has('macd') && indicatorData.macd.macd.length > 0;

    if (hasRsi || hasMacd) {
      const mainPane = chart.panes()[0];
      mainPane?.setStretchFactor(hasRsi && hasMacd ? 2.8 : 3.2);
    }

    if (hasRsi) {
      const rsiPane = chart.addPane();
      rsiPane.setStretchFactor(1);
      const rsiSeries = rsiPane.addSeries(LineSeries, {
        color: '#a78bfa',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
      });
      rsiSeries.setData(indicatorData.rsi.map((d) => ({ time: d.time as Time, value: d.value })));
      rsiSeries.createPriceLine({
        price: 70,
        color: 'rgba(255, 77, 109, 0.45)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '',
      });
      rsiSeries.createPriceLine({
        price: 30,
        color: 'rgba(34, 224, 161, 0.45)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '',
      });
    }

    if (hasMacd) {
      const macdPane = chart.addPane();
      macdPane.setStretchFactor(1);
      const histSeries = macdPane.addSeries(HistogramSeries, {
        priceLineVisible: false,
        lastValueVisible: false,
      });
      histSeries.setData(
        indicatorData.macd.histogram.map((d) => ({
          time: d.time as Time,
          value: d.value,
          color: d.color,
        }))
      );
      const macdLine = macdPane.addSeries(LineSeries, {
        color: '#46a6ff',
        lineWidth: 1.5 as any,
        priceLineVisible: false,
        lastValueVisible: true,
      });
      macdLine.setData(indicatorData.macd.macd.map((d) => ({ time: d.time as Time, value: d.value })));
      const signalLine = macdPane.addSeries(LineSeries, {
        color: '#ffb02e',
        lineWidth: 1.5 as any,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      signalLine.setData(indicatorData.macd.signal.map((d) => ({ time: d.time as Time, value: d.value })));
    }

    const sig = `${marketId}:${resolution}:${bars[0]?.time ?? 0}:${bars.length}`;
    if (lastDatasetSigRef.current !== `${marketId}:${resolution}`) {
      chart.timeScale().fitContent();
    } else if (bars.length > 0 && lastDatasetSigRef.current !== sig) {
      chart.timeScale().fitContent();
    }
    lastDatasetSigRef.current = `${marketId}:${resolution}`;

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || typeof param.time !== 'number') {
        setHoverTime(null);
      } else {
        setHoverTime(param.time);
      }
    });

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.floor(entry.contentRect.width);
        const h = Math.floor(entry.contentRect.height);
        if (w > 50 && h > 120) {
          chart.applyOptions({ width: w, height: h });
        }
      }
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      mainSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, [marketId, resolution, chartMode, scaleMode, indicatorKey, bars.length > 0 ? bars[0].time : 0, bars.length]);

  // Smoothly stream live last-bar tick updates without tearing down chart or zoom state
  useEffect(() => {
    if (!mainSeriesRef.current || bars.length === 0) return;
    const last = bars[bars.length - 1];
    try {
      if (chartMode === 'candle') {
        mainSeriesRef.current.update({
          time: last.time as Time,
          open: last.open,
          high: last.high,
          low: last.low,
          close: last.close,
        });
      } else {
        mainSeriesRef.current.update({
          time: last.time as Time,
          value: last.close,
        });
      }
      if (volumeSeriesRef.current) {
        volumeSeriesRef.current.update({
          time: last.time as Time,
          value: last.volume,
          color: last.close >= last.open ? 'rgba(34, 224, 161, 0.32)' : 'rgba(255, 77, 109, 0.32)',
        });
      }
    } catch {
      // ignore out-of-order tick edge cases
    }
  }, [bars, chartMode]);

  const activeBar = useMemo(() => {
    if (bars.length === 0) return null;
    if (hoverTime !== null) {
      const hit = bars.find((b) => b.time === hoverTime);
      if (hit) return hit;
    }
    return bars[bars.length - 1];
  }, [bars, hoverTime]);

  const activeReadouts = useMemo(() => {
    const t = activeBar?.time;
    const lookup = (arr: { time: number; value: number }[]) => {
      if (!arr.length) return null;
      if (t !== undefined) {
        const found = arr.find((p) => p.time === t);
        if (found) return found.value;
      }
      return arr[arr.length - 1].value;
    };
    return {
      ema9: activeIndicators.has('ema9') ? lookup(indicatorData.ema9) : null,
      ema21: activeIndicators.has('ema21') ? lookup(indicatorData.ema21) : null,
      ema50: activeIndicators.has('ema50') ? lookup(indicatorData.ema50) : null,
      sma20: activeIndicators.has('sma20') ? lookup(indicatorData.sma20) : null,
      vwap: activeIndicators.has('vwap') ? lookup(indicatorData.vwap) : null,
      rsi: activeIndicators.has('rsi') ? lookup(indicatorData.rsi) : null,
      macd: activeIndicators.has('macd') ? lookup(indicatorData.macd.macd) : null,
    };
  }, [activeBar, activeIndicators, indicatorData]);

  return (
    <div ref={wrapperRef} className="flex h-full flex-col gap-2.5">
      {/* Chart Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Resolution Selector */}
          <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#090e1a] p-1">
            {['1m', '5m', '15m', '1H', '4H', '1D'].map((res) => (
              <button
                key={res}
                type="button"
                onClick={() => onResolutionChange(res)}
                className={`rounded-md px-2.5 py-1 text-xs font-mono transition-colors whitespace-nowrap shrink-0 ${
                  resolution === res
                    ? 'bg-[#ffb02e] font-semibold text-[#1f0e03]'
                    : 'text-slate-400 hover:text-[#e8edfb]'
                }`}
              >
                {res}
              </button>
            ))}
          </div>

          {/* Indicators Popover */}
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                menuOpen || activeIndicators.size > 0
                  ? 'border-[#ffb02e]/50 bg-[#ffb02e]/10 text-[#ffb02e]'
                  : 'border-slate-800 bg-[#090e1a] text-slate-300 hover:text-[#e8edfb]'
              }`}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Indicators ({activeIndicators.size})
              <ChevronDown className="h-3.5 w-3.5" />
            </button>

            {menuOpen && (
              <div className="absolute left-0 top-full z-40 mt-1.5 w-64 rounded-xl border border-slate-700/80 bg-[#0b1120] p-2.5 shadow-2xl">
                <div className="mb-1.5 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Price Overlays
                </div>
                <div className="space-y-1">
                  {INDICATORS.filter((i) => i.group === 'overlay').map((ind) => {
                    const checked = activeIndicators.has(ind.id);
                    return (
                      <button
                        key={ind.id}
                        type="button"
                        onClick={() => toggleIndicator(ind.id)}
                        className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs transition-colors ${
                          checked
                            ? 'bg-slate-800/80 text-[#e8edfb]'
                            : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ backgroundColor: ind.color }}
                          />
                          {ind.label}
                        </span>
                        <span className="font-mono text-[10px] text-[#ffb02e]">
                          {checked ? 'ON' : 'OFF'}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="my-2 border-t border-slate-800" />
                <div className="mb-1.5 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Oscillators &amp; Volume
                </div>
                <div className="space-y-1">
                  {INDICATORS.filter((i) => i.group === 'pane').map((ind) => {
                    const checked = activeIndicators.has(ind.id);
                    return (
                      <button
                        key={ind.id}
                        type="button"
                        onClick={() => toggleIndicator(ind.id)}
                        className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs transition-colors ${
                          checked
                            ? 'bg-slate-800/80 text-[#e8edfb]'
                            : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ backgroundColor: ind.color }}
                          />
                          {ind.label}
                        </span>
                        <span className="font-mono text-[10px] text-[#ffb02e]">
                          {checked ? 'ON' : 'OFF'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Mode + Scale + Fit */}
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#090e1a] p-1">
            <button
              type="button"
              onClick={() => setChartMode('candle')}
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-mono whitespace-nowrap shrink-0 ${
                chartMode === 'candle' ? 'bg-slate-800 text-[#ffb02e]' : 'text-slate-400 hover:text-[#e8edfb]'
              }`}
            >
              <BarChart2 className="h-3.5 w-3.5" />
              Candles
            </button>
            <button
              type="button"
              onClick={() => setChartMode('area')}
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-mono whitespace-nowrap shrink-0 ${
                chartMode === 'area' ? 'bg-slate-800 text-[#ffb02e]' : 'text-slate-400 hover:text-[#e8edfb]'
              }`}
            >
              <TrendingUp className="h-3.5 w-3.5" />
              Area
            </button>
          </div>

          <button
            type="button"
            onClick={() => setScaleMode((m) => (m === 'normal' ? 'log' : 'normal'))}
            className={`rounded-lg border px-2.5 py-1.5 text-xs font-mono whitespace-nowrap shrink-0 ${
              scaleMode === 'log'
                ? 'border-[#ffb02e]/60 bg-[#ffb02e]/15 text-[#ffb02e]'
                : 'border-slate-800 bg-[#090e1a] text-slate-400 hover:text-[#e8edfb]'
            }`}
            title="Toggle Logarithmic Scale"
          >
            {scaleMode === 'log' ? 'LOG' : 'LIN'}
          </button>

          <button
            type="button"
            onClick={() => chartRef.current?.timeScale().fitContent()}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-[#090e1a] px-2.5 py-1.5 text-xs font-mono text-slate-400 hover:text-[#e8edfb] whitespace-nowrap shrink-0"
            title="Fit all bars"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            Fit
          </button>
        </div>
      </div>

      {/* Full-Height Interactive TradingView Canvas Container */}
      <div className="relative flex flex-1 flex-col overflow-hidden rounded-xl border border-slate-800/80 bg-[#090e1a] min-h-[460px]">
        {/* Top Live OHLCV + Indicator Legend Bar */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-slate-800/70 bg-[#090e1a]/95 px-3 py-2 text-[11px] font-mono tabular-nums text-slate-400">
          {activeBar ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-semibold text-[#e8edfb]">
                {symbol || `Market #${marketId}`} · {resolution}
              </span>
              <span className="text-slate-400">{formatDateTime(activeBar.time * 1000)}</span>
              <span>
                O <strong className="text-[#e8edfb]">{formatPrice(activeBar.open)}</strong>
              </span>
              <span>
                H <strong className="text-[#22e0a1]">{formatPrice(activeBar.high)}</strong>
              </span>
              <span>
                L <strong className="text-[#ff4d6d]">{formatPrice(activeBar.low)}</strong>
              </span>
              <span>
                C{' '}
                <strong className={activeBar.close >= activeBar.open ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}>
                  {formatPrice(activeBar.close)}
                </strong>
              </span>
              <span>
                Vol <strong className="text-[#ffb02e]">{activeBar.volume.toFixed(2)}</strong>
              </span>
            </div>
          ) : (
            <span>Loading {symbol || `Market #${marketId}`} candles…</span>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
            {activeReadouts.ema9 !== null && (
              <span style={{ color: '#ffb02e' }}>EMA9 {formatAxisPrice(activeReadouts.ema9)}</span>
            )}
            {activeReadouts.ema21 !== null && (
              <span style={{ color: '#46a6ff' }}>EMA21 {formatAxisPrice(activeReadouts.ema21)}</span>
            )}
            {activeReadouts.ema50 !== null && (
              <span style={{ color: '#c084fc' }}>EMA50 {formatAxisPrice(activeReadouts.ema50)}</span>
            )}
            {activeReadouts.sma20 !== null && (
              <span style={{ color: '#e2e8f0' }}>SMA20 {formatAxisPrice(activeReadouts.sma20)}</span>
            )}
            {activeReadouts.vwap !== null && (
              <span style={{ color: '#f472b6' }}>VWAP {formatAxisPrice(activeReadouts.vwap)}</span>
            )}
            {activeReadouts.rsi !== null && (
              <span style={{ color: '#a78bfa' }}>RSI {activeReadouts.rsi.toFixed(1)}</span>
            )}
            {activeReadouts.macd !== null && (
              <span style={{ color: '#22e0a1' }}>MACD {activeReadouts.macd.toFixed(3)}</span>
            )}
            {liveMarkPrice && liveMarkPrice > 0 ? (
              <span className="inline-flex items-center gap-1 text-[#22e0a1]">
                <Activity className="h-3 w-3" />
                Live {formatPrice(liveMarkPrice)}
              </span>
            ) : null}
          </div>
        </div>

        {/* Canvas fills 100% of remaining height */}
        <div ref={chartContainerRef} className="relative w-full flex-1 min-h-[420px]">
          {bars.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-400">
              No candle data available for this interval.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
