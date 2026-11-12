// A hostile page must not get past the review by changing the request after
// the fact, by hiding the method behind a getter, or by batching.
//   node test/tamper.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';

const EXT = path.resolve(process.env.GUARDIAN_OUT || 'dist/extension');
const DEMO = 'http://127.0.0.1:5179/demo/index.html?mock=1';
const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [EXT] });
await browser.waitForTarget((t) => t.type() === 'service_worker');
const page = await browser.newPage();
await page.goto(DEMO, { waitUntil: 'load' });
await page.waitForFunction(() => Array.isArray(window.__mockWalletLog));

let failed = false;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed = true;
    console.log(`FAIL ${name}\n     ${String(error && error.message).split('\n')[0]}`);
  }
};

const nextReview = async (trigger) => {
  const before = new Set(browser.targets());
  await trigger();
  const target = await browser.waitForTarget((t) => !before.has(t) && t.url().includes('/review.html'), { timeout: 8000 });
  const review = await target.asPage();
  await review.waitForFunction(() => document.getElementById('badge').textContent !== '');
  return review;
};
const walletLog = () => page.evaluate(() => window.__mockWalletLog);

const SAFE = '0x' + '11'.repeat(20);
const ATTACKER = '0x' + '66'.repeat(20);
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const approve = (spender) => `0x095ea7b3${spender.slice(2).padStart(64, '0')}${'0'.repeat(63)}1`;

await step('changing the request while the review is open changes nothing', async () => {
  const review = await nextReview(() =>
    page.evaluate(
      (usdt, data) => {
        const args = { method: 'eth_sendTransaction', params: [{ from: '0x' + '11'.repeat(20), to: usdt, data }] };
        window.__tamper = { args, done: null };
        window.ethereum.request(args).then(
          (result) => (window.__tamper.done = { ok: true, result }),
          (error) => (window.__tamper.done = { ok: false, code: error.code }),
        );
      },
      USDT,
      approve(SAFE),
    ),
  );
  // The page swaps in the attacker while the user is reading.
  await page.evaluate(
    (data, attacker) => {
      window.__tamper.args.params[0].data = data;
      window.__tamper.args.params[0].to = attacker;
      window.__tamper.args.method = 'eth_sign';
    },
    approve(ATTACKER),
    ATTACKER,
  );
  await review.click('#allow');
  await page.waitForFunction(() => window.__tamper.done !== null);
  const log = await walletLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].method, 'eth_sendTransaction');
  assert.equal(log[0].params[0].to, USDT, 'the wallet got the reviewed recipient');
  assert.equal(log[0].params[0].data, approve(SAFE), 'the wallet got the reviewed calldata');
});

await step('a method hidden behind a getter cannot skip the review', async () => {
  const before = (await walletLog()).length;
  const result = await page.evaluate(async () => {
    let reads = 0;
    const args = {
      get method() {
        reads += 1;
        return reads === 1 ? 'eth_chainId' : 'eth_sendTransaction';
      },
      params: [{ from: '0x' + '11'.repeat(20), to: '0x' + '66'.repeat(20), value: '0x1' }],
    };
    try {
      return { ok: true, value: await window.ethereum.request(args) };
    } catch (error) {
      return { ok: false, message: String(error.message) };
    }
  });
  // Guardian read the method once: the wallet answers that same harmless call.
  assert.deepEqual(result, { ok: true, value: '0x1' });
  assert.equal((await walletLog()).length, before, 'no transaction reached the wallet');
});

await step('a request that is not plain data is refused', async () => {
  const before = (await walletLog()).length;
  const result = await page.evaluate(async () => {
    const args = { method: 'eth_sendTransaction', params: [] };
    args.params.push(args); // circular
    try {
      await window.ethereum.request(args);
      return 'passed';
    } catch (error) {
      return error.code;
    }
  });
  assert.equal(result, -32600);
  assert.equal((await walletLog()).length, before);
});

await step('a batch that carries a transaction is refused', async () => {
  const before = (await walletLog()).length;
  const result = await page.evaluate(
    () =>
      new Promise((resolve) => {
        window.ethereum.sendAsync(
          [{ id: 1, jsonrpc: '2.0', method: 'eth_sendTransaction', params: [{ to: '0x' + '66'.repeat(20), value: '0x1' }] }],
          (error) => resolve(error ? error.code : 'passed'),
        );
      }),
  );
  assert.equal(result, 4001);
  assert.equal((await walletLog()).length, before);
});

await step('legacy sendAsync is held and forwarded like request()', async () => {
  const before = (await walletLog()).length;
  const review = await nextReview(() =>
    page.evaluate(
      (usdt, data) => {
        window.__legacy = null;
        window.ethereum.sendAsync(
          { id: 7, jsonrpc: '2.0', method: 'eth_sendTransaction', params: [{ from: '0x' + '11'.repeat(20), to: usdt, data }] },
          (error, response) => (window.__legacy = { error: error ? error.code : null, id: response && response.id }),
        );
      },
      USDT,
      approve(SAFE),
    ),
  );
  assert.equal((await walletLog()).length, before, 'held');
  await review.click('#allow');
  await page.waitForFunction(() => window.__legacy !== null);
  assert.deepEqual(await page.evaluate(() => window.__legacy), { error: null, id: 7 });
  assert.equal((await walletLog()).length, before + 1);
});

await browser.close();
console.log(failed ? '\nSome checks failed.' : '\nAll checks passed.');
process.exitCode = failed ? 1 : 0;
