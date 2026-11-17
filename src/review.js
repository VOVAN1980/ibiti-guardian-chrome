// Guardian's own review window (an extension page the site cannot touch; in
// the hosted demo, the same page shown in a frame).
// Facts, the risk level, the warnings and the sentence on what confirming
// does come from the deterministic analyzer. Gemini reads the same facts and
// fills in a form that code checks against them; only then are its picks
// used. Nothing a model writes is shown as text. On this computer by
// default; in the cloud only when the user has allowed it (the hybrid
// fallback) or asks for the deeper analysis.

import { analyze } from './analyzer/index.js';
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

  // The warnings at the top, the other reasons under "Why this matters".
  showImportant(result, [], '');

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

// ── Short explanation: what confirming does and the warnings, written by
// code; Gemini's own reading of the request, checked against the decoder,
// adds the reasons it finds most important. On this computer by default;
// with the user's permission, the SDK's hybrid mode falls back to the cloud
// when this computer has no on-device model, and the cloud reads the request
// once more when Gemini Nano's answer does not pass the check ──

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
function offerFallback(result, host, { afterNano = false } = {}) {
  if (!cloudReady) return;
  if (isPreview) {
    $('local-fallback-note').textContent =
      'For the rest of this visit, Gemini in the cloud then reads the request through Firebase whenever this browser ' +
      'has no on-device model, and once more whenever Gemini Nano’s answer does not pass Guardian’s check. ' +
      'Sends the decoded details below, and the words of the button you pressed with the page’s title and nearest ' +
      'heading: the site’s words, which can hold personal details. Never your wallet address.';
  }
  showSent(cloudPrompt(result, host), false);
  $('local-fallback').hidden = false;
  const allow = $('local-fallback-allow');
  allow.disabled = false;
  allow.onclick = async () => {
    allow.disabled = true;
    await allowCloudFallback();
    $('local-fallback').hidden = true;
    $('local-download').hidden = true;
    // Gemini Nano has already answered this one: only the cloud is asked now.
    await runLocal(result, host, { cloudOnly: afterNano });
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
  const tick = () => {
    const s = Math.floor((performance.now() - since) / 1000);
    note.textContent = `${what}: ${s} s so far. You can decide without it.`;
  };
  tick();
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}

/** What went wrong with a model's answer, after its name: "gave no usable answer", … */
const failure = (problem) =>
  problem === 'no usable answer'
    ? 'gave no usable answer'
    : problem === 'no answer within 90 seconds'
      ? 'did not answer within 90 seconds'
      : `read the request differently from Guardian’s decoder (${differed(problem)})`;

/**
 * The reasons listed as most important: Guardian's warnings, always, then
 * the ones Gemini picked (the analyzer's own words, in Gemini's order).
 */
function showImportant(result, top, where, offerWarning = null) {
  const items = mostImportant(result, top);
  // Gemini's reading of an unclear button: after Guardian's warnings, in
  // code's words that say it is Gemini's reading.
  if (offerWarning) items.splice(items.filter((i) => i.by === 'guardian').length, 0, { n: 0, text: offerWarning, by: 'gemini' });
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
  // The other reasons, once each: under "Why this matters".
  const listed = new Set(items.map((i) => i.n).filter((n) => n > 0));
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
    ? `${warned ? 'Warnings marked ⚠ are always shown by Guardian; the others were' : 'These were'} chosen by ${where}, and written by Guardian.`
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
async function runLocal(result, host, { cloudOnly = false } = {}) {
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
    meta.textContent =
      'Guardian could not decode this request, so no AI reads it: an answer could only be a guess. Written by Guardian.';
    meta.hidden = false;
    document.body.dataset.local = 'undecoded';
    return;
  }

  if (!deviceReady && !hybrid) {
    meta.textContent = canDownload
      ? 'Written by Guardian. Gemini Nano can help pick the main reasons once its model is downloaded.'
      : 'Written by Guardian. On-device AI is not available in this browser; the facts below do not depend on it.';
    meta.hidden = false;
    if (canDownload) offerDownload(result, host);
    offerFallback(result, host);
    return;
  }

  $('local-fallback').hidden = true;
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
        verdict = { checked: 'withheld', words: '', top: [], offer: null, problem: 'no answer within 90 seconds', detail: '' };
      }
    }
    // Gemini Nano's reading did not match the decoder. With the user's
    // permission, Gemini in the cloud reads the request once more.
    if (verdict.checked !== 'passed' && out.source === 'on_device' && hybrid) {
      nano = { out, verdict };
      stopWaiting();
      stopWaiting = waiting(note, 'Gemini Nano’s answer did not pass Guardian’s check. Gemini in the cloud is reading it once more, as you allowed');
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
      ? `Gemini Nano on your computer ${failure(nano.verdict.problem)}, so Gemini in the cloud read it once more, as you allowed. `
      : '';
    if (onDeviceRun) {
      meta.textContent = `Gemini Nano ran in Chrome on your computer${requests === 0 ? ': nothing was sent to an AI service' : ''}.`;
    } else if (nano || cloudOnly) {
      meta.textContent =
        'Gemini Nano’s answer did not pass Guardian’s check, so Gemini in the cloud read the request through Firebase, as you allowed. Your wallet address was not sent.';
    } else {
      meta.textContent =
        'No on-device model here, so Gemini answered in the cloud through Firebase, as you allowed. Your wallet address was not sent.';
    }
    if (verdict.checked === 'passed') {
      note.hidden = true;
      note.textContent = '';
      const offerWarning = geminiOffer(result, verdict.offer);
      showImportant(result, verdict.top, model, offerWarning);
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
      showCheck(
        $('local-check-box'),
        $('local-check'),
        `${nanoFirst}${
          `${model} ${failure(verdict.problem)}, so none of its answer was used.`
        } ${WRITTEN_BY_GUARDIAN}`,
      );
      // Gemini Nano's answer was not used and the cloud is not allowed: offer
      // it, for this and the next requests.
      if (onDeviceRun && !hybrid) offerFallback(result, host, { afterNano: true });
    }
    meta.hidden = false;
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
