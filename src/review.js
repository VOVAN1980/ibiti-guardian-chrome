// Guardian's own review window (an extension page the site cannot touch; in
// the hosted demo, the same page shown in a frame).
// Facts, the risk level and the sentence on what confirming does come from
// the deterministic analyzer. Gemini reads the same facts and fills in a form
// that code checks against them; only then is its short note shown. On this
// computer by default; in the cloud only when the user has allowed it (the
// hybrid fallback) or asks for the deeper analysis.

import { analyze } from './analyzer/index.js';
import { analyzeInCloud, cloudReady, deviceModelStatus, downloadDeviceModel, readHybrid, readOnDevice } from './ai/engine.js';
import { codeSentence, isUndecoded, ownAddresses, scrubAddresses, scrubResult } from './ai/guard.js';
import { deepPrompt, meaning, readingPrompt, shownReasons } from './ai/prompt.js';
import { PATTERNS, checkAnalysis, checkExplanation } from './ai/reading.js';
import {
  allowCloudFallback,
  closeReview,
  cloudFallbackAllowed,
  isPreview,
  loadReview,
  onCloudFallbackOff,
  saveLastExplanation,
  sendDecision,
} from './host.js';

const BADGE = { danger: 'High risk', caution: 'Check carefully', info: 'No red flags found' };
const $ = (id) => document.getElementById(id);
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

const id = new URLSearchParams(location.search).get('id');
let decided = false;
// The user's own address(es) in this request: removed from anything that may
// be sent to the cloud.
let own = [];

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

// ── Short explanation: what confirming does, written by code; Gemini's
// reading of it, checked, and its note. On this computer by default; with the
// user's permission, the SDK's hybrid mode falls back to the cloud when this
// computer has no on-device model ──

function setChip(element, source, ms, label) {
  element.dataset.source = source;
  element.textContent = `${source === 'on_device' ? 'On device' : label || 'Cloud'} · ${seconds(ms)}`;
  element.hidden = false;
}

function offerDownload(result, host) {
  const download = $('local-download');
  download.hidden = false;
  download.disabled = false;
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
}

/**
 * The explanation prompt. Never with the user's own address (taken out of
 * every value before any value is shortened, and again from the finished
 * text). The one that may go to the cloud also leaves out the balance.
 */
const cloudPrompt = (result, host) =>
  scrubAddresses(readingPrompt(scrubResult(result, own), host, { cloud: true }), own);
const devicePrompt = (result, host) => scrubAddresses(readingPrompt(scrubResult(result, own), host), own);

/** The network of the request under review (for the coin it pays gas in). */
let chainId = null;

// When the user pressed "Ask cloud AI" (performance.now() time): requests
// from then on are the deeper analysis, not the explanation.
let deepAskedAt = Infinity;

/** Shows the exact text that would be (or was) sent to the cloud. */
function showSent(prompt, sent) {
  $('local-sent').textContent = prompt;
  $('local-sent-label').textContent = sent ? 'Exactly what was sent' : 'Exactly what would be sent';
  $('local-sent-box').hidden = false;
}

/** The one-time permission, offered only when this computer has no model. */
function offerFallback(result, host) {
  if (!cloudReady) return;
  if (isPreview) {
    $('local-fallback-note').textContent =
      'Gemini in the cloud then explains instead, through Firebase, for the rest of this visit whenever this browser ' +
      'has no on-device model. Sends the decoded details below, never your wallet address.';
  }
  showSent(cloudPrompt(result, host), false);
  $('local-fallback').hidden = false;
  const allow = $('local-fallback-allow');
  allow.onclick = async () => {
    allow.disabled = true;
    await allowCloudFallback();
    $('local-fallback').hidden = true;
    $('local-download').hidden = true;
    await runLocal(result, host);
  };
}

// A cloud call that never starts (on the hosted demo, reCAPTCHA blocked by a
// privacy tool or a network filter) must not leave the window waiting.
const CLOUD_TIMEOUT_MS = 30000;

/**
 * Waits for `promise` at most `ms`. On time-out it also calls `onTimeout`,
 * which aborts the request: a late answer must not appear after the window
 * has said there was none, and nothing may be sent after that either.
 */
function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`no answer within ${ms / 1000} s`);
        error.name = 'TimeoutError';
        if (onTimeout) onTimeout(error);
        reject(error);
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Requests this window made to other sites between `since` and `until`
 * (performance.now() times), leaving out the deeper analysis the user asked
 * for: the evidence behind "nothing was sent" for an on-device answer.
 */
function cloudRequestsBetween(since, until) {
  return performance
    .getEntriesByType('resource')
    .filter(
      (e) =>
        e.startTime >= since &&
        e.startTime <= until &&
        e.startTime < deepAskedAt &&
        !e.name.startsWith(location.origin) &&
        !/^(chrome-extension|data|blob):/.test(e.name),
    ).length;
}

/** Why a cloud call failed, in words the user can act on. */
function cloudProblem(error) {
  const message = String((error && error.message) || error);
  if (error && error.name === 'TimeoutError') return 'The cloud did not answer within 30 seconds.';
  if (/free tier is not available|billing/i.test(message)) {
    return 'Cloud AI is not switched on for this Firebase project yet.';
  }
  if (/quota|429|resource.exhausted/i.test(message)) return 'The cloud AI is busy right now (usage limit).';
  return 'The cloud could not be reached.';
}

// What the window says about Gemini's part, once code has checked it.
const COMPARED = 'what it is, who gains, which way assets move, the limit';

/** Marks the analyzer's reasons that Gemini picked as the most important. */
function markTop(top) {
  const items = [...document.querySelectorAll('#reasons li')];
  for (const li of items) {
    delete li.dataset.top;
    li.querySelector('.pick')?.remove();
  }
  for (const n of top) {
    const li = items[n - 1];
    if (!li) continue;
    li.dataset.top = String(n);
    const pick = document.createElement('span');
    pick.className = 'pick';
    pick.textContent = 'Gemini: most important';
    li.append(pick);
  }
  document.body.dataset.top = top.join(',');
}

async function runLocal(result, host) {
  const text = $('local-text');
  const note = $('local-note');
  const meta = $('local-meta');
  const status = await deviceModelStatus();
  const deviceReady = status === 'available';
  const canDownload = status === 'downloadable' || status === 'downloading';
  const hybrid = cloudReady && (await cloudFallbackAllowed());
  document.body.dataset.local = status;
  document.body.dataset.fallback = hybrid ? 'on' : 'off';

  // Nothing from an earlier answer in this window may stay on screen.
  $('local-chip').hidden = true;
  $('local-sent-box').hidden = true;
  meta.hidden = true;
  note.hidden = true;
  note.textContent = '';
  note.classList.remove('pending', 'muted');
  markTop([]);
  for (const key of ['source', 'checked', 'withheld', 'withheldDetail', 'reading', 'stopped', 'localError']) {
    delete document.body.dataset[key];
  }

  // What confirming does, written by code from the decoded request: shown at
  // once, whatever any AI says or fails to say.
  text.textContent = codeSentence(result, meaning(result, host));

  // Nothing decoded, nothing to explain: a model could only guess what the
  // request does. Guardian says so itself, and no AI is asked.
  if (isUndecoded(result)) {
    meta.textContent =
      'Guardian could not decode this request, so no AI explains it: an explanation could only be a guess. Written by Guardian.';
    meta.hidden = false;
    document.body.dataset.local = 'undecoded';
    return;
  }

  if (!deviceReady && !hybrid) {
    meta.textContent = canDownload
      ? 'Written by Guardian. Gemini Nano can add a note once its model is downloaded.'
      : 'Written by Guardian. On-device AI is not available in this browser; the facts below do not depend on it.';
    meta.hidden = false;
    if (canDownload) offerDownload(result, host);
    offerFallback(result, host);
    return;
  }

  $('local-fallback').hidden = true;
  note.hidden = false;
  note.classList.add('pending');
  note.textContent = deviceReady
    ? 'Gemini Nano is reading this request on your computer…'
    : 'Gemini is reading this request in the cloud…';

  const toCloud = hybrid && !deviceReady;
  // With the permission on, the SDK decides where the answer is written, and
  // it decides again at the moment of the call: Gemini Nano that was ready a
  // moment ago may be gone. So whatever is handed to the hybrid mode is
  // already the text that may go to the cloud: no own address, no balance.
  const prompt = hybrid ? cloudPrompt(result, host) : devicePrompt(result, host);
  // The reason numbers that prompt showed: the only ones Gemini may pick.
  const shown = shownReasons(result, { cloud: hybrid }).map(([n]) => n);
  const started = performance.now();

  // Turning the permission off stops a cloud request that has not gone out,
  // on either path of the hybrid mode; so does the time-out.
  const stop = new AbortController();
  const stopListening = hybrid ? onCloudFallbackOff(() => stop.abort(new Error('cloud turned off'))) : () => {};
  let run = null;
  try {
    run = hybrid ? readHybrid(prompt, { deviceReady, signal: stop.signal }) : readOnDevice(prompt);
    const out = toCloud ? await withTimeout(run, CLOUD_TIMEOUT_MS, (e) => stop.abort(e)) : await run;
    const verdict = checkExplanation(out.text, result, { sentence: meaning(result, host), own, chainId, host, shown });
    note.classList.remove('pending');
    setChip($('local-chip'), out.source, out.ms, 'Cloud fallback');
    const requests = cloudRequestsBetween(started, performance.now());
    const where =
      out.source === 'on_device'
        ? `Gemini Nano, running in Chrome on your computer${requests === 0 ? ': nothing was sent to an AI service' : ''}.`
        : 'No on-device model here, so Gemini answered in the cloud through Firebase, as you allowed. Your wallet address was not sent.';
    if (verdict.checked === 'passed') {
      note.textContent = verdict.note;
      meta.textContent = `${where} Its reading of the request matched Guardian's decoder (${COMPARED}), so its note is shown. The sentence above is written by Guardian.`;
    } else {
      note.hidden = true;
      note.textContent = '';
      meta.textContent =
        verdict.checked === 'note-withheld'
          ? `${where} Its reading of the request matched Guardian's decoder (${COMPARED}), but its note was not shown: it had ${verdict.problem}. The sentence above is written by Guardian.`
          : `${where} Nothing from it is shown: it gave ${verdict.problem}. The sentence above is written by Guardian.`;
    }
    markTop(verdict.top);
    meta.hidden = false;
    if (out.source !== 'on_device') showSent(prompt, true);
    $('local-chip').title = `Answered after ${seconds(out.ms)}. Network requests from this window meanwhile: ${requests}.`;
    Object.assign(document.body.dataset, {
      local: 'done',
      source: out.source,
      ms: String(out.ms),
      requests: String(requests),
      checked: verdict.checked,
      reading: out.text.slice(0, 2000), // tests and logs only
    });
    if (verdict.problem) {
      document.body.dataset.withheld = verdict.problem;
      document.body.dataset.withheldDetail = verdict.detail || ''; // tests and logs only
    }
    saveLastExplanation({ source: out.source, ms: out.ms, requests, checked: verdict.checked });
  } catch (error) {
    if (run) run.catch(() => {}); // a late failure after the time-out
    note.classList.remove('pending');
    note.classList.add('muted');
    note.hidden = false;
    const message = String((error && error.message) || error);
    const turnedOff = stop.signal.aborted && /turned off/i.test(String(stop.signal.reason && stop.signal.reason.message));
    if (turnedOff) {
      note.textContent = 'Cloud AI was turned off, so Gemini was stopped. The facts below do not depend on it.';
      document.body.dataset.stopped = 'turned-off';
    } else if (toCloud) {
      note.textContent = `${cloudProblem(error)} The facts below do not depend on it.`;
      meta.textContent = isPreview
        ? 'Cloud AI stays allowed for this visit.'
        : 'Cloud AI can be turned off in Guardian’s toolbar panel.';
      meta.hidden = false;
    } else {
      note.textContent = 'The AI could not answer this time. The facts below do not depend on it.';
    }
    document.body.dataset.local = 'error';
    document.body.dataset.localError = message.slice(0, 300);
    saveLastExplanation({ source: toCloud ? 'in_cloud' : 'unknown', error: turnedOff ? 'turned off' : cloudProblem(error) });
    console.warn('[Guardian] explanation failed', error);
  } finally {
    stopListening();
    // The cloud stood in (or tried to) for a model this computer can still
    // download: keep offering it.
    if (hybrid && canDownload) {
      $('local-download').textContent = 'Download the on-device model to keep this on your computer';
      offerDownload(result, host);
    }
  }
}

// ── Cloud analysis: only after the user presses the button ────────────────

function wireCloud(result, host) {
  const ask = $('cloud-ask');
  if (!cloudReady) {
    ask.hidden = true;
    $('cloud-sent-box').hidden = true;
    $('cloud-consent').textContent = 'Cloud analysis is not set up in this build. Nothing is sent anywhere.';
    document.body.dataset.cloud = 'off';
    return;
  }
  // Nothing decoded: nothing for an analysis to work from but guesses.
  if (isUndecoded(result)) {
    ask.hidden = true;
    $('cloud-sent-box').hidden = true;
    $('cloud-consent').textContent =
      'Guardian could not decode this request, so there is nothing for an AI analysis to work from. Nothing is sent.';
    document.body.dataset.cloud = 'undecoded';
    return;
  }
  const prompt = scrubAddresses(deepPrompt(scrubResult(result, own), host), own);
  $('cloud-sent').textContent = prompt;
  ask.addEventListener('click', async () => {
    ask.disabled = true;
    ask.textContent = 'Asking Gemini in the cloud…';
    document.body.dataset.cloud = 'pending';
    deepAskedAt = Math.min(deepAskedAt, performance.now());
    const stop = new AbortController();
    try {
      const out = await withTimeout(analyzeInCloud(prompt, { signal: stop.signal }), CLOUD_TIMEOUT_MS, (e) => stop.abort(e));
      const verdict = checkAnalysis(out.text, result, { sentence: meaning(result, host), own, chainId, host });
      document.body.dataset.cloudReading = out.text.slice(0, 3000); // tests and logs only
      $('cloud-checks').replaceChildren();
      if (verdict.passed) {
        $('cloud-summary').textContent = verdict.summary;
        $('cloud-summary').hidden = false;
        $('cloud-confirm').textContent = '';
        $('cloud-confirm').hidden = true;
        $('cloud-pattern').textContent = PATTERNS[verdict.pattern].label;
        $('cloud-checks').append(
          ...verdict.checks.map((item) => {
            const li = document.createElement('li');
            li.textContent = item;
            return li;
          }),
        );
        document.body.dataset.cloudChecked = 'passed';
        document.body.dataset.patternKind = verdict.pattern;
      } else {
        $('cloud-summary').textContent = '';
        $('cloud-summary').hidden = true;
        $('cloud-confirm').textContent = `Gemini's analysis was not shown: it had ${verdict.problem}. The sentence at the top is written by Guardian.`;
        $('cloud-confirm').hidden = false;
        $('cloud-pattern').textContent = '';
        document.body.dataset.cloudChecked = 'withheld';
        document.body.dataset.cloudWithheld = verdict.problem;
        document.body.dataset.cloudWithheldDetail = verdict.detail; // tests and logs only
        document.body.dataset.patternKind = 'withheld';
      }
      $('cloud-result').hidden = false;
      setChip($('cloud-chip'), out.source, out.ms);
      ask.hidden = true;
      $('cloud-sent-box').querySelector('summary').textContent = 'Exactly what was sent';
      $('cloud-consent').textContent = verdict.passed
        ? 'Gemini through Firebase AI Logic, at your request. Its reading of the request and the scam pattern it named matched Guardian’s decoder, and its own words name nothing.'
        : 'Gemini through Firebase AI Logic, at your request. Its answer did not pass Guardian’s checks.';
      document.body.dataset.cloud = 'done';
    } catch (error) {
      const message = String((error && error.message) || error);
      ask.disabled = false;
      ask.textContent = 'Cloud analysis failed. Try again';
      $('cloud-consent').textContent = `${cloudProblem(error)} Nothing was analyzed in the cloud.`;
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
  own = ownAddresses(record);
  chainId = typeof record.chainId === 'number' ? record.chainId : null;
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
