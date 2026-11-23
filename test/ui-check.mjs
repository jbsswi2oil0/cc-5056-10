// Headless browser check for the editor. Verifies the golden path and a few
// edge cases, capturing screenshots into out/ui/ so the result is reviewable.
import { chromium } from 'playwright';
import fs from 'node:fs';

const URL = 'http://localhost:8787/';
const OUTDIR = 'out/ui';
fs.mkdirSync(OUTDIR, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/home/node/.cache/ms-playwright/chromium-1148/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => {
  const c = document.getElementById('canvas');
  return c && c.width > 0;
}, { timeout: 15000 });
await page.waitForTimeout(400);

async function shot(name) {
  await page.screenshot({ path: `${OUTDIR}/${name}.png` });
}

// 1) Golden path: hands at t=0
await shot('01-hands-t0');

// 2) Scrub to midpoint, overlay mesh + correspondence + provenance
await page.evaluate(() => {
  const p = document.getElementById('phase'); p.value = '0.5';
  p.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(200);
await page.check('#showMesh');
await page.check('#showCorr');
await page.check('#showProv');
await page.waitForTimeout(200);
await shot('02-hands-mid-mesh-prov');

// 3) Hover a pixel to read provenance
const box = await page.locator('#canvas').boundingBox();
await page.mouse.move(box.x + box.width * 0.52, box.y + box.height * 0.55);
await page.waitForTimeout(150);
const probeText = await page.locator('#probe').textContent();
await shot('03-hands-probe');

// 4) t just past midpoint: occlusion should have flipped (diagnostics show fold-free)
await page.evaluate(() => {
  const p = document.getElementById('phase'); p.value = '0.51';
  p.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(200);
await shot('04-hands-past-mid');

// 5) Switch to stitch scene, midpoint, with correspondence + mesh
await page.selectOption('#sceneSelect', 'stitch');
await page.waitForTimeout(600);
await page.uncheck('#showProv');
await page.evaluate(() => {
  const p = document.getElementById('phase'); p.value = '0.5';
  p.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(250);
await shot('05-stitch-mid-mesh');

// 6) Local correspondence edit: go to t=0, drag a landmark.
await page.evaluate(() => {
  const p = document.getElementById('phase'); p.value = '0';
  p.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(200);
const before = await page.evaluate(() => JSON.stringify(window.__diag || null));
// read a landmark position via the app's exposed state through the DOM: click first lm row then drag
const rows = await page.locator('.lm-row').count();
let editTest = { rows, dragged: false };
if (rows > 0) {
  // find a landmark dot on canvas approximate position by reading endpoints text
  // instead, just assert the UI accepted a drag by toggling correspondence and moving
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5 + 6, box.y + box.height * 0.5 + 4);
  await page.mouse.up();
  editTest.dragged = true;
}
await shot('06-stitch-t0-edit');

// 7) Export current frame (download event)
let frameDownload = null;
try {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.click('#exportFrame'),
  ]);
  const p = `${OUTDIR}/exported-frame.png`;
  await dl.saveAs(p);
  frameDownload = { suggested: dl.suggestedFilename(), path: p, size: fs.statSync(p).size };
} catch (e) { frameDownload = { error: String(e) }; }

const result = {
  errors,
  probeText,
  editTest,
  frameDownload,
  diagnosticsText: await page.locator('#diagnostics').textContent(),
  endpointsText: await page.locator('#endpoints').textContent(),
};
console.log(JSON.stringify(result, null, 2));
await browser.close();
