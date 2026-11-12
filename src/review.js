// Guardian's own review window (an extension page the site cannot touch).
// Shows the facts from the deterministic analyzer and sends the decision.

import { analyze } from './analyzer/index.js';

const BADGE = { danger: 'High risk', caution: 'Check carefully', info: 'Low risk' };
const $ = (id) => document.getElementById(id);

const id = new URLSearchParams(location.search).get('id');
let decided = false;

async function decide(decision) {
  if (decided) return;
  decided = true;
  $('reject').disabled = true;
  $('allow').disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'guardian:decide', id, decision });
  } finally {
    window.close();
  }
}

function render(record, result) {
  document.body.dataset.risk = result.risk;
  $('badge').textContent = BADGE[result.risk];

  let host = record.origin;
  try {
    host = new URL(record.origin).host;
  } catch {
    // keep the raw origin
  }
  $('origin').textContent = host;
  $('headline').textContent = result.headline;

  const facts = $('facts');
  facts.replaceChildren(
    ...result.facts.map((f) => {
      const row = document.createElement('div');
      row.className = 'fact';
      const dt = document.createElement('dt');
      dt.textContent = f.label;
      const dd = document.createElement('dd');
      dd.textContent = f.value;
      if (f.mono) dd.classList.add('mono');
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
  (safeIsReject ? $('reject') : $('allow')).focus();
}

async function main() {
  const key = `review:${id}`;
  const stored = await chrome.storage.session.get(key);
  const record = stored[key];
  if (!record) {
    $('headline').textContent = 'This request is no longer waiting';
    $('allow').hidden = true;
    $('reject').textContent = 'Close';
    $('reject').addEventListener('click', () => window.close());
    return;
  }

  const result = analyze(record);
  render(record, result);

  $('reject').addEventListener('click', () => decide('reject'));
  $('allow').addEventListener('click', () => decide('allow'));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') decide('reject');
  });
}

main();
