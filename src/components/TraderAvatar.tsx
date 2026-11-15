import React, { useEffect, useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';

function hashStr(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDENTICON_PALETTES = [
  ['#ffb02e', '#ff6a3d'],
  ['#22e0a1', '#46a6ff'],
  ['#ff3d81', '#ffb02e'],
  ['#8b7bff', '#46a6ff'],
  ['#22e0a1', '#ffb02e'],
  ['#ff6a3d', '#ff3d81'],
];

export const TraderAvatar: React.FC<{
  address: string;
  avatarUrl?: string | null;
  username?: string | null;
  size?: number;
  className?: string;
}> = ({ address, avatarUrl, username, size = 28, className = '' }) => {
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
  }, [avatarUrl, address]);

  const svgData = useMemo(() => {
    const clean = (address || '0x0000').toLowerCase();
    const h = hashStr(clean);
    const rng = mulberry32(h);
    const [fg1, fg2] = IDENTICON_PALETTES[h % IDENTICON_PALETTES.length];
    const cells: { x: number; y: number; color: string }[] = [];

    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 3; x++) {
        if (rng() > 0.42) {
          const c = rng() > 0.45 ? fg1 : fg2;
          cells.push({ x, y, color: c });
          if (x !== 2) {
            cells.push({ x: 4 - x, y, color: c });
          }
        }
      }
    }
    return cells;
  }, [address]);

  if (avatarUrl && !imgError) {
    return (
      <img
        src={avatarUrl}
        alt={username || address}
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        onError={() => setImgError(true)}
        className={`shrink-0 rounded-lg object-cover border border-slate-700/70 bg-[#0e1526] ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 5 5"
      shapeRendering="crispEdges"
      className={`shrink-0 rounded-lg border border-slate-700/70 bg-[#0e1526] p-[3px] ${className}`}
      style={{ width: size, height: size }}
      aria-label={username || address}
    >
      {svgData.map((c, idx) => (
        <rect key={idx} x={c.x} y={c.y} width={1} height={1} fill={c.color} />
      ))}
    </svg>
  );
};

export { TokenBadge } from './TokenBadge';

export function calcLiqDistancePct(
  markPrice: number,
  liquidationPrice: number,
  side: 'LONG' | 'SHORT'
): number | null {
  if (!Number.isFinite(markPrice) || markPrice <= 0) return null;
  if (!Number.isFinite(liquidationPrice) || liquidationPrice <= 0) return null;
  if (side === 'LONG') {
    return ((markPrice - liquidationPrice) / markPrice) * 100;
  }
  return ((liquidationPrice - markPrice) / markPrice) * 100;
}

export const LiqDistanceBadge: React.FC<{
  markPrice: number;
  liquidationPrice: number;
  side: 'LONG' | 'SHORT';
}> = ({ markPrice, liquidationPrice, side }) => {
  const dist = calcLiqDistancePct(markPrice, liquidationPrice, side);
  if (dist === null) {
    return <span className="text-[10px] font-mono text-slate-500">—</span>;
  }
  const clamped = Math.max(0, dist);
  if (clamped < 6) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-[#ff4d6d]/15 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-[#ff4d6d] border border-[#ff4d6d]/30">
        {clamped.toFixed(1)}% CRIT
      </span>
    );
  }
  if (clamped < 20) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-[#ffb02e]/15 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-[#ffb02e] border border-[#ffb02e]/30">
        {clamped.toFixed(1)}% NEAR
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-[#22e0a1]/12 px-1.5 py-0.5 text-[10px] font-mono text-[#22e0a1] border border-[#22e0a1]/25">
      {clamped.toFixed(1)}% SAFE
    </span>
  );
};

export const CopyBtn: React.FC<{ text: string; className?: string }> = ({ text, className = '' }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title="Copy to clipboard"
      className={`inline-flex items-center justify-center rounded p-1 text-slate-400 hover:bg-slate-800/80 hover:text-[#ffb02e] transition-colors ${className}`}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-[#22e0a1]" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
};
