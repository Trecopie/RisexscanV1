import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFundingHeatmap,
  buildMarketDashboard,
  buildMarketSectors,
  buildOpenInterestLeaders,
  computeProfitabilitySummary,
  computeTakerFlow,
  normalizeMarketSector,
} from './overviewAnalytics.ts';
import type { RisexMarket } from '../types/risex.ts';

function mkMarket(overrides: Partial<RisexMarket>): RisexMarket {
  return {
    market_id: '1',
    config: {
      name: 'BTC/USDC',
      quote: 'USDC',
      step_size: '0.001',
      step_price: '1',
      maintenance_margin_factor: '0.01',
      max_leverage: '50',
      min_order_size: '0.001',
      unlocked: true,
      open_interest_limit: '1000000',
      match_price_band: '0.05',
    },
    base_asset_symbol: 'BTC/USDC',
    quote_asset_symbol: 'USDC',
    underlying: 'BTC',
    display_name: 'BTC/USDC',
    quote_volume_24h: '1000000',
    change_24h: '500',
    high_24h: '91000',
    low_24h: '89000',
    last_price: '90000',
    mark_price: '90000',
    index_price: '90000',
    max_position_size: '100',
    open_interest: '100',
    funding_interval: '3600',
    next_funding_time: '0',
    post_only: false,
    predicted_funding_rate: '0.00001',
    current_funding_rate: '0.00001',
    funding_rate_8h: '0.00008',
    active: true,
    category: 'crypto',
    search_tags: [],
    is_new: false,
    ...overrides,
  };
}

test('normalizeMarketSector classifies Crypto, Stocks, Commodities, Index ETFs accurately', () => {
  assert.equal(normalizeMarketSector('crypto', 'BTC/USDC'), 'crypto');
  assert.equal(normalizeMarketSector('stocks', 'NVDA/USDC'), 'stocks');
  assert.equal(normalizeMarketSector('commodity', 'XAU/USDC'), 'commodity');
  assert.equal(normalizeMarketSector('index_etf', 'SPY/USDC'), 'index_etf');
  assert.equal(normalizeMarketSector('', 'XAG/USDC'), 'commodity');
});

test('buildMarketSectors computes Perp vs RWA breakdown and shares totaling 100%', () => {
  const markets = [
    mkMarket({
      market_id: '1',
      base_asset_symbol: 'BTC/USDC',
      display_name: 'BTC/USDC',
      category: 'crypto',
      quote_volume_24h: '600',
      open_interest: '1',
      mark_price: '100',
      current_funding_rate: '0.00001',
    }),
    mkMarket({
      market_id: '2',
      base_asset_symbol: 'NVDA/USDC',
      display_name: 'NVDA/USDC',
      category: 'stocks',
      quote_volume_24h: '250',
      open_interest: '2',
      mark_price: '100',
      current_funding_rate: '-0.00002',
    }),
    mkMarket({
      market_id: '3',
      base_asset_symbol: 'XAU/USDC',
      display_name: 'XAU/USDC',
      category: 'commodity',
      quote_volume_24h: '100',
      open_interest: '1',
      mark_price: '100',
    }),
    mkMarket({
      market_id: '4',
      base_asset_symbol: 'SPY/USDC',
      display_name: 'SPY/USDC',
      category: 'index_etf',
      quote_volume_24h: '50',
      open_interest: '1',
      mark_price: '100',
    }),
  ];

  const out = buildMarketSectors(markets);
  assert.equal(out.totalVolume24h, 1000);
  assert.equal(out.perpVolume24h, 600);
  assert.equal(out.rwaVolume24h, 400);
  assert.equal(out.perpCount, 1);
  assert.equal(out.rwaCount, 3);
  assert.equal(out.totalOpenInterestUsd, 500);
  const sumShare = out.sectors.reduce((s, sec) => s + sec.volumeSharePct, 0);
  assert.ok(Math.abs(sumShare - 100) < 1e-9);
});

test('buildOpenInterestLeaders & buildFundingHeatmap rank correctly', () => {
  const markets = [
    mkMarket({ market_id: '1', base_asset_symbol: 'BTC/USDC', open_interest: '10', mark_price: '100', current_funding_rate: '0.00001' }),
    mkMarket({ market_id: '2', base_asset_symbol: 'ETH/USDC', open_interest: '30', mark_price: '100', current_funding_rate: '-0.00005' }),
  ];

  const oi = buildOpenInterestLeaders(markets, 5);
  assert.equal(oi[0].symbol, 'ETH');
  assert.equal(oi[0].relTopPct, 100);
  assert.ok(Math.abs(oi[1].relTopPct - 33.333333) < 0.01);

  const heat = buildFundingHeatmap(markets, 5);
  assert.equal(heat[0].symbol, 'ETH');
  assert.ok(heat[0].aprPct < 0);
});

test('computeTakerFlow & computeProfitabilitySummary compute accurate ratios', () => {
  const flow = computeTakerFlow([
    { id: '1', maker_side: 'buy', price: '100', size: '3', time: '1', block_number: '1', log_index: '1' },
    { id: '2', maker_side: 'sell', price: '100', size: '1', time: '2', block_number: '1', log_index: '2' },
  ]);
  assert.equal(flow.buyUsd, 300);
  assert.equal(flow.sellUsd, 100);
  assert.equal(flow.buySharePct, 75);

  const prof = computeProfitabilitySummary([
    {
      portfolioEnriched: true,
      accountValue: 1000,
      totalPnlAll: 500,
      positions: [{ side: 'LONG', notionalUsd: 3000 } as any],
    },
    {
      portfolioEnriched: true,
      accountValue: 500,
      totalPnlAll: -200,
      positions: [{ side: 'SHORT', notionalUsd: 1000 } as any],
    },
    {
      portfolioEnriched: false,
      accountValue: 0,
      totalPnlAll: 99999,
      positions: [],
    },
  ]);
  assert.equal(prof.enrichedAccounts, 2);
  assert.equal(prof.inProfitCount, 1);
  assert.equal(prof.atLossCount, 1);
  assert.equal(prof.profitabilityPct, 50);
  assert.equal(prof.longOiUsd, 3000);
  assert.equal(prof.shortOiUsd, 1000);
  assert.equal(prof.longOiSharePct, 75);
});

test('buildMarketDashboard filters by sector and ranks volume, gainers, and losers', () => {
  const markets = [
    mkMarket({
      market_id: '1',
      base_asset_symbol: 'BTC/USDC',
      category: 'crypto',
      mark_price: '110',
      change_24h: '10', // +10%
      quote_volume_24h: '500000',
      open_interest: '100',
    }),
    mkMarket({
      market_id: '2',
      base_asset_symbol: 'ETH/USDC',
      category: 'crypto',
      mark_price: '90',
      change_24h: '-10', // -10%
      quote_volume_24h: '800000',
      open_interest: '200',
    }),
    mkMarket({
      market_id: '3',
      base_asset_symbol: 'NVDA/USDC',
      category: 'stocks',
      mark_price: '120',
      change_24h: '20', // +20%
      quote_volume_24h: '300000',
      open_interest: '50',
    }),
    mkMarket({
      market_id: '4',
      base_asset_symbol: 'XAU/USDC',
      category: 'commodity',
      mark_price: '95',
      change_24h: '-5', // -5%
      quote_volume_24h: '100000',
      open_interest: '20',
    }),
    mkMarket({
      market_id: '5',
      base_asset_symbol: 'OLD/USDC',
      category: 'crypto',
      active: false,
      mark_price: '100',
      change_24h: '99',
      quote_volume_24h: '9999999',
    }),
  ];

  const all = buildMarketDashboard(markets, 'all', 6);
  assert.equal(all.marketCount, 4);
  assert.equal(all.totalVolume24h, 1700000);
  assert.equal(all.topVolume[0].symbol, 'ETH');
  assert.equal(all.gainers[0].symbol, 'NVDA');
  assert.equal(all.losers[0].symbol, 'ETH');

  const cryptoOnly = buildMarketDashboard(markets, 'crypto', 6);
  assert.equal(cryptoOnly.marketCount, 2);
  assert.equal(cryptoOnly.gainers[0].symbol, 'BTC');
  assert.equal(cryptoOnly.losers[0].symbol, 'ETH');

  const rwaOnly = buildMarketDashboard(markets, 'rwa', 6);
  assert.equal(rwaOnly.marketCount, 2);
  assert.equal(rwaOnly.topVolume[0].symbol, 'NVDA');
  assert.equal(rwaOnly.gainers[0].symbol, 'NVDA');
  assert.equal(rwaOnly.losers[0].symbol, 'XAU');
});
