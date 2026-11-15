export interface IndexerTraderMeta {
  address: string;
  portfolioEnriched: boolean;
  lastUpdated: number;
  volumeAll: number;
  realizedPnlAll: number;
}

export interface ContractLogLike {
  topics?: (string | null | undefined)[];
}

const SMALL_INT_ADDR_RE = /^0x0{16,}/i;
const TOPIC_ADDRESS_RE = /^0x0{24}([0-9a-f]{40})$/i;

/**
 * Extracts unique, valid 20-byte wallet addresses from EVM log `topics`
 * (e.g., CollateralManager DepositedCollateral/Withdraw, Auth, OperatorHub),
 * filtering out zero-address, small integer IDs padded to 32 bytes, and known protocol contracts.
 */
export function extractWalletAddressesFromLogs(
  logs: ContractLogLike[],
  excludedContracts: Iterable<string> = []
): string[] {
  const excluded = new Set<string>();
  for (const c of excludedContracts) {
    if (c) excluded.add(c.toLowerCase());
  }
  excluded.add('0x0000000000000000000000000000000000000000');

  const seen = new Set<string>();
  const out: string[] = [];

  for (const log of logs || []) {
    for (const tp of log?.topics || []) {
      if (!tp || typeof tp !== 'string') continue;
      const m = TOPIC_ADDRESS_RE.exec(tp);
      if (!m) continue;
      const addr = `0x${m[1].toLowerCase()}`;
      if (SMALL_INT_ADDR_RE.test(addr)) continue;
      if (excluded.has(addr)) continue;
      if (!seen.has(addr)) {
        seen.add(addr);
        out.push(addr);
      }
    }
  }

  return out;
}

/**
 * Builds an anti-starvation enrichment queue for the background indexer:
 * 1) Stale priority traders sorted so unenriched -> legacy (lastUpdated=0) -> oldest lastUpdated come first.
 * 2) Historical/backfill traders sorted so legacy -> highest-volume unenriched -> oldest enriched come first.
 */
export function selectIndexerQueue(
  priorityList: string[],
  tradersMap: Map<string, IndexerTraderMeta>,
  nowMs: number,
  priorityFreshMs: number,
  priorityCap = 320,
  backfillCap = 200
): string[] {
  const prioritySet = new Set<string>();
  const stalePriorityEntries: { addr: string; tier: number; lastUpdated: number; score: number }[] = [];

  for (const addr of priorityList) {
    const key = addr.toLowerCase();
    if (prioritySet.has(key)) continue;
    prioritySet.add(key);

    const t = tradersMap.get(key);
    const isStale = !t || !t.portfolioEnriched || nowMs - t.lastUpdated > priorityFreshMs;
    if (!isStale) continue;

    let tier = 2;
    if (!t || !t.portfolioEnriched) tier = 0;
    else if (t.lastUpdated <= 0) tier = 1;

    const score = t ? Math.max(t.volumeAll || 0, Math.abs(t.realizedPnlAll || 0)) : 0;
    stalePriorityEntries.push({
      addr: t?.address || addr,
      tier,
      lastUpdated: t?.lastUpdated || 0,
      score,
    });
  }

  stalePriorityEntries.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.tier === 0) return b.score - a.score;
    return a.lastUpdated - b.lastUpdated;
  });

  const backfillEntries: { addr: string; tier: number; lastUpdated: number; score: number }[] = [];
  for (const t of tradersMap.values()) {
    const key = t.address.toLowerCase();
    if (prioritySet.has(key)) continue;

    let tier = 2;
    if (t.portfolioEnriched && t.lastUpdated <= 0) tier = 0;
    else if (!t.portfolioEnriched) tier = 1;

    backfillEntries.push({
      addr: t.address,
      tier,
      lastUpdated: t.lastUpdated || 0,
      score: Math.max(t.volumeAll || 0, Math.abs(t.realizedPnlAll || 0)),
    });
  }

  backfillEntries.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.tier === 1) return b.score - a.score;
    return a.lastUpdated - b.lastUpdated;
  });

  return [
    ...stalePriorityEntries.slice(0, priorityCap).map((e) => e.addr),
    ...backfillEntries.slice(0, backfillCap).map((e) => e.addr),
  ];
}
