// Guardian's review window itself, in a real Chrome:
//   - Continue is off when the window appears and comes alive after a moment
//     in focus; an early click, a press that began before then, Enter or
//     Space do nothing; Reject works at once.
//   - Once alive, a click, Enter or Space counts only after a pause in
//     clicking and pressing keys: a fast run of clicks at Continue's spot,
//     Space mashed after them, typing, Enter right after a Tab, or a key held
//     down, never decides. One Shift+Tab from a fresh window never reaches
//     Continue. An honest click, double-click or Enter still works, and so
//     does a screen reader's press after a pause. A press on a live Continue
//     that does not count says so, and the buttons do not move.
//   - A window whose page went on to another page (kept in the back/forward
//     cache) still closes on Reject, and the page gets the answer when it is
//     back; one that came back before the user decided gets Continue once;
//     one that goes away and back quickly, again and again, keeps its window.
//   - A second window opens exactly over the first: a popup the page places
//     cannot put the new window's Continue on the open window's Reject. A
//     window for a page in another browser window opens by that window, never
//     over the open one; the same page's next window opens over its own.
//   - A request the window cannot display keeps Continue off; Reject works.
//   - A text message is shown whole; one too long to show is never shown as
//     harmless with Continue on.
//   - A site with no address of its own is named as one Guardian cannot
//     identify, on screen and in what may be sent to the cloud.
//   - A sign-in for another site behind an account written "0X…" first, a
//     message in hex digits without 0x (or with 0X), and an approval just
//     under the largest number, are never "No red flags".
//   - The demo page promises calm on its ordinary requests only with its own
//     demo wallet (a real one is on a test network, where Guardian knows no token).
//   - An account only the page reported is never called the user's own.
//   - The hosted preview still works under the site's frame headers
//     (firebase.json), and another site cannot frame it.
//
//   GUARDIAN_OUT=dist/dev GUARDIAN_SITE_OUT=dist/site-verify node build.mjs
//   GUARDIAN_OUT=dist/dev GUARDIAN_SITE_OUT=dist/site-verify node test/review.mjs
//
// It starts its own demo server (tools/demo-server.mjs) on a free port. A
// press or click meant to decide may find the window already closed when the
// key comes up or the button is released (decideKey, decideAt, decide).

import assert from 'node:assert/strict';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { createDemoServer } from '../tools/demo-server.mjs';

const EXT = path.resolve(process.env.GUARDIAN_OUT || 'dist/extension');
const SITE = path.resolve(process.env.GUARDIAN_SITE_OUT || 'dist/site');
const ME = '0x1111111111111111111111111111111111111111';
const OTHER = '0x6666666666666666666666666666666666666666';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

// ── The extension ───────────────────────────────────────────────────────────

const demo = await createDemoServer();
const DEMO = `${await listen(demo)}/demo/index.html?mock=1`;
// A screen as large as a desktop's, so windows open where Guardian places them.
const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [EXT], args: ['--screen-info={1920x1080}'] });
const worker = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'));
const EXT_ORIGIN = worker.url().slice(0, -'/background.js'.length);
const page = await browser.newPage();
await page.goto(DEMO, { waitUntil: 'load' });
await page.waitForFunction(() => Array.isArray(window.__mockWalletLog));
assert.equal(await page.evaluate(() => window.__ibitiGuardian === true), true, 'Guardian is active on the page');

const walletLog = () => page.evaluate(() => window.__mockWalletLog.length);
const history = () => page.evaluate(() => window.__dapp.history.length);
const continueState = (review) =>
  review.evaluate(() => ({ state: document.body.dataset.continue, disabled: document.getElementById('allow').disabled }));

async function openReview(scenario, tab = page) {
  const before = new Set(browser.targets());
  await tab.click(`[data-scenario="${scenario}"]`);
  const target = await browser.waitForTarget((t) => !before.has(t) && t.url().includes('/review.html'), { timeout: 10000 });
  const review = await target.asPage();
  // The new window may still be on its first, empty document: wait for the
  // review page itself, loaded and drawn, before anything runs in it.
  await review.waitForFunction(
    () => {
      const badge = document.getElementById('badge');
      return location.pathname.endsWith('/review.html') && document.readyState === 'complete' && badge && badge.textContent !== '';
    },
    { polling: 20, timeout: 10000 },
  );
  return review;
}

const waitHistory = (n) => page.waitForFunction((k) => window.__dapp.history.length >= k, { timeout: 15000, polling: 100 }, n);
const waitArmed = (review) =>
  review.waitForFunction(() => !document.getElementById('allow').disabled, { timeout: 5000, polling: 20 });
/** The middle of an element, where a page would aim the user's clicks. */
const centre = async (review, selector) => {
  const box = await (await review.$(selector)).boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
// A press or click meant to decide. The window closes as soon as it has
// decided, so it may be gone before the key comes up or the button is
// released: that part is allowed to fail. The caller checks what the page
// got and the wallet's log.
/** Presses `key`, meant to decide. */
async function decideKey(review, key) {
  await review.keyboard.down(key);
  await review.keyboard.up(key).catch(() => {});
}
/** Clicks at `spot`, meant to decide. */
async function decideAt(review, spot) {
  await review.mouse.move(spot.x, spot.y);
  await review.mouse.down();
  await review.mouse.up().catch(() => {});
}
/** Clicks the button `selector` (in a page or a frame), meant to decide. */
async function decide(review, selector) {
  const button = await review.waitForSelector(selector);
  await button.scrollIntoView();
  const spot = await button.clickablePoint();
  await decideAt(review.mouse ? review : review.page(), spot);
}
// The pause review.js wants before the deciding press, and a little more.
const PAUSE = 600;
/**
 * The pace of one attempt's presses: no longer steady once two came nearly
 * half a second apart. Such a run proves nothing either way, and the caller
 * runs it again. A window that closes during a run kept at pace has
 * decided: a failure.
 */
function pacer() {
  let last = null;
  const pace = {
    steady: true,
    tick() {
      if (last !== null && Date.now() - last >= 480) pace.steady = false;
      last = Date.now();
    },
  };
  return pace;
}
/** `press()` every `every` ms for `ms` (at least once); then false if the pace was not kept. */
async function pressRun(pace, every, ms, press, what) {
  const end = Date.now() + ms;
  try {
    do {
      pace.tick();
      await press();
      if (Date.now() < end) await sleep(every);
    } while (Date.now() < end);
  } catch {
    if (pace.steady) assert.fail(`${what} decided: the window closed`);
    return false;
  }
  return pace.steady;
}
/**
 * Clicks at `spot` every `every` ms for `ms`, then presses `key` (if any)
 * at once. Returns false when this computer could not keep the pace.
 */
async function clickRun(review, spot, every, ms, { key = null, pace = pacer() } = {}) {
  if (!(await pressRun(pace, every, ms, () => review.mouse.click(spot.x, spot.y), `a click every ${every} ms`))) return false;
  if (key) return pressRun(pace, 0, 0, () => review.keyboard.press(key), `${key} right after clicks every ${every} ms`);
  return true;
}
/** Presses `key` every `every` ms for `ms`. Returns false when this computer could not keep the pace. */
const keyRun = (review, key, every, ms, { pace = pacer() } = {}) =>
  pressRun(pace, every, ms, () => review.keyboard.press(key), `${key} every ${every} ms`);
/** Records the clicks Continue itself gets from now on (alive or not, decided or not): their detail. */
const countClicks = (review) =>
  review.evaluate(() => {
    window.__clicks = [];
    document.getElementById('allow').addEventListener('click', (event) => window.__clicks.push(event.detail), true);
  });
const clicksOf = (review) => review.evaluate(() => window.__clicks);
/**
 * Runs `attempt(review)` on a fresh window for the drainer, at most three
 * times: once more whenever it returns false (this computer too busy to keep
 * a run of clicks at pace). Whatever such a run left open is rejected.
 */
async function atPace(attempt) {
  for (let tries = 0; tries < 3; tries += 1) {
    const before = await history();
    const review = await openReview('claim');
    if (await attempt(review)) return;
    if (!review.isClosed()) await review.click('#reject').catch(() => {});
    await waitHistory(before + 1);
  }
  assert.fail('this computer was too busy to click at pace, three times');
}

await step('Continue is off when the window appears, Reject is not; Continue comes alive after a moment', async () => {
  const startHistory = await history();
  const review = await openReview('claim');
  const spot = await centre(review, '#allow');
  assert.equal(await review.evaluate(() => document.getElementById('reject').disabled), false, 'Reject works at once');
  // What Continue was at each press, as the window saw it.
  await review.evaluate(() => {
    window.__presses = [];
    window.addEventListener('pointerdown', () => window.__presses.push(document.body.dataset.continue), true);
  });
  // The window may have been on screen a while before this test saw it: the
  // window's focus event starts the wait again, as the window appearing does.
  await review.evaluate(() => window.dispatchEvent(new Event('focus')));
  const shownAt = Date.now();
  // A click the instant it appears does nothing. (A plain mouse click: an
  // element click waits for the element first, and may come too late.)
  await review.mouse.click(spot.x, spot.y);
  const clickedAt = Date.now();
  assert.deepEqual(await review.evaluate(() => window.__presses), ['arming'], 'the click came while Continue waited');
  await sleep(150);
  assert.equal(await history(), startHistory, 'the request is still held');
  assert.equal(await review.evaluate(() => document.getElementById('reject').disabled), false, 'Reject still works');
  assert.equal(await walletLog(), 0);
  await waitArmed(review);
  const waited = Date.now() - shownAt;
  assert.ok(waited >= 500, `Continue came alive after ${waited} ms`);
  assert.deepEqual(await continueState(review), { state: 'on', disabled: false });
  // The deciding click, a pause after the early one.
  await sleep(Math.max(0, PAUSE - (Date.now() - clickedAt)));
  await decideAt(review, spot);
  await waitHistory(startHistory + 1);
  assert.equal(await page.evaluate(() => window.__dapp.last.ok), true, 'Continue forwarded it once alive');
  assert.equal(await walletLog(), 1);
});

await step('Enter and Space do nothing while Continue waits; Enter on it works once it is alive', async () => {
  const startHistory = await history();
  const startWallet = await walletLog();
  const review = await openReview('claim');
  await review.evaluate(() => window.dispatchEvent(new Event('focus'))); // the wait starts again
  for (const key of ['Enter', 'Space', 'Enter', 'Space']) await review.keyboard.press(key);
  await sleep(1200);
  assert.equal(await history(), startHistory, 'no key decided');
  assert.equal(await walletLog(), startWallet);
  assert.equal((await continueState(review)).state, 'on');
  await review.focus('#allow');
  await decideKey(review, 'Enter');
  await waitHistory(startHistory + 1);
  assert.equal(await page.evaluate(() => window.__dapp.last.ok), true);
  assert.equal(await walletLog(), startWallet + 1);
});

await step('a press that began before Continue came alive does not count', async () => {
  const startHistory = await history();
  const startWallet = await walletLog();
  const review = await openReview('claim');
  const box = await (await review.$('#allow')).boundingBox();
  await review.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await review.evaluate(() => window.dispatchEvent(new Event('focus'))); // the wait starts again
  await review.mouse.down();
  assert.equal((await continueState(review)).state, 'arming', 'pressed while Continue waited');
  await waitArmed(review);
  await review.mouse.up();
  await sleep(600);
  assert.equal(await history(), startHistory, 'the release after it came alive decided nothing');
  // A fresh click, after a pause, does.
  await decide(review, '#allow');
  await waitHistory(startHistory + 1);
  assert.equal(await page.evaluate(() => window.__dapp.last.ok), true);
  assert.equal(await walletLog(), startWallet + 1);
});

await step('clicks every 100 ms where Continue appears never decide; Enter right after neither; one click after a pause does', async () => {
  await atPace(async (review) => {
    const startHistory = await history();
    const startWallet = await walletLog();
    const spot = await centre(review, '#allow');
    await countClicks(review);
    // As a "tap as fast as you can" page would have it, from the moment the
    // window appears (the focus event starts the wait again, as appearing
    // does); then Enter at once, on the Continue the clicks gave the focus.
    await review.evaluate(() => window.dispatchEvent(new Event('focus')));
    if (!(await clickRun(review, spot, 100, 3000, { key: 'Enter' }))) return false;
    await sleep(200);
    assert.equal((await continueState(review)).state, 'on', 'Continue came alive meanwhile');
    const clicks = await clicksOf(review);
    assert.ok(clicks.filter((d) => d > 0).length >= 10, 'the clicks reached the live Continue');
    assert.equal(clicks.at(-1), 0, 'Enter clicked Continue too');
    assert.equal(await history(), startHistory, 'clicks every 100 ms, then Enter: still held');
    assert.equal(await walletLog(), startWallet);
    // A pause, then one click: the user's own decision.
    await sleep(PAUSE);
    await decideAt(review, spot);
    await waitHistory(startHistory + 1);
    assert.equal(await page.evaluate(() => window.__dapp.last.ok), true, 'one click after a pause forwarded it');
    assert.equal(await walletLog(), startWallet + 1);
    return true;
  });
});

await step('clicks every 350 ms never decide, nor does Enter held down from before; Reject works', async () => {
  await atPace(async (review) => {
    const startHistory = await history();
    const startWallet = await walletLog();
    const spot = await centre(review, '#allow');
    await countClicks(review);
    await review.evaluate(() => window.dispatchEvent(new Event('focus'))); // the wait starts again
    if (!(await clickRun(review, spot, 350, 3000))) return false;
    await sleep(100);
    assert.equal((await continueState(review)).state, 'on', 'Continue came alive meanwhile');
    assert.ok((await clicksOf(review)).length >= 3, 'the clicks reached the live Continue');
    assert.equal(await history(), startHistory, 'clicks every 350 ms: still held');
    assert.equal(await walletLog(), startWallet);
    // Enter pressed down while Continue had no focus, then held as Continue gets it.
    await sleep(PAUSE);
    await review.evaluate(() => document.activeElement && document.activeElement.blur());
    await review.keyboard.down('Enter');
    await review.focus('#allow');
    const before = (await clicksOf(review)).length;
    for (let i = 0; i < 5; i += 1) {
      await review.keyboard.down('Enter'); // a repeat of the key held down
      await sleep(50);
    }
    await review.keyboard.up('Enter');
    await sleep(200);
    assert.ok((await clicksOf(review)).length > before, 'the held key clicked Continue');
    assert.equal(await history(), startHistory, 'a key held down: still held');
    assert.equal(await walletLog(), startWallet);
    await decide(review, '#reject');
    await waitHistory(startHistory + 1);
    assert.equal(await page.evaluate(() => window.__dapp.last.code), 4001);
    assert.equal(await walletLog(), startWallet);
    return true;
  });
});

await step('clicks every 100 ms, then Space every 100 ms on the Continue they focused, never decide; one Space after a pause does', async () => {
  await atPace(async (review) => {
    const startHistory = await history();
    const startWallet = await walletLog();
    const spot = await centre(review, '#allow');
    await countClicks(review);
    // "Tap fast, then mash Space": the clicks give the live Continue the focus.
    await review.evaluate(() => window.dispatchEvent(new Event('focus'))); // the wait starts again
    const pace = pacer();
    if (!(await clickRun(review, spot, 100, 3000, { pace }))) return false;
    if (!(await keyRun(review, 'Space', 100, 2000, { pace }))) return false;
    await sleep(200);
    assert.equal(await review.evaluate(() => document.activeElement.id), 'allow', 'Continue had the focus');
    assert.ok((await clicksOf(review)).filter((d) => d === 0).length >= 10, 'Space clicked the live Continue');
    assert.equal(await history(), startHistory, 'clicks, then Space every 100 ms: still held');
    assert.equal(await walletLog(), startWallet);
    // A pause, then one Space: the user's own decision.
    await sleep(PAUSE);
    await decideKey(review, 'Space');
    await waitHistory(startHistory + 1);
    assert.equal(await page.evaluate(() => window.__dapp.last.ok), true, 'one Space after a pause forwarded it');
    assert.equal(await walletLog(), startWallet + 1);
    return true;
  });
});

await step('one Shift+Tab from a fresh window never reaches Continue; Enter right after a key does nothing; after a pause it does', async () => {
  const shiftTab = async (review) => {
    await review.keyboard.down('Shift');
    await review.keyboard.press('Tab');
    await review.keyboard.up('Shift');
  };
  const focused = (review) =>
    review.evaluate(() => (document.activeElement === document.body ? 'body' : document.activeElement.id || document.activeElement.className));
  await atPace(async (review) => {
    const startHistory = await history();
    const startWallet = await walletLog();
    await waitArmed(review);
    await sleep(PAUSE);
    assert.equal(await focused(review), 'body', 'a fresh window: nothing has the focus');
    // One Shift+Tab, then Enter at once ("press Shift+Tab, then Enter").
    await shiftTab(review);
    await review.keyboard.press('Enter');
    assert.equal(await focused(review), 'hold', 'one Shift+Tab lands after Continue, not on it');
    await sleep(150);
    assert.equal(await history(), startHistory, 'Enter there decided nothing');
    // A second Shift+Tab reaches Continue; Enter within 100 ms of it does nothing.
    const pace = pacer();
    pace.tick();
    await shiftTab(review);
    if (!(await pressRun(pace, 0, 0, () => review.keyboard.press('Enter'), 'Enter right after Shift+Tab'))) return false;
    await sleep(PAUSE);
    assert.equal(await focused(review), 'allow', 'the second Shift+Tab reached Continue');
    assert.equal(await history(), startHistory, 'Shift+Tab, then Enter at once: still held');
    assert.equal(await walletLog(), startWallet);
    // After the pause, Enter is the user's decision.
    await decideKey(review, 'Enter');
    await waitHistory(startHistory + 1);
    assert.equal(await page.evaluate(() => window.__dapp.last.ok), true, 'Enter after a pause forwarded it');
    assert.equal(await walletLog(), startWallet + 1);
    return true;
  });
});

await step('typing words while Continue has the focus never decides', async () => {
  await atPace(async (review) => {
    const startHistory = await history();
    const startWallet = await walletLog();
    await waitArmed(review);
    await sleep(PAUSE);
    await review.focus('#allow'); // as a run of clicks leaves it
    await countClicks(review);
    // "Type your name": a space every few letters, at a quick typist's pace.
    const pace = pacer();
    try {
      for (const key of 'my name is') {
        pace.tick();
        await review.keyboard.type(key);
        await sleep(100);
      }
    } catch {
      if (pace.steady) assert.fail('typing decided: the window closed');
      return false;
    }
    if (!pace.steady) return false;
    await sleep(200);
    assert.deepEqual(await clicksOf(review), [0, 0], 'each space clicked Continue');
    assert.equal(await history(), startHistory, 'typing: still held');
    assert.equal(await walletLog(), startWallet);
    await decide(review, '#reject');
    await waitHistory(startHistory + 1);
    assert.equal(await page.evaluate(() => window.__dapp.last.code), 4001);
    assert.equal(await walletLog(), startWallet);
    return true;
  });
});

await step('a click no pointer or key made (as a screen reader makes it) counts after a pause in pressing, not right after a click', async () => {
  const startHistory = await history();
  const startWallet = await walletLog();
  const review = await openReview('claim');
  await waitArmed(review);
  const press = () => review.evaluate(() => document.getElementById('allow').click());
  const headline = await centre(review, '#headline');
  await review.mouse.click(headline.x, headline.y);
  await press();
  await sleep(200);
  assert.equal(await history(), startHistory, 'right after a click: still held');
  await sleep(PAUSE);
  await press().catch(() => {}); // the window may close at once
  await waitHistory(startHistory + 1);
  assert.equal(await page.evaluate(() => window.__dapp.last.ok), true, 'after a pause it forwarded the request');
  assert.equal(await walletLog(), startWallet + 1);
});

await step('an honest single click, and a double-click, on a live Continue forward the request once', async () => {
  const startWallet = await walletLog();
  for (const count of [1, 2]) {
    const startHistory = await history();
    const review = await openReview('claim');
    await waitArmed(review);
    await sleep(300);
    const spot = await centre(review, '#allow');
    // The window closes on the first click of a double-click: the second may find it gone.
    await review.mouse.click(spot.x, spot.y, { count }).catch(() => {});
    await waitHistory(startHistory + 1);
    assert.equal(await page.evaluate(() => window.__dapp.last.ok), true, `${count} click(s) forwarded it`);
  }
  await sleep(300);
  assert.equal(await walletLog(), startWallet + 2, 'once each');
});

await step('a press on a live Continue that does not count says so, and the buttons do not move; the next one after a pause forwards once', async () => {
  const startHistory = await history();
  const startWallet = await walletLog();
  const review = await openReview('claim');
  await waitArmed(review);
  await sleep(PAUSE);
  const spot = await centre(review, '#allow');
  const headline = await centre(review, '#headline');
  const boxes = () =>
    review.evaluate(() => {
      const box = (el) => (el ? (({ top, bottom, left, right }) => ({ top, bottom, left, right }))(el.getBoundingClientRect()) : null);
      return { allow: box(document.getElementById('allow')), reject: box(document.getElementById('reject')), note: box(document.querySelector('#again span')) };
    });
  const before = await boxes();
  assert.equal(before.note, null, 'no note at first');
  // A click in the window, then one on the live Continue right after it.
  await review.mouse.click(headline.x, headline.y);
  await sleep(250);
  await review.mouse.click(spot.x, spot.y);
  await sleep(150);
  assert.equal(await history(), startHistory, 'still held');
  assert.equal(await review.evaluate(() => document.getElementById('again').textContent), 'Continue counts a press only after a short pause. Press it again to confirm.');
  const after = await boxes();
  assert.deepEqual([after.allow, after.reject], [before.allow, before.reject], 'the buttons did not move');
  assert.ok(after.note.bottom <= after.allow.top && after.note.bottom > after.note.top, 'the note shows above the buttons');
  // After a pause, the next click is the user's decision.
  await sleep(PAUSE);
  await decideAt(review, spot);
  await waitHistory(startHistory + 1);
  assert.equal(await page.evaluate(() => window.__dapp.last.ok), true);
  await sleep(300);
  assert.equal(await walletLog(), startWallet + 1, 'forwarded once');
});

// ── The page goes to another page while its window is open ─────────────────
// The old page waits in the back/forward cache: Chrome holds every message to
// it, unanswered, until it is shown again.
const isOpen = (review) => browser.targets().some((t) => t.url() === review.url());
async function closesWithin(review, ms) {
  const started = Date.now();
  while (isOpen(review) && Date.now() - started < ms) await sleep(50);
  return isOpen(review) ? null : Date.now() - started;
}
async function demoTab() {
  const tab = await browser.newPage();
  await tab.goto(DEMO, { waitUntil: 'load' });
  await tab.waitForFunction(() => Array.isArray(window.__mockWalletLog));
  // Still there after Back only if this very page came back from the cache.
  await tab.evaluate(() => (window.__kept = true));
  return tab;
}
const cameBack = (tab) =>
  tab.waitForFunction(() => window.__kept === true, { timeout: 8000, polling: 100 }).then(
    () => true,
    () => false,
  );

await step('a page that went to another page: Reject in its window still closes the window, and the page gets 4001 when it is back', async () => {
  for (const away of [DEMO.replace('?mock=1', '?mock=1&away=1'), 'about:blank']) {
    const tab = await demoTab();
    try {
      const review = await openReview('claim', tab);
      await tab.goto(away, { waitUntil: 'load' });
      await sleep(1500); // the tab's own check for gone pages runs meanwhile
      assert.equal(isOpen(review), true, `${away}: the window stays, the page may come back`);
      await review.bringToFront();
      await decide(review, '#reject');
      const ms = await closesWithin(review, 2000);
      assert.notEqual(ms, null, `${away}: the window closed after Reject`);
      await tab.goBack({ timeout: 5000 }).catch(() => {});
      assert.equal(await cameBack(tab), true, `${away}: the same page came back from the cache`);
      await tab.waitForFunction(() => window.__dapp.history.length === 1, { timeout: 5000, polling: 100 });
      assert.equal(await tab.evaluate(() => window.__dapp.last.code), 4001, `${away}: the page got the user's answer`);
      assert.equal(await tab.evaluate(() => window.__mockWalletLog.length), 0);
    } finally {
      await tab.close().catch(() => {});
    }
  }
});

await step('a page that went away and came back before the user decided: Continue forwards its request once', async () => {
  const tab = await demoTab();
  try {
    const review = await openReview('claim', tab);
    await tab.goto(DEMO.replace('?mock=1', '?mock=1&away=1'), { waitUntil: 'load' });
    await sleep(1500);
    await tab.goBack({ timeout: 5000 }).catch(() => {});
    assert.equal(await cameBack(tab), true, 'the same page came back from the cache');
    await sleep(1500);
    assert.equal(isOpen(review), true, 'the window is still open');
    await review.bringToFront();
    await review.evaluate(() => window.dispatchEvent(new Event('focus'))); // the wait starts again
    await waitArmed(review);
    await sleep(PAUSE);
    await decide(review, '#allow');
    await tab.waitForFunction(() => window.__dapp.history.length === 1, { timeout: 5000, polling: 100 });
    assert.equal(await tab.evaluate(() => window.__dapp.last.ok), true, 'Continue forwarded it');
    await sleep(500);
    assert.equal(await tab.evaluate(() => window.__mockWalletLog.length), 1, 'once');
  } finally {
    await tab.close().catch(() => {});
  }
});

await step('a page that goes away and comes back quickly, five times, keeps its window; Reject then gives 4001 once', async () => {
  const tab = await demoTab();
  try {
    const review = await openReview('claim', tab);
    for (let trip = 1; trip <= 5; trip += 1) {
      await tab.goto(DEMO.replace('?mock=1', `?mock=1&away=${trip}`), { waitUntil: 'load' });
      await sleep(400);
      await tab.goBack({ timeout: 5000 }).catch(() => {});
      assert.equal(await cameBack(tab), true, `trip ${trip}: the same page came back from the cache`);
      await sleep(400);
      assert.equal(isOpen(review), true, `trip ${trip}: the window stays`);
    }
    // Every check the trips started has ended meanwhile.
    await sleep(2500);
    assert.equal(isOpen(review), true, 'the window stays until the user decides');
    assert.equal(await tab.evaluate(() => window.__dapp.history.length), 0, 'the page has no answer yet');
    await review.bringToFront();
    await decide(review, '#reject');
    await tab.waitForFunction(() => window.__dapp.history.length === 1, { timeout: 5000, polling: 100 });
    assert.equal(await tab.evaluate(() => window.__dapp.last.code), 4001, 'the user’s answer');
    await sleep(1000);
    assert.equal(await tab.evaluate(() => window.__dapp.history.length), 1, 'given once');
    assert.equal(await tab.evaluate(() => window.__mockWalletLog.length), 0);
  } finally {
    await tab.close().catch(() => {});
  }
});

// ── Where a second window opens ────────────────────────────────────────────
// A page cannot place a review window: not by opening a popup of its own,
// sized and placed so that the next window's Continue would cover the open
// window's Reject.
const bounds = (review) =>
  review.evaluate(async () => {
    const { left, top, width, height } = await chrome.windows.getCurrent();
    const box = (id) => (({ x, y, width: w, height: h }) => ({ x, y, width: w, height: h }))(document.getElementById(id).getBoundingClientRect());
    return { left, top, width, height, bar: window.outerHeight - window.innerHeight, reject: box('reject'), allow: box('allow') };
  });
const onScreen = (w, b) => ({ left: w.left + b.x, right: w.left + b.x + b.width, top: w.top + w.bar + b.y, bottom: w.top + w.bar + b.y + b.height });
await step('a second window opens exactly over the first, never with its Continue on the first window’s Reject', async () => {
  const startHistory = await history();
  const first = await openReview('claim');
  const w1 = await bounds(first);
  const reject = onScreen(w1, w1.reject);
  const aim = { x: (reject.left + reject.right) / 2, y: (reject.top + reject.bottom) / 2 };
  // Where the next window would open if it were placed by the popup: at the
  // popup's right edge, its Continue's middle on that Reject.
  const wantLeft = Math.round(aim.x - (w1.allow.x + w1.allow.width / 2));
  const popupBefore = new Set(browser.targets());
  await page.evaluate((left, top) => {
    window.__second = window.open(`${location.pathname}?mock=1&second=1`, 'second', `popup,left=${left},top=${top},width=500,height=400`);
  }, wantLeft - 500 + 444, w1.top - 88);
  const popup = await (await browser.waitForTarget((t) => !popupBefore.has(t) && t.url().includes('second=1'), { timeout: 8000 })).asPage();
  await popup.waitForFunction(() => Array.isArray(window.__mockWalletLog) && window.__ibitiGuardian === true);
  try {
    const before = new Set(browser.targets());
    await popup.evaluate((spender) => {
      window.__out = null;
      const data = `0x095ea7b3${spender.slice(2).padStart(64, '0')}${'f'.repeat(64)}`;
      window.ethereum
        .request({ method: 'eth_sendTransaction', params: [{ from: '0x' + '11'.repeat(20), to: '0xdAC17F958D2ee523a2206206994597C13D831ec7', data }] })
        .then((r) => (window.__out = { ok: r }), (e) => (window.__out = { code: e.code }));
    }, OTHER);
    const target = await browser.waitForTarget((t) => !before.has(t) && t.url().includes('/review.html'), { timeout: 10000 });
    const second = await target.asPage();
    await second.waitForFunction(() => document.getElementById('badge').textContent !== '', { timeout: 10000 });
    const w2 = await bounds(second);
    const cont = onScreen(w2, w2.allow);
    const covers = aim.x >= cont.left && aim.x <= cont.right && aim.y >= cont.top && aim.y <= cont.bottom;
    assert.equal(covers, false, 'the second window’s Continue is not where the first window’s Reject is');
    assert.deepEqual([w2.left, w2.top, w2.width, w2.height], [w1.left, w1.top, w1.width, w1.height], 'exactly over the first');
    await decide(second, '#reject');
    await popup.waitForFunction(() => window.__out !== null, { timeout: 5000, polling: 100 });
    assert.equal(await popup.evaluate(() => window.__out.code), 4001);
    assert.equal(await popup.evaluate(() => window.__mockWalletLog.length), 0);
    // With no review window open, a request from the popup does not open where the popup points either.
    await first.bringToFront();
    await decide(first, '#reject');
    await waitHistory(startHistory + 1);
    const again = new Set(browser.targets());
    await popup.evaluate(() => {
      window.__out = null;
      window.ethereum.request({ method: 'personal_sign', params: ['0x48656c6c6f', '0x' + '11'.repeat(20)] }).then(
        (r) => (window.__out = { ok: r }),
        (e) => (window.__out = { code: e.code }),
      );
    });
    const third = await (await browser.waitForTarget((t) => !again.has(t) && t.url().includes('/review.html'), { timeout: 10000 })).asPage();
    await third.waitForFunction(() => document.getElementById('badge').textContent !== '', { timeout: 10000 });
    const w3 = await bounds(third);
    assert.notEqual(w3.left, wantLeft, 'not at the spot the popup was placed for');
    await decide(third, '#reject');
    await popup.waitForFunction(() => window.__out !== null, { timeout: 5000, polling: 100 });
    assert.equal(await popup.evaluate(() => window.__out.code), 4001);
  } finally {
    await popup.close().catch(() => {});
  }
});

// A window for a page in another browser window opens by that window: over
// another site's open window, a click meant for that site's Continue would
// land on this request.
await step('a window for a page in another browser window opens by that window, never over the open one; the same page’s next one opens over its own', async () => {
  const startHistory = await history();
  const startWallet = await walletLog();
  const first = await openReview('claim');
  const w1 = await bounds(first);
  // A demo page in a second browser window, further right on the screen.
  const cdp = await browser.target().createCDPSession();
  const pagesBefore = new Set(browser.targets());
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  const other = await (await browser.waitForTarget((t) => !pagesBefore.has(t) && t.type() === 'page', { timeout: 8000 })).asPage();
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 1100, top: 120, width: 700, height: 800 } });
    await other.goto(DEMO, { waitUntil: 'load' });
    await other.waitForFunction(() => Array.isArray(window.__mockWalletLog));
    const second = await openReview('claim', other);
    const w2 = await bounds(second);
    const apart = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
    const whole = (w) => ({ left: w.left, right: w.left + w.width, top: w.top, bottom: w.top + w.height });
    assert.equal(apart(whole(w2), whole(w1)), true, 'the second window is not over the first');
    const cont = onScreen(w2, w2.allow);
    assert.equal(apart(cont, onScreen(w1, w1.reject)), true, 'its Continue is not over the first window’s Reject');
    assert.equal(apart(cont, onScreen(w1, w1.allow)), true, 'its Continue is not over the first window’s Continue');
    // The first page asks again once the user has moved its window: the new
    // window opens exactly over that one.
    await first.evaluate(() => chrome.windows.update(chrome.windows.WINDOW_ID_CURRENT, { left: 200, top: 150 }));
    const moved = await bounds(first);
    const third = await openReview('claim');
    const w3 = await bounds(third);
    assert.deepEqual([w3.left, w3.top, w3.width, w3.height], [moved.left, moved.top, moved.width, moved.height], 'over the same page’s own window');
    for (const review of [third, second, first]) {
      await review.bringToFront();
      await decide(review, '#reject');
    }
    await waitHistory(startHistory + 2);
    await other.waitForFunction(() => window.__dapp.history.length === 1, { timeout: 5000, polling: 100 });
    assert.equal(await page.evaluate(() => window.__dapp.last.code), 4001);
    assert.equal(await other.evaluate(() => window.__dapp.last.code), 4001);
    assert.equal(await walletLog(), startWallet);
    assert.equal(await other.evaluate(() => window.__mockWalletLog.length), 0);
  } finally {
    await other.close().catch(() => {});
    await cdp.detach().catch(() => {});
  }
});

await step('losing focus turns Continue off again; back in focus it waits once more', async () => {
  const startHistory = await history();
  const review = await openReview('claim');
  await waitArmed(review);
  await review.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.deepEqual(await continueState(review), { state: 'off', disabled: true });
  await review.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.deepEqual(await continueState(review), { state: 'arming', disabled: true });
  await waitArmed(review);
  await decide(review, '#reject');
  await waitHistory(startHistory + 1);
  assert.equal(await page.evaluate(() => window.__dapp.last.code), 4001);
});

// A review page in a tab for a record put straight into Guardian's storage,
// with `before` run in it before any of its scripts.
let helper = null;
async function reviewOf(id, record, before) {
  if (!helper) {
    helper = await browser.newPage();
    await helper.goto(`${EXT_ORIGIN}/popup.html`);
  }
  await helper.evaluate((key, value) => chrome.storage.session.set({ [key]: value }), `review:${id}`, record);
  const tab = await browser.newPage();
  const errors = [];
  tab.on('pageerror', (error) => errors.push(error.message));
  if (before) await tab.evaluateOnNewDocument(before);
  await tab.goto(`${EXT_ORIGIN}/review.html?id=${encodeURIComponent(id)}`);
  await tab.waitForFunction(() => document.getElementById('headline').textContent !== 'Checking the request…', { timeout: 5000 });
  return { tab, errors };
}
const stored = (id) => helper.evaluate(async (key) => (await chrome.storage.session.get(key))[key] !== undefined, `review:${id}`);
const view = (tab) =>
  tab.evaluate(() => ({
    render: document.body.dataset.render || '',
    risk: document.body.dataset.risk,
    badge: document.getElementById('badge').textContent,
    headline: document.getElementById('headline').textContent,
    note: !document.getElementById('render-note').hidden,
    allow: !document.getElementById('allow').disabled,
    reject: !document.getElementById('reject').disabled,
  }));

const PAYMENT = {
  origin: 'https://shop.example',
  method: 'eth_sendTransaction',
  params: [{ from: ME, to: OTHER, value: '0x2386f26fc10000' }],
  chainId: 1,
  enrich: { accounts: [ME], balance: '0xde0b6b3a7640000' },
  createdAt: Date.now(),
};

await step('a request the window cannot draw: Reject works, Continue stays off, never "No red flags"', async () => {
  const { tab } = await reviewOf('cannot-draw', PAYMENT, () => {
    const create = Document.prototype.createElement;
    Document.prototype.createElement = function (name, ...rest) {
      if (String(name).toLowerCase() === 'dt') throw new Error('test: cannot draw this field');
      return create.call(this, name, ...rest);
    };
  });
  try {
    await sleep(1200);
    const shown = await view(tab);
    assert.equal(shown.render, 'failed');
    assert.equal(shown.note, true, 'the note says not all details could be displayed');
    assert.equal(shown.allow, false, 'Continue stays off');
    assert.equal(shown.reject, true);
    assert.notEqual(shown.badge, 'No red flags found');
    assert.notEqual(shown.risk, 'info');
    await tab.click('#allow').catch(() => {});
    assert.equal(await stored('cannot-draw'), true, 'Continue decided nothing');
    await decide(tab, '#reject');
    await helper.waitForFunction(async (key) => (await chrome.storage.session.get(key))[key] === undefined, { timeout: 5000 }, 'review:cannot-draw');
  } finally {
    await tab.close().catch(() => {});
  }
});

await step('a date the analyzer cannot show does not leave the window stuck: Reject works', async () => {
  const soon = Math.floor(Date.now() / 1000) + 3600;
  const permit = {
    ...PAYMENT,
    method: 'eth_signTypedData_v4',
    params: [
      ME,
      JSON.stringify({
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
          Permit: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        primaryType: 'Permit',
        domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
        message: { owner: ME, spender: OTHER, value: '1000000', nonce: 0, deadline: soon },
      }),
    ],
  };
  // Every date fails to format, as an out-of-range one does.
  const { tab } = await reviewOf('bad-date', permit, () => {
    Date.prototype.toISOString = () => {
      throw new RangeError('Invalid time value');
    };
  });
  try {
    await sleep(1200);
    const shown = await view(tab);
    assert.notEqual(shown.headline, 'Checking the request…');
    if (shown.render === 'failed') {
      assert.equal(shown.note, true);
      assert.equal(shown.allow, false, 'Continue stays off');
    }
    assert.equal(shown.reject, true);
    await decide(tab, '#reject');
    await helper.waitForFunction(async (key) => (await chrome.storage.session.get(key))[key] === undefined, { timeout: 5000 }, 'review:bad-date');
  } finally {
    await tab.close().catch(() => {});
  }
});

await step('an account only the page reported is never called the user’s own in what may be sent', async () => {
  const record = { ...PAYMENT, enrich: { accounts: [ME, OTHER], balance: `0x${'f'.repeat(64)}` } };
  const { tab } = await reviewOf('reported', record);
  try {
    await tab.waitForFunction(() => Boolean(document.body.dataset.local), { timeout: 5000 });
    const sent = await tab.evaluate(() => ({
      cloud: document.body.dataset.cloud === 'off' ? null : document.getElementById('cloud-sent').textContent,
      local: document.getElementById('local-sent').textContent,
    }));
    const texts = [sent.cloud, sent.local].filter(Boolean);
    if (texts.length === 0) {
      results.push('     (no Firebase settings in this build: no prompt to check)');
    }
    for (const text of texts) {
      assert.ok(!text.toLowerCase().includes(OTHER.slice(2)), 'the address is kept out');
      assert.ok(!text.toLowerCase().includes(ME.slice(2)), 'the user’s own is kept out');
      assert.doesNotMatch(text, /To: \(your own wallet\)/, 'the recipient is not called the user’s own');
    }
  } finally {
    await tab.close().catch(() => {});
  }
});

const hex = (text) => `0x${Buffer.from(text, 'utf8').toString('hex')}`;
const signText = (origin, text) => ({ origin, method: 'personal_sign', params: [hex(text), ME], chainId: 1, enrich: {}, createdAt: Date.now() });
const messageView = (tab) =>
  tab.evaluate(() => ({
    text: document.getElementById('message-text').textContent,
    cut: document.getElementById('message-cut').hidden ? '' : document.getElementById('message-cut').textContent,
  }));
const rejectIn = async (tab, id) => {
  await tab.bringToFront(); // a click in a tab behind another never lands
  await decide(tab, '#reject');
  await helper.waitForFunction(async (key) => (await chrome.storage.session.get(key))[key] === undefined, { timeout: 5000 }, `review:${id}`);
};

await step('a long text message is shown whole, its last line included', async () => {
  // Over 4,000 characters, with its last line far down: the box scrolls.
  const tail = `I also authorise ${OTHER} to act for this account.`;
  const text = `Welcome to Example Rewards!\nSign this message to check your eligibility.\n${' \n'.repeat(2000)}${tail}`;
  const { tab, errors } = await reviewOf('long-message', signText('https://rewards.example', text));
  try {
    const shown = await messageView(tab);
    assert.equal(shown.text.length, text.length, 'the whole message');
    assert.ok(shown.text.endsWith(tail), 'its last line too');
    assert.equal(shown.cut, '', 'nothing said to be cut');
    const drawn = await view(tab);
    assert.equal(drawn.render, '', 'drawn in full');
    assert.equal(drawn.note, false);
    // Continue comes alive as on any other request.
    await tab.bringToFront();
    await tab.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitArmed(tab);
    assert.deepEqual(errors, []);
    await rejectIn(tab, 'long-message');
  } finally {
    await tab.close().catch(() => {});
  }
});

await step('a message too long to show says how much is shown, keeps Continue off and is never "No red flags"', async () => {
  const tail = `I also authorise ${OTHER} to act for this account.`;
  const text = `${'Sign to check your eligibility. '.repeat(4000)}${tail}`;
  const { tab } = await reviewOf('too-long', signText('https://rewards.example', text));
  try {
    await tab.bringToFront();
    await tab.evaluate(() => window.dispatchEvent(new Event('focus')));
    await sleep(1200);
    const shown = await messageView(tab);
    assert.equal(shown.text.length, 100000);
    assert.equal(shown.cut, `Guardian shows the first 100,000 of ${text.length.toLocaleString('en-US')} characters.`);
    const drawn = await view(tab);
    assert.equal(drawn.render, 'failed');
    assert.equal(drawn.note, true, 'the note says not all details could be displayed');
    assert.equal(drawn.allow, false, 'Continue stays off');
    assert.equal(drawn.reject, true);
    assert.notEqual(drawn.badge, 'No red flags found');
    assert.notEqual(drawn.risk, 'info');
    await tab.click('#allow').catch(() => {});
    assert.equal(await stored('too-long'), true, 'Continue decided nothing');
    await rejectIn(tab, 'too-long');
  } finally {
    await tab.close().catch(() => {});
  }
});

await step('a site with no address of its own is named as one Guardian cannot identify', async () => {
  // A sandboxed frame's origin is "null".
  for (const [id, origin, shown] of [
    ['no-address', 'null', 'A site Guardian cannot identify'],
    ['named', 'https://shop.example', 'shop.example'],
  ]) {
    const { tab } = await reviewOf(id, signText(origin, 'Hello'));
    try {
      assert.equal(await tab.evaluate(() => document.getElementById('origin').textContent), shown, origin);
      await rejectIn(tab, id);
    } finally {
      await tab.close().catch(() => {});
    }
  }
});

await step('a site with no address of its own is never "null" or blank in the sentence or in what may be sent', async () => {
  const siwe = `app.example wants you to sign in with your Ethereum account:\n${ME}\n\nSign in.\n\nURI: https://app.example\nVersion: 1\nChain ID: 1\nNonce: abcdefgh12\nIssued At: 2026-11-24T00:00:00Z`;
  const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
  const approve = {
    ...PAYMENT,
    origin: 'null',
    params: [{ from: ME, to: USDT, data: `0x095ea7b3${OTHER.slice(2).padStart(64, '0')}${'f'.repeat(64)}` }],
    enrich: { accounts: [ME] },
  };
  const cases = [
    ['null-text', signText('null', 'Hello')],
    ['null-siwe', signText('null', siwe)],
    ['null-approve', approve],
    ['file-text', signText('file://', 'Hello')],
    ['blank-text', signText('', 'Hello')],
  ];
  let prompts = 0;
  for (const [id, record] of cases) {
    const { tab } = await reviewOf(id, record);
    try {
      await tab.waitForFunction(() => Boolean(document.body.dataset.local), { timeout: 5000 });
      const shown = await tab.evaluate(() => ({
        sentence: document.getElementById('local-text').textContent,
        local: document.getElementById('local-sent').textContent,
        cloud: document.body.dataset.cloud === 'off' ? '' : document.getElementById('cloud-sent').textContent,
      }));
      for (const [where, text] of Object.entries(shown)) {
        assert.doesNotMatch(text, /\bnull\b|website\s+asked|from\s*,/, `${id}: ${where}`);
      }
      for (const text of [shown.local, shown.cloud].filter(Boolean)) {
        assert.match(text, /^The website a site Guardian cannot identify asked the user's crypto wallet/m, id);
        prompts += 1;
      }
      await rejectIn(tab, id);
    } finally {
      await tab.close().catch(() => {});
    }
  }
  if (prompts === 0) results.push('     (no Firebase settings in this build: no prompt to check)');
});

await step('never "No red flags": a sign-in for another site behind an account written "0X…", a message in hex digits without 0x, or an approval just under the largest number', async () => {
  const siwe = `app.evil.example wants you to sign in with your Ethereum account:\n${ME}\n\nNonce: abcdefgh12`;
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const cases = [
    ['upper-siwe', { ...signText('https://site.example', siwe), params: ['0X' + ME.slice(2), hex(siwe)] }, 'High risk', 'Sign-in request for a different site'],
    ['upper-hash', { ...signText('https://site.example', ''), params: ['0X' + ME.slice(2), '0x' + 'ab'.repeat(32)] }, 'Check carefully', 'Signature for unreadable data'],
    // Hex digits without 0x, or with 0X: MetaMask signs the data they stand for.
    ['bare-hash', { ...signText('https://site.example', ''), params: ['ab'.repeat(32), ME] }, 'Check carefully', 'Signature for unreadable data'],
    ['bare-siwe', { ...signText('https://site.example', ''), params: ['0X' + hex(siwe).slice(2), ME] }, 'High risk', 'Sign-in request for a different site'],
    [
      'near-max',
      { ...PAYMENT, params: [{ from: ME, to: USDC, data: `0x095ea7b3${OTHER.slice(2).padStart(64, '0')}${((1n << 200n) - 1n).toString(16).padStart(64, '0')}` }] },
      'High risk',
      'Unlimited spending permission for USDC',
    ],
  ];
  for (const [id, record, badge, headline] of cases) {
    const { tab } = await reviewOf(id, record);
    try {
      const shown = await view(tab);
      assert.deepEqual([shown.badge, shown.headline], [badge, headline], id);
      assert.equal(await tab.evaluate(() => document.querySelector('.actions .primary').id), 'reject', `${id}: Reject is the main button`);
      await rejectIn(tab, id);
    } finally {
      await tab.close().catch(() => {});
    }
  }
});

await step('the demo promises calm on its ordinary requests only with the demo wallet', async () => {
  const title = (tab) => tab.evaluate(() => document.getElementById('calm-title').textContent);
  const tab = await browser.newPage();
  try {
    // A real wallet, as the local page finds one with ?wallet=real (only ever on a test network there).
    await tab.evaluateOnNewDocument(() => {
      const provider = { request: async () => null, on() {}, removeListener() {} };
      const info = { uuid: 'test', name: 'Test wallet', icon: 'data:,', rdns: 'io.example.wallet' };
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
      window.addEventListener('eip6963:requestProvider', announce);
    });
    await tab.goto(DEMO.replace('?mock=1', '?wallet=real'), { waitUntil: 'load' });
    await tab.waitForFunction(() => window.__dapp && window.__dapp.wallet === 'io.example.wallet', { timeout: 5000 });
    assert.equal(await title(tab), 'Ordinary requests');
    await tab.goto(DEMO, { waitUntil: 'load' });
    await tab.waitForFunction(() => window.__dapp && window.__dapp.wallet === 'dev.ibiti.demo-wallet', { timeout: 5000 });
    assert.equal(await title(tab), 'Ordinary requests: Guardian stays calm');
  } finally {
    await tab.close().catch(() => {});
  }
});

await helper?.close();
await browser.close();
demo.close();

// ── The hosted preview under the site's own headers ─────────────────────────

await step('the hosted preview works under the site’s frame headers, and another site cannot frame it', async () => {
  assert.ok(existsSync(path.join(SITE, 'index.html')), `no built site in ${SITE}`);
  const rules = JSON.parse(readFileSync('firebase.json', 'utf8')).hosting.headers.find((h) => h.source === '**').headers;
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
  const site = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    let file = path.join(SITE, pathname);
    if (!file.startsWith(SITE)) return response.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file)) return response.writeHead(404).end();
    response.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      ...Object.fromEntries(rules.map((h) => [h.key, h.value])),
    });
    createReadStream(file).pipe(response);
  });
  const siteOrigin = await listen(site);
  // Another site that puts the demo in a frame.
  const other = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><iframe id="f" src="${siteOrigin}/?mock=1" width="800" height="600"></iframe>`);
  });
  const otherOrigin = await listen(other);
  const plain = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const tab = await plain.newPage();
    await tab.setViewport({ width: 1280, height: 860 });
    await tab.goto(`${siteOrigin}/?mock=1`, { waitUntil: 'load' });
    await tab.waitForFunction(() => window.__ibitiGuardianPreview === true && Array.isArray(window.__mockWalletLog));
    await tab.click('#claim');
    const handle = await tab.waitForFunction(
      () => {
        const host = document.getElementById('ibiti-guardian-preview');
        const frame = host && host.shadowRoot.querySelector('iframe');
        const doc = frame && frame.contentDocument;
        return doc && doc.getElementById('badge') && doc.getElementById('badge').textContent !== '' ? frame : null;
      },
      { timeout: 15000, polling: 100 },
    );
    const frame = await (await handle.asElement()).contentFrame();
    assert.equal((await frame.evaluate(() => document.body.dataset.continue)) !== 'on', true, 'Continue waits in the preview too');
    await frame.click('#allow').catch(() => {});
    const early = Date.now();
    await sleep(200);
    assert.equal(await tab.evaluate(() => window.__mockWalletLog.length), 0, 'an early click did nothing');
    // A plain check loop: waitForFunction can miss a freshly loaded frame (test/site.mjs).
    const end = Date.now() + 5000;
    while ((await frame.evaluate(() => document.getElementById('allow').disabled)) && Date.now() < end) await sleep(50);
    // The deciding click comes after a pause in clicking, as in the extension.
    await sleep(Math.max(0, 600 - (Date.now() - early)));
    await decide(frame, '#allow');
    await tab.waitForFunction(() => window.__mockWalletLog.length === 1, { timeout: 10000, polling: 100 });

    const framed = await plain.newPage();
    await framed.goto(`${otherOrigin}/`, { waitUntil: 'load' });
    await sleep(800);
    const inner = framed.frames().find((f) => f !== framed.mainFrame());
    const loaded = inner ? await inner.evaluate(() => Boolean(document.getElementById('claim'))).catch(() => false) : false;
    assert.equal(loaded, false, 'the site does not load inside another site');
  } finally {
    await plain.close();
    site.close();
    other.close();
  }
});

console.log(results.join('\n'));
console.log(process.exitCode ? '\nSome checks failed.' : '\nAll checks passed.');
