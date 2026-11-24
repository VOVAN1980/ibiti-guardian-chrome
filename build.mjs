// Builds two things from the same sources:
//   dist/extension  the unpacked Chrome extension
//   dist/site       the hosted demo, with a no-install preview of Guardian
import { build } from 'esbuild';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// GUARDIAN_OUT / GUARDIAN_SITE_OUT let tests build elsewhere, so a copy loaded
// in Chrome from dist/extension is not replaced in the middle of a session.
const out = process.env.GUARDIAN_OUT || 'dist/extension';
const site = process.env.GUARDIAN_SITE_OUT || 'dist/site';

// GUARDIAN_SITE_DEBUG=1 keeps the App Check debug token in the site, for a
// build that stays on this machine: never in the folder Firebase publishes,
// nor in a folder inside it. Checked before anything is written, and once
// more when the folder exists. The extension, which holds the token, is
// never built there either. At the end of every build, also one that fails,
// the published folder itself is searched for the token, whatever
// GUARDIAN_SITE_OUT and GUARDIAN_OUT named.
const keepDebugToken = process.env.GUARDIAN_SITE_DEBUG === '1';
// The real folder a path names, through any link or junction on the way.
// For a path that does not exist yet: its nearest parent that does,
// resolved, and the rest of the path after it. On Windows, without the dots
// and spaces at the end of a name, which most programs drop (esbuild among
// them, though not Node's own file calls): dist/site. is dist/site.
const where = (dir) => {
  let full = path.resolve(dir);
  if (process.platform === 'win32') {
    full = path.resolve(full.split(path.sep).map((part) => (/^\.+$/.test(part) ? part : part.replace(/[. ]+$/, ''))).join(path.sep));
  }
  const rest = [];
  while (!existsSync(full) && path.dirname(full) !== full) {
    rest.unshift(path.basename(full));
    full = path.dirname(full);
  }
  const real = path.join(existsSync(full) ? realpathSync.native(full) : full, ...rest);
  return process.platform === 'win32' ? real.toLowerCase() : real;
};
// The same folder under any name, also one no link leads through (this
// disk's share, \\localhost\D$\...): the same file on the same volume.
const sameFolder = (a, b) => {
  try {
    const x = statSync(a, { bigint: true });
    const y = statSync(b, { bigint: true });
    return x.ino !== 0n && x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
};
let publicDir = 'dist/site';
try {
  publicDir = JSON.parse(readFileSync('firebase.json', 'utf8')).hosting.public || publicDir;
} catch {
  // no firebase.json here: the default folder
}
const published = [...new Set([publicDir, 'dist/site'])];
/** Whether `folder` is a published folder, or a folder inside one. */
const isPublished = (folder) => {
  const real = where(folder);
  if (published.some((dir) => real === where(dir) || real.startsWith(where(dir) + path.sep))) return true;
  for (let dir = path.resolve(folder); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    if (published.some((p) => sameFolder(dir, p))) return true;
  }
  return false;
};
const refuse = () => {
  throw new Error(
    `GUARDIAN_SITE_DEBUG=1 would write the debug token into ${site}, the folder Firebase publishes or a folder inside it. ` +
      'Set GUARDIAN_SITE_OUT to another folder.',
  );
};
if (keepDebugToken && isPublished(site)) refuse();
if (isPublished(out)) {
  throw new Error(
    `GUARDIAN_OUT=${out} would build the extension, which holds the App Check debug token, into the folder Firebase ` +
      'publishes or a folder inside it. Set GUARDIAN_OUT to another folder.',
  );
}

// src/config.js is private and not in the repository. Without it the build
// still works; only the AI explanations stay off.
const configPath = path.resolve(existsSync('src/config.js') ? 'src/config.js' : 'src/config.example.js');
if (!existsSync('src/config.js')) {
  console.warn('src/config.js not found: building without Firebase settings (AI explanations off).');
}
const config = await import(pathToFileURL(configPath).href);

/** The first file under `dir` that holds the debug token, or null. */
const holder = async (dir) => {
  if (!existsSync(dir)) return null;
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    if ((await readFile(file)).includes(config.appCheckDebugToken)) return file;
  }
  return null;
};

const common = { bundle: true, logLevel: 'info', legalComments: 'none' };

// Everything that writes. If any of it fails, the published folder is still
// searched (below) before the build ends.
let failed = null;
try {
  // ── Extension ─────────────────────────────────────────────────────────────
  // GUARDIAN_EXT_TOKEN builds the extension with another App Check debug token
  // (the judges' build, see tools/judges.mjs), so our own never leaves this machine.
  const extToken = process.env.GUARDIAN_EXT_TOKEN || '';
  let extConfigPath = configPath;
  if (extToken) {
    extConfigPath = path.resolve(`dist/.ext-config-${process.pid}.mjs`);
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

  // ── Hosted demo ───────────────────────────────────────────────────────────
  // The public site gets the Firebase web config (public by design) and the
  // reCAPTCHA site key, but never the App Check debug token (GUARDIAN_SITE_DEBUG
  // above is the one exception, and never for the published folder).
  const guardianDir = path.join(site, 'guardian');
  await rm(site, { recursive: true, force: true });
  await mkdir(guardianDir, { recursive: true });
  // Once more, now that the folder exists and before anything is written: a
  // link on the way that led nowhere before (on a fresh checkout, a junction
  // to a dist/ not made yet), or a share of this disk, may lead to the
  // published folder now.
  if (keepDebugToken && isPublished(site)) {
    await rm(site, { recursive: true, force: true });
    refuse();
  }

  const siteConfigPath = path.resolve(`dist/.site-config-${process.pid}.mjs`);
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
} catch (error) {
  failed = error; // thrown once the published folder has been searched
}

// A last check before anything can be published, also after a build that
// failed: the debug token must not be anywhere in the folder Firebase
// publishes, whatever GUARDIAN_SITE_OUT and GUARDIAN_OUT named (a folder
// inside it, a share of this disk). Found there, that folder is deleted.
if (config.appCheckDebugToken) {
  for (const dir of published) {
    const file = await holder(dir);
    if (file) {
      if (failed) console.error(failed);
      await rm(realpathSync.native(dir), { recursive: true, force: true });
      throw new Error(`The App Check debug token ended up in ${file}, in the folder Firebase publishes. ${dir} was deleted: build again.`);
    }
  }
}
if (failed) throw failed;

// Nor in the site just built, unless GUARDIAN_SITE_DEBUG asked for it.
if (config.appCheckDebugToken && !keepDebugToken) {
  const file = await holder(site);
  if (file) throw new Error(`The App Check debug token ended up in ${file}. Not publishable.`);
}
