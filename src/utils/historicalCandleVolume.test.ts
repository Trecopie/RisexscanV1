import test from 'node:test';
import assert from 'node:assert/strict';
import {
 calibrateCandleVolume, normalizeDailyCandle,dailyVolumeEstimate,
 type DailyRisexCandle,
} from './historicalCandleVolume';
const day=Date.UTC(2026,10,15);
const candles=(open:number,volToday:number,volYesterday:number):DailyRisexCandle[]=>[
 {time:day-86_400_000,open,close:open,volume:volYesterday},
 {time:day,open,close:open,volume:volToday},
];
test('identifies base-asset volumes against official rolling quote volume',()=>{
 const rows=candles(100,5,10),selection=calibrateCandleVolume(rows,1000,day+43_200_000);
 assert.equal(selection.mode,'base');
 assert.equal(dailyVolumeEstimate(rows[0],'base'),1000);
});
test('does not multiply already-USD candle volume by price',()=>{
 const rows=candles(100,500,1000),selection=calibrateCandleVolume(rows,1000,day+43_200_000);
 assert.equal(selection.mode,'quote');
 assert.equal(dailyVolumeEstimate(rows[0],'quote'),1000);
});
test('refuses nonsensical conversions rather than producing fake history',()=>{
 assert.equal(calibrateCandleVolume(candles(100,5,10),1000000000,day+43_200_000).mode,'unverified');
 assert.equal(calibrateCandleVolume(candles(100,5,10),0,day+43_200_000).mode,'unverified');
 assert.equal(calibrateCandleVolume([],1000,day+43_200_000).mode,'unverified');
});
test('reads nanosecond candle timestamps into UTC days',()=>{
 const ms=day+1_800_000,ns=(BigInt(ms)*1_000_000n).toString();
 assert.equal(normalizeDailyCandle({time:ns,open:'10',close:'11',volume:'5'})?.time,day);
 assert.equal(normalizeDailyCandle({time:ns,open:'10',close:'11',volume:'-5'}),null);
});
