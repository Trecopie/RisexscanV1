import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  BarChart2,
  ChevronDown,
  Crosshair,
  Eye,
  EyeOff,
  Magnet,
  Maximize2,
  Minus,
  Ruler,
  Settings2,
  SlidersHorizontal,
  Trash2,
  TrendingUp,
  Undo2,
  X,
} from 'lucide-react';
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
import type { MarketCandle } from '../types/risex';
import { formatDateTime, formatPrice } from '../utils/format';
import {
  calcBollingerBands,
  calcEMA,
  calcMACD,
  calcRSI,
  calcSMA,
  calcSupertrend,
  calcVWAP,
  getResolutionSeconds,
  normalizeCandles,
  type NormalizedBar,
} from '../utils/indicators';

export interface EmaSlotConfig {
  id: string;
  period: number;
  color: string;
  visible: boolean;
}

export interface IndicatorSettings {
  ema5: {
    enabled: boolean;
    visible: boolean;
    slots: EmaSlotConfig[];
  };
  supertrend: {
    enabled: boolean;
    visible: boolean;
    period: number;
    multiplier: number;
    upColor: string;
    downColor: string;
  };
  rsi: {
    enabled: boolean;
    visible: boolean;
    period: number;
    overbought: number;
    oversold: number;
    color: string;
  };
  sma: {
    enabled: boolean;
    visible: boolean;
    period: number;
    color: string;
  };
  bb: {
    enabled: boolean;
    visible: boolean;
    period: number;
    stdDev: number;
    color: string;
  };
  vwap: {
    enabled: boolean;
    visible: boolean;
    color: string;
  };
  macd: {
    enabled: boolean;
    visible: boolean;
    fast: number;
    slow: number;
    signal: number;
  };
  volume: {
    enabled: boolean;
    visible: boolean;
  };
}

export type EditableIndicatorKey = 'ema5' | 'supertrend' | 'rsi' | 'sma' | 'bb' | 'macd';

const DEFAULT_SETTINGS: IndicatorSettings = {
  ema5: {
    enabled: true,
    visible: true,
    slots: [
      { id: 'e1', period: 9, color: '#ffb02e', visible: true },
      { id: 'e2', period: 21, color: '#46a6ff', visible: true },
      { id: 'e3', period: 50, color: '#c084fc', visible: true },
      { id: 'e4', period: 100, color: '#38bdf8', visible: true },
      { id: 'e5', period: 200, color: '#f472b6', visible: true },
    ],
  },
  supertrend: {
    enabled: true,
    visible: true,
    period: 10,
    multiplier: 3,
    upColor: '#22e0a1',
    downColor: '#ff4d6d',
  },
  rsi: {
    enabled: true,
    visible: true,
    period: 14,
    overbought: 70,
    oversold: 30,
    color: '#a78bfa',
  },
  sma: {
    enabled: false,
    visible: true,
    period: 20,
    color: '#e2e8f0',
  },
  bb: {
    enabled: false,
    visible: true,
    period: 20,
    stdDev: 2,
    color: '#38bdf8',
  },
  vwap: {
    enabled: false,
    visible: true,
    color: '#fb7185',
  },
  macd: {
    enabled: false,
    visible: true,
    fast: 12,
    slow: 26,
    signal: 9,
  },
  volume: {
    enabled: true,
    visible: true,
  },
};

const SETTINGS_STORAGE_KEY = 'risexscan_chart_indicators_v2';

function loadSavedSettings(): IndicatorSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      ema5: {
        ...DEFAULT_SETTINGS.ema5,
        ...(parsed.ema5 || {}),
        slots:
          Array.isArray(parsed.ema5?.slots) && parsed.ema5.slots.length === 5
            ? parsed.ema5.slots
            : DEFAULT_SETTINGS.ema5.slots,
      },
      supertrend: { ...DEFAULT_SETTINGS.supertrend, ...(parsed.supertrend || {}) },
      rsi: { ...DEFAULT_SETTINGS.rsi, ...(parsed.rsi || {}) },
      sma: { ...DEFAULT_SETTINGS.sma, ...(parsed.sma || {}) },
      bb: { ...DEFAULT_SETTINGS.bb, ...(parsed.bb || {}) },
      vwap: { ...DEFAULT_SETTINGS.vwap, ...(parsed.vwap || {}) },
      macd: { ...DEFAULT_SETTINGS.macd, ...(parsed.macd || {}) },
      volume: { ...DEFAULT_SETTINGS.volume, ...(parsed.volume || {}) },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

type DrawingToolType =
  | 'crosshair'
  | 'trendline'
  | 'ray'
  | 'hline'
  | 'vline'
  | 'fib'
  | 'measure'
  | 'long'
  | 'short';

interface DrawingPoint {
  time: number; // unix sec
  price: number;
}

interface ChartDrawing {
  id: string;
  type: Exclude<DrawingToolType, 'crosshair'>;
  p1: DrawingPoint;
  p2?: DrawingPoint;
  color: string;
}

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const COLOR_PRESETS = ['#ffb02e', '#46a6ff', '#c084fc', '#38bdf8', '#f472b6', '#22e0a1', '#ff4d6d', '#e2e8f0'];

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
  const [settings, setSettings] = useState<IndicatorSettings>(loadSavedSettings);
  const [editingKey, setEditingKey] = useState<EditableIndicatorKey | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  // DexScreener-style left drawing toolbar state
  const [activeTool, setActiveTool] = useState<DrawingToolType>('crosshair');
  const [magnetEnabled, setMagnetEnabled] = useState(false);
  const [drawingsHidden, setDrawingsHidden] = useState(false);
  const [drawings, setDrawings] = useState<ChartDrawing[]>(() => {
    try {
      const saved = localStorage.getItem(`risexscan_drawings_v1_${marketId}`);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [draftStart, setDraftStart] = useState<DrawingPoint | null>(null);
  const [draftCursor, setDraftCursor] = useState<DrawingPoint | null>(null);
  const [, setRenderTick] = useState(0);

  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainSeriesRef = useRef<ISeriesApi<any> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<any> | null>(null);
  const lastDatasetSigRef = useRef<string>('');

  // Persist indicator settings
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // ignore storage errors
    }
  }, [settings]);

  // Load/save drawings per marketId
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`risexscan_drawings_v1_${marketId}`);
      setDrawings(saved ? JSON.parse(saved) : []);
      setDraftStart(null);
      setDraftCursor(null);
    } catch {
      setDrawings([]);
    }
  }, [marketId]);

  useEffect(() => {
    try {
      localStorage.setItem(`risexscan_drawings_v1_${marketId}`, JSON.stringify(drawings));
    } catch {
      // ignore
    }
  }, [drawings, marketId]);

  const bars = useMemo(() => normalizeCandles(candles), [candles]);

  const indicatorData = useMemo(() => {
    const emaActive = settings.ema5.enabled && settings.ema5.visible;
    const stActive = settings.supertrend.enabled && settings.supertrend.visible;
    const rsiActive = settings.rsi.enabled && settings.rsi.visible;
    const smaActive = settings.sma.enabled && settings.sma.visible;
    const bbActive = settings.bb.enabled && settings.bb.visible;
    const vwapActive = settings.vwap.enabled && settings.vwap.visible;
    const macdActive = settings.macd.enabled && settings.macd.visible;

    return {
      emaSlots: emaActive
        ? settings.ema5.slots.map((slot) => ({
            ...slot,
            data: slot.visible ? calcEMA(bars, slot.period) : [],
          }))
        : [],
      supertrend: stActive
        ? calcSupertrend(bars, settings.supertrend.period, settings.supertrend.multiplier)
        : { points: [], upLine: [], downLine: [] },
      rsi: rsiActive ? calcRSI(bars, settings.rsi.period) : [],
      sma: smaActive ? calcSMA(bars, settings.sma.period) : [],
      bb: bbActive
        ? calcBollingerBands(bars, settings.bb.period, settings.bb.stdDev)
        : { upper: [], middle: [], lower: [] },
      vwap: vwapActive ? calcVWAP(bars, resolution) : [],
      macd: macdActive
        ? calcMACD(bars, settings.macd.fast, settings.macd.slow, settings.macd.signal)
        : { macd: [], signal: [], histogram: [] },
    };
  }, [bars, settings, resolution]);

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

  // Escape cancels draft or exits active drawing tool
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        if (draftStart) {
          setDraftStart(null);
          setDraftCursor(null);
        } else if (activeTool !== 'crosshair') {
          setActiveTool('crosshair');
        } else if (editingKey) {
          setEditingKey(null);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draftStart, activeTool, editingKey]);

  const settingsSig = useMemo(() => JSON.stringify(settings), [settings]);

  // Build / rebuild chart when structural mode or indicator config changes
  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container) return;

    const initW = Math.max(280, container.clientWidth || 680);
    const initH = Math.max(420, container.clientHeight || 520);

    const showVol = settings.volume.enabled && settings.volume.visible;

    const chart = createChart(container, {
      width: initW,
      height: initH,
      layout: {
        background: { type: ColorType.Solid, color: '#070b14' },
        textColor: '#8d9bb8',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
        panes: {
          separatorColor: 'rgba(148, 163, 205, 0.14)',
          separatorHoverColor: 'rgba(255, 176, 46, 0.45)',
          enableResize: true,
        },
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 205, 0.06)' },
        horzLines: { color: 'rgba(148, 163, 205, 0.06)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: 'rgba(255, 176, 46, 0.5)',
          style: LineStyle.Dashed,
          labelBackgroundColor: '#172033',
        },
        horzLine: {
          color: 'rgba(255, 176, 46, 0.5)',
          style: LineStyle.Dashed,
          labelBackgroundColor: '#172033',
        },
      },
      rightPriceScale: {
        borderColor: 'rgba(148, 163, 205, 0.12)',
        mode: scaleMode === 'log' ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
        scaleMargins: {
          top: 0.1,
          bottom: showVol ? 0.2 : 0.08,
        },
      },
      timeScale: {
        borderColor: 'rgba(148, 163, 205, 0.12)',
        timeVisible: true,
        secondsVisible: resolution === '1m',
        rightOffset: 8,
      },
      localization: {
        priceFormatter: (p: number) => formatAxisPrice(p),
      },
      handleScroll: true,
      handleScale: true,
    });

    chartRef.current = chart;
    const { precision, minMove } = getPricePrecision(bars);

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
            topColor: 'rgba(255, 176, 46, 0.25)',
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

    if (showVol) {
      const volSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale('volume').applyOptions({
        scaleMargins: { top: 0.82, bottom: 0 },
      });
      volSeries.setData(
        bars.map((b) => ({
          time: b.time as Time,
          value: b.volume,
          color: b.close >= b.open ? 'rgba(34, 224, 161, 0.28)' : 'rgba(255, 77, 109, 0.28)',
        }))
      );
      volumeSeriesRef.current = volSeries;
    } else {
      volumeSeriesRef.current = null;
    }

    const addLineOverlay = (
      data: { time: number; value?: number }[],
      color: string,
      width = 1.5,
      dashed = false
    ) => {
      if (data.length === 0) return;
      const line = chart.addSeries(LineSeries, {
        color,
        lineWidth: width as any,
        lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      line.setData(
        data.map((d) =>
          d.value !== undefined ? { time: d.time as Time, value: d.value } : { time: d.time as Time }
        )
      );
    };

    // 5 EMA Ribbon
    for (const slot of indicatorData.emaSlots) {
      if (slot.data.length > 0) {
        addLineOverlay(slot.data, slot.color, 1.5);
      }
    }

    // Supertrend (separate bullish & bearish segments)
    if (settings.supertrend.enabled && settings.supertrend.visible && indicatorData.supertrend.points.length > 0) {
      addLineOverlay(indicatorData.supertrend.upLine, settings.supertrend.upColor, 2);
      addLineOverlay(indicatorData.supertrend.downLine, settings.supertrend.downColor, 2);
    }

    // SMA / VWAP / BB
    if (settings.sma.enabled && settings.sma.visible) {
      addLineOverlay(indicatorData.sma, settings.sma.color, 1.5);
    }
    if (settings.vwap.enabled && settings.vwap.visible) {
      addLineOverlay(indicatorData.vwap, settings.vwap.color, 1.5);
    }
    if (settings.bb.enabled && settings.bb.visible) {
      addLineOverlay(indicatorData.bb.upper, settings.bb.color, 1.25);
      addLineOverlay(indicatorData.bb.middle, 'rgba(56, 189, 248, 0.5)', 1, true);
      addLineOverlay(indicatorData.bb.lower, settings.bb.color, 1.25);
    }

    // Oscillator Panes
    const hasRsi = settings.rsi.enabled && settings.rsi.visible && indicatorData.rsi.length > 0;
    const hasMacd = settings.macd.enabled && settings.macd.visible && indicatorData.macd.macd.length > 0;

    if (hasRsi || hasMacd) {
      const mainPane = chart.panes()[0];
      mainPane?.setStretchFactor(hasRsi && hasMacd ? 2.8 : 3.2);
    }

    if (hasRsi) {
      const rsiPane = chart.addPane();
      rsiPane.setStretchFactor(1);
      const rsiSeries = rsiPane.addSeries(LineSeries, {
        color: settings.rsi.color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
      });
      rsiSeries.setData(indicatorData.rsi.map((d) => ({ time: d.time as Time, value: d.value })));
      rsiSeries.createPriceLine({
        price: settings.rsi.overbought,
        color: 'rgba(255, 77, 109, 0.45)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '',
      });
      rsiSeries.createPriceLine({
        price: settings.rsi.oversold,
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

    const dsKey = `${marketId}:${resolution}`;
    if (bars.length > 0 && lastDatasetSigRef.current !== dsKey) {
      chart.timeScale().fitContent();
      lastDatasetSigRef.current = dsKey;
    }

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || typeof param.time !== 'number') {
        setHoverTime(null);
      } else {
        setHoverTime(param.time);
      }
    });

    // Keep drawing SVG overlay synchronized on pan/zoom/resize
    let rafId = 0;
    const scheduleDrawSync = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => setRenderTick((t) => t + 1));
    };
    const onRangeChange = () => scheduleDrawSync();
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.floor(entry.contentRect.width);
        const h = Math.floor(entry.contentRect.height);
        if (w > 50 && h > 120) {
          chart.applyOptions({ width: w, height: h });
          scheduleDrawSync();
        }
      }
    });
    ro.observe(container);

    return () => {
      cancelAnimationFrame(rafId);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      mainSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, [marketId, resolution, chartMode, scaleMode, settingsSig, bars.length > 0 ? bars[0].time : 0, bars.length]);

  // Smoothly stream live tick updates without tearing down chart
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
      if (volumeSeriesRef.current && settings.volume.enabled && settings.volume.visible) {
        volumeSeriesRef.current.update({
          time: last.time as Time,
          value: last.volume,
          color: last.close >= last.open ? 'rgba(34, 224, 161, 0.28)' : 'rgba(255, 77, 109, 0.28)',
        });
      }
    } catch {
      // ignore out-of-order edge case
    }
  }, [bars, chartMode, settings.volume.enabled, settings.volume.visible]);

  // Coordinate conversions for SVG drawing overlay
  const resSec = getResolutionSeconds(resolution);

  const clientToDrawingPoint = useCallback(
    (clientX: number, clientY: number): DrawingPoint | null => {
      const container = chartContainerRef.current;
      const chart = chartRef.current;
      const series = mainSeriesRef.current;
      if (!container || !chart || !series || bars.length === 0) return null;

      const rect = container.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const y = Math.max(0, Math.min(rect.height, clientY - rect.top));

      let price = series.coordinateToPrice(y) as number | null;
      if (price === null || !Number.isFinite(price)) return null;

      let timeVal = chart.timeScale().coordinateToTime(x);
      let timeNum: number;
      if (typeof timeVal === 'number' && Number.isFinite(timeVal)) {
        timeNum = timeVal;
      } else {
        const logical = chart.timeScale().coordinateToLogical(x);
        if (logical === null || !Number.isFinite(logical)) {
          timeNum = bars[bars.length - 1].time;
        } else {
          const roundedIdx = Math.round(logical);
          if (roundedIdx >= 0 && roundedIdx < bars.length) {
            timeNum = bars[roundedIdx].time;
          } else if (roundedIdx < 0) {
            timeNum = bars[0].time + roundedIdx * resSec;
          } else {
            timeNum = bars[bars.length - 1].time + (roundedIdx - (bars.length - 1)) * resSec;
          }
        }
      }

      if (magnetEnabled) {
        let nearestBar = bars[0];
        let minDiff = Math.abs(bars[0].time - timeNum);
        for (const b of bars) {
          const d = Math.abs(b.time - timeNum);
          if (d < minDiff) {
            minDiff = d;
            nearestBar = b;
          }
        }
        const candidates = [nearestBar.open, nearestBar.high, nearestBar.low, nearestBar.close];
        let bestP: number = price;
        let bestDist = Infinity;
        for (const c of candidates) {
          const d = Math.abs(c - price);
          if (d < bestDist) {
            bestDist = d;
            bestP = c;
          }
        }
        price = bestP;
        timeNum = nearestBar.time;
      }

      return { time: timeNum, price };
    },
    [bars, magnetEnabled, resSec]
  );

  const pointToXY = useCallback(
    (pt: DrawingPoint): { x: number; y: number } | null => {
      const chart = chartRef.current;
      const series = mainSeriesRef.current;
      const container = chartContainerRef.current;
      if (!chart || !series || !container || bars.length === 0) return null;

      const y = series.priceToCoordinate(pt.price);
      if (y === null || !Number.isFinite(y)) return null;

      let x = chart.timeScale().timeToCoordinate(pt.time as Time);
      if (x === null || !Number.isFinite(x)) {
        // Fallback linear interpolation from anchor bars outside/beyond visible timestamps
        const firstBar = bars[0];
        const lastBar = bars[bars.length - 1];
        const x0 = chart.timeScale().timeToCoordinate(firstBar.time as Time);
        const x1 = chart.timeScale().timeToCoordinate(lastBar.time as Time);
        if (x0 !== null && x1 !== null && lastBar.time > firstBar.time) {
          const pxPerSec = (x1 - x0) / (lastBar.time - firstBar.time);
          x = (x0 + (pt.time - firstBar.time) * pxPerSec) as any;
        } else {
          return null;
        }
      }
      return { x: Number(x), y: Number(y) };
    },
    [bars]
  );

  const handleSvgMouseMove = (ev: React.MouseEvent<SVGSVGElement>) => {
    if (activeTool === 'crosshair' || !draftStart) return;
    const pt = clientToDrawingPoint(ev.clientX, ev.clientY);
    if (pt) setDraftCursor(pt);
  };

  const handleSvgClick = (ev: React.MouseEvent<SVGSVGElement>) => {
    if (activeTool === 'crosshair') return;
    const pt = clientToDrawingPoint(ev.clientX, ev.clientY);
    if (!pt) return;

    const toolColorMap: Record<Exclude<DrawingToolType, 'crosshair'>, string> = {
      trendline: '#ffb02e',
      ray: '#46a6ff',
      hline: '#38bdf8',
      vline: '#94a3b8',
      fib: '#c084fc',
      measure: '#ffb02e',
      long: '#22e0a1',
      short: '#ff4d6d',
    };

    if (activeTool === 'hline' || activeTool === 'vline') {
      setDrawings((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: activeTool,
          p1: pt,
          color: toolColorMap[activeTool],
        },
      ]);
      setActiveTool('crosshair');
      return;
    }

    if (!draftStart) {
      setDraftStart(pt);
      setDraftCursor(pt);
    } else {
      setDrawings((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: activeTool,
          p1: draftStart,
          p2: pt,
          color: toolColorMap[activeTool],
        },
      ]);
      setDraftStart(null);
      setDraftCursor(null);
      setActiveTool('crosshair');
    }
  };

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
    const lookupLine = (arr: { time: number; value: number }[]) => {
      if (!arr.length) return null;
      if (t !== undefined) {
        const found = arr.find((p) => p.time === t);
        if (found) return found.value;
      }
      return arr[arr.length - 1].value;
    };
    let stPoint = indicatorData.supertrend.points[indicatorData.supertrend.points.length - 1] || null;
    if (t !== undefined && indicatorData.supertrend.points.length > 0) {
      const hit = indicatorData.supertrend.points.find((p) => p.time === t);
      if (hit) stPoint = hit;
    }
    return {
      emaSlots: indicatorData.emaSlots.map((s) => ({
        ...s,
        current: s.visible ? lookupLine(s.data) : null,
      })),
      supertrend: stPoint,
      rsi: lookupLine(indicatorData.rsi),
      sma: lookupLine(indicatorData.sma),
      vwap: lookupLine(indicatorData.vwap),
      macd: lookupLine(indicatorData.macd.macd),
    };
  }, [activeBar, indicatorData]);

  const enabledCount = [
    settings.ema5.enabled,
    settings.supertrend.enabled,
    settings.rsi.enabled,
    settings.sma.enabled,
    settings.bb.enabled,
    settings.vwap.enabled,
    settings.macd.enabled,
    settings.volume.enabled,
  ].filter(Boolean).length;

  const canvasWidth = chartContainerRef.current?.clientWidth || 720;
  const canvasHeight = chartContainerRef.current?.clientHeight || 520;

  const renderDrawingSvg = (d: ChartDrawing, isPreview = false) => {
    const c1 = pointToXY(d.p1);
    if (!c1) return null;
    const c2 = d.p2 ? pointToXY(d.p2) : null;
    const opacity = isPreview ? 0.78 : 0.95;

    if (d.type === 'hline') {
      return (
        <g key={d.id} opacity={opacity}>
          <line x1={0} y1={c1.y} x2={canvasWidth} y2={c1.y} stroke={d.color} strokeWidth={1.5} strokeDasharray="5 3" />
          <rect x={8} y={c1.y - 10} width={78} height={18} rx={3} fill="#0b1120" stroke={d.color} strokeWidth={1} />
          <text x={13} y={c1.y + 3} fill={d.color} fontSize={10} fontFamily="JetBrains Mono, monospace">
            {formatAxisPrice(d.p1.price)}
          </text>
        </g>
      );
    }

    if (d.type === 'vline') {
      return (
        <g key={d.id} opacity={opacity}>
          <line x1={c1.x} y1={0} x2={c1.x} y2={canvasHeight} stroke={d.color} strokeWidth={1.25} strokeDasharray="4 4" />
        </g>
      );
    }

    if (!c2) return null;

    if (d.type === 'trendline') {
      return (
        <g key={d.id} opacity={opacity}>
          <line x1={c1.x} y1={c1.y} x2={c2.x} y2={c2.y} stroke={d.color} strokeWidth={2} />
          <circle cx={c1.x} cy={c1.y} r={3.5} fill={d.color} />
          <circle cx={c2.x} cy={c2.y} r={3.5} fill={d.color} />
        </g>
      );
    }

    if (d.type === 'ray') {
      const dx = c2.x - c1.x;
      const dy = c2.y - c1.y;
      const len = Math.hypot(dx, dy) || 1;
      const scale = 2500 / len;
      return (
        <g key={d.id} opacity={opacity}>
          <line
            x1={c1.x}
            y1={c1.y}
            x2={c1.x + dx * scale}
            y2={c1.y + dy * scale}
            stroke={d.color}
            strokeWidth={1.8}
          />
          <circle cx={c1.x} cy={c1.y} r={3.5} fill={d.color} />
          <circle cx={c2.x} cy={c2.y} r={3.5} fill={d.color} />
        </g>
      );
    }

    if (d.type === 'measure') {
      const minX = Math.min(c1.x, c2.x);
      const maxX = Math.max(c1.x, c2.x);
      const minY = Math.min(c1.y, c2.y);
      const maxY = Math.max(c1.y, c2.y);
      const pDiff = (d.p2?.price ?? d.p1.price) - d.p1.price;
      const pct = d.p1.price !== 0 ? (pDiff / d.p1.price) * 100 : 0;
      const col = pDiff >= 0 ? '#22e0a1' : '#ff4d6d';
      const label = `${pDiff >= 0 ? '+' : ''}${formatAxisPrice(pDiff)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
      return (
        <g key={d.id} opacity={opacity}>
          <rect
            x={minX}
            y={minY}
            width={Math.max(4, maxX - minX)}
            height={Math.max(4, maxY - minY)}
            fill={pDiff >= 0 ? 'rgba(34,224,161,0.12)' : 'rgba(255,77,109,0.12)'}
            stroke={col}
            strokeWidth={1.25}
          />
          <rect x={minX} y={Math.max(4, minY - 22)} width={Math.max(130, label.length * 7)} height={18} rx={3} fill="#090e1a" stroke={col} strokeWidth={1} />
          <text x={minX + 6} y={Math.max(16, minY - 9)} fill={col} fontSize={10} fontFamily="JetBrains Mono, monospace">
            {label}
          </text>
        </g>
      );
    }

    if (d.type === 'fib') {
      const minX = Math.min(c1.x, c2.x);
      const maxX = Math.max(c1.x, c2.x);
      const width = Math.max(48, maxX - minX);
      const pHigh = d.p1.price;
      const pLow = d.p2?.price ?? d.p1.price;
      return (
        <g key={d.id} opacity={opacity}>
          {FIB_LEVELS.map((lvl) => {
            const lvlPrice = pHigh + (pLow - pHigh) * lvl;
            const yCoord = mainSeriesRef.current?.priceToCoordinate(lvlPrice);
            if (yCoord === null || yCoord === undefined) return null;
            return (
              <g key={lvl}>
                <line
                  x1={minX}
                  y1={yCoord}
                  x2={minX + width}
                  y2={yCoord}
                  stroke={lvl === 0.618 || lvl === 0.5 ? '#ffb02e' : '#c084fc'}
                  strokeWidth={lvl === 0.618 || lvl === 0.5 ? 1.4 : 1}
                  strokeDasharray={lvl === 0 || lvl === 1 ? undefined : '4 3'}
                />
                <text x={minX + 4} y={yCoord - 3} fill="#cbd5e1" fontSize={9.5} fontFamily="JetBrains Mono, monospace">
                  {lvl.toFixed(3)} ({formatAxisPrice(lvlPrice)})
                </text>
              </g>
            );
          })}
        </g>
      );
    }

    if (d.type === 'long' || d.type === 'short') {
      const minX = Math.min(c1.x, c2.x);
      const width = Math.max(70, Math.abs(c2.x - c1.x));
      const entryY = c1.y;
      const targetY = c2.y;
      const profitHeight = Math.abs(targetY - entryY);
      const stopHeight = Math.max(16, profitHeight * 0.5);
      const isLong = d.type === 'long';
      const tpTop = Math.min(entryY, targetY);
      const slTop = isLong ? entryY : entryY - stopHeight;
      const targetPct = d.p1.price !== 0 ? (((d.p2?.price ?? d.p1.price) - d.p1.price) / d.p1.price) * 100 : 0;

      return (
        <g key={d.id} opacity={opacity}>
          <rect x={minX} y={tpTop} width={width} height={Math.max(8, profitHeight)} fill="rgba(34,224,161,0.16)" stroke="#22e0a1" strokeWidth={1} />
          <rect x={minX} y={slTop} width={width} height={stopHeight} fill="rgba(255,77,109,0.15)" stroke="#ff4d6d" strokeWidth={1} />
          <line x1={minX} y1={entryY} x2={minX + width} y2={entryY} stroke="#e2e8f0" strokeWidth={1.25} />
          <text x={minX + 6} y={tpTop + 13} fill="#22e0a1" fontSize={10} fontFamily="JetBrains Mono, monospace">
            {isLong ? 'LONG' : 'SHORT'} TP {targetPct >= 0 ? '+' : ''}{targetPct.toFixed(2)}%
          </text>
        </g>
      );
    }

    return null;
  };

  const drawingTools: {
    id: DrawingToolType;
    label: string;
    icon: React.ReactNode;
  }[] = [
    { id: 'crosshair', label: 'Crosshair (Pan / Zoom)', icon: <Crosshair className="h-4 w-4" /> },
    { id: 'trendline', label: 'Trend Line', icon: <TrendingUp className="h-4 w-4" /> },
    { id: 'ray', label: 'Trend Ray', icon: <ArrowUpRight className="h-4 w-4" /> },
    { id: 'hline', label: 'Horizontal Line', icon: <Minus className="h-4 w-4" /> },
    {
      id: 'vline',
      label: 'Vertical Line',
      icon: (
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
          <line x1="8" y1="2" x2="8" y2="14" strokeDasharray="2 2" />
          <circle cx="8" cy="8" r="1.8" fill="currentColor" />
        </svg>
      ),
    },
    {
      id: 'fib',
      label: 'Fib Retracement',
      icon: (
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.4">
          <line x1="2" y1="3" x2="14" y2="3" />
          <line x1="2" y1="8" x2="14" y2="8" strokeDasharray="2 1.5" />
          <line x1="2" y1="13" x2="14" y2="13" />
        </svg>
      ),
    },
    { id: 'measure', label: 'Price Range Measure', icon: <Ruler className="h-4 w-4" /> },
    {
      id: 'long',
      label: 'Long Position Box',
      icon: (
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="3" y="2.5" width="10" height="5.5" fill="rgba(34,224,161,0.25)" stroke="#22e0a1" />
          <rect x="3" y="8" width="10" height="4.5" fill="rgba(255,77,109,0.22)" stroke="#ff4d6d" />
        </svg>
      ),
    },
    {
      id: 'short',
      label: 'Short Position Box',
      icon: (
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="3" y="3" width="10" height="4.5" fill="rgba(255,77,109,0.22)" stroke="#ff4d6d" />
          <rect x="3" y="7.5" width="10" height="5.5" fill="rgba(34,224,161,0.25)" stroke="#22e0a1" />
        </svg>
      ),
    },
  ];

  return (
    <div className="flex h-full flex-col gap-2">
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Resolution Selector */}
          <div className="flex items-center gap-0.5 rounded-lg border border-slate-800 bg-[#070b14] p-0.5">
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
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                menuOpen
                  ? 'border-[#ffb02e]/60 bg-[#ffb02e]/12 text-[#ffb02e]'
                  : 'border-slate-800 bg-[#070b14] text-slate-200 hover:border-slate-700'
              }`}
            >
              <SlidersHorizontal className="h-3.5 w-3.5 text-[#ffb02e]" />
              Indicators ({enabledCount})
              <ChevronDown className="h-3.5 w-3.5" />
            </button>

            {menuOpen && (
              <div className="absolute left-0 top-full z-40 mt-1.5 w-72 rounded-xl border border-slate-700/80 bg-[#0b1120] p-2.5 shadow-2xl">
                <div className="mb-1.5 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Overlays &amp; Oscillators
                </div>
                <div className="space-y-1 text-xs">
                  {(
                    [
                      {
                        key: 'ema5',
                        label: `5 EMA Ribbon (${settings.ema5.slots.map((s) => s.period).join(', ')})`,
                        color: '#ffb02e',
                        enabled: settings.ema5.enabled,
                        visible: settings.ema5.visible,
                        editable: true,
                      },
                      {
                        key: 'supertrend',
                        label: `Supertrend (${settings.supertrend.period}, ${settings.supertrend.multiplier})`,
                        color: settings.supertrend.upColor,
                        enabled: settings.supertrend.enabled,
                        visible: settings.supertrend.visible,
                        editable: true,
                      },
                      {
                        key: 'rsi',
                        label: `RSI (${settings.rsi.period})`,
                        color: settings.rsi.color,
                        enabled: settings.rsi.enabled,
                        visible: settings.rsi.visible,
                        editable: true,
                      },
                      {
                        key: 'sma',
                        label: `SMA (${settings.sma.period})`,
                        color: settings.sma.color,
                        enabled: settings.sma.enabled,
                        visible: settings.sma.visible,
                        editable: true,
                      },
                      {
                        key: 'bb',
                        label: `Bollinger Bands (${settings.bb.period}, ${settings.bb.stdDev})`,
                        color: settings.bb.color,
                        enabled: settings.bb.enabled,
                        visible: settings.bb.visible,
                        editable: true,
                      },
                      {
                        key: 'vwap',
                        label: 'VWAP (Session)',
                        color: settings.vwap.color,
                        enabled: settings.vwap.enabled,
                        visible: settings.vwap.visible,
                        editable: false,
                      },
                      {
                        key: 'macd',
                        label: `MACD (${settings.macd.fast}, ${settings.macd.slow}, ${settings.macd.signal})`,
                        color: '#46a6ff',
                        enabled: settings.macd.enabled,
                        visible: settings.macd.visible,
                        editable: true,
                      },
                      {
                        key: 'volume',
                        label: 'Volume Histogram',
                        color: '#64748b',
                        enabled: settings.volume.enabled,
                        visible: settings.volume.visible,
                        editable: false,
                      },
                    ] as const
                  ).map((item) => (
                    <div
                      key={item.key}
                      className={`flex items-center justify-between rounded-lg px-2 py-1.5 ${
                        item.enabled ? 'bg-slate-800/75 text-[#e8edfb]' : 'text-slate-400 hover:bg-slate-800/35'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setSettings((prev) => ({
                            ...prev,
                            [item.key]: {
                              ...prev[item.key],
                              enabled: !prev[item.key].enabled,
                              visible: true,
                            },
                          }))
                        }
                        className="flex flex-1 items-center gap-2 text-left"
                      >
                        <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
                        <span className="truncate">{item.label}</span>
                      </button>

                      <div className="flex items-center gap-1 shrink-0">
                        {item.enabled && (
                          <button
                            type="button"
                            onClick={() =>
                              setSettings((prev) => ({
                                ...prev,
                                [item.key]: { ...prev[item.key], visible: !prev[item.key].visible },
                              }))
                            }
                            aria-label={`${item.visible ? 'Hide' : 'Show'} ${item.label}`}
                            title={item.visible ? 'Hide' : 'Show'}
                            className="rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-[#e8edfb]"
                          >
                            {item.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                          </button>
                        )}
                        {item.editable && (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingKey(item.key as EditableIndicatorKey);
                              setMenuOpen(false);
                            }}
                            aria-label={`Edit ${item.label}`}
                            title="Edit parameters"
                            className="rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-[#ffb02e]"
                          >
                            <Settings2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {activeTool !== 'crosshair' && (
            <span className="font-mono text-[11px] text-[#ffb02e]">
              {draftStart
                ? `Click 2nd point to place ${activeTool.toUpperCase()} (Esc to cancel)`
                : `Click chart to place ${activeTool.toUpperCase()}`}
            </span>
          )}
        </div>

        {/* Mode + Scale + Fit */}
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-0.5 rounded-lg border border-slate-800 bg-[#070b14] p-0.5">
            <button
              type="button"
              onClick={() => setChartMode('candle')}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-mono whitespace-nowrap shrink-0 ${
                chartMode === 'candle' ? 'bg-slate-800 text-[#ffb02e]' : 'text-slate-400 hover:text-[#e8edfb]'
              }`}
            >
              <BarChart2 className="h-3.5 w-3.5" />
              Candles
            </button>
            <button
              type="button"
              onClick={() => setChartMode('area')}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-mono whitespace-nowrap shrink-0 ${
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
            className={`rounded-lg border px-2.5 py-1 text-xs font-mono whitespace-nowrap shrink-0 ${
              scaleMode === 'log'
                ? 'border-[#ffb02e]/60 bg-[#ffb02e]/15 text-[#ffb02e]'
                : 'border-slate-800 bg-[#070b14] text-slate-400 hover:text-[#e8edfb]'
            }`}
            title="Toggle Logarithmic Scale"
          >
            {scaleMode === 'log' ? 'LOG' : 'LIN'}
          </button>

          <button
            type="button"
            onClick={() => chartRef.current?.timeScale().fitContent()}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-[#070b14] px-2.5 py-1 text-xs font-mono text-slate-400 hover:text-[#e8edfb] whitespace-nowrap shrink-0"
            title="Fit all bars"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            Fit
          </button>
        </div>
      </div>

      {/* Main Chart Body: DexScreener-Style Left Drawing Toolbar + Full-Height Canvas */}
      <div className="relative flex flex-1 overflow-hidden rounded-xl border border-slate-800/80 bg-[#070b14] min-h-[480px]">
        {/* Left Vertical Drawing Tools Sidebar */}
        <aside
          aria-label="Chart drawing tools"
          className="flex w-10 shrink-0 flex-col items-center justify-between border-r border-slate-800/80 bg-[#060911] py-2 select-none"
        >
          <div className="flex flex-col items-center gap-1">
            {drawingTools.map((tool) => {
              const active = activeTool === tool.id;
              return (
                <button
                  key={tool.id}
                  type="button"
                  onClick={() => {
                    setDraftStart(null);
                    setDraftCursor(null);
                    setActiveTool(tool.id);
                  }}
                  aria-label={tool.label}
                  title={tool.label}
                  className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                    active
                      ? 'bg-[#ffb02e]/20 text-[#ffb02e] ring-1 ring-[#ffb02e]/50'
                      : 'text-slate-400 hover:bg-slate-800/70 hover:text-[#e8edfb]'
                  }`}
                >
                  {tool.icon}
                </button>
              );
            })}
          </div>

          <div className="flex flex-col items-center gap-1 border-t border-slate-800/80 pt-2">
            <button
              type="button"
              onClick={() => setMagnetEnabled((m) => !m)}
              aria-label="Magnet Snap to OHLC"
              title="Magnet Snap to Candle OHLC"
              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                magnetEnabled
                  ? 'bg-[#46a6ff]/20 text-[#46a6ff]'
                  : 'text-slate-400 hover:bg-slate-800/70 hover:text-[#e8edfb]'
              }`}
            >
              <Magnet className="h-3.5 w-3.5" />
            </button>

            <button
              type="button"
              onClick={() => setDrawingsHidden((h) => !h)}
              aria-label={drawingsHidden ? 'Show drawings' : 'Hide drawings'}
              title={drawingsHidden ? 'Show all drawings' : 'Hide all drawings'}
              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                drawingsHidden
                  ? 'bg-[#ffb02e]/20 text-[#ffb02e]'
                  : 'text-slate-400 hover:bg-slate-800/70 hover:text-[#e8edfb]'
              }`}
            >
              {drawingsHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>

            <button
              type="button"
              disabled={drawings.length === 0}
              onClick={() => setDrawings((prev) => prev.slice(0, -1))}
              aria-label="Undo last drawing"
              title="Undo last drawing"
              className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800/70 hover:text-[#e8edfb] disabled:opacity-30 disabled:pointer-events-none"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </button>

            <button
              type="button"
              disabled={drawings.length === 0}
              onClick={() => {
                setDrawings([]);
                setDraftStart(null);
                setDraftCursor(null);
              }}
              aria-label="Clear all drawings"
              title="Clear all drawings"
              className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-[#ff4d6d]/15 hover:text-[#ff4d6d] disabled:opacity-30 disabled:pointer-events-none"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </aside>

        {/* Right Side: Live OHLCV + Indicator Legend + Full-Height Canvas + SVG Overlay */}
        <div className="relative flex flex-1 flex-col min-w-0">
          {/* Top Live OHLCV Bar */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-slate-800/70 bg-[#070b14] px-3 py-1.5 text-[11px] font-mono tabular-nums text-slate-400">
            {activeBar ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                <span className="font-semibold text-[#e8edfb]">
                  {symbol || `Market #${marketId}`} · {resolution}
                </span>
                <span className="text-slate-500">{formatDateTime(activeBar.time * 1000)}</span>
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

            {liveMarkPrice && liveMarkPrice > 0 ? (
              <span className="inline-flex items-center gap-1 text-[#22e0a1]">
                <Activity className="h-3 w-3" />
                Live {formatPrice(liveMarkPrice)}
              </span>
            ) : null}
          </div>

          {/* Interactive Indicator Legend Bar (Hide / Edit / Remove directly on chart) */}
          <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-800/50 bg-[#070b14]/90 px-3 py-1 text-[10.5px] font-mono tabular-nums">
            {settings.ema5.enabled && (
              <div
                className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 ${
                  settings.ema5.visible
                    ? 'border-slate-800 bg-[#0b101d] text-slate-200'
                    : 'border-slate-800/60 bg-[#070b14] text-slate-500 opacity-65'
                }`}
              >
                <span className="font-semibold text-slate-300">5 EMA</span>
                {settings.ema5.visible && (
                  <span className="hidden sm:inline-flex items-center gap-1.5">
                    {activeReadouts.emaSlots.map((slot) =>
                      slot.visible && slot.current !== null ? (
                        <span key={slot.id} style={{ color: slot.color }}>
                          {slot.period}:{formatAxisPrice(slot.current)}
                        </span>
                      ) : null
                    )}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setSettings((p) => ({ ...p, ema5: { ...p.ema5, visible: !p.ema5.visible } }))
                  }
                  aria-label={settings.ema5.visible ? 'Hide 5 EMA' : 'Show 5 EMA'}
                  title={settings.ema5.visible ? 'Hide 5 EMA' : 'Show 5 EMA'}
                  className="text-slate-400 hover:text-[#e8edfb]"
                >
                  {settings.ema5.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingKey('ema5')}
                  aria-label="Edit 5 EMA"
                  title="Edit 5 EMA"
                  className="text-slate-400 hover:text-[#ffb02e]"
                >
                  <Settings2 className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => setSettings((p) => ({ ...p, ema5: { ...p.ema5, enabled: false } }))}
                  aria-label="Remove 5 EMA"
                  title="Remove 5 EMA"
                  className="text-slate-500 hover:text-[#ff4d6d]"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}

            {settings.supertrend.enabled && (
              <div
                className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 ${
                  settings.supertrend.visible
                    ? 'border-slate-800 bg-[#0b101d] text-slate-200'
                    : 'border-slate-800/60 bg-[#070b14] text-slate-500 opacity-65'
                }`}
              >
                <span className="font-semibold text-slate-300">
                  Supertrend({settings.supertrend.period},{settings.supertrend.multiplier})
                </span>
                {settings.supertrend.visible && activeReadouts.supertrend && (
                  <span
                    style={{
                      color:
                        activeReadouts.supertrend.direction === 'up'
                          ? settings.supertrend.upColor
                          : settings.supertrend.downColor,
                    }}
                  >
                    {activeReadouts.supertrend.direction === 'up' ? 'BULL' : 'BEAR'}{' '}
                    {formatAxisPrice(activeReadouts.supertrend.value)}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setSettings((p) => ({
                      ...p,
                      supertrend: { ...p.supertrend, visible: !p.supertrend.visible },
                    }))
                  }
                  aria-label={settings.supertrend.visible ? 'Hide Supertrend' : 'Show Supertrend'}
                  title={settings.supertrend.visible ? 'Hide Supertrend' : 'Show Supertrend'}
                  className="text-slate-400 hover:text-[#e8edfb]"
                >
                  {settings.supertrend.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingKey('supertrend')}
                  aria-label="Edit Supertrend"
                  title="Edit Supertrend"
                  className="text-slate-400 hover:text-[#ffb02e]"
                >
                  <Settings2 className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setSettings((p) => ({ ...p, supertrend: { ...p.supertrend, enabled: false } }))
                  }
                  aria-label="Remove Supertrend"
                  title="Remove Supertrend"
                  className="text-slate-500 hover:text-[#ff4d6d]"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}

            {settings.rsi.enabled && (
              <div
                className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 ${
                  settings.rsi.visible
                    ? 'border-slate-800 bg-[#0b101d] text-slate-200'
                    : 'border-slate-800/60 bg-[#070b14] text-slate-500 opacity-65'
                }`}
              >
                <span className="font-semibold text-slate-300">RSI({settings.rsi.period})</span>
                {settings.rsi.visible && activeReadouts.rsi !== null && (
                  <span style={{ color: settings.rsi.color }}>{activeReadouts.rsi.toFixed(1)}</span>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setSettings((p) => ({ ...p, rsi: { ...p.rsi, visible: !p.rsi.visible } }))
                  }
                  aria-label={settings.rsi.visible ? 'Hide RSI' : 'Show RSI'}
                  title={settings.rsi.visible ? 'Hide RSI' : 'Show RSI'}
                  className="text-slate-400 hover:text-[#e8edfb]"
                >
                  {settings.rsi.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingKey('rsi')}
                  aria-label="Edit RSI"
                  title="Edit RSI"
                  className="text-slate-400 hover:text-[#ffb02e]"
                >
                  <Settings2 className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => setSettings((p) => ({ ...p, rsi: { ...p.rsi, enabled: false } }))}
                  aria-label="Remove RSI"
                  title="Remove RSI"
                  className="text-slate-500 hover:text-[#ff4d6d]"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}

            {settings.bb.enabled && (
              <div className="inline-flex items-center gap-1.5 rounded border border-slate-800 bg-[#0b101d] px-1.5 py-0.5 text-slate-300">
                <span>
                  BB({settings.bb.period},{settings.bb.stdDev})
                </span>
                <button
                  type="button"
                  onClick={() => setSettings((p) => ({ ...p, bb: { ...p.bb, visible: !p.bb.visible } }))}
                  aria-label={settings.bb.visible ? 'Hide Bollinger Bands' : 'Show Bollinger Bands'}
                  className="text-slate-400 hover:text-[#e8edfb]"
                >
                  {settings.bb.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingKey('bb')}
                  aria-label="Edit Bollinger Bands"
                  className="text-slate-400 hover:text-[#ffb02e]"
                >
                  <Settings2 className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => setSettings((p) => ({ ...p, bb: { ...p.bb, enabled: false } }))}
                  aria-label="Remove Bollinger Bands"
                  className="text-slate-500 hover:text-[#ff4d6d]"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}

            {settings.macd.enabled && (
              <div className="inline-flex items-center gap-1.5 rounded border border-slate-800 bg-[#0b101d] px-1.5 py-0.5 text-slate-300">
                <span>
                  MACD({settings.macd.fast},{settings.macd.slow},{settings.macd.signal})
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setSettings((p) => ({ ...p, macd: { ...p.macd, visible: !p.macd.visible } }))
                  }
                  aria-label={settings.macd.visible ? 'Hide MACD' : 'Show MACD'}
                  className="text-slate-400 hover:text-[#e8edfb]"
                >
                  {settings.macd.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingKey('macd')}
                  aria-label="Edit MACD"
                  className="text-slate-400 hover:text-[#ffb02e]"
                >
                  <Settings2 className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => setSettings((p) => ({ ...p, macd: { ...p.macd, enabled: false } }))}
                  aria-label="Remove MACD"
                  className="text-slate-500 hover:text-[#ff4d6d]"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>

          {/* Chart Canvas + Synchronized SVG Drawing Layer */}
          <div className="relative flex-1 min-h-[420px]">
            <div ref={chartContainerRef} className="absolute inset-0" />

            {/* Drawing Overlay */}
            <svg
              onMouseMove={handleSvgMouseMove}
              onClick={handleSvgClick}
              className={`absolute inset-0 h-full w-full z-20 ${
                activeTool === 'crosshair' ? 'pointer-events-none' : 'pointer-events-auto cursor-crosshair'
              }`}
            >
              {!drawingsHidden && drawings.map((d) => renderDrawingSvg(d, false))}
              {!drawingsHidden &&
                activeTool !== 'crosshair' &&
                draftStart &&
                draftCursor &&
                renderDrawingSvg(
                  {
                    id: 'draft-preview',
                    type: activeTool,
                    p1: draftStart,
                    p2: draftCursor,
                    color: '#ffb02e',
                  },
                  true
                )}
            </svg>

            {bars.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-400 pointer-events-none">
                No candle data available for this interval.
              </div>
            )}
          </div>
        </div>

        {/* Indicator Settings Editor Modal */}
        {editingKey && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
            <div className="w-full max-w-md rounded-xl border border-slate-700 bg-[#0b1120] p-4 shadow-2xl">
              <div className="mb-3 flex items-center justify-between border-b border-slate-800 pb-2.5">
                <h3 className="font-display text-sm font-bold text-[#e8edfb]">
                  {editingKey === 'ema5' && 'Edit 5 EMA Ribbon'}
                  {editingKey === 'supertrend' && 'Edit Supertrend Settings'}
                  {editingKey === 'rsi' && 'Edit RSI Settings'}
                  {editingKey === 'sma' && 'Edit SMA Settings'}
                  {editingKey === 'bb' && 'Edit Bollinger Bands'}
                  {editingKey === 'macd' && 'Edit MACD Settings'}
                </h3>
                <button
                  type="button"
                  onClick={() => setEditingKey(null)}
                  aria-label="Close indicator settings"
                  className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-[#e8edfb]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {editingKey === 'ema5' && (
                <div className="space-y-2.5 text-xs">
                  {settings.ema5.slots.map((slot, idx) => (
                    <div
                      key={slot.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-[#070b14] px-2.5 py-2"
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setSettings((p) => ({
                            ...p,
                            ema5: {
                              ...p.ema5,
                              slots: p.ema5.slots.map((s, i) =>
                                i === idx ? { ...s, visible: !s.visible } : s
                              ),
                            },
                          }))
                        }
                        aria-label={`Toggle EMA slot ${idx + 1}`}
                        className="text-slate-300 hover:text-[#ffb02e]"
                      >
                        {slot.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5 text-slate-500" />}
                      </button>

                      <span className="font-mono text-slate-400 w-12">EMA {idx + 1}</span>

                      <input
                        type="number"
                        min={2}
                        max={500}
                        aria-label={`EMA ${idx + 1} length`}
                        value={slot.period}
                        onChange={(e) => {
                          const val = Math.max(2, Math.min(500, Number(e.target.value) || 2));
                          setSettings((p) => ({
                            ...p,
                            ema5: {
                              ...p.ema5,
                              slots: p.ema5.slots.map((s, i) => (i === idx ? { ...s, period: val } : s)),
                            },
                          }));
                        }}
                        className="w-20 rounded border border-slate-700 bg-[#0b1120] px-2 py-1 font-mono text-xs text-[#e8edfb]"
                      />

                      <div className="flex items-center gap-1">
                        {COLOR_PRESETS.slice(0, 5).map((col) => (
                          <button
                            key={col}
                            type="button"
                            onClick={() =>
                              setSettings((p) => ({
                                ...p,
                                ema5: {
                                  ...p.ema5,
                                  slots: p.ema5.slots.map((s, i) =>
                                    i === idx ? { ...s, color: col } : s
                                  ),
                                },
                              }))
                            }
                            aria-label={`Set EMA ${idx + 1} color ${col}`}
                            className={`h-4 w-4 rounded-sm ${slot.color === col ? 'ring-2 ring-white' : ''}`}
                            style={{ backgroundColor: col }}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {editingKey === 'supertrend' && (
                <div className="space-y-3 text-xs">
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block space-y-1">
                      <span className="text-slate-400">ATR Length</span>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={settings.supertrend.period}
                        onChange={(e) =>
                          setSettings((p) => ({
                            ...p,
                            supertrend: {
                              ...p.supertrend,
                              period: Math.max(1, Math.min(100, Number(e.target.value) || 10)),
                            },
                          }))
                        }
                        className="w-full rounded border border-slate-700 bg-[#070b14] px-2.5 py-1.5 font-mono text-[#e8edfb]"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-slate-400">Factor / Multiplier</span>
                      <input
                        type="number"
                        step={0.5}
                        min={0.5}
                        max={10}
                        value={settings.supertrend.multiplier}
                        onChange={(e) =>
                          setSettings((p) => ({
                            ...p,
                            supertrend: {
                              ...p.supertrend,
                              multiplier: Math.max(0.5, Math.min(10, Number(e.target.value) || 3)),
                            },
                          }))
                        }
                        className="w-full rounded border border-slate-700 bg-[#070b14] px-2.5 py-1.5 font-mono text-[#e8edfb]"
                      />
                    </label>
                  </div>
                </div>
              )}

              {editingKey === 'rsi' && (
                <div className="space-y-3 text-xs">
                  <div className="grid grid-cols-3 gap-2.5">
                    <label className="block space-y-1">
                      <span className="text-slate-400">RSI Period</span>
                      <input
                        type="number"
                        min={2}
                        max={100}
                        value={settings.rsi.period}
                        onChange={(e) =>
                          setSettings((p) => ({
                            ...p,
                            rsi: { ...p.rsi, period: Math.max(2, Math.min(100, Number(e.target.value) || 14)) },
                          }))
                        }
                        className="w-full rounded border border-slate-700 bg-[#070b14] px-2.5 py-1.5 font-mono text-[#e8edfb]"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-slate-400">Overbought</span>
                      <input
                        type="number"
                        min={55}
                        max={95}
                        value={settings.rsi.overbought}
                        onChange={(e) =>
                          setSettings((p) => ({
                            ...p,
                            rsi: { ...p.rsi, overbought: Math.max(55, Math.min(95, Number(e.target.value) || 70)) },
                          }))
                        }
                        className="w-full rounded border border-slate-700 bg-[#070b14] px-2.5 py-1.5 font-mono text-[#e8edfb]"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-slate-400">Oversold</span>
                      <input
                        type="number"
                        min={5}
                        max={45}
                        value={settings.rsi.oversold}
                        onChange={(e) =>
                          setSettings((p) => ({
                            ...p,
                            rsi: { ...p.rsi, oversold: Math.max(5, Math.min(45, Number(e.target.value) || 30)) },
                          }))
                        }
                        className="w-full rounded border border-slate-700 bg-[#070b14] px-2.5 py-1.5 font-mono text-[#e8edfb]"
                      />
                    </label>
                  </div>
                </div>
              )}

              {editingKey === 'sma' && (
                <div className="space-y-3 text-xs">
                  <label className="block space-y-1">
                    <span className="text-slate-400">SMA Period</span>
                    <input
                      type="number"
                      min={2}
                      max={300}
                      value={settings.sma.period}
                      onChange={(e) =>
                        setSettings((p) => ({
                          ...p,
                          sma: { ...p.sma, period: Math.max(2, Math.min(300, Number(e.target.value) || 20)) },
                        }))
                      }
                      className="w-full rounded border border-slate-700 bg-[#070b14] px-2.5 py-1.5 font-mono text-[#e8edfb]"
                    />
                  </label>
                </div>
              )}

              {editingKey === 'bb' && (
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <label className="block space-y-1">
                    <span className="text-slate-400">BB Period</span>
                    <input
                      type="number"
                      min={5}
                      max={200}
                      value={settings.bb.period}
                      onChange={(e) =>
                        setSettings((p) => ({
                          ...p,
                          bb: { ...p.bb, period: Math.max(5, Math.min(200, Number(e.target.value) || 20)) },
                        }))
                      }
                      className="w-full rounded border border-slate-700 bg-[#070b14] px-2.5 py-1.5 font-mono text-[#e8edfb]"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-slate-400">StdDev Multiplier</span>
                    <input
                      type="number"
                      step={0.5}
                      min={0.5}
                      max={5}
                      value={settings.bb.stdDev}
                      onChange={(e) =>
                        setSettings((p) => ({
                          ...p,
                          bb: { ...p.bb, stdDev: Math.max(0.5, Math.min(5, Number(e.target.value) || 2)) },
                        }))
                      }
                      className="w-full rounded border border-slate-700 bg-[#070b14] px-2.5 py-1.5 font-mono text-[#e8edfb]"
                    />
                  </label>
                </div>
              )}

              {editingKey === 'macd' && (
                <div className="grid grid-cols-3 gap-2.5 text-xs">
                  <label className="block space-y-1">
                    <span className="text-slate-400">Fast</span>
                    <input
                      type="number"
                      min={2}
                      max={50}
                      value={settings.macd.fast}
                      onChange={(e) =>
                        setSettings((p) => ({
                          ...p,
                          macd: { ...p.macd, fast: Math.max(2, Math.min(50, Number(e.target.value) || 12)) },
                        }))
                      }
                      className="w-full rounded border border-slate-700 bg-[#070b14] px-2.5 py-1.5 font-mono text-[#e8edfb]"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-slate-400">Slow</span>
                    <input
                      type="number"
                      min={5}
                      max={100}
                      value={settings.macd.slow}
                      onChange={(e) =>
                        setSettings((p) => ({
                          ...p,
                          macd: { ...p.macd, slow: Math.max(5, Math.min(100, Number(e.target.value) || 26)) },
                        }))
                      }
                      className="w-full rounded border border-slate-700 bg-[#070b14] px-2.5 py-1.5 font-mono text-[#e8edfb]"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-slate-400">Signal</span>
                    <input
                      type="number"
                      min={2}
                      max={50}
                      value={settings.macd.signal}
                      onChange={(e) =>
                        setSettings((p) => ({
                          ...p,
                          macd: { ...p.macd, signal: Math.max(2, Math.min(50, Number(e.target.value) || 9)) },
                        }))
                      }
                      className="w-full rounded border border-slate-700 bg-[#070b14] px-2.5 py-1.5 font-mono text-[#e8edfb]"
                    />
                  </label>
                </div>
              )}

              <div className="mt-4 flex items-center justify-between border-t border-slate-800 pt-3">
                <button
                  type="button"
                  onClick={() =>
                    setSettings((p) => ({
                      ...p,
                      [editingKey]: DEFAULT_SETTINGS[editingKey],
                    }))
                  }
                  className="text-xs text-slate-400 hover:text-[#e8edfb]"
                >
                  Reset Defaults
                </button>
                <button
                  type="button"
                  onClick={() => setEditingKey(null)}
                  className="rounded-lg bg-[#ffb02e] px-3.5 py-1.5 text-xs font-semibold text-[#1f0e03] hover:brightness-110"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
