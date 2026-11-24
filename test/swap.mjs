// A wallet that replaces its own request() after start-up must stay guarded,
// and a legacy call that passes through several of the wallet's methods on
// its way down (send calls sendAsync calls request) is shown once. A wallet
// that answers with a Promise the page replaced (zone.js) is still read, and
// so is one whose first request() never answered before it put another in
// place; one that builds a new request() for each network is never read as
// the old network; a Proxy that binds every method anew stays one layer; and
// a page that wraps request() and calls it after an await still works.
//   node test/swap.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer';

const EXT = path.resolve(process.env.GUARDIAN_OUT || 'dist/extension');
const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [EXT] });
await browser.waitForTarget((t) => t.type() === 'service_worker');
let failed = false;

const newReviews = (before) => browser.targets().filter((t) => !before.has(t) && t.url().includes('/review.html'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The value, or 'no answer' after `ms` (a page busy for ever answers nothing). */
const within = (ms, promise) => Promise.race([promise, sleep(ms).then(() => 'no answer')]);
/**
 * Waits until Continue is alive. It comes alive a moment after the window
 * appears and is in focus (test/review.mjs). Headless Chrome can give a new
 * window its focus seconds late, even after bringToFront(), so the window is
 * taken as in focus, as the user's own window is when it opens.
 */
async function alive(review) {
  await review.emulateFocusedPage(true);
  await review.waitForFunction(() => !document.getElementById('allow').disabled, { timeout: 10000 });
}

/**
 * send(payload, callback) or sendAsync(payload, callback), allowed once: one
 * window, and the wallet gets the request once. The demo wallet's send()
 * calls its sendAsync(), which calls its request(); Guardian wraps all three.
 */
async function legacyOnce(page, name) {
  const before = new Set(browser.targets());
  const logBefore = await page.evaluate(() => window.__mockWalletLog.length);
  try {
    await page.evaluate((name) => {
      window.__legacy = null;
      const payload = { jsonrpc: '2.0', id: 7, method: 'personal_sign', params: ['0x48656c6c6f', '0x' + '11'.repeat(20)] };
      window.ethereum[name](payload, (error, response) => (window.__legacy = error ? { code: error.code } : { id: response.id }));
    }, name);
    const target = await browser.waitForTarget((t) => !before.has(t) && t.url().includes('/review.html'), { timeout: 8000 });
    const review = await target.asPage();
    await review.waitForFunction(() => document.getElementById('badge').textContent !== '');
    await alive(review);
    await review.click('#allow');
    await page.waitForFunction(() => window.__legacy !== null, { timeout: 4000 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(newReviews(before).length, 0, `${name}: no second window`);
    assert.deepEqual(await page.evaluate(() => window.__legacy), { id: 7 }, `${name}: the page got the answer`);
    assert.equal(await page.evaluate(() => window.__mockWalletLog.length), logBefore + 1, `${name}: the wallet got it once`);
  } finally {
    for (const target of newReviews(before)) await (await target.asPage()).close().catch(() => {});
  }
}

{
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:5179/demo/index.html?mock=1', { waitUntil: 'load' });
  await page.waitForFunction(() => Array.isArray(window.__mockWalletLog));
  for (const name of ['send', 'sendAsync']) {
    try {
      await legacyOnce(page, name);
      console.log(`ok   legacy ${name}(payload, callback) allowed once: one window, delivered once`);
    } catch (error) {
      failed = true;
      console.log(`FAIL legacy ${name}(payload, callback) allowed once\n     ${String(error && error.message).split('\n')[0]}`);
    }
  }
  await page.close();
}

// A Rabby-shaped wallet: its sendAsync() calls its request() with method and
// params only. The page sends a payload with a top-level from, as old MetaMask
// docs wrote it: one window, and the wallet gets it once.
{
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:5179/demo/index.html?mock=1', { waitUntil: 'load' });
  await page.waitForFunction(() => Array.isArray(window.__mockWalletLog));
  const before = new Set(browser.targets());
  try {
    await page.evaluate(() => {
      const log = window.__mockWalletLog;
      const rabby = {
        isRabby: true,
        request: async ({ method, params }) => {
          if (method === 'eth_chainId') return '0x1';
          if (method === 'eth_accounts') return ['0x' + '11'.repeat(20)];
          if (method === 'eth_getCode' || method === 'eth_call') return '0x';
          log.push({ method, params });
          return '0x' + 'cd'.repeat(65);
        },
        sendAsync: (payload, callback) => {
          const { method, params, ...rest } = payload;
          rabby.request({ method, params }).then(
            (result) => callback(null, { ...rest, method, result }),
            (error) => callback(error, null),
          );
        },
      };
      const info = { uuid: '5b6f0c0e-0000-4000-8000-000000000020', name: 'Rabby-like', icon: 'data:,', rdns: 'test.rabbylike' };
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider: rabby }) }));
      window.__legacy = null;
      const me = '0x' + '11'.repeat(20);
      rabby.sendAsync({ id: 3, jsonrpc: '2.0', method: 'personal_sign', params: ['0x48656c6c6f', me], from: me }, (error, response) => {
        window.__legacy = error ? { code: error.code } : { id: response.id };
      });
    });
    const target = await browser.waitForTarget((t) => !before.has(t) && t.url().includes('/review.html'), { timeout: 8000 });
    const review = await target.asPage();
    await review.waitForFunction(() => document.getElementById('badge').textContent !== '');
    await alive(review);
    await review.click('#allow');
    await page.waitForFunction(() => window.__legacy !== null, { timeout: 4000 }).catch(() => {});
    await sleep(1500);
    assert.equal(newReviews(before).length, 0, 'no second window (the first closed on Continue)');
    assert.deepEqual(await page.evaluate(() => window.__legacy), { id: 3 }, 'the page got the answer');
    assert.equal(await page.evaluate(() => window.__mockWalletLog.length), 1, 'the wallet got it once');
    console.log('ok   a Rabby-like sendAsync({ method, params, from }): one window, delivered once');
  } catch (error) {
    failed = true;
    console.log(`FAIL a Rabby-like sendAsync({ method, params, from })\n     ${String(error && error.message).split('\n')[0]}`);
  } finally {
    for (const target of newReviews(before)) await (await target.asPage()).close().catch(() => {});
  }
  await page.close();
}

// "stub": the wallet's first request() never answers (not set up yet); it
// puts its working one in place a moment later.
for (const mode of ['assign', 'define', 'rebind', 'stub']) {
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
    // The review's context is still read from the wallet (through request()
    // as Guardian first found it, or, when that one does not answer, the one
    // the wallet put in place since).
    const context = await review.evaluate(async () => {
      const key = `review:${new URLSearchParams(location.search).get('id')}`;
      const record = (await chrome.storage.session.get(key))[key];
      return { chainId: record.chainId, accounts: record.enrich.accounts, token: record.enrich.token };
    });
    assert.deepEqual(context, { chainId: 1, accounts: ['0x' + '11'.repeat(20)], token: { symbol: 'USDT', decimals: 6 } });
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
    // Continue comes alive a moment after the window appears (test/review.mjs).
    await alive(review2);
    await review2.click('#allow');
    await page.waitForFunction(() => window.__dapp.history.length === 2);
    assert.equal(await page.evaluate(() => window.__mockWalletLog.length), 1, 'allowed request delivered once');

    // The same for a legacy call, after the swap (TronLink re-binds, then sends).
    await legacyOnce(page, 'send');
    console.log(`ok   wallet replaces request() by "${mode}": still guarded`);
  } catch (error) {
    failed = true;
    console.log(`FAIL wallet replaces request() by "${mode}"\n     ${String(error && error.message).split('\n')[0]}`);
  }
  await page.close();
}

// A wallet whose first request() never answers: the window still names the
// network and opens in about the time the wallet takes, not 1.5 s later.
{
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:5179/demo/index.html?mock=1&swap=stub', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__mockWalletSwapDone === true);
  try {
    const before = new Set(browser.targets());
    const started = Date.now();
    await page.click('[data-scenario="transfer"]');
    const target = await browser.waitForTarget((t) => !before.has(t) && t.url().includes('/review.html'), { timeout: 8000 });
    const ms = Date.now() - started;
    const review = await target.asPage();
    await review.waitForFunction(() => document.getElementById('badge').textContent !== '');
    const view = await review.evaluate(() => {
      const facts = {};
      for (const row of document.querySelectorAll('#facts .fact')) facts[row.querySelector('dt').textContent] = row.querySelector('dd').textContent;
      return { badge: document.getElementById('badge').textContent, headline: document.getElementById('headline').textContent, facts };
    });
    assert.equal(view.headline, 'Send 0.01 ETH');
    assert.equal(view.facts.Network, 'Ethereum');
    assert.equal(view.badge, 'No red flags found');
    assert.ok(ms < 1400, `the window opened after ${ms} ms`);
    await review.click('#reject');
    await page.waitForFunction(() => window.__dapp.history.length === 1);
    assert.equal(await page.evaluate(() => window.__dapp.last.code), 4001);
    assert.equal(await page.evaluate(() => window.__mockWalletLog.length), 0);
    console.log(`ok   a wallet whose first request() never answers: 0.01 ETH on Ethereum, window after ${ms} ms`);
  } catch (error) {
    failed = true;
    console.log(`FAIL a wallet whose first request() never answers\n     ${String(error && error.message).split('\n')[0]}`);
  }
  await page.close();
}

// A page that replaces its Promise with a class of its own (zone.js does, in
// Angular apps), and a wallet in the page whose request() answers with that
// Promise. With ?never=1 its eth_chainId never answers.
const ZONE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Zone app</title>
<script>
  (() => {
    const Native = Promise;
    class ZonePromise {
      constructor(executor) {
        this.inner = new Native(executor);
      }
      then(onFulfilled, onRejected) {
        const next = Object.create(ZonePromise.prototype);
        next.inner = this.inner.then(onFulfilled, onRejected);
        return next;
      }
      catch(onRejected) {
        return this.then(undefined, onRejected);
      }
    }
    window.Promise = ZonePromise;
  })();
</script>
<script>
  (() => {
    const never = new URLSearchParams(location.search).has('never');
    const log = (window.__walletLog = []);
    const answer = (method, params) => {
      switch (method) {
        case 'eth_chainId':
          return '0x1';
        case 'eth_accounts':
          return ['0x${'11'.repeat(20)}'];
        case 'eth_getBalance':
          return '0x1bc16d674ec80000'; // 2 ETH
        case 'eth_getCode':
          return '0x6080';
        case 'eth_call':
          return '0x';
        default:
          log.push({ method, params });
          return '0x${'ab'.repeat(32)}';
      }
    };
    window.ethereum = {
      request({ method, params = [] }) {
        if (never && method === 'eth_chainId') return new Promise(() => {});
        return new Promise((resolve) => setTimeout(() => resolve(answer(method, params)), 5));
      },
    };
  })();
</script></head><body><h1>Zone app</h1></body></html>`;

// A wallet that builds a new request() for each network it switches to; the
// old one keeps answering for the old network (100 ETH on Ethereum, while
// the wallet now holds 0.01 ETH on Base).
const STALE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Stale</title>
<script>
  (() => {
    const log = (window.__walletLog = []);
    const later = (value) => new Promise((resolve) => setTimeout(() => resolve(value), 3));
    const provider = { isStaleWallet: true };
    const make = (chainId) =>
      function request({ method, params = [] }) {
        if (method === 'eth_chainId') return later(chainId);
        if (method === 'wallet_switchEthereumChain') {
          provider.request = make(params[0].chainId);
          return later(null);
        }
        if (method === 'eth_accounts') return later(['0x${'11'.repeat(20)}']);
        if (method === 'eth_getBalance') return later(chainId === '0x1' ? '0x56bc75e2d63100000' : '0x2386f26fc10000');
        if (method === 'eth_getCode' || method === 'eth_call') return later('0x');
        log.push({ method, params });
        return later('0x${'ab'.repeat(32)}');
      };
    provider.request = make('0x1');
    window.ethereum = provider;
  })();
</script></head><body><h1>Stale</h1></body></html>`;

// A wallet whose provider is a Proxy that hands out every function bound
// anew, each time it is read.
const PROXY_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Proxy</title>
<script>
  (() => {
    const log = (window.__walletLog = []);
    class Wallet {
      async request({ method, params = [] }) {
        if (method === 'eth_chainId') return '0x1';
        if (method === 'eth_accounts') return ['0x${'11'.repeat(20)}'];
        if (method === 'eth_getBalance') return '0x1bc16d674ec80000';
        if (method === 'eth_getCode' || method === 'eth_call') return '0x';
        log.push({ method, params });
        return '0x${'ab'.repeat(32)}';
      }
      sendAsync(payload, callback) {
        this.request(payload).then((result) => callback(null, { id: payload.id, jsonrpc: '2.0', result }), (error) => callback(error, null));
      }
    }
    const target = new Wallet();
    window.ethereum = new Proxy(target, {
      get(t, name) {
        const value = Reflect.get(t, name);
        return typeof value === 'function' ? value.bind(t) : value;
      },
    });
  })();
</script></head><body><h1>Proxy</h1></body></html>`;

{
  const PAGES = { '/stale.html': STALE_PAGE, '/proxy.html': PROXY_PAGE };
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(PAGES[new URL(request.url, 'http://local').pathname] || ZONE_PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const ZONE = `http://127.0.0.1:${server.address().port}/zone.html`;
  const ME = '0x' + '11'.repeat(20);
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const pay = { method: 'eth_sendTransaction', params: [{ from: ME, to: '0x' + '22'.repeat(20), value: '0x2386f26fc10000' }] };
  const approve = {
    method: 'eth_sendTransaction',
    params: [{ from: ME, to: USDC, data: `0x095ea7b3${'33'.repeat(20).padStart(64, '0')}${(20_000_000).toString(16).padStart(64, '0')}` }],
  };

  /** Sends the request from the page; returns its window, drawn, and how long it took to appear. */
  async function windowFor(page, request) {
    const before = new Set(browser.targets());
    const started = Date.now();
    await page.evaluate((request) => {
      window.__answer = null;
      window.ethereum.request(request).then(
        (result) => (window.__answer = { result }),
        (error) => (window.__answer = { code: error.code }),
      );
    }, request);
    const target = await browser.waitForTarget((t) => !before.has(t) && t.url().includes('/review.html'), { timeout: 8000 });
    const ms = Date.now() - started;
    const review = await target.asPage();
    await review.waitForFunction(() => document.getElementById('badge').textContent !== '');
    const view = await review.evaluate(async () => {
      const key = `review:${new URLSearchParams(location.search).get('id')}`;
      const record = (await chrome.storage.session.get(key))[key];
      const facts = {};
      for (const row of document.querySelectorAll('#facts .fact')) facts[row.querySelector('dt').textContent] = row.querySelector('dd').textContent;
      const text = (id) => document.getElementById(id).textContent;
      return { chainId: record.chainId, badge: text('badge'), headline: text('headline'), facts };
    });
    return { review, ms, view };
  }

  /** Continue, once it is alive: the page gets the wallet's answer. */
  async function allowed(page, review) {
    await alive(review);
    await review.click('#allow');
    await page.waitForFunction(() => window.__answer !== null, { timeout: 4000 });
    assert.deepEqual(await page.evaluate(() => window.__answer), { result: '0x' + 'ab'.repeat(32) });
  }

  const check = async (name, query, fn) => {
    const page = await browser.newPage();
    try {
      await page.goto(ZONE + query, { waitUntil: 'load' });
      await page.waitForFunction(() => Array.isArray(window.__walletLog));
      assert.equal(await page.evaluate(() => window.Promise.name), 'ZonePromise', 'the page has its own Promise');
      await fn(page);
      console.log(`ok   ${name}`);
    } catch (error) {
      failed = true;
      console.log(`FAIL ${name}\n     ${String(error && error.message).split('\n')[0]}`);
    }
    for (const target of browser.targets().filter((t) => t.url().includes('/review.html'))) await (await target.asPage()).close().catch(() => {});
    await page.close();
  };

  await check('zone.js page: a 0.01 ETH payment is read on its network, no red flags', '', async (page) => {
    const { review, view } = await windowFor(page, pay);
    assert.equal(view.chainId, 1);
    assert.equal(view.headline, 'Send 0.01 ETH');
    assert.equal(view.facts.Network, 'Ethereum');
    assert.equal(view.badge, 'No red flags found');
    await allowed(page, review);
    assert.equal(await page.evaluate(() => window.__walletLog.length), 1, 'delivered once');
  });

  await check('zone.js page: a USDC approve names USDC and its amount', '', async (page) => {
    const { review, view } = await windowFor(page, approve);
    assert.equal(view.headline, 'Spending permission for 20 USDC');
    assert.match(view.facts.Token, /^USDC \(USD Coin\)/);
    await allowed(page, review);
  });

  await check('zone.js page: an answer that never settles still opens the window, after about 1.5 s', '?never=1', async (page) => {
    const { review, ms, view } = await windowFor(page, pay);
    assert.ok(ms >= 1300 && ms < 6000, `opened after ${ms} ms`);
    assert.equal(view.chainId, null);
    assert.notEqual(view.badge, 'No red flags found');
    await review.click('#reject');
    await page.waitForFunction(() => window.__answer !== null, { timeout: 4000 });
    assert.deepEqual(await page.evaluate(() => window.__answer), { code: 4001 });
    assert.equal(await page.evaluate(() => window.__walletLog.length), 0, 'kept from the wallet');
  });

  const ORIGIN = `http://127.0.0.1:${server.address().port}`;
  const pageCheck = async (name, url, fn) => {
    const page = await browser.newPage();
    try {
      await page.goto(ORIGIN + url, { waitUntil: 'load' });
      await page.waitForFunction(() => Array.isArray(window.__walletLog));
      await fn(page);
      console.log(`ok   ${name}`);
    } catch (error) {
      failed = true;
      console.log(`FAIL ${name}\n     ${String(error && error.message).split('\n')[0]}`);
    }
    for (const target of browser.targets().filter((t) => t.url().includes('/review.html'))) await (await target.asPage()).close().catch(() => {});
    await page.close();
  };

  await pageCheck('a wallet with a new request() for each network: never read as the old network', '/stale.html', async (page) => {
    // Before the switch there is one request(): read as before.
    const first = await windowFor(page, pay);
    assert.equal(first.view.facts.Network, 'Ethereum');
    assert.equal(first.view.badge, 'No red flags found');
    await first.review.click('#reject');
    await page.waitForFunction(() => window.__answer !== null, { timeout: 4000 });
    // Switched to Base, where 0.01 ETH is all it holds; the old request() still says Ethereum.
    await page.evaluate(() => window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] }));
    const { review, view } = await windowFor(page, pay);
    assert.equal(view.chainId, null, 'the network is unknown, not the old one');
    assert.notEqual(view.facts.Network, 'Ethereum');
    assert.notEqual(view.badge, 'No red flags found');
    await review.click('#reject');
    await page.waitForFunction(() => window.__answer !== null, { timeout: 4000 });
    assert.deepEqual(await page.evaluate(() => window.__answer), { code: 4001 });
    assert.equal(await page.evaluate(() => window.__walletLog.length), 0, 'kept from the wallet');
  });

  await pageCheck('a Proxy wallet that binds every method anew: after 3000 re-checks, one window, delivered once', '/proxy.html', async (page) => {
    // Each 'ethereum#initialized' re-checks the providers, as once a second does.
    await page.evaluate(() => {
      for (let i = 0; i < 3000; i++) window.dispatchEvent(new Event('ethereum#initialized'));
    });
    assert.equal(await page.evaluate(() => window.ethereum.request({ method: 'eth_chainId' })), '0x1');
    const before = new Set(browser.targets());
    const sign = { method: 'personal_sign', params: ['0x48656c6c6f', ME] };
    const { review } = await windowFor(page, sign);
    await allowed(page, review);
    await sleep(1000);
    assert.equal(newReviews(before).length, 0, 'no second window (the first closed on Continue)');
    assert.equal(await page.evaluate(() => window.__walletLog.length), 1, 'delivered once');
  });
  server.close();
}

// A page (or an analytics SDK in it) that wraps request() by assignment and
// calls the one it read after an await, or after a microtask: a read still
// answers, a sign-in opens one window and reaches the wallet once, and the
// page stays responsive. Last: before the fix this froze the page.
for (const how of ['after an await', 'after a microtask']) {
  const page = await browser.newPage();
  const before = new Set(browser.targets());
  try {
    await page.goto('http://127.0.0.1:5179/demo/index.html?mock=1', { waitUntil: 'load' });
    await page.waitForFunction(() => Array.isArray(window.__mockWalletLog));
    await page.evaluate((how) => {
      window.__calls = 0;
      const orig = window.ethereum.request.bind(window.ethereum);
      window.ethereum.request =
        how === 'after an await'
          ? async (args) => {
              window.__calls++;
              await new Promise((resolve) => setTimeout(resolve, 5)); // analytics.track(args)
              return orig(args);
            }
          : function (args) {
              window.__calls++;
              return Promise.resolve().then(() => orig.call(this, args));
            };
    }, how);
    const read = await within(
      4000,
      page.evaluate(() => Promise.race([window.ethereum.request({ method: 'eth_chainId' }), new Promise((resolve) => setTimeout(() => resolve('none in 3 s'), 3000))])),
    );
    assert.equal(read, '0x1', 'a read answers');
    assert.equal(await within(2000, page.evaluate(() => window.__calls)), 1, 'the page’s function ran once');
    await page.evaluate(() => {
      window.__sign = null;
      window.ethereum.request({ method: 'personal_sign', params: ['0x48656c6c6f', '0x' + '11'.repeat(20)] }).then(
        (result) => (window.__sign = { result }),
        (error) => (window.__sign = { code: error.code }),
      );
    });
    const target = await browser.waitForTarget((t) => !before.has(t) && t.url().includes('/review.html'), { timeout: 8000 });
    const review = await target.asPage();
    await review.waitForFunction(() => document.getElementById('badge').textContent !== '');
    await alive(review);
    await review.click('#allow');
    await page.waitForFunction(() => window.__sign !== null, { timeout: 4000 });
    await sleep(1500);
    assert.equal(newReviews(before).length, 0, 'no second window (the first closed on Continue)');
    assert.deepEqual(await page.evaluate(() => window.__sign), { result: '0x' + 'cd'.repeat(65) });
    assert.equal(await page.evaluate(() => window.__mockWalletLog.length), 1, 'the wallet got it once');
    assert.equal(await within(2000, page.evaluate(() => 'here')), 'here', 'the page stays responsive');
    console.log(`ok   a page that wraps request() and calls it ${how}: reads answer, one window, delivered once`);
  } catch (error) {
    failed = true;
    console.log(`FAIL a page that wraps request() and calls it ${how}\n     ${String(error && error.message).split('\n')[0]}`);
  } finally {
    for (const target of newReviews(before)) await within(3000, target.asPage().then((review) => review.close())).catch(() => {});
  }
  await within(5000, page.close()).catch(() => {});
}

await browser.close();
console.log(failed ? '\nSome checks failed.' : '\nAll checks passed.');
process.exitCode = failed ? 1 : 0;
