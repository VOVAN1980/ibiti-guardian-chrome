// Gemini's part of the window: a form that code checks against the decoded
// request. Nothing Gemini writes is shown as text; the sentence on what
// confirming does and the warnings are written by code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { analyze } from '../src/analyzer/index.js';
import { isUndecoded } from '../src/ai/guard.js';
import { meaning, readingPrompt, deepPrompt, shownReasons } from '../src/ai/prompt.js';
import {
  ACTIONS,
  CHECKS,
  DIRECTIONS,
  LIMITS,
  PATTERNS,
  WHO,
  checkAnalysis,
  checkExplanation,
  checkReading,
  checksFor,
  decodedReading,
  mostImportant,
  parseAnswer,
} from '../src/ai/reading.js';

const ME = '0x1111111111111111111111111111111111111111';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const FAKE = '0x00000000000000000000000000000000DeaDBeef';
const NFT = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const ATTACKER = '0x9F3a00000000000000000000000000000000c21E';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const HOST = 'shop.example';
const MAX = 'f'.repeat(64);
const pad = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const uint = (n) => BigInt(n).toString(16).padStart(64, '0');
const toHex = (text) => `0x${Buffer.from(text).toString('hex')}`;
const tx = (to, data, value, enrich) => ({
  method: 'eth_sendTransaction',
  params: [{ from: ME, to, data, ...(value ? { value } : {}) }],
  chainId: 1,
  origin: `https://${HOST}`,
  ...(enrich ? { enrich } : {}),
});
const typed = (data) => ({ method: 'eth_signTypedData_v4', params: [ME, JSON.stringify(data)], chainId: 1, origin: `https://${HOST}` });
const personal = (text) => ({ method: 'personal_sign', params: [toHex(text), ME], chainId: 1, origin: `https://${HOST}` });
const batch = (calls) => ({ method: 'wallet_sendCalls', params: [{ chainId: '0x1', from: ME, calls }], chainId: 1, origin: `https://${HOST}` });

// The demo's ten requests, and the other kinds the analyzer decodes.
const RECORDS = {
  claim: tx(USDT, `0x095ea7b3${pad(ATTACKER)}${MAX}`, null, { spenderIsContract: false }),
  fake: tx(FAKE, `0x095ea7b3${pad(ATTACKER)}${uint(1000000n)}`, null, { token: { symbol: 'USDT', decimals: 6 } }),
  limited: tx(USDC, `0x095ea7b3${pad(PERMIT2)}${uint(25_000_000n)}`),
  nft: tx(NFT, `0xa22cb465${pad(ATTACKER)}${uint(1)}`),
  transfer: tx(ATTACKER, '0x', '0x2386f26fc10000', { balance: '0x2386f26fc10000' }),
  revoke: tx(USDT, `0x095ea7b3${pad(ATTACKER)}${uint(0)}`),
  blind: { method: 'eth_sign', params: [ME, `0x${'5a'.repeat(32)}`], chainId: 1, origin: `https://${HOST}` },
  permit: typed({
    primaryType: 'Permit',
    domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC },
    message: { owner: ME, spender: ATTACKER, value: BigInt(`0x${MAX}`).toString(), nonce: 0, deadline: 4102444800 },
  }),
  signin: personal(`${HOST} wants you to sign in with your Ethereum account:\n${ME}\n\nNonce: 8f2c1d`),
  phish: personal(`nft-market.example wants you to sign in with your Ethereum account:\n${ME}\n\nNonce: 77aa01`),
  increase: tx(USDC, `0x39509351${pad(ATTACKER)}${uint(5_000_000n)}`),
  tokenPayment: tx(USDT, `0xa9059cbb${pad(ATTACKER)}${uint(5_000_000n)}`),
  revokeAll: tx(NFT, `0xa22cb465${pad(ATTACKER)}${uint(0)}`),
  coinsOnRevoke: tx(USDT, `0x095ea7b3${pad(ATTACKER)}${uint(0)}`, '0xde0b6b3a7640000'),
  toSelf: tx(ME, '0x', '0x2386f26fc10000'),
  empty: tx(OTHER, '0x', '0x0'),
  fromOther: tx(USDT, `0x23b872dd${pad(OTHER)}${pad(ATTACKER)}${uint(1_000_000n)}`),
  fromOtherToMe: tx(USDT, `0x23b872dd${pad(OTHER)}${pad(ME)}${uint(1_000_000n)}`),
  // Ends in 30 days.
  permit2Approve: tx(PERMIT2, `0x87517c45${pad(USDC)}${pad(ATTACKER)}${uint(10_000_000n)}${uint(Math.floor(Date.now() / 1000) + 30 * 86400)}`),
  permitSingle: typed({
    primaryType: 'PermitSingle',
    domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
    message: { details: { token: USDC, amount: '800000000', expiration: 4102444800, nonce: 0 }, spender: ATTACKER, sigDeadline: 4102444800 },
  }),
  permitTransfer: typed({
    primaryType: 'PermitTransferFrom',
    domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
    message: { permitted: { token: USDC, amount: '800000000' }, spender: ATTACKER, nonce: 1, deadline: 4102444800 },
  }),
  permitBatch: typed({
    primaryType: 'PermitBatch',
    domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
    message: {
      details: [
        { token: USDC, amount: '800000000', expiration: 4102444800, nonce: 0 },
        { token: USDT, amount: ((1n << 160n) - 1n).toString(), expiration: 4102444800, nonce: 0 },
      ],
      spender: ATTACKER,
      sigDeadline: 4102444800,
    },
  }),
  order: typed({ primaryType: 'OrderComponents', domain: { name: 'Seaport' }, message: { offer: [{}] } }),
  text: personal('Hello, please sign to confirm your email.'),
  batchOk: batch([
    { to: USDT, data: `0x095ea7b3${pad(ATTACKER)}${MAX}` },
    { to: USDC, data: `0xa9059cbb${pad(ATTACKER)}${uint(2_000_000n)}` },
  ]),
  batchRevokes: batch([{ to: USDT, data: `0x095ea7b3${pad(ATTACKER)}${uint(0)}` }]),
  batchUnknown: batch([{ to: USDT, data: `0x095ea7b3${pad(ATTACKER)}${MAX}` }, { to: OTHER, data: '0xdeadbeef' }]),
  unknownCall: tx(OTHER, '0xdeadbeef'),
  unreadable: { method: 'personal_sign', params: ['0xff00fe', ME], chainId: 1, origin: `https://${HOST}` },
};
const R = Object.fromEntries(Object.entries(RECORDS).map(([k, v]) => [k, analyze(v)]));

/** The first right value of each field: the answer of a model that read it right. */
const rightAnswer = (result, extra = {}) => {
  const d = decodedReading(result);
  return { action: d.action[0], who_gains: d.who_gains[0], direction: d.direction[0], limit: d.limit[0], reasons: [1], ...extra };
};

/** A right deep answer: the reading, a pattern that fits, a check that fits. */
const rightDeep = (result, extra = {}) => {
  const known = Object.keys(PATTERNS).find((p) => !['no_known_pattern', 'cannot_determine'].includes(p) && PATTERNS[p].fits(result));
  const pattern = result.risk === 'info' || !known ? 'no_known_pattern' : known;
  const { reasons, ...reading } = rightAnswer(result);
  return { ...reading, pattern, checks: ['did_you_start_this'], ...extra };
};

test('every decoded request has a reading; undecoded ones have none, so no AI is asked', () => {
  for (const [name, result] of Object.entries(R)) {
    assert.equal(decodedReading(result) === null, isUndecoded(result), name);
  }
  for (const name of ['blind', 'batchUnknown', 'unknownCall', 'unreadable']) assert.equal(decodedReading(R[name]), null, name);
});

test('the blind sets’ requests all have a reading', () => {
  const dir = new URL('./fixtures/', import.meta.url);
  const files = readdirSync(dir).filter((f) => /^forms-records-.*\.json$/.test(f));
  assert.ok(files.length >= 2);
  for (const file of files) {
    for (const [name, record] of Object.entries(JSON.parse(readFileSync(new URL(file, dir), 'utf8')))) {
      const result = analyze(record);
      assert.equal(decodedReading(result) === null, isUndecoded(result), `${file} ${name}`);
    }
  }
});

test('a right reading matches', () => {
  for (const [name, result] of Object.entries(R)) {
    if (!decodedReading(result)) continue;
    const out = checkReading(rightAnswer(result), result);
    assert.equal(out.match, true, `${name}: ${JSON.stringify(out.mismatches)}`);
  }
});

test('every wrong value in every field is caught, in every request: a role or direction swap cannot pass', () => {
  const values = { action: ACTIONS, who_gains: WHO, direction: DIRECTIONS, limit: LIMITS };
  let tried = 0;
  for (const [name, result] of Object.entries(R)) {
    const decoded = decodedReading(result);
    if (!decoded) continue;
    for (const [field, all] of Object.entries(values)) {
      for (const value of all) {
        if (decoded[field].includes(value)) continue;
        const out = checkReading(rightAnswer(result, { [field]: value }), result);
        assert.equal(out.match, false, `${name}: ${field}=${value} passed`);
        tried += 1;
      }
      // Missing, empty or not a string: never a match.
      for (const value of [undefined, '', null, 3, ['out_of_your_wallet']]) {
        assert.equal(checkReading(rightAnswer(result, { [field]: value }), result).match, false, `${name}: ${field}=${value}`);
      }
    }
  }
  assert.ok(tried > 200, `${tried} wrong readings tried`);
});

test('who gains and where assets go, request by request', () => {
  const said = (name, who, direction) => checkReading(rightAnswer(R[name], { who_gains: who, direction }), R[name]).match;
  // Approvals and payments: the other party gains, out of the wallet.
  for (const name of ['claim', 'fake', 'limited', 'nft', 'transfer', 'permit', 'increase', 'tokenPayment', 'permitTransfer', 'permitBatch', 'batchOk']) {
    assert.equal(said(name, 'another_party', 'out_of_your_wallet'), true, name);
    assert.equal(said(name, 'you', 'out_of_your_wallet'), false, name);
    assert.equal(said(name, 'another_party', 'into_your_wallet'), false, name);
    assert.equal(said(name, 'nobody', 'nothing_moves'), false, name);
  }
  // Nothing moves: sign-ins, text, revokes.
  for (const name of ['signin', 'phish', 'text', 'revoke', 'revokeAll', 'batchRevokes']) {
    assert.equal(said(name, 'nobody', 'nothing_moves'), true, name);
    assert.equal(said(name, 'another_party', 'out_of_your_wallet'), false, name);
    assert.equal(said(name, 'you', 'into_your_wallet'), false, name);
  }
  // A sign-in for a different site: the other site could sign in as you.
  assert.equal(said('phish', 'another_party', 'nothing_moves'), true);
  assert.equal(said('signin', 'another_party', 'nothing_moves'), false);
  // A "revoke" that sends coins: they leave the wallet.
  assert.equal(said('coinsOnRevoke', 'nobody', 'nothing_moves'), false);
  assert.equal(said('coinsOnRevoke', 'another_party', 'out_of_your_wallet'), true);
  // Someone else's tokens: they do not leave this wallet; to this wallet, they come in.
  assert.equal(said('fromOther', 'another_party', 'out_of_your_wallet'), false);
  assert.equal(said('fromOther', 'nobody', 'nothing_moves'), true);
  assert.equal(said('fromOther', 'another_party', 'nothing_moves'), true);
  assert.equal(said('fromOtherToMe', 'you', 'into_your_wallet'), true);
  assert.equal(said('fromOtherToMe', 'another_party', 'out_of_your_wallet'), false);
});

test('the limit: unlimited only where the request is unlimited, and never hidden where it is', () => {
  const limit = (name, value) => checkReading(rightAnswer(R[name], { limit: value }), R[name]).match;
  for (const name of ['claim', 'permit', 'nft', 'permitBatch', 'batchOk']) {
    assert.equal(limit(name, 'unlimited'), true, name);
    assert.equal(limit(name, 'limited'), false, name);
    assert.equal(limit(name, 'does_not_apply'), false, name);
  }
  for (const name of ['limited', 'increase', 'fake', 'permitSingle', 'permitTransfer', 'transfer', 'tokenPayment', 'signin', 'revoke']) {
    assert.equal(limit(name, 'unlimited'), false, name);
  }
  // A payment is limited.
  assert.equal(limit('transfer', 'does_not_apply'), false);
});

test('the reasons Gemini picks: only numbers it was shown, at most two', () => {
  const r = R.claim;
  assert.deepEqual(checkReading(rightAnswer(r, { reasons: [2, 1] }), r).top, [2, 1]);
  assert.deepEqual(checkReading(rightAnswer(r, { reasons: [2, 2, 9, 0, -1, 1.5, '3', 4, 3] }), r).top, [2, 4]);
  // A payment of the whole balance: its first reason is about the balance and
  // is not in the cloud prompt, so the cloud model cannot pick it.
  const pay = R.transfer;
  const shown = shownReasons(pay, { cloud: true }).map(([n]) => n);
  assert.deepEqual(shown, [2]);
  assert.deepEqual(checkReading(rightAnswer(pay, { reasons: [1, 2] }), pay, { shown }).top, [2]);
  assert.deepEqual(checkReading(rightAnswer(pay, { reasons: 'all' }), pay).top, []);
});

test('warnings come from code and stay first: Gemini adds emphasis, it cannot drop one', () => {
  // Every high-risk request has at least one warning, and every warning is one of its reasons.
  for (const [name, result] of Object.entries(R)) {
    const warnings = result.warnings || [];
    if (result.risk === 'danger') assert.ok(warnings.length > 0, `${name}: high risk without a warning`);
    for (const w of warnings) assert.ok(result.reasons.includes(w), `${name}: ${w}`);
  }
  const r = R.claim; // any amount to a personal wallet
  const warned = mostImportant(r, []);
  assert.deepEqual(warned.map((i) => i.by), ['guardian', 'guardian']);
  assert.match(warned.map((i) => i.text).join(' '), /any amount of USDT/);
  assert.match(warned.map((i) => i.text).join(' '), /personal wallet/);
  // Gemini picks only the last reason: the warnings are still there, first.
  const picked = mostImportant(r, [4]);
  assert.deepEqual(picked.map((i) => [i.n, i.by]), [[1, 'guardian'], [2, 'guardian'], [4, 'gemini']]);
  // Gemini picks a warning: it is not listed twice.
  assert.deepEqual(mostImportant(r, [2, 3]).map((i) => i.n), [1, 2, 3]);
  // A request with no red flags: only Gemini's picks.
  assert.deepEqual(mostImportant(R.limited, [1]).map((i) => i.by), ['gemini']);
  assert.deepEqual(mostImportant(R.limited, []), []);
  // The other warnings.
  for (const [name, words] of [
    ['phish', /signs you in to nft-market\.example/],
    ['fake', /not the real USDT/],
    ['coinsOnRevoke', /also sends 1 ETH/],
    ['transfer', /all of the ETH in this wallet/],
    ['nft', /every item you own/],
  ]) {
    assert.match((R[name].warnings || []).join(' '), words, name);
  }
});

test('the deeper analysis names a scam pattern only where the request has its shape', () => {
  const deep = (name, pattern) => checkReading(rightDeep(R[name], { pattern }), R[name], { deep: true }).match;
  assert.equal(deep('claim', 'approval_phishing'), true);
  assert.equal(deep('claim', 'permit_phishing'), false);
  assert.equal(deep('claim', 'sign_in_phishing'), false);
  assert.equal(deep('claim', 'fake_token'), false);
  assert.equal(deep('fake', 'fake_token'), true);
  assert.equal(deep('permit', 'permit_phishing'), true);
  assert.equal(deep('permit', 'approval_phishing'), true, 'a permit is an approval by signature');
  assert.equal(deep('permitTransfer', 'permit_phishing'), true);
  assert.equal(deep('nft', 'collection_approval_phishing'), true);
  assert.equal(deep('phish', 'sign_in_phishing'), true);
  assert.equal(deep('signin', 'sign_in_phishing'), false, 'a sign-in for this same site');
  assert.equal(deep('batchOk', 'risky_action_in_a_batch'), true);
  assert.equal(deep('order', 'marketplace_order_phishing'), true);
  // Never a known scam on a request with no red flags.
  assert.equal(R.limited.risk, 'info');
  assert.equal(deep('limited', 'approval_phishing'), false);
  assert.equal(deep('limited', 'no_known_pattern'), true);
  // On a high-risk request with a pattern that fits, "none matched" or "cannot tell" is not accepted.
  for (const name of ['claim', 'permit', 'nft', 'fake', 'phish', 'batchOk', 'permitBatch']) {
    assert.equal(R[name].risk, 'danger', name);
    assert.equal(deep(name, 'no_known_pattern'), false, name);
    assert.equal(deep(name, 'cannot_determine'), false, name);
  }
  for (const name of Object.keys(R)) {
    if (!decodedReading(R[name])) continue;
    if (R[name].risk !== 'danger') assert.equal(deep(name, 'cannot_determine'), true, name);
    assert.equal(deep(name, 'something_else'), false, name);
    assert.equal(deep(name, undefined), false, name);
  }
  assert.ok(Object.values(PATTERNS).every((p) => typeof p.label === 'string' && p.label.length > 20));
});

test('things to check: only ones that fit the request, and code’s own always come first', () => {
  const ok = (name, checks) => checkReading(rightDeep(R[name], { checks }), R[name], { deep: true }).match;
  assert.equal(ok('claim', ['who_is_the_spender', 'revoke_when_done']), true);
  assert.equal(ok('claim', ['check_the_recipient']), false, 'no recipient in an approval');
  assert.equal(ok('claim', ['compare_the_sites']), false, 'not a sign-in');
  assert.equal(ok('transfer', ['check_the_recipient', 'payments_are_final']), true);
  assert.equal(ok('transfer', ['who_is_the_spender']), false);
  assert.equal(ok('phish', ['compare_the_sites']), true);
  assert.equal(ok('revoke', ['which_permission']), true);
  assert.equal(ok('revoke', ['revoke_when_done']), false, 'nothing to revoke later');
  assert.equal(ok('permitTransfer', ['revoke_when_done']), false, 'a one-time signature leaves nothing to revoke');
  assert.equal(ok('permitTransfer', ['how_long_it_is_valid']), true);
  assert.equal(ok('coinsOnRevoke', ['why_coins_attached']), true);
  assert.equal(ok('limited', ['is_the_token_real']), false, 'a verified token');
  assert.equal(ok('fake', ['is_the_token_real']), true);
  assert.equal(ok('claim', []), false, 'at least one');
  assert.equal(ok('claim', ['made_up']), false);
  for (const [id, c] of Object.entries(CHECKS)) {
    assert.ok(c.text.length > 20 && typeof c.fits === 'function', id);
    for (const [name, result] of Object.entries(R)) {
      if (c.must && c.must(result)) assert.ok(c.fits(result), `${id} is a must for ${name} but does not fit it`);
    }
  }
  // Code's checks for a request, whatever the model picks.
  assert.deepEqual(checksFor(R.phish, []), ['compare_the_sites']);
  assert.deepEqual(checksFor(R.fake, ['revoke_when_done']), ['is_the_token_real', 'revoke_when_done']);
  assert.deepEqual(checksFor(R.coinsOnRevoke, []), ['why_coins_attached']);
  assert.deepEqual(checksFor(R.transfer, ['check_the_recipient']), ['check_the_recipient']);
});

test('answers: a JSON object, nothing else', () => {
  assert.deepEqual(parseAnswer('{"action":"payment"}'), { action: 'payment' });
  assert.deepEqual(parseAnswer('```json\n{"action":"payment"}\n```'), { action: 'payment' });
  for (const text of ['', 'The spender could take it.', '[1,2]', 'null', '"x"', '{"action":', undefined]) {
    assert.equal(parseAnswer(text), null, String(text));
  }
});

test('the sentence on what confirming does is exact', () => {
  const m = (name) => meaning(R[name], HOST);
  assert.match(m('claim'), /someone else, an unknown address \(a personal wallet\), gets permission to take any amount of USDT out of your wallet, at any time, without asking you again, until you revoke it\.$/);
  assert.match(m('increase'), /up to 5 USDC more out of your wallet/);
  assert.match(m('permit2Approve'), /up to 10 USDC out of your wallet, at any time, without asking you again, until \d{4}-\d\d-\d\d \d\d:\d\d UTC, unless you revoke it sooner\.$/);
  assert.match(m('permitSingle'), /for more than a year, unless you revoke it sooner\.$/);
  assert.match(m('permitTransfer'), /can take up to 800 USDC out of your wallet, once, at any time until this signature expires\.$/);
  assert.match(m('permitBatch'), /the amounts listed below, of 2 tokens, out of your wallet, for more than a year, unless you revoke them sooner\.$/);
  assert.match(m('coinsOnRevoke'), /permission is removed, and 1 ETH is sent to the contract 0xdac17f958d2ee523a2206206994597c13d831ec7\.$/);
  assert.doesNotMatch(m('coinsOnRevoke'), /Nothing leaves/);
  assert.match(m('revoke'), /Nothing leaves your wallet\.$/);
  assert.match(m('fromOther'), /moves from 0x3333333333333333333333333333333333333333, which is not this wallet,/);
  assert.match(m('toSelf'), /an address of this same wallet\.$/);
  assert.match(m('empty'), /no coins move, only the network fee is paid\.$/);
  assert.match(m('phish'), /sign-in message for "nft-market\.example", but the request comes from shop\.example, a different site\.$/);
  assert.match(m('batchOk'), /all 2 actions listed below/);
  assert.match(m('transfer'), /^If you confirm, 0\.01 ETH leaves your wallet and goes to 0x9f3a/i);
});

test('prompts give the decoded facts, not the code’s sentence: Gemini’s reading is its own', () => {
  for (const [name, result] of Object.entries(R)) {
    if (!decodedReading(result)) continue;
    for (const prompt of [readingPrompt(result, HOST), readingPrompt(result, HOST, { cloud: true }), deepPrompt(result, HOST)]) {
      assert.ok(!prompt.includes(meaning(result, HOST).slice(0, 60)), `${name}: the code's sentence is not in the prompt`);
      assert.ok(prompt.includes(result.headline.slice(0, 40)), `${name}: the facts are`);
    }
  }
  // The deeper analysis lists exactly the patterns and the checks code knows.
  for (const key of [...Object.keys(PATTERNS), ...Object.keys(CHECKS)]) assert.ok(deepPrompt(R.claim, HOST).includes(key), key);
});

test('the whole check, as the window runs it', () => {
  const r = R.claim;
  const right = rightAnswer(r, { reasons: [3, 1] });
  const run = (answer) => checkExplanation(typeof answer === 'string' ? answer : JSON.stringify(answer), r);

  assert.deepEqual(run(right), {
    checked: 'passed',
    words: 'a spending permission · someone else gains · out of your wallet · unlimited',
    top: [3, 1],
    problem: null,
    detail: '',
  });
  const swapped = run({ ...right, who_gains: 'you' });
  assert.equal(swapped.checked, 'withheld');
  assert.equal(swapped.words, '');
  assert.deepEqual(swapped.top, []);
  assert.match(swapped.problem, /a different reading of the request \(who gains\)/);
  assert.doesNotMatch(swapped.problem, /\byou\b/, 'the window does not repeat the wrong value');
  assert.equal(run('not json').checked, 'withheld');
  // Whatever else the model adds is never used.
  const extra = run({ ...right, note: 'This is safe.', summary: 'All fine.' });
  assert.equal(extra.checked, 'passed');
  assert.ok(!JSON.stringify(extra).includes('safe'));

  const deep = rightDeep(r, { pattern: 'approval_phishing', checks: ['revoke_when_done', 'did_you_start_this'] });
  const ok = checkAnalysis(JSON.stringify(deep), r);
  assert.equal(ok.passed, true);
  assert.equal(ok.label, PATTERNS.approval_phishing.label);
  assert.deepEqual(
    ok.checks.map((c) => c.by),
    ['guardian', 'gemini', 'gemini'],
    'the spender check is code’s own here (a personal wallet), then Gemini’s two',
  );
  assert.equal(checkAnalysis(JSON.stringify({ ...deep, pattern: 'sign_in_phishing' }), r).passed, false);
  assert.equal(checkAnalysis(JSON.stringify({ ...deep, direction: 'into_your_wallet' }), r).passed, false);
  assert.equal(checkAnalysis(JSON.stringify({ ...deep, checks: ['check_the_recipient'] }), r).passed, false);
  assert.equal(checkAnalysis(JSON.stringify({ ...deep, pattern: 'no_known_pattern' }), r).passed, false);
});

test('real Gemini answers to the forms, recorded live, get the verdict they deserve', async () => {
  const { DEMO_RECORDS } = await import('./demo-records.js');
  const real = JSON.parse(readFileSync(new URL('./fixtures/real-forms.json', import.meta.url), 'utf8'));
  const wrong = [];
  let count = 0;
  for (const [name, answers] of Object.entries(real)) {
    const result = analyze(DEMO_RECORDS[name]);
    for (const a of answers) {
      count += 1;
      const shown = a.form === 'deep'
        ? checkAnalysis(a.text, result).passed
        : checkExplanation(a.text, result, { shown: shownReasons(result, { cloud: a.cloud !== false }).map(([n]) => n) }).checked === 'passed';
      const got = shown ? 'show' : 'hide';
      if (got !== a.expected) wrong.push(`${name}/${a.form}: expected ${a.expected}, got ${got}: ${a.text.replace(/\s+/g, ' ')}`);
    }
  }
  assert.ok(count >= 20, `${count} answers`);
  assert.deepEqual(wrong, []);
});

// Blind form sets: answers written by an independent author who saw only the
// decoded requests and the model's instructions. Each was measured once as
// written (the result is named in the file); what it revealed was fixed, and
// the set stays here. Since 2026-11-17 Gemini writes no text that is shown,
// so only the form is replayed: a wrong field (or a scam pattern the request
// does not have) must keep everything from the model off the screen, and a
// right one must not.
test('blind form sets: a wrong reading is never used, a right one is', () => {
  const dir = new URL('./fixtures/', import.meta.url);
  const files = readdirSync(dir).filter((f) => /^forms-set-.*\.json$/.test(f));
  assert.ok(files.length >= 2);
  let count = 0;
  for (const file of files) {
    const { entries, disagree } = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    const records = JSON.parse(readFileSync(new URL(file.replace('forms-set-', 'forms-records-'), dir), 'utf8'));
    const wrong = [];
    for (const e of entries) {
      const result = analyze(records[e.scenario]);
      const fieldError = /^field_/.test(e.error || '');
      // The free-text parts of the old form are not used any more.
      const answer = { ...e.answer, checks: ['did_you_start_this'] };
      const used = checkReading(answer, result, { deep: e.form === 'deep' }).match;
      count += 1;
      if (used === fieldError && !(disagree || {})[`${e.scenario}/${e.form}/${e.error || 'correct'}`]) {
        wrong.push(`${file} ${e.scenario}/${e.form}/${e.error || 'correct'}: ${used ? 'used' : 'not used'}: ${JSON.stringify(e.answer)}`);
      }
    }
    assert.deepEqual(wrong, []);
  }
  assert.ok(count > 300, `${count} answers`);
});
