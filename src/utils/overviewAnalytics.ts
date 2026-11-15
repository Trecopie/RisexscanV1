import type { IndexedTrader, MarketTrade, RisexMarket } from '../types/risex';
import { calcMarketChangePct } from './format';

export type MarketSectorId = 'crypto' | 'stocks' | 'commodity' | 'index_etf';

export interface MarketSectorStat {
  id: MarketSectorId;
  label: string;
  shortLabel: string;
  group: 'PERP' | 'RWA';
  count: number;
  volume24h: number;
  volumeSharePct: number;
  openInterestUsd: number;
  oiSharePct: number;
  avgFundingAprPct: number;
  topSymbol: string;
  topMarketId: string;
}

export interface OpenInterestLeaderItem {
  marketId: string;
  symbol: string;
  displayName: string;
  category: MarketSectorId;
  openInterestUsd: number;
  sharePct: number;
  relTopPct: number;
  volume24h: number;
  changePct: number;
  fundingAprPct: number;
}

export interface FundingHeatmapItem {
  marketId: string;
  symbol: string;
  displayName: string;
  category: MarketSectorId;
  rate1hPct: number;
  aprPct: number;
  markPrice: number;
  openInterestUsd: number;
}

export interface VolumeHeatmapItem {
  marketId: string;
  symbol: string;
  displayName: string;
  category: MarketSectorId;
  volume24h: number;
  sharePct: number;
  changePct: number;
  markPrice: number;
}

export interface TakerFlowSummary {
  buyCount: number;
  sellCount: number;
  buyUsd: number;
  sellUsd: number;
  totalUsd: number;
  buySharePct: number;
  sellSharePct: number;
}

export interface ProfitabilitySummary {
  totalAccounts: number;
  enrichedAccounts: number;
  inProfitCount: number;
  atLossCount: number;
  profitabilityPct: number;
  totalEquityUsd: number;
  totalPnlSumUsd: number;
  longOiUsd: number;
  shortOiUsd: number;
  longPositionsCount: number;
  shortPositionsCount: number;
  longOiSharePct: number;
}

export type DashboardSectorFilter = 'all' | 'crypto' | 'rwa';

export interface MarketDashboardEntry {
  marketId: string;
  symbol: string;
  displayName: string;
  sector: MarketSectorId;
  group: 'PERP' | 'RWA';
  markPrice: number;
  changePct: number;
  volume24h: number;
  openInterestUsd: number;
  fundingAprPct: number;
  maxLeverage: string;
}

export interface MarketDashboardData {
  filter: DashboardSectorFilter;
  marketCount: number;
  totalVolume24h: number;
  totalOpenInterestUsd: number;
  advancers: number;
  decliners: number;
  unchanged: number;
  advancersPct: number;
  topVolume: MarketDashboardEntry[];
  gainers: MarketDashboardEntry[];
  losers: MarketDashboardEntry[];
}

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function cleanBaseSymbol(symbol: string): string {
  return String(symbol || '')
    .replace(/\/.*$/, '')
    .replace(/\s*\[deprecated.*$/i, '')
    .trim()
    .toUpperCase();
}

export function normalizeMarketSector(category?: string | null, baseSymbol?: string | null): MarketSectorId {
  const raw = String(category || '').toLowerCase().trim();
  if (raw === 'commodity' || raw === 'commodities') return 'commodity';
  if (raw === 'stocks' || raw === 'stock' || raw === 'equity' || raw === 'equities') return 'stocks';
  if (raw === 'index_etf' || raw === 'etf' || raw === 'index') return 'index_etf';
  if (raw === 'crypto') return 'crypto';

  const clean = cleanBaseSymbol(baseSymbol || '');
  if (['XAU', 'XAG', 'CL', 'BZ'].includes(clean)) return 'commodity';
  if (['SPY', 'QQQ', 'DRAM', 'KORU', 'EWZ'].includes(clean)) return 'index_etf';
  if (
    [
      'NVDA', 'TSLA', 'AAPL', 'GOOGL', 'META', 'MSTR', 'INTC', 'MU', 'ARM',
      'QCOM', 'SNDK', 'SPCX', 'CRCL', 'HOOD', 'SKHYNIX', 'SOXL', 'CRWV',
      'LLY', 'TTWO', 'HIMS',
    ].includes(clean)
  ) {
    return 'stocks';
  }
  return 'crypto';
}

const SECTOR_META: Record<MarketSectorId, { label: string; shortLabel: string; group: 'PERP' | 'RWA' }> = {
  crypto: { label: 'Crypto Perps', shortLabel: 'CRYPTO', group: 'PERP' },
  stocks: { label: 'Equities', shortLabel: 'STOCK', group: 'RWA' },
  commodity: { label: 'Commodities', shortLabel: 'CMDTY', group: 'RWA' },
  index_etf: { label: 'Index ETFs', shortLabel: 'ETF', group: 'RWA' },
};

export function buildMarketSectors(markets: RisexMarket[]): {
  sectors: MarketSectorStat[];
  perpVolume24h: number;
  rwaVolume24h: number;
  perpOiUsd: number;
  rwaOiUsd: number;
  perpCount: number;
  rwaCount: number;
  totalVolume24h: number;
  totalOpenInterestUsd: number;
} {
  const buckets = new Map<
    MarketSectorId,
    {
      count: number;
      volume24h: number;
      openInterestUsd: number;
      fundingAprSum: number;
      topVol: number;
      topSymbol: string;
      topMarketId: string;
    }
  >();

  const order: MarketSectorId[] = ['crypto', 'stocks', 'commodity', 'index_etf'];
  for (const id of order) {
    buckets.set(id, {
      count: 0,
      volume24h: 0,
      openInterestUsd: 0,
      fundingAprSum: 0,
      topVol: -1,
      topSymbol: '—',
      topMarketId: '',
    });
  }

  let totalVolume24h = 0;
  let totalOpenInterestUsd = 0;

  for (const m of markets) {
    if (m.active === false) continue;
    const secId = normalizeMarketSector(m.category, m.base_asset_symbol);
    const mark = toNum(m.mark_price || m.last_price);
    const vol = toNum(m.quote_volume_24h);
    const oiUsd = toNum(m.open_interest) * mark;
    const rate1h = toNum(m.current_funding_rate);
    const fundingApr = rate1h * 24 * 365 * 100;

    totalVolume24h += vol;
    totalOpenInterestUsd += oiUsd;

    const b = buckets.get(secId)!;
    b.count += 1;
    b.volume24h += vol;
    b.openInterestUsd += oiUsd;
    b.fundingAprSum += fundingApr;
    if (vol > b.topVol) {
      b.topVol = vol;
      b.topSymbol = cleanBaseSymbol(m.base_asset_symbol || m.display_name);
      b.topMarketId = String(m.market_id);
    }
  }

  const sectors: MarketSectorStat[] = order.map((id) => {
    const b = buckets.get(id)!;
    const meta = SECTOR_META[id];
    return {
      id,
      label: meta.label,
      shortLabel: meta.shortLabel,
      group: meta.group,
      count: b.count,
      volume24h: b.volume24h,
      volumeSharePct: totalVolume24h > 0 ? (b.volume24h / totalVolume24h) * 100 : 0,
      openInterestUsd: b.openInterestUsd,
      oiSharePct: totalOpenInterestUsd > 0 ? (b.openInterestUsd / totalOpenInterestUsd) * 100 : 0,
      avgFundingAprPct: b.count > 0 ? b.fundingAprSum / b.count : 0,
      topSymbol: b.topSymbol,
      topMarketId: b.topMarketId,
    };
  });

  const perpSector = sectors.find((s) => s.id === 'crypto')!;
  const rwaSectors = sectors.filter((s) => s.group === 'RWA');

  return {
    sectors,
    perpVolume24h: perpSector.volume24h,
    rwaVolume24h: rwaSectors.reduce((s, r) => s + r.volume24h, 0),
    perpOiUsd: perpSector.openInterestUsd,
    rwaOiUsd: rwaSectors.reduce((s, r) => s + r.openInterestUsd, 0),
    perpCount: perpSector.count,
    rwaCount: rwaSectors.reduce((s, r) => s + r.count, 0),
    totalVolume24h,
    totalOpenInterestUsd,
  };
}

export function buildOpenInterestLeaders(markets: RisexMarket[], limit = 10): OpenInterestLeaderItem[] {
  const active = markets.filter((m) => m.active !== false);
  const totalOi = active.reduce(
    (s, m) => s + toNum(m.open_interest) * toNum(m.mark_price || m.last_price),
    0
  );

  const items = active
    .map((m) => {
      const mark = toNum(m.mark_price || m.last_price);
      const oiUsd = toNum(m.open_interest) * mark;
      const rate1h = toNum(m.current_funding_rate);
      return {
        marketId: String(m.market_id),
        symbol: cleanBaseSymbol(m.base_asset_symbol || m.display_name),
        displayName: m.display_name,
        category: normalizeMarketSector(m.category, m.base_asset_symbol),
        openInterestUsd: oiUsd,
        sharePct: totalOi > 0 ? (oiUsd / totalOi) * 100 : 0,
        relTopPct: 0,
        volume24h: toNum(m.quote_volume_24h),
        changePct: calcMarketChangePct(mark, m.change_24h),
        fundingAprPct: rate1h * 24 * 365 * 100,
      };
    })
    .sort((a, b) => b.openInterestUsd - a.openInterestUsd)
    .slice(0, limit);

  const maxOi = items[0]?.openInterestUsd || 1;
  return items.map((item) => ({
    ...item,
    relTopPct: (item.openInterestUsd / maxOi) * 100,
  }));
}

export function buildFundingHeatmap(markets: RisexMarket[], limit = 15): FundingHeatmapItem[] {
  return markets
    .filter((m) => m.active !== false)
    .map((m) => {
      const mark = toNum(m.mark_price || m.last_price);
      const rate1h = toNum(m.current_funding_rate);
      return {
        marketId: String(m.market_id),
        symbol: cleanBaseSymbol(m.base_asset_symbol || m.display_name),
        displayName: m.display_name,
        category: normalizeMarketSector(m.category, m.base_asset_symbol),
        rate1hPct: rate1h * 100,
        aprPct: rate1h * 24 * 365 * 100,
        markPrice: mark,
        openInterestUsd: toNum(m.open_interest) * mark,
      };
    })
    .sort((a, b) => Math.abs(b.aprPct) - Math.abs(a.aprPct))
    .slice(0, limit);
}

export function buildVolumeHeatmap(markets: RisexMarket[], limit = 16): VolumeHeatmapItem[] {
  const active = markets.filter((m) => m.active !== false);
  const totalVol = active.reduce((s, m) => s + toNum(m.quote_volume_24h), 0);

  return active
    .map((m) => {
      const mark = toNum(m.mark_price || m.last_price);
      const vol = toNum(m.quote_volume_24h);
      return {
        marketId: String(m.market_id),
        symbol: cleanBaseSymbol(m.base_asset_symbol || m.display_name),
        displayName: m.display_name,
        category: normalizeMarketSector(m.category, m.base_asset_symbol),
        volume24h: vol,
        sharePct: totalVol > 0 ? (vol / totalVol) * 100 : 0,
        changePct: calcMarketChangePct(mark, m.change_24h),
        markPrice: mark,
      };
    })
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, limit);
}

export function computeTakerFlow(trades: MarketTrade[]): TakerFlowSummary {
  let buyCount = 0;
  let sellCount = 0;
  let buyUsd = 0;
  let sellUsd = 0;

  for (const tr of trades) {
    const usd = toNum(tr.price) * toNum(tr.size);
    // RISEx reports MAKER side. Taker flow is the opposite of that side:
    // maker 0/BUY -> taker SELL; maker 1/SELL -> taker BUY.
    const makerSide = String(tr.maker_side ?? '').toLowerCase().trim();
    if (!['0', '1', 'buy', 'sell'].includes(makerSide)) continue;
    const takerIsBuy = makerSide === '1' || makerSide === 'sell';
    if (takerIsBuy) {
      buyCount += 1;
      buyUsd += usd;
    } else {
      sellCount += 1;
      sellUsd += usd;
    }
  }

  const totalUsd = buyUsd + sellUsd;
  const buySharePct = totalUsd > 0 ? (buyUsd / totalUsd) * 100 : 50;
  return {
    buyCount,
    sellCount,
    buyUsd,
    sellUsd,
    totalUsd,
    buySharePct,
    sellSharePct: 100 - buySharePct,
  };
}

export function computeProfitabilitySummary(traders: Pick<
  IndexedTrader,
  'portfolioEnriched' | 'accountValue' | 'totalPnlAll' | 'positions'
>[]): ProfitabilitySummary {
  const enriched = traders.filter((t) => t.portfolioEnriched);
  let inProfitCount = 0;
  let atLossCount = 0;
  let totalEquityUsd = 0;
  let totalPnlSumUsd = 0;
  let longOiUsd = 0;
  let shortOiUsd = 0;
  let longPositionsCount = 0;
  let shortPositionsCount = 0;

  for (const t of enriched) {
    totalEquityUsd += toNum(t.accountValue);
    totalPnlSumUsd += toNum(t.totalPnlAll);
    if (t.totalPnlAll > 0) inProfitCount += 1;
    else if (t.totalPnlAll < 0) atLossCount += 1;

    for (const p of t.positions || []) {
      if (p.side === 'LONG') {
        longPositionsCount += 1;
        longOiUsd += toNum(p.notionalUsd);
      } else {
        shortPositionsCount += 1;
        shortOiUsd += toNum(p.notionalUsd);
      }
    }
  }

  const denom = inProfitCount + atLossCount;
  const totalOi = longOiUsd + shortOiUsd;
  return {
    totalAccounts: traders.length,
    enrichedAccounts: enriched.length,
    inProfitCount,
    atLossCount,
    profitabilityPct: denom > 0 ? (inProfitCount / denom) * 100 : 0,
    totalEquityUsd,
    totalPnlSumUsd,
    longOiUsd,
    shortOiUsd,
    longPositionsCount,
    shortPositionsCount,
    longOiSharePct: totalOi > 0 ? (longOiUsd / totalOi) * 100 : 50,
  };
}

export function buildMarketDashboard(
  markets: RisexMarket[],
  filter: DashboardSectorFilter = 'all',
  limit = 6
): MarketDashboardData {
  const entries: MarketDashboardEntry[] = [];
  let totalVolume24h = 0;
  let totalOpenInterestUsd = 0;
  let advancers = 0;
  let decliners = 0;
  let unchanged = 0;

  for (const m of markets) {
    if (m.active === false) continue;
    const markPrice = toNum(m.mark_price || m.last_price);
    if (markPrice <= 0) continue;

    const sector = normalizeMarketSector(m.category, m.base_asset_symbol);
    const group: 'PERP' | 'RWA' = sector === 'crypto' ? 'PERP' : 'RWA';

    if (filter === 'crypto' && group !== 'PERP') continue;
    if (filter === 'rwa' && group !== 'RWA') continue;

    const volume24h = toNum(m.quote_volume_24h);
    const openInterestUsd = toNum(m.open_interest) * markPrice;
    const changePct = calcMarketChangePct(markPrice, m.change_24h);
    if (changePct > 0) advancers++;
    else if (changePct < 0) decliners++;
    else unchanged++;
    const fundingAprPct = toNum(m.current_funding_rate) * 24 * 365 * 100;

    totalVolume24h += volume24h;
    totalOpenInterestUsd += openInterestUsd;

    entries.push({
      marketId: String(m.market_id),
      symbol: cleanBaseSymbol(m.base_asset_symbol || m.display_name),
      displayName: m.display_name || m.base_asset_symbol,
      sector,
      group,
      markPrice,
      changePct,
      volume24h,
      openInterestUsd,
      fundingAprPct,
      maxLeverage: String(m.config?.max_leverage || '—'),
    });
  }

  const topVolume = [...entries]
    .sort((a, b) => b.volume24h - a.volume24h || b.openInterestUsd - a.openInterestUsd)
    .slice(0, limit);

  const gainers = entries
    .filter((entry) => entry.changePct > 0)
    .sort((a, b) => b.changePct - a.changePct || b.volume24h - a.volume24h)
    .slice(0, limit);

  const losers = entries
    .filter((entry) => entry.changePct < 0)
    .sort((a, b) => a.changePct - b.changePct || b.volume24h - a.volume24h)
    .slice(0, limit);

  return {
    filter,
    marketCount: entries.length,
    totalVolume24h,
    totalOpenInterestUsd,
    advancers,
    decliners,
    unchanged,
    advancersPct: entries.length > 0 ? advancers / entries.length * 100 : 0,
    topVolume,
    gainers,
    losers,
  };
}

