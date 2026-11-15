import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMarketPricePatch,
  parseOracleWei,
  applyWsBatchToMarkets,
  parseWsMarketMessage,
  updateOrderbookAndGetMid,
  type OrderbookCache,
} from './marketWsPatch.ts';
import type { RisexMarket } from '../types/risex.ts';

function mkMarket(overrides: Partial<RisexMarket> = {}): RisexMarket {
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
    change_24h: '1000',
    high_24h: '91000',
    low_24h: '89000',
    last_price: '91000',
    mark_price: '91000',
    index_price: '91000',
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

test('parseWsMarketMessage parses trades, orderbook, and funding messages cleanly', () => {
  const subAck = parseWsMarketMessage({ type: 'subscribed', channel: 'trades', status: 'success' });
  assert.equal(subAck.length, 0);

  const tradeFrames = parseWsMarketMessage({
    channel: 'trades',
    type: 'update',
    market_id: '1',
    data: { id: 't-1', maker_side: 'buy', price: '92000', size: '0.5', time: '1700000000' },
  });
  assert.equal(tradeFrames.length, 1);
  assert.equal(tradeFrames[0].kind, 'trade');
  if (tradeFrames[0].kind === 'trade') {
    assert.equal(tradeFrames[0].price, 92000);
    assert.equal(tradeFrames[0].size, 0.5);
  }

  const bookFrames = parseWsMarketMessage({
    channel: 'orderbook',
    type: 'snapshot',
    data: {
      market_id: 1,
      bids: [{ price: '91990', quantity: '2.0' }],
      asks: [{ price: '92010', quantity: '1.5' }],
    },
  });
  assert.equal(bookFrames.length, 1);
  assert.equal(bookFrames[0].kind, 'orderbook');

  const fundingFrames = parseWsMarketMessage({
    channel: 'funding',
    type: 'update',
    market_id: '1',
    data: { funding_rate: '0.000025', funding_rate_8h: '0.0002' },
  });
  assert.equal(fundingFrames.length, 1);
  assert.equal(fundingFrames[0].kind, 'funding');
});

test('updateOrderbookAndGetMid handles snapshots, incremental level deletes, and BBO mid calculation', () => {
  const cache: OrderbookCache = new Map();
  const mid1 = updateOrderbookAndGetMid(cache, {
    kind: 'orderbook',
    marketId: '1',
    isSnapshot: true,
    bids: [
      { price: 100, quantity: 5 },
      { price: 99, quantity: 3 },
    ],
    asks: [
      { price: 102, quantity: 2 },
      { price: 104, quantity: 4 },
    ],
  });
  assert.equal(mid1, 101);

  // Remove best ask 102, best ask becomes 104 -> mid = (100 + 104) / 2 = 102
  const mid2 = updateOrderbookAndGetMid(cache, {
    kind: 'orderbook',
    marketId: '1',
    isSnapshot: false,
    bids: [],
    asks: [{ price: 102, quantity: 0 }],
  });
  assert.equal(mid2, 102);
});

test('applyMarketPricePatch preserves 24h open baseline and updates volume/high/low accurately', () => {
  // mark 91000, change_24h +1000 => open24h = 90000
  const m = mkMarket();
  const updated = applyMarketPricePatch(m, {
    markPrice: 92000,
    lastPrice: 92000,
    tradeVolumeUsd: 46000,
  });
  assert.equal(updated.mark_price, '92000');
  assert.equal(updated.last_price, '92000');
  assert.equal(updated.change_24h, '2000');
  assert.equal(updated.high_24h, '92000');
  assert.equal(updated.low_24h, '89000');
  assert.equal(updated.quote_volume_24h, '1046000');
});

test('applyWsBatchToMarkets batches updates and skips untouched arrays cleanly', () => {
  const cache: OrderbookCache = new Map();
  const markets = [mkMarket({ market_id: '1' }), mkMarket({ market_id: '2', display_name: 'ETH/USDC', mark_price: '2000', last_price: '2000', change_24h: '0' })];

  // Unknown market frame should be a no-op returning identical reference
  const noop = applyWsBatchToMarkets(markets, cache, [
    {
      kind: 'trade',
      marketId: '999',
      price: 50,
      size: 1,
      trade: { id: 'x', maker_side: 'buy', price: '50', size: '1', time: '1', block_number: '', log_index: '' },
    },
  ]);
  assert.equal(noop.changed, false);
  assert.equal(noop.markets, markets);

  const res = applyWsBatchToMarkets(markets, cache, [
    {
      kind: 'orderbook',
      marketId: '2',
      isSnapshot: true,
      bids: [{ price: 2005, quantity: 1 }],
      asks: [{ price: 2015, quantity: 1 }],
    },
    {
      kind: 'trade',
      marketId: '1',
      price: 92000,
      size: 0.5,
      trade: { id: 't1', maker_side: 'buy', price: '92000', size: '0.5', time: '10', block_number: '1', log_index: '1' },
    },
  ]);

  assert.equal(res.changed, true);
  assert.equal(res.markets[0].mark_price, '92000');
  assert.equal(res.markets[1].mark_price, '2010');
  assert.equal(res.markets[1].change_24h, '10');
  assert.equal(res.trades.length, 1);
  assert.equal(res.trades[0].market_name, 'BTC/USDC');
});

test('RISEx oracle frames decode 18-decimal mark/index prices without decimal trade confusion', () => {
  assert.ok(Math.abs((parseOracleWei('63126084821834306372811') || 0) - 63126.08482183431) < 1e-8);
  assert.equal(parseOracleWei('64000000000000000000000'), 64000);
  assert.equal(parseOracleWei('64000'), 6.4e-14); // raw oracle strings are always wei
  assert.equal(parseOracleWei('not-a-price'), undefined);
  const parsed = parseWsMarketMessage({
    channel: 'oracle', type: 'update', market_id: null,
    data: { timestamp: 1786934140, prices: {
      '1': { mark_price: '64000000000000000000000', index_price: '64010000000000000000000' },
      '2': { mark_price: '2000000000000000000000' },
    } },
  });
  assert.equal(parsed.length, 2);
  const market = mkMarket({ mark_price: '63000', last_price: '63000', index_price: '63000', change_24h: '1000' });
  const result = applyWsBatchToMarkets([market], new Map(), parsed);
  assert.equal(result.markets[0].mark_price, '64000');
  assert.equal(result.markets[0].index_price, '64010');
  assert.equal(result.markets[0].change_24h, '2000');
  const mixed = applyWsBatchToMarkets([market], new Map(), [
    parsed[0],
    { kind: 'trade', marketId: '1', price: 63990, size: 1,
      trade: { id: 't', maker_side: 'buy', price: '63990', size: '1', time: '1786934140', block_number: '1', log_index: '1' } },
  ]);
  assert.equal(mixed.markets[0].mark_price, '64000');
  assert.equal(mixed.markets[0].last_price, '63990');
});
