// The hosted demo, opened in a plain Chrome with no extension installed: the
// in-page preview must hold, reject and forward requests the same way.
//   node test/site.mjs
import assert from 'node:assert/strict';
import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(process.env.GUARDIAN_SITE_OUT || 'dist/site');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://x').pathname);
  let file = path.join(ROOT, pathname);
  if (!file.startsWith(ROOT)) {
    response.writeHead(403).end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!existsSync(file)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({ headless: true, pipe: true });
const page = await browser.newPage();
const external = [];
page.on('request', (request) => {
  if (!request.url().startsWith(origin) && !request.url().startsWith('data:')) external.push(request.url());
});
await page.goto(`${origin}/?mock=1`, { waitUntil: 'load' });

// Waits are a plain check loop. Puppeteer's own waitForFunction sometimes
// never fires inside a freshly navigated iframe, although the page is fine.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(target, fn, ...args) {
  const end = Date.now() + 15000;
  let last;
  while (Date.now() < end) {
    try {
      last = await Promise.race([target.evaluate(fn, ...args), sleep(2000).then(() => 'evaluate hung')]);
      if (last === true) return;
    } catch (error) {
      last = String(error.message).split('\n')[0];
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${String(fn).slice(0, 80)} (last: ${String(last)})`);
}

let failed = false;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed = true;
    console.log(`FAIL ${name}\n     ${String(error && error.message).split('\n')[0]}`);
    if (process.env.DEBUG) {
      console.log(
        await page.evaluate(() =>
          JSON.stringify({
            url: location.search,
            history: window.__dapp.history,
            log: window.__mockWalletLog.length,
            panel: Boolean(document.getElementById('ibiti-guardian-preview')),
            lines: Array.from(document.querySelectorAll('#log .line'), (l) => l.textContent),
          }),
        ),
      );
    }
  }
};

/** Clicks a scenario and returns the review frame once it has rendered. */
const seen = new Set();
const openReview = async (selector) => {
  // The frame object for the review page itself, not the blank frame the
  // iframe starts with.
  const next = page.waitForFrame((f) => !seen.has(f) && !f.detached && f.url().includes('/guardian/review.html'));
  await page.click(selector);
  const frame = await next;
  seen.add(frame);
  // Rendered, styled and done sliding in, so a click lands where it is aimed.
  await until(
    frame,
    () =>
      Boolean(document.getElementById('badge')?.textContent) && getComputedStyle(document.body).display === 'flex',
  );
  await sleep(300);
  return frame;
};
const walletLog = () => page.evaluate(() => window.__mockWalletLog);
const panelGone = () => until(page, () => !document.getElementById('ibiti-guardian-preview'));

await step('the preview starts by itself when no extension is installed', async () => {
  assert.equal(await page.evaluate(() => window.__ibitiGuardianPreview), true);
  assert.equal(await page.evaluate(() => document.getElementById('guard').dataset.state), 'on');
});

await step('a dangerous approve is held and described before the wallet sees it', async () => {
  const frame = await openReview('#claim');
  assert.equal(await frame.evaluate(() => document.getElementById('badge').textContent), 'High risk');
  assert.equal(await frame.evaluate(() => document.body.dataset.host), 'preview');
  assert.match(await frame.evaluate(() => document.getElementById('headline').textContent), /unlimited/i);
  assert.equal((await walletLog()).length, 0, 'held');
  await frame.click('#reject');
  await panelGone();
  await until(page, () => window.__dapp.history.length === 1);
  assert.equal(await page.evaluate(() => window.__dapp.last.code), 4001);
  assert.equal((await walletLog()).length, 0, 'reject kept it from the wallet');
});

await step('Continue forwards the request to the wallet unchanged', async () => {
  const frame = await openReview('#claim');
  await frame.click('#allow');
  await panelGone();
  await until(page, () => window.__dapp.history.length === 2);
  const log = await walletLog();
  assert.equal(log.length, 1);
  assert.deepEqual(log[0], await page.evaluate(() => window.__dapp.sent));
});

await step('closing the panel counts as Reject', async () => {
  await openReview('[data-scenario="permit"]');
  await page.evaluate(() =>
    document.getElementById('ibiti-guardian-preview').shadowRoot.querySelector('.bar button').click(),
  );
  await panelGone();
  await until(page, () => window.__dapp.history.length === 3);
  assert.equal(await page.evaluate(() => window.__dapp.last.code), 4001);
  assert.equal((await walletLog()).length, 1);
});

await step('a safe request is shown as safe', async () => {
  const frame = await openReview('[data-scenario="revoke"]');
  assert.equal(await frame.evaluate(() => document.getElementById('badge').textContent), 'No red flags found');
  await frame.click('#allow');
  await panelGone();
  assert.equal((await walletLog()).length, 2);
});

await step('a plain visit uses the demo wallet and is guarded', async () => {
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  assert.equal(await page.evaluate(() => window.__dapp.wallet), 'dev.ibiti.demo-wallet');
  const frame = await openReview('#claim');
  assert.equal((await walletLog()).length, 0, 'held');
  await frame.click('#reject');
  await panelGone();
  await until(page, () => window.__dapp.history.length === 1);
  assert.equal((await walletLog()).length, 0);
});

await step('with Guardian switched off, the same request goes straight to the wallet', async () => {
  await page.click('#guard-toggle');
  await until(page, () => location.search.includes('guardian=off') && Boolean(window.__dapp));
  assert.equal(await page.evaluate(() => document.getElementById('guard').dataset.state), 'off');
  await page.click('#claim');
  await until(page, () => window.__dapp.history.length === 1);
  assert.equal(await page.evaluate(() => window.__dapp.last.ok), true);
  assert.equal((await walletLog()).length, 1, 'nothing held it');
  assert.equal(await page.evaluate(() => Boolean(document.getElementById('ibiti-guardian-preview'))), false);
});

await step('nothing was sent to any other server', async () => {
  assert.deepEqual(external, []);
});

await browser.close();
server.close();
console.log(failed ? '\nSome checks failed.' : '\nAll checks passed.');
process.exitCode = failed ? 1 : 0;
