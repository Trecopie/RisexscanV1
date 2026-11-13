export function shortAddress(addr: string, start = 6, end = 4): string {
  if (!addr) return '—';
  if (addr.length <= start + end + 2) return addr;
  return `${addr.slice(0, start)}…${addr.slice(-end)}`;
}

export function formatUsd(val: number | string | null | undefined, compact = false): string {
  if (val === null || val === undefined || val === '') return '—';
  const num = typeof val === 'string' ? Number(val) : val;
  if (!Number.isFinite(num)) return '—';
  const abs = Math.abs(num);
  const sign = num < 0 ? '-' : '';
  if (compact) {
    if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}K`;
  }
  return `${sign}$${abs.toLocaleString('en-US', {
    minimumFractionDigits: abs >= 1000 ? 0 : abs >= 1 ? 2 : 4,
    maximumFractionDigits: abs >= 1000 ? 0 : abs >= 1 ? 2 : 4,
  })}`;
}

export function formatSignedUsd(val: number | string | null | undefined, compact = false): string {
  if (val === null || val === undefined || val === '') return '—';
  const num = typeof val === 'string' ? Number(val) : val;
  if (!Number.isFinite(num)) return '—';
  const formatted = formatUsd(Math.abs(num), compact);
  if (num > 0) return `+${formatted}`;
  if (num < 0) return `-${formatted}`;
  return formatted;
}

export function formatPrice(val: number | string | null | undefined): string {
  if (val === null || val === undefined || val === '') return '—';
  const num = typeof val === 'string' ? Number(val) : val;
  if (!Number.isFinite(num)) return '—';
  const abs = Math.abs(num);
  if (abs === 0) return '$0.00';
  if (abs >= 1000) return `$${num.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 })}`;
  if (abs >= 1) return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  return `$${num.toPrecision(4)}`;
}

export function formatNumber(val: number | string | null | undefined, decimals = 4): string {
  if (val === null || val === undefined || val === '') return '—';
  const num = typeof val === 'string' ? Number(val) : val;
  if (!Number.isFinite(num)) return '—';
  if (Math.abs(num) >= 1000) {
    return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  return num.toLocaleString('en-US', { maximumFractionDigits: decimals });
}

export function formatPct(val: number | string | null | undefined, signed = true): string {
  if (val === null || val === undefined || val === '') return '—';
  const num = typeof val === 'string' ? Number(val) : val;
  if (!Number.isFinite(num)) return '—';
  const prefix = signed && num > 0 ? '+' : '';
  return `${prefix}${num.toFixed(2)}%`;
}

export function calcMarketChangePct(
  markOrLast: number | string | null | undefined,
  change24hUsd: number | string | null | undefined
): number {
  const mark = Number(markOrLast);
  const delta = Number(change24hUsd);
  if (!Number.isFinite(mark) || !Number.isFinite(delta) || mark <= 0) return 0;
  const prevPrice = mark - delta;
  if (prevPrice <= 0) return 0;
  return (delta / prevPrice) * 100;
}

export function nsToMs(nsStr: string | number | null | undefined): number {
  if (nsStr === null || nsStr === undefined || nsStr === '') return 0;
  const s = String(nsStr);
  if (/^\d+$/.test(s)) {
    if (s.length > 15) {
      return Number(BigInt(s) / 1000000n);
    }
    if (s.length > 12) {
      return Number(s);
    }
    return Number(s) * 1000;
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function formatTimeShort(ts: string | number | null | undefined): string {
  const ms = nsToMs(ts);
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(ts: string | number | null | undefined): string {
  const ms = nsToMs(ts);
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatDateOnly(ts: string | number | null | undefined): string {
  const ms = nsToMs(ts);
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function formatDuration(secondsStr: string | number | null | undefined): string {
  const sec = Number(secondsStr);
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function isValidAddress(input: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(input.trim());
}

export function isValidTxHash(input: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(input.trim());
}
