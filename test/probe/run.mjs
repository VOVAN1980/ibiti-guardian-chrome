// Calls the cloud model through Firebase AI Logic and prints Google's full reply.
//   node test/probe/run.mjs [model,model,...]
import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';
await build({ entryPoints: ['test/probe/probe.js'], bundle: true, format: 'esm', outfile: 'dist/probe/probe.js', logLevel: 'error' });
await writeFile('dist/probe/index.html', '<!doctype html><meta charset="utf-8"><script type="module" src="probe.js"></script>');
const models = process.argv[2] || 'default';
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
page.on('response', async (response) => {
  const url = response.url();
  if (!url.includes('googleapis.com')) return;
  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '(no body)';
  }
  const safeUrl = url.replace(/key=[^&]+/, 'key=…');
  console.log(`\n${response.status()} ${safeUrl.slice(0, 130)}`);
  if (!url.includes('firebaseappcheck')) console.log(body.slice(0, 1500));
});
await page.goto(`http://127.0.0.1:5179/dist/probe/index.html?models=${models}`);
await page.waitForFunction(() => window.__probe && window.__probe.done, { timeout: 90000 });
await new Promise((r) => setTimeout(r, 500));
await browser.close();
