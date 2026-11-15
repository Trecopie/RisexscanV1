import React from 'react';
import { cleanBaseSymbol, normalizeMarketSector, type MarketSectorId } from '../utils/overviewAnalytics';

interface AssetTheme {
  bg: string;
  fg: string;
  accent: string;
}

const ASSET_THEMES: Record<string, AssetTheme> = {
  BTC: { bg: '#f7931a', fg: '#ffffff', accent: '#ffd59a' },
  ETH: { bg: '#5b76e8', fg: '#ffffff', accent: '#c7d2fe' },
  SOL: { bg: '#0c1624', fg: '#14f195', accent: '#9945ff' },
  BNB: { bg: '#f3ba2f', fg: '#141108', accent: '#fff2cc' },
  HYPE: { bg: '#0b221e', fg: '#22e0a1', accent: '#5eead4' },
  XRP: { bg: '#0e1726', fg: '#38bdf8', accent: '#bae6fd' },
  TAO: { bg: '#111827', fg: '#f8fafc', accent: '#94a3b8' },
  ZEC: { bg: '#ecb244', fg: '#141108', accent: '#fef3c7' },
  ONDO: { bg: '#0b1322', fg: '#38bdf8', accent: '#e0f2fe' },
  NEAR: { bg: '#0c1816', fg: '#00ec97', accent: '#a7f3d0' },
  VVV: { bg: '#1b1128', fg: '#e879f9', accent: '#f5d0fe' },
  LIT: { bg: '#1b1410', fg: '#fb923c', accent: '#fed7aa' },
  DOGE: { bg: '#c2a633', fg: '#151206', accent: '#fef08a' },
  AERO: { bg: '#0b1830', fg: '#38bdf8', accent: '#60a5fa' },
  AAVE: { bg: '#261433', fg: '#d977d4', accent: '#f5d0fe' },
  ARB: { bg: '#13243f', fg: '#60a5fa', accent: '#bfdbfe' },
  ENA: { bg: '#0d1a22', fg: '#2dd4bf', accent: '#99f6e4' },
  MON: { bg: '#1d1233', fg: '#a78bfa', accent: '#ddd6fe' },
  WLD: { bg: '#111827', fg: '#e2e8f0', accent: '#cbd5e1' },
  STRK: { bg: '#191436', fg: '#a855f7', accent: '#f472b6' },
  ZRO: { bg: '#111622', fg: '#f8fafc', accent: '#94a3b8' },
  XMR: { bg: '#ff6600', fg: '#ffffff', accent: '#fed7aa' },
  PUMP: { bg: '#0b2217', fg: '#4ade80', accent: '#bbf7d0' },
  CHIP: { bg: '#161b2e', fg: '#ffb02e', accent: '#fde68a' },
  '1000PEPE': { bg: '#153219', fg: '#4ade80', accent: '#bbf7d0' },
  PEPE: { bg: '#153219', fg: '#4ade80', accent: '#bbf7d0' },
  RISE: { bg: '#ffb02e', fg: '#160a02', accent: '#ff6a3d' },
  SUI: { bg: '#122949', fg: '#4da2ff', accent: '#bae6fd' },
  // Commodities
  XAU: { bg: '#2d2208', fg: '#facc15', accent: '#fef08a' },
  XAG: { bg: '#1e2532', fg: '#e2e8f0', accent: '#94a3b8' },
  CL: { bg: '#1c1917', fg: '#fb923c', accent: '#f59e0b' },
  BZ: { bg: '#171c26', fg: '#f59e0b', accent: '#fde68a' },
  // Stocks
  NVDA: { bg: '#192a09', fg: '#76b900', accent: '#bef264' },
  TSLA: { bg: '#2c0b12', fg: '#ff2e4c', accent: '#fecdd3' },
  META: { bg: '#0b1e3b', fg: '#3b82f6', accent: '#93c5fd' },
  GOOGL: { bg: '#0f1b2d', fg: '#60a5fa', accent: '#34d399' },
  MSTR: { bg: '#2d1208', fg: '#ff6a3d', accent: '#fed7aa' },
  INTC: { bg: '#091f3a', fg: '#38bdf8', accent: '#bae6fd' },
  MU: { bg: '#0f1c30', fg: '#60a5fa', accent: '#cbd5e1' },
  ARM: { bg: '#0b2129', fg: '#22d3ee', accent: '#a5f3fc' },
  QCOM: { bg: '#141c38', fg: '#818cf8', accent: '#c7d2fe' },
  SNDK: { bg: '#2c0d12', fg: '#f43f5e', accent: '#fda4af' },
  SKHYNIX: { bg: '#2a1216', fg: '#fb7185', accent: '#fb923c' },
  SOXL: { bg: '#112236', fg: '#38bdf8', accent: '#22e0a1' },
  CRCL: { bg: '#0d2329', fg: '#2dd4bf', accent: '#99f6e4' },
  SPCX: { bg: '#0f172a', fg: '#e2e8f0', accent: '#46a6ff' },
  CRWV: { bg: '#151c32', fg: '#8b7bff', accent: '#c4b5fd' },
  HOOD: { bg: '#0d2616', fg: '#22e0a1', accent: '#86efac' },
  LLY: { bg: '#2a0f14', fg: '#fb7185', accent: '#fecdd3' },
  TTWO: { bg: '#1b1726', fg: '#c084fc', accent: '#e9d5ff' },
  HIMS: { bg: '#251a12', fg: '#fbbf24', accent: '#fde68a' },
  // ETFs
  SPY: { bg: '#0e241b', fg: '#22e0a1', accent: '#a7f3d0' },
  QQQ: { bg: '#121c38', fg: '#60a5fa', accent: '#bfdbfe' },
  DRAM: { bg: '#181934', fg: '#a78bfa', accent: '#ddd6fe' },
  KORU: { bg: '#111d36', fg: '#38bdf8', accent: '#f43f5e' },
  EWZ: { bg: '#0d2415', fg: '#4ade80', accent: '#facc15' },
};

const SECTOR_DEFAULT_THEMES: Record<MarketSectorId, AssetTheme> = {
  crypto: { bg: '#161f36', fg: '#ffb02e', accent: '#fde68a' },
  commodity: { bg: '#261e09', fg: '#facc15', accent: '#fef08a' },
  stocks: { bg: '#111f33', fg: '#46a6ff', accent: '#bae6fd' },
  index_etf: { bg: '#0d221c', fg: '#22e0a1', accent: '#a7f3d0' },
};

function renderVectorMark(clean: string, sector: MarketSectorId, theme: AssetTheme) {
  switch (clean) {
    case 'BTC':
      return (
        <g stroke={theme.fg} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" fill="none">
          <path d="M10.5 7v10M13.5 7v10" />
          <path d="M9.2 8.5h4.4a2 2 0 0 1 0 3.8H9.2h4.8a2.1 2.1 0 0 1 0 4.2H9.2" />
        </g>
      );
    case 'ETH':
      return (
        <g>
          <polygon points="12,4.5 17,12 12,15 7,12" fill={theme.fg} opacity="0.95" />
          <polygon points="12,16.1 17,13.1 12,19.8 7,13.1" fill={theme.accent} opacity="0.9" />
        </g>
      );
    case 'SOL':
      return (
        <g>
          <polygon points="7.5,7.2 17.5,7.2 15.8,9.4 5.8,9.4" fill={theme.fg} />
          <polygon points="5.8,10.9 15.8,10.9 17.5,13.1 7.5,13.1" fill={theme.accent} />
          <polygon points="7.5,14.6 17.5,14.6 15.8,16.8 5.8,16.8" fill={theme.fg} />
        </g>
      );
    case 'BNB':
      return (
        <g fill={theme.fg}>
          <polygon points="12,5.5 15,8.5 12,11.5 9,8.5" />
          <polygon points="12,12.5 15,15.5 12,18.5 9,15.5" />
          <polygon points="6.5,10 8.5,12 6.5,14 4.5,12" />
          <polygon points="17.5,10 19.5,12 17.5,14 15.5,12" />
        </g>
      );
    case 'HYPE':
      return (
        <g stroke={theme.fg} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" fill="none">
          <path d="M7.5 6.8v10.4M16.5 6.8v10.4M7.5 12c2.2-1.8 6.8 1.8 9 0" />
        </g>
      );
    case 'XRP':
      return (
        <g stroke={theme.fg} strokeWidth="2.1" strokeLinecap="round" fill="none">
          <path d="M7 7.5c2 2.4 8 2.4 10 0" />
          <path d="M7 16.5c2-2.4 8-2.4 10 0" />
        </g>
      );
    case 'ARB':
      return (
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12,5.2 17.8,8.5 17.8,15.5 12,18.8 6.2,15.5 6.2,8.5" stroke={theme.fg} strokeWidth="1.6" />
          <path d="M9.4 15.5 12 8.8l2.6 6.7M10.4 13.3h3.2" stroke={theme.accent} strokeWidth="1.8" />
        </g>
      );
    case 'SUI':
      return (
        <path
          d="M12 5.4c2.8 3.6 4.7 6.1 4.7 8.5a4.7 4.7 0 1 1-9.4 0c0-2.4 1.9-4.9 4.7-8.5z"
          fill="none"
          stroke={theme.fg}
          strokeWidth="2"
        />
      );
    case 'XAU':
    case 'XAG':
      return (
        <g fill={theme.fg}>
          <polygon points="7.5,9 16.5,9 17.8,12.2 6.2,12.2" opacity="0.9" />
          <polygon points="6.2,13.4 17.8,13.4 19,16.8 5,16.8" />
        </g>
      );
    case 'CL':
    case 'BZ':
      return (
        <g>
          <path
            d="M12 5.5c2.6 3.5 4.4 6 4.4 8.3a4.4 4.4 0 1 1-8.8 0c0-2.3 1.8-4.8 4.4-8.3z"
            fill={theme.fg}
          />
          <path d="M10.2 13.8a2 2 0 0 0 1.8 1.8" stroke={theme.bg} strokeWidth="1.5" strokeLinecap="round" fill="none" />
        </g>
      );
    case 'NVDA':
      return (
        <g fill="none" stroke={theme.fg} strokeWidth="1.9" strokeLinecap="round">
          <path d="M5.8 12c2-3.4 10.4-3.4 12.4 0-2 3.4-10.4 3.4-12.4 0z" />
          <circle cx="12" cy="12" r="2.1" fill={theme.accent} stroke="none" />
        </g>
      );
    case 'TSLA':
      return (
        <g stroke={theme.fg} strokeWidth="2.1" strokeLinecap="round" fill="none">
          <path d="M6.8 8.3c3.2-1 7.2-1 10.4 0" />
          <path d="M12 8.5v8.8" />
        </g>
      );
    case 'META':
      return (
        <path
          d="M7.2 14.4c-1.4-1.8-.9-5.2 1.2-5.2 2.2 0 3.6 5.6 6.2 5.6 2 0 2.7-3.4 1.2-5.2-1.2-1.4-2.8-.2-3.8 1.7"
          fill="none"
          stroke={theme.fg}
          strokeWidth="2"
          strokeLinecap="round"
        />
      );
    case 'SPY':
    case 'QQQ':
    case 'DRAM':
    case 'KORU':
    case 'EWZ':
      return (
        <g>
          <rect x="6.5" y="13.2" width="2.4" height="4.2" rx="0.6" fill={theme.accent} />
          <rect x="10.8" y="9.8" width="2.4" height="7.6" rx="0.6" fill={theme.fg} />
          <rect x="15.1" y="6.8" width="2.4" height="10.6" rx="0.6" fill={theme.accent} />
        </g>
      );
    case 'RISE':
      return (
        <g stroke={theme.fg} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" fill="none">
          <path d="M6.8 16.5 12 7.5l5.2 9" />
          <path d="M8.8 13.5h6.4" />
        </g>
      );
    default: {
      const label =
        clean === '1000PEPE'
          ? 'PEPE'
          : clean === 'SKHYNIX'
            ? 'SKH'
            : clean.slice(0, clean.length >= 4 ? 4 : 3);
      const fontSize = label.length >= 4 ? 6.6 : label.length === 3 ? 7.8 : 9.2;
      return (
        <g>
          {sector === 'stocks' && (
            <rect
              x="4.5"
              y="4.5"
              width="15"
              height="15"
              rx="3.5"
              fill="none"
              stroke={theme.accent}
              strokeOpacity="0.35"
              strokeWidth="1"
            />
          )}
          <text
            x="12"
            y="12.6"
            textAnchor="middle"
            dominantBaseline="central"
            fill={theme.fg}
            fontFamily="JetBrains Mono, ui-monospace, monospace"
            fontWeight="700"
            fontSize={fontSize}
            letterSpacing="-0.3"
          >
            {label}
          </text>
        </g>
      );
    }
  }
}

export const TokenBadge: React.FC<{
  symbol: string;
  size?: number;
  category?: string | null;
  className?: string;
}> = ({ symbol, size = 26, category, className = '' }) => {
  const clean = cleanBaseSymbol(symbol || '?');
  const sector = normalizeMarketSector(category, clean);
  const theme = ASSET_THEMES[clean] || SECTOR_DEFAULT_THEMES[sector];
  const radius = sector === 'stocks' || sector === 'index_etf' ? 6 : 12;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`shrink-0 select-none ${className}`}
      style={{ width: size, height: size }}
      aria-label={clean}
    >
      <rect
        x="1"
        y="1"
        width="22"
        height="22"
        rx={radius}
        fill={theme.bg}
        stroke={theme.accent}
        strokeOpacity="0.45"
        strokeWidth="1.2"
      />
      {renderVectorMark(clean, sector, theme)}
    </svg>
  );
};
