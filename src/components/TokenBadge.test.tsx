import test from 'node:test';
import assert from 'node:assert/strict';
import {curatedAssetLogoUrl} from './TokenBadge.tsx';

test('curated icon registry serves known symbols and avoids wrong asset mappings',()=>{
  assert.match(curatedAssetLogoUrl('BTC/USDC','crypto') || '',/\/btc\.svg$/);
  assert.ok((curatedAssetLogoUrl('NVDA/USDC','stocks') || '').endsWith('/nvidia/76B900'));
  assert.ok((curatedAssetLogoUrl('XMR/USDC','crypto') || '').endsWith('/xmr.svg'));
  assert.ok((curatedAssetLogoUrl('ZEC/USDC','crypto') || '').endsWith('/zec.svg'));
  assert.equal(curatedAssetLogoUrl('SPY/USDC','index_etf'),null);
  assert.equal(curatedAssetLogoUrl('SOMEUNKNOWN/USDC','crypto'),null);
  assert.equal(curatedAssetLogoUrl('BTC','stocks'),null);
});
