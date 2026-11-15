import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCohortsAnalytics, classifyTraderCohort } from './cohorts.ts';

test('classifyTraderCohort assigns wallet tiers correctly by equity and notional', () => {
  assert.equal(classifyTraderCohort(150_000, 100_000), 'whale');
  assert.equal(classifyTraderCohort(40_000, 600_000), 'whale');
  assert.equal(classifyTraderCohort(40_000, 120_000), 'shark');
  assert.equal(classifyTraderCohort(12_000, 30_000), 'dolphin');
  assert.equal(classifyTraderCohort(2_500, 8_000), 'fish');
  assert.equal(classifyTraderCohort(350, 900), 'shrimp');
});

test('buildCohortsAnalytics computes cohort bias, market divergence, and liquidation radar accurately', () => {
  const traders = [
    {
      address: '0x1111111111111111111111111111111111111111',
      username: 'mega_whale',
      accountValue: 250_000,
      totalNotional: 800_000,
      accountLeverage: 3.2,
      unrealizedPnl: 15_000,
      totalPnlAll: 80_000,
      portfolioEnriched: true,
      positions: [
        {
          address: '0x1111111111111111111111111111111111111111',
          portfolioValue: 250_000,
          accountLeverage: 3.2,
          marketId: '1',
          marketName: 'BTC/USDC',
          side: 'LONG' as const,
          size: 8,
          notionalUsd: 800_000,
          entryPrice: 98_000,
          markPrice: 100_000,
          liquidationPrice: 72_000,
          leverage: 5,
          unrealizedPnl: 15_000,
          roiPct: 9.3,
          marginBalance: 160_000,
          marginMode: 'Cross' as const,
        },
      ],
    },
    {
      address: '0x2222222222222222222222222222222222222222',
      username: 'tiny_shrimp',
      accountValue: 400,
      totalNotional: 2_000,
      accountLeverage: 5,
      unrealizedPnl: -50,
      totalPnlAll: -300,
      portfolioEnriched: true,
      positions: [
        {
          address: '0x2222222222222222222222222222222222222222',
          portfolioValue: 400,
          accountLeverage: 5,
          marketId: '1',
          marketName: 'BTC/USDC',
          side: 'SHORT' as const,
          size: 0.02,
          notionalUsd: 2_000,
          entryPrice: 97_500,
          markPrice: 100_000,
          liquidationPrice: 103_000,
          leverage: 20,
          unrealizedPnl: -50,
          roiPct: -50,
          marginBalance: 100,
          marginMode: 'Isolated' as const,
        },
      ],
    },
  ];

  const markets = [
    {
      market_id: '1',
      base_asset_symbol: 'BTC',
      display_name: 'BTC/USDC',
      mark_price: '100000',
      quote_volume_24h: '50000000',
      open_interest: '150',
      current_funding_rate: '0.0000125',
      active: true,
    },
  ];

  const res = buildCohortsAnalytics(traders, markets, 1_700_000_000_000);
  const whale = res.sizeCohorts.find((c) => c.id === 'whale')!;
  const shrimp = res.sizeCohorts.find((c) => c.id === 'shrimp')!;

  assert.equal(whale.tradersCount, 1);
  assert.equal(whale.biasPct, 100);
  assert.equal(whale.biasLabel, 'NET LONG');
  assert.equal(shrimp.tradersCount, 1);
  assert.equal(shrimp.biasPct, -100);
  assert.equal(shrimp.biasLabel, 'NET SHORT');

  assert.equal(res.marketCohorts.length, 1);
  assert.equal(res.marketCohorts[0].whaleBiasPct, 100);
  assert.equal(res.marketCohorts[0].retailBiasPct, -100);
  assert.equal(res.marketCohorts[0].divergencePct, 200);

  // tiny_shrimp is only 3% away from liquidation ($103k vs $100k) -> present in liquidationRadar
  assert.equal(res.liquidationRadar.length, 1);
  assert.equal(res.liquidationRadar[0].cohort, 'shrimp');
  // Latest market mark must override stale position mark for risk classification.
  const changedMark = buildCohortsAnalytics(traders, [
    { ...markets[0], mark_price: '97000' },
  ], 1_700_000_000_000);
  assert.equal(changedMark.liquidationRadar.length, 0); // 103k vs 97k >5%

});
