// The published site's cloud analysis, end to end, in a clean Chrome with no
// extension: reCAPTCHA Enterprise → App Check → Firebase AI Logic.
//   node test/cloud-live.mjs [url]
import puppeteer from 'puppeteer';

const URL_ = process.argv[2] || 'https://ibiti-guardian-chrome.web.app/';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await puppeteer.launch({ headless: process.env.HEADFUL ? false : true, pipe: true });
const page = await browser.newPage();
const notes = [];
page.on('console', (m) => {
  const t = m.text();
  if (/app-check|AppCheck|recaptcha|session|cloud|Guardian|400|401|403/i.test(t)) notes.push(`console ${m.type()}: ${t.slice(0, 300)}`);
});
page.on('response', async (r) => {
  const u = r.url();
  if (/exchangeRecaptcha|recaptcha\/enterprise|firebasevertexai|firebaseappcheck/i.test(u)) {
    let body = '';
    if (r.status() >= 400) body = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    notes.push(`HTTP ${r.status()} ${u.split('?')[0]} ${body}`);
  }
});
await page.goto(URL_, { waitUntil: 'load' });
await page.click('#claim');
let frame = null;
for (let i = 0; i < 60 && !frame; i++) {
  await sleep(250);
  frame = page.frames().find((f) => f.url().includes('/guardian/review.html'));
}
if (!frame) throw new Error('review did not open');
for (let i = 0; i < 60; i++) {
  await sleep(250);
  const ready = await frame.evaluate(() => Boolean(document.getElementById('badge')?.textContent)).catch(() => false);
  if (ready) break;
}
await frame.evaluate(() => document.getElementById('cloud-ask').click());
let result = null;
for (let i = 0; i < 160; i++) {
  await sleep(250);
  result = await frame
    .evaluate(() => ({
      state: document.body.dataset.cloud,
      chip: document.getElementById('cloud-chip').textContent,
      summary: document.getElementById('cloud-summary').textContent,
      error: document.body.dataset.cloudError || '',
    }))
    .catch(() => null);
  if (result && ['done', 'error'].includes(result.state)) break;
}
console.log(JSON.stringify(result, null, 1));
console.log(notes.join('\n'));
await browser.close();
process.exitCode = result && result.state === 'done' ? 0 : 1;
