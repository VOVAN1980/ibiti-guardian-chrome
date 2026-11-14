// Builds two things from the same sources:
//   dist/extension  the unpacked Chrome extension
//   dist/site       the hosted demo, with a no-install preview of Guardian
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// GUARDIAN_OUT / GUARDIAN_SITE_OUT let tests build elsewhere, so a copy loaded
// in Chrome from dist/extension is not replaced in the middle of a session.
const out = process.env.GUARDIAN_OUT || 'dist/extension';
const site = process.env.GUARDIAN_SITE_OUT || 'dist/site';

// src/config.js is private and not in the repository. Without it the build
// still works; only the AI explanations stay off.
const configPath = path.resolve(existsSync('src/config.js') ? 'src/config.js' : 'src/config.example.js');
if (!existsSync('src/config.js')) {
  console.warn('src/config.js not found: building without Firebase settings (AI explanations off).');
}
const config = await import(pathToFileURL(configPath).href);

const common = { bundle: true, logLevel: 'info', legalComments: 'none' };

// ── Extension ───────────────────────────────────────────────────────────────
// GUARDIAN_EXT_TOKEN builds the extension with another App Check debug token
// (the judges' build, see tools/judges.mjs), so our own never leaves this machine.
const extToken = process.env.GUARDIAN_EXT_TOKEN || '';
let extConfigPath = configPath;
if (extToken) {
  extConfigPath = path.resolve('dist/.ext-config.mjs');
  await mkdir('dist', { recursive: true });
  await writeFile(
    extConfigPath,
    [
      `export const firebaseConfig = ${JSON.stringify(config.firebaseConfig)};`,
      `export const appCheckDebugToken = ${JSON.stringify(extToken)};`,
      'export const recaptcha = null;',
      '',
    ].join('\n'),
  );
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp('extension', out, { recursive: true });

const extension = {
  ...common,
  target: 'chrome139',
  outdir: out,
  alias: {
    'guardian-config': extConfigPath,
    'guardian-appcheck': path.resolve('src/ai/appcheck.ext.js'),
  },
};
// Content scripts are classic scripts: one self-contained file each.
await build({ ...extension, entryPoints: ['src/inpage.js', 'src/bridge.js'], format: 'iife' });
// The service worker and extension pages are ES modules.
await build({ ...extension, entryPoints: ['src/background.js', 'src/review.js', 'src/popup.js'], format: 'esm' });

if (extToken) {
  await rm(extConfigPath, { force: true });
  // Our own token must not be in a build made for someone else.
  if (config.appCheckDebugToken && config.appCheckDebugToken !== extToken) {
    for (const entry of await readdir(out, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath ?? entry.path, entry.name);
      if ((await readFile(file)).includes(config.appCheckDebugToken)) {
        throw new Error(`Our own App Check debug token ended up in ${file}.`);
      }
    }
  }
}

// ── Hosted demo ─────────────────────────────────────────────────────────────
// The public site gets the Firebase web config (public by design) and the
// reCAPTCHA site key, but never the App Check debug token.
// GUARDIAN_SITE_DEBUG=1 keeps the token, for a build that stays on this machine.
const keepDebugToken = process.env.GUARDIAN_SITE_DEBUG === '1';
const siteConfigPath = path.resolve('dist/.site-config.mjs');
await mkdir('dist', { recursive: true });
await writeFile(
  siteConfigPath,
  [
    `export const firebaseConfig = ${JSON.stringify(config.firebaseConfig)};`,
    `export const appCheckDebugToken = ${JSON.stringify(keepDebugToken ? config.appCheckDebugToken || '' : '')};`,
    `export const recaptcha = ${JSON.stringify(config.recaptcha || null)};`,
    '',
  ].join('\n'),
);

const guardianDir = path.join(site, 'guardian');
await rm(site, { recursive: true, force: true });
await mkdir(guardianDir, { recursive: true });
await cp('demo', site, { recursive: true });
// Served but not in the repository: the judges' test build at an unlisted
// address (tools/judges.mjs). Copied in on every build so a deploy keeps it.
if (existsSync('site-private')) await cp('site-private', site, { recursive: true });
await cp('extension/review.html', path.join(guardianDir, 'review.html'));
await cp('extension/review.css', path.join(guardianDir, 'review.css'));
await cp('extension/icons', path.join(guardianDir, 'icons'), { recursive: true });

const web = {
  ...common,
  target: 'es2022',
  outdir: guardianDir,
  alias: {
    'guardian-config': siteConfigPath,
    'guardian-appcheck': path.resolve('src/ai/appcheck.web.js'),
  },
};
await build({ ...web, entryPoints: ['src/inpage.js', 'src/web/panel.js'], entryNames: '[name]', format: 'iife' });
await build({ ...web, entryPoints: ['src/review.js'], format: 'esm' });
await rm(siteConfigPath, { force: true });

// The published page only ever uses the demo wallet (see demo/dapp.js).
const sitePage = path.join(site, 'index.html');
const marker = '<!-- playground:public -->';
const html = await readFile(sitePage, 'utf8');
if (!html.includes(marker)) throw new Error('index.html: public marker missing');
await writeFile(sitePage, html.replace(marker, '<script>window.__playgroundPublic = true;</script>'));

// A last check before anything can be published: the debug token must not be
// anywhere in the public site.
if (!keepDebugToken && config.appCheckDebugToken) {
  const files = await readdir(site, { recursive: true, withFileTypes: true });
  for (const entry of files) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    if ((await readFile(file)).includes(config.appCheckDebugToken)) {
      throw new Error(`The App Check debug token ended up in ${file}. Not publishable.`);
    }
  }
}
