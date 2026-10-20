import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// 가린 로컬 자료의 실제 Next 화면을 조회합니다. 신청·저장·결제 요청은 보내지 않습니다.
const base = 'http://127.0.0.1:4090';
const routes = ['/', '/about','/programs','/schedule','/annual','/simulator','/apply','/apply/trial','/apply/enroll','/apply/uniform','/notices','/gallery','/faq','/terms','/privacy','/seasonal'];
const results = []; const browser = await chromium.launch({ executablePath: process.env.STATUS_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true });
await mkdir('.tmp/public-pages-preview', { recursive:true });
try {
  for (const theme of ['lavender','official','sport']) {
    const context = await browser.newContext();
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base || request.method() !== 'GET') return route.abort();
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    for (const width of [320,360,768,1280,1440]) for (const pathname of routes) {
      const errors = []; const record = { theme, width, pathname };
      const onError = error => errors.push(error.message); page.on('pageerror',onError);
      try {
        await page.setViewportSize({width,height:900});
        const response = await page.goto(`${base}${pathname}?previewTheme=${theme}`, {waitUntil:'domcontentloaded'});
        assert.equal(response.status(),200);
        await page.locator(`.public-site[data-public-theme="${theme}"]`).waitFor();
        await page.locator('main h1').waitFor();
        const bounds=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,heading:document.querySelectorAll('main h1').length,inputs:[...document.querySelectorAll('main input,main textarea')].filter(e=>e.getClientRects().length&&!['checkbox','radio','hidden'].includes(e.type)).map(e=>parseFloat(getComputedStyle(e).fontSize))}));
        assert.ok(bounds.scroll<=width+1,JSON.stringify(bounds)); assert.equal(bounds.heading,1); assert.ok(bounds.inputs.every(size=>size>=16));assert.deepEqual(errors,[]);
        if(pathname==='/'&&width<=360){const cta=await page.locator('main a[href="/apply/trial"]').first().boundingBox();assert.ok(cta.y+cta.height<=900,'첫 화면 체험 신청 표시');assert.ok(!(await page.locator('main h1').innerText()).includes('No.1'));}
        if(pathname==='/'&&[360,1440].includes(width))await page.screenshot({path:`.tmp/public-pages-preview/${theme}-${width}.png`,fullPage:true});
        record.pass=true;
      }catch(error){record.pass=false;record.error=error.message;}
      finally{page.off('pageerror',onError);results.push(record);}
    }
    for(const [width,height] of [[320,900],[874,402],[402,300]]) {
      const record={theme,width,height,pathname:'help-chat'};
      try {
        await page.setViewportSize({width,height});await page.goto(`${base}/?previewTheme=${theme}`);
        await page.getByRole('button',{name:'상담·안내 열기'}).click();
        const help=page.getByRole('region',{name:'상담과 이용 안내'});await help.getByRole('button',{name:'학원 둘러보기'}).click();
        const box=await help.boundingBox();assert.ok(box.y>=0&&box.y+box.height<=height);
        await help.getByRole('button',{name:'다른 도움 보기'}).click();await help.getByRole('button',{name:'상담 챗봇',exact:true}).click();
        const close=page.getByRole('button',{name:'채팅 닫기'});await close.waitFor();const closeBox=await close.boundingBox();assert.ok(closeBox.y>=0&&closeBox.y+closeBox.height<=height);
        await page.locator('.public-chat-panel textarea').fill('화면 확인');const input=await page.locator('.public-chat-panel textarea').boundingBox();assert.ok(input.y>=0&&input.y+input.height<=height);
        await close.click();record.pass=true;
      }catch(error){record.pass=false;record.error=error.message;}
      results.push(record);
    }
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile('.tmp/public-pages-preview/report.json',JSON.stringify({total:results.length,passed:results.filter(r=>r.pass).length,cases:results},null,2));
}
const failed=results.filter(r=>!r.pass);console.log(JSON.stringify({total:results.length,passed:results.length-failed.length,failed}));if(failed.length)process.exitCode=1;
