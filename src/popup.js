// The panel behind the toolbar icon. Guardian itself needs no clicks: it opens
// its own window when a page asks the wallet to sign or send. This panel only
// says that it is on, what this build can do, and where to try it.

import { firebaseConfig } from 'guardian-config';
import { cloudReady } from 'guardian-appcheck';
import { deviceModelStatus } from './ai/device.js';

const DEMO = 'https://ibiti-guardian-chrome.web.app/';
const $ = (id) => document.getElementById(id);

function show(id, text, kind) {
  const el = $(id);
  el.textContent = text;
  el.className = kind;
}

$('version').textContent = `v${chrome.runtime.getManifest().version}`;

$('try').addEventListener('click', async () => {
  await chrome.tabs.create({ url: DEMO });
  window.close();
});

// Without Firebase settings the SDK cannot start, not even on the device.
const aiBuilt = Boolean(firebaseConfig && firebaseConfig.apiKey);

if (!aiBuilt) {
  show('nano', 'Off in this build (no Firebase settings)', 'off');
} else {
  const status = await deviceModelStatus();
  if (status === 'available') show('nano', 'Ready', 'ok');
  else if (status === 'downloadable') show('nano', 'Not downloaded yet: Guardian’s window offers it', 'warn');
  else if (status === 'downloading') show('nano', 'Downloading…', 'warn');
  else show('nano', 'Not available in this Chrome', 'off');
}

if (aiBuilt && cloudReady) show('cloud', 'Set up: a button in Guardian’s window', 'ok');
else show('cloud', 'Not set up in this build', 'off');
