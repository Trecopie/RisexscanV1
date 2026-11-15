import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { nsToMs } from './src/utils/format.ts';
import { calcRoiPct, reconstructTradeLifecycles, safeNum, summarizeRealizedEvents } from './src/utils/tradeLifecycle.ts';
import {
  buildConsistentPnlSeries,
  computeRolling24hPnl,
  computeUtcPeriodPnl,
  normalizeCalendarAndPeriodMetrics,
  reconstructAccountEquitySeries,
} from './src/utils/portfolioCurves.ts';
import { buildCohortsAnalytics, classifyTraderCohort } from './src/utils/cohorts.ts';
import { computeProfitabilitySummary } from './src/utils/overviewAnalytics.ts';
import { extractWalletAddressesFromLogs, selectIndexerQueue } from './src/utils/indexerQueue.ts';
import { buildTraderSyncDiagnostic } from './src/utils/pnlDiagnostic.ts';
import { LIQUIDATION_ALERT_PCT, LIQUIDATION_CANDIDATE_PCT, liquidationDistancePct } from './src/utils/liquidationRisk.ts';
import { normalizeRpcBlocks } from './src/utils/liveChain.ts';
import { HistoryStore, type ObservedTradeRecord } from './src/utils/historyStore.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RISEX_API = 'https://api.rise.trade';
const RISE_RPC = 'https://rpc.risechain.com/';
const RISE_EXPLORER_API = 'https://explorer.risechain.com/api/v2';
const CACHE_FILE = path.join(__dirname, '.risex-index-cache.json');

let activeInteractiveRequests = 0;

async function fetchJson(url: string, options: RequestInit = {}, timeoutMs = 10000, retries = 1): Promise<any> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(options.headers || {}),
        },
      });
      if (res.status === 429 && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        const waitMs = Math.min(2500, Math.max(700, retryAfter * 1000));
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

interface PositionRow {
  address: string;
  username?: string | null;
  avatarUrl?: string | null;
  portfolioValue: number;
  accountLeverage: number;
  marketId: string;
  marketName: string;
  side: 'LONG' | 'SHORT';
  size: number;
  notionalUsd: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  leverage: number;
  unrealizedPnl: number;
  realizedPnl?: number | null;
  realizedPnlComplete?: boolean;
  roiPct: number;
  marginBalance: number;
  marginMode: 'Cross' | 'Isolated';
}

interface TraderRecord {
  address: string;
  username: string | null;
  avatarUrl: string | null;
  xHandle: string | null;
  accountValue: number;
  usdcBalance: number;
  totalNotional: number;
  accountLeverage: number;
  marginUsagePct: number;
  unrealizedPnl: number;
  realizedPnlAll: number;
  totalPnlAll: number;
  roiAllPct: number;
  pnl24h: number | null;
  pnl7d: number | null;
  pnl30d: number | null;
  roi24hPct: number | null;
  roi7dPct: number | null;
  roi30dPct: number | null;
  volume24h: number;
  volume7d: number;
  volume30d: number;
  volumeAll: number;
  volumeRank24h: number;
  volumeRankAll: number;
  winRate: number | null;
  sharpeRatio: number | null;
  maxDrawdown: number | null;
  profitFactor: number | null;
  openPositionsCount: number;
  positions: PositionRow[];
  riskLevel: string;
  inLiquidation: boolean;
  portfolioEnriched: boolean;
  lastUpdated: number;
  sources: string[];
}

// In-memory store
let marketsCache: any[] = [];
let marketsUpdatedAt = 0;
let lastMarketHistorySample = 0;
let lastPositionHistorySample = 0;
let tradeFeedConnected = false;
let lastObservedTradeAt = 0;
let droppedTradeEvents = 0;
let systemConfigCache: any = null;
const tradersMap = new Map<string, TraderRecord>();
const historyStore = new HistoryStore();
const changedTraders = new Set<string>();

function putTrader(address: string, row: TraderRecord) {
  const key = address.toLowerCase();
  tradersMap.set(key, row);
  changedTraders.add(key);
}

const customSearchedWallets = new Set<string>();
let isIndexing = false;
let lastIndexComplete = 0;
let authCursor: Record<string, any> | null = null;
let cmCursor: Record<string, any> | null = null;
let authBackfillComplete = false;
let cmBackfillComplete = false;

// Generic bounded TTL + Stale-While-Revalidate cache with single-flight request coalescing
interface CacheEntry<T> {
  value: T;
  freshUntil: number;
  staleUntil: number;
}
const apiResponseCache = new Map<string, CacheEntry<any>>();
const apiInFlight = new Map<string, Promise<any>>();

async function cachedCallSWR<T>(
  key: string,
  freshTtlMs: number,
  staleTtlMs: number,
  loader: () => Promise<T>,
  maxEntries = 400
): Promise<T> {
  const now = Date.now();
  const hit = apiResponseCache.get(key);
  if (hit && hit.freshUntil > now) {
    return hit.value as T;
  }

  const refresh = (): Promise<T> => {
    const pending = apiInFlight.get(key);
    if (pending) return pending as Promise<T>;

    const promise = loader()
      .then((value) => {
        if (apiResponseCache.size >= maxEntries) {
          const oldestKey = apiResponseCache.keys().next().value;
          if (oldestKey !== undefined) apiResponseCache.delete(oldestKey);
        }
        const t = Date.now();
        apiResponseCache.set(key, {
          value,
          freshUntil: t + freshTtlMs,
          staleUntil: t + Math.max(freshTtlMs, staleTtlMs),
        });
        return value;
      })
      .finally(() => {
        apiInFlight.delete(key);
      });

    apiInFlight.set(key, promise);
    return promise;
  };

  if (hit && hit.staleUntil > now) {
    refresh().catch(() => {});
    return hit.value as T;
  }

  return refresh();
}

async function cachedCall<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  maxEntries = 400
): Promise<T> {
  return cachedCallSWR(key, ttlMs, ttlMs, loader, maxEntries);
}

function invalidateLeaderboardAndCohortCaches() {
  for (const k of Array.from(apiResponseCache.keys())) {
    if (k.startsWith('leaderboard:') || k === 'cohorts:analytics') {
      apiResponseCache.delete(k);
    }
  }
}

async function resolveAddressOrUsername(
  rawParam: string
): Promise<{ address: string; traderProfile: any | null } | null> {
  const clean = rawParam.trim();
  if (!clean) return null;
  if (/^0x[a-fA-F0-9]{40}$/.test(clean)) {
    return { address: clean, traderProfile: null };
  }
  const localMatch = Array.from(tradersMap.values()).find(
    (t) => t.username && t.username.toLowerCase() === clean.toLowerCase()
  );
  if (localMatch) {
    return { address: localMatch.address, traderProfile: null };
  }
  try {
    const tr = await fetchJson(`${RISEX_API}/v1/traders/${encodeURIComponent(clean)}`);
    if (tr?.data?.address && /^0x[a-fA-F0-9]{40}$/.test(tr.data.address)) {
      return { address: tr.data.address, traderProfile: tr.data };
    }
  } catch {
    return null;
  }
  return null;
}

function loadDiskCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.traders)) {
      const staleVersion = parsed.cacheVersion !== 3;
      for (const t of parsed.traders) {
        if (t?.address) {
          tradersMap.set(
            t.address.toLowerCase(),
            staleVersion ? { ...t, lastUpdated: 0 } : t
          );
        }
      }
      lastIndexComplete = parsed.lastIndexComplete || 0;
      authCursor = parsed.authCursor || null;
      cmCursor = parsed.cmCursor || null;
      authBackfillComplete = Boolean(parsed.authBackfillComplete);
      cmBackfillComplete = Boolean(parsed.cmBackfillComplete);
      console.log(`Loaded ${tradersMap.size} cached RISEx traders from disk`);
    }
  } catch {
    // ignore corrupt cache
  }
}

let persistQueue = Promise.resolve();
function saveDiskCache() {
  const metadata = {
    cacheVersion: 3,
    lastIndexComplete,
    authCursor,
    cmCursor,
    authBackfillComplete,
    cmBackfillComplete,
  };
  if (historyStore.ready) {
    const dirtyKeys = [...changedTraders];
    changedTraders.clear();
    const records = dirtyKeys.map((key) => tradersMap.get(key)).filter((t):t is TraderRecord=>Boolean(t));
    persistQueue = persistQueue
      .then(async () => {
        await historyStore.upsertTraders(records);
        await historyStore.saveState(metadata);
      })
      .catch((err) => {
        for (const key of dirtyKeys) changedTraders.add(key);
        console.error('Persistent index save failed:', err);
      });
    return;
  }
  try {
    const payload = {...metadata,traders:Array.from(tradersMap.values())};
    const tmpFile = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(payload));
    fs.renameSync(tmpFile, CACHE_FILE);
  } catch {
    // ephemeral local fallback; PostgreSQL is required for durable history.
  }
}

async function restoreIndexAtStartup():Promise<void>{
  await historyStore.initialize();
  if (!historyStore.ready) {
    loadDiskCache();
    return;
  }
  try {
    const state=await historyStore.loadState();
    if (state) {
      lastIndexComplete=Number(state.lastIndexComplete||0);
      authCursor=state.authCursor||null;
      cmCursor=state.cmCursor||null;
      authBackfillComplete=Boolean(state.authBackfillComplete);
      cmBackfillComplete=Boolean(state.cmBackfillComplete);
    }
    const count=await historyStore.loadTraders((rows) => {
      for (const trader of rows) {
        if (trader?.address) tradersMap.set(trader.address.toLowerCase(),trader as TraderRecord);
      }
    });
    // First DB-enabled deployment may have an existing local checkpoint. Import
    // it once rather than throwing away a previously discovered wallet universe.
    if (count === 0 && fs.existsSync(CACHE_FILE)) {
      loadDiskCache();
      for (const key of tradersMap.keys()) changedTraders.add(key);
      saveDiskCache();
      console.log(`Importing ${tradersMap.size} historical wallet records into PostgreSQL`);
    } else {
      console.log(`Restored ${count} traders from persistent PostgreSQL index`);
    }
  } catch(err) {
    console.error('Postgres restore failed; using local fallback:',err);
    loadDiskCache();
  }
}

async function getMarkets(force = false): Promise<any[]> {
  if (!force && marketsCache.length > 0 && Date.now() - marketsUpdatedAt < 15000) {
    return marketsCache;
  }
  const json = await fetchJson(`${RISEX_API}/v1/markets`);
  const list = json?.data?.markets || [];
  if (list.length > 0) {
    marketsCache = list;
    marketsUpdatedAt = Date.now();
    if (historyStore.ready && Date.now() - lastMarketHistorySample > 3_600_000) {
      lastMarketHistorySample = Date.now();
      const sampledAt = lastMarketHistorySample;
      const samples = list.filter((m:any) => m.active !== false)
        .map((m:any) => ({
          marketId:String(m.market_id),
          observedAt:sampledAt,
          openInterestUsd:safeNum(m.open_interest)*safeNum(m.mark_price || m.last_price),
          volume24hUsd:safeNum(m.quote_volume_24h),
          fundingRate:safeNum(m.current_funding_rate),
          markPrice:safeNum(m.mark_price || m.last_price),
        }));
      historyStore.recordMarketSamples(samples).catch((err) => {
        lastMarketHistorySample = 0;
        console.error('Market sample persistence warning:',err);
      });
    }
  }
  return marketsCache;
}

async function getSystemConfig(): Promise<any> {
  if (systemConfigCache) return systemConfigCache;
  const json = await fetchJson(`${RISEX_API}/v1/system/config`);
  systemConfigCache = json?.data || null;
  return systemConfigCache;
}

function seedDiscoveredTrader(
  address: string,
  meta: {
    username?: string | null;
    avatarUrl?: string | null;
    xHandle?: string | null;
    realizedPnl?: number;
    volume?: number;
    winRate?: number | null;
    source: string;
  }
) {
  const key = address.trim().toLowerCase();
  const existing = tradersMap.get(key);
  if (existing) {
    if (meta.username && !existing.username) existing.username = meta.username;
    if (meta.avatarUrl && !existing.avatarUrl) existing.avatarUrl = meta.avatarUrl;
    if (meta.xHandle && !existing.xHandle) existing.xHandle = meta.xHandle;
    if (meta.volume && meta.volume > existing.volumeAll) existing.volumeAll = meta.volume;
    if (meta.realizedPnl !== undefined && !existing.portfolioEnriched && Math.abs(meta.realizedPnl) > Math.abs(existing.realizedPnlAll)) {
      existing.realizedPnlAll = meta.realizedPnl;
      existing.totalPnlAll = meta.realizedPnl;
    }
    if (!existing.sources.includes(meta.source)) existing.sources.push(meta.source);
    changedTraders.add(key);
    return;
  }

  const rPnl = meta.realizedPnl ?? 0;
  putTrader(key, {
    address: address.trim(),
    username: meta.username || null,
    avatarUrl: meta.avatarUrl || null,
    xHandle: meta.xHandle || null,
    accountValue: 0,
    usdcBalance: 0,
    totalNotional: 0,
    accountLeverage: 0,
    marginUsagePct: 0,
    unrealizedPnl: 0,
    realizedPnlAll: rPnl,
    totalPnlAll: rPnl,
    roiAllPct: 0,
    pnl24h: null,
    pnl7d: null,
    pnl30d: null,
    roi24hPct: null,
    roi7dPct: null,
    roi30dPct: null,
    volume24h: 0,
    volume7d: 0,
    volume30d: 0,
    volumeAll: meta.volume || 0,
    volumeRank24h: 0,
    volumeRankAll: 0,
    winRate: meta.winRate ?? null,
    sharpeRatio: null,
    maxDrawdown: null,
    profitFactor: null,
    openPositionsCount: 0,
    positions: [],
    riskLevel: 'NORMAL',
    inLiquidation: false,
    portfolioEnriched: false,
    lastUpdated: 0,
    sources: [meta.source],
  });
}

async function enrichWallet(address: string, sourceTag: string): Promise<TraderRecord | null> {
  const norm = address.trim();
  const key = norm.toLowerCase();
  const existing = tradersMap.get(key);

  try {
    const calls: Promise<any>[] = [
      fetchJson(`${RISEX_API}/v1/portfolio/details?account=${norm}`, {}, 10000, 2),
      fetchJson(`${RISEX_API}/v1/portfolio/header?account=${norm}`, {}, 10000, 2),
      fetchJson(`${RISEX_API}/v1/portfolio/stats?account=${norm}&period=30d`),
      fetchJson(`${RISEX_API}/v1/portfolio/pnl-calendar?account=${norm}&period=1m`, {}, 10000, 2),
      fetchJson(`${RISEX_API}/v1/portfolio/chart?account=${norm}&period=1D`, {}, 10000, 2),
    ];
    // Fetch RISEx account profile/username if we don't already have it
    const needProfile = !existing?.username;
    if (needProfile) {
      calls.push(fetchJson(`${RISEX_API}/v1/traders/${norm}`));
    }

    const [detailsRes, headerRes, statsRes, calRes, chart1DRes, profileRes] = await Promise.allSettled(calls);

    const details = detailsRes.status === 'fulfilled' ? detailsRes.value?.data : null;
    if (!details || !details.summary) return null;

    const summary = details.summary;
    const rawPositions: any[] = details.positions || [];
    const header = headerRes.status === 'fulfilled' ? headerRes.value?.data : null;
    const stats = statsRes.status === 'fulfilled' ? statsRes.value?.data : null;
    const cal = calRes.status === 'fulfilled' ? calRes.value?.data : null;
    const chart1D = chart1DRes.status === 'fulfilled' ? chart1DRes.value?.data : null;
    const traderProf = profileRes && profileRes.status === 'fulfilled' ? profileRes.value?.data : null;

    const username = traderProf?.username || existing?.username || null;
    const avatarUrl =
      traderProf?.avatar_url ||
      traderProf?.x_account?.profile_image_url ||
      existing?.avatarUrl ||
      null;
    const xHandle = traderProf?.x_account?.username || existing?.xHandle || null;

    const accountValue = safeNum(summary.total_account_value);
    const usdcBalance = safeNum(summary.usdc_balance);
    const totalNotional = safeNum(summary.total_notional);
    const accountLeverage = safeNum(summary.account_leverage);
    const marginUsagePct = safeNum(summary.margin_usage) * 100;
    const unrealizedPnl = safeNum(summary.total_unrealized_pnl);
    const realizedPnlAll = safeNum(summary.realized_pnl);
    const totalPnlAll = realizedPnlAll + unrealizedPnl;
    const roiAllPct = calcRoiPct(totalPnlAll, accountValue);

    const positions: PositionRow[] = [];
    for (const p of rawPositions) {
      const sz = safeNum(p.size);
      if (Math.abs(sz) === 0) continue;
      const markPrice = safeNum(p.mark_price);
      const entryPrice = safeNum(p.avg_entry_price);
      const notionalUsd = Math.abs(sz) * markPrice;
      const uPnl = safeNum(p.unrealized_pnl);
      const lev = safeNum(p.leverage);
      const marginBal = safeNum(p.margin_balance) || (lev > 0 ? notionalUsd / lev : notionalUsd);
      const posRoi = marginBal > 0 ? (uPnl / marginBal) * 100 : 0;

      positions.push({
        address: details.account || norm,
        username,
        avatarUrl,
        portfolioValue: accountValue,
        accountLeverage,
        marketId: String(p.market_id),
        marketName: p.market_name || `Market #${p.market_id}`,
        side: sz > 0 ? 'LONG' : 'SHORT',
        size: Math.abs(sz),
        notionalUsd,
        entryPrice,
        markPrice,
        liquidationPrice: safeNum(p.liquidation_price),
        leverage: lev,
        unrealizedPnl: uPnl,
        roiPct: posRoi,
        marginBalance: marginBal,
        marginMode: p.margin_mode === 1 ? 'Isolated' : 'Cross',
      });
    }

    const days: { date: string; pnl: string }[] = cal?.days || [];
    const nowMs = Date.now();
    const chart1DPoints: any[] = chart1D?.data || [];
    let realizedFallback: any[] = [];
    if (chart1DPoints.length < 2) {
      const rpRes = await fetchJson(
        `${RISEX_API}/v1/portfolio/realized-pnl?account=${norm}&limit=1000&page=1`
      ).catch(() => null);
      realizedFallback = rpRes?.data?.data || [];
    }
    const { pnl7d, pnl30d } = computeUtcPeriodPnl(days, realizedFallback, nowMs);
    const pnl24h = computeRolling24hPnl({
      upstreamPnl1D: chart1DPoints,
      realizedEvents: realizedFallback,
      calDays: days,
      nowMs,
    });

    const perf = stats?.performance;
    const winRate =
      perf?.win_rate !== undefined && perf?.win_rate !== ''
        ? safeNum(perf.win_rate) * 100
        : existing?.winRate ?? null;
    const sharpeRatio =
      perf?.sharpe_ratio !== undefined && perf?.sharpe_ratio !== ''
        ? safeNum(perf.sharpe_ratio)
        : null;
    const maxDrawdown =
      perf?.max_drawdown !== undefined && perf?.max_drawdown !== ''
        ? safeNum(perf.max_drawdown) * 100
        : null;
    const profitFactor =
      perf?.profit_factor && perf.profit_factor !== 'Infinity'
        ? safeNum(perf.profit_factor)
        : null;

    const sources = Array.from(new Set([...(existing?.sources || []), sourceTag]));

    const record: TraderRecord = {
      address: details.account || norm,
      username,
      avatarUrl,
      xHandle,
      accountValue,
      usdcBalance,
      totalNotional,
      accountLeverage,
      marginUsagePct,
      unrealizedPnl,
      realizedPnlAll,
      totalPnlAll,
      roiAllPct,
      pnl24h,
      pnl7d,
      pnl30d,
      roi24hPct: pnl24h !== null ? calcRoiPct(pnl24h, accountValue) : null,
      roi7dPct: pnl7d !== null ? calcRoiPct(pnl7d, accountValue) : null,
      roi30dPct: pnl30d !== null ? calcRoiPct(pnl30d, accountValue) : null,
      volume24h: safeNum(header?.h24?.volume),
      volume7d: safeNum(header?.d7?.volume),
      volume30d: safeNum(header?.d30?.volume),
      volumeAll: Math.max(safeNum(header?.all_time?.volume), existing?.volumeAll || 0),
      volumeRank24h: safeNum(header?.h24?.volume_rank),
      volumeRankAll: safeNum(header?.all_time?.volume_rank),
      winRate,
      sharpeRatio,
      maxDrawdown,
      profitFactor,
      openPositionsCount: positions.length,
      positions,
      riskLevel: summary.risk_level || 'NORMAL',
      inLiquidation: Boolean(summary.in_liquidation),
      portfolioEnriched: true,
      lastUpdated: Date.now(),
      sources,
    };

    putTrader(key, record);
    return record;
  } catch {
    return null;
  }
}

async function discoverAllTraders() {
  const priorityQueue: string[] = [];
  const prioritySeen = new Set<string>();
  const addPriority = (addr: string) => {
    const k = addr.toLowerCase();
    if (!prioritySeen.has(k)) {
      prioritySeen.add(k);
      priorityQueue.push(addr);
    }
  };

  // 1. Active volume/liquidation/fee leaderboards (highest priority active whales)
  const lbCalls = [
    { url: `${RISEX_API}/v1/stats/user-volume/leaderboard?window=24h&limit=100&category=USER_VOLUME_CATEGORY_TRADED`, tag: 'vol-24h' },
    { url: `${RISEX_API}/v1/stats/user-volume/leaderboard?window=7d&limit=100&category=USER_VOLUME_CATEGORY_TRADED`, tag: 'vol-7d' },
    { url: `${RISEX_API}/v1/stats/user-volume/leaderboard?window=14d&limit=100&category=USER_VOLUME_CATEGORY_TRADED`, tag: 'vol-14d' },
    { url: `${RISEX_API}/v1/stats/user-volume/leaderboard?window=14d&limit=100&category=USER_VOLUME_CATEGORY_LIQUIDATION`, tag: 'liq-14d' },
    { url: `${RISEX_API}/v1/stats/user-volume/leaderboard?window=14d&limit=100&category=USER_VOLUME_CATEGORY_TOTAL_FEE`, tag: 'fee-14d' },
  ];

  const lbResults = await Promise.allSettled(lbCalls.map((c) => fetchJson(c.url)));
  lbResults.forEach((res, idx) => {
    if (res.status === 'fulfilled') {
      const entries = res.value?.data?.entries || [];
      for (const e of entries) {
        if (e.address) {
          seedDiscoveredTrader(e.address, {
            volume: safeNum(e.total_volume || e.traded_volume),
            source: lbCalls[idx].tag,
          });
          addPriority(e.address);
        }
      }
    }
  });

  // 2. Discover EVERY competition & paginate all traders + usernames + avatars + X handles concurrently
  try {
    const compsRes = await fetchJson(`${RISEX_API}/v1/competitions?limit=50`);
    const comps: any[] = compsRes?.data?.competitions || [];
    const fetchComp = async (comp: any) => {
      const slug = comp.slug;
      if (!slug) return;
      let offset = 0;
      const limit = 500;
      let pages = 0;
      while (pages < 10) {
        pages++;
        try {
          const lb = await fetchJson(`${RISEX_API}/v1/competitions/${encodeURIComponent(slug)}/leaderboard?limit=${limit}&offset=${offset}`);
          const rows: any[] = lb?.data?.rows || [];
          for (const row of rows) {
            if (!row.address) continue;
            const wr = safeNum(row.win_rate);
            seedDiscoveredTrader(row.address, {
              username: row.username || null,
              avatarUrl: row.avatar_url || row.x_account?.profile_image_url || null,
              xHandle: row.x_account?.username || null,
              realizedPnl: safeNum(row.realized_pnl),
              volume: safeNum(row.window_volume),
              winRate: wr > 0 ? wr : null,
              source: `comp:${slug}`,
            });
            if (comp.state === 'live') {
              addPriority(row.address);
            }
          }
          if (rows.length < limit) break;
          offset += limit;
        } catch {
          break;
        }
      }
    };
    for (let i = 0; i < comps.length; i += 4) {
      await Promise.allSettled(comps.slice(i, i + 4).map(fetchComp));
    }
  } catch {
    // ignore competition fetch error
  }

  // 3. Blockscout on-chain EOA senders, contract event logs (CollateralManager/Auth/OperatorHub) & historical cursors
  try {
    const cfg = await getSystemConfig().catch(() => null);
    const routerAddr = cfg?.addresses?.router || '0xaadde0cea454f2bcb26f46ed54c5709b7bb34a7e';
    const perpsAddr = cfg?.addresses?.perps_manager || '0x53f10facfc8965750494e6965f5d6da39b41d852';
    const ordersAddr = cfg?.addresses?.orders_manager || '0xe03c1d5081eb2d0e6bfd62a949c5b12efa44f2cd';
    const collateralAddr = cfg?.addresses?.collateral_manager || '0x2c03c7d7e2974c6599b6b108879109281ef3f818';
    const feeAddr = cfg?.addresses?.fee_manager || '0x11541dc387b9c307043ea732127df92b80bab52b';
    const authAddr = cfg?.addresses?.auth || '0x0d919daa3f12ae715744eb648c00066c5dbd66f0';
    const operatorHubAddr = cfg?.addresses?.operator_hub || '0xf665aba90b6ac7515d50b12fcb4f350136726734';
    const usdcAddr = cfg?.addresses?.usdc || '0xe436820ba0c69702c1d3e601d421c0ef38262739';
    const knownContracts = [
      routerAddr,
      perpsAddr,
      ordersAddr,
      collateralAddr,
      feeAddr,
      authAddr,
      operatorHubAddr,
      usdcAddr,
      cfg?.addresses?.oracle,
      cfg?.addresses?.stork,
      cfg?.addresses?.multicall3,
    ].filter(Boolean) as string[];

    for (const cAddr of [routerAddr, perpsAddr]) {
      try {
        const txData = await fetchJson(`${RISE_EXPLORER_API}/addresses/${cAddr}/transactions`, {}, 7000);
        for (const tx of txData?.items || []) {
          const from = tx?.from?.hash;
          if (from && !tx?.from?.is_contract) {
            seedDiscoveredTrader(from, { source: 'onchain-tx' });
            addPriority(from);
          }
        }
      } catch {
        // ignore single contract error
      }
    }

    // 3.0 Direct contract event logs (catches relayed deposits/withdraws & all auth/operator signers)
    for (const [contractAddr, tag] of [
      [collateralAddr, 'collateral-log'],
      [authAddr, 'auth-log'],
      [operatorHubAddr, 'operator-log'],
    ] as const) {
      try {
        let logParams: Record<string, any> | null = null;
        for (let page = 0; page < 2; page++) {
          const qs = logParams
            ? '?' + new URLSearchParams(Object.entries(logParams).map(([k, v]) => [k, String(v)])).toString()
            : '';
          const logsRes = await fetchJson(`${RISE_EXPLORER_API}/addresses/${contractAddr}/logs${qs}`, {}, 7000);
          const extracted = extractWalletAddressesFromLogs(logsRes?.items || [], knownContracts);
          for (const addr of extracted) {
            seedDiscoveredTrader(addr, { source: tag });
            addPriority(addr);
          }
          logParams = logsRes?.next_page_params || null;
          if (!logParams) break;
        }
      } catch {
        // ignore log fetch error
      }
    }

    // 3a. CollateralManager depositors & withdrawers (paginated chronologically from cursor)
    if (!cmBackfillComplete) {
      let cmParams = cmCursor;
      for (let page = 0; page < 12; page++) {
        try {
          const qs = cmParams
            ? '?' + new URLSearchParams(Object.entries(cmParams).map(([k, v]) => [k, String(v)])).toString()
            : '';
          const cmData = await fetchJson(`${RISE_EXPLORER_API}/addresses/${collateralAddr}/transactions${qs}`, {}, 7000);
          for (const tx of cmData?.items || []) {
            const from = tx?.from?.hash;
            if (from && !tx?.from?.is_contract) {
              seedDiscoveredTrader(from, { source: 'collateral-tx' });
              addPriority(from);
            }
          }
          cmParams = cmData?.next_page_params || null;
          cmCursor = cmParams;
          if (!cmParams) {
            cmBackfillComplete = true;
            break; // Reached beginning of history
          }
        } catch {
          break;
        }
      }
    } else {
      // Check latest page for new depositors/withdrawers
      try {
        const cmData = await fetchJson(`${RISE_EXPLORER_API}/addresses/${collateralAddr}/transactions`, {}, 7000);
        for (const tx of cmData?.items || []) {
          const from = tx?.from?.hash;
          if (from && !tx?.from?.is_contract) {
            seedDiscoveredTrader(from, { source: 'collateral-tx' });
            addPriority(from);
          }
        }
      } catch {
        // ignore
      }
    }

    // 3b. Auth contract signer registrations: newest 3 pages + progressive historical cursor crawl
    const crawlAuthPage = async (params: Record<string, any> | null, prioritize: boolean) => {
      const qs = params
        ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
        : '';
      const authData = await fetchJson(`${RISE_EXPLORER_API}/addresses/${authAddr}/transactions${qs}`, {}, 7000);
      for (const tx of authData?.items || []) {
        const raw: string = tx?.raw_input || '';
        if (raw.length >= 74 && (tx?.method === '0x8a10cb9e' || tx?.method === '0xf8219d90')) {
          const traderAddr = '0x' + raw.slice(34, 74);
          if (/^0x[a-fA-F0-9]{40}$/.test(traderAddr)) {
            seedDiscoveredTrader(traderAddr, { source: 'auth-registry' });
            if (prioritize) addPriority(traderAddr);
          }
        }
      }
      return authData?.next_page_params || null;
    };

    // Latest 3 pages for brand-new active non-challenge signers
    try {
      let headParams: Record<string, any> | null = null;
      for (let p = 0; p < 3; p++) {
        headParams = await crawlAuthPage(headParams, true);
        if (!headParams) break;
      }
    } catch {
      // ignore
    }

    // Historical sweep across all past Auth registrations (active + inactive wallets)
    if (!authBackfillComplete) {
      for (let page = 0; page < 15; page++) {
        try {
          const nextP = await crawlAuthPage(authCursor, false);
          authCursor = nextP;
          if (!nextP) {
            authBackfillComplete = true;
            break;
          }
        } catch {
          break;
        }
      }
    }
  } catch {
    // ignore
  }

  for (const custom of customSearchedWallets) {
    addPriority(custom);
  }

  return priorityQueue;
}

// Persist an up-to-date sample independently of large discovery/enrichment cycles.
// Observations update the current UTC hour bucket; distinct hours remain comparable.
let cohortCaptureInProgress = false;
const COHORT_CAPTURE_INTERVAL_MS = 5 * 60_000;
async function captureCohortSnapshot():Promise<void> {
  if(!historyStore.ready || cohortCaptureInProgress ||
     Date.now()-lastPositionHistorySample < COHORT_CAPTURE_INTERVAL_MS)return;
  cohortCaptureInProgress=true;
  const capturedAt=Date.now();
  try {
    const grouped=new Map<string,{
      marketId:string;cohort:'whale'|'shark'|'dolphin'|'fish'|'shrimp';
      observedAt:number;longUsd:number;shortUsd:number;positions:number
    }>();
    for(const trader of tradersMap.values()){
      if(!trader.portfolioEnriched)continue;
      const cohort=classifyTraderCohort(trader.accountValue,trader.totalNotional);
      for(const pos of trader.positions){
        const key=`${pos.marketId}:${cohort}`;
        const row=grouped.get(key)||{
          marketId:pos.marketId,cohort,observedAt:capturedAt,
          longUsd:0,shortUsd:0,positions:0,
        };
        if(pos.side==='LONG')row.longUsd+=pos.notionalUsd;
        else row.shortUsd+=pos.notionalUsd;
        row.positions++;
        grouped.set(key,row);
      }
    }
    if(grouped.size===0)return;
    await historyStore.recordCohortSnapshots([...grouped.values()]);
    lastPositionHistorySample=capturedAt;
  }catch(err){
    console.error('Cohort snapshot persistence warning:',err);
  }finally{
    cohortCaptureInProgress=false;
  }
}

// Merge newly discovered/enriched wallets written by the independent GitHub
// backfill worker, without restarting the live website or replacing newer data.
let backfillSyncCursorTime=new Date(Date.now()-15*60_000).toISOString();
let backfillSyncCursorAddress='';
let backfillSyncBusy=false;
async function syncWalletBackfillUpdates():Promise<void>{
  if(!historyStore.ready || backfillSyncBusy)return;
  backfillSyncBusy=true;
  try{
    const page=await historyStore.loadWalletBackfillUpdates(
      backfillSyncCursorTime,backfillSyncCursorAddress,1200
    );
    let changed=0;
    for(const candidate of page.records){
      if(!candidate?.address)continue;
      const key=String(candidate.address).toLowerCase();
      const existing=tradersMap.get(key);
      const incomingUpdated=safeNum(candidate.lastUpdated);
      const existingUpdated=safeNum(existing?.lastUpdated);
      if(!existing || incomingUpdated>existingUpdated){
        tradersMap.set(key,candidate as TraderRecord);
        changed++;
      }
    }
    backfillSyncCursorTime=page.cursorTime;
    backfillSyncCursorAddress=page.cursorAddress;
    if(changed)invalidateLeaderboardAndCohortCaches();
  }catch(err){
    console.error('Durable wallet backfill sync warning:',err);
  }finally{backfillSyncBusy=false;}
}

async function runBackgroundIndexer() {
  if (isIndexing) return;
  isIndexing = true;
  try {
    await getMarkets(true);
    const priorityList = await discoverAllTraders();
    const now = Date.now();
    const PRIORITY_FRESH_MS = 5 * 60 * 1000;

    // Anti-starvation round-robin queue: unenriched active traders & legacy entries first, then oldest stale
    const queue = selectIndexerQueue(priorityList, tradersMap, now, PRIORITY_FRESH_MS, 360, 220);
    const BATCH_SIZE = 4;
    for (let i = 0; i < queue.length; i += BATCH_SIZE) {
      // Give interactive requests first priority without starving backfill indefinitely.
      // A bounded pause prevents a constantly busy public site from stopping indexing.
      for(let pause=0;pause<6 && activeInteractiveRequests>0;pause++){
        await new Promise((r)=>setTimeout(r,500));
      }
      const batch = queue.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map((addr) => enrichWallet(addr, 'indexer')));
      invalidateLeaderboardAndCohortCaches();
      if (i % 40 === 0 && i > 0) saveDiskCache();
      await new Promise((r) => setTimeout(r, 1200));
    }

    lastIndexComplete = Date.now();
    await captureCohortSnapshot();
    saveDiskCache();
  } catch (err) {
    console.error('Indexer cycle warning:', err);
  } finally {
    isIndexing = false;
  }
}

async function fetchAllRealizedPnl(address: string): Promise<any[]> {
  return cachedCall(`hist:rpnl:${address.toLowerCase()}`, 90_000, async () => {
    const first = await fetchJson(
      `${RISEX_API}/v1/portfolio/realized-pnl?account=${address}&limit=1000&page=1`
    );
    const page1: any[] = first?.data?.data || [];
    if (page1.length < 1000) return page1;

    const batch1 = await Promise.all(
      [2, 3, 4, 5].map((p) =>
        fetchJson(`${RISEX_API}/v1/portfolio/realized-pnl?account=${address}&limit=1000&page=${p}`)
          .then((r) => r?.data?.data || [])
          
      )
    );
    const all = [...page1, ...batch1.flat()];
    if (batch1[batch1.length - 1].length < 1000) return all;

    const batch2 = await Promise.all(
      [6, 7, 8, 9, 10].map((p) =>
        fetchJson(`${RISEX_API}/v1/portfolio/realized-pnl?account=${address}&limit=1000&page=${p}`)
          .then((r) => r?.data?.data || [])
          
      )
    );
    return [...all, ...batch2.flat()];
  });
}

async function fetchAllTradeHistory(address: string): Promise<any[]> {
  return cachedCall(`hist:trades:${address.toLowerCase()}`, 90_000, async () => {
    const first = await fetchJson(
      `${RISEX_API}/v1/trade-history?account=${address}&limit=200&page=1`
    );
    const page1: any[] = first?.data?.trades || [];
    if (page1.length < 200) return page1;

    const batch1 = await Promise.all(
      [2, 3, 4].map((p) =>
        fetchJson(`${RISEX_API}/v1/trade-history?account=${address}&limit=200&page=${p}`)
          .then((r) => r?.data?.trades || [])
          
      )
    );
    const all = [...page1, ...batch1.flat()];
    if (batch1.some((b) => b.length < 200)) return all;

    const batch2 = await Promise.all(
      [5, 6, 7, 8].map((p) =>
        fetchJson(`${RISEX_API}/v1/trade-history?account=${address}&limit=200&page=${p}`)
          .then((r) => r?.data?.trades || [])
          
      )
    );
    return [...all, ...batch2.flat()];
  });
}

async function fetchAllTransfers(address: string): Promise<{ items: any[]; complete: boolean }> {
  return cachedCall(`hist:transfers:${address.toLowerCase()}`, 90_000, async () => {
    const first = await fetchJson(
      `${RISEX_API}/v1/account/transfer-history?account=${address}&limit=200&page=1`
    ).catch(() => null);
    if (!first) return { items: [], complete: false };
    const page1: any[] = first?.data?.items || [];
    if (!first?.data?.has_next_page || page1.length < 200) {
      return { items: page1, complete: true };
    }

    const batch1 = await Promise.all(
      [2, 3, 4, 5].map((p) =>
        fetchJson(`${RISEX_API}/v1/account/transfer-history?account=${address}&limit=200&page=${p}`).catch(() => null)
      )
    );
    const all = [...page1];
    let complete = false;
    for (const res of batch1) {
      const items: any[] = res?.data?.items || [];
      all.push(...items);
      if (!res?.data?.has_next_page || items.length < 200) {
        complete = true;
        break;
      }
    }
    if (complete) return { items: all, complete: true };

    const batch2 = await Promise.all(
      [6, 7, 8, 9, 10].map((p) =>
        fetchJson(`${RISEX_API}/v1/account/transfer-history?account=${address}&limit=200&page=${p}`).catch(() => null)
      )
    );
    for (const res of batch2) {
      const items: any[] = res?.data?.items || [];
      all.push(...items);
      if (!res?.data?.has_next_page || items.length < 200) {
        complete = true;
        break;
      }
    }
    return { items: all, complete };
  });
}

async function fetchAllFundingPayments(address: string): Promise<any[]> {
  return cachedCall(`hist:funding:${address.toLowerCase()}`, 90_000, async () => {
    const first = await fetchJson(
      `${RISEX_API}/v1/account/funding-payments?account=${address}&limit=200&page=1`
    ).catch(() => null);
    const page1: any[] = first?.data?.records || [];
    if (!first?.data?.has_next_page || page1.length < 200) return page1;

    const batch1 = await Promise.all(
      [2, 3, 4, 5, 6].map((p) =>
        fetchJson(`${RISEX_API}/v1/account/funding-payments?account=${address}&limit=200&page=${p}`)
          .catch(() => null)
      )
    );
    const all = [...page1, ...batch1.flatMap((r) => r?.data?.records || [])];
    const lastBatch1 = batch1[batch1.length - 1];
    if (!lastBatch1?.data?.has_next_page || (lastBatch1?.data?.records?.length || 0) < 200) {
      return all;
    }

    const batch2 = await Promise.all(
      [7, 8, 9, 10, 11, 12, 13, 14, 15].map((p) =>
        fetchJson(`${RISEX_API}/v1/account/funding-payments?account=${address}&limit=200&page=${p}`)
          .then((r) => r?.data?.records || [])
          .catch(() => [])
      )
    );
    return [...all, ...batch2.flat()];
  });
}

async function getDefiLlamaRiseData() {
  return cachedCallSWR(
    'defillama:risex',
    120_000,
    900_000,
    async () => {
      const [protoRes, chainRes] = await Promise.allSettled([
        fetchJson('https://api.llama.fi/protocol/risex', {}, 9000, 1),
        fetchJson('https://api.llama.fi/v2/historicalChainTvl/RISE', {}, 9000, 1),
      ]);

      const proto = protoRes.status === 'fulfilled' ? protoRes.value : null;
      const chainArr: any[] =
        chainRes.status === 'fulfilled' && Array.isArray(chainRes.value) ? chainRes.value : [];

      const rawTvl: { date: number; totalLiquidityUSD: number }[] = Array.isArray(proto?.tvl)
        ? proto.tvl
        : [];
      const tvlHistory = rawTvl
        .map((p) => ({
          date: safeNum(p.date) * 1000,
          tvl: safeNum(p.totalLiquidityUSD),
        }))
        .filter((p) => p.date > 0 && p.tvl >= 0)
        .slice(-120);

      const chainTvlHistory = chainArr
        .map((p: any) => ({
          date: safeNum(p.date) * 1000,
          tvl: safeNum(p.tvl),
        }))
        .filter((p) => p.date > 0 && p.tvl >= 0)
        .slice(-120);

      const currentProtoTvl =
        safeNum(proto?.currentChainTvls?.RISE) ||
        tvlHistory[tvlHistory.length - 1]?.tvl ||
        0;
      const prevProtoTvl =
        tvlHistory.length >= 2 ? tvlHistory[tvlHistory.length - 2].tvl : currentProtoTvl;
      const tvl24hChangePct =
        prevProtoTvl > 0 ? ((currentProtoTvl - prevProtoTvl) / prevProtoTvl) * 100 : 0;

      const currentChainTvl =
        chainTvlHistory[chainTvlHistory.length - 1]?.tvl || 0;
      const risexShareOfChainPct =
        currentChainTvl > 0 ? Math.min(100, (currentProtoTvl / currentChainTvl) * 100) : 0;

      return {
        protocolTvl: currentProtoTvl,
        chainTvl: currentChainTvl,
        tvl24hChangePct,
        risexShareOfChainPct,
        tvlHistory,
        chainTvlHistory,
        fetchedAt: Date.now(),
      };
    }
  );
}

async function getRecentMarketTrades() {
  return cachedCallSWR('trades:recent', 4000, 20000, async () => {
    const markets = await getMarkets();
    const topMarkets = [...markets]
      .sort((a, b) => safeNum(b.quote_volume_24h) - safeNum(a.quote_volume_24h))
      .slice(0, 8);

    const results = await Promise.allSettled(
      topMarkets.map(async (m) => {
        const r = await fetchJson(`${RISEX_API}/v1/markets/id/${m.market_id}/trade-history?limit=15`);
        return (r?.data?.trades || []).map((t: any) => ({
          ...t,
          market_id: m.market_id,
          market_name: m.display_name,
        }));
      })
    );

    const allTrades: any[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') allTrades.push(...r.value);
    }
    allTrades.sort((a, b) => nsToMs(b.time) - nsToMs(a.time));
    return { trades: allTrades.slice(0, 80) };
  });
}

/**
 * Public RISEx trade observer for forward-looking volume/fee analytics.
 * A disconnected/sleeping collector MUST NOT be represented as a complete
 * trade history. Idempotent DB keys dedupe repeated WebSocket messages.
 */
function startObservedTradeCollector() {
  if (!historyStore.ready || typeof WebSocket === 'undefined') return;
  let ws: WebSocket | null = null;
  let attempts = 0;
  let closed = false;
  let flushing = false;
  let reconnect: ReturnType<typeof setTimeout> | null = null;
  let buffer: ObservedTradeRecord[] = [];
  const flush = async () => {
    if (flushing || !buffer.length) return;
    flushing = true;
    const batch = buffer.splice(0, 1000);
    try {
      await historyStore.recordTrades(batch);
    } catch (err) {
      // Retain bounded queued data when DB is temporarily unreachable.
      buffer = [...batch, ...buffer].slice(0, 12000);
      console.error('Observed RISEx trade persistence warning:', err);
    } finally {
      flushing = false;
    }
  };
  const interval = setInterval(() => { void flush(); }, 1500);
  const connect = () => {
    if (closed) return;
    try {
      const socket = new WebSocket('wss://ws.rise.trade/ws');
      ws = socket;
      socket.addEventListener('open', () => {
        tradeFeedConnected = true;
        attempts = 0;
        socket.send(JSON.stringify({method:'subscribe',params:{channel:'trades'}}));
      });
      socket.addEventListener('message', (message) => {
        try {
          const frame = JSON.parse(String(message.data));
          if (frame?.channel !== 'trades') return;
          const marketId=String(frame.market_id ?? '');
          const items=Array.isArray(frame.data) ? frame.data : frame.data?.trades ?? [frame.data];
          for (const item of items) {
            const id=String(item?.id ?? '');
            const price=safeNum(item?.price), size=safeNum(item?.size);
            if (!/^\d+$/.test(marketId) || !id || price<=0 || size<=0) continue;
            const feeFields=[item.fee_maker,item.fee_taker,item.fee_liquidation]
              .filter((value:unknown)=>value !== null && value !== undefined && value !== '');
            const reportedFee=feeFields.length > 0
              ? feeFields.reduce((sum:number,value:unknown)=>sum+safeNum(value),0) : null;
            const ts=nsToMs(frame.worker_timestamp ?? frame.timestamp ?? frame.block_timestamp ?? Date.now());
            const timestampMs=ts > 0 ? ts : Date.now();
            if (buffer.length >= 12000) {
              buffer.shift();
              droppedTradeEvents++;
            }
            const maker=String(item?.maker||'');
            const taker=String(item?.taker||'');
            const makerSide=Number(item?.maker_side);
            if (/^0x[a-fA-F0-9]{40}$/.test(maker)) {
              seedDiscoveredTrader(maker,{source:'live-trade-maker'});
            }
            if (/^0x[a-fA-F0-9]{40}$/.test(taker)) {
              seedDiscoveredTrader(taker,{source:'live-trade-taker'});
            }
            buffer.push({
              marketId,tradeId:id,timestampMs,
              notionalUsd:price*size,feeUsd:reportedFee,
              maker:/^0x[a-fA-F0-9]{40}$/.test(maker)?maker.toLowerCase():null,
              taker:/^0x[a-fA-F0-9]{40}$/.test(taker)?taker.toLowerCase():null,
              makerSide:Number.isInteger(makerSide) && (makerSide===0||makerSide===1)?makerSide:null,
              price:String(item.price),size:String(item.size),
            });
            lastObservedTradeAt=Date.now();
          }
        } catch {
          // Ignore malformed frames without injecting fabricated trade events.
        }
      });
      socket.addEventListener('close', () => {
        if (ws !== socket) return;
        tradeFeedConnected = false;
        ws = null;
        if (!closed) reconnect = setTimeout(connect, Math.min(60000,1500*2**Math.min(6,attempts++)));
      });
      socket.addEventListener('error', () => { socket.close(); });
    } catch {
      tradeFeedConnected = false;
      if (!closed) reconnect = setTimeout(connect, Math.min(60000,1500*2**Math.min(6,attempts++)));
    }
  };
  connect();
  const shutdown = () => {
    closed=true;
    if (reconnect)clearTimeout(reconnect);
    clearInterval(interval);
    ws?.close();
    void flush();
  };
  process.once('SIGTERM',shutdown);
  process.once('SIGINT',shutdown);
}

async function startServer() {
  await restoreIndexAtStartup();
  startObservedTradeCollector();

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({limit:'32kb'}));
  // All RISEx venue market IDs are numeric. Validate before interpolating
  // identifiers into upstream URLs to avoid endpoint/path manipulation.
  app.param('marketId',(req:Request,res:Response,next,value:string)=>{
    if(!/^\d{1,6}$/.test(value)){
      res.status(400).json({error:'Invalid market ID'});
      return;
    }
    next();
  });
  app.param('addressOrUsername',(req:Request,res:Response,next,value:string)=>{
    if(value.length>120){
      res.status(400).json({error:'Account query is too long'});
      return;
    }
    next();
  });

  // Public security headers (allow iframe preview in AI Studio while hardening MIME/referrer)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // Bounded in-memory API latency telemetry. No wallet addresses or search
  // query strings are stored; Express route patterns group dynamic IDs.
  const apiPerf = new Map<string,{durations:number[];requests:number;errors:number}>();
  app.use('/api', (req,res,next) => {
    const start=performance.now();
    res.once('finish', () => {
      // Never retain user-controlled wallet names, tx hashes, or addresses.
      // Express route patterns are set after a matching handler runs; group
      // unmatched paths into 'unmatched' rather than saving raw URL components.
      const route = req.route?.path;
      const path = typeof route === 'string' ? route : 'unmatched';
      if (path === '/monitoring/performance') return;
      const entry=apiPerf.get(path) || {durations:[],requests:0,errors:0};
      entry.requests++;
      if (res.statusCode >= 400) entry.errors++;
      entry.durations.push(Math.round(performance.now()-start));
      if (entry.durations.length > 300) entry.durations.shift();
      if (apiPerf.size >= 70 && !apiPerf.has(path)) apiPerf.delete(apiPerf.keys().next().value!);
      apiPerf.set(path,entry);
    });
    next();
  });
  app.get('/api/monitoring/performance', (_req,res) => {
    const percentile = (rows:number[], pct:number) =>
      rows.length ? rows[Math.floor((rows.length-1)*pct)] : 0;
    const metrics=[...apiPerf.entries()].map(([route,v]) => {
      const ordered=[...v.durations].sort((a,b)=>a-b);
      return {
        route, requests:v.requests, errorRatePct: +(v.errors/v.requests*100).toFixed(1),
        p50Ms:percentile(ordered,0.50),p95Ms:percentile(ordered,0.95),
        maxMs:ordered[ordered.length-1] || 0,
        sampleSize:ordered.length,
      };
    }).sort((a,b)=>b.p95Ms-a.p95Ms);
    res.setHeader('Cache-Control','no-store');
    res.json({fetchedAt:Date.now(),uptimeSec:Math.round(process.uptime()),metrics});
  });

  // Heavy account diagnostics can request 9+ upstream calls and optional
  // forced trader resync. Bound them separately from ordinary price APIs;
  // otherwise an anonymous visitor could exhaust free-provider quotas.
  const diagnosticBudget=new Map<string,{count:number;resetAt:number}>();
  const resyncBudget=new Map<string,{count:number;resetAt:number}>();
  function permitCostlyRequest(budget:Map<string,{count:number;resetAt:number}>,
      ip:string,limit:number,windowMs:number):{allowed:boolean;retryAfterSec:number}{
    const now=Date.now();
    const current=budget.get(ip);
    if(!current || current.resetAt<=now){
      if(budget.size>2500){
        for(const [key,value]of budget)if(value.resetAt<=now)budget.delete(key);
      }
      budget.set(ip,{count:1,resetAt:now+windowMs});
      return {allowed:true,retryAfterSec:0};
    }
    if(current.count>=limit)return {
      allowed:false,
      retryAfterSec:Math.max(1,Math.ceil((current.resetAt-now)/1000)),
    };
    current.count++;
    return {allowed:true,retryAfterSec:0};
  }

  // Lightweight sliding-window per-IP rate limiter for /api/*
  const ipHits = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of ipHits.entries()) {
      if (entry.resetAt <= now) ipHits.delete(ip);
    }
  }, 60000);

  app.use('/api', (req, res, next) => {
    if (req.path === '/health') return next();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const cur = ipHits.get(ip);
    if (!cur || cur.resetAt <= now) {
      ipHits.set(ip, { count: 1, resetAt: now + 60000 });
      return next();
    }
    cur.count += 1;
    if (cur.count > 240) {
      res.setHeader('Retry-After', String(Math.ceil((cur.resetAt - now) / 1000)));
      res.status(429).json({ error: 'Rate limit exceeded. Please retry shortly.' });
      return;
    }
    next();
  });

  app.get('/api/analytics/position-changes',async(_req:Request,res:Response)=>{
    try {
      const result=await cachedCallSWR('analytics:position-changes',60000,120000,
        ()=>historyStore.getPositionChanges());
      res.json({...result,indexedTraders:tradersMap.size,
        note:'Changes are sampled from enriched indexed accounts, not proof of executed buys or sells.'});
    }catch(err:any){
      res.status(503).json({error:err?.message||'Position changes unavailable'});
    }
  });

  app.get('/api/analytics/history', async (_req:Request,res:Response) => {
    try {
      const payload=await cachedCallSWR('analytics:history',30_000,60_000,
        () => historyStore.getHistoricalAnalytics());
      res.json({
        ...payload,
        liveCollector:{connected:tradeFeedConnected,lastTradeAt:lastObservedTradeAt||null,droppedInMemory:droppedTradeEvents},
      });
    } catch(err:any) {
      res.status(503).json({error:err?.message||'History analytics unavailable'});
    }
  });

  // Use free DefiLlama protocol TVL history as a separately attributed series.
  // It must never be substituted for RISEx OI, trading volume, or fees.
  app.get('/api/analytics/protocol-tvl',async(_req:Request,res:Response)=>{
    try{
      const d=await getDefiLlamaRiseData();
      res.json({source:'DefiLlama',tvlHistory:d.tvlHistory,updatedAt:d.fetchedAt});
    }catch{
      res.status(503).json({error:'Protocol TVL history unavailable'});
    }
  });

  app.get('/api/data/freshness', async (_req:Request,res:Response) => {
    res.setHeader('Cache-Control','no-store');
    const storage=await historyStore.storageStatus().catch(()=>null);
    res.json({
      fetchedAt:Date.now(),
      databaseStorageBytes:storage?.usedBytes ?? null,
      databaseSoftLimitBytes:storage?.limitBytes ?? null,
      databaseTradeWritesPaused:storage?.writeLimited ?? false,
      marketsRestUpdatedAt:marketsUpdatedAt || null,
      walletIndexCompletedAt:lastIndexComplete || null,
      indexedTraders:tradersMap.size,
      enrichedTraders:Array.from(tradersMap.values()).filter(t=>t.portfolioEnriched).length,
      databaseConnected:historyStore.ready,
      tradesWsConnected:tradeFeedConnected,
      lastObservedTradeAt:lastObservedTradeAt || null,
      tradeEventsDropped:droppedTradeEvents,
      historicalCoverageComplete:false,
      note:'Wallet discovery is progressive; recorded trade/fee history may have gaps during downtime or when the public REST history window is capped.',
    });
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      tradersDiscovered: tradersMap.size,
      tradersEnriched: Array.from(tradersMap.values()).filter((t) => t.portfolioEnriched).length,
      marketsCount: marketsCache.length,
      indexingInProgress: isIndexing,
      lastIndexComplete,
    });
  });

  void syncWalletBackfillUpdates();
  setInterval(() => { void syncWalletBackfillUpdates(); }, 120_000);
  void captureCohortSnapshot();
  setInterval(() => { void captureCohortSnapshot(); }, COHORT_CAPTURE_INTERVAL_MS);
  runBackgroundIndexer();
  setInterval(() => {
    runBackgroundIndexer();
  }, 120000);

  // Pre-warm DefiLlama & recent trades cache cleanly in background
  setTimeout(() => {
    getDefiLlamaRiseData().catch(() => {});
    getRecentMarketTrades().catch(() => {});
  }, 600);

  // 1. Unified Overview Pulse + DefiLlama + Markets + Top Traders + Recent Fills (4s SWR cached -> instant load)
  app.get('/api/overview', async (_req: Request, res: Response) => {
    try {
      const bundle = await cachedCallSWR('overview:bundle', 4000, 30000, async () => {
        const [markets, config, rpcBlock, defiLlama, recentData] = await Promise.all([
          getMarkets(),
          getSystemConfig().catch(() => null),
          cachedCall('rpc:blockNumber', 3000, () =>
            fetchJson(
              RISE_RPC,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
              },
              5000
            ).catch(() => null)
          ),
          getDefiLlamaRiseData().catch(() => null),
          getRecentMarketTrades().catch(() => ({ trades: [] })),
        ]);

        let totalVolume24h = 0;
        let totalOpenInterestUsd = 0;
        for (const m of markets) {
          totalVolume24h += safeNum(m.quote_volume_24h);
          totalOpenInterestUsd += safeNum(m.open_interest) * safeNum(m.mark_price || m.last_price);
        }

        const traders = Array.from(tradersMap.values());
        const enriched = traders.filter((t) => t.portfolioEnriched);
        const totalEquityTracked = enriched.reduce((s, t) => s + t.accountValue, 0);
        const totalOpenPositions = enriched.reduce((s, t) => s + t.openPositionsCount, 0);
        const blockNumber = rpcBlock?.result ? parseInt(rpcBlock.result, 16) : null;

        const posCounts = new Map<string, { count: number; longNotional: number; shortNotional: number }>();
        for (const t of traders) {
          for (const p of t.positions) {
            const cur = posCounts.get(p.marketId) || { count: 0, longNotional: 0, shortNotional: 0 };
            cur.count += 1;
            if (p.side === 'LONG') cur.longNotional += p.notionalUsd;
            else cur.shortNotional += p.notionalUsd;
            posCounts.set(p.marketId, cur);
          }
        }

        const enrichedMarkets = markets.map((m) => ({
          ...m,
          indexedStats: posCounts.get(String(m.market_id)) || {
            count: 0,
            longNotional: 0,
            shortNotional: 0,
          },
        }));

        const topTraders = [...traders]
          .sort((a, b) => b.totalPnlAll - a.totalPnlAll)
          .slice(0, 12)
          .map(({ positions: _positions, ...rest }) => ({ ...rest, positions: [] }));

        const profitability = computeProfitabilitySummary(traders);

        return {
          totalVolume24h,
          totalOpenInterestUsd,
          activeMarketsCount: markets.filter((m) => m.active).length,
          totalMarketsCount: markets.length,
          totalDiscoveredCount: traders.length,
          indexedTradersCount: enriched.length,
          totalEquityTracked,
          totalOpenPositions,
          blockNumber,
          chainName: config?.chain?.name || 'Rise Mainnet',
          chainId: config?.chain?.chain_id || '4153',
          indexingInProgress: isIndexing,
          lastRefresh: lastIndexComplete,
          defiLlama,
          profitability,
          markets: enrichedMarkets,
          topTraders,
          recentTrades: (recentData?.trades || []).slice(0, 30),
        };
      });

      res.json(bundle);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load overview' });
    }
  });

  // 2. All Markets
  app.get('/api/markets', async (req: Request, res: Response) => {
    try {
      const force = req.query.force === '1';
      const markets = await getMarkets(force);
      const posCounts = new Map<string, { count: number; longNotional: number; shortNotional: number }>();
      for (const t of tradersMap.values()) {
        for (const p of t.positions) {
          const cur = posCounts.get(p.marketId) || { count: 0, longNotional: 0, shortNotional: 0 };
          cur.count += 1;
          if (p.side === 'LONG') cur.longNotional += p.notionalUsd;
          else cur.shortNotional += p.notionalUsd;
          posCounts.set(p.marketId, cur);
        }
      }

      const enriched = markets.map((m) => ({
        ...m,
        indexedStats: posCounts.get(String(m.market_id)) || { count: 0, longNotional: 0, shortNotional: 0 },
      }));

      res.json({ markets: enriched });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch markets' });
    }
  });

  // 3. Global Search across 3,500+ discovered traders (username + address) & markets
  app.get('/api/search', async (req: Request, res: Response) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) {
      res.json({ markets: [], traders: [] });
      return;
    }
    const markets = await getMarkets().catch(() => []);
    const matchedMarkets = markets
      .filter(
        (m) =>
          m.display_name?.toLowerCase().includes(q) ||
          m.base_asset_symbol?.toLowerCase().includes(q) ||
          String(m.market_id) === q
      )
      .slice(0, 8);

    const matchedTraders = Array.from(tradersMap.values())
      .filter(
        (t) =>
          t.address.toLowerCase().includes(q) ||
          (t.username && t.username.toLowerCase().includes(q)) ||
          (t.xHandle && t.xHandle.toLowerCase().includes(q))
      )
      .sort((a, b) => Math.abs(b.totalPnlAll) - Math.abs(a.totalPnlAll))
      .slice(0, 10);

    res.json({ markets: matchedMarkets, traders: matchedTraders });
  });

  // 4. Leaderboard (Returns lightweight trader rows without heavy embedded positions; supports ?limit=)
  app.get('/api/leaderboard', async (req: Request, res: Response) => {
    const limitParam = req.query.limit ? Math.max(1, Math.min(2000, Number(req.query.limit))) : null;
    const cacheKey = limitParam ? `leaderboard:limit:${limitParam}` : 'leaderboard:full';
    const payload = await cachedCall(cacheKey, 4000, async () => {
      const all = Array.from(tradersMap.values());
      const stripPositions = (t: TraderRecord) => {
        const { positions: _positions, ...rest } = t;
        return { ...rest, positions: [] };
      };
      const enriched = all.filter((t) => t.portfolioEnriched);

      if (limitParam) {
        const top = [...all]
          .sort((a, b) => b.totalPnlAll - a.totalPnlAll)
          .slice(0, limitParam)
          .map(stripPositions);
        return {
          traders: top,
          totalDiscovered: all.length,
          totalEnriched: enriched.length,
          indexingInProgress: isIndexing,
          lastRefresh: lastIndexComplete,
        };
      }

      // Include enriched traders + top unenriched competition traders so all usernames & realized PnL appear cleanly
      const unenriched = all
        .filter((t) => !t.portfolioEnriched && (t.username || Math.abs(t.realizedPnlAll) > 0 || t.volumeAll > 0))
        .sort((a, b) => Math.abs(b.realizedPnlAll) - Math.abs(a.realizedPnlAll))
        .slice(0, 400);

      return {
        traders: [...enriched, ...unenriched].map(stripPositions),
        totalDiscovered: all.length,
        totalEnriched: enriched.length,
        indexingInProgress: isIndexing,
        lastRefresh: lastIndexComplete,
      };
    });
    res.json(payload);
  });

  // 4b. Leaderboard Sync Diagnostic (Compares tradersMap cached snapshot vs live RISEx event logs & contract txs)
  app.get('/api/leaderboard/diagnostic/:addressOrUsername', async (req: Request, res: Response) => {
    try {
      const rawParam = String(req.params.addressOrUsername || '').trim();
      if(rawParam.length>120){
        res.status(400).json({error:'Trader query is too long'});
        return;
      }
      const shouldResync = req.query.resync === '1';
      const ip=String(req.ip||req.socket.remoteAddress||'unknown');
      const diagnosticGate=permitCostlyRequest(diagnosticBudget,ip,8,60000);
      const resyncGate=shouldResync
        ?permitCostlyRequest(resyncBudget,ip,2,600000)
        :{allowed:true,retryAfterSec:0};
      if(!diagnosticGate.allowed || !resyncGate.allowed){
        res.setHeader('Retry-After',String(Math.max(diagnosticGate.retryAfterSec,resyncGate.retryAfterSec)));
        res.status(429).json({error:'Trader diagnostic rate limit; try again later.'});
        return;
      }
      const resolved = await resolveAddressOrUsername(rawParam);
      if (!resolved) {
        res.status(404).json({ error: `Trader or wallet "${rawParam}" not found` });
        return;
      }

      const { address, traderProfile: preProfile } = resolved;
      const key = address.toLowerCase();
      if (customSearchedWallets.size >= 500) {
        const first = customSearchedWallets.values().next().value;
        if (first) customSearchedWallets.delete(first);
      }
      customSearchedWallets.add(address);

      let resynced = false;
      if (shouldResync) {
        const updated = await enrichWallet(address, 'diagnostic-resync');
        if (updated) {
          resynced = true;
          invalidateLeaderboardAndCohortCaches();
          apiResponseCache.delete(`wallet:full:${key}`);
          apiResponseCache.delete(`wallet:lite:${key}`);
        }
      }

      const snapshotEntry = tradersMap.get(key) || null;
      activeInteractiveRequests++;
      try {
        const [
          profileRes,
          detailsRes,
          chart1DRes,
          calRes,
          rpPage1Res,
          rpPage2Res,
          tradesRes,
          onChainRes,
          marketsList,
        ] = await Promise.allSettled([
          preProfile ? Promise.resolve({ data: preProfile }) : fetchJson(`${RISEX_API}/v1/traders/${address}`, {}, 9000, 1),
          fetchJson(`${RISEX_API}/v1/portfolio/details?account=${address}`, {}, 10000, 2),
          fetchJson(`${RISEX_API}/v1/portfolio/chart?account=${address}&period=1D`, {}, 10000, 2),
          fetchJson(`${RISEX_API}/v1/portfolio/pnl-calendar?account=${address}&period=1m`, {}, 10000, 2),
          fetchJson(`${RISEX_API}/v1/portfolio/realized-pnl?account=${address}&limit=1000&page=1`, {}, 10000, 1),
          fetchJson(`${RISEX_API}/v1/portfolio/realized-pnl?account=${address}&limit=1000&page=2`, {}, 10000, 1),
          fetchJson(`${RISEX_API}/v1/trade-history?account=${address}&limit=40&page=1`, {}, 9000, 1),
          fetchJson(`${RISE_EXPLORER_API}/addresses/${address}/transactions`, {}, 8000, 1),
          getMarkets(),
        ]);

        const profData = profileRes.status === 'fulfilled' ? profileRes.value?.data : null;
        const details = detailsRes.status === 'fulfilled' ? detailsRes.value?.data : null;
        const chart1D = chart1DRes.status === 'fulfilled' ? chart1DRes.value?.data?.data || [] : [];
        const calDays = calRes.status === 'fulfilled' ? calRes.value?.data?.days || [] : [];
        const rp1: any[] = rpPage1Res.status === 'fulfilled' ? rpPage1Res.value?.data?.data || [] : [];
        const rp2: any[] =
          rp1.length >= 1000 && rpPage2Res.status === 'fulfilled'
            ? rpPage2Res.value?.data?.data || []
            : [];
        const realizedEvents = [...rp1, ...rp2];
        const recentTrades = tradesRes.status === 'fulfilled' ? tradesRes.value?.data?.trades || [] : [];
        const onChainTxs = onChainRes.status === 'fulfilled' ? onChainRes.value?.items || [] : [];
        const markets = marketsList.status === 'fulfilled' ? marketsList.value : marketsCache;

        const openPositionsCount = (details?.positions || []).filter(
          (p: any) => Math.abs(safeNum(p.size)) > 0
        ).length;

        const report = buildTraderSyncDiagnostic({
          query: rawParam,
          resolvedAddress: details?.account || address,
          username: profData?.username || snapshotEntry?.username || null,
          avatarUrl:
            profData?.avatar_url ||
            profData?.x_account?.profile_image_url ||
            snapshotEntry?.avatarUrl ||
            null,
          xHandle: profData?.x_account?.username || snapshotEntry?.xHandle || null,
          snapshot: snapshotEntry
            ? {
                address: snapshotEntry.address,
                username: snapshotEntry.username,
                portfolioEnriched: snapshotEntry.portfolioEnriched,
                lastUpdated: snapshotEntry.lastUpdated,
                sources: snapshotEntry.sources,
                pnl24h: snapshotEntry.pnl24h,
                pnl7d: snapshotEntry.pnl7d,
                pnl30d: snapshotEntry.pnl30d,
                realizedPnlAll: snapshotEntry.realizedPnlAll,
                unrealizedPnl: snapshotEntry.unrealizedPnl,
                totalPnlAll: snapshotEntry.totalPnlAll,
                accountValue: snapshotEntry.accountValue,
                openPositionsCount: snapshotEntry.openPositionsCount,
              }
            : null,
          detailsSummary: details?.summary || null,
          openPositionsCount,
          chart1DPoints: chart1D,
          calDays,
          realizedEvents,
          realizedTotalFetched: realizedEvents.length,
          recentTrades,
          onChainTxs,
          markets,
          nowMs: Date.now(),
        });

        res.json({ ...report, resynced });
      } finally {
        activeInteractiveRequests = Math.max(0, activeInteractiveRequests - 1);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to run trader sync diagnostic' });
    }
  });

  // 5. Liquidation Risk Feed (near-liquidation positions across all indexed traders)
  app.get('/api/liquidations', async (_req: Request, res: Response) => {
    try {
      // Indexer snapshots are slow-moving: use fresh market marks instead of
      // positions' historical mark_price values when calculating proximity.
      const currentMarkets = await getMarkets().catch(() => marketsCache);
      const markById = new Map<string, number>();
      for (const m of currentMarkets) {
        const mark = safeNum(m.mark_price || m.last_price);
        if (mark > 0) markById.set(String(m.market_id), mark);
      }
      const candidates: (PositionRow & { distancePct: number })[] = [];
      for (const trader of tradersMap.values()) {
        if (!trader.portfolioEnriched) continue;
        for (const p of trader.positions) {
          const markPrice = markById.get(p.marketId) || p.markPrice;
          const dist = liquidationDistancePct(markPrice, p.liquidationPrice);
          if (dist !== null && dist < LIQUIDATION_CANDIDATE_PCT) {
            candidates.push({ ...p, markPrice, distancePct: dist });
          }
        }
      }
      candidates.sort((a, b) => a.distancePct - b.distancePct);
      const atRisk = candidates.filter((p) => p.distancePct < LIQUIDATION_ALERT_PCT).slice(0, 100);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        atRisk,
        candidates: candidates.slice(0, 500),
        thresholdPct: LIQUIDATION_ALERT_PCT,
        marketsUpdatedAt,
        indexUpdatedAt: lastIndexComplete,
        fetchedAt: Date.now(),
        totalIndexed: tradersMap.size,
      });
    } catch (err: any) {
      res.status(503).json({ error: err.message || 'Liquidation risk feed unavailable' });
    }
  });

  // 5b. Cohort & Bias Analytics (HyperTracker + RiseScreener live aggregation, 5s SWR cached)
  app.get('/api/cohorts', async (_req: Request, res: Response) => {
    try {
      const payload = await cachedCallSWR('cohorts:analytics', 5000, 30000, async () => {
        const markets = await getMarkets().catch(() => marketsCache);
        return buildCohortsAnalytics(Array.from(tradersMap.values()), markets, Date.now());
      });
      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to compute cohort analytics' });
    }
  });

  // 6. Ticker Analytics + Sortable Open Positions
  app.get('/api/ticker/:marketId/analytics', async (req: Request, res: Response) => {
    try {
      const marketId = String(req.params.marketId);
      const markets = await getMarkets();
      const market = markets.find((m) => String(m.market_id) === marketId);
      if (!market) {
        res.status(404).json({ error: `Market ID ${marketId} not found` });
        return;
      }

      const positions: PositionRow[] = [];
      let longCount = 0;
      let shortCount = 0;
      let longNotional = 0;
      let shortNotional = 0;
      let longWeightedEntry = 0;
      let shortWeightedEntry = 0;
      let longUnrealizedPnl = 0;
      let shortUnrealizedPnl = 0;

      for (const trader of tradersMap.values()) {
        for (const pos of trader.positions) {
          if (pos.marketId === marketId) {
            positions.push({
              ...pos,
              username: trader.username,
              avatarUrl: trader.avatarUrl,
            });
            if (pos.side === 'LONG') {
              longCount += 1;
              longNotional += pos.notionalUsd;
              longWeightedEntry += pos.entryPrice * pos.notionalUsd;
              longUnrealizedPnl += pos.unrealizedPnl;
            } else {
              shortCount += 1;
              shortNotional += pos.notionalUsd;
              shortWeightedEntry += pos.entryPrice * pos.notionalUsd;
              shortUnrealizedPnl += pos.unrealizedPnl;
            }
          }
        }
      }

      res.json({
        market,
        positioning: {
          totalPositions: positions.length,
          longCount,
          shortCount,
          longNotional,
          shortNotional,
          avgLongEntry: longNotional > 0 ? longWeightedEntry / longNotional : 0,
          avgShortEntry: shortNotional > 0 ? shortWeightedEntry / shortNotional : 0,
          longUnrealizedPnl,
          shortUnrealizedPnl,
        },
        positions,
        indexedTradersCount: Array.from(tradersMap.values()).filter((t) => t.portfolioEnriched).length,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load ticker analytics' });
    }
  });

  // 7. OHLCV Candles (15s cached)
  app.get('/api/markets/:marketId/candles', async (req: Request, res: Response) => {
    try {
      const marketId = String(req.params.marketId);
      const resolution = String(req.query.resolution || '1H');

      const intervalMap: Record<string, { ns: string; bars: number }> = {
        '1m': { ns: '60000000000', bars: 260 },
        '5m': { ns: '300000000000', bars: 260 },
        '15m': { ns: '900000000000', bars: 260 },
        '1H': { ns: '3600000000000', bars: 260 },
        '4H': { ns: '14400000000000', bars: 260 },
        '1D': { ns: '86400000000000', bars: 260 },
      };
      const cfg = intervalMap[resolution] || intervalMap['1H'];

      const payload = await cachedCall(`candles:${marketId}:${resolution}`, 15000, async () => {
        let toNs = BigInt(Date.now()) * 1000000n;
        try {
          const latestTrade = await fetchJson(`${RISEX_API}/v1/markets/id/${marketId}/trade-history?limit=1`);
          const tStr = latestTrade?.data?.trades?.[0]?.time;
          if (tStr && /^\d+$/.test(tStr)) {
            const tBig = BigInt(tStr);
            if (tBig > toNs) toNs = tBig;
          }
        } catch {
          // fallback
        }

        const intervalBig = BigInt(cfg.ns);
        const fromNs = toNs - intervalBig * BigInt(cfg.bars);

        const tv = await fetchJson(
          `${RISEX_API}/v1/markets/id/${marketId}/trading-view-data?interval=${cfg.ns}&from=${fromNs.toString()}&to=${toNs.toString()}`
        );
        const raw: any[] = tv?.data?.data || [];
        const candles = raw
          .map((c) => ({
            time: nsToMs(c.time),
            open: safeNum(c.open),
            high: safeNum(c.high),
            low: safeNum(c.low),
            close: safeNum(c.close),
            volume: safeNum(c.volume),
          }))
          .sort((a, b) => a.time - b.time);

        return { candles, resolution };
      });

      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load candles' });
    }
  });

  // Real 24h OHLCV-based mini charts, requested in batches to avoid 18+
  // client fetches. Never synthesize sine-wave price series from % change.
  app.get('/api/markets/sparklines', async (req:Request,res:Response) => {
    const ids=String(req.query.ids||'').split(',').map(v=>v.trim())
      .filter(v=>/^\d{1,6}$/.test(v)).slice(0,30);
    const unique=[...new Set(ids)];
    if (!unique.length) {res.json({series:{},fetchedAt:Date.now()});return;}
    const now=Date.now();
    const toNs=(BigInt(now)*1000000n).toString();
    const fromNs=(BigInt(now-40*3600000)*1000000n).toString();
    const series:Record<string,{points:Array<{time:number;price:number}>;lastCandleAt:number|null}>={};
    for(let offset=0;offset<unique.length;offset+=6){
      const batch=await Promise.allSettled(unique.slice(offset,offset+6).map(async (id)=>{
        const result=await cachedCall(`sparkline:${id}`,300000,async()=>{
          const tv=await fetchJson(`${RISEX_API}/v1/markets/id/${id}/trading-view-data?interval=3600000000000&from=${fromNs}&to=${toNs}`,{},9000,0);
          const values=(tv?.data?.data||[]).map((c:any)=>({
            time:nsToMs(c.time),
            value:safeNum(c.close),
          })).filter((p:{time:number;value:number}) => p.time > now-86400000 && p.time <= now+300000 && p.value>0)
            .sort((a:{time:number},b:{time:number})=>a.time-b.time);
          return {
            points:values.slice(-30).map((p:{time:number;value:number})=>({time:p.time,price:p.value})),
            lastCandleAt:values[values.length-1]?.time||null,
          };
        });
        return [id,result] as const;
      }));
      for(const result of batch) if(result.status==='fulfilled')series[result.value[0]]=result.value[1];
    }
    res.json({series,fetchedAt:Date.now(),source:'RISEx 1H OHLCV'});
  });

  // 8. Orderbook (2s cached)
  app.get('/api/markets/:marketId/orderbook', async (req: Request, res: Response) => {
    try {
      const marketId = String(req.params.marketId);
      const payload = await cachedCall(`ob:${marketId}`, 2000, async () => {
        const ob = await fetchJson(`${RISEX_API}/v1/orderbook?market_id=${marketId}`);
        const bids = (ob?.data?.bids || []).map((b: any) => ({ price: b.price, size: b.quantity }));
        const asks = (ob?.data?.asks || []).map((a: any) => ({ price: a.price, size: a.quantity }));
        return { bids, asks };
      });
      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load orderbook' });
    }
  });

  // 9. Market Trades (3s cached)
  app.get('/api/markets/:marketId/trades', async (req: Request, res: Response) => {
    try {
      const marketId = String(req.params.marketId);
      const limit = Math.min(Number(req.query.limit || 60), 200);
      const payload = await cachedCall(`mtrades:${marketId}:${limit}`, 3000, async () => {
        const json = await fetchJson(`${RISEX_API}/v1/markets/id/${marketId}/trade-history?limit=${limit}`);
        return { trades: json?.data?.trades || [] };
      });
      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load market trades' });
    }
  });

  // 10. Market Funding History (30s cached)
  app.get('/api/markets/:marketId/funding', async (req: Request, res: Response) => {
    try {
      const marketId = String(req.params.marketId);
      const payload = await cachedCall(`mfunding:${marketId}`, 30000, async () => {
        const json = await fetchJson(`${RISEX_API}/v1/markets/id/${marketId}/funding-rate-history?limit=48`);
        return { records: json?.data?.records || [] };
      });
      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load funding history' });
    }
  });

  // 11. Global Recent Trade Tape (4s SWR cached)
  app.get('/api/trades/recent', async (_req: Request, res: Response) => {
    try {
      const payload = await getRecentMarketTrades();
      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load recent trades' });
    }
  });

  // 12. Full Wallet Profiler — Accepts 0x address OR RISEx username! Supports ?lite=1 for quick-peek drawer
  app.get('/api/wallet/:addressOrUsername', async (req: Request, res: Response) => {
    try {
      const rawParam = String(req.params.addressOrUsername).trim();
      const isLite = req.query.lite === '1';
      const resolved = await resolveAddressOrUsername(rawParam);
      if (!resolved) {
        res.status(404).json({ error: `Wallet or RISEx username "${rawParam}" not found` });
        return;
      }
      const { address, traderProfile } = resolved;

      if (customSearchedWallets.size >= 500) {
        const first = customSearchedWallets.values().next().value;
        if (first) customSearchedWallets.delete(first);
      }
      customSearchedWallets.add(address);

      if (isLite) {
        const litePayload = await cachedCall(`wallet:lite:${address.toLowerCase()}`, 20000, async () => {
          const [profileRes, detailsRes, statsAllRes] = await Promise.allSettled([
            traderProfile ? Promise.resolve({ data: traderProfile }) : fetchJson(`${RISEX_API}/v1/traders/${address}`),
            fetchJson(`${RISEX_API}/v1/portfolio/details?account=${address}`),
            fetchJson(`${RISEX_API}/v1/portfolio/stats?account=${address}&period=all`),
          ]);
          const profData = profileRes.status === 'fulfilled' ? profileRes.value?.data : null;
          const existingCached = tradersMap.get(address.toLowerCase());
          const mergedProfile = profData || (existingCached?.username
            ? {
                username: existingCached.username,
                avatar_url: existingCached.avatarUrl,
                x_account: existingCached.xHandle ? { username: existingCached.xHandle } : null,
              }
            : null);
          const details = detailsRes.status === 'fulfilled' ? detailsRes.value?.data : null;
          const summary = details?.summary || null;
          const accountValue = safeNum(summary?.total_account_value);
          const positions: PositionRow[] = (details?.positions || [])
            .filter((p: any) => Math.abs(safeNum(p.size)) > 0)
            .map((p: any) => {
              const sz = safeNum(p.size);
              const markPrice = safeNum(p.mark_price);
              const notionalUsd = Math.abs(sz) * markPrice;
              const uPnl = safeNum(p.unrealized_pnl);
              const lev = safeNum(p.leverage);
              const marginBal = safeNum(p.margin_balance) || (lev > 0 ? notionalUsd / lev : notionalUsd);
              return {
                address: details?.account || address,
                username: mergedProfile?.username || null,
                avatarUrl: mergedProfile?.avatar_url || null,
                portfolioValue: accountValue,
                accountLeverage: safeNum(summary?.account_leverage),
                marketId: String(p.market_id),
                marketName: p.market_name || `Market #${p.market_id}`,
                side: sz > 0 ? 'LONG' : 'SHORT',
                size: Math.abs(sz),
                notionalUsd,
                entryPrice: safeNum(p.avg_entry_price),
                markPrice,
                liquidationPrice: safeNum(p.liquidation_price),
                leverage: lev,
                unrealizedPnl: uPnl,
                roiPct: marginBal > 0 ? (uPnl / marginBal) * 100 : 0,
                marginBalance: marginBal,
                marginMode: p.margin_mode === 1 ? 'Isolated' : 'Cross',
              };
            });
          const statsAll = statsAllRes.status === 'fulfilled' ? statsAllRes.value?.data : null;
          const winRateRaw = statsAll?.performance?.win_rate;
          return {
            address: details?.account || address,
            profile: mergedProfile,
            summary,
            positions,
            liteWinRatePct:
              winRateRaw !== undefined && winRateRaw !== '' ? safeNum(winRateRaw) * 100 : null,
            fetchedAt: Date.now(),
          };
        });
        res.json(litePayload);
        return;
      }

      activeInteractiveRequests++;
      const fullPayload = await cachedCallSWR(`wallet:full:${address.toLowerCase()}`, 15_000, 120_000, async () => {
        const [
          profileRes,
          detailsRes,
          headerRes,
          stats7dRes,
          stats30dRes,
          statsAllRes,
          pnl1DRes,
          eq1DRes,
          eq1WRes,
          eq1MRes,
          eqAllRes,
          calRes,
          allRealizedRes,
          tradesRes,
          openOrdersRes,
          ordersRes,
          fundingRes,
          transfersRes,
          marketsListRes,
        ] = await Promise.allSettled([
          traderProfile ? Promise.resolve({ data: traderProfile }) : fetchJson(`${RISEX_API}/v1/traders/${address}`),
          fetchJson(`${RISEX_API}/v1/portfolio/details?account=${address}`, {}, 10000, 2),
          fetchJson(`${RISEX_API}/v1/portfolio/header?account=${address}`, {}, 10000, 2),
          fetchJson(`${RISEX_API}/v1/portfolio/stats?account=${address}&period=7d`),
          fetchJson(`${RISEX_API}/v1/portfolio/stats?account=${address}&period=30d`),
          fetchJson(`${RISEX_API}/v1/portfolio/stats?account=${address}&period=all`),
          fetchJson(`${RISEX_API}/v1/portfolio/chart?account=${address}&period=1D`, {}, 10000, 2),
          fetchJson(`${RISEX_API}/v1/portfolio/equity-chart?account=${address}&period=1D`),
          fetchJson(`${RISEX_API}/v1/portfolio/equity-chart?account=${address}&period=1W`),
          fetchJson(`${RISEX_API}/v1/portfolio/equity-chart?account=${address}&period=1M`),
          fetchJson(`${RISEX_API}/v1/portfolio/equity-chart?account=${address}&period=ALL`),
          fetchJson(`${RISEX_API}/v1/portfolio/pnl-calendar?account=${address}&period=all-time`, {}, 10000, 2),
          fetchAllRealizedPnl(address),
          fetchAllTradeHistory(address),
          fetchJson(`${RISEX_API}/v1/orders/open?account=${address}&limit=100`),
          fetchJson(`${RISEX_API}/v1/orders?account=${address}&limit=200`),
          fetchAllFundingPayments(address),
          fetchAllTransfers(address),
          getMarkets(),
        ]);

        const profData = profileRes.status === 'fulfilled' ? profileRes.value?.data : null;
        const existingCached = tradersMap.get(address.toLowerCase());
        const mergedProfile = profData || (existingCached?.username
          ? {
              username: existingCached.username,
              avatar_url: existingCached.avatarUrl,
              x_account: existingCached.xHandle ? { username: existingCached.xHandle } : null,
            }
          : null);

        if (!existingCached?.portfolioEnriched) {
          enrichWallet(address, 'user-search').catch(() => {});
        }

      const details = detailsRes.status === 'fulfilled' ? detailsRes.value?.data : null;
      if (!details) {
        throw new Error('RISEx API temporarily rate-limited while fetching wallet summary. Please retry.');
      }
      const summary = details?.summary || null;
      const header = headerRes.status === 'fulfilled' ? headerRes.value?.data : null;
      const cal = calRes.status === 'fulfilled' ? calRes.value?.data : null;
      const realizedDataAvailable = allRealizedRes.status === 'fulfilled';
      const tradeHistoryAvailable = tradesRes.status === 'fulfilled';
      const realizedList: any[] = realizedDataAvailable ? allRealizedRes.value : [];
      const allTradesList: any[] = tradeHistoryAvailable ? tradesRes.value : [];
      const fundingList: any[] = fundingRes.status === 'fulfilled' ? fundingRes.value : [];
      const marketsList: any[] = marketsListRes.status === 'fulfilled' ? marketsListRes.value : [];

      const {
        openRealizedByMarket,
        openRealizedCompleteByMarket,
        closedTrades: reconstructedCycles,
        unattributedEventCount,
      } = reconstructTradeLifecycles(
        details?.positions || [],
        allTradesList,
        realizedList,
        marketsList
      );
      // Only publish cycles fully covered by the official settlement history.
      // If the 10,000-event limit cuts through a position, its visible events
      // are just a partial sum, even though the fill lifecycle itself closed.
      const realizedEventsCapped = realizedList.length >= 10000;
      const firstRealizedMs = realizedList.reduce((earliest: number, event: any) => {
        const time = nsToMs(event?.timestamp);
        return time > 0 ? Math.min(earliest, time) : earliest;
      }, Infinity);
      const closedTrades = reconstructedCycles.filter(
        (cycle) =>
          cycle.officialEventCount > 0 &&
          (!realizedEventsCapped || nsToMs(cycle.openTime) >= firstRealizedMs - 1500)
      );
      const unverifiedCyclesCount = reconstructedCycles.length - closedTrades.length;

      // Summarize metrics across official RISEx realized PnL events (falls back to closedTrades if empty)
      const realizedSummary = summarizeRealizedEvents(
        realizedList.length > 0 ? realizedList : closedTrades
      );

      const accountValue = safeNum(summary?.total_account_value);
      const realizedAll = safeNum(summary?.realized_pnl);
      const unrealizedAll = safeNum(summary?.total_unrealized_pnl);
      const totalPnlAll = realizedAll + unrealizedAll;

      const positions: PositionRow[] = (details?.positions || [])
        .filter((p: any) => Math.abs(safeNum(p.size)) > 0)
        .map((p: any) => {
          const sz = safeNum(p.size);
          const markPrice = safeNum(p.mark_price);
          const notionalUsd = Math.abs(sz) * markPrice;
          const uPnl = safeNum(p.unrealized_pnl);
          const lev = safeNum(p.leverage);
          const marginBal = safeNum(p.margin_balance) || (lev > 0 ? notionalUsd / lev : notionalUsd);
          const mId = String(p.market_id);
          return {
            address: details?.account || address,
            username: mergedProfile?.username || null,
            avatarUrl: mergedProfile?.avatar_url || null,
            portfolioValue: accountValue,
            accountLeverage: safeNum(summary?.account_leverage),
            marketId: mId,
            marketName: p.market_name || `Market #${p.market_id}`,
            side: sz > 0 ? 'LONG' : 'SHORT',
            size: Math.abs(sz),
            notionalUsd,
            entryPrice: safeNum(p.avg_entry_price),
            markPrice,
            liquidationPrice: safeNum(p.liquidation_price),
            leverage: lev,
            unrealizedPnl: uPnl,
            realizedPnl: realizedDataAvailable && tradeHistoryAvailable ? (openRealizedByMarket.get(mId) ?? null) : null,
            realizedPnlComplete:
              realizedDataAvailable &&
              tradeHistoryAvailable &&
              (openRealizedCompleteByMarket.get(mId) ?? false) &&
              !realizedEventsCapped,
            roiPct: marginBal > 0 ? (uPnl / marginBal) * 100 : 0,
            marginBalance: marginBal,
            marginMode: p.margin_mode === 1 ? 'Isolated' : 'Cross',
          };
        });

      const rawCalDays: { date: string; pnl: string }[] = cal?.days || [];
      const nowMs = Date.now();
      const pnl1DPoints = pnl1DRes.status === 'fulfilled' ? pnl1DRes.value?.data?.data || [] : [];
      const normalizedCal = normalizeCalendarAndPeriodMetrics(rawCalDays, realizedList, nowMs);
      const pnl24h = computeRolling24hPnl({
        upstreamPnl1D: pnl1DPoints,
        realizedEvents: realizedList,
        calDays: normalizedCal.days,
        nowMs,
      });
      const pnl7d = normalizedCal.periodTotals['7d'];
      const pnl30d = normalizedCal.periodTotals['30d'];

      // Sync ALL fresh live metrics back into tradersMap and invalidate cached leaderboard/cohorts
      const resolvedAddr = details?.account || address;
      const syncKey = address.toLowerCase();
      const prevCached = tradersMap.get(syncKey);
      const nextPnl24hRoi = accountValue > 0 ? calcRoiPct(pnl24h, accountValue) : null;
      const nextPnl7dRoi = accountValue > 0 ? calcRoiPct(pnl7d, accountValue) : null;
      const nextPnl30dRoi = accountValue > 0 ? calcRoiPct(pnl30d, accountValue) : null;
      const nextRoiAll = accountValue > 0 ? calcRoiPct(totalPnlAll, accountValue) : 0;
      const statsAllPerf = statsAllRes.status === 'fulfilled' ? statsAllRes.value?.data?.performance : null;
      const stats30Perf = stats30dRes.status === 'fulfilled' ? stats30dRes.value?.data?.performance : null;
      const activePerf = statsAllPerf || stats30Perf;
      const freshRecord: TraderRecord = {
        address: resolvedAddr,
        username: mergedProfile?.username || prevCached?.username || null,
        avatarUrl:
          mergedProfile?.avatar_url ||
          mergedProfile?.x_account?.profile_image_url ||
          prevCached?.avatarUrl ||
          null,
        xHandle: mergedProfile?.x_account?.username || prevCached?.xHandle || null,
        accountValue,
        usdcBalance: safeNum(summary?.usdc_balance),
        totalNotional: safeNum(summary?.total_notional),
        accountLeverage: safeNum(summary?.account_leverage),
        marginUsagePct: safeNum(summary?.margin_usage) * 100,
        unrealizedPnl: unrealizedAll,
        realizedPnlAll: realizedAll,
        totalPnlAll,
        roiAllPct: nextRoiAll,
        pnl24h,
        pnl7d,
        pnl30d,
        roi24hPct: nextPnl24hRoi,
        roi7dPct: nextPnl7dRoi,
        roi30dPct: nextPnl30dRoi,
        volume24h: safeNum(header?.h24?.volume),
        volume7d: safeNum(header?.d7?.volume),
        volume30d: safeNum(header?.d30?.volume),
        volumeAll: Math.max(safeNum(header?.all_time?.volume), prevCached?.volumeAll || 0),
        volumeRank24h: safeNum(header?.h24?.volume_rank),
        volumeRankAll: safeNum(header?.all_time?.volume_rank),
        winRate:
          activePerf?.win_rate !== undefined && activePerf?.win_rate !== ''
            ? safeNum(activePerf.win_rate) * 100
            : prevCached?.winRate ?? null,
        sharpeRatio:
          activePerf?.sharpe_ratio !== undefined && activePerf?.sharpe_ratio !== ''
            ? safeNum(activePerf.sharpe_ratio)
            : prevCached?.sharpeRatio ?? null,
        maxDrawdown:
          activePerf?.max_drawdown !== undefined && activePerf?.max_drawdown !== ''
            ? safeNum(activePerf.max_drawdown) * 100
            : prevCached?.maxDrawdown ?? null,
        profitFactor:
          activePerf?.profit_factor && activePerf.profit_factor !== 'Infinity'
            ? safeNum(activePerf.profit_factor)
            : prevCached?.profitFactor ?? null,
        openPositionsCount: positions.length,
        positions,
        riskLevel: summary?.risk_level || prevCached?.riskLevel || 'NORMAL',
        inLiquidation: Boolean(summary?.in_liquidation),
        portfolioEnriched: true,
        lastUpdated: Date.now(),
        sources: Array.from(new Set([...(prevCached?.sources || []), 'wallet-view'])),
      };
      putTrader(syncKey, freshRecord);
      invalidateLeaderboardAndCohortCaches();

      const transfersData =
        transfersRes.status === 'fulfilled'
          ? transfersRes.value
          : { items: [], complete: false };

      const equityChart = reconstructAccountEquitySeries({
        transfers: transfersData.items,
        realizedEvents: realizedList,
        calDays: normalizedCal.days,
        fundingPayments: fundingList,
        currentAccountValue: accountValue,
        unrealizedPnl: unrealizedAll,
        transfersComplete: transfersData.complete,
        upstreamEquityByWindow: {
          '1D': eq1DRes.status === 'fulfilled' ? eq1DRes.value?.data?.data || [] : [],
          '1W': eq1WRes.status === 'fulfilled' ? eq1WRes.value?.data?.data || [] : [],
          '1M': eq1MRes.status === 'fulfilled' ? eq1MRes.value?.data?.data || [] : [],
          'ALL': eqAllRes.status === 'fulfilled' ? eqAllRes.value?.data?.data || [] : [],
        },
        nowMs,
      });

      const pnlChart = buildConsistentPnlSeries({
        calDays: normalizedCal.days,
        realizedEvents: realizedList,
        upstreamPnl1D: pnl1DPoints,
        totalRealizedPnl: realizedAll,
        unrealizedPnl: unrealizedAll,
        periodPnl: { '24h': pnl24h, '7d': pnl7d, '30d': pnl30d, all: totalPnlAll },
        nowMs,
      });

        return {
          address: details?.account || address,
          profile: mergedProfile,
          summary,
          positions,
          closedTrades,
          tradesCapped: allTradesList.length >= 1600,
          realizedEventsCapped,
          realizedDataAvailable,
          tradeHistoryAvailable,
          unverifiedCyclesCount,
          unattributedRealizedEvents: unattributedEventCount,
          header,
          statsByPeriod: {
            '7d': stats7dRes.status === 'fulfilled' ? stats7dRes.value?.data : null,
            '30d': stats30dRes.status === 'fulfilled' ? stats30dRes.value?.data : null,
            'all': statsAllRes.status === 'fulfilled' ? statsAllRes.value?.data : null,
          },
          pnlChart,
          equityChart,
          pnlCalendar:
            normalizedCal.days.length > 0 || cal
              ? {
                  days: normalizedCal.days,
                  win_days: normalizedCal.win_days,
                  best_day: normalizedCal.best_day || cal?.best_day,
                  period_totals: normalizedCal.periodTotals,
                }
              : null,
          realizedPnlHistory: realizedList,
          realizedSummary,
          trades: allTradesList.slice(0, 300),
          openOrders: openOrdersRes.status === 'fulfilled' ? openOrdersRes.value?.data?.orders || [] : [],
          orderHistory: ordersRes.status === 'fulfilled' ? ordersRes.value?.data?.orders || [] : [],
          fundingPayments: fundingList.slice(0, 300),
          transfers: transfersData.items,
          periodMetrics: {
            '24h': {
              pnl: pnl24h,
              roiPct: accountValue > 0 ? calcRoiPct(pnl24h, accountValue) : null,
              volume: safeNum(header?.h24?.volume),
              rank: safeNum(header?.h24?.volume_rank),
              exposure: safeNum(header?.h24?.market_exposure),
            },
            '7d': {
              pnl: pnl7d,
              roiPct: accountValue > 0 ? calcRoiPct(pnl7d, accountValue) : null,
              volume: safeNum(header?.d7?.volume),
              rank: safeNum(header?.d7?.volume_rank),
              exposure: safeNum(header?.d7?.market_exposure),
            },
            '30d': {
              pnl: pnl30d,
              roiPct: accountValue > 0 ? calcRoiPct(pnl30d, accountValue) : null,
              volume: safeNum(header?.d30?.volume),
              rank: safeNum(header?.d30?.volume_rank),
              exposure: safeNum(header?.d30?.market_exposure),
            },
            'all': {
              pnl: totalPnlAll,
              roiPct: accountValue > 0 ? calcRoiPct(totalPnlAll, accountValue) : null,
              volume: safeNum(header?.all_time?.volume),
              rank: safeNum(header?.all_time?.volume_rank),
              exposure: safeNum(header?.all_time?.market_exposure),
            },
          },
          fetchedAt: Date.now(),
        };
      });

      res.json(fullPayload);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch wallet profile' });
    } finally {
      activeInteractiveRequests = Math.max(0, activeInteractiveRequests - 1);
    }
  });

  // 13. On-Chain Explorer Overview (5s cached)
  app.get('/api/explorer/overview', async (_req: Request, res: Response) => {
    try {
      const payload = await cachedCall('explorer:overview', 5000, async () => {
        const cfg = await getSystemConfig().catch(() => null);
        const routerAddr = cfg?.addresses?.router || '0xaadde0cea454f2bcb26f46ed54c5709b7bb34a7e';
        const perpsAddr = cfg?.addresses?.perps_manager || '0x53f10facfc8965750494e6965f5d6da39b41d852';

        const ordersAddr = cfg?.addresses?.orders_manager;
        const [blocksRes, perpsTxRes, routerTxRes, ordersTxRes, rpcRes] = await Promise.allSettled([
          fetchJson(`${RISE_EXPLORER_API}/blocks`, {}, 8000),
          fetchJson(`${RISE_EXPLORER_API}/addresses/${perpsAddr}/transactions`, {}, 8000),
          fetchJson(`${RISE_EXPLORER_API}/addresses/${routerAddr}/transactions`, {}, 8000),
          ordersAddr ? fetchJson(`${RISE_EXPLORER_API}/addresses/${ordersAddr}/transactions`, {}, 8000) : Promise.resolve(null),
          fetchJson(RISE_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
          }, 5000),
        ]);

        const blocks = blocksRes.status === 'fulfilled' ? blocksRes.value?.items || [] : [];
        const perpsTxs = perpsTxRes.status === 'fulfilled' ? perpsTxRes.value?.items || [] : [];
        const routerTxs = routerTxRes.status === 'fulfilled' ? routerTxRes.value?.items || [] : [];
        const ordersTxs = ordersTxRes.status === 'fulfilled' ? ordersTxRes.value?.items || [] : [];
        const rpcHex = rpcRes.status === 'fulfilled' ? rpcRes.value?.result : null;
        const chainHead = typeof rpcHex === 'string' && /^0x[0-9a-f]+$/i.test(rpcHex) ? parseInt(rpcHex, 16) : null;

        const txMap = new Map<string, any>();
        for (const tx of [...ordersTxs, ...routerTxs, ...perpsTxs]) {
          if (tx?.hash && !txMap.has(tx.hash)) {
            txMap.set(tx.hash, tx);
          }
        }
        const transactions = Array.from(txMap.values())
          .sort((a, b) => (b.block_number || 0) - (a.block_number || 0))
          .slice(0, 40);

        return {
          systemConfig: cfg,
          blocks: blocks.slice(0, 20),
          transactions,
          chainHead,
          fetchedAt: Date.now(),
          sourceStatus: {
            blocks: blocksRes.status === 'fulfilled',
            transactions: [perpsTxRes, routerTxRes, ordersTxRes].some((x) => x.status === 'fulfilled' && Array.isArray(x.value?.items)),
            rpc: chainHead !== null,
          },
        };
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load explorer data' });
    }
  });

  // RPC tip is independent of the asynchronously indexed Blockscout feed.
  // All visitors share a 1.5s cache; this avoids per-browser RPC hammering.
  app.get('/api/chain/live', async (_req: Request, res: Response) => {
    try {
      const payload = await cachedCall('chain:rpc:live', 1500, async () => {
        const rpc = (method: string, params: unknown[]) =>
          fetchJson(RISE_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          }, 4000, 0);
        const headResponse = await rpc('eth_getBlockByNumber', ['latest', false]);
        if (headResponse?.error || !headResponse?.result?.number) {
          throw new Error('RISE RPC did not return a current block');
        }
        const head = Number.parseInt(headResponse.result.number, 16);
        const earlier = await Promise.allSettled(
          [1, 2, 3, 4].filter((n) => head >= n).map((n) =>
            rpc('eth_getBlockByNumber', ['0x' + (head - n).toString(16), false])
              .then((response) => response?.result || null)
          )
        );
        return normalizeRpcBlocks([
          headResponse.result,
          ...earlier.map((result) => result.status === 'fulfilled' ? result.value : null),
        ]);
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json(payload);
    } catch (err: any) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(503).json({ error: err?.message || 'RISE RPC unavailable', source: 'rpc' });
    }
  });

  // 14. Tx Decoder (60s cached)
  app.get('/api/explorer/tx/:hash', async (req: Request, res: Response) => {
    try {
      const hash = String(req.params.hash).trim();
      if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) {
        res.status(400).json({ error: 'Invalid transaction hash' });
        return;
      }

      const payload = await cachedCall(`tx:${hash.toLowerCase()}`, 60000, async () => {
        const [decodeRes, explorerRes] = await Promise.allSettled([
          fetchJson(`${RISEX_API}/v1/tx/${hash}`),
          fetchJson(`${RISE_EXPLORER_API}/transactions/${hash}`, {}, 8000),
        ]);

        return {
          hash,
          decoded: decodeRes.status === 'fulfilled' ? decodeRes.value?.data || decodeRes.value : null,
          explorerTx: explorerRes.status === 'fulfilled' ? explorerRes.value : null,
        };
      });
      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to inspect transaction' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`RISExScan server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
