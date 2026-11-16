// Guardian's own review window (an extension page the site cannot touch; in
// the hosted demo, the same page shown in a frame).
// Facts and the risk level come from the deterministic analyzer. The AI only
// explains them: on this computer by default; in the cloud only when the user
// has allowed it (the hybrid fallback) or asks for the deeper analysis.

import { analyze } from './analyzer/index.js';
import {
  analyzeInCloud,
  cloudReady,
  deviceModelStatus,
  downloadDeviceModel,
  explainHybrid,
  explainOnDevice,
} from './ai/engine.js';
import { answerChecker, codeSentence, isUndecoded, ownAddresses, scrubAddresses, scrubResult } from './ai/guard.js';
import { deepPrompt, explainPrompt, meaning } from './ai/prompt.js';
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

// ── Short explanation: on this computer by default; with the user's
// permission, the SDK's hybrid mode falls back to the cloud when this
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
 * The explanation prompt as it may go to the cloud: no balance, no own
 * address (taken out of every value before any value is shortened, and again
 * from the finished text).
 */
const cloudExplainPrompt = (result, host) =>
  scrubAddresses(explainPrompt(scrubResult(result, own), host, { cloud: true }), own);

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
  showSent(cloudExplainPrompt(result, host), false);
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

const CHECKED = 'its addresses, amounts and token names were checked against the request';

async function runLocal(result, host) {
  const text = $('local-text');
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
  delete document.body.dataset.source;

  // Nothing decoded, nothing to explain: a model could only guess what the
  // request does. Guardian says so itself, and no AI is asked.
  if (isUndecoded(result)) {
    text.classList.remove('pending');
    text.textContent = codeSentence(result, meaning(result, host));
    meta.textContent =
      'Guardian could not decode this request, so no AI explains it: an explanation could only be a guess. Written by Guardian.';
    meta.hidden = false;
    document.body.dataset.local = 'undecoded';
    return;
  }

  if (!deviceReady && !hybrid) {
    text.classList.remove('pending');
    if (canDownload) {
      text.textContent = 'The on-device model is not downloaded yet.';
      offerDownload(result, host);
    } else {
      text.classList.add('muted');
      text.textContent = 'On-device AI is not available in this browser. The facts below do not depend on it.';
    }
    offerFallback(result, host);
    return;
  }

  $('local-fallback').hidden = true;
  text.classList.remove('muted');
  text.classList.add('pending');
  text.textContent = deviceReady
    ? 'Gemini Nano is writing on this computer. Each sentence appears once its addresses, amounts and token names have been checked against the request.'
    : 'Gemini is writing in the cloud. Each sentence appears once its addresses, amounts and token names have been checked against the request.';

  const toCloud = hybrid && !deviceReady;
  // With the permission on, the SDK decides where the answer is written, and
  // it decides again at the moment of the call: Gemini Nano that was ready a
  // moment ago may be gone. So whatever is handed to the hybrid mode is
  // already the text that may go to the cloud: no own address, no balance.
  const prompt = hybrid ? cloudExplainPrompt(result, host) : explainPrompt(result, host);
  const sentence = meaning(result, host);
  const checker = answerChecker(result, sentence, { own, chainId });
  const started = performance.now();
  let shownMs = null;
  // Once this run has ended (answered, failed or timed out), nothing more
  // from it may reach the screen.
  let over = false;
  const show = ({ shown }) => {
    if (over || !shown) return;
    if (shownMs === null) shownMs = Math.round(performance.now() - started);
    text.classList.remove('pending');
    text.textContent = shown;
  };

  // Turning the permission off stops a cloud request that has not gone out,
  // on either path of the hybrid mode; so does the time-out.
  const stop = new AbortController();
  const stopListening = hybrid ? onCloudFallbackOff(() => stop.abort(new Error('cloud turned off'))) : () => {};
  let run = null;
  try {
    // Reading stops at the first sentence that fails: the rest is not wanted.
    const onText = (partial) => {
      if (over) return false;
      const state = checker.push(partial);
      show(state);
      return state.problem === null;
    };
    const ask = () => explainHybrid(prompt, onText, { deviceReady, signal: stop.signal });
    run = hybrid ? ask() : explainOnDevice(prompt, onText);
    const out = toCloud ? await withTimeout(run, CLOUD_TIMEOUT_MS, (e) => stop.abort(e)) : await run;
    over = true;
    const verdict = checker.finish(out.text);
    text.classList.remove('pending');
    setChip($('local-chip'), out.source, out.ms, 'Cloud fallback');
    const requests = cloudRequestsBetween(started, performance.now());
    const where =
      out.source === 'on_device'
        ? `Gemini Nano, running in Chrome. Written on your computer${requests === 0 ? ': nothing was sent to an AI service' : ''}.`
        : 'No on-device model here, so Gemini answered in the cloud through Firebase, as you allowed. Your wallet address was not sent.';
    if (verdict.problem && verdict.shown) {
      // The answer stopped at a sentence that failed; what is on screen passed.
      text.textContent = verdict.shown;
      meta.textContent = `${where} Gemini's answer was cut short: its next sentence had ${verdict.problem}.`;
      document.body.dataset.checked = 'cut';
    } else if (verdict.problem) {
      // Nothing passed: what the user reads is written by code from the facts.
      text.textContent = codeSentence(result, sentence);
      meta.textContent =
        verdict.problem === 'nothing'
          ? 'Gemini gave no usable answer, so this sentence is written by Guardian from the facts.'
          : `Gemini's answer was not shown: it had ${verdict.problem}. This sentence is written by Guardian from the facts.`;
      document.body.dataset.checked = 'withheld';
    } else {
      text.textContent = verdict.shown;
      meta.textContent = `${where} Before it was shown, ${CHECKED}.`;
      document.body.dataset.checked = 'passed';
    }
    if (verdict.problem) {
      document.body.dataset.withheld = verdict.problem;
      document.body.dataset.withheldDetail = verdict.detail || ''; // tests and logs only
    }
    meta.hidden = false;
    if (out.source !== 'on_device') showSent(prompt, true);
    $('local-chip').title =
      `First words after ${seconds(out.firstMs ?? out.ms)}; checked text shown after ${seconds(shownMs ?? out.ms)}; ` +
      `finished after ${seconds(out.ms)}. Network requests from this window meanwhile: ${requests}.`;
    Object.assign(document.body.dataset, {
      local: 'done',
      source: out.source,
      firstMs: String(out.firstMs ?? ''),
      shownMs: String(shownMs ?? ''),
      ms: String(out.ms),
      requests: String(requests),
    });
    saveLastExplanation({
      source: out.source,
      firstMs: out.firstMs,
      shownMs,
      ms: out.ms,
      requests,
      checked: document.body.dataset.checked,
    });
  } catch (error) {
    over = true;
    if (run) run.catch(() => {}); // a late failure after the time-out
    text.classList.remove('pending');
    text.classList.add('muted');
    const message = String((error && error.message) || error);
    const turnedOff = stop.signal.aborted && /turned off/i.test(String(stop.signal.reason && stop.signal.reason.message));
    if (turnedOff) {
      text.textContent = 'Cloud AI was turned off, so the explanation was stopped. The facts below do not depend on it.';
      document.body.dataset.stopped = 'turned-off';
    } else if (toCloud) {
      text.textContent = `${cloudProblem(error)} The facts below do not depend on it.`;
      meta.textContent = isPreview
        ? 'Cloud AI stays allowed for this visit.'
        : 'Cloud AI can be turned off in Guardian’s toolbar panel.';
      meta.hidden = false;
    } else {
      text.textContent = 'The AI could not answer this time. The facts below do not depend on it.';
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
      const data = out.data || {};
      const summary = String(data.summary || '');
      const confirm = String(data.ifYouConfirm || '');
      // A list number the model puts in front ("1. Verify …") is not part of the advice.
      const checks = (Array.isArray(data.checks) ? data.checks : [])
        .slice(0, 4)
        .map((item) => String(item).replace(/^\s*\d{1,2}[.)]\s+/, ''));
      const name = String(data.patternName || '');
      // Every piece is checked against the facts before anything is shown.
      const truthExtra = meaning(result, host);
      const failed = [summary, confirm, name, ...checks]
        .map((piece) => answerChecker(result, truthExtra, { own, chainId }).finish(piece))
        .find((v) => v.problem && v.problem !== 'nothing');
      const problem = failed ? failed.problem : null;
      // For tests and logs only; the window never repeats it.
      if (failed) document.body.dataset.cloudWithheldDetail = failed.detail;
      const passed = !problem && summary.trim() !== '';
      if (passed) {
        $('cloud-summary').textContent = summary;
        $('cloud-confirm').textContent = confirm;
        $('cloud-checks').replaceChildren(
          ...checks.map((item) => {
            const li = document.createElement('li');
            li.textContent = item;
            return li;
          }),
        );
        document.body.dataset.cloudChecked = 'passed';
      } else {
        $('cloud-summary').textContent = codeSentence(result, truthExtra);
        $('cloud-confirm').textContent = problem
          ? `Gemini's analysis was not shown: it had ${problem}. This sentence is written by Guardian from the facts.`
          : 'Gemini gave no usable analysis, so this sentence is written by Guardian from the facts.';
        $('cloud-checks').replaceChildren();
        document.body.dataset.cloudChecked = 'withheld';
        document.body.dataset.cloudWithheld = problem || 'nothing';
      }
      // The scam-pattern label. The risk is Guardian's, decided by code: the
      // label is shown only from an answer that passed, and a "known scam"
      // label never on a request Guardian found no red flags in.
      let pattern = '';
      const kind = String(data.patternKind || 'cannot_determine');
      if (passed) {
        if (kind === 'known_scam_pattern' && result.risk !== 'info') pattern = name || 'Matches a known scam pattern';
        else if (kind === 'no_known_pattern') pattern = 'No known scam pattern matched. That alone does not make it safe';
        else if (kind === 'cannot_determine') pattern = 'Could not determine what this does';
      }
      $('cloud-pattern').textContent = pattern;
      document.body.dataset.patternKind = passed ? kind : 'withheld';
      $('cloud-result').hidden = false;
      setChip($('cloud-chip'), out.source, out.ms);
      ask.hidden = true;
      $('cloud-sent-box').querySelector('summary').textContent = 'Exactly what was sent';
      $('cloud-consent').textContent = passed
        ? `Gemini through Firebase AI Logic, at your request. Before it was shown, ${CHECKED}.`
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
