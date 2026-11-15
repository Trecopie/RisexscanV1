/**
 * Read-only launch smoke test against the published RISExScan site.
 * No account, wallet signature, market order or state-changing API call.
 */
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';

const origin=process.env.SITE_URL||'https://risexscan.onrender.com';
const url=new URL(origin);
if(url.protocol!=='https:'||url.username||url.password||url.port){
  throw Error('Only a normal public HTTPS origin is supported');
}
await mkdir('artifacts/browser',{recursive:true});
const browser=await chromium.launch({headless:true});
const errors=[];
const attach=(page)=>{
  page.on('pageerror',err=>errors.push(err.message.slice(0,200)));
};
try{
  const desktop=await browser.newPage({viewport:{width:1440,height:920},deviceScaleFactor:1});
  attach(desktop);
  await desktop.goto(url.origin,{waitUntil:'domcontentloaded',timeout:120000});
  await desktop.getByRole('heading',{name:'Historical Market Analytics'}).waitFor({timeout:30000});
  const marketHistory=await desktop.evaluate(async()=>{
    const response=await fetch('/api/analytics/history');
    if(!response.ok)throw Error('Historical API HTTP '+response.status);
    const data=await response.json();
    return {
      days:data.marketCandles?.daily?.length??0,
      marketIds:data.marketCandles?.distinctMarkets??0,
      firstDay:data.marketCandles?.firstDay??null,
      oiPoints:data.defillamaOi?.points?.length??0,
    };
  });
  assert.ok(marketHistory.days>=180,'Historical candle archive should contain real prior dates');
  assert.ok(marketHistory.marketIds>=50,'Historical candle market count unexpectedly low');
  assert.ok(marketHistory.firstDay<Date.now()-90*86_400_000,'Missing older RISEx history');
  console.log('Historical: '+JSON.stringify(marketHistory));

  await desktop.screenshot({path:'artifacts/browser/overview-dark.png',fullPage:false});

  const light=desktop.getByRole('button',{name:'Switch to light mode'});
  await light.click();
  assert.equal(await desktop.evaluate(()=>document.documentElement.dataset.theme),'light');
  await desktop.screenshot({path:'artifacts/browser/overview-light.png',fullPage:false});
  await desktop.reload({waitUntil:'domcontentloaded',timeout:120000});
  assert.equal(await desktop.evaluate(()=>document.documentElement.dataset.theme),'light',
    'Light theme must persist across reloads');
  await desktop.getByRole('button',{name:'Switch to dark mode'}).click();
  assert.equal(await desktop.evaluate(()=>document.documentElement.dataset.theme),'dark');

  await desktop.getByRole('button',{name:'Markets',exact:true}).first().click();
  assert.ok(new URL(desktop.url()).searchParams.get('tab')==='markets',
    'Market navigation should update the shareable URL');
  await desktop.getByRole('button',{name:'Heatmap',exact:true}).click();
  await desktop.getByRole('heading',{name:'Market Heatmap'}).waitFor({timeout:30000});
  await desktop.locator('.market-heat-tile').first().waitFor({timeout:30000});
  const tiles=await desktop.locator('.market-heat-tile').count();
  assert.ok(tiles>0&&tiles<=150,'Expected bounded live heatmap');
  await desktop.screenshot({path:'artifacts/browser/markets-heatmap.png',fullPage:false});
  await desktop.getByRole('group',{name:'Market display'}).getByRole('button',{name:'Screener',exact:true}).click();
  assert.ok(await desktop.getByRole('table').first().isVisible(),'Screener table restored');
  await desktop.getByRole('button',{name:'Leaderboard',exact:true}).first().click();
  assert.ok(new URL(desktop.url()).searchParams.get('tab')==='leaderboard',
    'Leaderboard navigation should update the shareable URL');
  console.log('Desktop: heatmap '+tiles+' live cells, charts, dark/light persistence, market+leaderboard navigation OK');

  const mobile=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1,
    isMobile:true,hasTouch:true});
  attach(mobile);
  await mobile.goto(url.origin,{waitUntil:'domcontentloaded',timeout:120000});
  await mobile.getByRole('button',{name:'Markets',exact:true}).first().click();
  await mobile.getByRole('button',{name:'Heatmap',exact:true}).click();
  await mobile.getByRole('heading',{name:'Market Heatmap'}).waitFor({timeout:30000});
  const overflow=await mobile.evaluate(()=>({
    viewport:document.documentElement.clientWidth,
    body:document.body.scrollWidth,
    html:document.documentElement.scrollWidth,
  }));
  await mobile.screenshot({path:'artifacts/browser/overview-mobile.png',fullPage:false});
  assert.ok(overflow.html<=overflow.viewport+10,'Unexpected page-wide horizontal overflow: '+JSON.stringify(overflow));
  assert.deepEqual(errors,[],'Uncaught browser runtime exceptions');
  console.log('Mobile: responsive overview, no page-wide overflow; uncaught errors: 0');
  console.log('Launch smoke test is visual/browser wiring evidence, not a guarantee of fee, volume, or all-time indexing accuracy.');
}finally{await browser.close();}
