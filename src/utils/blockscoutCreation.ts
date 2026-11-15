/** Parse Blockscout's official legacy contract-creation lookup only when its
 * response explicitly associates the requested contract with a creation tx.
 * This must not infer a creation transaction from ordinary contract calls.
 */
export function contractCreationHash(response:unknown,contract:string):string|null{
  if(!/^0x[a-f0-9]{40}$/i.test(contract))return null;
  if(!response||typeof response!=='object')return null;
  const record=response as Record<string,unknown>;
  if(record.status!=='1'||!Array.isArray(record.result))return null;
  const matches=record.result.filter(row=>{
    if(!row||typeof row!=='object')return false;
    const entry=row as Record<string,unknown>;
    return typeof entry.contractAddress==='string'&&entry.contractAddress.toLowerCase()===contract.toLowerCase();
  });
  if(matches.length!==1)return null;
  const hash=(matches[0] as Record<string,unknown>).txHash;
  return typeof hash==='string'&&/^0x[a-f0-9]{64}$/i.test(hash)?hash:null;
}
