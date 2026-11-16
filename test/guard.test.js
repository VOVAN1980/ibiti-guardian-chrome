// Guardian's checks on its own AI: real answers pass, wrong ones are caught
// before the user would see them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze } from '../src/analyzer/index.js';
import { meaning } from '../src/ai/prompt.js';
import { answerChecker, groundTruth, ownAddresses, scrubAddresses } from '../src/ai/guard.js';

const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const FAKE_USDT = '0x00000000000000000000000000000000DeaDBeef';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const ATTACKER = '0x9F3a00000000000000000000000000000000c21E';
const NFT = '0x2222222222222222222222222222222222222222';
const ME = '0x1111111111111111111111111111111111111111';
const HOST = '127.0.0.1:5179';
const MAX = 'f'.repeat(64);
const pad = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const uint = (n) => BigInt(n).toString(16).padStart(64, '0');
const toHex = (text) => `0x${Buffer.from(text).toString('hex')}`;
const base = { chainId: 1, origin: `http://${HOST}` };
const send = (to, data, value, enrich) => ({
  ...base,
  method: 'eth_sendTransaction',
  params: [{ from: ME, to, data, ...(value ? { value } : {}) }],
  ...(enrich ? { enrich } : {}),
});

// The ten demo scenarios (demo/dapp.js), plus requests Guardian cannot decode.
const RECORDS = {
  claim: send(USDT, `0x095ea7b3${pad(ATTACKER)}${MAX}`, null, { spenderIsContract: false }),
  fake: send(FAKE_USDT, `0x095ea7b3${pad(ATTACKER)}${uint(1000000n)}`, null, {
    spenderIsContract: false,
    token: { symbol: 'USDT', decimals: 6 },
  }),
  limited: send(USDC, `0x095ea7b3${pad(PERMIT2)}${uint(25_000_000n)}`),
  nft: send(NFT, `0xa22cb465${pad(ATTACKER)}${uint(1)}`, null, { spenderIsContract: false }),
  transfer: send(ATTACKER, '0x', '0x2386f26fc10000', { balance: '0x1bc16d674ec80000' }),
  revoke: send(USDT, `0x095ea7b3${pad(ATTACKER)}${uint(0)}`),
  blind: { ...base, method: 'eth_sign', params: [ME, `0x${'5a'.repeat(32)}`] },
  permit: {
    ...base,
    method: 'eth_signTypedData_v4',
    params: [
      ME,
      JSON.stringify({
        types: {},
        primaryType: 'Permit',
        domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC },
        message: { owner: ME, spender: ATTACKER, value: BigInt(`0x${MAX}`).toString(), nonce: 0, deadline: 4102444800 },
      }),
    ],
    enrich: { spenderIsContract: false },
  },
  signin: {
    ...base,
    method: 'personal_sign',
    params: [toHex(`${HOST} wants you to sign in with your Ethereum account:\n${ME}\n\nSign in to the demo.\n\nNonce: 8f2c1d`), ME],
  },
  phish: {
    ...base,
    method: 'personal_sign',
    params: [toHex(`nft-market.example wants you to sign in with your Ethereum account:\n${ME}\n\nNonce: 77aa01`), ME],
  },
  unknownCall: send(ATTACKER, `0xdeadbeef${uint(5)}`),
  // 0.007716… ETH
  oddAmount: send(ATTACKER, '0x', '0x1b69b4ba630f34'),
  self: send(ME, '0x', '0x2386f26fc10000'),
  unknownTyped: {
    ...base,
    method: 'eth_signTypedData_v4',
    params: [ME, JSON.stringify({ primaryType: 'Mystery', domain: { name: 'Some App' }, message: { a: 1 } })],
  },
};
const R = Object.fromEntries(Object.entries(RECORDS).map(([name, record]) => [name, analyze(record)]));

/** Checks a whole answer the way the window does. Null = it would be shown. */
/** "reason (detail)": the reason the window shows, and what was wrong. */
const verdict = (name, text) => {
  const result = R[name];
  const checker = answerChecker(result, meaning(result, HOST), { own: [ME], chainId: 1, host: HOST });
  checker.push(text);
  const out = checker.finish(text);
  return out.problem === null ? null : `${out.problem} (${out.detail})`;
};
const caught = (name, text, why) => assert.match(String(verdict(name, text)), why, `${name}: ${text}`);
const passes = (name, text) => assert.equal(verdict(name, text), null, `${name}: ${text}`);

// ── Real answers must pass ──────────────────────────────────────────────────

test('real Gemini answers, recorded from the device and the cloud, pass the checks', () => {
  const real = JSON.parse(readFileSync(new URL('./fixtures/real-answers.json', import.meta.url), 'utf8'));
  let count = 0;
  for (const [name, answers] of Object.entries(real)) {
    for (const { text } of answers) {
      passes(name, text);
      count += 1;
    }
  }
  assert.ok(count >= 90, `${count} recorded answers checked`);
});

test('the sentences Guardian writes itself pass its own checks', () => {
  for (const [name, result] of Object.entries(R)) {
    const sentence = meaning(result, HOST);
    if (sentence) passes(name, sentence);
    for (const reason of result.reasons) passes(name, reason);
  }
});

// ── Amounts: the right number with the right token ──────────────────────────

test('a wrong amount is caught, even when its digits occur inside an address', () => {
  // The recipient is 0x9F3a…c21E: "9", "3" and "21" are in the address, not amounts.
  caught('transfer', 'If you confirm, 3 ETH leaves your wallet.', /amount.*\(3 ETH\)/);
  caught('transfer', 'If you confirm, 21 ETH leaves your wallet.', /amount.*\(21 ETH\)/);
  caught('transfer', 'If you confirm, 9 ETH leaves your wallet.', /amount.*\(9 ETH\)/);
  caught('transfer', 'If you confirm, 0.1 ETH leaves your wallet.', /amount.*\(0\.1 ETH\)/);
  caught('transfer', 'If you confirm, 0.01 USDT leaves your wallet.', /amount.*\(0\.01 USDT\)/);
  caught('limited', 'This lets a known service spend up to 250 USDC.', /amount.*\(250 USDC\)/);
  caught('limited', 'This lets a known service spend up to 25 USDT.', /amount.*\(25 USDT\)/);
  caught('fake', 'The spender can take up to 1,000 USDT.', /amount/);
  passes('transfer', 'If you confirm, 0.01 ETH leaves your wallet.');
  passes('transfer', 'If you confirm, 0.010 ETH leaves your wallet.');
  passes('limited', 'This lets Uniswap Permit2 spend up to 25 USDC from your wallet.');
  passes('limited', 'This lets Uniswap Permit2 spend up to $25 from your wallet.');
});

test('amounts in other spellings are caught', () => {
  caught('claim', 'They could take $5,000 from you.', /amount/);
  caught('claim', 'They could take €500 from you.', /amount/);
  caught('claim', 'They could take 500 dollars from you.', /amount/);
  caught('claim', 'They could take five hundred USDT from you.', /amount/);
  caught('claim', 'They could take 5k USDT from you.', /amount/);
  caught('claim', 'They could take 2 million USDT from you.', /amount/);
  caught('limited', 'They could take half of your USDC.', /amount/);
  caught('transfer', 'This sends 50% of your ETH.', /share/);
  caught('transfer', 'This is step 3 of the process.', /number.*\(3\)/);
  // What the facts say may be repeated.
  passes('transfer', 'This is less than 1% of your ETH.');
  passes('claim', 'They could take 100% of your USDT.');
  passes('claim', 'This is an ERC-20 approval of the kind drainers abuse.');
});

// ── Addresses, tokens ───────────────────────────────────────────────────────

test('an address or name that is not in the request is caught', () => {
  caught('claim', 'If you confirm, 0xDEAD000000000000000000000000000000BEEF can take your USDT.', /address/);
  caught('claim', 'The spender 0xdead00…00beef gets unlimited USDT.', /address/);
  caught('claim', 'The spender 0X9F3A00000000000000000000000000000000BEEF gets unlimited USDT.', /address/);
  caught('claim', 'The spender 0x9f3a…beef gets unlimited USDT.', /address/);
  caught('claim', 'The spender is vitalik.eth, a known person.', /name.*\(vitalik\.eth\)/);
  // The real spender, in the forms the window itself uses, is fine.
  passes('claim', 'The spender 0x9f3a00…00c21e gets permission to take any amount of USDT.');
  passes('claim', 'The spender 0x9F3a00000000000000000000000000000000c21E gets permission to take any amount of USDT.');
  passes('claim', 'The spender 0x9f3a...c21e gets permission to take any amount of USDT.');
});

test('a token that is not in the request is caught', () => {
  caught('claim', 'Someone else could take any amount of your USDC.', /token.*\(USDC\)/);
  caught('claim', 'Someone else could take any amount of your usdc.', /token.*\(usdc\)/);
  caught('claim', 'Someone else could take your Bitcoin.', /token.*\(Bitcoin\)/);
  caught('limited', 'This is about your Tether.', /token.*\(Tether\)/);
  passes('claim', 'Someone else could take your Tether.');
  passes('claim', 'You would still pay a little ETH for the network fee.');
});

test('"unlimited" or "everything" for a limited request is caught', () => {
  caught('limited', 'A known service could take any amount of your USDC.', /more is at stake/);
  caught('limited', 'A known service could take all your USDC.', /more is at stake/);
  caught('transfer', 'You could lose everything.', /more is at stake/);
  passes('blind', 'Whoever holds this signature could do anything with your wallet.');
});

// ── Who gets what ───────────────────────────────────────────────────────────

test('swapped roles are caught', () => {
  caught('claim', 'If you confirm, your wallet gets permission to spend USDT.', /you get the permission/);
  caught('permit', 'You will receive permission to use USDC.', /you get the permission/);
  caught('claim', 'If you confirm, you will receive your free USDT.', /comes to you/);
  caught('transfer', 'If you confirm, you will receive 0.01 ETH.', /comes to you/);
  caught('transfer', '0.01 ETH is sent into your wallet.', /comes to you/);
  passes('transfer', 'If you confirm, 0.01 ETH leaves your wallet and goes to 0x9f3a…c21e.');
  passes('claim', 'This gives a stranger access to your wallet’s USDT.');
  passes('transfer', 'You cannot get your ETH back once it is confirmed.');
});

// ── Saying it is safe ───────────────────────────────────────────────────────

test('calling a dangerous or undecodable request safe is caught, however it is phrased', () => {
  const claims = [
    'Signing this cannot harm your funds.',
    'Check the address; this request is safe.',
    'Check the address, this request is safe.',
    'Check the address: it is safe.',
    'Check the address and this is safe.',
    'This is a standard token approval and is safe to confirm.',
    'It looks safe.',
    'This looks like a routine contract call.',
    'It is a common, legitimate kind of request.',
    'There is no risk in confirming it.',
    'There is no danger here.',
    "It's fine to approve.",
    'You can safely confirm this.',
    'You can confirm this request.',
    'Nothing bad will happen.',
    'This will not cost you anything.',
    'You will not lose any money.',
    "It doesn't move your funds.",
    'This is how most dapps work.',
    'The spender is a legitimate service.',
    'This request is not dangerous.',
    "Don't worry about this one.",
    'The contract is trusted.',
    'This works as expected.',
    'This is a standard ERC-20 approval.',
  ];
  for (const text of claims) {
    caught('unknownCall', text, /cannot confirm/);
    caught('claim', text, /cannot confirm/);
  }
  caught('unknownTyped', 'This signature is harmless.', /cannot confirm/);
  caught('blind', 'This signature is harmless.', /cannot confirm/);
});

test('"If you confirm, …" does not switch the safety check off (review 2026-11-16)', () => {
  caught('claim', 'If you confirm, this is safe and nothing will be lost.', /cannot confirm/);
  caught('claim', 'If you confirm, it is a standard approval that most apps use.', /cannot confirm/);
  caught('claim', 'If you confirm, someone else can take any amount of USDT; this is a normal and safe step that apps use.', /cannot confirm/);
  caught('permit', 'If you sign, this is a legitimate and routine permit.', /cannot confirm/);
  caught('permit', 'If you sign this permit, it is harmless because it costs no gas.', /cannot confirm/);
  caught('blind', 'If you sign, it is safe.', /cannot confirm/);
  caught('unknownCall', 'If you confirm, this routine contract call is safe.', /cannot confirm/);
  caught('phish', 'If you confirm, you just log in, which is safe.', /cannot confirm/);
  caught('claim', 'This is not a scam, it is safe and legitimate.', /cannot confirm/);
  caught('claim', 'No worries, the spender is legitimate.', /cannot confirm/);
  caught('claim', "Don't worry, it is safe to approve.", /cannot confirm/);
  caught('claim', 'If you trust this site, this is safe.', /cannot confirm/);
  // A flagged request that is not "danger": "safe" is still not Guardian's word.
  caught('fake', 'This is safe to approve.', /cannot confirm/);
  caught('transfer', 'This is a safe transfer.', /cannot confirm/);
  caught('limited', 'It is safe to approve this.', /cannot confirm/);
});

test('the user is never told they get the permission, in any phrasing', () => {
  caught('claim', "If you confirm, you'll get permission to spend USDT.", /you get the permission/);
  caught('claim', 'If you confirm, you will get unlimited permission to spend USDT.', /you get the permission/);
  caught('claim', 'If you confirm, you are granted permission to spend USDT held by 0x9f3a…c21e.', /you get the permission|owner of the assets/);
  caught('claim', 'If you confirm, your wallet can spend any amount of USDT from 0x9f3a…c21e.', /you get the permission/);
});

test('correct answers found wrongly withheld in the review now pass', () => {
  // Saying how it LOOKS and then "but" concedes; saying it IS standard claims (blind set A, 2026-11-17).
  caught('claim', 'This is a standard token approval, but the spender is an unknown personal wallet, so it could take all of your USDT at any time.', /cannot confirm/);
  passes('permit', 'This request looks like a harmless signature, but it is really an unlimited spending permission for your USDC.');
  passes('claim', 'Although it looks like a normal approval request, a personal wallet would get permission to take any amount of your USDT.');
  passes('claim', 'To be safe, verify who owns the spender address before you continue.');
  passes('claim', 'Approving a personal wallet is a common tactic used by scammers.');
  passes('transfer', 'If that address is wrong, the coins cannot be returned to your wallet.');
  passes('transfer', 'Make sure you get what you are paying for.');
  passes('limited', 'If you confirm, Uniswap Permit2 (0x0000…8ba3), a well-known service, gets permission to take up to 25 USDC out of your wallet.');
  passes('limited', `The spender is ${PERMIT2}, Uniswap Permit2.`);
  passes('limited', 'This is limited to 25 USDC, not an unlimited amount.');
  passes('revoke', 'If you confirm, the permission for 0x9f3a00…00c21e to spend your USDT is removed, so it can no longer take any amount of USDT.');
  passes('signin', 'Signing in only proves you own this wallet; it does not move any ETH or tokens.');
  // On a flagged request the AI may not say what cannot happen, even where
  // it happens to be true: Guardian cannot verify it. The token itself is fine.
  caught('phish', 'It does not move any ETH, but someone could use it to log in to nft-market.example as you.', /cannot confirm/);
  passes('phish', 'Someone could use this signature to log in to nft-market.example as you, even though no ETH is involved.');
  passes('unknownCall', 'This calls an unknown function (0xdeadbeef), so no one can say what it will do.');
  passes('oddAmount', 'If you confirm, about 0.0077 ETH leaves your wallet and goes to 0x9f3a…c21e.');
  caught('oddAmount', 'If you confirm, about 0.0090 ETH leaves your wallet.', /amount/);
  passes('self', 'If you confirm, 0.01 ETH goes to (your own wallet).');
  passes('self', 'If you confirm, 0.01 ETH is sent to your own wallet.');
});

test('harmless numbers in advice pass; invented ones still do not', () => {
  passes('claim', 'Compare the first and last 4 characters of the spender address with the one you expect.');
  passes('claim', '1. Verify who owns the spender address.');
  caught('claim', 'This permission expires in 30 days.', /number/);
  caught('claim', 'Revoke it within 24 hours.', /number/);
});

// The cause of a real failure (2026-11-16): a correct cloud answer was
// withheld as "a number that is not in this request". The model had named
// the site that asked, 127.0.0.1:5179, which the prompt tells it; the checks
// did not know the site, so its digits looked made up. Found from 683
// recorded real answers: the only numbers in them are the request's amounts
// and that site's address.
test('an answer may name the site that asked; a site it was not told is still caught', () => {
  const text = 'Check why the website 127.0.0.1:5179 is asking for unlimited access to your USDT.';
  const sentence = meaning(R.claim, HOST);
  // As it failed: without the site.
  assert.equal(answerChecker(R.claim, sentence, { own: [ME], chainId: 1 }).finish(text).problem, 'a number that is not in this request');
  // As the window runs it now.
  assert.equal(answerChecker(R.claim, sentence, { own: [ME], chainId: 1, host: HOST }).finish(text).problem, null);
  const live = 'ibiti-guardian-chrome.web.app';
  const named = `The site ${live} is asking for unlimited access to your USDT.`;
  assert.equal(answerChecker(R.claim, sentence, { own: [ME], chainId: 1, host: live }).finish(named).problem, null);
  assert.match(
    answerChecker(R.claim, sentence, { own: [ME], chainId: 1, host: live }).finish('The site free-usdt-claim.com is asking for access.').problem,
    /site or name that is not in this request/,
  );
});

// Two real cloud answers that were wrongly withheld (found in 90 runs,
// 2026-11-17): advice starting with "Confirm …" was read as a claim.
test('advice that starts with "Confirm" is advice', () => {
  passes('claim', 'Confirm you are interacting with an official service rather than an unknown website.');
  passes('claim', 'Confirm if the website you are visiting is a legitimate service.');
  caught('claim', 'If you confirm, an official service gets the permission.', /verified/);
});

test('the withheld note never repeats what the model made up', () => {
  const checker = answerChecker(R.transfer, meaning(R.transfer, HOST));
  const out = checker.finish('If you confirm, 5,000,000,000 ETH leaves your wallet.');
  assert.equal(out.problem, 'an amount that is not in this request');
  assert.doesNotMatch(out.problem, /5,000/);
});

test('warnings and advice are not mistaken for "safe"', () => {
  passes('claim', 'This is not safe: a personal wallet could take any amount of USDT.');
  passes('claim', 'This is a common drainer trick.');
  passes('unknownCall', 'Guardian cannot tell what this call does, so it cannot confirm it is safe.');
  passes('claim', 'Verify that the spender address is a legitimate contract for the app you are using.');
  passes('claim', 'Check whether this site is a legitimate service.');
  passes('claim', 'Remember that legitimate apps almost always request approval for smart contracts, not personal wallets.');
  passes('claim', 'Only continue if you are sure the spender is trustworthy.');
  // An ordinary, decoded request may be called ordinary.
  passes('limited', 'This is a common step before a swap.');
  passes('revoke', 'Nothing leaves your wallet.');
  passes('signin', 'This only proves you own the wallet and does not move funds.');
});

// ── Nothing unchecked reaches the screen ────────────────────────────────────

test('only complete, checked sentences are shown while the answer streams', () => {
  const checker = answerChecker(R.claim, meaning(R.claim, HOST));
  assert.deepEqual(checker.push('If you confirm, someone else gets permission'), { shown: '', problem: null, detail: null });
  assert.deepEqual(checker.push('If you confirm, someone else gets permission to take any amount of USDT. They could'), {
    shown: 'If you confirm, someone else gets permission to take any amount of USDT.',
    problem: null,
    detail: null,
  });
  // The second sentence invents an amount: it never appears, and the answer stops.
  const bad = checker.push(
    'If you confirm, someone else gets permission to take any amount of USDT. They could take 900 USDT tomorrow. More',
  );
  assert.equal(bad.shown, 'If you confirm, someone else gets permission to take any amount of USDT.');
  assert.match(bad.detail, /900 USDT/);
  assert.match(checker.finish('anything').detail, /900 USDT/, 'stays withheld');
});

test('a last sentence without a full stop is still checked', () => {
  const checker = answerChecker(R.transfer, meaning(R.transfer, HOST));
  checker.push('If you confirm, 3 ETH leaves your wallet');
  assert.match(checker.finish('If you confirm, 3 ETH leaves your wallet').detail, /3 ETH/);
});

test('an empty answer counts as a failure', () => {
  assert.equal(answerChecker(R.claim).finish('   ').problem, 'nothing');
});

// ── The user's own address never leaves ─────────────────────────────────────

test('the user’s own address is found in every kind of request and scrubbed', () => {
  for (const [name, record] of Object.entries(RECORDS)) assert.deepEqual(ownAddresses(record), [ME], name);
  assert.deepEqual(ownAddresses({ method: 'wallet_sendCalls', params: [{ from: ME, calls: [] }] }), [ME]);
  const text = `Owner ${ME}, again ${ME.toUpperCase().replace('0X', '0x')} and bare ${ME.slice(2)}.`;
  const out = scrubAddresses(text, [ME]);
  assert.ok(!out.toLowerCase().includes(ME.slice(2)), out);
  assert.equal(out.match(/\(your own wallet\)/g).length, 3);
});

test('a self-transfer still checks against the facts', () => {
  const self = analyze(send(ME, '0x', '0x2386f26fc10000'));
  assert.ok(groundTruth(self).hexes.includes(ME));
});
