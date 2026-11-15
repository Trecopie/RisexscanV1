import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { MarketTrade } from '../types/risex';
import {
  applyWsBatchToMarkets,
  mergeSnapshotWithRecentOracle,
  parseWsMarketMessage,
  type MarketWithStats,
  type OrderbookCache,
  type ParsedWsMarketFrame,
  type TimedOracleQuote,
} from '../utils/marketWsPatch';

const RISEX_WS_URL = 'wss://ws.rise.trade/ws';
const MARKETS_CACHE_KEY = 'risexscan_markets_cache_v1';
const FLUSH_INTERVAL_MS = 250;

export type WsConnectionState = 'connecting' | 'connected' | 'reconnecting';

interface MarketWebSocketContextValue {
  markets: MarketWithStats[];
  recentTrades: MarketTrade[];
  connectionState: WsConnectionState;
  loading: boolean;
  error: string | null;
  refreshSnapshot: () => Promise<void>;
}

const MarketWebSocketContext = createContext<MarketWebSocketContextValue | null>(null);

function readCachedMarkets(): MarketWithStats[] {
  try {
    const raw = sessionStorage.getItem(MARKETS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const MarketWebSocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [markets, setMarkets] = useState<MarketWithStats[]>(() => readCachedMarkets());
  const [recentTrades, setRecentTrades] = useState<MarketTrade[]>([]);
  const [connectionState, setConnectionState] = useState<WsConnectionState>('connecting');
  const [loading, setLoading] = useState<boolean>(() => readCachedMarkets().length === 0);
  const [error, setError] = useState<string | null>(null);

  const marketsRef = useRef<MarketWithStats[]>(markets);
  marketsRef.current = markets;

  const bookCacheRef = useRef<OrderbookCache>(new Map());
  const oracleQuotesRef = useRef(new Map<string, TimedOracleQuote>());
  const frameQueueRef = useRef<ParsedWsMarketFrame[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const subscribedKeyRef = useRef<string>('');
  const snapshotAbortRef = useRef<AbortController | null>(null);
  const disposedRef = useRef(false);

  const flushQueuedFrames = useCallback(() => {
    flushTimerRef.current = null;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const batch = frameQueueRef.current;
    if (batch.length === 0) return;
    frameQueueRef.current = [];
    const now = Date.now();
    for (const frame of batch) {
      if (frame.kind === 'oracle') {
        const existing = oracleQuotesRef.current.get(frame.marketId);
        oracleQuotesRef.current.set(frame.marketId, {
          receivedAt: now,
          markPrice: frame.markPrice ?? existing?.markPrice,
          indexPrice: frame.indexPrice ?? existing?.indexPrice,
        });
      }
    }

    const { markets: nextMarkets, trades, changed } = applyWsBatchToMarkets(
      marketsRef.current,
      bookCacheRef.current,
      batch
    );

    if (changed) {
      marketsRef.current = nextMarkets;
      setMarkets(nextMarkets);
    }

    if (trades.length > 0) {
      setRecentTrades((prev) => {
        const seen = new Set(prev.map((t) => t.id));
        const uniqueFresh = trades.filter((t) => !seen.has(t.id));
        if (uniqueFresh.length === 0) return prev;
        return [...uniqueFresh.reverse(), ...prev].slice(0, 40);
      });
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current !== null || rafRef.current !== null) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        flushQueuedFrames();
      });
    }, FLUSH_INTERVAL_MS);
  }, [flushQueuedFrames]);

  const sendSubscriptions = useCallback((ws: WebSocket, list: MarketWithStats[]) => {
    if (ws.readyState !== WebSocket.OPEN || list.length === 0) return;

    // Stable market-ID ordering prevents duplicate subscriptions whenever
    // rolling 24h volume changes the relative volume leaderboard order.
    const allIds = list
      .filter((m) => m.active !== false)
      .map((m) => Number(m.market_id))
      .filter((id) => Number.isInteger(id) && id >= 0)
      .sort((a, b) => a - b);
    if (allIds.length === 0) return;

    const key = allIds.join(',');
    if (subscribedKeyRef.current === key) return;
    subscribedKeyRef.current = key;

    // Subscribe only to data the global UI consumes. L2 depth is handled by
    // the currently opened ticker detail, avoiding 20 unused orderbook streams.
    ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'oracle' } }));
    ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'trades', market_ids: allIds } }));
    ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'funding', market_ids: allIds } }));
  }, []);

  const refreshSnapshot = useCallback(async () => {
    snapshotAbortRef.current?.abort();
    const controller = new AbortController();
    snapshotAbortRef.current = controller;

    try {
      const res = await fetch('/api/markets', { signal: controller.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Markets error (${res.status})`);
      if (controller.signal.aborted || disposedRef.current) return;

      if (Array.isArray(data?.markets)) {
        // Preserve an oracle tick received after REST assembled its snapshot.
        // Expired quotes automatically give way to fresh REST pricing.
        const merged = mergeSnapshotWithRecentOracle(data.markets, oracleQuotesRef.current);
        marketsRef.current = merged;
        setMarkets(merged);
        setError(null);
        try {
          sessionStorage.setItem(MARKETS_CACHE_KEY, JSON.stringify(data.markets));
        } catch {
          // ignore storage quota errors
        }

        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          // Re-subscribe only when the market-id set has actually changed.
          sendSubscriptions(wsRef.current, data.markets);
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError' || disposedRef.current) return;
      setError(err?.message || 'Failed to sync market snapshot');
    } finally {
      if (!controller.signal.aborted && !disposedRef.current) {
        setLoading(false);
      }
    }
  }, [sendSubscriptions]);

  useEffect(() => {
    disposedRef.current = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    // Initial HTTP snapshot bootstrap; WS handles price updates, slower snapshots
    // reconcile rolling 24h volume, funding, and indexed position counts.
    refreshSnapshot();
    const reconcileTimer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshSnapshot();
    }, 60_000);

    const onVisible = () => {
      if (document.visibilityState === 'hidden') {
        // No background WebSocket message handling or reconnection churn.
        wsRef.current?.close();
      } else {
        void refreshSnapshot();
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (!wsRef.current) connectWs();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    const connectWs = () => {
      if (disposedRef.current || document.visibilityState === 'hidden') return;
      if (wsRef.current &&
          (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) return;
      setConnectionState(attempt === 0 ? 'connecting' : 'reconnecting');

      try {
        const ws = new WebSocket(RISEX_WS_URL);
        wsRef.current = ws;

        ws.onopen = () => {
          if (disposedRef.current) {
            ws.close();
            return;
          }
          const wasReconnect = attempt > 0;
          attempt = 0;
          setConnectionState('connected');
          subscribedKeyRef.current = '';
          sendSubscriptions(ws, marketsRef.current);

          // Reconcile baseline snapshot once upon reconnect
          if (wasReconnect) {
            refreshSnapshot();
          }
        };

        ws.onmessage = (ev) => {
          if (disposedRef.current || document.visibilityState === 'hidden') return;
          try {
            const parsed = JSON.parse(String(ev.data));
            const frames = parseWsMarketMessage(parsed);
            if (frames.length > 0) {
              frameQueueRef.current.push(...frames);
              scheduleFlush();
            }
          } catch {
            // ignore malformed WS frames
          }
        };

        ws.onclose = () => {
          if (wsRef.current === ws) wsRef.current = null;
          if (disposedRef.current) return;
          setConnectionState('reconnecting');
          if (document.visibilityState === 'hidden') return;
          const delay = Math.min(30000, 1500 * Math.pow(2, attempt++));
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectWs();
          }, delay);
        };

        ws.onerror = () => {
          try {
            ws.close();
          } catch {
            // ignore
          }
        };
      } catch {
        if (!disposedRef.current) {
          setConnectionState('reconnecting');
          const delay = Math.min(30000, 1500 * Math.pow(2, attempt++));
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectWs();
          }, delay);
        }
      }
    };

    connectWs();

    return () => {
      disposedRef.current = true;
      snapshotAbortRef.current?.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(reconcileTimer);
      document.removeEventListener('visibilitychange', onVisible);
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      try {
        wsRef.current?.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    };
  }, [refreshSnapshot, scheduleFlush, sendSubscriptions]);

  const value = useMemo<MarketWebSocketContextValue>(
    () => ({
      markets,
      recentTrades,
      connectionState,
      loading,
      error,
      refreshSnapshot,
    }),
    [markets, recentTrades, connectionState, loading, error, refreshSnapshot]
  );

  return <MarketWebSocketContext.Provider value={value}>{children}</MarketWebSocketContext.Provider>;
};

export function useMarketStream(): MarketWebSocketContextValue {
  const ctx = useContext(MarketWebSocketContext);
  if (!ctx) {
    throw new Error('useMarketStream must be used within a MarketWebSocketProvider');
  }
  return ctx;
}
