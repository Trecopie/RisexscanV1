export interface DailyRisexCandle {
  time:number;
  open:number;
  close:number;
  volume:number;
}
export type CandleVolumeMode='base'|'quote'|'unverified';
export interface CandleVolumeCalibration {
  mode:CandleVolumeMode;
  estimated24hUsd:number|null;
  relativeDifference:number|null;
}
/**
 * RISEx's undocumented OHLCV volume unit must NOT be blindly assumed USD.
 * Compare a 24h rolling exchange quote-volume reference against the
 * last two UTC-day candles, with approximate time weighting. The result is
 * a heuristic, NOT source-authenticated volume. Reject questionable rows.
 */
export function calibrateCandleVolume(
  candles:DailyRisexCandle[],
  official24hUsd:number,
  nowMs:number,
):CandleVolumeCalibration {
  const unknown: CandleVolumeCalibration={mode:'unverified',estimated24hUsd:null,relativeDifference:null};
  if(!Number.isFinite(official24hUsd)||official24hUsd<=0||!Number.isFinite(nowMs))return unknown;
  const DAY=86_400_000;
  const today=Math.floor(nowMs/DAY)*DAY;
  const last=candles.find(c=>c.time===today);
  const previous=candles.find(c=>c.time===today-DAY);
  if(!last||!previous)return unknown;
  const frac=Math.max(0,Math.min(1,(nowMs-today)/DAY));
  const mid=(c:DailyRisexCandle)=>c.open>0&&c.close>0?(c.open+c.close)/2:0;
  const base=last.volume*mid(last)+previous.volume*mid(previous)*(1-frac);
  const quote=last.volume+previous.volume*(1-frac);
  if(!(base>0&&quote>0&&Number.isFinite(base)&&Number.isFinite(quote)))return unknown;
  const baseDiff=Math.abs(Math.log(base/official24hUsd));
  const quoteDiff=Math.abs(Math.log(quote/official24hUsd));
  const diff=Math.min(baseDiff,quoteDiff);
  // Exchange/UTC candle windows and intraday seasonality do differ.
  // If neither interpretation is within a factor of three, do not store it.
  if(diff>Math.log(3))return unknown;
  // Close matches can be ambiguous when the asset itself trades near $1.
  // Such a case matters less than the variation in rolling-vs-UTC windows.
  if(Math.abs(baseDiff-quoteDiff)<Math.log(1.15)&&
    Math.abs(Math.log(base/quote))>Math.log(1.15))return unknown;
  const mode:CandleVolumeMode=baseDiff<quoteDiff?'base':'quote';
  const selected=mode==='base'?base:quote;
  return {mode,estimated24hUsd:selected,
    relativeDifference:Math.abs(selected-official24hUsd)/official24hUsd};
}
export function normalizeDailyCandle(raw:unknown):DailyRisexCandle|null{
  if(!raw||typeof raw!=='object')return null;
  const item=raw as Record<string,unknown>;
  const timeRaw=String(item.time??'');
  let t=0;
  if(/^\d{16,}$/.test(timeRaw))t=Number(BigInt(timeRaw)/1_000_000n);
  else if(/^\d{13}$/.test(timeRaw))t=Number(timeRaw);
  else if(/^\d{10}$/.test(timeRaw))t=Number(timeRaw)*1000;
  const open=Number(item.open),close=Number(item.close),volume=Number(item.volume);
  if(!Number.isFinite(t)||t<=0||!Number.isFinite(open)||open<=0||
    !Number.isFinite(close)||close<=0||!Number.isFinite(volume)||volume<0)return null;
  return {time:Math.floor(t/86_400_000)*86_400_000,open,close,volume};
}
export function dailyVolumeEstimate(candle:DailyRisexCandle,mode:Exclude<CandleVolumeMode,'unverified'>):number{
  const quote=mode==='base'?candle.volume*((candle.open+candle.close)/2):candle.volume;
  return Number.isFinite(quote)&&quote>=0?quote:0;
}
