import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/home/node/.cache/ms-playwright/chromium-1148/chrome-linux/chrome', args: ['--no-sandbox','--disable-gpu','--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('http://localhost:8787/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__editor && window.__editor.getState().engineReady);
await page.waitForTimeout(300);
await page.check('#showCorr');
await page.waitForTimeout(150);
const dots = await page.evaluate(() => window.__editor.landmarkScreenPositions());
const rect = await page.evaluate(() => { const r = window.__editor.canvasRect(); return { left: r.left, top: r.top }; });
const target = dots.find(d => d.landmarkId === 'F_mark') || dots[0];
const clientX = rect.left + target.canvas[0];
const clientY = rect.top + target.canvas[1];
const before = await page.locator('#endpoints').textContent();
// drag that dot 20px right
await page.mouse.move(clientX, clientY);
await page.mouse.down();
await page.mouse.move(clientX + 20, clientY + 6, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(400);
await page.screenshot({ path: 'out/ui/07-after-edit.png' });
const after = await page.locator('#endpoints').textContent();
await page.evaluate(() => { const p=document.getElementById('phase'); p.value='0.5'; p.dispatchEvent(new Event('input',{bubbles:true})); });
await page.waitForTimeout(300);
await page.screenshot({ path: 'out/ui/08-after-edit-mid.png' });
const diag = await page.locator('#diagnostics').textContent();
const dotAfter = (await page.evaluate(() => window.__editor.landmarkScreenPositions())).find(d => d.landmarkId === target.landmarkId);
console.log(JSON.stringify({
  errs, target: target.landmarkId,
  dotMovedClient: Math.hypot(dotAfter.canvas[0]-target.canvas[0], dotAfter.canvas[1]-target.canvas[1]),
  before, after, endpointsChanged: before !== after, diag,
}, null, 2));
await browser.close();
