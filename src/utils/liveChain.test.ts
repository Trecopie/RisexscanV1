import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRpcBlock, normalizeRpcBlocks } from './liveChain.ts';

test('actual RPC hex headers transform to Blockscout-compatible timestamp and counts', () => {
  const rpc = { number:'0x1234', hash:'0xabcd', timestamp:'0x6789',gasUsed:'0x1f4', gasLimit:'0x7a120',
    transactions:['0xa','0xb'] };
  const b=normalizeRpcBlock(rpc)!;
  assert.equal(b.height,4660);
  assert.equal(b.transactions_count,2);
  assert.equal(b.gas_used,'500');
  assert.equal(b.gas_limit,'500000');
  assert.equal(b.timestamp,new Date(0x6789*1000).toISOString());
});

test('RPC normalization sorts unique blocks and rejects partial/bad heights', () => {
  const rows=[
    {number:'0x12', timestamp:'0x1', transactions:[]},
    {number:'0x13', timestamp:'0x1', transactions:['a']},
    {number:'0x12', timestamp:'0x1', transactions:[]},
    {number:'not-hex',timestamp:'0x1'},
    null,
  ];
  const res=normalizeRpcBlocks(rows,1234);
  assert.equal(res.source,'rpc');
  assert.equal(res.fetchedAt,1234);
  assert.equal(res.head,19);
  assert.deepEqual(res.blocks.map(x=>x.height),[19,18]);
  assert.equal(normalizeRpcBlocks([null,{}]).head,null);
});
