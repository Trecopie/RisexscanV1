import test from 'node:test';
import assert from 'node:assert/strict';
import type { RisexMarket } from '../types/risex.ts';
import { filterDirectoryMarkets, summarizeDirectoryMarkets } from './marketDirectory.ts';

const sample = (market_id: string, category: string, volume: string, oi: string, mark: string, display_name: string): RisexMarket => ({
  market_id,
  category,
  display_name,
  base_asset_symbol: display_name,
  search_tags: [],
  quote_volume_24h: volume,
  open_interest: oi,
  mark_price: mark,
  last_price: mark,
} as unknown as RisexMarket);

const markets = [
  sample('1', 'crypto', '1000', '2', '100', 'BTC/USDC'),
  sample('2', 'commodity', '500', '4', '50', 'XAU/USDC'),
  sample('3', 'stocks', '300', '10', '20', 'NVDA/USDC'),
  sample('4', 'index_etf', '200', '5', '40', 'QQQ/USDC'),
];

test('All Markets metrics use precisely the visible market list', () => {
  const filtered = filterDirectoryMarkets(markets, 'ALL', '');
  assert.equal(filtered.length, 4);
  assert.deepEqual(summarizeDirectoryMarkets(filtered), {
    marketCount: 4, volume24h: 2000, openInterestUsd: 800,
  });
});

test('the active category changes the count, volume and dollar open interest together', () => {
  for (const [category, volume, openInterestUsd] of [
    ['CRYPTO', 1000, 200],
    ['COMMODITY', 500, 200],
    ['STOCKS', 300, 200],
    ['INDEX_ETF', 200, 200],
  ] as const) {
    assert.deepEqual(summarizeDirectoryMarkets(filterDirectoryMarkets(markets, category, '')), {
      marketCount: 1, volume24h: volume, openInterestUsd,
    });
  }
});

test('typing into ticker search also updates the metrics for matching rows', () => {
  assert.deepEqual(summarizeDirectoryMarkets(filterDirectoryMarkets(markets, 'ALL', ' nvda ')), {
    marketCount: 1, volume24h: 300, openInterestUsd: 200,
  });
  assert.deepEqual(summarizeDirectoryMarkets(filterDirectoryMarkets(markets, 'CRYPTO', 'XAU')), {
    marketCount: 0, volume24h: 0, openInterestUsd: 0,
  });
});

test('bad or negative upstream numeric fields do not inflate volume or OI', () => {
  const rows = [sample('bad', 'crypto', 'not-a-number', '-5', 'NaN', 'BAD')];
  assert.deepEqual(summarizeDirectoryMarkets(rows), {
    marketCount: 1, volume24h: 0, openInterestUsd: 0,
  });
});

test('a halted market is excluded from live count, volume and OI unless explicitly included', () => {
  const halted = { ...sample('99', 'stocks', '9000', '20', '200', 'DELISTED/USDC'), active: false };
  const universe = [...markets, halted];
  assert.deepEqual(summarizeDirectoryMarkets(filterDirectoryMarkets(universe, 'ALL', '')), {
    marketCount: 4, volume24h: 2000, openInterestUsd: 800,
  });
  assert.deepEqual(summarizeDirectoryMarkets(filterDirectoryMarkets(universe, 'ALL', '', true)), {
    marketCount: 5, volume24h: 11000, openInterestUsd: 4800,
  });
});
