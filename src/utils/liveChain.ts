import type { ExplorerBlock } from '../types/risex.ts';

export interface LiveChainData {
  blocks: ExplorerBlock[];
  head: number | null;
  fetchedAt: number;
  source: 'rpc';
}

/** eth_getBlockByNumber exposes hex numeric fields; Blockscout uses decimals. */
export function normalizeRpcBlock(raw: unknown): ExplorerBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const number = b.number;
  if (typeof number !== 'string' || !/^0x[0-9a-f]+$/i.test(number)) return null;
  const height = Number.parseInt(number, 16);
  const gasUsed = typeof b.gasUsed === 'string' && /^0x[0-9a-f]+$/i.test(b.gasUsed)
    ? BigInt(b.gasUsed).toString() : '0';
  const timestampSec = typeof b.timestamp === 'string' && /^0x[0-9a-f]+$/i.test(b.timestamp)
    ? Number.parseInt(b.timestamp, 16) : 0;
  if (!Number.isSafeInteger(height) || height < 0 || !Number.isFinite(timestampSec)) return null;
  return {
    height,
    hash: typeof b.hash === 'string' ? b.hash : '',
    timestamp: new Date(timestampSec * 1000).toISOString(),
    gas_used: gasUsed,
    gas_limit: typeof b.gasLimit === 'string' && /^0x[0-9a-f]+$/i.test(b.gasLimit)
      ? BigInt(b.gasLimit).toString() : '0',
    transactions_count: Array.isArray(b.transactions) ? b.transactions.length : undefined,
  };
}

export function normalizeRpcBlocks(values: unknown[], fetchedAt = Date.now()): LiveChainData {
  const blocks = values.map(normalizeRpcBlock).filter((b): b is ExplorerBlock => b !== null)
    .sort((a, b) => b.height - a.height)
    .filter((b, i, arr) => arr.findIndex((other) => other.height === b.height) === i);
  return { blocks, head: blocks[0]?.height ?? null, fetchedAt, source: 'rpc' };
}
