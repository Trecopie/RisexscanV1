import type {RisexMarket} from '../types/risex';
import {calcMarketChangePct} from './format';
import {normalizeMarketSector} from './overviewAnalytics';

export interface MarketHeatmapCell {
  id:string;
  symbol:string;
  changePct:number;
  rangePct:number|null;
  volumeUsd:number;
  sharePct:number;
  intensity:number;
  rank:number;
  sector:'crypto'|'rwa';
}

/** Volatility proxy is the reported 24-hour high/low percentage range.
 * It is NOT realized volatility or a reconstructed price series.
 */
export function buildMarketHeatmap(markets:RisexMarket[]):MarketHeatmapCell[]{
  const rows=markets
    .filter(m=>m.active!==false)
    .map(m=>{
      const mark=Number(m.mark_price||m.last_price);
      const high=Number(m.high_24h),low=Number(m.low_24h);
      const volume=Number(m.quote_volume_24h);
      const validRange=Number.isFinite(high)&&Number.isFinite(low)&&high>0&&low>0&&high>=low;
      const range=validRange?(high-low)/((high+low)/2)*100:null;
      return {
        id:String(m.market_id),symbol:String(m.base_asset_symbol||m.display_name||m.market_id),
        changePct:calcMarketChangePct(mark,m.change_24h),
        rangePct:range,volumeUsd:Number.isFinite(volume)&&volume>=0?volume:0,
        sector:normalizeMarketSector(m.category,m.base_asset_symbol)==='crypto'?'crypto' as const:'rwa' as const,
      };
    })
    .sort((a,b)=>b.volumeUsd-a.volumeUsd||a.symbol.localeCompare(b.symbol));
  const sum=rows.reduce((a,b)=>a+b.volumeUsd,0);
  const max=Math.max(1,...rows.map(r=>r.volumeUsd));
  return rows.map((r,i)=>({
    ...r,rank:i+1,sharePct:sum>0?r.volumeUsd/sum*100:0,
    // Log normalization avoids allowing BTC alone to overpower all smaller RWA cells.
    intensity:Math.max(.12,Math.min(1,Math.log1p(r.volumeUsd)/Math.log1p(max))),
  }));
}
