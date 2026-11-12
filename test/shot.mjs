// Saves a screenshot of the review window for one demo scenario.
//   node test/shot.mjs <scenario> <output.png>
import path from 'node:path';
import puppeteer from 'puppeteer';

const [scenario = 'claim', output = 'review.png'] = process.argv.slice(2);
const EXT = path.resolve('dist/extension');
const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [EXT] });
await browser.waitForTarget((t) => t.type() === 'service_worker');
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5179/demo/index.html?mock=1', { waitUntil: 'load' });
await page.waitForFunction(() => Array.isArray(window.__mockWalletLog));
const before = new Set(browser.targets());
await page.click(`[data-scenario="${scenario}"]`);
const target = await browser.waitForTarget((t) => !before.has(t) && t.url().includes('/review.html'));
const review = await target.asPage();
await review.setViewport({ width: 420, height: 680, deviceScaleFactor: 2 });
await review.waitForFunction(() => document.getElementById('badge').textContent !== '');
if (process.argv.includes('--cloud')) {
  await review.click('#cloud-ask');
  await review.waitForFunction(() => ['done', 'error'].includes(document.body.dataset.cloud), { timeout: 40000 });
  await review.setViewport({ width: 420, height: 1180, deviceScaleFactor: 2 });
}
await review.screenshot({ path: output });
await browser.close();
