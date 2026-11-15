import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyRawBook,crc32Ascii,risexBookChecksum,applyRawBookFrame,readRawOrderbookFrame,rawBookIntegrityOk} from './orderbookIntegrity.ts';

test('CRC32-IEEE canonical test vector and exact wei interleaving',()=>{
  assert.equal(crc32Ascii('123456789'),0xCBF43926);
  const book=emptyRawBook();
  const f=readRawOrderbookFrame({
    channel:'orderbook',type:'snapshot',market_id:'1', data:{market_id:1,
      bids:[{price:'50000000000000000000000',quantity:'1000000000000000000'}],
      asks:[{price:'50100000000000000000000',quantity:'2000000000000000000'}],
    },
  })!;
  assert.ok(f);applyRawBookFrame(book,f);
  assert.equal(risexBookChecksum(book),crc32Ascii(
    '50000000000000000000000:1000000000000000000:50100000000000000000000:2000000000000000000'
  ));
});
test('snapshot + delta + delete validate and detect corruption',()=>{
  const book=emptyRawBook();
  const frame=(type:'snapshot'|'update',bids:unknown[],asks:unknown[],checksum?:number)=>
    readRawOrderbookFrame({channel:'orderbook',type,market_id:'2',checksum,data:{market_id:2,bids,asks}})!;
  applyRawBookFrame(book,frame('snapshot',[
    {price:'100000000000000000000',quantity:'5000000000000000000'}],[
    {price:'101000000000000000000',quantity:'2000000000000000000'}]));
  const expected=emptyRawBook();expected.bids.set('99000000000000000000','4000000000000000000');
  expected.asks.set('101000000000000000000','2000000000000000000');
  const update=frame('update',[
    {price:'100000000000000000000',quantity:'0'},
    {price:'99000000000000000000',quantity:'4000000000000000000'},
  ],[],risexBookChecksum(expected));
  applyRawBookFrame(book,update);
  assert.equal(rawBookIntegrityOk(book,update),true);
  assert.equal(book.bids.has('100000000000000000000'),false);
  const bad=frame('update',[],[],123456);
  assert.equal(rawBookIntegrityOk(book,bad),false);
});
test('invalid decimal formatted L2 frames are rejected instead of poisoning book',()=>{
  assert.equal(readRawOrderbookFrame({channel:'orderbook',type:'update',market_id:'1',data:{bids:[{price:'100.0',quantity:'2'}],asks:[]}}),null);
});
