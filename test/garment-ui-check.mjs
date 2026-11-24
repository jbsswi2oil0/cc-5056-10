// Headless browser check for the two garment practice projects.
// Verifies: branch switching, the draggable occlusion handoff, sampling mesh,
// cuff identity tracks, and protection-gap rendering. Screenshots into
// out/ui/ for visual review.
import { chromium } from 'playwright';
import fs from 'node:fs';

const URL = 'http://localhost:8787/';
const OUTDIR = 'out/ui';
fs.mkdirSync(OUTDIR, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/home/node/.cache/ms-playwright/chromium-1148/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => {
  const c = document.getElementById('canvas');
  return c && c.width > 0;
}, { timeout: 15000 });

async function shot(name) { await page.screenshot({ path: `${OUTDIR}/${name}.png` }); }
async function setScene(name) {
  await page.selectOption('#sceneSelect', name);
  await page.waitForTimeout(500);
}
async function setT(t) {
  await page.evaluate((v) => {
    const p = document.getElementById('phase'); p.value = String(v);
    p.dispatchEvent(new Event('input', { bubbles: true }));
  }, t);
  await page.waitForTimeout(200);
}
async function diag() {
  return page.locator('#diagnostics').textContent();
}

// 1) flapfront branch at a held-out-like mid phase, mesh + tracks on
await setScene('flapfront');
await setT(0.37);
await page.check('#showMesh');
await page.check('#showTracks');
const handoffRowVisible = await page.locator('#handoffRow').isVisible();
const flapDiag = await diag();
await shot('11-flapfront-mesh-tracks');

// 2) armfront branch, same geometry, different visible domain
await setScene('armfront');
await setT(0.63);
const armDiag = await diag();
await shot('12-armfront-mesh-tracks');

// 3) drag the occlusion handoff slider and confirm the engine rebuilds
const handoffTextBefore = await page.locator('#handoffVal').textContent();
await page.evaluate(() => {
  const h = document.getElementById('handoff'); h.value = '0.35';
  h.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(300);
const handoffTextAfter = await page.locator('#handoffVal').textContent();
const branchText = await page.locator('#handoffBranch').textContent();
await shot('13-armfront-handoff-035');

// 4) drag the on-image handoff handle with the mouse
const box = await page.locator('#canvas').boundingBox();
const handleInfo = await page.evaluate(() => {
  const eng = window.__editor && window.__editor.getState ? window.__editor.getState() : null;
  return eng;
});
// grab near the top of the dashed handoff marker and move horizontally
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.42);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.42, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(250);
const handoffTextDragged = await page.locator('#handoffVal').textContent();
await shot('14-armfront-handoff-dragged');

// 5) gaps toggle exists and renders without errors; healthy scene shows 0 gaps
const gapToggle = await page.locator('#showGaps').isVisible();
const gapLine = await diag();

const result = {
  errors,
  handoffRowVisible,
  handoffTextBefore,
  handoffTextAfter,
  branchText,
  handoffTextDragged,
  gapToggle,
  flapDiagHasNoGaps: /protection gaps\s*0/.test(flapDiag),
  armDiagHasNoGaps: /protection gaps\s*0/.test(armDiag),
  gapLine,
  engineReady: handleInfo?.engineReady,
};
console.log(JSON.stringify(result, null, 2));
await browser.close();
if (errors.length) process.exit(1);
