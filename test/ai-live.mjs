// Live check of Guardian's AI on every demo scenario, through the cloud (the
// test browser has no Gemini Nano): the hybrid fallback explanation and the
// deeper analysis. Records what Gemini answered, whether Guardian's checks
// let it through or withheld it, and how long it took.
//
//   GUARDIAN_OUT=dist/dev ROUNDS=2 node test/ai-live.mjs     (demo served at 127.0.0.1:5179)
//
// Uses the Firebase project's free Gemini quota (2 calls per scenario per
// round). Report: dist/ai-live.json.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const EXT = path.resolve(process.env.GUARDIAN_OUT || 'dist/extension');
const DEMO = process.env.DEMO_URL || 'http://127.0.0.1:5179/demo/index.html?mock=1';
const ROUNDS = Number(process.env.ROUNDS || 1);
const SCENARIOS = (process.env.SCENARIOS || 'claim,permit,nft,blind,fake,phish,transfer,limited,signin,revoke').split(',');

const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [EXT] });
const worker = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'));
const ext = new URL(worker.url()).host;
const page = await browser.newPage();
await page.goto(DEMO, { waitUntil: 'load' });
await page.waitForFunction(() => Array.isArray(window.__mockWalletLog));

// Allow the cloud fallback once, as a user would (FALLBACK=0: deeper analysis only).
const setup = await browser.newPage();
await setup.goto(`chrome-extension://${ext}/popup.html`, { waitUntil: 'load' });
await setup.evaluate((on) => chrome.storage.local.set({ cloudFallback: on }), process.env.FALLBACK !== '0');
await setup.close();

/** The model's own text inside a Gemini response (streamed or not). */
function modelText(body) {
  const pieces = [];
  const take = (json) => {
    for (const c of json.candidates || []) for (const p of (c.content && c.content.parts) || []) pieces.push(p.text || '');
  };
  for (const raw of body.split('\n')) {
    const line = raw.replace(/^data:\s*/, '').trim();
    if (!line.startsWith('{')) continue;
    try {
      take(JSON.parse(line));
    } catch {
      // not a JSON line
    }
  }
  if (pieces.length === 0) {
    try {
      take(JSON.parse(body));
    } catch {
      // nothing readable
    }
  }
  return pieces.join('');
}

const results = [];
for (let round = 1; round <= ROUNDS; round++) {
  for (const scenario of SCENARIOS) {
    await page.bringToFront();
    const before = new Set(browser.targets());
    await page.click(`[data-scenario="${scenario}"]`);
    const target = await browser.waitForTarget((t) => !before.has(t) && t.url().includes('/review.html'));
    const review = await target.asPage();
    const answers = [];
    review.on('response', async (response) => {
      if (!/generatecontent/i.test(response.url())) return;
      try {
        answers.push(modelText(await response.text()));
      } catch {
        answers.push('(body not readable)');
      }
    });
    const row = { round, scenario };
    try {
      // 'unavailable' / 'downloadable': no model here and the cloud not allowed (FALLBACK=0).
      await review.waitForFunction(
        () => ['done', 'error', 'undecoded', 'unavailable', 'downloadable'].includes(document.body.dataset.local),
        { timeout: 60000 },
      );
      Object.assign(
        row,
        await review.evaluate(() => ({
          risk: document.body.dataset.risk,
          local: document.body.dataset.local,
          source: document.body.dataset.source,
          checked: document.body.dataset.checked,
          withheld: document.body.dataset.withheld
            ? `${document.body.dataset.withheld} [${document.body.dataset.withheldDetail}]`
            : null,
          firstMs: Number(document.body.dataset.firstMs) || null,
          shownMs: Number(document.body.dataset.shownMs) || null,
          ms: Number(document.body.dataset.ms) || null,
          shown: document.getElementById('local-text').textContent,
          error: document.body.dataset.localError || null,
        })),
      );
      if (await review.evaluate(() => !document.getElementById('cloud-ask').hidden)) {
        await review.click('#cloud-ask');
        await review.waitForFunction(() => ['done', 'error'].includes(document.body.dataset.cloud), { timeout: 60000 });
        await new Promise((r) => setTimeout(r, 300));
      }
      row.deep = await review.evaluate(() => ({
        state: document.body.dataset.cloud,
        checked: document.body.dataset.cloudChecked || null,
        withheld: document.body.dataset.cloudWithheld
          ? `${document.body.dataset.cloudWithheld} [${document.body.dataset.cloudWithheldDetail}]`
          : null,
        patternKind: document.body.dataset.patternKind || null,
        pattern: document.getElementById('cloud-pattern').textContent,
        chip: document.getElementById('cloud-chip').textContent,
        error: document.body.dataset.cloudError || null,
      }));
      row.gemini = answers;
    } catch (error) {
      row.failure = String(error.message).split('\n')[0];
    } finally {
      await review.click('#reject').catch(() => {});
      // Stay under the free tier's per-minute limit, which judges share.
      await new Promise((r) => setTimeout(r, Number(process.env.PACE_MS || 9000)));
    }
    results.push(row);
    const deep = row.deep || {};
    console.log(
      `${round} ${scenario.padEnd(8)} ${row.risk || '-'}  explain: ${row.checked || row.local || row.failure}` +
        `${row.withheld ? ` (${row.withheld})` : ''} ${row.ms ? `${(row.ms / 1000).toFixed(1)} s` : ''}` +
        ` | deep: ${deep.checked || deep.state || '-'}${deep.withheld ? ` (${deep.withheld})` : ''} ${deep.patternKind || ''}`,
    );
  }
}

await browser.close();
await mkdir('dist', { recursive: true });
await writeFile('dist/ai-live.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
const withheld = results.filter((r) => r.checked === 'withheld' || (r.deep && r.deep.checked === 'withheld'));
console.log(`\n${results.length} runs, ${withheld.length} with something withheld. Report: dist/ai-live.json`);
