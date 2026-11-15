import test from 'node:test';
import assert from 'node:assert/strict';
import {curatedAssetLogoUrl} from './TokenBadge.tsx';

test('curated icon registry serves known symbols and avoids wrong asset mappings',()=>{
  assert.match(curatedAssetLogoUrl('BTC/USDC','crypto') || '',/\/btc\.svg$/);
  assert.match(curatedAssetLogoUrl('NVDA/USDC','stocks') || '',/\/nvidia\.svg$/);
  assert.equal(curatedAssetLogoUrl('SPY/USDC','index_etf'),null);
  assert.equal(curatedAssetLogoUrl('SOMEUNKNOWN/USDC','crypto'),null);
  assert.equal(curatedAssetLogoUrl('BTC','stocks'),null);
});
