/** Display threshold is intentionally strict: positions exactly 5% away are excluded. */
export const LIQUIDATION_ALERT_PCT = 5;
/** Broader candidates let the client respond immediately to live oracle marks. */
export const LIQUIDATION_CANDIDATE_PCT = 25;

export function liquidationDistancePct(mark: unknown, liquidation: unknown): number | null {
  const m = Number(mark);
  const l = Number(liquidation);
  if (!Number.isFinite(m) || !Number.isFinite(l) || m <= 0 || l <= 0) return null;
  return Math.abs((l - m) / m) * 100;
}

export function isNearLiquidation(mark: unknown, liquidation: unknown, threshold = LIQUIDATION_ALERT_PCT): boolean {
  const distance = liquidationDistancePct(mark, liquidation);
  return distance !== null && distance < threshold;
}
