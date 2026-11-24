// What keeps private things private around the build:
//   - the folder Firebase publishes never gets the App Check debug token
//     (build.mjs, GUARDIAN_SITE_DEBUG, GUARDIAN_OUT), however the path names
//     it, and every build, also one that fails, ends by searching that folder
//     for it;
//   - `npm run demo` serves the demo and nothing else (tools/demo-server.mjs),
//     and the cloud probe serves only its own folder;
//   - another site cannot put the hosted demo in a frame (firebase.json).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDemoServer, createFolderServer } from '../tools/demo-server.mjs';

const BUILD = path.resolve('build.mjs');

/**
 * Runs build.mjs in an empty folder holding only `firebase` as firebase.json.
 * `env`: the variables to set, or a function of the folder that gives them.
 * `setup(dir)` prepares the folder first; `look(dir)` is what is left after.
 * `base`: where the folder is made (the system's temp folder by default).
 */
function buildIn(env, firebase = { hosting: { public: 'dist/site' } }, { setup, look, base = os.tmpdir() } = {}) {
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'guardian-build-'));
  try {
    writeFileSync(path.join(dir, 'firebase.json'), JSON.stringify(firebase));
    if (setup) setup(dir);
    const run = spawnSync(process.execPath, [BUILD], {
      cwd: dir,
      env: {
        ...process.env,
        GUARDIAN_OUT: 'dist/dev',
        GUARDIAN_SITE_OUT: '',
        GUARDIAN_SITE_DEBUG: '',
        ...(typeof env === 'function' ? env(dir) : env),
      },
      encoding: 'utf8',
      timeout: 60000,
    });
    return {
      status: run.status,
      stderr: String(run.stderr),
      wrote: existsSync(path.join(dir, 'dist')),
      left: look ? look(dir) : undefined,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (base !== os.tmpdir()) rmSync(base, { recursive: true, force: true });
  }
}

/** A junction on Windows (no rights needed, as mklink /J), a symlink elsewhere. */
const junction = (dir, name, target) => symlinkSync(path.join(dir, target), path.join(dir, name), 'junction');

/** Every file under `dir` (none if it does not exist). */
const filesIn = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => path.join(e.parentPath ?? e.path, e.name))
    : [];

/** Files under `dir` that hold `token`. */
const withToken = (dir, token) => filesIn(dir).filter((file) => readFileSync(file, 'utf8').includes(token));

/**
 * A made-up token for a build in a copy of the sources. The copies are made
 * inside this repository's own dist/ (ignored by git), so the bundler finds
 * node_modules without a link to it; one folder per test run.
 */
const newToken = () => `guardian-test-token-${process.pid}-${Date.now()}`;
const COPIES = path.resolve('dist', `build-test-${process.pid}`);
/** What a whole build needs, with `token` in place of src/config.js. */
function copySources(dir, token) {
  for (const folder of ['extension', 'demo']) cpSync(folder, path.join(dir, folder), { recursive: true });
  cpSync('src', path.join(dir, 'src'), { recursive: true, filter: (from) => path.basename(from) !== 'config.js' });
  writeFileSync(
    path.join(dir, 'src', 'config.js'),
    `export const firebaseConfig = {};\nexport const appCheckDebugToken = '${token}';\nexport const recaptcha = null;\n`,
  );
}

/** The same folder through this disk's administrative share: \\localhost\D$\... */
const share = (dir) => `\\\\localhost\\${dir[0]}$${dir.slice(2)}`;

/** A whole build in a copy that fails before it ends: its demo page lost the public marker. */
function copyBroken(dir, token) {
  copySources(dir, token);
  const page = path.join(dir, 'demo', 'index.html');
  writeFileSync(page, readFileSync(page, 'utf8').replace('<!-- playground:public -->', ''));
}

const REFUSED = /GUARDIAN_SITE_DEBUG=1 would write the debug token/;
const REFUSED_OUT = /GUARDIAN_OUT=.+ would build the extension, which holds the App Check debug token, into the folder Firebase publishes/;
const FOUND_PUBLISHED = /The App Check debug token ended up in .+, in the folder Firebase publishes\. dist\/site was deleted/;

test('SEC-L2: GUARDIAN_SITE_DEBUG=1 is refused for the folder Firebase publishes, before anything is written', () => {
  const published = ['', 'dist/site', './dist/site/', 'dist/../dist/site', 'dist/site/debug', './dist/site/a/b'];
  // Windows drops the dots and spaces at the end of a name: these are dist/site too.
  if (process.platform === 'win32') published.push('DIST\\Site', 'DIST\\Site\\Debug', 'dist/site.', 'dist/site ', 'dist/site. .', 'dist./site', 'dist/site./debug');
  for (const out of published) {
    const run = buildIn({ GUARDIAN_SITE_DEBUG: '1', GUARDIAN_SITE_OUT: out });
    assert.notEqual(run.status, 0, `refused for "${out}"`);
    assert.match(run.stderr, REFUSED, `refused for "${out}"`);
    assert.equal(run.wrote, false, `nothing written for "${out}"`);
  }
  // The folder firebase.json names, whatever it is, and a folder inside it.
  for (const out of ['public', 'public/debug']) {
    const custom = buildIn({ GUARDIAN_SITE_DEBUG: '1', GUARDIAN_SITE_OUT: out }, { hosting: { public: 'public' } });
    assert.match(custom.stderr, REFUSED, out);
    assert.equal(custom.wrote, false, out);
  }
});

test('SEC-L2: a folder inside the published folder is refused once dist/site exists too; nothing is written', () => {
  for (const out of ['dist/site/debug', 'dist/site/guardian']) {
    const run = buildIn({ GUARDIAN_SITE_DEBUG: '1', GUARDIAN_SITE_OUT: out }, undefined, {
      setup: (dir) => mkdirSync(path.join(dir, 'dist', 'site'), { recursive: true }),
      look: (dir) => readdirSync(path.join(dir, 'dist'), { recursive: true }),
    });
    assert.match(run.stderr, REFUSED, out);
    assert.deepEqual(run.left, ['site'], `nothing written for "${out}"`);
  }
});

test('SEC-L2: the published folder named through this disk’s share (\\\\localhost\\D$) is refused', (t) => {
  if (process.platform !== 'win32') return t.skip('a Windows share');
  if (!existsSync(share(path.resolve('build.mjs')))) return t.skip(`${share(path.resolve('.'))} cannot be read here`);
  const env = (dir) => ({ GUARDIAN_SITE_DEBUG: '1', GUARDIAN_SITE_OUT: share(path.join(dir, 'dist', 'site')) });
  // dist/site there already: refused before anything is written.
  const there = buildIn(env, undefined, {
    base: COPIES,
    setup: (dir) => mkdirSync(path.join(dir, 'dist', 'site'), { recursive: true }),
    look: (dir) => readdirSync(path.join(dir, 'dist'), { recursive: true }),
  });
  assert.match(there.stderr, REFUSED);
  assert.deepEqual(there.left, ['site'], 'nothing written');
  // A fresh checkout: the share names the folder only once the build made
  // it. Refused before the site is written; the whole build runs here.
  const token = newToken();
  const fresh = buildIn(env, undefined, {
    base: COPIES,
    setup: (dir) => copySources(dir, token),
    look: (dir) => ({
      built: existsSync(path.join(dir, 'dist', 'dev', 'review.js')),
      site: filesIn(path.join(dir, 'dist', 'site')),
      withToken: withToken(path.join(dir, 'dist'), token).filter((file) => !file.startsWith(path.join(dir, 'dist', 'dev'))),
    }),
  });
  assert.match(fresh.stderr, REFUSED);
  assert.notEqual(fresh.status, 0);
  assert.equal(fresh.left.built, true, 'the build got as far as the site');
  assert.deepEqual(fresh.left.site, [], 'nothing in the published folder');
  assert.deepEqual(fresh.left.withToken, [], 'the token is nowhere outside the extension build');
});

test('SEC-L2: the published folder named through a junction is refused, even before dist/site exists', () => {
  const env = { GUARDIAN_SITE_DEBUG: '1', GUARDIAN_SITE_OUT: 'pub/site' };
  const look = (dir) => ({ site: existsSync(path.join(dir, 'dist', 'site')), dev: existsSync(path.join(dir, 'dist', 'dev')) });
  // pub -> dist, with and without dist/site in it yet: refused before anything is written.
  for (const siteExists of [true, false]) {
    const run = buildIn(env, undefined, {
      setup: (dir) => {
        mkdirSync(path.join(dir, 'dist', ...(siteExists ? ['site'] : [])), { recursive: true });
        junction(dir, 'pub', 'dist');
      },
      look,
    });
    assert.match(run.stderr, REFUSED, `dist/site there: ${siteExists}`);
    assert.deepEqual(run.left, { site: siteExists, dev: false }, `nothing written (dist/site there: ${siteExists})`);
  }
});

test('SEC-L2: a junction that leads to the published folder only once the build made dist/ is refused before the site is written', () => {
  // A fresh checkout: no dist/ yet, so pub -> dist leads nowhere until the
  // extension build makes dist/dev. The whole build runs here.
  const token = newToken();
  const run = buildIn({ GUARDIAN_SITE_DEBUG: '1', GUARDIAN_SITE_OUT: 'pub/site' }, undefined, {
    base: COPIES,
    setup: (dir) => {
      copySources(dir, token);
      junction(dir, 'pub', 'dist');
    },
    look: (dir) => ({
      built: existsSync(path.join(dir, 'dist', 'dev', 'review.js')),
      site: filesIn(path.join(dir, 'dist', 'site')),
      withToken: withToken(path.join(dir, 'dist'), token).filter((file) => !file.startsWith(path.join(dir, 'dist', 'dev'))),
    }),
  });
  assert.match(run.stderr, REFUSED);
  assert.notEqual(run.status, 0);
  assert.equal(run.left.built, true, 'the extension was built: the build got as far as the site');
  assert.deepEqual(run.left.site, [], 'nothing in the published folder');
  assert.deepEqual(run.left.withToken, [], 'the token is nowhere outside the extension build');
});

test('SEC-L2: a debug build elsewhere, or a plain build, is not refused', () => {
  // These go on to fail for lack of sources in the empty folder, not on the check.
  assert.doesNotMatch(buildIn({ GUARDIAN_SITE_DEBUG: '1', GUARDIAN_SITE_OUT: 'dist/site-local' }).stderr, REFUSED);
  assert.doesNotMatch(buildIn({ GUARDIAN_SITE_DEBUG: '1', GUARDIAN_SITE_OUT: 'dist/sites' }).stderr, REFUSED);
  assert.doesNotMatch(buildIn({}).stderr, REFUSED);
});

test('SEC-L2: the extension, which holds the token, is never built into the published folder: refused before anything is written', () => {
  const outs = ['dist/site', './dist/site/', 'dist/site/extension', 'dist/../dist/site/ext'];
  if (process.platform === 'win32') outs.push('DIST\\Site\\Ext', 'dist/site.', 'dist/site./ext', 'dist./site/ext');
  for (const out of outs) {
    // A plain build, and one with a debug site elsewhere.
    for (const debug of [{}, { GUARDIAN_SITE_DEBUG: '1', GUARDIAN_SITE_OUT: 'dist/site-local' }]) {
      const run = buildIn({ GUARDIAN_OUT: out, ...debug });
      assert.notEqual(run.status, 0, `refused for "${out}"`);
      assert.match(run.stderr, REFUSED_OUT, `refused for "${out}"`);
      assert.equal(run.wrote, false, `nothing written for "${out}"`);
    }
  }
  // The folder firebase.json names, whatever it is.
  const custom = buildIn({ GUARDIAN_OUT: 'public/ext' }, { hosting: { public: 'public' } });
  assert.match(custom.stderr, REFUSED_OUT);
  assert.equal(custom.wrote, false);
  // Elsewhere is fine, dist/extension too (these go on to fail for lack of sources).
  assert.doesNotMatch(buildIn({ GUARDIAN_OUT: 'dist/site-ext' }).stderr, REFUSED_OUT);
  assert.doesNotMatch(buildIn({ GUARDIAN_OUT: '' }).stderr, REFUSED_OUT);
});

test('SEC-L2: a build that fails part way leaves no token in the published folder', () => {
  const look = (dir) => ({
    published: filesIn(path.join(dir, 'dist', 'site')).map((file) => path.relative(dir, file)),
    withToken: (token) => withToken(path.join(dir, 'dist', 'site'), token),
  });
  const cases = [
    // The extension aimed into the published folder, the site elsewhere.
    { env: { GUARDIAN_OUT: 'dist/site/ext', GUARDIAN_SITE_OUT: 'dist/site-local' }, refused: REFUSED_OUT },
    { env: { GUARDIAN_OUT: 'dist/site/ext', GUARDIAN_SITE_DEBUG: '1', GUARDIAN_SITE_OUT: 'dist/site-local' }, refused: REFUSED_OUT },
  ];
  // A debug site in the published folder under the name Windows drops the dot of.
  if (process.platform === 'win32') {
    cases.push({ env: { GUARDIAN_SITE_DEBUG: '1', GUARDIAN_SITE_OUT: 'dist/site.' }, refused: REFUSED });
  }
  for (const { env, refused } of cases) {
    // With the published folder there already, and on a fresh checkout.
    for (const siteExists of [true, false]) {
      const token = newToken();
      let found = null;
      const run = buildIn(env, undefined, {
        base: COPIES,
        setup: (dir) => {
          copyBroken(dir, token);
          if (siteExists) {
            mkdirSync(path.join(dir, 'dist', 'site'), { recursive: true });
            writeFileSync(path.join(dir, 'dist', 'site', 'index.html'), '<!doctype html>published');
          }
        },
        look: (dir) => {
          found = look(dir).withToken(token);
          return look(dir).published;
        },
      });
      const what = `${JSON.stringify(env)}, dist/site there: ${siteExists}`;
      assert.notEqual(run.status, 0, what);
      assert.match(run.stderr, refused, what);
      assert.deepEqual(found, [], `${what}: no token in the published folder`);
      assert.deepEqual(run.left, siteExists ? [path.join('dist', 'site', 'index.html')] : [], `${what}: the published folder untouched`);
    }
  }
});

test('SEC-L2: every build ends by searching the published folder for the token, whatever GUARDIAN_SITE_OUT was', () => {
  const look = (dir) => ({
    published: filesIn(path.join(dir, 'dist', 'site')).map((file) => path.relative(dir, file)),
    elsewhere: existsSync(path.join(dir, 'dist', 'site-local', 'guardian', 'review.js')),
  });
  // A plain build elsewhere, with the token left in the published folder by
  // something else: that folder is deleted.
  let token = newToken();
  const plain = buildIn({ GUARDIAN_SITE_OUT: 'dist/site-local' }, undefined, {
    base: COPIES,
    setup: (dir) => {
      copySources(dir, token);
      mkdirSync(path.join(dir, 'dist', 'site', 'old'), { recursive: true });
      writeFileSync(path.join(dir, 'dist', 'site', 'old', 'review.js'), `const token = '${token}';`);
    },
    look,
  });
  assert.notEqual(plain.status, 0);
  assert.match(plain.stderr, FOUND_PUBLISHED);
  assert.ok(!plain.stderr.includes(token), 'the token itself is never printed');
  assert.deepEqual(plain.left, { published: [], elsewhere: true });
  // The same when the build itself fails part way: the folder is still
  // searched and deleted, and the build's own error is still shown.
  token = newToken();
  const broken = buildIn({ GUARDIAN_SITE_OUT: 'dist/site-local' }, undefined, {
    base: COPIES,
    setup: (dir) => {
      copyBroken(dir, token);
      mkdirSync(path.join(dir, 'dist', 'site', 'old'), { recursive: true });
      writeFileSync(path.join(dir, 'dist', 'site', 'old', 'review.js'), `const token = '${token}';`);
    },
    look,
  });
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, FOUND_PUBLISHED);
  assert.match(broken.stderr, /index\.html: public marker missing/);
  assert.ok(!broken.stderr.includes(token), 'the token itself is never printed');
  assert.deepEqual(broken.left.published, []);
  // A failed build with nothing in the published folder fails with its own error.
  token = newToken();
  const failed = buildIn({ GUARDIAN_SITE_OUT: 'dist/site-local' }, undefined, { base: COPIES, setup: (dir) => copyBroken(dir, token) });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /index\.html: public marker missing/);
  assert.doesNotMatch(failed.stderr, FOUND_PUBLISHED);
  // A published folder without the token is left as it is.
  token = newToken();
  const clean = buildIn({ GUARDIAN_SITE_OUT: 'dist/site-local' }, undefined, {
    base: COPIES,
    setup: (dir) => {
      copySources(dir, token);
      mkdirSync(path.join(dir, 'dist', 'site'), { recursive: true });
      writeFileSync(path.join(dir, 'dist', 'site', 'index.html'), '<!doctype html>published');
    },
    look,
  });
  assert.equal(clean.status, 0, clean.stderr);
  assert.deepEqual(clean.left, { published: [path.join('dist', 'site', 'index.html')], elsewhere: true });
});

test('SEC-L2: a site built without GUARDIAN_SITE_DEBUG that holds the token fails the build', () => {
  // Here the demo's own files carry it.
  const token = newToken();
  const run = buildIn({ GUARDIAN_SITE_OUT: 'dist/site-local' }, undefined, {
    base: COPIES,
    setup: (dir) => {
      copySources(dir, token);
      writeFileSync(path.join(dir, 'demo', 'notes.txt'), token);
    },
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /The App Check debug token ended up in .+notes\.txt\. Not publishable\./);
  assert.ok(!run.stderr.includes(token), 'the token itself is never printed');
});

/** GET (or another method) with any Host header: fetch() cannot set one. */
function get(port, pathname, { host = `127.0.0.1:${port}`, method = 'GET' } = {}) {
  // host null: no Host header at all.
  const headers = host === null ? {} : { host };
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, setHost: host !== null }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('SEC-L3: npm run demo serves the demo and nothing else', async () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.scripts.demo, 'node tools/demo-server.mjs');

  const server = await createDemoServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    for (const name of ['index.html', 'index.html?mock=1', 'dapp.js', 'mock-wallet.js']) {
      const res = await get(port, `/demo/${name}`);
      assert.equal(res.status, 200, name);
    }
    assert.match((await get(port, '/demo/index.html')).body, /IBITI Guardian playground/);
    assert.equal((await get(port, '/demo/dapp.js')).headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal((await get(port, '/demo/index.html', { host: `localhost:${port}` })).status, 200);
    assert.equal((await get(port, '/')).headers.location, '/demo/index.html');

    const hidden = [
      '/src/config.js',
      '/src/config.example.js',
      '/tools/judges-token.local.txt',
      '/tools/demo-server.mjs',
      '/.git/HEAD',
      '/.git/config',
      '/package.json',
      '/dist/probe/probe.js',
      '/demo/../src/config.js',
      '/demo/%2e%2e/src/config.js',
      '/demo/..%2fsrc%2fconfig.js',
      '/demo/%2E%2E%5Csrc%5Cconfig.js',
      '/demo/..\\src\\config.js',
      '/demo//etc/hosts',
      '/demo/.gitignore',
      '/demo/index.html/',
      '/demo/INDEX.HTML',
    ];
    for (const pathname of hidden) {
      const res = await get(port, pathname);
      assert.equal(res.status, 404, pathname);
      assert.ok(!/appCheckDebugToken|firebaseConfig|\[core\]/.test(res.body), pathname);
    }
    // A page whose own name only points here (DNS rebinding) is refused.
    for (const host of [`evil.example:${port}`, 'evil.example', `127.0.0.1.evil.example:${port}`, '127.0.0.1:1']) {
      assert.equal((await get(port, '/demo/index.html', { host })).status, 421, host);
    }
    // No Host header at all: Node refuses it before the server sees it.
    assert.equal((await get(port, '/demo/index.html', { host: null })).status, 400);
    assert.equal((await get(port, '/demo/index.html', { method: 'POST' })).status, 405);
  } finally {
    server.close();
  }
});

test('SEC-L3: a file added to demo/ later is not served until the server restarts; demo/ is all it reads', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guardian-demo-'));
  try {
    mkdirSync(path.join(root, 'demo'));
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'demo', 'index.html'), '<!doctype html>demo');
    writeFileSync(path.join(root, 'src', 'config.js'), 'export const appCheckDebugToken = "secret";');
    const server = await createDemoServer({ root });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      writeFileSync(path.join(root, 'demo', 'later.js'), 'late');
      assert.equal((await get(port, '/demo/index.html')).body, '<!doctype html>demo');
      assert.equal((await get(port, '/demo/later.js')).status, 404);
      assert.equal((await get(port, '/src/config.js')).status, 404);
    } finally {
      server.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEC-L3: the cloud probe (test/probe/run.mjs) serves its own folder the same way: its files, to this computer only', async () => {
  assert.match(readFileSync('test/probe/run.mjs', 'utf8'), /createFolderServer\(path\.resolve\('dist\/probe'\), '\/dist\/probe\/'\)/);
  const root = mkdtempSync(path.join(os.tmpdir(), 'guardian-probe-'));
  try {
    const probe = path.join(root, 'dist', 'probe');
    mkdirSync(probe, { recursive: true });
    writeFileSync(path.join(probe, 'index.html'), '<!doctype html>probe');
    writeFileSync(path.join(probe, 'probe.js'), 'export const appCheckDebugToken = "secret";');
    writeFileSync(path.join(root, 'dist', 'other.js'), 'other');
    const server = await createFolderServer(probe, '/dist/probe/');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      assert.equal((await get(port, '/dist/probe/index.html?models=default')).body, '<!doctype html>probe');
      assert.equal((await get(port, '/dist/probe/probe.js')).status, 200);
      assert.equal((await get(port, '/')).headers.location, '/dist/probe/index.html');
      for (const pathname of ['/dist/other.js', '/dist/probe/../other.js', '/dist/probe/%2e%2e/other.js', '/demo/index.html', '/probe.js']) {
        assert.equal((await get(port, pathname)).status, 404, pathname);
      }
      assert.equal((await get(port, '/dist/probe/probe.js', { host: `evil.example:${port}` })).status, 421);
    } finally {
      server.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEC-L1: another site cannot frame the hosted demo; its own preview frame still can', () => {
  const firebase = JSON.parse(readFileSync('firebase.json', 'utf8'));
  const all = firebase.hosting.headers.find((h) => h.source === '**');
  const header = (key) => (all.headers.find((h) => h.key === key) || {}).value;
  // 'self', not 'none': the preview (src/web/panel.js) frames guardian/review.html from the same site.
  assert.equal(header('X-Frame-Options'), 'SAMEORIGIN');
  assert.equal(header('Content-Security-Policy'), "frame-ancestors 'self'");
  // Nothing that could stop the site's own scripts (inline ones, reCAPTCHA).
  for (const rule of firebase.hosting.headers) {
    for (const h of rule.headers) {
      if (h.key.toLowerCase() === 'content-security-policy') assert.doesNotMatch(h.value, /script-src|default-src/);
    }
  }
  assert.match(readFileSync('src/web/panel.js', 'utf8'), /new URL\(`review\.html\?id=\$\{encodeURIComponent\(id\)\}`, base\)/);
});
