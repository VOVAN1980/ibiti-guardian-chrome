// End-to-end check in a real Chrome with the unpacked extension loaded:
// a held request must not reach the wallet until the user allows it.
//
//   npm run build && node test/e2e.mjs      (demo served at 127.0.0.1:5179)

import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';

const EXT = path.resolve(process.env.GUARDIAN_OUT || 'dist/extension');
const DEMO = process.env.DEMO_URL || 'http://127.0.0.1:5179/demo/index.html?mock=1';

const browser = await puppeteer.launch({
  headless: true,
  pipe: true,
  enableExtensions: [EXT],
});

const results = [];
const step = async (name, fn) => {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}\n     ${String(error && error.message).split('\n')[0]}`);
    process.exitCode = 1;
  }
};

// The extension is installed right after launch: wait for it before loading
// the page, or the page loads without Guardian's content scripts.
await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'));
const page = await browser.newPage();
await page.goto(DEMO, { waitUntil: 'load' });
await page.waitForFunction(() => Array.isArray(window.__mockWalletLog));
assert.equal(await page.evaluate(() => window.__ibitiGuardian === true), true, 'Guardian is active on the page');

const walletLog = () => page.evaluate(() => window.__mockWalletLog.length);
const dappHistory = () => page.evaluate(() => window.__dapp.history.length);
const dappLast = () => page.evaluate(() => window.__dapp.last);

async function openReview(scenario) {
  const before = new Set(browser.targets());
  await page.click(`[data-scenario="${scenario}"]`);
  const target = await browser.waitForTarget(
    (t) => !before.has(t) && t.url().includes('/review.html'),
    { timeout: 10000 },
  );
  const review = await target.asPage();
  await review.waitForFunction(() => document.getElementById('badge').textContent !== '');
  const view = await review.evaluate(() => ({
    risk: document.body.dataset.risk,
    headline: document.getElementById('headline').textContent,
    origin: document.getElementById('origin').textContent,
    facts: Object.fromEntries(
      [...document.querySelectorAll('.fact')].map((row) => {
        const dd = row.querySelector('dd');
        const address = dd.querySelector('.address');
        return [row.querySelector('dt').textContent, address ? address.dataset.full : dd.childNodes[0].textContent];
      }),
    ),
    reasons: [...document.querySelectorAll('#reasons li')].map((li) => li.textContent),
  }));
  return { review, view };
}

async function waitForHistory(length) {
  await page.waitForFunction((n) => window.__dapp.history.length >= n, { timeout: 10000 }, length);
}

await step('read-only calls pass straight through', async () => {
  const chainId = await page.evaluate(() => window.ethereum.request({ method: 'eth_chainId' }));
  assert.equal(chainId, '0x1');
});

await step('a dangerous approve is held and described before the wallet sees it', async () => {
  const { review, view } = await openReview('claim');
  assert.equal(view.risk, 'danger');
  assert.equal(view.headline, 'Unlimited spending permission for USDT');
  assert.equal(view.origin, '127.0.0.1:5179');
  assert.equal(view.facts.Amount, 'Unlimited');
  assert.equal(view.facts.Token, 'USDT (Tether USD)');
  assert.ok(view.reasons.some((r) => /personal wallet/.test(r)), 'spender flagged as a personal wallet');
  assert.equal(await walletLog(), 0, 'wallet must not have the request yet');
  assert.equal(await dappHistory(), 0, 'the site is still waiting');

  await review.click('#reject');
  await waitForHistory(1);
  const last = await dappLast();
  assert.equal(last.ok, false);
  assert.equal(last.code, 4001);
  assert.equal(await walletLog(), 0, 'Reject must keep the request away from the wallet');
});

await step('Continue forwards the request to the wallet unchanged', async () => {
  const { review } = await openReview('claim');
  assert.equal(await walletLog(), 0);
  await review.click('#allow');
  await waitForHistory(2);
  const last = await dappLast();
  assert.equal(last.ok, true);
  assert.equal(await walletLog(), 1);
  const { sent, received } = await page.evaluate(() => ({
    sent: window.__dapp.sent,
    received: window.__mockWalletLog[0],
  }));
  // Same method, same recipient, same amount, same calldata: byte for byte.
  assert.deepEqual(received, sent);
});

await step('closing the review window counts as Reject', async () => {
  const { review } = await openReview('claim');
  await review.close();
  await waitForHistory(3);
  const last = await dappLast();
  assert.equal(last.ok, false);
  assert.equal(last.code, 4001);
  assert.equal(await walletLog(), 1);
});

const expectations = {
  permit: { risk: 'danger', headline: 'Unlimited spending permission for USDC' },
  nft: { risk: 'danger', headline: 'Access to all your items in a collection' },
  blind: { risk: 'danger', headline: 'Blind signature request' },
  fake: { risk: 'danger', headline: 'Spending permission for 1 USDT' },
  phish: { risk: 'danger', headline: 'Sign-in request for a different site' },
  transfer: { risk: 'info', headline: 'Send 0.01 ETH' },
  limited: { risk: 'info', headline: 'Spending permission for 25 USDC' },
  signin: { risk: 'info', headline: 'Sign in to 127.0.0.1:5179' },
  revoke: { risk: 'info', headline: 'Remove a spending permission for USDT' },
};

let expectedHistory = 3;
for (const [scenario, expected] of Object.entries(expectations)) {
  await step(`scenario "${scenario}" is read correctly`, async () => {
    const { review, view } = await openReview(scenario);
    try {
      assert.equal(view.headline, expected.headline);
      assert.equal(view.risk, expected.risk);
    } finally {
      await review.click('#reject');
      expectedHistory += 1;
      await waitForHistory(expectedHistory);
    }
  });
}

await step('nothing slipped through while requests were rejected', async () => {
  assert.equal(await walletLog(), 1);
});

await step('cloud analysis runs only after the user asks for it', async () => {
  const before = new Set(browser.targets());
  await page.click('[data-scenario="claim"]');
  const target = await browser.waitForTarget((t) => !before.has(t) && t.url().includes('/review.html'));
  const review = await target.asPage();
  const calls = [];
  review.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('chrome-extension://')) calls.push(url);
  });
  try {
    await review.waitForFunction(() => document.getElementById('badge').textContent !== '');
    await review.waitForFunction(() => document.body.dataset.local !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.deepEqual(calls, [], 'no network request before the user asks for the cloud');

    // This test browser has no on-device model. Guardian must still show the
    // facts and keep holding the request: no AI never means "let it through".
    const noAi = await review.evaluate(() => ({
      local: document.body.dataset.local,
      headline: document.getElementById('headline').textContent,
      facts: document.querySelectorAll('.fact').length,
    }));
    assert.equal(noAi.local, 'unavailable');
    assert.equal(noAi.headline, 'Unlimited spending permission for USDT');
    assert.ok(noAi.facts >= 4);
    assert.equal(await dappHistory(), expectedHistory, 'still held without AI');
    assert.equal(await walletLog(), 1, 'nothing reached the wallet without a decision');

    await review.click('#cloud-ask');
    await review.waitForFunction(() => ['done', 'error'].includes(document.body.dataset.cloud), { timeout: 40000 });
    const cloudError = await review.evaluate(() => document.body.dataset.cloudError || '');
    if (/free tier is not available|billing/i.test(cloudError)) {
      // The Firebase project has no paid tier: the request was made (after
      // consent) and Google refused it. Not a Guardian failure.
      assert.ok(calls.some((url) => url.includes('googleapis.com')));
      console.log('     cloud: SKIPPED, the Firebase project has no Gemini API billing yet');
      return;
    }
    const cloud = await review.evaluate(() => ({
      state: document.body.dataset.cloud,
      chip: document.getElementById('cloud-chip').textContent,
      summary: document.getElementById('cloud-summary').textContent,
      checks: document.querySelectorAll('#cloud-checks li').length,
    }));
    assert.equal(cloud.state, 'done');
    assert.match(cloud.chip, /^Cloud · \d/);
    assert.ok(cloud.summary.length > 20, 'cloud summary is present');
    assert.ok(cloud.checks >= 1, 'cloud analysis lists things to check');
    assert.ok(calls.some((url) => url.includes('googleapis.com')), 'the cloud call went through Firebase');
    console.log(`     cloud: ${cloud.chip} | ${cloud.summary}`);
  } finally {
    await review.click('#reject');
    expectedHistory += 1;
    await waitForHistory(expectedHistory);
  }
});

// Opens a scenario's review window and records every request it makes outside
// the extension.
async function reviewWithCalls(scenario) {
  const before = new Set(browser.targets());
  await page.click(`[data-scenario="${scenario}"]`);
  const target = await browser.waitForTarget((t) => !before.has(t) && t.url().includes('/review.html'));
  const review = await target.asPage();
  const calls = [];
  const bodies = [];
  review.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('chrome-extension://')) return;
    calls.push(url);
    if (/generatecontent/i.test(url)) bodies.push(request.postData() || '');
  });
  await review.waitForFunction(() => document.getElementById('badge').textContent !== '');
  return { review, calls, bodies };
}

/** The prompt text inside a Gemini request body. */
const promptOf = (body) => {
  try {
    return JSON.parse(body).contents[0].parts[0].text;
  } catch {
    return '';
  }
};

async function rejectAndWait(review) {
  await review.click('#reject');
  expectedHistory += 1;
  await waitForHistory(expectedHistory);
}

await step('hybrid: once allowed, a computer without Gemini Nano gets the explanation from the cloud by itself', async () => {
  // Before the user allows it: offered, with the exact text that would be sent.
  const first = await reviewWithCalls('claim');
  try {
    await first.review.waitForFunction(() => document.body.dataset.local !== undefined);
    const offer = await first.review.evaluate(() => ({
      local: document.body.dataset.local,
      fallback: document.body.dataset.fallback,
      shown: !document.getElementById('local-fallback').hidden,
      sent: document.getElementById('local-sent').textContent,
    }));
    if (offer.fallback === undefined || !offer.shown) {
      assert.equal(await first.review.evaluate(() => document.body.dataset.cloud), 'off');
      console.log('     hybrid: SKIPPED, cloud is not set up in this build');
      return;
    }
    assert.equal(offer.local, 'unavailable');
    assert.equal(offer.fallback, 'off');
    assert.match(offer.sent, /Unlimited spending permission for USDT/);
    const user = await page.evaluate(() => window.ethereum.request({ method: 'eth_accounts' }));
    assert.ok(user.length > 0 && !offer.sent.toLowerCase().includes(user[0].toLowerCase()), 'the user’s address is not in it');
    assert.deepEqual(first.calls, [], 'nothing is sent before the user allows it');

    await first.review.click('#local-fallback-allow');
    await first.review.waitForFunction(() => ['done', 'error'].includes(document.body.dataset.local), { timeout: 40000 });
    const out = await first.review.evaluate(() => ({
      local: document.body.dataset.local,
      source: document.body.dataset.source,
      chip: document.getElementById('local-chip').textContent,
      text: document.getElementById('local-text').textContent,
      meta: document.getElementById('local-meta').textContent,
    }));
    assert.equal(out.local, 'done', 'the explanation arrived');
    assert.equal(out.source, 'in_cloud', 'the SDK fell back to the cloud');
    assert.match(out.chip, /^Cloud fallback · \d/);
    assert.ok(out.text.length > 20, 'an explanation is shown');
    assert.match(out.meta, /as you allowed/);
    assert.ok(first.calls.some((url) => url.includes('googleapis.com')), 'answered through Firebase');
    // What was shown is exactly what went out, and the window says so.
    assert.equal(first.bodies.length, 1, 'one cloud call for the explanation');
    assert.equal(promptOf(first.bodies[0]), offer.sent);
    const after = await first.review.evaluate(() => ({
      label: document.getElementById('local-sent-label').textContent,
      sent: document.getElementById('local-sent').textContent,
      shown: !document.getElementById('local-sent-box').hidden,
    }));
    assert.deepEqual(after, { label: 'Exactly what was sent', sent: offer.sent, shown: true });
    console.log(`     hybrid: ${out.chip} | ${out.text.slice(0, 90)}`);
  } finally {
    await rejectAndWait(first.review);
  }

  // The next request: no click, the explanation comes by itself.
  const second = await reviewWithCalls('permit');
  try {
    await second.review.waitForFunction(() => ['done', 'error'].includes(document.body.dataset.local), { timeout: 40000 });
    const out = await second.review.evaluate(() => ({
      local: document.body.dataset.local,
      fallback: document.body.dataset.fallback,
      offered: !document.getElementById('local-fallback').hidden,
      chip: document.getElementById('local-chip').textContent,
    }));
    assert.equal(out.fallback, 'on');
    assert.equal(out.offered, false, 'not asked again');
    assert.equal(out.local, 'done');
    assert.match(out.chip, /^Cloud fallback · \d/);
  } finally {
    await rejectAndWait(second.review);
  }
});

await step('hybrid: the toolbar panel turns the cloud fallback off again', async () => {
  const worker = browser.targets().find((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'));
  const panel = await browser.newPage();
  try {
    await panel.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`, { waitUntil: 'load' });
    await panel.waitForFunction(() => !/Checking/.test(document.getElementById('fallback-text').textContent));
    const state = await panel.evaluate(() => ({
      disabled: document.getElementById('fallback').disabled,
      checked: document.getElementById('fallback').checked,
    }));
    if (state.disabled) {
      console.log('     hybrid off: SKIPPED, cloud is not set up in this build');
      return;
    }
    assert.equal(state.checked, true, 'on, as allowed in the window');
    await panel.click('#fallback');
    await panel.waitForFunction(() => /^Off/.test(document.getElementById('fallback-text').textContent));
  } finally {
    await panel.close();
  }

  const next = await reviewWithCalls('claim');
  try {
    await next.review.waitForFunction(() => document.body.dataset.local !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const out = await next.review.evaluate(() => ({
      fallback: document.body.dataset.fallback,
      offered: !document.getElementById('local-fallback').hidden,
    }));
    assert.deepEqual(out, { fallback: 'off', offered: true });
    assert.deepEqual(next.calls, [], 'nothing is sent once it is off');
  } finally {
    await rejectAndWait(next.review);
  }
});

await step('the toolbar panel says Guardian is on, what this build can do, and opens the test page', async () => {
  const worker = browser.targets().find((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'));
  const id = new URL(worker.url()).host;
  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' });
  await panel.waitForFunction(
    () => !/Checking/.test(document.getElementById('nano').textContent) && !/Checking/.test(document.getElementById('cloud').textContent),
  );
  const text = await panel.evaluate(() => document.body.innerText);
  assert.match(text, /Guardian is watching wallet requests on every site/);
  assert.match(text, /Try it on the test page/);
  const before = new Set(browser.targets());
  await panel.click('#try');
  const opened = await browser.waitForTarget(
    (t) => !before.has(t) && t.type() === 'page' && t.url().startsWith('https://ibiti-guardian-chrome.web.app'),
    { timeout: 10000 },
  );
  await (await opened.asPage()).close();
  await panel.close().catch(() => {}); // the panel closes itself after opening the page
});

await step('if Guardian cannot be reached, the request is refused, not passed', async () => {
  // Reloading the extension cuts this page off from it, as an update or a
  // crash would. The page still has the wrapper; it must fail closed.
  const worker = await browser
    .targets()
    .find((t) => t.type() === 'service_worker')
    .worker();
  await worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const reviewsBefore = browser.targets().filter((t) => t.url().includes('/review.html')).length;
  await page.click('[data-scenario="claim"]');
  expectedHistory += 1;
  await waitForHistory(expectedHistory);
  const last = await dappLast();
  assert.equal(last.ok, false);
  assert.equal(last.code, 4001);
  assert.match(last.message, /could not review/);
  assert.equal(await walletLog(), 1, 'the wallet did not receive it');
  assert.equal(browser.targets().filter((t) => t.url().includes('/review.html')).length, reviewsBefore);
});

await browser.close();
console.log(results.join('\n'));
console.log(process.exitCode ? '\nSome checks failed.' : '\nAll checks passed.');
