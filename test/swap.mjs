// A wallet that replaces its own request() after start-up must stay guarded.
//   node test/swap.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';

const EXT = path.resolve(process.env.GUARDIAN_OUT || 'dist/extension');
const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [EXT] });
await browser.waitForTarget((t) => t.type() === 'service_worker');
let failed = false;

for (const mode of ['assign', 'define', 'rebind']) {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:5179/demo/index.html?mock=1&swap=${mode}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__mockWalletSwapDone === true);
  await new Promise((resolve) => setTimeout(resolve, 1300)); // one re-check interval
  try {
    // Read-only calls still work, with no endless loop.
    const chainId = await page.evaluate(() => window.ethereum.request({ method: 'eth_chainId' }));
    assert.equal(chainId, '0x1');

    const before = new Set(browser.targets());
    await page.click('#claim');
    const target = await browser.waitForTarget((t) => !before.has(t) && t.url().includes('/review.html'), { timeout: 8000 });
    const review = await target.asPage();
    await review.waitForFunction(() => document.getElementById('badge').textContent !== '');
    assert.equal(await page.evaluate(() => window.__mockWalletLog.length), 0, 'held after the swap');
    await review.click('#reject');
    await page.waitForFunction(() => window.__dapp.history.length === 1);
    const last = await page.evaluate(() => window.__dapp.last);
    assert.equal(last.code, 4001);
    assert.equal(await page.evaluate(() => window.__mockWalletLog.length), 0, 'reject kept it from the wallet');

    // Allowed requests reach the wallet exactly once.
    const before2 = new Set(browser.targets());
    await page.click('#claim');
    const target2 = await browser.waitForTarget((t) => !before2.has(t) && t.url().includes('/review.html'), { timeout: 8000 });
    const review2 = await target2.asPage();
    await review2.waitForFunction(() => document.getElementById('badge').textContent !== '');
    await review2.click('#allow');
    await page.waitForFunction(() => window.__dapp.history.length === 2);
    assert.equal(await page.evaluate(() => window.__mockWalletLog.length), 1, 'allowed request delivered once');
    console.log(`ok   wallet replaces request() by "${mode}": still guarded`);
  } catch (error) {
    failed = true;
    console.log(`FAIL wallet replaces request() by "${mode}"\n     ${String(error && error.message).split('\n')[0]}`);
  }
  await page.close();
}

await browser.close();
console.log(failed ? '\nSome checks failed.' : '\nAll checks passed.');
process.exitCode = failed ? 1 : 0;
