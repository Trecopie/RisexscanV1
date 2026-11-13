import { useEffect, useState } from 'react';
import { Navbar, type NavTab } from './components/Navbar';
import { OverviewPage } from './components/OverviewPage';
import { LeaderboardPage } from './components/LeaderboardPage';
import { MarketsPage } from './components/MarketsPage';
import { TickerDetailPage } from './components/TickerDetailPage';
import { WalletPage } from './components/WalletPage';
import { ExplorerPage } from './components/ExplorerPage';
import { TraderPeekDrawer } from './components/TraderPeekDrawer';
import type { IndexedTrader, RisexMarket } from './types/risex';
import { isValidAddress, isValidTxHash } from './utils/format';

function parseUrlRoute(): {
  tab: NavTab;
  marketId: string | null;
  wallet: string | null;
  txHash: string | null;
} {
  if (typeof window === 'undefined') {
    return { tab: 'overview', marketId: null, wallet: null, txHash: null };
  }
  const params = new URLSearchParams(window.location.search);
  const wallet = params.get('wallet') || params.get('address');
  const marketId = params.get('market');
  const txHash = params.get('tx');
  const rawTab = params.get('tab') as NavTab | null;

  if (wallet) return { tab: 'wallet', marketId: null, wallet, txHash: null };
  if (txHash) return { tab: 'explorer', marketId: null, wallet: null, txHash };
  if (marketId) return { tab: 'markets', marketId, wallet: null, txHash: null };
  if (rawTab && ['overview', 'markets', 'leaderboard', 'explorer', 'wallet'].includes(rawTab)) {
    return { tab: rawTab, marketId: null, wallet: null, txHash: null };
  }
  return { tab: 'overview', marketId: null, wallet: null, txHash: null };
}

function pushUrlRoute(route: {
  tab: NavTab;
  marketId?: string | null;
  wallet?: string | null;
  txHash?: string | null;
}) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams();
  if (route.tab !== 'overview') params.set('tab', route.tab);
  if (route.tab === 'markets' && route.marketId) params.set('market', route.marketId);
  if (route.tab === 'wallet' && route.wallet) params.set('wallet', route.wallet);
  if (route.tab === 'explorer' && route.txHash) params.set('tx', route.txHash);
  const qs = params.toString();
  const nextUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
  if (window.location.pathname + window.location.search !== nextUrl) {
    window.history.pushState(null, '', nextUrl);
  }
}

export default function App() {
  const initial = parseUrlRoute();
  const [activeTab, setActiveTab] = useState<NavTab>(initial.tab);
  const [selectedMarketId, setSelectedMarketId] = useState<string | null>(initial.marketId);
  const [selectedWallet, setSelectedWallet] = useState<string | null>(initial.wallet);
  const [selectedTxHash, setSelectedTxHash] = useState<string | null>(initial.txHash);
  const [markets, setMarkets] = useState<RisexMarket[]>([]);
  const [searchNotice, setSearchNotice] = useState<string | null>(null);

  // Quick-peek drawer state
  const [peekAddress, setPeekAddress] = useState<string | null>(null);
  const [peekSeed, setPeekSeed] = useState<IndexedTrader | null>(null);

  useEffect(() => {
    const onPopState = () => {
      const next = parseUrlRoute();
      setActiveTab(next.tab);
      setSelectedMarketId(next.marketId);
      setSelectedWallet(next.wallet);
      setSelectedTxHash(next.txHash);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    fetch('/api/markets')
      .then((r) => r.json())
      .then((d) => d?.markets && setMarkets(d.markets))
      .catch(() => {});
  }, []);

  const handleNavigate = (tab: NavTab) => {
    setSearchNotice(null);
    const nextMarketId = tab === 'markets' ? null : selectedMarketId;
    if (tab === 'markets') {
      setSelectedMarketId(null);
    }
    setActiveTab(tab);
    pushUrlRoute({
      tab,
      marketId: tab === 'markets' ? null : nextMarketId,
      wallet: tab === 'wallet' ? selectedWallet : null,
      txHash: tab === 'explorer' ? selectedTxHash : null,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSelectWallet = (addressOrUsername: string) => {
    setSearchNotice(null);
    setSelectedWallet(addressOrUsername);
    setActiveTab('wallet');
    pushUrlRoute({ tab: 'wallet', wallet: addressOrUsername });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSelectMarket = (marketId: string) => {
    setSearchNotice(null);
    setSelectedMarketId(marketId);
    setActiveTab('markets');
    pushUrlRoute({ tab: 'markets', marketId });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleInspectTx = (txHash: string) => {
    setSearchNotice(null);
    setSelectedTxHash(txHash);
    setActiveTab('explorer');
    pushUrlRoute({ tab: 'explorer', txHash });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handlePeekTrader = (address: string, trader?: IndexedTrader) => {
    setPeekAddress(address);
    setPeekSeed(trader || null);
  };

  const handleGlobalSearch = async (rawQuery: string) => {
    const q = rawQuery.trim();
    if (!q) return;

    if (isValidAddress(q)) {
      handleSelectWallet(q);
      return;
    }

    if (isValidTxHash(q)) {
      handleInspectTx(q);
      return;
    }

    // Match ticker symbol or market ID
    const upper = q.toUpperCase();
    const matched =
      markets.find((m) => m.display_name.toUpperCase() === upper) ||
      markets.find((m) => m.display_name.toUpperCase().startsWith(`${upper}/`)) ||
      markets.find((m) => m.base_asset_symbol.toUpperCase() === upper) ||
      markets.find((m) => String(m.market_id) === q);

    if (matched) {
      handleSelectMarket(String(matched.market_id));
      return;
    }

    // Check /api/search for RISEx usernames first, then try direct /api/wallet/:username resolution
    try {
      const sRes = await fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.json());
      if (sRes?.traders?.length > 0) {
        const exact = sRes.traders.find(
          (t: IndexedTrader) => t.username && t.username.toLowerCase() === q.toLowerCase()
        );
        handleSelectWallet((exact || sRes.traders[0]).address);
        return;
      }
      if (sRes?.markets?.length > 0) {
        handleSelectMarket(String(sRes.markets[0].market_id));
        return;
      }

      // Fallback direct RISEx username lookup via /api/wallet/:username?lite=1
      const wRes = await fetch(`/api/wallet/${encodeURIComponent(q)}?lite=1`);
      if (wRes.ok) {
        const wJson = await wRes.json();
        if (wJson?.address) {
          handleSelectWallet(wJson.address);
          return;
        }
      }
    } catch {
      // ignore
    }

    setSearchNotice(`No matching RISEx username, 0x wallet, tx hash, or market found for "${q}".`);
    setTimeout(() => setSearchNotice(null), 4000);
  };

  return (
    <div className="relative min-h-screen flex flex-col text-[#e8edfb]">
      <div className="sunrise-bg" />

      <Navbar
        activeTab={activeTab}
        onNavigate={handleNavigate}
        onGlobalSearch={handleGlobalSearch}
        onSelectWallet={handleSelectWallet}
        onSelectMarket={handleSelectMarket}
        markets={markets}
      />

      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6">
        {searchNotice && (
          <div className="mb-4 rounded-xl border border-[#ffb02e]/35 bg-[#ffb02e]/10 px-4 py-2.5 text-xs text-[#ffb02e]">
            {searchNotice}
          </div>
        )}

        {activeTab === 'overview' && (
          <OverviewPage
            onSelectWallet={handleSelectWallet}
            onSelectMarket={handleSelectMarket}
            onNavigateTab={handleNavigate}
            onPeekTrader={handlePeekTrader}
          />
        )}

        {activeTab === 'leaderboard' && (
          <LeaderboardPage
            onSelectWallet={handleSelectWallet}
            onPeekTrader={handlePeekTrader}
          />
        )}

        {activeTab === 'markets' && (
          selectedMarketId ? (
            <TickerDetailPage
              marketId={selectedMarketId}
              onBack={() => {
                setSelectedMarketId(null);
                pushUrlRoute({ tab: 'markets', marketId: null });
              }}
              onSelectMarket={handleSelectMarket}
              onSelectWallet={handleSelectWallet}
              onPeekTrader={(addr) => handlePeekTrader(addr)}
            />
          ) : (
            <MarketsPage onSelectMarket={handleSelectMarket} />
          )
        )}

        {activeTab === 'explorer' && (
          <ExplorerPage
            initialTxHash={selectedTxHash}
            onSelectWallet={handleSelectWallet}
            onSelectMarket={handleSelectMarket}
          />
        )}

        {activeTab === 'wallet' && (
          <WalletPage
            initialAddress={selectedWallet}
            onSelectWallet={handleSelectWallet}
            onSelectMarket={handleSelectMarket}
            onInspectTx={handleInspectTx}
          />
        )}
      </main>

      <TraderPeekDrawer
        traderAddress={peekAddress}
        seedTrader={peekSeed}
        onClose={() => {
          setPeekAddress(null);
          setPeekSeed(null);
        }}
        onOpenFullProfile={handleSelectWallet}
        onSelectMarket={handleSelectMarket}
      />

      <footer className="border-t border-slate-800/70 bg-[#05070d]/90 py-4 px-6">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-2 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <div>
            RISExScan · Live market, trader, realized PnL & on-chain explorer for RISEx on RISE Mainnet
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://docs.risechain.com/docs/risex/about/overview"
              target="_blank"
              rel="noreferrer"
              className="hover:text-[#ffb02e] transition-colors"
            >
              RISEx Docs
            </a>
            <a
              href="https://explorer.risechain.com/"
              target="_blank"
              rel="noreferrer"
              className="hover:text-[#ffb02e] transition-colors"
            >
              RISE Blockscout
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
