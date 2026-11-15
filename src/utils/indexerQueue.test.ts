import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractWalletAddressesFromLogs,
  selectIndexerQueue,
  type IndexerTraderMeta,
} from './indexerQueue';

test('extractWalletAddressesFromLogs extracts valid user addresses and filters system contracts & integer IDs', () => {
  const logs = [
    {
      // DepositedCollateral(depositor, user, token, amount)
      topics: [
        '0x1a52dc5f1a697e41465e09288950bab46daf62b3558244f71c7eee6ec1872a88',
        '0x000000000000000000000000228e195eb98faa456b17c2d285495a3bee22765e',
        '0x000000000000000000000000da9558ddd9e70e74130825bc69ccbd28c7078ecc',
        '0x000000000000000000000000e436820ba0c69702c1d3e601d421c0ef38262739', // usdc contract
      ],
    },
    {
      // OrdersManager small integer topic (marketId=8, orderId=81) must be excluded
      topics: [
        '0x1ba6d4f45859245e661ea27392cafbd50836e944393e90c0b8098114c9279dd7',
        '0x0000000000000000000000000000000000000000000000000000000000000051',
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      ],
    },
  ];

  const addrs = extractWalletAddressesFromLogs(logs, [
    '0xe436820ba0c69702c1d3e601d421c0ef38262739',
  ]);
  assert.deepEqual(addrs, [
    '0x228e195eb98faa456b17c2d285495a3bee22765e',
    '0xda9558ddd9e70e74130825bc69ccbd28c7078ecc',
  ]);
});

test('selectIndexerQueue prioritizes unenriched & oldest stale traders in round-robin order without starvation', () => {
  const now = 1_700_000_000_000;
  const freshMs = 300_000;
  const map = new Map<string, IndexerTraderMeta>([
    ['0xaaa', { address: '0xaaa', portfolioEnriched: true, lastUpdated: now - 400_000, volumeAll: 5000, realizedPnlAll: 100 }],
    ['0xbbb', { address: '0xbbb', portfolioEnriched: true, lastUpdated: now - 900_000, volumeAll: 5000, realizedPnlAll: 100 }],
    ['0xccc', { address: '0xccc', portfolioEnriched: true, lastUpdated: 0, volumeAll: 1000, realizedPnlAll: 50 }],
    ['0xddd', { address: '0xddd', portfolioEnriched: false, lastUpdated: 0, volumeAll: 25000, realizedPnlAll: 1000 }],
    ['0xeee', { address: '0xeee', portfolioEnriched: true, lastUpdated: now - 60_000, volumeAll: 99999, realizedPnlAll: 5000 }], // fresh -> skipped
    ['0xfff', { address: '0xfff', portfolioEnriched: false, lastUpdated: 0, volumeAll: 80000, realizedPnlAll: 0 }], // non-priority backfill high vol
    ['0x111', { address: '0x111', portfolioEnriched: false, lastUpdated: 0, volumeAll: 10, realizedPnlAll: 0 }], // non-priority backfill low vol
  ]);

  const queue = selectIndexerQueue(
    ['0xaaa', '0xbbb', '0xccc', '0xddd', '0xeee'],
    map,
    now,
    freshMs,
    3,
    2
  );

  // Priority picks: 0xddd (unenriched) -> 0xccc (lastUpdated=0) -> 0xbbb (older than 0xaaa)
  // Backfill picks: 0xfff (high vol unenriched) -> 0x111 (low vol unenriched)
  assert.deepEqual(queue, ['0xddd', '0xccc', '0xbbb', '0xfff', '0x111']);
});
