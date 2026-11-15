import test from 'node:test';
import assert from 'node:assert/strict';
import {HistoryStore} from './historyStore.ts';

const testUrl=process.env.TEST_DATABASE_URL || '';
test('PostgreSQL round trip: durable traders, state, unique trades, OI and cohort changes',
  {skip:!testUrl ? 'Set TEST_DATABASE_URL to run real PostgreSQL integration test':false},
  async()=>{
    const store=new HistoryStore(testUrl);
    try {
      await store.initialize();
      assert.equal(store.ready,true);
      const marker=`0x${'ab'.repeat(20)}`;
      await store.upsertTraders([{address:marker,username:'ci-verify',accountValue:120.1}]);
      let loaded:any[]=[];
      await store.loadTraders(rows=>{loaded.push(...rows);});
      assert.ok(loaded.some(t=>t.address.toLowerCase()===marker && t.username==='ci-verify'));
      await store.saveState({lastIndexComplete:1234,authCursor:{page:3}});
      const state=await store.loadState();
      assert.equal(state.lastIndexComplete,1234);
      assert.deepEqual(state.authCursor,{page:3});

      const now=Date.now(),hour=Math.floor(now/3600000)*3600000;
      const fakeId='ci-test-market';
      await store.recordMarketSamples([{
        marketId:fakeId,observedAt:hour,
        openInterestUsd:222,volume24hUsd:333,fundingRate:0.001,markPrice:100,
      }]);
      const makeTrade=(id:string)=>({
        marketId:fakeId,tradeId:id,timestampMs:hour+3000,
        notionalUsd:105,feeUsd:0.45,
        maker:marker,taker:`0x${'cd'.repeat(20)}`,makerSide:1,price:'105',size:'1',
      });
      await store.recordTrades([makeTrade('ci-test-execution-1'),makeTrade('ci-test-execution-1')]);
      const history=await store.getHistoricalAnalytics();
      assert.equal(history.coverage.databaseConnected,true);
      assert.ok(history.coverage.observedTrades>=1);
      assert.ok(history.dailyTrades.some(day=>day.volumeUsd>=105));
      assert.ok(history.oiSnapshots.some(s=>s.marketCount>=1 && s.openInterestUsd>=222));

      // A single bucket must expose present exposure, not a fabricated zero-based change.
      await store.recordCohortSnapshots([
        {marketId:fakeId,cohort:'whale',observedAt:hour-3600000,longUsd:100,shortUsd:10,positions:2},
      ]);
      const initialPositions=await store.getPositionChanges();
      assert.equal(initialPositions.mode,'current');
      assert.equal(initialPositions.fromTime,null);
      assert.ok(initialPositions.changes.some(v=>
        v.marketId===fakeId && v.cohort==='whale' &&
        v.currentNetUsd===90 && v.deltaNetUsd===null && v.previousNetUsd===null
      ));

      await store.recordCohortSnapshots([
        {marketId:fakeId,cohort:'whale',observedAt:hour,longUsd:120,shortUsd:30,positions:2},
        {marketId:fakeId,cohort:'shark',observedAt:hour-3600000,longUsd:25,shortUsd:0,positions:1},
      ]);
      const changes=await store.getPositionChanges();
      assert.equal(changes.mode,'changes');
      assert.ok(changes.changes.some(v=>v.marketId===fakeId && v.cohort==='whale' && v.deltaNetUsd!==null && Math.abs(v.deltaNetUsd)<1e-9));
      assert.ok(changes.changes.some(v=>v.marketId===fakeId && v.cohort==='shark' && v.deltaNetUsd===-25));
      // Verify the default free-tier budget cannot be bypassed by bulk fills.
      const previousLimit=process.env.RISEX_DB_SOFT_LIMIT_BYTES;
      process.env.RISEX_DB_SOFT_LIMIT_BYTES='1';
      const guarded=new HistoryStore(testUrl);
      try{
        await guarded.initialize();
        assert.equal((await guarded.storageStatus(true)).writeLimited,true);
        await assert.rejects(
          ()=>guarded.recordTrades([makeTrade('ci-test-over-quota')]),
          /soft storage limit reached/
        );
      }finally{
        await guarded.close();
        if(previousLimit===undefined)delete process.env.RISEX_DB_SOFT_LIMIT_BYTES;
        else process.env.RISEX_DB_SOFT_LIMIT_BYTES=previousLimit;
      }
    } finally {
      await store.close();
    }
  }
);
