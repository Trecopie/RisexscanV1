import {shortAddress} from './format';

/**
 * This address is labeled RISEx Vault by the user's updated V2 UI source.
 * Independent protocol-operator/contract verification has NOT been found.
 * Resolve by full wallet address ONLY. The alias "mmAdapter" alone is
 * insufficient evidence that an arbitrary wallet belongs to the vault.
 */
export const POSSIBLE_VAULT_WALLET='0x938a104179a2d23dec249a968ecd5b4f8b857cac';
export function formatTraderDisplay(address:string,username?:string|null):{
  name:string;
  provisionalVault:boolean;
  attribution:string|null;
}{
  if(String(address||'').toLowerCase()===POSSIBLE_VAULT_WALLET){
    return {name:'RISEx Vault (mmAdapter)',provisionalVault:true,
      attribution:'Vault attribution inferred from RISExScanV2 UI mapping; not independently verified with RISEx.'};
  }
  return {name:username?.trim()||shortAddress(address),
    provisionalVault:false,attribution:null};
}
