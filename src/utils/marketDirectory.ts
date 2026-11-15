import type { RisexMarket } from '../types/risex';

/** Keep the directory, counter, volume and OI on the exact same market subset. */
export function filterDirectoryMarkets<T extends RisexMarket>(
  markets: T[],
  category: string,
  search: string,
  includeInactive = false
): T[] {
  const selectedCategory = category.toUpperCase();
  const q = search.trim().toLowerCase();
  return markets.filter((market) => {
    // A delisted/paused market is not part of the live venue universe.
    if (!includeInactive && market.active === false) return false;
    if (selectedCategory !== 'ALL' && (market.category || '').toUpperCase() !== selectedCategory) {
      return false;
    }
    if (!q) return true;
    return (
      (market.display_name || '').toLowerCase().includes(q) ||
      (market.base_asset_symbol || '').toLowerCase().includes(q) ||
      (market.search_tags || []).some((tag) => tag.toLowerCase().includes(q))
    );
  });
}

function nonNegativeFinite(raw: unknown): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function summarizeDirectoryMarkets(markets: RisexMarket[]) {
  let volume24h = 0;
  let openInterestUsd = 0;
  for (const market of markets) {
    const markPrice = nonNegativeFinite(market.mark_price || market.last_price);
    volume24h += nonNegativeFinite(market.quote_volume_24h);
    openInterestUsd += nonNegativeFinite(market.open_interest) * markPrice;
  }
  return { marketCount: markets.length, volume24h, openInterestUsd };
}
