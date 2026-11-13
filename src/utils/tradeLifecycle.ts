import { nsToMs } from './format.ts';

export function safeNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function calcRoiPct(pnl: number, accountValue: number): number {
  const base = accountValue - pnl;
  if (base > 10) return (pnl / base) * 100;
  if (accountValue > 10) return (pnl / accountValue) * 100;
  return 0;
}

export interface ReconstructedClosedTrade {
  id: string;
  marketId: string;
  marketName: string;
  side: 'LONG' | 'SHORT';
  maxSize: number;
  closedSize: number;
  entryPrice: number;
  exitPrice: number;
  openTime: string;
  closeTime: string;
  fillsCount: number;
  fees: number;
  funding: number;
  realizedPnl: number;
}

export function reconstructTradeLifecycles(
  rawOpenPositions: any[],
  trades: any[],
  realizedEvents: any[],
  marketsList: any[]
): {
  openRealizedByMarket: Map<string, number>;
  closedTrades: ReconstructedClosedTrade[];
} {
  const marketNameMap = new Map<string, string>();
  for (const m of marketsList) marketNameMap.set(String(m.market_id), m.display_name);
  for (const p of rawOpenPositions) {
    if (p.market_id && p.market_name) marketNameMap.set(String(p.market_id), p.market_name);
  }

  const openSignedMap = new Map<string, number>();
  for (const p of rawOpenPositions) {
    const sz = safeNum(p.size);
    if (Math.abs(sz) > 0) openSignedMap.set(String(p.market_id), sz);
  }

  const tradesByMarket = new Map<string, any[]>();
  for (const t of trades) {
    const mId = String(t.market_id || '');
    if (!mId) continue;
    if (!tradesByMarket.has(mId)) tradesByMarket.set(mId, []);
    tradesByMarket.get(mId)!.push(t);
  }

  const fundingByMarket = new Map<string, { ms: number; funding: number }[]>();
  for (const ev of realizedEvents) {
    const mId = String(ev.market_id || '');
    const f = safeNum(ev.funding);
    if (!mId || f === 0) continue;
    if (!fundingByMarket.has(mId)) fundingByMarket.set(mId, []);
    fundingByMarket.get(mId)!.push({ ms: nsToMs(ev.timestamp), funding: f });
  }

  const openRealizedByMarket = new Map<string, number>();
  const closedTrades: ReconstructedClosedTrade[] = [];
  const EPS = 1e-6;

  for (const [mId, list] of tradesByMarket.entries()) {
    list.sort((a, b) => {
      const aStr = String(a.time || '');
      const bStr = String(b.time || '');
      if (/^\d+$/.test(aStr) && /^\d+$/.test(bStr)) {
        const ta = BigInt(aStr);
        const tb = BigInt(bStr);
        if (tb > ta) return 1;
        if (tb < ta) return -1;
      } else {
        const ma = nsToMs(aStr);
        const mb = nsToMs(bStr);
        if (mb !== ma) return mb - ma;
      }
      return safeNum(b.blockchain_data?.log_index) - safeNum(a.blockchain_data?.log_index);
    });

    const isMarketCurrentlyOpen = openSignedMap.has(mId);
    let net = openSignedMap.get(mId) || 0;

    const makeCycle = (isOpen: boolean, signedPos: number, closeTime: string) => ({
      isOpen,
      side: (signedPos > 0 ? 'LONG' : signedPos < 0 ? 'SHORT' : 'FLAT') as 'LONG' | 'SHORT' | 'FLAT',
      maxSize: Math.abs(signedPos),
      closedSize: 0,
      openVol: 0,
      openVal: 0,
      closeVol: 0,
      closeVal: 0,
      openTime: closeTime,
      closeTime,
      fillsCount: 0,
      fees: 0,
      realizedPnl: 0,
      completeOpenFound: false,
    });

    let cur = makeCycle(isMarketCurrentlyOpen, net, String(list[0]?.time || '0'));

    const finalizeCycle = (c: ReturnType<typeof makeCycle>, idx: number) => {
      if (c.isOpen) {
        openRealizedByMarket.set(mId, c.realizedPnl);
        return;
      }
      if (!c.completeOpenFound || c.closeVol <= EPS || c.side === 'FLAT') return;

      const openMs = nsToMs(c.openTime);
      const closeMs = nsToMs(c.closeTime);
      const fundList = fundingByMarket.get(mId) || [];
      const matchedFunding = fundList
        .filter((f) => f.ms >= openMs && f.ms <= closeMs)
        .reduce((s, f) => s + f.funding, 0);

      closedTrades.push({
        id: `${mId}-${c.closeTime}-${idx}`,
        marketId: mId,
        marketName: marketNameMap.get(mId) || `Market #${mId}`,
        side: c.side,
        maxSize: c.maxSize,
        closedSize: c.closedSize,
        entryPrice: c.openVol > 0 ? c.openVal / c.openVol : 0,
        exitPrice: c.closeVol > 0 ? c.closeVal / c.closeVol : 0,
        openTime: c.openTime,
        closeTime: c.closeTime,
        fillsCount: c.fillsCount,
        fees: c.fees,
        funding: matchedFunding,
        realizedPnl: c.realizedPnl,
      });
    };

    let cycleCounter = 0;
    for (const t of list) {
      const sz = safeNum(t.size);
      if (sz <= 0) continue;
      const px = safeNum(t.price);
      const sideStr = String(t.side || '').toUpperCase();
      const signedDelta = sideStr === 'BUY' || sideStr === '0' ? sz : -sz;
      const prevNet = net - signedDelta;
      const fillRpnl = safeNum(t.realized_pnl);
      const fillFee = safeNum(t.fee);

      if (cur.fillsCount === 0) {
        cur.closeTime = String(t.time || '0');
      }

      if (Math.abs(net) > EPS && Math.abs(prevNet) > EPS && Math.sign(net) !== Math.sign(prevNet)) {
        const openPortion = Math.min(1, Math.abs(net) / sz);
        const closePortion = 1 - openPortion;

        cur.openVol += Math.abs(net);
        cur.openVal += Math.abs(net) * px;
        cur.openTime = String(t.time || '0');
        cur.fillsCount += 1;
        cur.fees += fillFee * openPortion;
        cur.realizedPnl -= fillFee * openPortion;
        cur.maxSize = Math.max(cur.maxSize, Math.abs(net));
        cur.completeOpenFound = true;
        finalizeCycle(cur, cycleCounter++);

        cur = makeCycle(false, prevNet, String(t.time || '0'));
        cur.closeVol += Math.abs(prevNet);
        cur.closeVal += Math.abs(prevNet) * px;
        cur.closedSize += Math.abs(prevNet);
        cur.fillsCount = 1;
        cur.fees = fillFee * closePortion;
        cur.realizedPnl = fillRpnl + fillFee * openPortion;
        cur.maxSize = Math.max(cur.maxSize, Math.abs(prevNet));
        net = prevNet;
        continue;
      }

      if (cur.side === 'FLAT') {
        if (Math.abs(prevNet) > EPS) cur.side = prevNet > 0 ? 'LONG' : 'SHORT';
        else if (Math.abs(net) > EPS) cur.side = net > 0 ? 'LONG' : 'SHORT';
        else cur.side = signedDelta > 0 ? 'LONG' : 'SHORT';
      }

      if (Math.abs(net) > Math.abs(prevNet)) {
        cur.openVol += sz;
        cur.openVal += sz * px;
      } else {
        cur.closeVol += sz;
        cur.closeVal += sz * px;
        cur.closedSize += sz;
      }

      cur.fillsCount += 1;
      cur.fees += fillFee;
      cur.realizedPnl += fillRpnl;
      cur.openTime = String(t.time || '0');
      cur.maxSize = Math.max(cur.maxSize, Math.abs(net), Math.abs(prevNet));

      if (Math.abs(prevNet) <= EPS) {
        cur.completeOpenFound = true;
        finalizeCycle(cur, cycleCounter++);
        net = 0;
        cur = makeCycle(false, 0, String(t.time || '0'));
      } else {
        net = prevNet;
      }
    }

    if (cur.isOpen) {
      openRealizedByMarket.set(mId, cur.realizedPnl);
    }
  }

  closedTrades.sort((a, b) => nsToMs(b.closeTime) - nsToMs(a.closeTime));
  return { openRealizedByMarket, closedTrades };
}
