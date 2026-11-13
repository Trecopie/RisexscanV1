import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { nsToMs } from './src/utils/format.ts';
import { calcRoiPct, reconstructTradeLifecycles, safeNum } from './src/utils/tradeLifecycle.ts';
import {
  buildConsistentPnlSeries,
  computeUtcPeriodPnl,
  normalizeCalendarAndPeriodMetrics,
  reconstructAccountEquitySeries,
} from './src/utils/portfolioCurves.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RISEX_API = 'https://api.rise.trade';
const RISE_RPC = 'https://rpc.risechain.com/';
const RISE_EXPLORER_API = 'https://explorer.risechain.com/api/v2';
const CACHE_FILE = path.join(__dirname, '.risex-index-cache.json');

async function fetchJson(url: string, options: RequestInit = {}, timeoutMs = 10000): Promise<any> {
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
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
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
  realizedPnl?: number;
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
let systemConfigCache: any = null;
const tradersMap = new Map<string, TraderRecord>();
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

function loadDiskCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.traders)) {
      const staleVersion = parsed.cacheVersion !== 2;
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

function saveDiskCache() {
  try {
    const payload = {
      cacheVersion: 2,
      lastIndexComplete,
      authCursor,
      cmCursor,
      authBackfillComplete,
      cmBackfillComplete,
      traders: Array.from(tradersMap.values()),
    };
    const tmpFile = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(payload));
    fs.renameSync(tmpFile, CACHE_FILE);
  } catch {
    // ignore write errors on ephemeral/read-only filesystems
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
    return;
  }

  const rPnl = meta.realizedPnl ?? 0;
  tradersMap.set(key, {
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
      fetchJson(`${RISEX_API}/v1/portfolio/details?account=${norm}`),
      fetchJson(`${RISEX_API}/v1/portfolio/header?account=${norm}`),
      fetchJson(`${RISEX_API}/v1/portfolio/stats?account=${norm}&period=30d`),
      fetchJson(`${RISEX_API}/v1/portfolio/pnl-calendar?account=${norm}&period=1m`),
    ];
    // Fetch RISEx account profile/username if we don't already have it
    const needProfile = !existing?.username;
    if (needProfile) {
      calls.push(fetchJson(`${RISEX_API}/v1/traders/${norm}`));
    }

    const [detailsRes, headerRes, statsRes, calRes, profileRes] = await Promise.allSettled(calls);

    const details = detailsRes.status === 'fulfilled' ? detailsRes.value?.data : null;
    if (!details || !details.summary) return null;

    const summary = details.summary;
    const rawPositions: any[] = details.positions || [];
    const header = headerRes.status === 'fulfilled' ? headerRes.value?.data : null;
    const stats = statsRes.status === 'fulfilled' ? statsRes.value?.data : null;
    const cal = calRes.status === 'fulfilled' ? calRes.value?.data : null;
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
    const { pnl24h, pnl7d, pnl30d } = computeUtcPeriodPnl(days, [], Date.now());

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

    tradersMap.set(key, record);
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
            if (comp.state === 'live' || offset === 0) {
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

  // 3. Blockscout on-chain EOA senders & Auth/Collateral historical non-challenge wallets
  try {
    const cfg = await getSystemConfig().catch(() => null);
    const routerAddr = cfg?.addresses?.router || '0xaadde0cea454f2bcb26f46ed54c5709b7bb34a7e';
    const perpsAddr = cfg?.addresses?.perps_manager || '0x53f10facfc8965750494e6965f5d6da39b41d852';
    const collateralAddr = cfg?.addresses?.collateral_manager || '0x2c03c7d7e2974c6599b6b108879109281ef3f818';
    const authAddr = cfg?.addresses?.auth || '0x0d919daa3f12ae715744eb648c00066c5dbd66f0';

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

async function runBackgroundIndexer() {
  if (isIndexing) return;
  isIndexing = true;
  try {
    await getMarkets(true);
    const priorityList = await discoverAllTraders();
    const now = Date.now();
    const PRIORITY_FRESH_MS = 10 * 60 * 1000;

    // Only re-enrich priority traders if stale (>10m) or not yet enriched, freeing capacity for historical backfill
    const stalePriority = priorityList.filter((addr) => {
      const t = tradersMap.get(addr.toLowerCase());
      return !t || !t.portfolioEnriched || now - t.lastUpdated > PRIORITY_FRESH_MS;
    });
    const prioritySet = new Set(priorityList.map((p) => p.toLowerCase()));

    // Sort remaining discovered wallets by staleness (unenriched first, then oldest)
    const remaining = Array.from(tradersMap.values())
      .filter((t) => !prioritySet.has(t.address.toLowerCase()))
      .sort((a, b) => a.lastUpdated - b.lastUpdated)
      .map((t) => t.address);

    // Enrich stale priority traders + up to 300 historical traders per cycle
    const queue = [...stalePriority.slice(0, 250), ...remaining.slice(0, 300)];
    const BATCH_SIZE = 4;
    for (let i = 0; i < queue.length; i += BATCH_SIZE) {
      const batch = queue.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map((addr) => enrichWallet(addr, 'indexer')));
      // Save periodically
      if (i % 40 === 0 && i > 0) saveDiskCache();
      await new Promise((r) => setTimeout(r, 1250));
    }

    lastIndexComplete = Date.now();
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
    ).catch(() => null);
    const page1: any[] = first?.data?.data || [];
    if (page1.length < 1000) return page1;

    const batch1 = await Promise.all(
      [2, 3, 4, 5].map((p) =>
        fetchJson(`${RISEX_API}/v1/portfolio/realized-pnl?account=${address}&limit=1000&page=${p}`)
          .then((r) => r?.data?.data || [])
          .catch(() => [])
      )
    );
    const all = [...page1, ...batch1.flat()];
    if (batch1[batch1.length - 1].length < 1000) return all;

    const batch2 = await Promise.all(
      [6, 7, 8, 9, 10].map((p) =>
        fetchJson(`${RISEX_API}/v1/portfolio/realized-pnl?account=${address}&limit=1000&page=${p}`)
          .then((r) => r?.data?.data || [])
          .catch(() => [])
      )
    );
    return [...all, ...batch2.flat()];
  });
}

async function fetchAllTradeHistory(address: string): Promise<any[]> {
  return cachedCall(`hist:trades:${address.toLowerCase()}`, 90_000, async () => {
    const first = await fetchJson(
      `${RISEX_API}/v1/trade-history?account=${address}&limit=200&page=1`
    ).catch(() => null);
    const page1: any[] = first?.data?.trades || [];
    if (page1.length < 200) return page1;

    const batch1 = await Promise.all(
      [2, 3, 4, 5, 6].map((p) =>
        fetchJson(`${RISEX_API}/v1/trade-history?account=${address}&limit=200&page=${p}`)
          .then((r) => r?.data?.trades || [])
          .catch(() => [])
      )
    );
    const all = [...page1, ...batch1.flat()];
    if (batch1.some((b) => b.length < 200)) return all;

    const batch2 = await Promise.all(
      [7, 8, 9, 10, 11, 12, 13, 14, 15].map((p) =>
        fetchJson(`${RISEX_API}/v1/trade-history?account=${address}&limit=200&page=${p}`)
          .then((r) => r?.data?.trades || [])
          .catch(() => [])
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

async function startServer() {
  loadDiskCache();

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());

  // Public security headers (allow iframe preview in AI Studio while hardening MIME/referrer)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

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

  runBackgroundIndexer();
  setInterval(() => {
    runBackgroundIndexer();
  }, 120000);

  // 1. Overview Pulse
  app.get('/api/overview', async (_req: Request, res: Response) => {
    try {
      const [markets, config, rpcBlock] = await Promise.all([
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

      res.json({
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
      });
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

  // 5. Liquidation Risk Feed (near-liquidation positions across all indexed traders)
  app.get('/api/liquidations', async (_req: Request, res: Response) => {
    const atRisk: (PositionRow & { distancePct: number })[] = [];
    for (const t of tradersMap.values()) {
      for (const p of t.positions) {
        if (p.liquidationPrice > 0 && p.markPrice > 0) {
          const dist = Math.abs((p.liquidationPrice - p.markPrice) / p.markPrice) * 100;
          if (dist < 15) {
            atRisk.push({ ...p, distancePct: dist });
          }
        }
      }
    }
    atRisk.sort((a, b) => a.distancePct - b.distancePct);
    res.json({ atRisk: atRisk.slice(0, 100), totalIndexed: tradersMap.size });
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
        '1m': { ns: '60000000000', bars: 120 },
        '5m': { ns: '300000000000', bars: 120 },
        '15m': { ns: '900000000000', bars: 120 },
        '1H': { ns: '3600000000000', bars: 120 },
        '4H': { ns: '14400000000000', bars: 120 },
        '1D': { ns: '86400000000000', bars: 90 },
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

  // 11. Global Recent Trade Tape (4s cached)
  app.get('/api/trades/recent', async (_req: Request, res: Response) => {
    try {
      const payload = await cachedCall('trades:recent', 4000, async () => {
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
      let address = rawParam;
      let traderProfile: any = null;

      if (!/^0x[a-fA-F0-9]{40}$/.test(rawParam)) {
        // Try local index by username first, then RISEx /v1/traders/{username}
        const localMatch = Array.from(tradersMap.values()).find(
          (t) => t.username && t.username.toLowerCase() === rawParam.toLowerCase()
        );
        if (localMatch) {
          address = localMatch.address;
        } else {
          try {
            const tr = await fetchJson(`${RISEX_API}/v1/traders/${encodeURIComponent(rawParam)}`);
            if (tr?.data?.address) {
              address = tr.data.address;
              traderProfile = tr.data;
            }
          } catch {
            res.status(404).json({ error: `Wallet or RISEx username "${rawParam}" not found` });
            return;
          }
        }
      }

      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        res.status(400).json({ error: 'Invalid wallet address or unknown RISEx username' });
        return;
      }

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
          fetchJson(`${RISEX_API}/v1/portfolio/details?account=${address}`),
          fetchJson(`${RISEX_API}/v1/portfolio/header?account=${address}`),
          fetchJson(`${RISEX_API}/v1/portfolio/stats?account=${address}&period=7d`),
          fetchJson(`${RISEX_API}/v1/portfolio/stats?account=${address}&period=30d`),
          fetchJson(`${RISEX_API}/v1/portfolio/stats?account=${address}&period=all`),
          fetchJson(`${RISEX_API}/v1/portfolio/chart?account=${address}&period=1D`),
          fetchJson(`${RISEX_API}/v1/portfolio/equity-chart?account=${address}&period=1D`),
          fetchJson(`${RISEX_API}/v1/portfolio/equity-chart?account=${address}&period=1W`),
          fetchJson(`${RISEX_API}/v1/portfolio/equity-chart?account=${address}&period=1M`),
          fetchJson(`${RISEX_API}/v1/portfolio/equity-chart?account=${address}&period=ALL`),
          fetchJson(`${RISEX_API}/v1/portfolio/pnl-calendar?account=${address}&period=all-time`),
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
      const summary = details?.summary || null;
      const header = headerRes.status === 'fulfilled' ? headerRes.value?.data : null;
      const cal = calRes.status === 'fulfilled' ? calRes.value?.data : null;
      const realizedList: any[] = allRealizedRes.status === 'fulfilled' ? allRealizedRes.value : [];
      const allTradesList: any[] = tradesRes.status === 'fulfilled' ? tradesRes.value : [];
      const fundingList: any[] = fundingRes.status === 'fulfilled' ? fundingRes.value : [];
      const marketsList: any[] = marketsListRes.status === 'fulfilled' ? marketsListRes.value : [];

      const { openRealizedByMarket, closedTrades } = reconstructTradeLifecycles(
        details?.positions || [],
        allTradesList,
        realizedList,
        marketsList
      );

      // Summarize metrics across completely closed trades
      let netRealizedPnl = 0;
      let grossProfit = 0;
      let grossLoss = 0;
      let totalFunding = 0;
      let wins = 0;
      let losses = 0;
      let bestClose = -Infinity;
      let worstClose = Infinity;
      for (const ct of closedTrades) {
        const p = ct.realizedPnl;
        netRealizedPnl += p;
        totalFunding += ct.funding;
        if (p > 0) {
          grossProfit += p;
          wins++;
        } else if (p < 0) {
          grossLoss += p;
          losses++;
        }
        if (p > bestClose) bestClose = p;
        if (p < worstClose) worstClose = p;
      }
      const totalEvents = closedTrades.length;
      const realizedSummary = {
        totalEvents,
        netRealizedPnl,
        grossProfit,
        grossLoss,
        totalFunding,
        wins,
        losses,
        winRatePct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0,
        profitFactor: grossLoss !== 0 ? grossProfit / Math.abs(grossLoss) : grossProfit > 0 ? null : 0,
        bestClose: totalEvents > 0 ? bestClose : 0,
        worstClose: totalEvents > 0 ? worstClose : 0,
      };

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
            realizedPnl: openRealizedByMarket.get(mId) ?? 0,
            roiPct: marginBal > 0 ? (uPnl / marginBal) * 100 : 0,
            marginBalance: marginBal,
            marginMode: p.margin_mode === 1 ? 'Isolated' : 'Cross',
          };
        });

      const rawCalDays: { date: string; pnl: string }[] = cal?.days || [];
      const nowMs = Date.now();
      const pnl1DPoints = pnl1DRes.status === 'fulfilled' ? pnl1DRes.value?.data?.data || [] : [];
      const normalizedCal = normalizeCalendarAndPeriodMetrics(rawCalDays, realizedList, nowMs);
      const pnl24h = normalizedCal.periodTotals['24h'];
      const pnl7d = normalizedCal.periodTotals['7d'];
      const pnl30d = normalizedCal.periodTotals['30d'];

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
          tradesCapped: allTradesList.length >= 3000,
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
    }
  });

  // 13. On-Chain Explorer Overview (5s cached)
  app.get('/api/explorer/overview', async (_req: Request, res: Response) => {
    try {
      const payload = await cachedCall('explorer:overview', 5000, async () => {
        const cfg = await getSystemConfig().catch(() => null);
        const routerAddr = cfg?.addresses?.router || '0xaadde0cea454f2bcb26f46ed54c5709b7bb34a7e';
        const perpsAddr = cfg?.addresses?.perps_manager || '0x53f10facfc8965750494e6965f5d6da39b41d852';

        const [blocksRes, perpsTxRes, routerTxRes] = await Promise.allSettled([
          fetchJson(`${RISE_EXPLORER_API}/blocks`, {}, 8000),
          fetchJson(`${RISE_EXPLORER_API}/addresses/${perpsAddr}/transactions`, {}, 8000),
          fetchJson(`${RISE_EXPLORER_API}/addresses/${routerAddr}/transactions`, {}, 8000),
        ]);

        const blocks = blocksRes.status === 'fulfilled' ? blocksRes.value?.items || [] : [];
        const perpsTxs = perpsTxRes.status === 'fulfilled' ? perpsTxRes.value?.items || [] : [];
        const routerTxs = routerTxRes.status === 'fulfilled' ? routerTxRes.value?.items || [] : [];

        const txMap = new Map<string, any>();
        for (const tx of [...routerTxs, ...perpsTxs]) {
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
        };
      });
      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load explorer data' });
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
