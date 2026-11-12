// Screenshots of the hosted demo (dist/site), desktop and phone width, for
// the design pass and the submission.
//   node test/shots-site.mjs   → dist/shots/site-*.png
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(process.env.GUARDIAN_SITE_OUT || 'dist/site');
const OUT = path.resolve('dist/shots');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((request, response) => {
  let file = path.join(ROOT, decodeURIComponent(new URL(request.url, 'http://x').pathname));
  if (!file.startsWith(ROOT)) return response.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!existsSync(file)) return response.writeHead(404).end();
  response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
await mkdir(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await puppeteer.launch({ headless: true, pipe: true });

for (const [label, viewport] of [
  ['desktop', { width: 1280, height: 860 }],
  ['phone', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
]) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, `site-${label}-page.png`) });
  await page.click('#claim');
  await sleep(1800);
  await page.screenshot({ path: path.join(OUT, `site-${label}-review.png`) });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  console.log(`${label}: horizontal overflow ${overflow}px`);
  await page.close();
}

await browser.close();
server.close();
console.log(`Saved to ${OUT}`);
