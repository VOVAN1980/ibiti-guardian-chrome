// A hostile page must not get past the review by changing the request after
// the fact, by hiding the method behind a getter, or by batching; nor by
// replacing built-ins Guardian shares with it, by calling back into Guardian
// from a function it put in the wallet's place, or by reloading under an
// open review window; nor by presetting Guardian's channel or marks in its
// markup or in a page it opens, by adding keys the wallet's copy inherits,
// or by forging another Guardian's wrapper.
//   node test/tamper.mjs
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';

const EXT = path.resolve(process.env.GUARDIAN_OUT || 'dist/extension');
const DEMO = 'http://127.0.0.1:5179/demo/index.html?mock=1';

// Pages of our own, for attacks that need their own markup. The demo wallet
// is served next to them; /slow.html sends its body late, so a page that
// opens it can reach its new document before Guardian starts there.
const MOCK_WALLET = await readFile('demo/mock-wallet.js', 'utf8');
const pages = new Map();
const server = http.createServer((request, response) => {
  const { pathname } = new URL(request.url, 'http://local');
  if (pathname === '/mock-wallet.js') {
    response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
    response.end(MOCK_WALLET);
    return;
  }
  const html = pages.get(pathname);
  if (html === undefined) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  if (pathname === '/slow.html') {
    response.write(' ');
    setTimeout(() => response.end(html), 700);
  } else {
    response.end(html);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const OWN = `http://127.0.0.1:${server.address().port}`;

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
  await continueAlive(review);
  return review;
};
// Continue comes alive a moment after the window appears (test/review.mjs);
// a window whose Continue never does is left to the test to judge.
function continueAlive(review) {
  return review.waitForFunction(() => !document.getElementById('allow').disabled, { timeout: 3000 }).catch(() => {});
}
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

// ── Attacks by a page written against Guardian ─────────────────────────────
// Each one runs on a page of its own, so what it changes stays there.
const USER = SAFE;
const MAL = { method: 'eth_sendTransaction', params: [{ from: USER, to: USDT, data: `0x095ea7b3${ATTACKER.slice(2).padStart(64, '0')}${'f'.repeat(64)}` }] };
const BENIGN = { method: 'eth_sendTransaction', params: [{ from: USER, to: '0x' + '22'.repeat(20), value: '0x1' }] };

const fresh = async () => {
  const tab = await browser.newPage();
  await tab.goto(DEMO, { waitUntil: 'load' });
  await tab.waitForFunction(() => Array.isArray(window.__mockWalletLog));
  return tab;
};
const reviewTargets = () => browser.targets().filter((t) => t.url().includes('/review.html'));
const reviewAfter = async (trigger) => {
  const before = new Set(browser.targets());
  await trigger();
  const target = await browser.waitForTarget((t) => !before.has(t) && t.url().includes('/review.html'), { timeout: 8000 });
  const review = await target.asPage();
  await review.waitForFunction(() => document.getElementById('badge').textContent !== '');
  await continueAlive(review);
  return review;
};
/** What Guardian's window was given to show: the stored record. */
const recordOf = (review) =>
  review.evaluate(async () => {
    const key = `review:${new URLSearchParams(location.search).get('id')}`;
    const record = (await chrome.storage.session.get(key))[key];
    return { method: record.method, params: record.params, chainId: record.chainId, enrich: record.enrich, risk: document.body.dataset.risk };
  });
const logOf = (tab) => tab.evaluate(() => window.__mockWalletLog);
const waitOut = (tab, name = '__out') => tab.waitForFunction((n) => window[n] !== null, { polling: 100, timeout: 10000 }, name);
/** Starts a request whose outcome lands in window.__out. */
const start = (tab, args) =>
  tab.evaluate((a) => {
    window.__out = null;
    window.ethereum.request(a).then(
      (result) => (window.__out = { ok: true, result }),
      (error) => (window.__out = { ok: false, code: error.code }),
    );
  }, args);

await step('Object.prototype.toJSON cannot make the window show another request', async () => {
  for (const decision of ['reject', 'allow']) {
    const tab = await fresh();
    try {
      // Right after the call, every object with a method serializes as a harmless sign-in.
      const review = await reviewAfter(() =>
        tab.evaluate((mal, user) => {
          window.__out = null;
          window.ethereum.request(mal).then(
            (result) => (window.__out = { ok: true, result }),
            (error) => (window.__out = { ok: false, code: error.code }),
          );
          Object.defineProperty(Object.prototype, 'toJSON', {
            configurable: true,
            writable: true,
            value() {
              return Object.prototype.hasOwnProperty.call(this, 'method') ? { id: this.id, method: 'personal_sign', params: ['0x48656c6c6f', user] } : this;
            },
          });
        }, MAL, USER),
      );
      const shown = await recordOf(review);
      await tab.evaluate(() => delete Object.prototype.toJSON);
      assert.equal(shown.method, 'eth_sendTransaction', 'the window shows the real method');
      assert.deepEqual(shown.params, MAL.params, 'the window shows the real request');
      assert.equal(shown.risk, 'danger');
      await review.click(`#${decision}`);
      await waitOut(tab);
      const log = await logOf(tab);
      if (decision === 'reject') {
        assert.equal((await tab.evaluate(() => window.__out)).code, 4001);
        assert.deepEqual(log, [], 'Reject kept it from the wallet');
      } else {
        assert.equal(log.length, 1);
        assert.deepEqual(log[0], { method: shown.method, params: shown.params }, 'the wallet got exactly what was shown');
      }
    } finally {
      await tab.close();
    }
  }
});

await step('a function assigned to request() that calls back into Guardian is still reviewed', async () => {
  const tab = await fresh();
  try {
    // The page's function slips the drainer in while a harmless call runs.
    const review = await reviewAfter(() =>
      tab.evaluate((mal) => {
        const g = window.ethereum.request;
        window.__mal = null;
        window.__chain = null;
        window.ethereum.request = function (a) {
          g.call(this, mal).then(
            (result) => (window.__mal = { ok: true, result }),
            (error) => (window.__mal = { ok: false, code: error.code }),
          );
          return g.call(this, a);
        };
        window.ethereum.request({ method: 'eth_chainId' }).then((v) => (window.__chain = v));
      }, MAL),
    );
    assert.deepEqual((await recordOf(review)).params, MAL.params, 'the drainer is what the window shows');
    await review.click('#reject');
    await waitOut(tab, '__mal');
    assert.equal((await tab.evaluate(() => window.__mal)).code, 4001);
    assert.equal(await tab.evaluate(() => window.__chain), '0x1', 'the harmless call still works');
    assert.deepEqual(await logOf(tab), []);
  } finally {
    await tab.close();
  }
});

await step('a function assigned to request() cannot swap an allowed request for another', async () => {
  for (const decision of ['reject', 'allow']) {
    const tab = await fresh();
    try {
      const first = await reviewAfter(async () => {
        await tab.evaluate((mal) => {
          const g = window.ethereum.request;
          window.ethereum.request = function (a) {
            return a && a.method === 'eth_sendTransaction' ? g.call(this, mal) : g.call(this, a);
          };
        }, MAL);
        await start(tab, BENIGN);
      });
      assert.deepEqual((await recordOf(first)).params, BENIGN.params);
      // Continue on the harmless one: the drainer it is swapped for gets a window of its own.
      const second = await reviewAfter(() => first.click('#allow'));
      const shown = await recordOf(second);
      assert.deepEqual(shown.params, MAL.params);
      const windows = reviewTargets().length;
      await second.click(`#${decision}`);
      await waitOut(tab);
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (decision === 'reject') {
        assert.equal((await tab.evaluate(() => window.__out)).code, 4001);
        assert.deepEqual(await logOf(tab), [], 'nothing reached the wallet');
      } else {
        // The user saw the drainer and let it go: it reaches the wallet once, as shown.
        assert.deepEqual(await logOf(tab), [{ method: shown.method, params: shown.params }]);
      }
      assert.ok(reviewTargets().length < windows, 'no further window opened');
    } finally {
      await tab.close();
    }
  }
});

/**
 * A second wallet, announced the EIP-6963 way, whose legacy send/sendAsync go
 * straight to it (as MetaMask's do), not through its request(). It records
 * into the same log as the demo wallet.
 */
const addDirectWallet = (tab) =>
  tab.evaluate(() => {
    const log = window.__mockWalletLog;
    const answer = (method, params) => {
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_accounts') return ['0x' + '11'.repeat(20)];
      if (method === 'eth_getBalance') return '0x1bc16d674ec80000';
      if (method === 'eth_getCode' || method === 'eth_call') return '0x';
      log.push({ method, params });
      return '0xsigned';
    };
    const direct = {
      async request(args) {
        return answer(args.method, args.params);
      },
      sendAsync(payload, callback) {
        setTimeout(() => callback(null, { id: payload.id, jsonrpc: '2.0', result: answer(payload.method, payload.params) }), 0);
      },
      send(payload, callback) {
        return this.sendAsync(payload, callback);
      },
    };
    const info = { uuid: '5b6f0c0e-0000-4000-8000-000000000002', name: 'Direct', icon: 'data:,', rdns: 'test.direct' };
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider: direct }) }));
    window.__direct = direct;
  });

await step('the legacy sendAsync: a function put in its place that calls back is still reviewed', async () => {
  const tab = await fresh();
  try {
    await addDirectWallet(tab);
    const review = await reviewAfter(() =>
      tab.evaluate((mal) => {
        const wallet = window.__direct;
        const g = wallet.sendAsync;
        window.__out = null;
        wallet.sendAsync = (payload, callback) => g.call(wallet, { id: 9, jsonrpc: '2.0', ...mal }, callback);
        wallet.sendAsync({ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] }, (error) => (window.__out = { code: error ? error.code : 'passed' }));
      }, MAL),
    );
    assert.deepEqual((await recordOf(review)).params, MAL.params);
    await review.click('#reject');
    await waitOut(tab);
    assert.equal((await tab.evaluate(() => window.__out)).code, 4001);
    assert.deepEqual(await logOf(tab), []);
  } finally {
    await tab.close();
  }
});

// The page answers the context calls itself: a huge balance, the attacker
// among "your" accounts, a test network. The wallet holds 2 ETH on mainnet.
const forgeContext = `(a, real) => {
  if (a && a.method === 'eth_getBalance') return Promise.resolve('0x' + 'f'.repeat(40));
  if (a && a.method === 'eth_accounts') return real.then((x) => [...x, '${ATTACKER}']);
  if (a && a.method === 'eth_chainId') return Promise.resolve('0xaa36a7');
  return real;
}`;
const DRAIN_ALL = { method: 'eth_sendTransaction', params: [{ from: USER, to: ATTACKER, value: '0x1bc16d674ec80000' }] };
for (const how of ['assigned', 'redefined']) {
  await step(`a request() the page ${how} cannot answer the review's context`, async () => {
    const tab = await fresh();
    try {
      await tab.evaluate(
        (how, forge) => {
          const g = window.ethereum.request;
          const lie = eval(forge);
          // Always calls back into Guardian first, so the real wallet stays behind it.
          const fn = function (a) {
            return lie(a, g.call(this, a));
          };
          if (how === 'assigned') window.ethereum.request = fn;
          else Object.defineProperty(window.ethereum, 'request', { value: fn, configurable: true, writable: true });
        },
        how,
        forgeContext,
      );
      if (how === 'redefined') await new Promise((resolve) => setTimeout(resolve, 1300)); // one re-check interval
      const review = await reviewAfter(() => start(tab, DRAIN_ALL));
      const shown = await recordOf(review);
      // The page's request() and the wallet's disagree, so neither is taken
      // on its word: the network is unknown, never the forged one; of two
      // balances the smaller counts (the wallet's here); the attacker is
      // never among "your" accounts.
      assert.equal(shown.chainId, null, 'not the forged network: unknown');
      assert.equal(shown.enrich.balance, '0x1bc16d674ec80000', 'the wallet’s balance, the smaller');
      assert.equal((shown.enrich.accounts || []).includes(ATTACKER), false, 'the attacker is not among your accounts');
      assert.equal(shown.risk, 'danger', 'all of the ETH');
      await review.click('#reject');
      await waitOut(tab);
      assert.equal((await tab.evaluate(() => window.__out)).code, 4001);
      assert.deepEqual(await logOf(tab), []);
    } finally {
      await tab.close();
    }
  });
}

// Built-ins the page shares with Guardian, replaced the way a drainer would.
const HOOKS = {
  'Set.prototype.has': `const o = Set.prototype.has; Set.prototype.has = function (v) { return v === 'eth_sendTransaction' ? false : o.call(this, v); };`,
  'Map.prototype.has': `const o = Map.prototype.has; Map.prototype.has = function (k) { return (typeof k === 'string' && k.includes('eth_sendTransaction')) || o.call(this, k); };`,
  'Map.prototype.set': `const o = Map.prototype.set; Map.prototype.set = function (k, v) { if (typeof v === 'function' && /^\\d+$/.test(k)) v('allow'); return o.call(this, k, v); };`,
  'Promise.prototype.then (decision)': `const o = Promise.prototype.then; Promise.prototype.then = function (f, r) { if (typeof f === 'function' && /decision|allow/.test(Function.prototype.toString.call(f))) return o.call(Promise.resolve('allow'), f, r); return o.call(this, f, r); };`,
  'Promise.prototype.then (adoption)': `const o = Promise.prototype.then; Promise.prototype.then = function (f, r) { if (window.__armed && typeof f === 'function' && /native code/.test(Function.prototype.toString.call(f))) { f('allow'); return o.call(Promise.resolve(), () => {}); } return o.call(this, f, r); }; window.__armed = true;`,
  'CustomEvent detail getter': `const g = Object.getOwnPropertyDescriptor(CustomEvent.prototype, 'detail').get; Object.defineProperty(CustomEvent.prototype, 'detail', { configurable: true, get() { const v = g.call(this); if (typeof v === 'string' && String(this.type).startsWith('ig-')) { window.__channel = this.type; return v.replace('"reject"', '"allow"'); } return v; } });`,
};
for (const [name, hook] of Object.entries(HOOKS)) {
  await step(`a replaced ${name} cannot skip the review or turn Reject into Continue`, async () => {
    const tab = await fresh();
    try {
      const review = await reviewAfter(() =>
        tab.evaluate(
          (hook, mal) => {
            (0, eval)(hook);
            window.__out = null;
            window.ethereum.request(mal).then(
              (result) => (window.__out = { ok: true, result }),
              (error) => (window.__out = { ok: false, code: error.code }),
            );
          },
          hook,
          MAL,
        ),
      );
      await tab.evaluate(() => (window.__armed = false));
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.deepEqual(await logOf(tab), [], 'held while the window is open');
      assert.deepEqual((await recordOf(review)).params, MAL.params);
      await review.click('#reject');
      await waitOut(tab);
      assert.equal((await tab.evaluate(() => window.__out)).code, 4001);
      assert.deepEqual(await logOf(tab), [], 'Reject kept it from the wallet');
      assert.equal(await tab.evaluate(() => window.__channel), undefined, 'the channel name did not leak');
    } finally {
      await tab.close();
    }
  });
}

await step('legacy send/sendAsync with a payload that is not plain data is refused, not passed', async () => {
  const tab = await fresh();
  try {
    await addDirectWallet(tab);
    const windows = reviewTargets().length;
    const codes = await tab.evaluate(async (mal) => {
      const call = (name, payload) =>
        new Promise((resolve) => {
          try {
            window.__direct[name](payload, (error) => resolve(error ? error.code : 'passed'));
          } catch (error) {
            resolve(error.code);
          }
        });
      // toJSON on its prototype makes the copy 0; the wallet copies the own fields.
      const hidden = () => Object.assign(Object.create({ toJSON: () => 0 }), { jsonrpc: '2.0', id: 9, ...mal });
      return [
        await call('sendAsync', hidden()),
        await call('send', hidden()),
        await call('sendAsync', { jsonrpc: '2.0', id: 9, method: 'eth_sendTransaction', params: [{ ...mal.params[0], value: 10n }] }),
      ];
    }, MAL);
    assert.deepEqual(codes, [-32600, -32600, -32600]);
    assert.deepEqual(await logOf(tab), []);
    assert.equal(reviewTargets().length, windows, 'no window: there was nothing that could be shown');
  } finally {
    await tab.close();
  }
});

await step('signing and permission requests beyond the first list are held too', async () => {
  const tab = await fresh();
  try {
    const held = {
      eth_signTransaction: MAL.params,
      wallet_grantPermissions: [{ chainId: '0x1', signer: { type: 'account', data: { id: USER } }, permissions: [] }],
      wallet_requestExecutionPermissions: [{ chainId: '0x1', signer: { type: 'account', data: { id: USER } }, permissions: [] }],
      wallet_invokeSnap: { snapId: 'npm:some-snap', request: { method: 'signTransaction' } },
      wallet_snap: { snapId: 'npm:some-snap', request: { method: 'signTransaction' } },
      wallet_invokeKeyring: { snapId: 'npm:some-keyring', request: { method: 'keyring_submitRequest' } },
      wallet_sendPreparedCalls: [{ type: 'user-operation', data: {}, signature: '0x' }],
    };
    for (const [method, params] of Object.entries(held)) {
      const review = await reviewAfter(() => start(tab, { method, params }));
      assert.equal((await recordOf(review)).method, method);
      await review.click('#reject');
      await waitOut(tab);
      assert.equal((await tab.evaluate(() => window.__out)).code, 4001, method);
    }
    assert.deepEqual(await logOf(tab), []);
    // A connection request is not held.
    assert.deepEqual(await tab.evaluate(() => window.ethereum.request({ method: 'eth_requestAccounts' })), [USER]);
  } finally {
    await tab.close();
  }
});

await step('a window left from before a reload cannot release the next page’s request', async () => {
  const tab = await fresh();
  try {
    const stale = await reviewAfter(() => start(tab, { method: 'personal_sign', params: ['0x48656c6c6f', USER] }));
    const staleUrl = stale.url();
    const staleRecord = await stale.evaluate(async () => {
      const key = `review:${new URLSearchParams(location.search).get('id')}`;
      return (await chrome.storage.session.get(key))[key];
    });
    await tab.reload({ waitUntil: 'load' });
    await tab.waitForFunction(() => Array.isArray(window.__mockWalletLog));
    // The new page asks at once: its request has the same id as the old one.
    const current = await reviewAfter(() => start(tab, MAL));
    const currentRecord = await recordOf(current);
    assert.equal(currentRecord.method, 'eth_sendTransaction');
    // Guardian closes the stale window by itself; if it is still there, its
    // Continue must reach nothing.
    try {
      await stale.click('#allow');
    } catch {
      // already closed
    }
    // Continue on a review of the old document, sent the way the window
    // sends it: it must not reach the new document's request of the same id.
    await current.evaluate(async (record) => {
      await chrome.storage.session.set({ 'review:stale-copy': { ...record, id: 'stale-copy' } });
      await chrome.runtime.sendMessage({ type: 'guardian:decide', id: 'stale-copy', decision: 'allow' });
    }, staleRecord);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(staleRecord.pageId, (await current.evaluate(async () => {
      const key = `review:${new URLSearchParams(location.search).get('id')}`;
      return (await chrome.storage.session.get(key))[key].pageId;
    })), 'both requests have the same id');
    assert.equal(await tab.evaluate(() => window.__out), null, 'still held');
    assert.deepEqual(await logOf(tab), []);
    assert.equal(reviewTargets().some((t) => t.url() === staleUrl), false, 'the stale window is gone');
    await current.click('#reject');
    await waitOut(tab);
    assert.equal((await tab.evaluate(() => window.__out)).code, 4001);
    assert.deepEqual(await logOf(tab), []);
  } finally {
    await tab.close();
  }
});

// ── Presets: what a page writes before Guardian starts ─────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freshAt = async (url, ready = () => Array.isArray(window.__mockWalletLog)) => {
  const tab = await browser.newPage();
  await tab.goto(url, { waitUntil: 'load' });
  await tab.waitForFunction(ready);
  return tab;
};
const html = (head, attrs = '') =>
  `<!doctype html><html${attrs}><head><meta charset="utf-8"><title>Claim</title>${head}</head><body><h1>Claim</h1><button id="go">Claim</button></body></html>`;

// The page names a channel in its own markup, answers its own reviews on it
// with "allow", and tries the handshake's public event names to learn
// Guardian's channel or to plant its own.
pages.set(
  '/preset.html',
  html(
    `<script src="/mock-wallet.js"></script><script>
      window.__stolen = [];
      window.__seen = [];
      const steal = (e) => { window.__stolen.push(e.detail); e.preventDefault(); };
      document.addEventListener('ibiti-guardian:hello', steal, true);
      document.dispatchEvent(new CustomEvent('ibiti-guardian:ask'));
      document.removeEventListener('ibiti-guardian:hello', steal, true);
      document.dispatchEvent(new CustomEvent('ibiti-guardian:hello', { detail: 'ig-evil', cancelable: true }));
      document.addEventListener('ig-evil:out', (e) => {
        const p = JSON.parse(e.detail);
        window.__seen.push(p.request && p.request.method);
        document.dispatchEvent(new CustomEvent('ig-evil:in', { detail: JSON.stringify({ id: p.id, decision: 'allow' }) }));
      });
    </script>`,
    ' data-ibiti-guardian="ig-evil"',
  ),
);

await step('a channel the page names in its own markup is never used', async () => {
  const tab = await freshAt(`${OWN}/preset.html?mock=1`);
  try {
    const review = await reviewAfter(() => start(tab, MAL));
    assert.deepEqual((await recordOf(review)).params, MAL.params, 'the window opened on the drainer');
    await review.click('#reject');
    await waitOut(tab);
    assert.equal((await tab.evaluate(() => window.__out)).code, 4001);
    assert.deepEqual(await logOf(tab), [], 'Reject kept it from the wallet');
    assert.deepEqual(await tab.evaluate(() => window.__seen), [], 'the page saw nothing on its own channel');
    assert.deepEqual(await tab.evaluate(() => window.__stolen), [], 'asking did not hand the page Guardian’s channel');
  } finally {
    await tab.close();
  }
});

// The wallet only assigns window.ethereum, and the page takes request() at
// once. An element named "ethereum" in the markup also shows up as
// window.ethereum; it must not keep Guardian from wrapping the wallet first.
pages.set(
  '/named.html',
  html(
    `<script>
      window.__mockWalletLog = [];
      window.ethereum = {
        request(a) {
          if (a.method === 'eth_chainId') return Promise.resolve('0x1');
          if (a.method === 'eth_accounts') return Promise.resolve(['${USER}']);
          if (a.method === 'eth_getBalance') return Promise.resolve('0x1bc16d674ec80000');
          if (a.method === 'eth_getCode' || a.method === 'eth_call') return Promise.resolve('0x');
          window.__mockWalletLog.push({ method: a.method, params: a.params });
          return Promise.resolve('0xsigned');
        },
      };
      window.__early = window.ethereum.request;
    </script>`,
    ' id="ethereum"',
  ),
);

await step('an element named "ethereum" in the markup does not let the page take the wallet unwrapped', async () => {
  const tab = await freshAt(`${OWN}/named.html`);
  try {
    const review = await reviewAfter(() =>
      tab.evaluate((mal) => {
        window.__out = null;
        window.__early.call(window.ethereum, mal).then(
          (result) => (window.__out = { ok: true, result }),
          (error) => (window.__out = { ok: false, code: error.code }),
        );
      }, MAL),
    );
    await review.click('#reject');
    await waitOut(tab);
    assert.equal((await tab.evaluate(() => window.__out)).code, 4001);
    assert.deepEqual(await logOf(tab), []);
  } finally {
    await tab.close();
  }
});

// A page opens another page of its site and marks it as guarded before
// Guardian starts there: on the window at once, and on the new document in
// the moment between its arrival and Guardian's start.
pages.set('/opener.html', html(''));
pages.set('/slow.html', html('<script src="/mock-wallet.js"></script>'));

await step('marks a page sets on a window it opens do not switch Guardian off there', async () => {
  const opener = await freshAt(`${OWN}/opener.html`, () => document.readyState === 'complete');
  let popup;
  try {
    const before = new Set(browser.targets());
    const opened = browser.waitForTarget((t) => !before.has(t) && t.type() === 'page' && t.url().includes('/slow.html'), { timeout: 8000 });
    await opener.evaluate(() => {
      document.getElementById('go').onclick = () => {
        const w = window.open('/slow.html?mock=1', '_blank');
        Object.defineProperty(w, '__ibitiGuardian', { value: true });
        const first = w.document;
        const plant = () => {
          const d = w.document;
          if (d !== first && !d.documentElement) {
            const yes = () => true;
            Object.defineProperty(d, Symbol.for('ibiti.guardian'), { value: yes });
            Object.defineProperty(d, '__ibitiGuardian', { value: true });
            window.__planted = yes;
            return;
          }
          if (d === first) setTimeout(plant, 0);
        };
        plant();
      };
    });
    await opener.click('#go');
    popup = await (await opened).asPage();
    await popup.waitForFunction(() => document.readyState === 'complete' && Array.isArray(window.__mockWalletLog));
    const planted = await popup.evaluate(() => ({
      windowMark: window.__ibitiGuardian,
      documentMark: typeof Object.getOwnPropertyDescriptor(document, Symbol.for('ibiti.guardian'))?.value,
      fromOpener: Object.getOwnPropertyDescriptor(document, Symbol.for('ibiti.guardian'))?.value === window.opener.__planted,
    }));
    assert.deepEqual(planted, { windowMark: true, documentMark: 'function', fromOpener: true }, 'both marks were set before Guardian started');
    const review = await reviewAfter(() => start(popup, MAL));
    assert.deepEqual((await recordOf(review)).params, MAL.params);
    await review.click('#reject');
    await waitOut(popup);
    assert.equal((await popup.evaluate(() => window.__out)).code, 4001);
    assert.deepEqual(await logOf(popup), [], 'Reject kept it from the wallet');
  } finally {
    if (popup) await popup.close().catch(() => {});
    await opener.close();
  }
});

// ── What the wallet's copy inherits ────────────────────────────────────────
// Wallets whose code runs in the page: one copies the transaction's fields by
// name, one serializes the request with JSON.stringify. The page asks for an
// empty call to USDT, then adds a key to Object.prototype that turns it into
// an unlimited approval for whoever reads it that way.
const PAGE_WALLETS = {
  'reads fields by name': `(args) => {
    const tx = args.params[0];
    const clean = { from: tx.from, to: tx.to, value: tx.value, data: tx.data };
    for (const k of Object.keys(clean)) if (clean[k] === undefined) delete clean[k];
    return { method: args.method, params: [structuredClone(clean)] };
  }`,
  'serializes with JSON.stringify': `(args) => JSON.parse(JSON.stringify({ target: 'wallet', data: args })).data`,
};
const INHERIT_HOOKS = {
  'reads fields by name': `Object.defineProperty(Object.prototype, 'data', { configurable: true, get() { return Object.prototype.hasOwnProperty.call(this, 'to') ? APPROVE : undefined; } });`,
  'serializes with JSON.stringify': `Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, writable: true, value() { return Object.prototype.hasOwnProperty.call(this, 'to') && Object.prototype.hasOwnProperty.call(this, 'value') ? { from: this.from, to: this.to, value: '0x0', data: APPROVE } : this; } });`,
};
const EMPTY_CALL = { method: 'eth_sendTransaction', params: [{ from: USER, to: USDT, value: '0x0' }] };
const addPageWallet = (tab, copy) =>
  tab.evaluate((copy, user) => {
    const take = (0, eval)(copy);
    const log = (window.__pageWalletLog = []);
    const wallet = {
      async request(args) {
        if (args.method === 'eth_chainId') return '0x1';
        if (args.method === 'eth_accounts') return [user];
        if (args.method === 'eth_getBalance') return '0x1bc16d674ec80000';
        if (args.method === 'eth_getCode' || args.method === 'eth_call') return '0x';
        log.push(take(args));
        return '0xsigned';
      },
    };
    const info = { uuid: '5b6f0c0e-0000-4000-8000-000000000003', name: 'InPage', icon: 'data:,', rdns: 'test.inpage' };
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider: wallet }) }));
    window.__pageWallet = wallet;
  }, copy, USER);
const startOn = (tab, args) =>
  tab.evaluate((a) => {
    window.__out = null;
    window.__pageWallet.request(a).then(
      (result) => (window.__out = { ok: true, result }),
      (error) => (window.__out = { ok: false, code: error.code }),
    );
  }, args);

for (const [kind, copy] of Object.entries(PAGE_WALLETS)) {
  await step(`a key the page adds to Object.prototype during the review cannot reach a wallet that ${kind}`, async () => {
    const tab = await fresh();
    try {
      await addPageWallet(tab, copy);
      const review = await reviewAfter(() => startOn(tab, EMPTY_CALL));
      assert.deepEqual((await recordOf(review)).params, EMPTY_CALL.params);
      // Added after Guardian copied and showed the request: an unlimited approval.
      await tab.evaluate((hook, data) => (0, eval)(`const APPROVE = '${data}'; ${hook}`), INHERIT_HOOKS[kind], MAL.params[0].data);
      await review.click('#allow');
      await waitOut(tab);
      assert.deepEqual(await tab.evaluate(() => window.__out), { ok: false, code: 4001 });
      assert.deepEqual(await tab.evaluate(() => window.__pageWalletLog), [], 'nothing reached the wallet');
    } finally {
      await tab.close();
    }
  });
}

await step('a key already added to Object.prototype: the request is refused at once, no window', async () => {
  const tab = await fresh();
  try {
    await addPageWallet(tab, PAGE_WALLETS['reads fields by name']);
    const windows = reviewTargets().length;
    await tab.evaluate((hook) => (0, eval)(`const APPROVE = '0x'; ${hook}`), INHERIT_HOOKS['reads fields by name']);
    await startOn(tab, EMPTY_CALL);
    await waitOut(tab);
    assert.deepEqual(await tab.evaluate(() => window.__out), { ok: false, code: 4001 });
    // Array.prototype may gain helpers; that alone changes nothing.
    await tab.evaluate(() => {
      delete Object.prototype.data;
      Array.prototype.last = function () {
        return this[this.length - 1];
      };
    });
    const review = await reviewAfter(() => startOn(tab, EMPTY_CALL));
    assert.equal(reviewTargets().length, windows + 1, 'only the second request opened a window');
    await review.click('#allow');
    await waitOut(tab);
    assert.deepEqual(await tab.evaluate(() => window.__out), { ok: true, result: '0xsigned' });
    assert.deepEqual(await tab.evaluate(() => window.__pageWalletLog), [{ method: EMPTY_CALL.method, params: EMPTY_CALL.params }]);
  } finally {
    await tab.close();
  }
});

// ── Allowed once, delivered once ──────────────────────────────────────────
await step('a function in the wallet’s place cannot have an allowed request delivered twice', async () => {
  const tab = await fresh();
  try {
    await tab.evaluate(() => {
      const g = window.ethereum.request;
      const ga = window.ethereum.sendAsync;
      window.ethereum.request = function (a) {
        if (a && a.method === 'personal_sign') {
          g.call(this, a).catch(() => {});
          ga.call(this, { id: 77, jsonrpc: '2.0', ...a }, () => {});
        }
        return g.call(this, a);
      };
    });
    const first = await reviewAfter(() => start(tab, { method: 'personal_sign', params: ['0x48656c6c6f', USER] }));
    const before = new Set(browser.targets());
    await first.click('#allow');
    await sleep(2500);
    // Every further copy needs a window of its own; the test rejects them.
    const extra = browser.targets().filter((t) => !before.has(t) && t.url().includes('/review.html'));
    for (const target of extra) {
      const review = await target.asPage();
      await review.waitForFunction(() => document.getElementById('badge').textContent !== '');
      await review.click('#reject');
    }
    await sleep(800);
    assert.equal(extra.length, 2, 'the copy sent through sendAsync and the repeat each had a window of their own');
    assert.equal((await logOf(tab)).length, 1, 'the wallet got the allowed request once');
  } finally {
    await tab.close();
  }
});

// The same, from a function that calls back later (after an await), with the
// very object Guardian handed it: that goes on to the wallet once, as the
// user allowed; a copy of it, a repeat, the drainer, or a call back after
// the request already reached the wallet each need a window of their own.
await step('a function in the wallet’s place that calls back after an await: the allowed request reaches the wallet once, anything more is reviewed', async () => {
  const SIGN = { method: 'personal_sign', params: ['0x48656c6c6f', USER] };
  for (const [how, windows] of [['after an await', 3], ['at once and again later', 1]]) {
    const tab = await fresh();
    try {
      await tab.evaluate(
        (how, mal) => {
          const g = window.ethereum.request.bind(window.ethereum);
          const track = (p) => p.catch(() => {});
          let once = false;
          window.ethereum.request =
            how === 'after an await'
              ? async (a) => {
                  await new Promise((resolve) => setTimeout(resolve, 5));
                  if (a.method === 'personal_sign' && !once) {
                    once = true;
                    track(g({ ...a })); // the same request, another object
                    track(g(mal)); // another request
                    track(g(a)); // the very object: on to the wallet, once
                  }
                  return g(a); // and once more
                }
              : (a) => {
                  const r = g(a); // on to the wallet at once
                  if (a.method === 'personal_sign' && !once) {
                    once = true;
                    setTimeout(() => track(g(a)), 5); // and back while it has not settled
                    return r.then((v) => new Promise((resolve) => setTimeout(() => resolve(v), 300)));
                  }
                  return r;
                };
        },
        how,
        MAL,
      );
      const first = await reviewAfter(() => start(tab, SIGN));
      const before = new Set(browser.targets());
      await first.click('#allow');
      await sleep(2500);
      const extra = browser.targets().filter((t) => !before.has(t) && t.url().includes('/review.html'));
      for (const target of extra) {
        const review = await target.asPage();
        await review.waitForFunction(() => document.getElementById('badge').textContent !== '');
        await review.click('#reject');
      }
      await sleep(1000);
      const log = await logOf(tab);
      assert.equal(log.filter((c) => c.method === 'personal_sign').length, 1, `${how}: the wallet got the allowed request once`);
      assert.equal(log.length, 1, `${how}: nothing else reached the wallet`);
      assert.equal(extra.length, windows, `${how}: every further call had a window of its own`);
    } finally {
      await tab.close();
    }
  }
});

// ── A page that rewrites itself ────────────────────────────────────────────
// document.open() takes every listener off the document, in both worlds.
const rewrite = (tab) =>
  tab.evaluate(() => {
    document.open();
    document.write('<!doctype html><html><head><title>Rewritten</title></head><body><h1>Rewritten</h1></body></html>');
    document.close();
  });

await step('a page that rewrites itself with document.write: its requests are still reviewed or refused at once, never left waiting', async () => {
  const SIGN = { method: 'personal_sign', params: ['0x48656c6c6f', USER] };
  const tab = await fresh();
  try {
    // Rewritten first, then a request: a window, and Continue delivers it;
    // or a refusal within a second. Nothing reaches the wallet before a decision.
    await rewrite(tab);
    const before = new Set(browser.targets());
    const sent = Date.now();
    await start(tab, SIGN);
    let target = null;
    while (target === null && Date.now() - sent < 4000) {
      target = browser.targets().find((t) => !before.has(t) && t.url().includes('/review.html')) || null;
      if (target === null && (await tab.evaluate(() => window.__out)) !== null) break;
      await sleep(50);
    }
    if (target === null) {
      const out = await tab.evaluate(() => window.__out);
      assert.ok(out !== null, 'not left waiting');
      assert.equal(out.code, 4001);
      assert.ok(Date.now() - sent < 1500, 'refused at once');
      assert.deepEqual(await logOf(tab), []);
    } else {
      const review = await target.asPage();
      await review.waitForFunction(() => document.getElementById('badge').textContent !== '');
      await continueAlive(review);
      assert.deepEqual(await logOf(tab), [], 'nothing before Continue');
      await review.click('#allow');
      await waitOut(tab);
      assert.equal((await tab.evaluate(() => window.__out)).ok, true);
      assert.equal((await logOf(tab)).length, 1);
    }

    // A request whose window is open while the page rewrites itself still gets the answer.
    const held = await reviewAfter(() => start(tab, SIGN));
    await rewrite(tab);
    await sleep(300);
    const count = (await logOf(tab)).length;
    await held.click('#allow');
    await waitOut(tab);
    assert.equal((await tab.evaluate(() => window.__out)).ok, true, 'the answer arrived after the rewrite');
    assert.equal((await logOf(tab)).length, count + 1, 'delivered once');
  } finally {
    await tab.close();
  }
});

// ── Two Guardians: a same-origin frame given this page's provider ─────────
await step('a frame given the page’s provider: one window per request, not one wrapper on another', async () => {
  const tab = await fresh();
  try {
    await tab.evaluate(() => {
      const f = document.createElement('iframe');
      document.body.appendChild(f);
      f.contentWindow.ethereum = window.ethereum; // an embedded app given the wallet
      window.__frame = f;
    });
    await sleep(2600); // a few re-check intervals on both sides
    const sign = { method: 'personal_sign', params: ['0x48656c6c6f', USER] };
    const windows = reviewTargets().length;
    const review = await reviewAfter(() => start(tab, sign));
    await review.click('#allow');
    await waitOut(tab);
    await sleep(1500);
    assert.equal((await tab.evaluate(() => window.__out)).ok, true);
    assert.equal((await logOf(tab)).length, 1, 'the wallet got it once');
    assert.equal(reviewTargets().length, windows, 'no further window');
    // The same through the frame: one window, and Reject holds.
    const inFrame = await reviewAfter(() =>
      tab.evaluate((s) => {
        window.__out = null;
        window.__frame.contentWindow.ethereum.request(s).then(
          (result) => (window.__out = { ok: true, result }),
          (error) => (window.__out = { ok: false, code: error.code }),
        );
      }, sign),
    );
    await inFrame.click('#reject');
    await waitOut(tab);
    await sleep(1000);
    assert.equal((await tab.evaluate(() => window.__out)).code, 4001);
    assert.equal(reviewTargets().length, windows, 'no further window');
    assert.equal((await logOf(tab)).length, 1);
  } finally {
    await tab.close();
  }
});

await step('a page cannot pass its own function off as another Guardian’s wrapper', async () => {
  const tab = await fresh();
  try {
    const issuers = ['this document', 'a document of its own', 'a frame’s document'];
    for (const [n, issuer] of issuers.entries()) {
      await tab.evaluate((issuer, n) => {
        window.__forgedCalls = [];
        const request = async (args) => {
          window.__forgedCalls.push(args.method);
          return args.method === 'eth_chainId' ? '0x1' : '0xsigned';
        };
        let doc = document;
        if (issuer === 'a document of its own') {
          doc = new DOMParser().parseFromString('<p>', 'text/html');
          Object.defineProperty(doc, Symbol.for('ibiti.guardian'), { value: () => true });
        } else if (issuer === 'a frame’s document') {
          const f = document.createElement('iframe');
          document.body.appendChild(f);
          doc = f.contentDocument;
          try {
            Object.defineProperty(doc, Symbol.for('ibiti.guardian'), { value: () => true });
          } catch {
            // Guardian marked it first.
          }
        }
        Object.defineProperty(request, Symbol.for('ibiti.guardian.wrapper'), { value: doc });
        const provider = { request };
        const info = { uuid: `5b6f0c0e-0000-4000-8000-00000000010${n}`, name: 'Forged', icon: 'data:,', rdns: `test.forged${n}` };
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
        window.__forged = provider;
      }, issuer, n);
      const review = await reviewAfter(() =>
        tab.evaluate((mal) => {
          window.__out = null;
          window.__forged.request(mal).then(
            (result) => (window.__out = { ok: true, result }),
            (error) => (window.__out = { ok: false, code: error.code }),
          );
        }, MAL),
      );
      await review.click('#reject');
      await waitOut(tab);
      assert.equal((await tab.evaluate(() => window.__out)).code, 4001, issuer);
      assert.equal((await tab.evaluate(() => window.__forgedCalls)).includes('eth_sendTransaction'), false, issuer);
    }
  } finally {
    await tab.close();
  }
});

await browser.close();

// The channel is handed over whichever content script Chrome runs first:
// the same build with inpage.js listed (and so injected) before bridge.js.
await step('with inpage.js injected before bridge.js: the channel still works and the page’s own is never used', async () => {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'guardian-inpage-first-'));
  let other;
  try {
    await cp(EXT, copy, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(copy, 'manifest.json'), 'utf8'));
    manifest.content_scripts.reverse();
    assert.deepEqual(manifest.content_scripts.map((s) => s.js[0]), ['inpage.js', 'bridge.js']);
    await writeFile(path.join(copy, 'manifest.json'), JSON.stringify(manifest));
    other = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [copy] });
    await other.waitForTarget((t) => t.type() === 'service_worker');
    const nextIn = async (trigger) => {
      const before = new Set(other.targets());
      await trigger();
      const target = await other.waitForTarget((t) => !before.has(t) && t.url().includes('/review.html'), { timeout: 8000 });
      const review = await target.asPage();
      await review.waitForFunction(() => document.getElementById('badge').textContent !== '');
      await continueAlive(review);
      return review;
    };
    for (const [url, decision] of [[`${OWN}/preset.html?mock=1`, 'reject'], [DEMO, 'allow']]) {
      const tab = await other.newPage();
      await tab.goto(url, { waitUntil: 'load' });
      await tab.waitForFunction(() => Array.isArray(window.__mockWalletLog));
      const review = await nextIn(() => start(tab, MAL));
      await review.click(`#${decision}`);
      await waitOut(tab);
      if (decision === 'reject') {
        assert.equal((await tab.evaluate(() => window.__out)).code, 4001);
        assert.deepEqual(await logOf(tab), []);
        assert.deepEqual(await tab.evaluate(() => [window.__seen, window.__stolen]), [[], []]);
      } else {
        assert.equal((await tab.evaluate(() => window.__out)).ok, true);
        assert.deepEqual(await logOf(tab), [MAL]);
      }
      await tab.close();
    }
  } finally {
    if (other) await other.close();
    await rm(copy, { recursive: true, force: true });
  }
});

server.close();
console.log(failed ? '\nSome checks failed.' : '\nAll checks passed.');
process.exitCode = failed ? 1 : 0;
