// Guardian's own review window (an extension page the site cannot touch; in
// the hosted demo, the same page shown in a frame).
// Facts and the risk level come from the deterministic analyzer. The AI only
// explains them: on this computer by default, in the cloud only on request.

import { analyze } from './analyzer/index.js';
import { analyzeInCloud, cloudReady, deviceModelStatus, downloadDeviceModel, explainOnDevice } from './ai/engine.js';
import { deepPrompt, explainPrompt } from './ai/prompt.js';
import { closeReview, isPreview, loadReview, sendDecision } from './host.js';

const BADGE = { danger: 'High risk', caution: 'Check carefully', info: 'No red flags found' };
const $ = (id) => document.getElementById(id);
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

const id = new URLSearchParams(location.search).get('id');
let decided = false;

async function decide(decision) {
  if (decided) return;
  decided = true;
  $('reject').disabled = true;
  $('allow').disabled = true;
  try {
    await sendDecision(id, decision);
  } finally {
    closeReview();
  }
}

function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** 0x9f3a…c21e; a click shows the whole address and copies it. */
function addressButton(address) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'address';
  button.dataset.full = address;
  button.title = `${address}\nClick to show and copy`;
  button.textContent = `${address.slice(0, 8)}…${address.slice(-6)}`;
  button.addEventListener('click', () => {
    button.classList.add('full');
    button.textContent = address;
    navigator.clipboard?.writeText(address).catch(() => {});
  });
  return button;
}

function render(record, result) {
  document.body.dataset.risk = result.risk;
  $('badge').textContent = BADGE[result.risk];
  $('origin').textContent = hostOf(record.origin);
  $('headline').textContent = result.headline;

  $('facts').replaceChildren(
    ...result.facts.map((f) => {
      const row = document.createElement('div');
      row.className = 'fact';
      const dt = document.createElement('dt');
      dt.textContent = f.label;
      const dd = document.createElement('dd');
      if (ADDRESS.test(f.value)) {
        dd.append(addressButton(f.value));
      } else {
        dd.textContent = f.value;
        if (f.mono) dd.classList.add('mono');
      }
      if (f.tone) dd.dataset.tone = f.tone;
      if (f.note) {
        const note = document.createElement('span');
        note.className = 'note';
        note.textContent = f.note;
        dd.append(note);
      }
      row.append(dt, dd);
      return row;
    }),
  );

  if (result.reasons.length > 0) {
    $('reasons').replaceChildren(
      ...result.reasons.map((text) => {
        const li = document.createElement('li');
        li.textContent = text;
        return li;
      }),
    );
    $('why').hidden = false;
  }

  if (typeof result.message === 'string') {
    $('message-text').textContent = result.message.slice(0, 4000);
    $('message').hidden = false;
  }

  // The safer choice is the prominent one.
  const safeIsReject = result.risk !== 'info';
  $('reject').classList.toggle('primary', safeIsReject);
  $('allow').classList.toggle('primary', !safeIsReject);
  $('allow').textContent = safeIsReject ? 'Continue anyway' : 'Continue to wallet';
}

// ── On-device explanation: starts by itself, nothing leaves the computer ──

function setChip(element, source, ms) {
  element.dataset.source = source;
  element.textContent = `${source === 'on_device' ? 'On device' : 'Cloud'} · ${seconds(ms)}`;
  element.hidden = false;
}

async function runLocal(result, host) {
  const text = $('local-text');
  const meta = $('local-meta');
  const download = $('local-download');
  const status = await deviceModelStatus();
  document.body.dataset.local = status;

  if (status === 'unavailable') {
    text.classList.remove('pending');
    text.classList.add('muted');
    text.textContent = 'On-device AI is not available in this browser. The facts below do not depend on it.';
    return;
  }

  if (status === 'downloadable' || status === 'downloading') {
    text.classList.remove('pending');
    text.textContent = 'The on-device model is not downloaded yet.';
    download.hidden = false;
    download.onclick = async () => {
      download.disabled = true;
      try {
        await downloadDeviceModel((percent) => {
          download.textContent = `Downloading the model… ${percent}%`;
        });
        download.hidden = true;
        await runLocal(result, host);
      } catch (error) {
        download.disabled = false;
        download.textContent = 'Download failed. Try again';
        console.warn('[Guardian] model download failed', error);
      }
    };
    return;
  }

  text.classList.add('pending');
  text.textContent = 'Explaining on this computer';
  try {
    const out = await explainOnDevice(explainPrompt(result, host), (partial) => {
      text.classList.remove('pending');
      text.textContent = partial;
    });
    text.classList.remove('pending');
    text.textContent = out.text;
    setChip($('local-chip'), out.source, out.ms);
    meta.textContent = 'Gemini Nano, running in Chrome. Nothing about this request left your computer.';
    meta.hidden = false;
    document.body.dataset.local = 'done';
  } catch (error) {
    text.classList.remove('pending');
    text.classList.add('muted');
    text.textContent = 'The on-device model could not answer this time. The facts below do not depend on it.';
    document.body.dataset.local = 'error';
    console.warn('[Guardian] on-device explanation failed', error);
  }
}

// ── Cloud analysis: only after the user presses the button ────────────────

function wireCloud(result, host) {
  const ask = $('cloud-ask');
  if (!cloudReady) {
    ask.hidden = true;
    $('cloud-consent').textContent = 'Cloud analysis is not set up in this build. Nothing is sent anywhere.';
    document.body.dataset.cloud = 'off';
    return;
  }
  ask.addEventListener('click', async () => {
    ask.disabled = true;
    ask.textContent = 'Asking Gemini in the cloud…';
    document.body.dataset.cloud = 'pending';
    try {
      const out = await analyzeInCloud(deepPrompt(result, host));
      $('cloud-summary').textContent = String(out.data.summary || '');
      $('cloud-confirm').textContent = String(out.data.ifYouConfirm || '');
      $('cloud-pattern').textContent = String(out.data.pattern || '');
      $('cloud-checks').replaceChildren(
        ...(Array.isArray(out.data.checks) ? out.data.checks : []).slice(0, 4).map((item) => {
          const li = document.createElement('li');
          li.textContent = String(item);
          return li;
        }),
      );
      $('cloud-result').hidden = false;
      setChip($('cloud-chip'), out.source, out.ms);
      ask.hidden = true;
      $('cloud-consent').textContent = 'Gemini through Firebase AI Logic, at your request.';
      document.body.dataset.cloud = 'done';
    } catch (error) {
      const message = String((error && error.message) || error);
      ask.disabled = false;
      ask.textContent = 'Cloud analysis failed. Try again';
      $('cloud-consent').textContent = /free tier is not available|billing/i.test(message)
        ? 'Cloud AI is not switched on for this Firebase project yet. Nothing was analyzed in the cloud.'
        : 'The cloud could not be reached. Nothing was analyzed in the cloud.';
      document.body.dataset.cloud = 'error';
      document.body.dataset.cloudError = message.slice(0, 300);
      console.warn('[Guardian] cloud analysis failed', error);
    }
  });
}

async function main() {
  if (isPreview) document.body.dataset.host = 'preview';
  const record = await loadReview(id);
  if (!record) {
    $('headline').textContent = 'This request is no longer waiting';
    $('local').hidden = true;
    $('cloud').hidden = true;
    $('allow').hidden = true;
    $('reject').textContent = 'Close';
    $('reject').addEventListener('click', () => decide('reject'));
    return;
  }

  const result = analyze(record);
  const host = hostOf(record.origin);
  render(record, result);

  $('reject').addEventListener('click', () => decide('reject'));
  $('allow').addEventListener('click', () => decide('allow'));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') decide('reject');
  });

  wireCloud(result, host);
  runLocal(result, host);
}

main();
