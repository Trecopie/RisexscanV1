import test from 'node:test';
import assert from 'node:assert/strict';
import {contractCreationHash} from './blockscoutCreation.ts';

const perps='0x53f10facfc8965750494e6965f5d6da39b41d852';
const collateral='0x2c03c7d7e2974c6599b6b108879109281ef3f818';
const tx='0x'+'a'.repeat(64);

test('accepts an explicitly matched contract creation transaction',()=>{
  assert.equal(contractCreationHash({
    status:'1',message:'OK',
    result:[{contractAddress:collateral,contractCreator:perps,txHash:'0x'+'b'.repeat(64)},
            {contractAddress:perps,contractCreator:collateral,txHash:tx}],
  },perps),tx);
});
test('rejects ambiguous, invalid and unrelated creation proofs',()=>{
  assert.equal(contractCreationHash({status:'0',result:[{contractAddress:perps,txHash:tx}]},perps),null);
  assert.equal(contractCreationHash({status:'1',result:[{contractAddress:collateral,txHash:tx}]},perps),null);
  assert.equal(contractCreationHash({status:'1',result:[{contractAddress:perps,txHash:'0x123'}]},perps),null);
  assert.equal(contractCreationHash({status:'1',result:[{contractAddress:perps,txHash:tx},{contractAddress:perps,txHash:tx}]},perps),null);
});
