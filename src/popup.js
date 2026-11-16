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

// Where the last explanation ran and how long it took (review.js keeps it).
const { lastExplanation: last } = await chrome.storage.local.get('lastExplanation');
if (last && typeof last.at === 'number') {
  const s = (ms) => `${(ms / 1000).toFixed(1)} s`;
  const when = new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const where = last.source === 'on_device' ? 'On device' : last.source === 'in_cloud' ? 'Cloud' : 'AI';
  const parts = last.error
    ? [when, where, `no answer: ${last.error}`]
    : [
        when,
        where,
        typeof last.firstMs === 'number' ? `first words ${s(last.firstMs)}` : null,
        typeof last.shownMs === 'number' ? `shown ${s(last.shownMs)}` : null,
        typeof last.ms === 'number' ? `done ${s(last.ms)}` : null,
        `${last.requests ?? '?'} network requests from Guardian’s window`,
        last.checked === 'withheld' ? 'answer withheld by the checks' : last.checked === 'cut' ? 'answer cut short by the checks' : null,
      ];
  show('last', parts.filter(Boolean).join(' · '), !last.error && last.source === 'on_device' && last.requests === 0 ? 'ok' : 'off');
  $('last-row').hidden = false;
}

// The one-time permission for the hybrid fallback (same key as host.js).
const fallback = $('fallback');
const fallbackText = (on) => {
  $('fallback-text').textContent = on ? 'On: Gemini in the cloud explains instead' : 'Off: only Gemini Nano explains';
  $('fallback-text').className = on ? 'ok' : 'off';
};
if (aiBuilt && cloudReady) {
  const { cloudFallback } = await chrome.storage.local.get('cloudFallback');
  fallback.checked = cloudFallback === true;
  fallback.disabled = false;
  fallbackText(fallback.checked);
  fallback.addEventListener('change', async () => {
    await chrome.storage.local.set({ cloudFallback: fallback.checked });
    fallbackText(fallback.checked);
  });
} else {
  show('fallback-text', 'Not set up in this build', 'off');
}
