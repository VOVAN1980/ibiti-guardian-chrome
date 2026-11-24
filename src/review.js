// Guardian's own review window (an extension page the site cannot touch; in
// the hosted demo, the same page shown in a frame).
// Facts, the risk level, the warnings and the sentence on what confirming
// does come from the deterministic analyzer. Gemini reads the same facts and
// fills in a form that code checks against them; only then are its picks
// used. Nothing a model writes is shown as text. On this computer by
// default; in the cloud only when the user has allowed it (the hybrid
// fallback) or asks for the deeper analysis.

import { analyze } from './analyzer/index.js';
import { OFFERS, contradiction } from './analyzer/promise.js';
import {
  analyzeInCloud,
  cloudReady,
  deviceModelStatus,
  downloadDeviceModel,
  readHybrid,
  readInCloud,
  readOnDevice,
} from './ai/engine.js';
import { codeSentence, isUndecoded, ownAddresses, scrubAddresses, scrubResult } from './ai/guard.js';
import { deepPrompt, meaning, readingPrompt, shownReasons } from './ai/prompt.js';
import { PATTERN_NOTE, checkAnalysis, checkExplanation, geminiOffer, mostImportant } from './ai/reading.js';
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
// The title over the reasons listed first, by risk.
const TOP_TITLE = { danger: 'Why it is high risk', caution: 'What to check', info: 'Good to know' };
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
  disarm();
  $('reject').disabled = true;
  $('allow').disabled = true;
  try {
    await sendDecision(id, decision);
  } finally {
    closeReview();
  }
}

// ── Continue waits a moment ─────────────────────────────────────────────────
// The window opens focused, at a spot a page can work out. A page that keeps
// the user clicking fast there ("click to verify", "tap as fast as you can")
// could land a click on Continue. So Continue comes alive only once the
// window has been on screen and in focus for a moment, and again after every
// focus change, like the browser's own permission prompts. Then a click,
// Enter or Space counts only after a pause in clicking and pressing keys: a
// run of fast clicks or key presses never does. Reject and Escape work at
// once.
const ARM_MS = 800;
// The pause before the deciding press, about a double-click's interval.
const PAUSE_MS = 500;
let canArm = false; // the request is on screen in full
let armed = false;
let armedAt = Infinity; // performance.now() when Continue came alive
let pressedAt = -Infinity; // the latest press in this window: a pointer or a key
let pressedBefore = -Infinity; // the press before it
let keyHeld = false; // the latest key press repeats a key held down
let byKey = false; // a key event is being handled: a click now is that key's
let armTimer = null;

// The preview is a frame inside the demo page, which owns that frame anyway:
// there only the delay applies, not the focus.
const inFocus = () => document.visibilityState === 'visible' && (isPreview || document.hasFocus());

function disarm() {
  clearTimeout(armTimer);
  armTimer = null;
  armed = false;
  armedAt = Infinity;
  const allow = $('allow');
  allow.disabled = true;
  delete allow.dataset.arming;
  document.body.dataset.continue = 'off'; // tests and logs only
  hideAgain();
}

// A press on a live Continue that did not count: the window says so for a
// moment, just above the buttons and over the content, so they never move.
// The box is a live region: a screen reader hears it once per showing.
const AGAIN = 'Continue counts a press only after a short pause. Press it again to confirm.';
let againTimer = null;
function hideAgain() {
  clearTimeout(againTimer);
  $('again').replaceChildren();
}
function notCounted() {
  clearTimeout(againTimer);
  if (!$('again').firstChild) {
    const note = document.createElement('span');
    note.textContent = AGAIN;
    $('again').replaceChildren(note);
  }
  againTimer = setTimeout(hideAgain, 4000);
}

/** Starts (or restarts) the wait; Continue comes alive at its end. */
function arm() {
  disarm();
  if (!canArm || decided || !inFocus()) return;
  const allow = $('allow');
  allow.style.setProperty('--arm', `${ARM_MS}ms`);
  allow.dataset.arming = '';
  document.body.dataset.continue = 'arming';
  armTimer = setTimeout(() => {
    armTimer = null;
    if (!canArm || decided || !inFocus()) return;
    armed = true;
    armedAt = performance.now();
    delete allow.dataset.arming;
    allow.disabled = false;
    document.body.dataset.continue = 'on';
  }, ARM_MS);
}

/**
 * Whether a click on a live Continue is the user's decision: its press began
 * after Continue came alive, and a pause after the press before it, whether
 * that was a click, a tap or a key. A mouse click or a tap (detail above 0)
 * is measured from its pointer press; Enter or Space on a focused Continue
 * from the key's own press, and a key held down never counts. A click that
 * no pointer or key in this window made (a screen reader pressing the button
 * for the user) counts after a pause since the last press.
 */
function deliberate(event) {
  const paused = pressedAt >= armedAt && pressedAt - pressedBefore >= PAUSE_MS;
  if (event.detail > 0) return paused;
  if (byKey) return !keyHeld && paused;
  return !keyHeld && performance.now() - pressedAt >= PAUSE_MS;
}

function wireContinue() {
  // On the window, in the capture phase: it also gets the presses on
  // Continue while it is off (a disabled button gets no mousedown or click,
  // but the window still gets the pointerdown), so it sees the whole run.
  const press = () => {
    pressedBefore = pressedAt;
    pressedAt = performance.now();
  };
  window.addEventListener('pointerdown', press, true);
  // Every key press counts too; the repeats of a key held down do not.
  window.addEventListener(
    'keydown',
    (event) => {
      keyHeld = event.repeat;
      if (!event.repeat) press();
    },
    true,
  );
  // A key's click comes while that key's event is handled (Enter's with its
  // keypress, Space's with its keyup), before the next task.
  for (const type of ['keydown', 'keypress', 'keyup']) {
    window.addEventListener(
      type,
      () => {
        byKey = true;
        setTimeout(() => (byKey = false));
      },
      true,
    );
  }
  $('allow').addEventListener('click', (event) => {
    if (!armed) return;
    if (deliberate(event)) decide('allow');
    else notCounted();
  });
  if (!isPreview) {
    window.addEventListener('focus', arm);
    window.addEventListener('blur', disarm);
  }
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? arm() : disarm()));
}

// A sandboxed or hidden frame has no address of its own: its origin is "null".
const UNKNOWN_SITE = 'A site Guardian cannot identify';

/** The site as the window's header names it, or null when it has no web address. */
function siteOf(origin) {
  try {
    const url = new URL(origin);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && url.host) return url.host;
  } catch {
    // not an address
  }
  return null;
}

/** Writes the site at the top of the window: "<site> wants your wallet to confirm". */
function showSite(origin) {
  const site = siteOf(origin);
  $('origin').textContent = site || UNKNOWN_SITE;
  if (site) delete $('origin').dataset.unknown;
  else $('origin').dataset.unknown = '';
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

// A text message to sign is shown whole, up to a length no honest one
// reaches; a longer one is cut there, and the window says so.
const MESSAGE_SHOWN = 100000;
const grouped = (n) => n.toLocaleString('en-US');

/** Draws the request. Returns false when part of it could not be shown. */
function render(record, result) {
  document.body.dataset.risk = result.risk;
  $('badge').textContent = BADGE[result.risk];
  showSite(record.origin);
  $('headline').textContent = result.headline;
  showPromise(result);

  // The button is shown above, with what it offered: not again here.
  const above = Boolean((result.subject || {}).promise);
  const facts = result.facts.filter((f) => !(above && f.label === 'Button pressed'));
  $('facts').replaceChildren(
    ...facts.map((f) => {
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

  // The warnings at the top, the other reasons under "Also worth knowing".
  showImportant(result, [], '');

  // The whole message: the box scrolls.
  let whole = true;
  if (typeof result.message === 'string') {
    const text = result.message;
    whole = text.length <= MESSAGE_SHOWN;
    $('message-text').textContent = whole ? text : text.slice(0, MESSAGE_SHOWN);
    $('message-cut').textContent = whole ? '' : `Guardian shows the first ${grouped(MESSAGE_SHOWN)} of ${grouped(text.length)} characters.`;
    $('message-cut').hidden = whole;
    $('message').hidden = false;
  }

  // The window's motion starts now, with the request on screen.
  document.body.dataset.shown = '';

  // The safer choice is the prominent one.
  const safeIsReject = result.risk !== 'info';
  $('reject').classList.toggle('primary', safeIsReject);
  $('allow').classList.toggle('primary', !safeIsReject);
  $('allow').textContent = safeIsReject ? 'Continue anyway' : 'Continue to wallet';
  return whole;
}

// ── Short explanation: what confirming does and the warnings, written by
// code; Gemini's own reading of the request, checked against the decoder,
// adds the reasons it finds most important. On this computer by default;
// with the user's permission, the SDK's hybrid mode falls back to the cloud
// when this computer has no on-device model, and the cloud reads the request
// once more when Gemini Nano's answer does not pass the check ──

/** The AI status when no AI reads this request: a grey chip. */
function noAi(text) {
  const chip = $('local-chip');
  chip.textContent = text;
  chip.dataset.source = 'none';
  chip.hidden = false;
}

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

/**
 * The one-time permission: offered when this computer has no model, or when
 * Gemini Nano's answer did not pass Guardian's check (`afterNano`). The same
 * permission covers both, and says so.
 */
function offerFallback(result, host, { afterNano = false, nanoProblem = '' } = {}) {
  if (!cloudReady) return;
  if (isPreview) {
    $('local-fallback-note').textContent =
      'For the rest of this visit, Gemini in the cloud (Firebase) then reads requests when this browser has no ' +
      'Gemini Nano, and once more whenever Gemini Nano’s answer does not pass Guardian’s check. It gets the ' +
      'request’s details and the page’s words near the button, which may include a name. Never your wallet address.';
  }
  showSent(cloudPrompt(result, host), false);
  $('local-fallback').hidden = false;
  const allow = $('local-fallback-allow');
  allow.disabled = false;
  allow.onclick = async () => {
    allow.disabled = true;
    await allowCloudFallback();
    $('local-fallback').hidden = true;
    $('local').focus();
    $('local-download').hidden = true;
    // Gemini Nano has already answered this one: only the cloud is asked now.
    await runLocal(result, host, { cloudOnly: afterNano, nanoProblem });
  };
}

// A cloud call that never starts (on the hosted demo, reCAPTCHA blocked by a
// privacy tool or a network filter) must not leave the window waiting.
const CLOUD_TIMEOUT_MS = 45000;
// Gemini Nano usually answers in 15 to 30 s (the first time after a pause,
// up to about a minute); it has also been seen to hang on a page in another
// language. After this long its answer counts as not given.
const DEVICE_TIMEOUT_MS = 90000;

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
  if (error && error.name === 'TimeoutError') return 'The cloud did not answer within 45 seconds.';
  if (/free tier is not available|billing/i.test(message)) {
    return 'Cloud AI is not switched on for this Firebase project yet.';
  }
  if (/quota|429|resource.exhausted/i.test(message)) return 'The cloud AI is busy right now (usage limit).';
  return 'The cloud could not be reached.';
}

// Everything the window says about Gemini's part is written here, by code.
// The main view never says Gemini "agrees": a reader could take that for an
// all-clear. Whether its reading matched the decoder is in the details.
const WRITTEN_BY_GUARDIAN = 'Every word here is written by Guardian: Gemini answers a form, never text that is shown.';
const differed = (problem) => problem.replace(/^a different reading of the request \((.*)\)$/, '$1');
/**
 * Says that an AI is reading, and for how long so far, once a second, until
 * the returned function is called.
 */
function waiting(note, what) {
  const since = performance.now();
  // The note is in a live region: a screen reader hears it once, not the
  // seconds every second.
  const count = document.createElement('span');
  count.setAttribute('aria-hidden', 'true');
  note.replaceChildren(`${what}: `, count, ' You can decide without it.');
  const tick = () => {
    count.textContent = `${Math.floor((performance.now() - since) / 1000)} s so far.`;
  };
  tick();
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}

const NO_ANSWER = 'no answer within 90 seconds';
/** Why Gemini Nano's answer was not used, as a sentence's start. */
const nanoNotUsed = (problem) =>
  problem === NO_ANSWER ? 'Gemini Nano did not answer within 90 seconds' : 'Gemini Nano’s answer did not pass Guardian’s check';

/** What went wrong with a model's answer, after its name: "gave no usable answer", … */
const failure = (problem) =>
  problem === 'no usable answer'
    ? 'gave no usable answer'
    : problem === NO_ANSWER
      ? 'did not answer within 90 seconds'
      : `read the request differently from Guardian’s decoder (${differed(problem)})`;

/** The warning code wrote for a button that contradicts the request, if any. */
const clashOf = (result) => (((result.subject || {}).promise || {}).clash ? result.warnings[0] : null);

/**
 * The button the user pressed against what confirming really does: the
 * first thing on screen. Code reads plain words; for words it cannot read,
 * `gemini` is Gemini's reading once its whole answer passed the check:
 * { offer, warning, where }, or { pending: true } while it reads. Only code
 * may say there is no mismatch, and only on a request with no red flags.
 */
function showPromise(result, gemini = null) {
  const promise = (result.subject || {}).promise;
  $('promise').hidden = !promise;
  if (!promise) return;
  $('promise-button').textContent = promise.button;
  const label = (offer) => (OFFERS[offer] ? OFFERS[offer].label : null);
  const pending = Boolean(!promise.offer && gemini && gemini.pending);
  const read = !promise.offer && gemini && !gemini.pending ? gemini : null;
  // A button that names more than one thing ("Approve and claim"): without a
  // mismatch, the one that fits the request.
  const own = promise.clash
    ? promise.offer
    : (promise.offers || []).find((o) => !contradiction(o, result, promise.button)) || promise.offer;
  let line = 'Guardian cannot tell what these words offer';
  if (promise.offer) line = `Guardian reads this as: ${label(own)}`;
  else if (pending) line = 'Guardian’s code cannot read these words';
  else if (read && label(read.offer)) line = `${read.where} reads this as: ${label(read.offer)}`;
  else if (read) line = `${read.where} finds no clear offer in these words`;
  const reading = $('promise-reading');
  if (reading.textContent !== line) reading.textContent = line;
  reading.dataset.by = promise.offer ? 'guardian' : read ? 'gemini' : '';
  // Unclear words: the heading they sit under, which Gemini reads them with.
  const context = $('promise-context');
  context.textContent = !promise.offer && promise.heading ? `under “${promise.heading}”` : '';
  context.hidden = !context.textContent;

  const warning = promise.offer ? clashOf(result) : read ? read.warning : null;
  const by = promise.offer ? 'guardian' : 'gemini';
  const state = warning ? 'clash' : pending ? 'pending' : promise.offer && result.risk === 'info' ? 'none' : '';
  const verdict = $('promise-verdict');
  verdict.hidden = !state;
  verdict.dataset.state = state || 'off';
  verdict.dataset.by = by;
  const text =
    state === 'clash'
      ? by === 'gemini'
        ? 'Does not match · read by Gemini'
        : 'Does not match'
      : state === 'pending'
        ? 'Gemini is reading…'
        : 'No mismatch found';
  // The whole warning, in code's words, for screen readers (and the record).
  const whole =
    state === 'clash'
      ? warning
      : state === 'pending'
        ? 'Gemini is reading the button’s words.'
        : 'No mismatch found between the button and the request.';
  if (state && verdict.dataset.text !== whole) {
    verdict.dataset.text = whole;
    const shown = document.createElement('span');
    shown.setAttribute('aria-hidden', 'true');
    shown.textContent = text;
    const said = document.createElement('span');
    said.className = 'sr-only';
    said.textContent = whole;
    verdict.replaceChildren(shown, said);
  }
  document.body.dataset.promise = warning ? `clash:${by}` : state === 'none' ? 'none' : pending ? 'reading' : 'unread';
}

/**
 * The reasons listed first: Guardian's warnings, always, then the ones
 * Gemini picked (the analyzer's own words, in Gemini's order). A button that
 * contradicts the request is shown above, once, not again here.
 */
function showImportant(result, top, where) {
  const clash = clashOf(result);
  const items = mostImportant(result, top).filter((i) => i.text !== clash);
  $('local-title').textContent = items.length ? TOP_TITLE[result.risk] : 'AI check';
  $('local-top').replaceChildren(
    ...items.map((item) => {
      const li = document.createElement('li');
      li.textContent = item.text;
      li.dataset.reason = String(item.n);
      li.dataset.by = item.by;
      return li;
    }),
  );
  $('local-important').hidden = items.length === 0;
  // The other reasons, once each: under "Also worth knowing".
  const listed = new Set(items.map((i) => i.n).filter((n) => n > 0));
  if (clash) listed.add(result.reasons.indexOf(clash) + 1);
  const rest = result.reasons.map((text, i) => [i + 1, text]).filter(([n]) => !listed.has(n));
  $('reasons').replaceChildren(
    ...rest.map(([n, text]) => {
      const li = document.createElement('li');
      li.textContent = text;
      li.dataset.reason = String(n);
      return li;
    }),
  );
  $('why').hidden = rest.length === 0;
  const picked = items.some((i) => i.by === 'gemini');
  const warned = items.some((i) => i.by === 'guardian');
  $('local-picked').textContent = picked
    ? `✦ chosen by ${where} from Guardian’s list${warned ? ' · ⚠ always shown by Guardian' : ''}`
    : '';
  $('local-picked').hidden = !picked;
  document.body.dataset.top = top.join(',');
}

/** What Gemini answered and how code checked it: the details, not the main view. */
function showCheck(box, textEl, text) {
  textEl.textContent = text;
  box.hidden = false;
}

/**
 * `cloudOnly`: Gemini Nano has already answered this request and its reading
 * did not match; the user has just allowed the cloud, so only the cloud is asked.
 */
async function runLocal(result, host, { cloudOnly = false, nanoProblem = '' } = {}) {
  const text = $('local-text');
  const note = $('local-note');
  const meta = $('local-meta');
  const status = await deviceModelStatus();
  const hybrid = cloudReady && (await cloudFallbackAllowed());
  // Only with the permission on: the cloud prompt is the one without the balance.
  cloudOnly = cloudOnly && hybrid;
  const deviceReady = status === 'available' && !cloudOnly;
  const canDownload = status === 'downloadable' || status === 'downloading';
  document.body.dataset.local = status;
  document.body.dataset.fallback = hybrid ? 'on' : 'off';

  // Nothing from an earlier answer in this window may stay on screen.
  $('local-chip').hidden = true;
  $('local-sent-box').hidden = true;
  $('local-check-box').hidden = true;
  meta.hidden = true;
  note.hidden = true;
  note.textContent = '';
  note.classList.remove('pending', 'muted');
  for (const key of ['source', 'checked', 'withheld', 'withheldDetail', 'reading', 'stopped', 'localError', 'top', 'retried', 'nanoWithheld', 'offer', 'offerWarning']) {
    delete document.body.dataset[key];
  }

  // What confirming does and the warnings, written by code from the decoded
  // request: on screen at once, whatever any AI says or fails to say.
  text.textContent = codeSentence(result, meaning(result, host));
  showImportant(result, [], '');

  // Nothing decoded: a model could only guess what the request does. Guardian
  // says so itself, and no AI is asked.
  if (isUndecoded(result)) {
    noAi('No AI for this request');
    meta.textContent =
      'Guardian could not decode this request, so no AI reads it: an answer could only be a guess. Written by Guardian.';
    meta.hidden = false;
    document.body.dataset.local = 'undecoded';
    return;
  }

  if (!deviceReady && !hybrid) {
    noAi(canDownload ? 'Gemini Nano · not downloaded' : 'No on-device AI');
    meta.textContent = canDownload
      ? 'Gemini Nano can help once its model is downloaded. Everything here is Guardian’s own check.'
      : 'Gemini Nano is not in this browser. Everything here is Guardian’s own check.';
    meta.hidden = false;
    if (canDownload) offerDownload(result, host);
    offerFallback(result, host);
    return;
  }

  $('local-fallback').hidden = true;
  showPromise(result, { pending: true });
  note.hidden = false;
  note.classList.add('pending');
  // While the AI reads, the window says how long it has taken so far: the
  // facts and the buttons do not wait for it.
  let stopWaiting = waiting(
    note,
    deviceReady ? 'Gemini Nano is reading this request on your computer' : 'Gemini is reading this request in the cloud',
  );

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
  // Gemini Nano's own stop: its time-out must not stop the cloud's answer after it.
  const deviceStop = new AbortController();
  const stopListening = hybrid ? onCloudFallbackOff(() => stop.abort(new Error('cloud turned off'))) : () => {};
  let run = null;
  // Gemini Nano's answer, when its reading did not match and the cloud was
  // asked once more.
  let nano = null;
  try {
    run = cloudOnly
      ? readInCloud(prompt, { signal: stop.signal })
      : hybrid
        ? readHybrid(prompt, { deviceReady, signal: stop.signal, deviceSignal: deviceStop.signal })
        : readOnDevice(prompt, { deviceSignal: deviceStop.signal });
    let out;
    let verdict;
    if (toCloud) {
      out = await withTimeout(run, CLOUD_TIMEOUT_MS, (e) => stop.abort(e));
      verdict = checkExplanation(out.text, result, { shown });
    } else {
      try {
        out = await withTimeout(run, DEVICE_TIMEOUT_MS, (e) => deviceStop.abort(e));
        verdict = checkExplanation(out.text, result, { shown });
      } catch (error) {
        if (!error || error.name !== 'TimeoutError') throw error;
        run.catch(() => {});
        // No answer in time: the same as an answer that did not pass.
        out = { text: '', ms: DEVICE_TIMEOUT_MS, source: 'on_device', timedOut: true };
        verdict = { checked: 'withheld', words: '', top: [], offer: null, problem: NO_ANSWER, detail: '' };
      }
    }
    // Gemini Nano's reading did not match the decoder. With the user's
    // permission, Gemini in the cloud reads the request once more.
    if (verdict.checked !== 'passed' && out.source === 'on_device' && hybrid) {
      nano = { out, verdict };
      stopWaiting();
      stopWaiting = waiting(
        note,
        verdict.problem === NO_ANSWER
          ? 'Gemini Nano did not answer within 90 seconds. Gemini in the cloud is reading the request instead, as you allowed'
          : 'Gemini Nano’s answer did not pass Guardian’s check. Gemini in the cloud is reading it once more, as you allowed',
      );
      run = readInCloud(prompt, { signal: stop.signal });
      out = await withTimeout(run, CLOUD_TIMEOUT_MS, (e) => stop.abort(e));
      verdict = checkExplanation(out.text, result, { shown });
    }
    stopWaiting();
    note.classList.remove('pending');
    setChip($('local-chip'), out.source, out.ms, 'Cloud fallback');
    if (out.timedOut) {
      $('local-chip').textContent = 'On device · no answer in 90 s';
      $('local-chip').dataset.source = 'none';
    }
    const requests = cloudRequestsBetween(started, performance.now());
    const onDeviceRun = out.source === 'on_device';
    const model = onDeviceRun ? 'Gemini Nano on your computer' : 'Gemini in the cloud';
    const nanoFirst = nano
      ? `Gemini Nano on your computer ${failure(nano.verdict.problem)}, so Gemini in the cloud read it ${
          nano.verdict.problem === NO_ANSWER ? 'instead' : 'once more'
        }, as you allowed. `
      : '';
    // (Not while the user's own deeper analysis went to the cloud meanwhile.)
    const quiet = onDeviceRun && requests === 0 && deepAskedAt === Infinity;
    if (quiet && !out.timedOut) $('local-chip').textContent += ' · nothing sent';
    if (onDeviceRun) {
      meta.textContent = `Gemini Nano ran in Chrome on your computer${requests === 0 ? ': nothing was sent to an AI service' : ''}.`;
    } else if (nano || cloudOnly) {
      meta.textContent = `${nanoNotUsed(nano ? nano.verdict.problem : nanoProblem)}, so Gemini in the cloud read the request through Firebase, as you allowed. Your wallet address was not sent.`;
    } else {
      meta.textContent =
        'No on-device model here, so Gemini answered in the cloud through Firebase, as you allowed. Your wallet address was not sent.';
    }
    if (verdict.checked === 'passed') {
      note.hidden = true;
      note.textContent = '';
      const offerWarning = geminiOffer(result, verdict.offer);
      showImportant(result, verdict.top, model);
      showPromise(result, { offer: verdict.offer, warning: offerWarning, where: onDeviceRun ? 'Gemini Nano' : 'Gemini in the cloud' });
      document.body.dataset.offer = verdict.offer || '';
      if (offerWarning) document.body.dataset.offerWarning = '1';
      showCheck(
        $('local-check-box'),
        $('local-check'),
        `${nanoFirst}${model} read the decoded facts on its own, without Guardian’s sentence, and answered a form. Its reading matched Guardian’s decoder: ${verdict.words}. Only then were its picks used. ${WRITTEN_BY_GUARDIAN}`,
      );
    } else {
      note.classList.add('muted');
      note.textContent = 'Gemini’s answer was not used this time. Everything here is Guardian’s own.';
      showPromise(result);
      showCheck(
        $('local-check-box'),
        $('local-check'),
        `${nanoFirst}${
          `${model} ${failure(verdict.problem)}, so none of its answer was used.`
        } ${WRITTEN_BY_GUARDIAN}`,
      );
      // Gemini Nano's answer was not used and the cloud is not allowed: offer
      // it, for this and the next requests.
      if (onDeviceRun && !hybrid) offerFallback(result, host, { afterNano: true, nanoProblem: verdict.problem });
    }
    // On this computer with nothing sent, the chip says so: no line for it.
    meta.hidden = quiet;
    if (!onDeviceRun) showSent(prompt, true);
    const nanoTook = (o) => (o.timedOut ? 'did not answer within 90 seconds' : `answered after ${seconds(o.ms)}`);
    $('local-chip').title = nano
      ? `Gemini Nano ${nanoTook(nano.out)}; Gemini in the cloud answered after ${seconds(out.ms)} more. Network requests from this window meanwhile: ${requests}.`
      : `${out.timedOut ? 'No answer within 90 seconds' : `Answered after ${seconds(out.ms)}`}. Network requests from this window meanwhile: ${requests}.`;
    Object.assign(document.body.dataset, {
      local: 'done',
      source: out.source,
      ms: String(out.ms),
      requests: String(requests),
      checked: verdict.checked,
      reading: out.text.slice(0, 2000), // tests and logs only
    });
    if (nano) {
      document.body.dataset.retried = 'cloud';
      document.body.dataset.nanoWithheld = nano.verdict.problem || ''; // tests and logs only
    }
    if (verdict.problem) {
      document.body.dataset.withheld = verdict.problem;
      document.body.dataset.withheldDetail = verdict.detail || ''; // tests and logs only
    }
    saveLastExplanation({
      source: out.source,
      ms: out.ms,
      requests,
      checked: verdict.checked,
      retried: Boolean(nano),
      timedOut: Boolean(out.timedOut),
    });
  } catch (error) {
    stopWaiting();
    showPromise(result);
    if (run) run.catch(() => {}); // a late failure after the time-out
    note.classList.remove('pending');
    note.classList.add('muted');
    note.hidden = false;
    const message = String((error && error.message) || error);
    const turnedOff = stop.signal.aborted && /turned off/i.test(String(stop.signal.reason && stop.signal.reason.message));
    if (turnedOff) {
      note.textContent = 'Cloud AI was turned off, so Gemini was stopped. The facts below do not depend on it.';
      document.body.dataset.stopped = 'turned-off';
    } else if (nano) {
      // The cloud did not answer the second reading; Gemini Nano's was not used.
      note.textContent = `Gemini’s answer was not used this time. ${cloudProblem(error)} The facts below do not depend on it.`;
      document.body.dataset.retried = 'cloud';
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
    stopWaiting();
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
      const verdict = checkAnalysis(out.text, result);
      document.body.dataset.cloudReading = out.text.slice(0, 3000); // tests and logs only
      $('cloud-checks').replaceChildren();
      if (verdict.passed) {
        $('cloud-pattern').textContent = verdict.label;
        $('cloud-pattern').hidden = false;
        // A known pattern is a shape, not proof: code says so under it.
        const known = !['no_known_pattern', 'cannot_determine'].includes(verdict.pattern);
        $('cloud-pattern-note').textContent = known ? PATTERN_NOTE : '';
        $('cloud-pattern-note').hidden = !known;
        $('cloud-checks').append(
          ...verdict.checks.map((item) => {
            const li = document.createElement('li');
            li.textContent = item.text;
            li.dataset.by = item.by;
            return li;
          }),
        );
        $('cloud-checks-label').hidden = false;
        $('cloud-confirm').hidden = true;
        $('cloud-confirm').textContent = '';
        showCheck(
          $('cloud-check-box'),
          $('cloud-summary'),
          `Gemini in the cloud read the decoded facts and answered a form. Its reading matched Guardian’s decoder (${verdict.words}); the scam pattern and each thing to check are ones this request has. Checks marked ⚠ are always shown by Guardian. ${WRITTEN_BY_GUARDIAN}`,
        );
        document.body.dataset.cloudChecked = 'passed';
        document.body.dataset.patternKind = verdict.pattern;
      } else {
        $('cloud-pattern').textContent = '';
        $('cloud-pattern').hidden = true;
        $('cloud-pattern-note').hidden = true;
        $('cloud-checks-label').hidden = true;
        $('cloud-confirm').textContent = 'Gemini’s analysis was not used this time. The facts above are Guardian’s own.';
        $('cloud-confirm').hidden = false;
        showCheck(
          $('cloud-check-box'),
          $('cloud-summary'),
          verdict.problem === 'no usable answer'
            ? `Gemini gave no usable analysis, so none of it was used. ${WRITTEN_BY_GUARDIAN}`
            : `Gemini’s analysis did not fit the decoded request (${differed(verdict.problem)}), so none of it was used. ${WRITTEN_BY_GUARDIAN}`,
        );
        document.body.dataset.cloudChecked = 'withheld';
        document.body.dataset.cloudWithheld = verdict.problem;
        document.body.dataset.cloudWithheldDetail = verdict.detail; // tests and logs only
        document.body.dataset.patternKind = 'withheld';
      }
      $('cloud-result').hidden = false;
      setChip($('cloud-chip'), out.source, out.ms);
      ask.hidden = true;
      $('cloud').focus(); // the button the user pressed is gone
      $('cloud-sent-box').querySelector('summary').textContent = 'Exactly what was sent';
      $('cloud-consent').textContent = 'Gemini through Firebase AI Logic, at your request.';
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

/**
 * The user's own address(es) in this request, kept out of anything that may
 * go to the cloud. Only the account that sends or signs the request is the
 * user's own. Accounts the page reported (eth_accounts) can be any address,
 * the recipient's among them: hidden too, never called the user's own.
 */
function ownOf(record) {
  const signers = new Set(
    ownAddresses({ ...record, enrich: undefined })
      .filter((a) => typeof a === 'string')
      .map((a) => a.toLowerCase()),
  );
  return ownAddresses(record).map((entry) => {
    const address = typeof entry === 'string' ? entry : entry && entry.address;
    return typeof address === 'string' && signers.has(address.toLowerCase()) ? address : { address, reported: true };
  });
}

/**
 * Something in this request could not be shown. Reject works as ever;
 * Continue stays off, since the user cannot see all of what it would confirm.
 */
function couldNotDisplay(error, record) {
  console.warn('[Guardian] could not display the request', error);
  canArm = false;
  disarm();
  document.body.dataset.render = 'failed';
  // Never calmer than "Check carefully", whatever was drawn before it failed.
  if (document.body.dataset.risk !== 'danger') {
    document.body.dataset.risk = 'caution';
    $('badge').textContent = BADGE.caution;
  }
  if ($('promise-verdict').dataset.state === 'none') $('promise-verdict').hidden = true;
  if (!$('origin').textContent) showSite(record && record.origin);
  if ($('headline').textContent === 'Checking the request…') $('headline').textContent = 'Guardian could not display this request';
  $('render-note').hidden = false;
  $('local').hidden = true;
  $('cloud').hidden = true;
  $('reject').classList.add('primary');
  $('allow').classList.remove('primary');
  $('allow').textContent = 'Continue anyway';
}

async function main() {
  if (isPreview) document.body.dataset.host = 'preview';
  // Reject first: whatever happens below, the user can always refuse.
  $('reject').addEventListener('click', () => decide('reject'));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') decide('reject');
  });
  wireContinue();
  disarm();

  let record;
  try {
    record = await loadReview(id);
  } catch (error) {
    couldNotDisplay(error);
    return;
  }
  if (!record) {
    $('headline').textContent = 'This request is no longer waiting';
    $('local').hidden = true;
    $('cloud').hidden = true;
    $('allow').hidden = true;
    $('reject').textContent = 'Close';
    return;
  }

  let result;
  let host;
  try {
    result = analyze(record);
    // The site as the sentences and the prompts name it: never "null" or "".
    host = siteOf(record.origin) || 'a site Guardian cannot identify';
    own = ownOf(record);
    chainId = typeof record.chainId === 'number' ? record.chainId : null;
    const whole = render(record, result);
    // The sentence on what confirming does, at once (runLocal writes the same).
    $('local-text').textContent = codeSentence(result, meaning(result, host));
    // A message cut short: the user cannot read all of what they would sign.
    if (!whole) throw new Error(`the message is longer than ${grouped(MESSAGE_SHOWN)} characters`);
  } catch (error) {
    couldNotDisplay(error, record);
    return;
  }
  canArm = true;
  arm();

  // The AI parts: if one fails, the facts, the warnings and both buttons stand.
  try {
    wireCloud(result, host);
  } catch (error) {
    $('cloud').hidden = true;
    console.warn('[Guardian] cloud analysis unavailable', error);
  }
  runLocal(result, host).catch((error) => {
    noAi('No AI for this request');
    console.warn('[Guardian] explanation unavailable', error);
  });
}

main();
