// The hosted demo, opened in a plain Chrome with no extension installed (a
// fresh profile, like a private window): the in-page preview must hold,
// reject and forward requests the same way the extension does.
//
//   node test/site.mjs                          the local build in dist/site
//   SITE_URL=https://… node test/site.mjs       the published site
//   PHONE=1                                     phone-sized screen
//   SHOTS=dir                                   save a screenshot of every review
import assert from 'node:assert/strict';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(process.env.GUARDIAN_SITE_OUT || 'dist/site');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const PHONE = process.env.PHONE === '1';
const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null;
if (SHOTS) await mkdir(SHOTS, { recursive: true });

let server = null;
let origin = process.env.SITE_URL ? new URL(process.env.SITE_URL).origin : null;
if (!origin) {
  server = http.createServer((request, response) => {
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
  origin = `http://127.0.0.1:${server.address().port}`;
}
const host = new URL(origin).host;
console.log(`Site: ${origin}${PHONE ? ' (phone screen)' : ''}`);

const browser = await puppeteer.launch({ headless: true, pipe: true });
const page = await browser.newPage();
if (PHONE) await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
else await page.setViewport({ width: 1280, height: 860 });

const external = [];
const errors = [];
page.on('request', (request) => {
  const url = request.url();
  if (!url.startsWith(origin) && !url.startsWith('data:')) external.push(url);
});
page.on('pageerror', (error) => errors.push(`page error: ${error.message}`));
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  // Chrome's own notes about Built-in AI being off in this test browser.
  if (/On-device AI|feature flag gating model execution|Built-In AI/i.test(text)) return;
  errors.push(`console: ${text}`);
});
page.on('response', (response) => {
  if (response.url().startsWith(origin) && response.status() >= 400) {
    errors.push(`HTTP ${response.status()} ${response.url()}`);
  }
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
        await page
          .evaluate(() =>
            JSON.stringify({
              url: location.search,
              history: window.__dapp.history,
              log: window.__mockWalletLog.length,
              panel: Boolean(document.getElementById('ibiti-guardian-preview')),
              lines: Array.from(document.querySelectorAll('#log .line'), (l) => l.textContent),
            }),
          )
          .catch((e) => e.message),
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
const historyLength = () => page.evaluate(() => window.__dapp.history.length);

await step('the preview starts by itself when no extension is installed', async () => {
  assert.equal(await page.evaluate(() => window.__ibitiGuardianPreview), true);
  assert.equal(await page.evaluate(() => document.getElementById('guard').dataset.state), 'on');
});

await step('the page says it is a simulation and offers no real wallet', async () => {
  const state = await page.evaluate(() => ({
    isPublic: window.__dapp.public,
    sim: document.getElementById('sim').innerText,
    walletSection: document.getElementById('wallet-section').hidden,
    wallet: window.__dapp.wallet,
  }));
  assert.equal(state.isPublic, true, 'built as the public playground');
  assert.match(state.sim, /^Simulation\./);
  assert.match(state.sim, /no keys, no funds/);
  assert.equal(state.walletSection, true, 'no wallet picker or connect button');
  assert.equal(state.wallet, 'dev.ibiti.demo-wallet');
});

await step('a dangerous approve is held and described before the wallet sees it', async () => {
  const frame = await openReview('#claim');
  assert.equal(await frame.evaluate(() => document.getElementById('badge').textContent), 'High risk');
  assert.equal(await frame.evaluate(() => document.body.dataset.host), 'preview');
  assert.equal(await frame.evaluate(() => document.getElementById('origin').textContent), host, 'shows the real site');
  assert.match(await frame.evaluate(() => document.getElementById('headline').textContent), /unlimited/i);
  assert.equal((await walletLog()).length, 0, 'held');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${PHONE ? 'phone' : 'desktop'}-claim.png`) });
  await frame.click('#reject');
  await panelGone();
  await until(page, () => window.__dapp.history.length === 1);
  assert.equal(await page.evaluate(() => window.__dapp.last.code), 4001);
  assert.equal((await walletLog()).length, 0, 'reject kept it from the wallet');
  assert.match(await page.evaluate(() => document.querySelector('#log .line').textContent), /stopped by Guardian/);
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

// Every scenario: the right risk, a plain headline, facts and reasons, and
// nothing reaches the wallet on Reject.
const expectations = {
  permit: { risk: 'High risk', headline: 'Unlimited spending permission for USDC' },
  nft: { risk: 'High risk', headline: 'Access to all your items in a collection' },
  blind: { risk: 'High risk', headline: 'Blind signature request' },
  fake: { risk: 'High risk', headline: 'Spending permission for 1 USDT' },
  phish: { risk: 'High risk', headline: 'Sign-in request for a different site' },
  transfer: { risk: 'No red flags found', headline: 'Send 0.01 ETH' },
  limited: { risk: 'No red flags found', headline: 'Spending permission for 25 USDC' },
  signin: { risk: 'No red flags found', headline: `Sign in to ${host}` },
  revoke: { risk: 'No red flags found', headline: 'Remove a spending permission for USDT' },
};
for (const [scenario, expected] of Object.entries(expectations)) {
  await step(`scenario "${scenario}": ${expected.risk.toLowerCase()}, "${expected.headline}"`, async () => {
    const before = await historyLength();
    const wallet = (await walletLog()).length;
    const frame = await openReview(`[data-scenario="${scenario}"]`);
    const shown = await frame.evaluate(() => ({
      badge: document.getElementById('badge').textContent,
      headline: document.getElementById('headline').textContent,
      facts: document.querySelectorAll('#facts .fact').length,
      reasons: document.getElementById('why').hidden ? 0 : document.querySelectorAll('#reasons li').length,
      overflow: document.documentElement.scrollWidth - innerWidth,
    }));
    assert.equal(shown.badge, expected.risk);
    assert.equal(shown.headline, expected.headline);
    assert.ok(shown.facts >= 2, `facts shown: ${shown.facts}`);
    if (expected.risk === 'High risk') assert.ok(shown.reasons >= 1, 'a dangerous request says why');
    assert.ok(shown.overflow <= 0, `review window scrolls sideways by ${shown.overflow}px`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${PHONE ? 'phone' : 'desktop'}-${scenario}.png`) });
    await frame.click('#reject');
    await panelGone();
    await until(page, (n) => window.__dapp.history.length === n, before + 1);
    assert.equal(await page.evaluate(() => window.__dapp.last.code), 4001);
    assert.equal((await walletLog()).length, wallet, 'nothing reached the wallet');
  });
}

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
  assert.match(await page.evaluate(() => document.querySelector('#log .line').textContent), /with nothing in between/);
});

await step('the page itself does not scroll sideways', async () => {
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
});

await step('no errors in the page and no broken links to files', async () => {
  assert.deepEqual(errors, []);
});

await step('nothing was sent to any other server', async () => {
  assert.deepEqual(external, []);
});

// The App Check debug token must not be anywhere in what the site serves.
const configFile = path.resolve('src/config.js');
if (existsSync(configFile)) {
  await step('the published files hold no App Check debug token', async () => {
    const { appCheckDebugToken } = await import(pathToFileURL(configFile).href);
    if (!appCheckDebugToken) return;
    for (const file of ['', 'dapp.js', 'mock-wallet.js', 'guardian/inpage.js', 'guardian/panel.js', 'guardian/review.js', 'guardian/review.html']) {
      const response = await fetch(`${origin}/${file}`);
      assert.equal(response.status, 200, `${file || 'index.html'} is served`);
      const text = await response.text();
      assert.ok(!text.includes(appCheckDebugToken), `debug token found in ${file || 'index.html'}`);
    }
  });
}

await browser.close();
if (server) server.close();
console.log(failed ? '\nSome checks failed.' : '\nAll checks passed.');
process.exitCode = failed ? 1 : 0;
