// Gemini's part of the window: a form that code checks against the decoded
// request. Nothing Gemini writes is shown as text; the sentence on what
// confirming does and the warnings are written by code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { analyze } from '../src/analyzer/index.js';
import { typedData } from './demo-records.js';
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
  geminiOffer,
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
// A permit as a dapp sends it, with its standard types.
const permit = (primaryType, domain, message) => typed(typedData(primaryType, domain, message));
const personal = (text) => ({ method: 'personal_sign', params: [toHex(text), ME], chainId: 1, origin: `https://${HOST}` });
const batch = (calls) => ({ method: 'wallet_sendCalls', params: [{ chainId: '0x1', from: ME, calls }], chainId: 1, origin: `https://${HOST}` });
// Tokens the registry does not list, an EIP-3009 transfer and a meta-transaction (re-attack of 2026-11-24).
const UNI = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';
const LINK = '0x514910771af9ca656af840dff83e8264ecf986ca';
const fieldsOf = (spec) => spec.split(',').map((f) => ({ type: f.split(' ')[0], name: f.split(' ')[1] }));
const AUTH_TYPES = { TransferWithAuthorization: fieldsOf('address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce') };
const META_TYPES = { MetaTransaction: fieldsOf('uint256 nonce,address from,bytes functionSignature') };
const USDC_DOMAIN = { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC };
const AUTH = { from: ME, to: ATTACKER, value: '50000000000', validAfter: 0, validBefore: 1900000000, nonce: `0x${'11'.repeat(32)}` };

// The demo's ten requests, and the other kinds the analyzer decodes.
const RECORDS = {
  claim: tx(USDT, `0x095ea7b3${pad(ATTACKER)}${MAX}`, null, { spenderIsContract: false }),
  fake: tx(FAKE, `0x095ea7b3${pad(ATTACKER)}${uint(1000000n)}`, null, { token: { symbol: 'USDT', decimals: 6 } }),
  limited: tx(USDC, `0x095ea7b3${pad(PERMIT2)}${uint(25_000_000n)}`),
  nft: tx(NFT, `0xa22cb465${pad(ATTACKER)}${uint(1)}`),
  transfer: tx(ATTACKER, '0x', '0x2386f26fc10000', { balance: '0x2386f26fc10000' }),
  revoke: tx(USDT, `0x095ea7b3${pad(ATTACKER)}${uint(0)}`),
  blind: { method: 'eth_sign', params: [ME, `0x${'5a'.repeat(32)}`], chainId: 1, origin: `https://${HOST}` },
  permit: permit(
    'Permit',
    { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC },
    { owner: ME, spender: ATTACKER, value: BigInt(`0x${MAX}`).toString(), nonce: 0, deadline: 4102444800 },
  ),
  signin: personal(`${HOST} wants you to sign in with your Ethereum account:\n${ME}\n\nNonce: 8f2c1d`),
  phish: personal(`nft-market.example wants you to sign in with your Ethereum account:\n${ME}\n\nNonce: 77aa01`),
  increase: tx(USDC, `0x39509351${pad(ATTACKER)}${uint(5_000_000n)}`),
  tokenPayment: tx(USDT, `0xa9059cbb${pad(ATTACKER)}${uint(5_000_000n)}`),
  revokeAll: tx(NFT, `0xa22cb465${pad(ATTACKER)}${uint(0)}`),
  coinsOnRevoke: tx(USDT, `0x095ea7b3${pad(ATTACKER)}${uint(0)}`, '0xde0b6b3a7640000'),
  toSelf: tx(ME, '0x', '0x2386f26fc10000'),
  empty: tx(OTHER, '0x', '0x0'),
  // Added by the last re-attack of 2026-11-24: an empty transaction whose network fee, as the site set it, can reach 21 ETH.
  siteFee: { ...tx(OTHER), params: [{ from: ME, to: OTHER, data: '0x', value: '0x0', gas: '0x5208', maxFeePerGas: '0x38d7ea4c68000' }] },
  fromOther: tx(USDT, `0x23b872dd${pad(OTHER)}${pad(ATTACKER)}${uint(1_000_000n)}`),
  fromOtherToMe: tx(USDT, `0x23b872dd${pad(OTHER)}${pad(ME)}${uint(1_000_000n)}`),
  // Ends in 30 days.
  permit2Approve: tx(PERMIT2, `0x87517c45${pad(USDC)}${pad(ATTACKER)}${uint(10_000_000n)}${uint(Math.floor(Date.now() / 1000) + 30 * 86400)}`),
  permitSingle: permit(
    'PermitSingle',
    { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
    { details: { token: USDC, amount: '800000000', expiration: 4102444800, nonce: 0 }, spender: ATTACKER, sigDeadline: 4102444800 },
  ),
  permitTransfer: permit(
    'PermitTransferFrom',
    { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
    { permitted: { token: USDC, amount: '800000000' }, spender: ATTACKER, nonce: 1, deadline: 4102444800 },
  ),
  permitBatch: permit(
    'PermitBatch',
    { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
    {
      details: [
        { token: USDC, amount: '800000000', expiration: 4102444800, nonce: 0 },
        { token: USDT, amount: ((1n << 160n) - 1n).toString(), expiration: 4102444800, nonce: 0 },
      ],
      spender: ATTACKER,
      sigDeadline: 4102444800,
    },
  ),
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
  // Added by the re-attack of 2026-11-24.
  itemZero: tx(UNI, `0x095ea7b3${pad(ATTACKER)}${uint(0)}`, null, { token: { symbol: 'UNI', decimals: 18 }, spenderIsContract: false }),
  itemZeroBatch: batch([UNI, LINK].map((to) => ({ to, data: `0x095ea7b3${pad(ATTACKER)}${uint(0)}` }))),
  noChange: tx(USDT, `0x39509351${pad(ATTACKER)}${uint(0)}`),
  authorization: typed({ types: AUTH_TYPES, primaryType: 'TransferWithAuthorization', domain: USDC_DOMAIN, message: AUTH }),
  metaApprove: typed({
    types: META_TYPES,
    primaryType: 'MetaTransaction',
    domain: { name: '(PoS) Tether USD', version: '1', verifyingContract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' },
    message: { nonce: 0, from: ME, functionSignature: `0x095ea7b3${pad(ATTACKER)}${MAX}` },
  }),
  // Added by the second re-attack of 2026-11-24: an NFT permit (Uniswap V3 positions), and small payments in one batch.
  itemPermit: typed(
    typedData(
      'Permit',
      { name: 'Uniswap V3 Positions NFT-V1', version: '1', chainId: 1, verifyingContract: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' },
      { spender: ATTACKER, tokenId: '12345', nonce: 0, deadline: 4102444800 },
      'NftPermit',
    ),
  ),
  paidTwice: batch([
    { to: ATTACKER, value: '0xb1a2bc2ec50000' },
    { to: OTHER, value: '0xb1a2bc2ec50000' },
  ]),
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

test('the deeper analysis names a scam pattern only with evidence the analyzer found', () => {
  const deep = (name, pattern) => checkReading(rightDeep(R[name], { pattern }), R[name], { deep: true }).match;
  assert.equal(deep('claim', 'approval_phishing'), true);
  assert.equal(deep('claim', 'permit_phishing'), false);
  assert.equal(deep('claim', 'sign_in_phishing'), false);
  assert.equal(deep('claim', 'fake_token'), false);
  assert.equal(deep('fake', 'fake_token'), true);
  assert.equal(deep('permit', 'permit_phishing'), true);
  assert.equal(deep('permit', 'approval_phishing'), true, 'a permit is an approval by signature');
  assert.equal(deep('nft', 'collection_approval_phishing'), true);
  assert.equal(deep('phish', 'sign_in_phishing'), true);
  assert.equal(deep('signin', 'sign_in_phishing'), false, 'a sign-in for this same site');
  assert.equal(deep('batchOk', 'risky_action_in_a_batch'), true);
  // An approval, a permit, a batch or an order is no scam by itself: without
  // the analyzer's warnings, no known pattern fits.
  assert.equal(R.increase.risk, 'caution');
  assert.equal(deep('increase', 'approval_phishing'), false, 'a limited approval to an unknown contract');
  assert.equal(R.permitTransfer.risk, 'caution');
  assert.equal(deep('permitTransfer', 'permit_phishing'), false, 'a limited one-time signature to an unknown contract');
  assert.equal(deep('order', 'marketplace_order_phishing'), false, 'not on the list: Guardian cannot see an order’s price');
  assert.equal(deep('order', 'no_known_pattern'), true);
  assert.equal(deep('order', 'cannot_determine'), true);
  assert.ok(!('marketplace_order_phishing' in PATTERNS));
  for (const [name, p] of Object.entries(PATTERNS)) {
    if (['no_known_pattern', 'cannot_determine'].includes(name)) continue;
    for (const [rname, result] of Object.entries(R)) {
      if (p.fits(result)) assert.ok(result.risk === 'danger' && result.warnings.length > 0, `${name} fits ${rname} without evidence`);
    }
  }
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
  assert.equal(m('claim'), 'If you confirm, an unknown personal wallet can take any amount of USDT from your wallet, whenever it wants, without asking you, until you revoke it.');
  assert.match(m('limited'), /^If you confirm, Uniswap Permit2 \(a well-known service\) can take up to 25 USDC from your wallet,/);
  assert.match(m('increase'), /an unknown address can take up to 5 USDC more from your wallet/);
  assert.match(m('permit2Approve'), /up to 10 USDC from your wallet, whenever it wants, without asking you, until \d{4}-\d\d-\d\d \d\d:\d\d UTC, unless you revoke it sooner\.$/);
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
    offer: null,
    problem: null,
    detail: '',
  });
  assert.equal(run({ ...right, offer: 'receive' }).offer, 'receive');
  assert.equal(run({ ...right, offer: 'made_up' }).offer, null);
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

test('what the button promised: code reads plain words, Gemini only the unclear ones, and only adds a warning', async () => {
  const { cleanPromise, offerOf, contradiction } = await import('../src/analyzer/promise.js');
  const { geminiOffer } = await import('../src/ai/reading.js');
  const press = (button, extra = {}) => ({ button, title: 'Rewards', heading: 'Claim your tokens', ageMs: 300, ...extra });
  // Only a recent, plain press counts.
  assert.equal(cleanPromise(null), null);
  assert.equal(cleanPromise(press('')), null);
  assert.equal(cleanPromise(press('Claim', { ageMs: 20000 })), null, 'too long before the request');
  assert.equal(cleanPromise(press('x'.repeat(300))).button.length, 80);
  assert.equal(cleanPromise(press('Claim' + String.fromCharCode(10) + 'now')).button, 'Claim now');
  // What code reads from the words.
  for (const [button, offer] of [
    ['Claim airdrop', 'receive'],
    ['Get your reward', 'receive'],
    ['Connect wallet', 'sign_in'],
    ['Verify ownership', 'sign_in'],
    ['Revoke', 'revoke'],
    ['Mint now', 'mint'],
    ['Swap', 'swap'],
    ['Send 0.01 ETH', 'pay'],
    ['Approve 25 USDC for a swap', 'swap'],
    ['Unlock NFT trading', 'approve'],
    ['Check eligibility', 'receive'],
    ['Continue', null],
    ['Get started', null],
  ]) {
    assert.equal(offerOf(button), offer, button);
  }
  // A button that names more than one thing: a contradiction only if every one of them is.
  const { offersOf } = await import('../src/analyzer/promise.js');
  assert.deepEqual(offersOf('Approve and claim'), ['receive', 'approve']);
  assert.equal(analyze({ ...RECORDS.limited, promise: press('Approve and claim') }).risk, 'info', 'it says it approves');
  assert.equal(analyze({ ...RECORDS.limited, promise: press('Approve and claim') }).warnings.length, 0);
  assert.equal(analyze({ ...RECORDS.limited, promise: press('Stake') }).warnings.length, 0);
  assert.equal(analyze({ ...RECORDS.limited, promise: press('Claim and connect') }).warnings.length, 1, 'both offers contradict it');
  assert.equal(analyze({ ...RECORDS.signin, promise: press('Check eligibility') }).warnings.length, 0, 'a sign-in moves nothing');
  // Clear contradictions only.
  const pressedOn = (name, button) => analyze({ ...RECORDS[name], promise: press(button) });
  const claim = pressedOn('limited', 'Claim airdrop');
  assert.equal(claim.risk, 'danger', 'a claim that gives a permission is high risk');
  assert.equal(claim.facts[1].label, 'Button pressed');
  assert.match(claim.warnings[0], /^The button you pressed said “Claim airdrop”, an offer to receive something, but this request gives someone permission to take USDC out of your wallet\.$/);
  assert.equal(pressedOn('limited', 'Approve 25 USDC for a swap').risk, 'info', 'an honest button changes nothing');
  assert.equal(pressedOn('signin', 'Sign in').warnings.length, 0);
  assert.match(pressedOn('transfer', 'Sign in').warnings[0], /an offer to sign in or verify the wallet, but this request sends 0\.01 ETH out of your wallet/);
  assert.match(pressedOn('nft', 'Mint now').warnings[0], /an offer to mint, but this request gives someone access to every item you own in a collection/);
  assert.match(pressedOn('permitBatch', 'Revoke').warnings[0], /an offer to remove a permission/);
  assert.equal(pressedOn('revoke', 'Revoke').warnings.length, 0);
  assert.equal(contradiction('receive', R.signin, 'Claim'), null, 'nothing moves in a sign-in');
  // Gemini: only where code could not read the button, and only to add a warning.
  const unclear = pressedOn('claim', 'Continue');
  assert.equal(unclear.subject.promise.offer, null);
  assert.match(geminiOffer(unclear, 'receive'), /^Gemini reads the button you pressed, “Continue”, as an offer to receive something, but this request gives someone permission to take any amount of USDT out of your wallet\.$/);
  assert.equal(geminiOffer(unclear, 'approve'), null, 'no contradiction');
  assert.equal(geminiOffer(unclear, 'other'), null);
  assert.equal(geminiOffer(pressedOn('claim', 'Claim airdrop'), 'swap'), null, 'code read the button: Gemini is not asked to');
  assert.equal(geminiOffer(R.claim, 'receive'), null, 'no button pressed');
});

test('the button check, after the review of 2026-11-18: revoke phrases, lure words, paid calls, facts order, addresses', async () => {
  const { offersOf, cleanPromise } = await import('../src/analyzer/promise.js');
  const { geminiOffer } = await import('../src/ai/reading.js');
  const press = (button, extra = {}) => ({ button, title: 'Rewards', heading: 'Claim your tokens', ageMs: 300, ...extra });
  const on = (name, button) => analyze({ ...RECORDS[name], promise: press(button) });
  const clashOf = (r) => r.subject.promise.clash;
  // What a revoke button names is what it removes, not an offer to approve.
  for (const button of [
    'Revoke approval',
    'Remove approval',
    'Remove approvals',
    'Cancel approval',
    'Revoke permission',
    'Remove permission',
    'Revoke all approvals',
    'Remove USDC approval',
    'Cancel spending permission',
    'Remove unlimited approvals',
    'Cancel USDC approval',
    'Revoke permit',
    'Remove risky approvals',
  ]) {
    assert.deepEqual(offersOf(button), ['revoke'], button);
    assert.equal(on('limited', button).risk, 'danger', `${button} on a permission`);
  }
  assert.deepEqual(offersOf('Revoke and approve'), ['revoke', 'approve'], 'an approve verb still counts');
  assert.equal(clashOf(on('limited', 'Revoke and approve')), false);
  // Only verbs approve: nouns never do, and a verb with other meanings only
  // at the start of the button or of a clause.
  for (const [name, button] of [
    ['permit', 'Connect wallet to check approvals'],
    ['permit', 'Connect to scan approvals'],
    ['order', 'Verify permissions'],
    ['permit', 'Claim (no approvals needed)'],
    ['limited', 'Claim grant'],
    ['limited', 'You’re on the list! Claim now'],
  ]) {
    assert.equal(clashOf(on(name, button)), true, `${button} on ${name}`);
  }
  for (const button of ['Claim and sell', 'Connect & enable USDC', 'Unlock rewards', 'Enable USDC', 'Approve and claim', 'Give permission (you can revoke it anytime)']) {
    assert.equal(clashOf(on('limited', button)), false, `${button} on a permission`);
  }
  assert.deepEqual(offersOf('Check approvals'), [], 'unclear: Gemini reads it');
  assert.equal(clashOf(on('transfer', 'Approve')), false, 'a lone approve is never a contradiction');
  assert.equal(clashOf(on('transfer', 'Approve and claim')), true, 'approving is not sending');
  // Where code is not sure, it says nothing and Gemini may read the words:
  // "Unlock rewards" on a payment may be paying to unlock something.
  for (const button of ['Unlock rewards', 'Unlock bonus content']) {
    const r = on('transfer', button);
    assert.equal(r.risk, R.transfer.risk, button);
    assert.equal(r.subject.promise.offer, null, button);
  }
  assert.match(geminiOffer(on('transfer', 'Unlock rewards'), 'receive'), /^Gemini reads the button you pressed, “Unlock rewards”, as an offer to receive something, but this request sends 0\.01 ETH out of your wallet\.$/);
  assert.equal(geminiOffer(on('transfer', 'Unlock bonus content'), 'pay'), null);
  // Words for paying to get something are left to Gemini, except against a
  // marketplace order for the user's own items, which no purchase needs.
  for (const button of ['Redeem', 'Collect', 'Enter to win']) {
    assert.equal(on('limited', button).risk, 'info', button);
    assert.equal(on('limited', button).subject.promise.offer, null, button);
    assert.equal(clashOf(on('order', button)), true, `${button} on a marketplace order`);
  }
  // A sign-in or a revoke never sends coins; a claim may cost a fee.
  const payable = tx(ATTACKER, '0x5fba79f5', '0xde0b6b3a7640000', { balance: '0xde0b6b3a7640000' });
  const paid = (button) => analyze({ ...payable, promise: press(button) });
  assert.match(paid('Connect wallet').warnings[0], /^The button you pressed said “Connect wallet”, an offer to sign in or verify the wallet, but this request sends 1 ETH to a contract call Guardian cannot read\.$/);
  assert.equal(paid('Connect wallet').risk, 'danger');
  assert.equal(clashOf(paid('Revoke')), true);
  assert.equal(clashOf(paid('Claim airdrop')), false, 'a claim may cost a fee');
  assert.equal(clashOf(analyze({ ...tx(ATTACKER, '0x5fba79f5'), promise: press('Connect wallet') })), false, 'no coins, no contradiction');
  // The pressed button comes after the action, or after every numbered action or token.
  const where = (r) => r.facts.findIndex((f) => f.label === 'Button pressed');
  const numbered = (r) => r.facts.filter((f) => /^(?:Action|Token) \d+$/.test(f.label)).length;
  for (const name of ['batchOk', 'batchUnknown', 'permitBatch']) {
    const r = on(name, 'Continue');
    assert.ok(numbered(r) > 1, name);
    assert.equal(where(r), numbered(r), `${name}: after all ${numbered(r)} numbered facts`);
  }
  assert.equal(where(on('limited', 'Continue')), 1, 'right after the action');
  // Addresses in the site's words go before anything is cut short.
  const own = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
  const seen = cleanPromise(press('Continue', { title: `Positions, rewards and recent activity for wallet ${own}`, heading: 'Rewards for 0x71C7…976F' }));
  assert.equal(seen.title, 'Positions, rewards and recent activity for wallet an address');
  assert.equal(seen.heading, 'Rewards for an address');
  assert.equal(cleanPromise(press('Send to 0x71c7...976f')).button, 'Send to an address');
  for (const short of ['0x11…1111', '0x111…1111', '0x71C7••••976F', '0x71C7....976F', '0x71C7⋯976F', '0x71C7…976F']) {
    assert.equal(cleanPromise(press(`Rewards for ${short}`)).button, 'Rewards for an address', short);
  }
  assert.equal(cleanPromise(press('0x1234 · Add funds')).button, 'an address · Add funds', 'the words after it stay');
  assert.ok(!/[0-9a-f]{6}/i.test(JSON.stringify(seen)), 'no part of the address is left');
  // The in-page guard takes them out with the same pattern, before it cuts.
  const pattern = (file) => readFileSync(new URL(file, import.meta.url), 'utf8').match(/const ADDRESS = (.*);/)[1];
  assert.equal(pattern('../src/inpage.js'), pattern('../src/analyzer/promise.js'));
});

test('Gemini Nano’s response constraint leaves nothing to run on with', async () => {
  const { READING_SCHEMA, DEVICE_READING_SCHEMA, REASON_NUMBERS } = await import('../src/ai/reading.js');
  // The same form as the cloud's schema...
  assert.deepEqual(Object.keys(DEVICE_READING_SCHEMA.properties), Object.keys(READING_SCHEMA.properties));
  assert.deepEqual(DEVICE_READING_SCHEMA.required, READING_SCHEMA.required);
  assert.equal(DEVICE_READING_SCHEMA.additionalProperties, false);
  // ...with every value bounded: fixed words, at most two listed numbers.
  for (const [name, field] of Object.entries(DEVICE_READING_SCHEMA.properties)) {
    if (name === 'reasons') continue;
    assert.ok(Array.isArray(field.enum), `${name} is one of fixed words`);
  }
  const { reasons } = DEVICE_READING_SCHEMA.properties;
  assert.equal(reasons.maxItems, 2);
  assert.deepEqual(reasons.items.enum, REASON_NUMBERS);
  // Every reason a request on the demo has can be picked.
  for (const [name, result] of Object.entries(R)) {
    assert.ok(result.reasons.length <= REASON_NUMBERS.length, `${name}: ${result.reasons.length} reasons`);
  }
});

// ── Security review of 2026-11-21 ──────────────────────────────────────────

test('requests Guardian cannot read get no AI: malformed, delegation, unreadable permits, methods with no decoder', () => {
  const approve = `0x095ea7b3${pad(ATTACKER)}${MAX}`;
  const cannot = {
    noPrefix: tx(USDT, approve.slice(2)),
    decimalValue: { ...tx(ATTACKER, '0x'), params: [{ from: ME, to: ATTACKER, value: '9000000000000000' }] },
    delegation: { ...tx(ME, '0x'), params: [{ from: ME, to: ME, type: '0x4', authorizationList: [{ address: ATTACKER }] }] },
    noTypes: typed({ primaryType: 'Permit', domain: { verifyingContract: USDC }, message: { owner: ME, spender: ATTACKER, value: '0', nonce: 0, deadline: 1 } }),
    grant: { method: 'wallet_grantPermissions', params: [{}], origin: `https://${HOST}` },
    snap: { method: 'wallet_invokeSnap', params: [{}], origin: `https://${HOST}` },
    batch: batch([{ to: USDT, data: approve.slice(2) }]),
  };
  for (const [name, record] of Object.entries(cannot)) {
    const result = analyze(record);
    assert.equal(isUndecoded(result), true, name);
    assert.equal(decodedReading(result), null, name);
    assert.notEqual(result.risk, 'info', name);
  }
});

test('a sign-in from a site Guardian cannot identify: another site may gain, and comparing the sites is a must', () => {
  const unknown = analyze({ ...RECORDS.phish, origin: 'null' });
  assert.equal(unknown.subject.unknownSite, true);
  const said = (who) => checkReading(rightAnswer(unknown, { who_gains: who }), unknown).match;
  assert.equal(said('nobody'), true);
  assert.equal(said('another_party'), true);
  assert.equal(said('you'), false);
  assert.deepEqual(checksFor(unknown, []), ['compare_the_sites']);
  // No known scam pattern on a request that is only "check carefully".
  assert.equal(checkReading(rightDeep(unknown), unknown, { deep: true }).match, true);
});

test('eth_signTransaction has the same reading as the transaction; bulk orders read as a marketplace order', () => {
  const signed = analyze({ ...RECORDS.claim, method: 'eth_signTransaction' });
  assert.deepEqual(decodedReading(signed), decodedReading(R.claim));
  const bulk = analyze(typed({ primaryType: 'BulkOrder', domain: { name: 'Seaport' }, message: { tree: [] } }));
  assert.deepEqual(decodedReading(bulk).action, ['marketplace_order']);
  assert.equal(checkReading(rightAnswer(bulk), bulk).match, true);
});

test('a payment to an account the page reported is to another party, in the reading too', () => {
  // 1 ETH: more than a small payment, so a forged huge balance cannot calm it.
  const result = analyze(tx(OTHER, '0x', '0xde0b6b3a7640000', { accounts: [ME, OTHER], balance: `0x${'f'.repeat(64)}` }));
  assert.equal(result.risk, 'caution');
  assert.deepEqual(decodedReading(result).who_gains, ['another_party']);
  assert.equal(checkReading(rightAnswer(result, { who_gains: 'you' }), result).match, false);
  // A small one raises no flag, and is still to another party.
  const small = analyze(tx(OTHER, '0x', '0x2386f26fc10000', { accounts: [ME, OTHER], balance: `0x${'f'.repeat(64)}` }));
  assert.equal(small.risk, 'info');
  assert.equal(checkReading(rightAnswer(small, { who_gains: 'you' }), small).match, false);
});

// ── Re-attack of 2026-11-24 ────────────────────────────────────────────────

test('approve(spender, 0) that may be a revoke or item #0: either reading is right, but only as a whole', () => {
  const r = R.itemZero;
  assert.equal(r.risk, 'caution');
  const said = (answer) => checkReading({ reasons: [], ...answer }, r).match;
  const revoke = { action: 'remove_permission', who_gains: 'nobody', direction: 'nothing_moves', limit: 'does_not_apply' };
  const item = { action: 'spending_permission', who_gains: 'another_party', direction: 'out_of_your_wallet', limit: 'limited' };
  assert.equal(said(revoke), true);
  assert.equal(said(item), true);
  // A field of each is not a reading of the request.
  for (const mixed of [
    { ...revoke, who_gains: 'another_party' },
    { ...revoke, direction: 'out_of_your_wallet' },
    { ...item, direction: 'nothing_moves' },
    { ...item, who_gains: 'nobody', direction: 'nothing_moves' },
    { ...item, limit: 'does_not_apply' },
  ]) {
    const out = checkReading({ reasons: [], ...mixed }, r);
    assert.equal(out.match, false, JSON.stringify(mixed));
    assert.ok(out.mismatches.length > 0);
  }
  assert.equal(said({ ...item, limit: 'unlimited' }), false);
  assert.equal(said({ ...revoke, who_gains: 'you' }), false);
  // A batch of them: either nothing moves, or something may leave; never "you gain".
  const b = R.itemZeroBatch;
  assert.equal(checkReading({ reasons: [], action: 'several_actions', who_gains: 'nobody', direction: 'nothing_moves', limit: 'limited' }, b).match, true);
  assert.equal(checkReading({ reasons: [], action: 'several_actions', who_gains: 'another_party', direction: 'out_of_your_wallet', limit: 'limited' }, b).match, true);
  assert.equal(checkReading({ reasons: [], action: 'several_actions', who_gains: 'nobody', direction: 'out_of_your_wallet', limit: 'limited' }, b).match, false);
  // A batch with a real permission in it: assets may leave, whatever the other part is.
  const mixedBatch = analyze(batch([{ to: UNI, data: `0x095ea7b3${pad(ATTACKER)}${uint(0)}` }, { to: USDT, data: `0x095ea7b3${pad(ATTACKER)}${MAX}` }]));
  assert.deepEqual(decodedReading(mixedBatch).direction, ['out_of_your_wallet']);
  // Coins sent with it leave the wallet in either reading.
  const paid = analyze({ ...RECORDS.itemZero, params: [{ from: ME, to: UNI, data: `0x095ea7b3${pad(ATTACKER)}${uint(0)}`, value: '0x1' }] });
  assert.equal(checkReading({ reasons: [], ...revoke }, paid).match, false);
  assert.equal(checkReading({ reasons: [], ...revoke, who_gains: 'another_party', direction: 'out_of_your_wallet' }, paid).match, true);
  // What to check: which permission it removes; not an amount; the spender is no must here.
  assert.equal(CHECKS.which_permission.fits(r), true);
  assert.equal(CHECKS.is_the_amount_needed.fits(r), false);
  assert.equal(CHECKS.who_is_the_spender.must(r), false);
  // Gemini reading the button as a revoke adds nothing; as a claim, it warns.
  const pressed = analyze({ ...RECORDS.itemZero, promise: { button: 'Continue', title: 'Revoke', heading: 'Approvals', ageMs: 300 } });
  assert.equal(geminiOffer(pressed, 'revoke'), null);
  assert.match(geminiOffer(pressed, 'receive'), /may give someone your item #0, if this contract is an NFT collection\.$/);
});

test('increaseAllowance of 0 reads as a permission that changes nothing, never as a removal', () => {
  const r = R.noChange;
  assert.deepEqual(decodedReading(r).action, ['spending_permission']);
  assert.equal(checkReading(rightAnswer(r, { action: 'remove_permission' }), r).match, false);
  assert.equal(checkReading(rightAnswer(r, { who_gains: 'another_party', direction: 'out_of_your_wallet' }), r).match, false);
  assert.equal(CHECKS.which_permission.fits(r), false);
});

test('an EIP-3009 signed transfer reads as a payment or a one-time permission; its validity can be checked', () => {
  const r = R.authorization;
  for (const action of ['payment', 'spending_permission']) assert.equal(checkReading(rightAnswer(r, { action }), r).match, true, action);
  assert.equal(checkReading(rightAnswer(r, { direction: 'nothing_moves' }), r).match, false);
  assert.equal(CHECKS.how_long_it_is_valid.fits(r), true);
  assert.deepEqual(checksFor(r, []), ['check_the_recipient']);
  // Under a claim button: high risk, and the deeper analysis must name its pattern.
  const lure = analyze({ ...RECORDS.authorization, promise: { button: 'Claim airdrop', title: 'Airdrop', heading: 'Claim', ageMs: 300 } });
  assert.equal(lure.risk, 'danger');
  assert.equal(PATTERNS.permit_phishing.fits(lure), true);
  assert.equal(checkReading(rightDeep(lure, { pattern: 'permit_phishing' }), lure, { deep: true }).match, true);
  assert.equal(checkReading(rightDeep(lure, { pattern: 'no_known_pattern' }), lure, { deep: true }).match, false);
});

test('a meta-transaction reads as the call it has the contract make', () => {
  const r = R.metaApprove;
  assert.equal(r.risk, 'danger');
  assert.deepEqual(decodedReading(r), decodedReading(R.claim));
  assert.equal(PATTERNS.approval_phishing.fits(r), true);
  // A call Guardian has no decoder for: no AI at all.
  const unknown = analyze({ ...RECORDS.metaApprove, params: [ME, JSON.stringify({ ...JSON.parse(RECORDS.metaApprove.params[1]), message: { nonce: 0, from: ME, functionSignature: '0xdeadbeef' } })] });
  assert.equal(unknown.risk, 'caution');
  assert.equal(decodedReading(unknown), null);
});

test('an NFT permit reads as a spending permission for one item: limited, out of the wallet; its sentence names the item', () => {
  const r = R.itemPermit;
  assert.equal(r.risk, 'caution');
  assert.deepEqual(decodedReading(r), { action: ['spending_permission'], who_gains: ['another_party'], direction: ['out_of_your_wallet'], limit: ['limited'] });
  assert.equal(checkReading(rightAnswer(r, { action: 'collection_access' }), r).match, false, 'one item, not the whole collection');
  assert.equal(checkReading(rightAnswer(r, { limit: 'unlimited' }), r).match, false);
  assert.equal(checkReading(rightAnswer(r, { who_gains: 'nobody', direction: 'nothing_moves' }), r).match, false);
  assert.equal(
    meaning(r, HOST),
    'If you confirm, an unknown address can take your item #12345 of the collection 0xc36442b4a4522e871399cd717abdd847ab11fe88 from your wallet, whenever it wants, without asking you, until you revoke it.',
  );
  // Things to check: who the spender is, how long the signature is valid; no token amount to ask about.
  for (const id of ['who_is_the_spender', 'how_long_it_is_valid', 'revoke_when_done']) assert.equal(CHECKS[id].fits(r), true, id);
  for (const id of ['is_the_amount_needed', 'is_the_token_real', 'check_the_recipient', 'which_permission']) assert.equal(CHECKS[id].fits(r), false, id);
  // Under a claim button: high risk, and the deeper analysis must name a pattern it has.
  const lure = analyze({ ...RECORDS.itemPermit, promise: { button: 'Claim airdrop', title: 'Airdrop', heading: 'Claim', ageMs: 300 } });
  assert.equal(lure.risk, 'danger');
  assert.equal(PATTERNS.permit_phishing.fits(lure), true);
  assert.equal(checkReading(rightDeep(lure, { pattern: 'permit_phishing' }), lure, { deep: true }).match, true);
  assert.equal(checkReading(rightDeep(lure, { pattern: 'no_known_pattern' }), lure, { deep: true }).match, false);
});

test('an empty transaction whose network fee the site set above a small payment: the sentence names it, and the fee may be read as leaving the wallet', () => {
  const r = R.siteFee;
  assert.equal(r.risk, 'caution');
  assert.equal(meaning(r, HOST), `If you confirm, an empty transaction is sent to ${OTHER}: no coins move, only the network fee is paid, up to 21 ETH as the site set it.`);
  const said = (direction) => checkReading(rightAnswer(r, { direction }), r).match;
  assert.equal(said('nothing_moves'), true);
  assert.equal(said('out_of_your_wallet'), true);
  assert.equal(said('into_your_wallet'), false);
  // An ordinary empty transaction: as before.
  assert.equal(meaning(R.empty, HOST), `If you confirm, an empty transaction is sent to ${OTHER}: no coins move, only the network fee is paid.`);
  assert.equal(checkReading(rightAnswer(R.empty, { direction: 'out_of_your_wallet' }), R.empty).match, false);
});

test('small payments in one batch: several actions, out of the wallet, and the sentence says their sum', () => {
  const r = R.paidTwice;
  assert.equal(r.risk, 'caution');
  assert.deepEqual(decodedReading(r).action, ['several_actions']);
  assert.equal(checkReading(rightAnswer(r, { who_gains: 'nobody', direction: 'nothing_moves' }), r).match, false);
  assert.equal(meaning(r, HOST), 'If you confirm, all 2 actions listed below are carried out with this one confirmation. Together, they send 0.1 ETH out of your wallet.');
  assert.ok(r.reasons.includes('Together, these actions send 0.1 ETH out of your wallet.'));
  // One payment: no sum to say.
  assert.doesNotMatch(meaning(analyze(batch([{ to: ATTACKER, value: '0xb1a2bc2ec50000' }])), HOST), /Together/);
});
