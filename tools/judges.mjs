// The test build for the contest judges: the extension with its own App Check
// debug token, ready to load in Chrome, zipped with install steps.
//
//   node tools/judges.mjs <token>
//
// The token is a UUID registered in Firebase console → App Check → Apps →
// Manage debug tokens, named "judges". It is not ours: it can be revoked after
// judging without touching our own. Firebase asks to keep debug tokens private,
// so the zip goes to the judges only (Devpost testing instructions), never to
// GitHub. Output: dist/judges/ and dist/IBITI-Guardian-judges.zip (dist/ is ignored).

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';

const token = process.argv[2] || '';
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
  console.error('usage: node tools/judges.mjs <judges App Check debug token (UUID)>');
  process.exit(2);
}
if (!existsSync('src/config.js')) {
  console.error('src/config.js is missing: the judges need the Firebase settings for Gemini to work.');
  process.exit(2);
}

const OUT = 'dist/judges';
const ZIP = 'dist/IBITI-Guardian-judges.zip';
execFileSync(process.execPath, ['build.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, GUARDIAN_OUT: OUT, GUARDIAN_SITE_OUT: 'dist/judges-site', GUARDIAN_EXT_TOKEN: token },
});
await rm('dist/judges-site', { recursive: true, force: true });

const { version } = JSON.parse(await readFile(`${OUT}/manifest.json`, 'utf8'));
await writeFile(
  `${OUT}/INSTALL.txt`,
  `IBITI Guardian ${version} - test build for the #BuildHybridAI 2026 judges

Install (desktop Chrome 139 or newer, Windows / macOS / Linux):
  1. Unzip this archive.
  2. Open chrome://extensions and turn on "Developer mode" (top right).
  3. Press "Load unpacked" and choose the unzipped folder (the one with manifest.json).
  4. Pin IBITI Guardian from the puzzle icon. Its panel says what is available.

Try it (about 1 minute):
  5. Open https://ibiti-guardian-chrome.web.app/ (or press "Try it on the test page"
     in the panel). The page uses a demo wallet: no keys, no funds, nothing on chain.
  6. Press "Claim airdrop". Guardian's own window opens: the request is held,
     the facts are decoded by code, and Gemini Nano explains it on your device
     (Firebase AI Logic, InferenceMode.ONLY_ON_DEVICE).
  7. Press "Ask cloud AI": Gemini in the cloud (InferenceMode.ONLY_IN_CLOUD,
     App Check with the judges' debug token in this build) names the scam
     pattern and what to check.
  8. Press "Reject". The page's log says the request was stopped and the demo
     wallet never saw it. The other buttons on the page show the other tricks.

Gemini Nano: if Chrome has not downloaded the on-device model yet, Guardian's
window offers a one-time download (a few GB, needs a capable GPU or CPU; see
https://developer.chrome.com/docs/ai/get-started). Everything else works
without it, and the cloud analysis works either way.

Please keep this build to the judging: it carries an App Check debug token
for our free Firebase project. Source: https://github.com/VOVAN1980/ibiti-guardian-chrome
`,
);

await rm(ZIP, { force: true });
execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${OUT}\\*' -DestinationPath '${ZIP}'`], {
  stdio: 'inherit',
});
console.log(`\n${ZIP} ready (version ${version}).`);

// The download for the judges: site-private/ is served by the hosted demo
// (build.mjs copies it in) but is not in the repository, under a random
// directory that nothing links to. The same address is kept on every rebuild.
const DROP = 'site-private/j';
await mkdir(DROP, { recursive: true });
let dir = (await readdir(DROP, { withFileTypes: true })).find((e) => e.isDirectory())?.name;
if (!dir) {
  dir = randomBytes(16).toString('hex');
  await mkdir(`${DROP}/${dir}`);
}
await copyFile(ZIP, `${DROP}/${dir}/IBITI-Guardian-judges.zip`);
console.log(`Served after the next deploy at /j/${dir}/IBITI-Guardian-judges.zip`);
