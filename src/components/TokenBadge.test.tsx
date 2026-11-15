import test from 'node:test';
import assert from 'node:assert/strict';
import {curatedAssetLogoUrl} from './TokenBadge.tsx';

test('curated icon registry serves known symbols and avoids wrong asset mappings',()=>{
  assert.match(curatedAssetLogoUrl('BTC/USDC','crypto') || '',/@v0\.18\.1\/svg\/color\/btc\.svg$/);
  assert.ok((curatedAssetLogoUrl('NVDA/USDC','stocks') || '').endsWith('/nvidia/76B900'));
  assert.ok((curatedAssetLogoUrl('XMR/USDC','crypto') || '').endsWith('/xmr.svg'));
  assert.ok((curatedAssetLogoUrl('ZEC/USDC','crypto') || '').endsWith('/zec.svg'));
  assert.equal(curatedAssetLogoUrl('SPY/USDC','index_etf'),null);
  assert.equal(curatedAssetLogoUrl('SOMEUNKNOWN/USDC','crypto'),null);
  assert.match(curatedAssetLogoUrl('NEAR','crypto') || '',/simpleicons\.org\/near\/29A9A0$/);
  assert.equal(curatedAssetLogoUrl('PEPE','crypto'),null); // unknown artwork must not be guessed
  assert.equal(curatedAssetLogoUrl('BTC','stocks'),null);
});
