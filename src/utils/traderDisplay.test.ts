import test from 'node:test';
import assert from 'node:assert/strict';
import {formatTraderDisplay,POSSIBLE_VAULT_WALLET} from './traderDisplay';
test('possible vault label requires the known V2 UI wallet address, never merely username',()=>{
  const recognized=formatTraderDisplay(POSSIBLE_VAULT_WALLET,'mmAdapter');
  assert.equal(recognized.provisionalVault,true);
  assert.match(recognized.name,/RISEx Vault/);
  assert.match(recognized.attribution||'',/not independently verified/);
  const lookalike=formatTraderDisplay('0x1111111111111111111111111111111111111111','mmAdapter');
  assert.equal(lookalike.provisionalVault,false);
  assert.equal(lookalike.name,'mmAdapter');
});
