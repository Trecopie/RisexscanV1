import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BarChart3,
  Blocks,
  Compass,
  Search,
  Trophy,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import type { IndexedTrader, RisexMarket } from '../types/risex';
import { calcMarketChangePct, formatPct, formatPrice, formatSignedUsd, shortAddress } from '../utils/format';
import { RisexSymbol } from './RisexSymbol';
import { TokenBadge, TraderAvatar } from './TraderAvatar';

export type NavTab = 'overview' | 'markets' | 'cohorts' | 'leaderboard' | 'explorer' | 'wallet';

interface NavbarProps {
  activeTab: NavTab;
  onNavigate: (tab: NavTab) => void;
  onGlobalSearch: (query: string) => void;
  onSelectWallet: (address: string) => void;
  onSelectMarket: (marketId: string) => void;
  markets: RisexMarket[];
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  onNavigate,
  onGlobalSearch,
  onSelectWallet,
  onSelectMarket,
  markets,
}) => {
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [results, setResults] = useState<{ markets: RisexMarket[]; traders: IndexedTrader[] }>({
    markets: [],
    traders: [],
  });
  const searchBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSearchOpen(false);
        setMobileSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults({ markets: [], traders: [] });
      setSearchLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearchLoading(true);
      fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d && !controller.signal.aborted) {
            setResults({
              markets: d.markets || [],
              traders: d.traders || [],
            });
          }
        })
        .catch(() => {})
        .finally(() => {
          if (!controller.signal.aborted) setSearchLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      setSearchOpen(false);
      onGlobalSearch(query.trim());
    }
  };

  const navItems: { id: NavTab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Overview', icon: <Compass className="h-3.5 w-3.5" /> },
    { id: 'markets', label: 'Markets', icon: <BarChart3 className="h-3.5 w-3.5" /> },
    { id: 'cohorts', label: 'Cohorts', icon: <Users className="h-3.5 w-3.5" /> },
    { id: 'leaderboard', label: 'Leaderboard', icon: <Trophy className="h-3.5 w-3.5" /> },
    { id: 'explorer', label: 'Explorer', icon: <Blocks className="h-3.5 w-3.5" /> },
    { id: 'wallet', label: 'Wallet', icon: <Wallet className="h-3.5 w-3.5" /> },
  ];

  const tickerItems = useMemo(
    () =>
      [...markets]
        .filter((m) => m.active !== false && Number(m.mark_price || m.last_price) > 0)
        .sort((a, b) => Number(b.quote_volume_24h || 0) - Number(a.quote_volume_24h || 0))
        .slice(0, 20),
    [markets]
  );

  return (
    <header className="sticky top-0 z-40 border-b border-slate-800/80 bg-[#060911]/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-4 py-2 sm:px-6">
        {/* Brand */}
        <button
          type="button"
          onClick={() => onNavigate('overview')}
          className="flex shrink-0 items-center gap-2.5 text-left group"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md border border-[#03DE82]/35 bg-[#0a0f1c]">
            <RisexSymbol className="h-4 w-4 text-[#03DE82]" />
          </span>
          <div className="leading-tight">
            <div className="flex items-center gap-2">
              <span className="font-display text-base font-bold tracking-tight text-[#e8edfb] group-hover:text-[#ffb02e] transition-colors">
                RISEx<span className="text-[#ffb02e]">Scan</span>
              </span>
              <span className="hidden sm:inline-flex items-center gap-1 text-[10px] font-mono text-slate-500">
                <Activity className="h-2.5 w-2.5 text-[#03DE82]" />
                4153
              </span>
            </div>
          </div>
        </button>

        {/* Primary Nav */}
        <nav className="flex items-center gap-1 overflow-x-auto no-scrollbar">
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-all ${
                  active
                    ? 'bg-[#ffb02e]/14 text-[#ffb02e] border border-[#ffb02e]/35'
                    : 'text-slate-400 hover:bg-[#0e1526] hover:text-[#e8edfb] border border-transparent'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Mobile Search Toggle */}
        <button
          type="button"
          onClick={() => {
            setMobileSearchOpen((v) => !v);
            setSearchOpen(true);
          }}
          aria-label="Toggle search"
          className="md:hidden shrink-0 rounded-lg border border-slate-700/50 bg-[#090e1a] p-2 text-slate-300 hover:border-[#ffb02e]/60 hover:text-[#ffb02e]"
        >
          {mobileSearchOpen ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
        </button>

        {/* Global Search with Live Dropdown (Desktop + Expandable Mobile) */}
        <div
          ref={searchBoxRef}
          className={
            mobileSearchOpen
              ? 'fixed left-3 right-3 top-[54px] z-50 md:static md:block md:w-80 lg:w-96 md:shrink-0'
              : 'relative hidden md:block w-80 lg:w-96 shrink-0'
          }
        >
          <form onSubmit={handleSubmit} className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={query}
              onFocus={() => setSearchOpen(true)}
              onChange={(e) => {
                setQuery(e.target.value);
                setSearchOpen(true);
              }}
              placeholder="Search RISEx username, 0x wallet, ticker, tx…"
              className="w-full rounded-xl border border-slate-700/45 bg-[#090e1a] py-2 md:py-1.5 pl-9 pr-14 text-xs text-[#e8edfb] placeholder:text-slate-500 shadow-xl md:shadow-none focus:border-[#ffb02e]/60 focus:outline-none"
            />
            <button
              type="submit"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg bg-[#131c31] px-2 py-0.5 text-[10px] font-mono text-slate-300 hover:bg-[#ffb02e] hover:text-[#1f0e03] transition-colors"
            >
              GO
            </button>
          </form>

          {searchOpen && query.trim().length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1.5 max-h-96 overflow-y-auto rounded-xl border border-slate-700/60 bg-[#090e1a] p-2 shadow-2xl">
              {searchLoading && results.traders.length === 0 && results.markets.length === 0 && (
                <div className="px-3 py-2 text-xs text-slate-400">Searching RISEx index…</div>
              )}

              {results.markets.length > 0 && (
                <div className="mb-2">
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    Markets ({results.markets.length})
                  </div>
                  {results.markets.map((m) => {
                    const chg = calcMarketChangePct(m.mark_price || m.last_price, m.change_24h);
                    return (
                      <button
                        key={m.market_id}
                        type="button"
                        onClick={() => {
                          setSearchOpen(false);
                          setMobileSearchOpen(false);
                          setQuery('');
                          onSelectMarket(String(m.market_id));
                        }}
                        className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left hover:bg-[#131c31]"
                      >
                        <div className="flex items-center gap-2">
                          <TokenBadge symbol={m.base_asset_symbol} category={m.category} size={22} />
                          <div>
                            <div className="text-xs font-semibold text-[#e8edfb]">{m.display_name}</div>
                            <div className="text-[10px] text-slate-400">{m.category || 'PERP'} · Max {m.config?.max_leverage || '—'}x</div>
                          </div>
                        </div>
                        <div className="text-right font-mono text-xs tabular-nums">
                          <div className="text-[#e8edfb]">{formatPrice(m.mark_price || m.last_price)}</div>
                          <div className={chg >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}>
                            {formatPct(chg)}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {results.traders.length > 0 && (
                <div>
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    Traders ({results.traders.length})
                  </div>
                  {results.traders.map((t) => (
                    <button
                      key={t.address}
                      type="button"
                      onClick={() => {
                        setSearchOpen(false);
                        setMobileSearchOpen(false);
                        setQuery('');
                        onSelectWallet(t.address);
                      }}
                      className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left hover:bg-[#131c31]"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <TraderAvatar
                          address={t.address}
                          avatarUrl={t.avatarUrl}
                          username={t.username}
                          size={24}
                        />
                        <div className="min-w-0">
                          <div className="truncate text-xs font-semibold text-[#e8edfb]">
                            {t.username || shortAddress(t.address)}
                            {t.xHandle && (
                              <span className="ml-1.5 text-[10px] font-mono text-[#46a6ff]">@{t.xHandle}</span>
                            )}
                          </div>
                          <div className="text-[10px] font-mono text-slate-400">{shortAddress(t.address, 8, 6)}</div>
                        </div>
                      </div>
                      <div className="text-right font-mono text-xs tabular-nums">
                        <div className={t.totalPnlAll >= 0 ? 'text-[#22e0a1]' : 'text-[#ff4d6d]'}>
                          {formatSignedUsd(t.totalPnlAll, true)}
                        </div>
                        <div className="text-[10px] text-slate-400">PnL</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {!searchLoading && results.markets.length === 0 && results.traders.length === 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setMobileSearchOpen(false);
                    handleSubmit({ preventDefault: () => {} } as React.FormEvent);
                  }}
                  className="w-full rounded-lg px-3 py-2 text-left text-xs text-slate-300 hover:bg-[#131c31]"
                >
                  Press Enter to resolve <span className="font-mono text-[#ffb02e]">{query.trim()}</span> directly via RISEx API
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Live Scrolling Market Ticker Strip */}
      {tickerItems.length > 0 && (
        <div className="ticker-wrap overflow-hidden border-t border-slate-800/75 bg-[#070b15]/95 py-1">
          <div className="ticker-track">
            {[...tickerItems, ...tickerItems].map((m, i) => {
              const mark = Number(m.mark_price || m.last_price || 0);
              const chg = calcMarketChangePct(mark, m.change_24h);
              const up = chg >= 0;
              const sym = m.base_asset_symbol.replace(/\/.*$/, '').replace(/\s*\[deprecated.*$/i, '').trim();
              const half = i < tickerItems.length ? 'a' : 'b';
              return (
                <button
                  key={`${m.market_id}-${half}`}
                  type="button"
                  onClick={() => onSelectMarket(String(m.market_id))}
                  className="group flex shrink-0 items-center gap-1.5 rounded border border-slate-800/80 bg-[#0b1120]/90 px-2 py-0.5 text-[11px] font-mono tabular-nums whitespace-nowrap hover:border-[#ffb02e]/50 hover:bg-[#121b31] transition-colors"
                >
                  <TokenBadge symbol={m.base_asset_symbol} category={m.category} size={16} />
                  <span className="font-display text-[11px] font-bold tracking-tight text-[#e8edfb] group-hover:text-[#ffb02e] transition-colors">
                    {sym}
                  </span>
                  <span className="text-[11px] text-slate-300">{formatPrice(mark)}</span>
                  <span
                    className={`inline-flex items-center gap-0.5 rounded px-1.5 py-[1px] text-[10px] font-bold leading-tight ${
                      up
                        ? 'border border-[#22e0a1]/30 bg-[#22e0a1]/15 text-[#22e0a1]'
                        : 'border border-[#ff4d6d]/30 bg-[#ff4d6d]/15 text-[#ff4d6d]'
                    }`}
                  >
                    <span aria-hidden="true" className="text-[8px]">
                      {up ? '▲' : '▼'}
                    </span>
                    {formatPct(chg)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </header>
  );
};
