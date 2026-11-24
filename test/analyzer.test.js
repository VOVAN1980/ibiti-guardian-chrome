import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyzer/index.js';
import { isUndecoded } from '../src/ai/guard.js';
import { DEMO_RECORDS, typedData } from './demo-records.js';

const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const SPENDER = '0x9f3a000000000000000000000000000000c21e00';
const ME = '0x1111111111111111111111111111111111111111';
const MAX = (1n << 256n) - 1n;

const pad = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const uint = (n) => BigInt(n).toString(16).padStart(64, '0');
const call = (selector, ...words) => `${selector}${words.join('')}`;
const tx = (to, data, value) => ({
  method: 'eth_sendTransaction',
  params: [{ from: ME, to, data, ...(value ? { value } : {}) }],
  chainId: 1,
});
const factValue = (result, label) => result.facts.find((f) => f.label === label)?.value;

test('unlimited approve of verified USDT to an unknown spender is danger', () => {
  const r = analyze(tx(USDT, call('0x095ea7b3', pad(SPENDER), uint(MAX))));
  assert.equal(r.kind, 'approve');
  assert.equal(r.risk, 'danger');
  assert.equal(r.headline, 'Unlimited spending permission for USDT');
  assert.equal(factValue(r, 'Amount'), 'Unlimited');
  assert.equal(factValue(r, 'Token'), 'USDT (Tether USD)');
  assert.equal(factValue(r, 'Spender'), SPENDER);
  assert.match(r.reasons[0], /any amount of USDT/);
});

test('limited approve to an unknown spender shows the exact amount and is caution', () => {
  const r = analyze(tx(USDC, call('0x095ea7b3', pad(SPENDER), uint(100_000_000n))));
  assert.equal(r.risk, 'caution');
  assert.equal(r.headline, 'Spending permission for 100 USDC');
  assert.match(r.reasons[0], /up to 100 USDC/);
});

test('approve of zero is a revoke', () => {
  const r = analyze(tx(USDT, call('0x095ea7b3', pad(SPENDER), uint(0))));
  assert.equal(r.kind, 'revoke');
  assert.equal(r.risk, 'info');
});

test('unlimited approve to a known protocol is caution, and names it', () => {
  const r = analyze(tx(USDT, call('0x095ea7b3', pad(PERMIT2), uint(MAX))));
  assert.equal(r.risk, 'caution');
  assert.match(factValue(r, 'Spender'), /Uniswap Permit2/);
});

test('a spender that is a personal wallet is danger even for a small amount', () => {
  const r = analyze({
    ...tx(USDC, call('0x095ea7b3', pad(SPENDER), uint(5_000_000n))),
    enrich: { spenderIsContract: false },
  });
  assert.equal(r.risk, 'danger');
  assert.ok(r.reasons.some((x) => /personal wallet/.test(x)));
});

test('a token that only calls itself USDT is flagged', () => {
  const fake = '0x00000000000000000000000000000000deadbeef';
  const r = analyze({
    ...tx(fake, call('0x095ea7b3', pad(SPENDER), uint(1000n))),
    enrich: { token: { symbol: 'USDT', decimals: 6 } },
  });
  assert.equal(r.risk, 'danger');
  assert.equal(factValue(r, 'Token'), 'USDT (unverified token)');
  assert.ok(r.reasons.some((x) => /not the real USDT/.test(x)));
});

test('setApprovalForAll true is danger, false is a revoke', () => {
  const nft = '0x2222222222222222222222222222222222222222';
  const on = analyze(tx(nft, call('0xa22cb465', pad(SPENDER), uint(1))));
  assert.equal(on.kind, 'approveAll');
  assert.equal(on.risk, 'danger');
  const off = analyze(tx(nft, call('0xa22cb465', pad(SPENDER), uint(0))));
  assert.equal(off.kind, 'revoke');
  assert.equal(off.risk, 'info');
});

test('plain coin transfer shows amount and recipient', () => {
  const r = analyze(tx(SPENDER, '0x', '0x6f05b59d3b20000')); // 0.5 ETH
  assert.equal(r.kind, 'nativeTransfer');
  assert.equal(r.risk, 'caution', 'more than 0.05 ETH: ask the user to check');
  assert.equal(r.headline, 'Send 0.5 ETH');
});

test('A8: a small payment raises no flag; the balance the page reports can only raise it', () => {
  // 0.01 ETH out of 2 ETH (the demo's "Send 0.01 ETH"): the amount is the request's own.
  const r = analyze({ ...tx(SPENDER, '0x', '0x2386f26fc10000'), enrich: { balance: '0x1bc16d674ec80000' } });
  assert.equal(r.risk, 'info');
  assert.equal(r.facts.find((f) => f.label === 'Amount').note, undefined, 'no "less than 1%": a share is said only when it raises the risk');
  assert.deepEqual(r.warnings, []);
  assert.equal(analyze(tx(SPENDER, '0x', '0x2386f26fc10000')).risk, 'info', 'no balance read');
  // 0.05 ETH is the most; one wei more is checked, whatever balance the page reports.
  const at = 5n * 10n ** 16n;
  assert.equal(analyze(tx(SPENDER, '0x', `0x${at.toString(16)}`)).risk, 'info');
  for (const balance of [undefined, `0x${'f'.repeat(64)}`, '0xde0b6b3a7640000000']) {
    assert.equal(analyze({ ...tx(SPENDER, '0x', `0x${(at + 1n).toString(16)}`), enrich: { balance } }).risk, 'caution', String(balance));
  }
  // A quarter or more of the balance is said and raises a small payment; almost all is high risk.
  const quarter = analyze({ ...tx(SPENDER, '0x', '0x2386f26fc10000'), enrich: { balance: '0x8e1bc9bf040000' } }); // 0.01 of 0.04
  assert.equal(quarter.risk, 'caution');
  assert.equal(quarter.facts.find((f) => f.label === 'Amount').note, 'about 25% of your ETH');
  const all = analyze({ ...tx(SPENDER, '0x', '0x2386f26fc10000'), enrich: { balance: '0x2386f26fc10000' } });
  assert.equal(all.risk, 'danger');
  assert.equal(all.facts.find((f) => f.label === 'Amount').note, 'All of your ETH');
  // Above 0.05: a quarter or more is said, and changes nothing below 90 %.
  const half = analyze({ ...tx(SPENDER, '0x', '0xde0b6b3a7640000'), enrich: { balance: '0x1bc16d674ec80000' } });
  assert.equal(half.risk, 'caution');
  assert.equal(half.facts.find((f) => f.label === 'Amount').note, 'about 50% of your ETH');
  // On every network of the registry, test networks too; on one Guardian does not know, or none it can
  // tell (eth_chainId failed), a coin may be worth anything.
  for (const chainId of [56, 137, 8453, 11155111]) assert.equal(analyze({ ...tx(SPENDER, '0x', '0x2386f26fc10000'), chainId }).risk, 'info', String(chainId));
  for (const chainId of [30, 42220, null]) assert.equal(analyze({ ...tx(SPENDER, '0x', '0x2386f26fc10000'), chainId }).risk, 'caution', String(chainId));
  const named = { method: 'eth_sendTransaction', params: [{ from: ME, to: SPENDER, value: '0x2386f26fc10000', chainId: '0x1e' }], chainId: 1 };
  assert.equal(analyze(named).risk, 'caution', 'the network the request names wins');
  // Whatever else raises it still does: a button that says otherwise, a signature for later, a token transfer.
  assert.equal(analyze({ ...tx(SPENDER, '0x', '0x2386f26fc10000'), promise: { button: 'Claim airdrop', ageMs: 300 } }).risk, 'danger');
  assert.equal(analyze({ ...tx(SPENDER, '0x', '0x2386f26fc10000'), method: 'eth_signTransaction' }).risk, 'caution');
  assert.equal(analyze(tx(USDT, call('0xa9059cbb', pad(SPENDER), uint(10_000n)))).risk, 'caution', 'a token’s worth is unknown');
});

test('a payment of nearly the whole balance is danger', () => {
  // 1.95 ETH out of 2 ETH
  const r = analyze({ ...tx(SPENDER, '0x', '0x1b0fcaab20030000'), enrich: { balance: '0x1bc16d674ec80000' } });
  assert.equal(r.risk, 'danger');
  assert.ok(r.reasons.some((x) => /almost all of the ETH/.test(x)));
});

test('a token transfer is judged by its share of the token balance', () => {
  const small = analyze({
    ...tx(USDT, call('0xa9059cbb', pad(SPENDER), uint(5_000_000n))),
    enrich: { tokenBalance: '1000000000' },
  });
  assert.equal(small.risk, 'caution', 'a small share is still a payment out of the wallet');
  const all = analyze({
    ...tx(USDT, call('0xa9059cbb', pad(SPENDER), uint(1_000_000_000n))),
    enrich: { tokenBalance: '1000000000' },
  });
  assert.equal(all.risk, 'danger');
});

test('a limited approval to a known protocol raises no red flag', () => {
  const r = analyze(tx(USDC, call('0x095ea7b3', pad(PERMIT2), uint(25_000_000n))));
  assert.equal(r.risk, 'info');
  assert.equal(r.headline, 'Spending permission for 25 USDC');
});

test('"verified contract" needs the real address on that network, not just the name', () => {
  // The Ethereum USDT address used on BNB Chain is not the BNB Chain USDT.
  const wrongChain = analyze({
    ...tx(USDT, call('0x095ea7b3', pad(SPENDER), uint(1000n))),
    chainId: 56,
    enrich: { token: { symbol: 'USDT', decimals: 6 } },
  });
  const tokenFact = wrongChain.facts.find((f) => f.label === 'Token');
  assert.equal(tokenFact.note, undefined);
  assert.equal(tokenFact.value, 'USDT (unverified token)');
  assert.equal(wrongChain.risk, 'danger');
});

test('token transfer decodes recipient and amount', () => {
  const r = analyze(tx(USDT, call('0xa9059cbb', pad(SPENDER), uint(2_500_000n))));
  assert.equal(r.kind, 'transfer');
  assert.equal(r.headline, 'Send 2.5 USDT');
  assert.equal(factValue(r, 'To'), SPENDER);
});

test('unknown selector is caution and says it cannot be decoded', () => {
  const r = analyze(tx(SPENDER, '0xdeadbeef' + uint(1)));
  assert.equal(r.kind, 'contractCall');
  assert.equal(r.risk, 'caution');
  assert.equal(factValue(r, 'Function'), '0xdeadbeef');
});

test('eth_sign is always danger', () => {
  const r = analyze({ method: 'eth_sign', params: [ME, '0x' + 'ab'.repeat(32)], chainId: 1 });
  assert.equal(r.risk, 'danger');
});

test('personal_sign of readable text is info and keeps the text', () => {
  const hex = '0x' + Buffer.from('Hello, sign me in', 'utf8').toString('hex');
  const r = analyze({ method: 'personal_sign', params: [hex, ME], chainId: 1 });
  assert.equal(r.risk, 'info');
  assert.equal(r.message, 'Hello, sign me in');
});

test('personal_sign of binary data is caution', () => {
  const r = analyze({ method: 'personal_sign', params: ['0x' + '00ff'.repeat(16), ME], chainId: 1 });
  assert.equal(r.risk, 'caution');
});

test('sign-in message for another domain is danger', () => {
  const text = 'nft-market.example wants you to sign in with your Ethereum account:\n' + ME + '\n\nNonce: 1';
  const hex = '0x' + Buffer.from(text, 'utf8').toString('hex');
  const bad = analyze({ method: 'personal_sign', params: [hex, ME], origin: 'https://free-airdrop.example' });
  assert.equal(bad.kind, 'signIn');
  assert.equal(bad.risk, 'danger');
  const ok = analyze({ method: 'personal_sign', params: [hex, ME], origin: 'https://nft-market.example' });
  assert.equal(ok.risk, 'info');
});

test('personal_sign picks the message as MetaMask does: the account written "0X…" first is not the message', () => {
  const text = 'app.evil.example wants you to sign in with your Ethereum account:\n' + ME + '\n\nNonce: 1';
  const hex = '0x' + Buffer.from(text, 'utf8').toString('hex');
  const upper = '0X' + ME.slice(2);
  // MetaMask takes the first parameter as the account by its length alone.
  const r = analyze({ method: 'personal_sign', params: [upper, hex], origin: 'https://site.example', chainId: 1 });
  assert.equal(r.risk, 'danger');
  assert.equal(r.headline, 'Sign-in request for a different site');
  assert.equal(r.message, text);
  // A 32-byte hash signed the same way is never harmless.
  const hash = analyze({ method: 'personal_sign', params: [upper, '0x' + 'ab'.repeat(32)], origin: 'https://site.example', chainId: 1 });
  assert.notEqual(hash.risk, 'info');
  assert.equal(hash.headline, 'Signature for unreadable data');
  // Readable text with the account in that form: picked the same way, and checked.
  const odd = analyze({ method: 'personal_sign', params: [upper, '0x' + Buffer.from('Hello').toString('hex')], chainId: 1 });
  assert.equal(odd.message, 'Hello');
  assert.equal(odd.risk, 'caution');
  assert.ok(odd.reasons.some((x) => /not written the standard way/.test(x)));
  // Either standard order reads the same message as before, with no note.
  const hello = '0x' + Buffer.from('Hello').toString('hex');
  for (const params of [[hello, ME], [ME, hello]]) {
    const plain = analyze({ method: 'personal_sign', params, chainId: 1 });
    assert.equal(plain.risk, 'info', JSON.stringify(params));
    assert.equal(plain.message, 'Hello');
    assert.ok(!plain.reasons.some((x) => /not written the standard way/.test(x)));
  }
  // A message of an address's length, with the account second, is still the message.
  const fortyTwo = 'Sign this to prove you own the wallet: ok.';
  assert.equal(fortyTwo.length, 42);
  assert.equal(analyze({ method: 'personal_sign', params: [fortyTwo, ME], chainId: 1 }).message, fortyTwo);
});

test('EIP-2612 permit with unlimited value is danger and notes it is off-chain', () => {
  const typed = typedData(
    'Permit',
    { name: 'USD Coin', chainId: 1, verifyingContract: USDC },
    { owner: ME, spender: SPENDER, value: MAX.toString(), nonce: 0, deadline: 99999999999 },
  );
  const r = analyze({ method: 'eth_signTypedData_v4', params: [ME, JSON.stringify(typed)], chainId: 1 });
  assert.equal(r.kind, 'permit');
  assert.equal(r.risk, 'danger');
  assert.equal(factValue(r, 'Amount'), 'Unlimited');
  assert.equal(factValue(r, 'Valid until'), 'More than a year from now');
  assert.ok(r.reasons.some((x) => /costs no gas/.test(x)));
});

test('Permit2 PermitSingle is decoded', () => {
  const typed = typedData(
    'PermitSingle',
    { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
    {
      details: { token: USDT, amount: ((1n << 160n) - 1n).toString(), expiration: 1893456000, nonce: 0 },
      spender: SPENDER,
      sigDeadline: 1893456000,
    },
  );
  const r = analyze({ method: 'eth_signTypedData_v4', params: [ME, typed], chainId: 1 });
  assert.equal(r.kind, 'permit2');
  assert.equal(r.risk, 'danger');
  assert.equal(factValue(r, 'Token'), 'USDT (Tether USD)');
  assert.equal(factValue(r, 'Amount'), 'Unlimited');
});

test('an amount no one holds is unlimited, not only the largest number', () => {
  const ONE_INCH = '0x111111125421ca6dc452d289314280a0f8842a65';
  const unlimited = (r, what) => {
    assert.equal(r.risk, 'danger', what);
    assert.equal(factValue(r, 'Amount'), 'Unlimited', what);
    assert.ok(r.warnings.some((x) => /any amount of USDC/.test(x)), what);
  };
  for (const amount of [(1n << 200n) - 1n, 10n ** 30n, 10n ** 18n]) {
    const r = analyze(tx(USDC, call('0x095ea7b3', pad(SPENDER), uint(amount))));
    unlimited(r, `approve ${amount}`);
    assert.equal(r.headline, 'Unlimited spending permission for USDC');
  }
  // An EIP-2612 permit, and a Permit2 allowance one below its largest amount.
  const permit = typedData(
    'Permit',
    { name: 'USD Coin', chainId: 1, verifyingContract: USDC },
    { owner: ME, spender: SPENDER, value: (10n ** 30n).toString(), nonce: 0, deadline: 99999999999 },
  );
  unlimited(analyze({ method: 'eth_signTypedData_v4', params: [ME, JSON.stringify(permit)], chainId: 1 }), 'permit 10^30');
  const single = typedData(
    'PermitSingle',
    { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
    {
      details: { token: USDC, amount: ((1n << 160n) - 2n).toString(), expiration: 1893456000, nonce: 0 },
      spender: SPENDER,
      sigDeadline: 1893456000,
    },
  );
  unlimited(analyze({ method: 'eth_signTypedData_v4', params: [ME, JSON.stringify(single)], chainId: 1 }), 'Permit2 2^160 - 2');
  // A token the registry does not know, with no decimals read: from 10^30 base units on.
  const unknown = '0x00000000000000000000000000000000deadbeef';
  for (const amount of [1n << 128n, 10n ** 30n]) {
    const big = analyze(tx(unknown, call('0x095ea7b3', pad(SPENDER), uint(amount))));
    assert.equal(big.risk, 'danger', String(amount));
    assert.equal(factValue(big, 'Amount'), 'Unlimited', String(amount));
  }
  assert.equal(analyze(tx(unknown, call('0x095ea7b3', pad(SPENDER), uint(10n ** 30n - 1n)))).risk, 'caution');
  // Ordinary amounts stay as they were.
  const swap = analyze(tx(USDC, call('0x095ea7b3', pad(ONE_INCH), uint(1_000_000_000n))));
  assert.equal(swap.risk, 'info');
  assert.equal(factValue(swap, 'Amount'), '1,000 USDC');
  const other = analyze(tx(USDC, call('0x095ea7b3', pad(SPENDER), uint(1_000_000_000n))));
  assert.equal(other.risk, 'caution');
  assert.equal(other.headline, 'Spending permission for 1,000 USDC');
  // Just under a trillion USDC is still an amount.
  assert.equal(factValue(analyze(tx(USDC, call('0x095ea7b3', pad(SPENDER), uint(10n ** 18n - 1n)))), 'Amount'), '999,999,999,999.999999 USDC');
});

test('unrecognised typed data is caution', () => {
  const typed = { primaryType: 'Mystery', domain: { name: 'Some App' }, message: { a: 1 } };
  const r = analyze({ method: 'eth_signTypedData_v4', params: [ME, JSON.stringify(typed)] });
  assert.equal(r.kind, 'typedData');
  assert.equal(r.risk, 'caution');
});

test('batch takes the highest risk of its parts', () => {
  const r = analyze({
    method: 'wallet_sendCalls',
    params: [
      {
        chainId: '0x1',
        calls: [
          { to: USDT, data: call('0xa9059cbb', pad(SPENDER), uint(1_000_000n)) },
          { to: USDT, data: call('0x095ea7b3', pad(SPENDER), uint(MAX)) },
        ],
      },
    ],
  });
  assert.equal(r.kind, 'batch');
  assert.equal(r.risk, 'danger');
  assert.equal(r.facts.length, 2);
});

test('coins sent along with a token call are a fact and a high risk, even on a revoke', () => {
  const r = analyze(tx(USDT, call('0x095ea7b3', pad(SPENDER), uint(0)), '0xde0b6b3a7640000'));
  assert.equal(r.kind, 'revoke');
  assert.equal(r.risk, 'danger');
  assert.equal(factValue(r, 'Also sends'), '1 ETH');
  assert.match(r.reasons[0], /also sends 1 ETH to the contract/);
  assert.equal(r.subject.coins, '1 ETH');
  // The same for an approval.
  const a = analyze(tx(USDC, call('0x095ea7b3', pad(PERMIT2), uint(1_000_000n)), '0x1'));
  assert.equal(a.risk, 'danger');
  assert.ok(factValue(a, 'Also sends'));
});

test('increaseAllowance says "more": it adds to what the spender may already move', () => {
  const r = analyze(tx(USDC, call('0x39509351', pad(SPENDER), uint(5_000_000n))));
  assert.equal(r.headline, 'Extra spending permission for 5 USDC');
  assert.equal(factValue(r, 'Amount'), '5 USDC more');
  assert.match(r.reasons[0], /up to 5 USDC more/);
});

test('a Permit2 allowance says when it ends', () => {
  const soon = Math.floor(Date.now() / 1000) + 7 * 86400;
  const r = analyze(tx(PERMIT2, call('0x87517c45', pad(USDC), pad(SPENDER), uint(10_000_000n), uint(soon))));
  assert.match(factValue(r, 'Permission ends'), /^\d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
  assert.ok(r.reasons.some((x) => /stays active until \d{4}-.* UTC, unless you revoke it sooner/.test(x)));
  assert.ok(!r.reasons.includes('The permission stays active until you revoke it.'));
  const now = analyze(tx(PERMIT2, call('0x87517c45', pad(USDC), pad(SPENDER), uint(10_000_000n), uint(0))));
  assert.equal(factValue(now, 'Permission ends'), 'In the same transaction only');
  // An ordinary approval has no end time.
  assert.equal(factValue(analyze(tx(USDT, call('0x095ea7b3', pad(SPENDER), uint(MAX)))), 'Permission ends'), undefined);
});

test('a Permit2 transfer signature is one-time: no permission stays behind', () => {
  const typed = typedData(
    'PermitTransferFrom',
    { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
    { permitted: { token: USDC, amount: '800000000' }, spender: SPENDER, nonce: 1, deadline: 4102444800 },
  );
  const r = analyze({ method: 'eth_signTypedData_v4', params: [ME, JSON.stringify(typed)], chainId: 1 });
  assert.equal(r.kind, 'permit2');
  assert.equal(r.subject.action, 'permitTransfer');
  assert.equal(r.headline, 'Signature that lets someone take up to 800 USDC');
  assert.match(r.reasons[0], /once, until this signature expires/);
  assert.ok(!r.reasons.some((x) => /until you revoke/.test(x)));
  assert.equal(factValue(r, 'Valid until'), 'More than a year from now');
});

test('a Permit2 batch keeps every token’s reasons, not only the first one’s', () => {
  const unknown = '0x00000000000000000000000000000000deadbeef';
  const typed = typedData(
    'PermitBatch',
    { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
    {
      details: [
        { token: USDC, amount: '1000000', expiration: 4102444800, nonce: 0 },
        { token: unknown, amount: ((1n << 160n) - 1n).toString(), expiration: 4102444800, nonce: 0 },
      ],
      spender: SPENDER,
      sigDeadline: 4102444800,
    },
  );
  const r = analyze({ method: 'eth_signTypedData_v4', params: [ME, JSON.stringify(typed)], chainId: 1 });
  assert.equal(r.risk, 'danger');
  assert.ok(r.reasons.some((x) => /up to 1 USDC/.test(x)), r.reasons.join(' | '));
  assert.ok(r.reasons.some((x) => /any amount of this token/.test(x)), r.reasons.join(' | '));
  assert.equal(new Set(r.reasons).size, r.reasons.length, 'no reason twice');
  assert.equal(factValue(r, 'Permissions end'), 'More than a year from now');
  assert.ok(factValue(r, 'Spender'));
});

test('transferFrom says whose tokens move', () => {
  const other = '0x3333333333333333333333333333333333333333';
  const theirs = analyze(tx(USDT, call('0x23b872dd', pad(other), pad(SPENDER), uint(1_000_000n))));
  assert.equal(theirs.headline, 'Move 1 USDT from another address');
  assert.equal(theirs.subject.fromSelf, false);
  assert.equal(theirs.facts.find((f) => f.label === 'From').note, 'not this wallet');
  const mine = analyze(tx(USDT, call('0x23b872dd', pad(ME), pad(SPENDER), uint(1_000_000n))));
  assert.equal(mine.headline, 'Send 1 USDT');
  assert.equal(mine.subject.fromSelf, true);
});

test('a payment to the wallet’s own address says so; an account only the page reported is not "this wallet"', () => {
  const r = analyze(tx(ME, '0x', '0x1'));
  assert.equal(r.subject.toSelf, true);
  assert.equal(r.facts.find((f) => f.label === 'To').note, 'an address of this wallet');
  // eth_accounts is read through the page's provider: a page can list the attacker.
  const other = analyze({ ...tx(SPENDER, '0x', '0x1'), enrich: { accounts: [ME, SPENDER] } });
  assert.equal(other.subject.toSelf, false);
  assert.equal(other.facts.find((f) => f.label === 'To').note, undefined);
});

test('a batch line says with whom', () => {
  const r = analyze({
    method: 'wallet_sendCalls',
    params: [{ chainId: '0x1', calls: [{ to: USDT, data: call('0xa9059cbb', pad(SPENDER), uint(1_000_000n)) }] }],
  });
  assert.equal(factValue(r, 'Action 1'), 'Send 1 USDT, to 0x9f3a…1e00');
});

// ── Security review of 2026-11-21 ──────────────────────────────────────────

const ATTACKER = '0xbad0000000000000000000000000000000000bad';
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
const CLAIM = { button: 'Claim airdrop', title: 'Airdrop', heading: 'Claim your tokens', ageMs: 500 };
const signTyped = (typed, extra = {}) => ({
  method: 'eth_signTypedData_v4',
  params: [ME, JSON.stringify(typed)],
  chainId: 1,
  origin: 'https://claim-airdrop.example',
  ...extra,
});
const unreadable = (r, name) => {
  assert.equal(r.kind, 'typedData', name);
  assert.equal(r.risk, 'danger', name);
  assert.equal(r.headline, 'Token permission Guardian cannot read', name);
  assert.ok(r.warnings.length > 0, name);
};
const daiPermit = (message) =>
  typedData('Permit', { name: 'Dai Stablecoin', version: '1', chainId: 1, verifyingContract: DAI }, message, 'DaiPermit');
const DAI_MESSAGE = { holder: ME, spender: ATTACKER, nonce: 0, expiry: 1900000000, allowed: true };
const take = (message) => typedData('PermitTransferFrom', { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 }, message);
const TAKE_ALL = { permitted: { token: WETH, amount: MAX.toString() }, spender: ATTACKER, nonce: 1, deadline: 1900000000 };

test('RA-3: a DAI permit is read through its types: allowed true is unlimited, false is a revoke', () => {
  const all = analyze(signTyped(daiPermit(DAI_MESSAGE), { promise: CLAIM }));
  assert.equal(all.risk, 'danger');
  assert.equal(all.headline, 'Unlimited spending permission for DAI');
  assert.equal(all.subject.promise.clash, true);
  const off = analyze(signTyped(daiPermit({ ...DAI_MESSAGE, allowed: false })));
  assert.equal(off.kind, 'revoke');
  assert.equal(off.risk, 'info');
});

test('RA-3: a key the wallet does not sign, or an "allowed" that is not true or false, cannot be read', () => {
  // The wallet signs only the declared fields: an extra value:"0" does not make it a revoke.
  unreadable(analyze(signTyped(daiPermit({ ...DAI_MESSAGE, value: '0' }), { promise: CLAIM })), 'extra value');
  for (const allowed of [1, 0, 'false', 'true', null]) {
    unreadable(analyze(signTyped(daiPermit({ ...DAI_MESSAGE, allowed }))), `allowed ${JSON.stringify(allowed)}`);
  }
  const missing = { ...DAI_MESSAGE };
  delete missing.expiry;
  unreadable(analyze(signTyped(daiPermit(missing))), 'missing field');
});

test('RA-3: a Permit2 signature is read by its primary type, never by a decoy key', () => {
  const honest = analyze(signTyped(take(TAKE_ALL)));
  assert.equal(honest.risk, 'danger');
  assert.equal(honest.headline, 'Signature that lets someone take any amount of WETH');
  // A decoy "details" for 0.000001 USDC is not part of what is signed.
  const decoy = { ...TAKE_ALL, details: { token: USDC, amount: '1', expiration: 0, nonce: 0 } };
  unreadable(analyze(signTyped(take(decoy))), 'decoy details');
  unreadable(analyze(signTyped(take({ ...TAKE_ALL, details: [] }))), 'empty details');
  // An extra key inside the signed struct too.
  unreadable(analyze(signTyped(take({ ...TAKE_ALL, permitted: { ...TAKE_ALL.permitted, extra: 1 } }))), 'nested extra');
  // A witness transfer reads its permitted tokens, whatever the witness type of the app is.
  const witness = analyze(
    signTyped(
      typedData('PermitWitnessTransferFrom', { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 }, { ...TAKE_ALL, witness: {} }),
    ),
  );
  assert.equal(witness.subject.action, 'permitTransfer');
  assert.equal(witness.risk, 'danger');
});

test('RA-3: missing, empty or non-standard types, and values wallets read differently, are high risk', () => {
  const message = { owner: ME, spender: ATTACKER, value: '0', nonce: 0, deadline: 1900000000 };
  const domain = { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC };
  const good = typedData('Permit', domain, message);
  assert.equal(analyze(signTyped(good)).kind, 'revoke', 'a real EIP-2612 permit of 0 is a revoke');
  const { types, ...noTypes } = good;
  unreadable(analyze(signTyped(noTypes)), 'no types');
  unreadable(analyze(signTyped({ ...good, types: {} })), 'empty types');
  // EIP-4494 (an NFT permit) has the same name and other fields: read as such (B5 below), but not in another order.
  const nftTypes = {
    Permit: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'spender', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  };
  const nft = { ...good, types: nftTypes, message: { spender: ATTACKER, tokenId: '0', nonce: 0, deadline: 1900000000 } };
  unreadable(analyze(signTyped(nft)), 'EIP-4494, fields in another order');
  // A struct named like a plain type changes how the wallet encodes that field.
  unreadable(analyze(signTyped({ ...good, types: { ...types, uint256: [{ name: 'x', type: 'uint8' }] } })), 'uint256 redefined');
  for (const value of ['1e3', '-1', ' 1', '0X10', (1n << 256n).toString(), 1.5]) {
    unreadable(analyze(signTyped(typedData('Permit', domain, { ...message, value }))), `value ${value}`);
  }
  // A Permit2 amount above uint160.
  const single = typedData('PermitSingle', { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 }, {
    details: { token: USDC, amount: (1n << 160n).toString(), expiration: 1900000000, nonce: 0 },
    spender: ATTACKER,
    sigDeadline: 1900000000,
  });
  unreadable(analyze(signTyped(single)), 'amount over uint160');
  // Any other type signed for the Permit2 contract.
  unreadable(analyze(signTyped({ ...single, primaryType: 'Mystery' })), 'unknown Permit2 type');
});

test('RA-11: a DAI permit with expiry 0 never expires', () => {
  const r = analyze(signTyped(daiPermit({ ...DAI_MESSAGE, expiry: 0 })));
  assert.equal(factValue(r, 'Valid until'), 'Never expires');
  assert.equal(r.facts.find((f) => f.label === 'Valid until').tone, 'caution');
  // EIP-2612 has no such rule: 0 is long past.
  const message = { owner: ME, spender: ATTACKER, value: '1', nonce: 0, deadline: 0 };
  const eip = analyze(signTyped(typedData('Permit', { name: 'USD Coin', chainId: 1, verifyingContract: USDC }, message)));
  assert.equal(factValue(eip, 'Valid until'), '1970-01-01 00:00 UTC');
});

test('RA-12: bulk marketplace orders say their items cannot be shown, and a claim button over them clashes', () => {
  for (const primaryType of ['BulkOrder', 'Root']) {
    const r = analyze(signTyped({ types: {}, primaryType, domain: { name: 'Seaport' }, message: { tree: [] } }, { promise: CLAIM }));
    assert.equal(r.kind, 'order', primaryType);
    assert.equal(r.subject.action, 'marketOrder', primaryType);
    assert.match(factValue(r, 'Items'), /cannot show their items/, primaryType);
    assert.equal(r.subject.promise.clash, true, primaryType);
    assert.equal(r.risk, 'danger', primaryType);
    assert.equal(analyze(signTyped({ types: {}, primaryType, domain: {}, message: {} })).risk, 'caution', primaryType);
  }
});

test('RA-4: only the standard 0x-hex form is read; anything else cannot be read, never "empty" or "deploy"', () => {
  const approve = call('0x095ea7b3', pad(ATTACKER), uint(MAX));
  const send = (fields) => analyze({ method: 'eth_sendTransaction', params: [{ from: ME, ...fields }], chainId: 1, promise: CLAIM });
  const malformed = (r, name) => {
    assert.equal(r.kind, 'malformed', name);
    assert.equal(r.risk, 'danger', name);
    assert.notEqual(r.headline, 'Empty transaction', name);
    assert.ok(r.warnings.length > 0, name);
  };
  assert.equal(send({ to: USDT, data: approve }).headline, 'Unlimited spending permission for USDT');
  malformed(send({ to: USDT, data: approve.slice(2) }), 'data without 0x');
  malformed(send({ to: USDT, data: `0X${approve.slice(2)}` }), 'data with 0X');
  malformed(send({ to: USDT, data: `${approve}0` }), 'odd-length data');
  malformed(send({ to: USDT.slice(2), data: approve }), 'to without 0x');
  malformed(send({ to: '', data: approve }), 'empty to');
  malformed(send({ to: ATTACKER, value: '9000000000000000' }), 'decimal value');
  malformed(send({ to: ATTACKER, value: 'de0b6b3a7640000' }), 'hex value without 0x');
  malformed(send({ to: ATTACKER, value: 1000 }), 'number value');
  malformed(send({ to: ATTACKER, value: `0x1${'0'.repeat(64)}` }), 'value over 256 bits');
  malformed(send({ to: USDT, data: '0x', input: approve }), 'data and input differ');
  malformed(send({ to: USDT, data: approve, input: '0x' }), 'input and data differ');
  // The same call data twice, or only in "input": read as usual.
  assert.equal(send({ to: USDT, data: approve, input: approve.toUpperCase().replace('0X', '0x') }).kind, 'approve');
  assert.equal(send({ to: USDT, input: approve }).kind, 'approve');
  // Empty is empty; no "to" is still a deployment.
  assert.equal(send({ to: ATTACKER, data: '', value: '0x' }).headline, 'Empty transaction');
  assert.equal(send({ data: '0x6080' }).kind, 'deploy');
  // The same in a batch.
  const calls = [{ to: USDT, data: approve.slice(2) }];
  const batch = analyze({ method: 'wallet_sendCalls', params: [{ chainId: '0x1', from: ME, calls }] });
  assert.equal(batch.risk, 'danger');
  assert.equal(batch.parts[0].kind, 'malformed');
  assert.equal(analyze({ method: 'wallet_sendCalls', params: [{ chainId: '0x1', calls: [null] }] }).parts[0].kind, 'malformed');
});

test('RA-10: EIP-7702 delegation, an unknown transaction type or field is high risk, never an empty transaction', () => {
  const r = analyze(tx(ME, '0x'));
  assert.equal(r.headline, 'Empty transaction', 'a real empty transaction');
  const delegate = analyze({
    method: 'eth_sendTransaction',
    params: [{ from: ME, to: ME, type: '0x4', authorizationList: [{ address: ATTACKER, chainId: '0x1', nonce: '0x0' }] }],
    chainId: 1,
  });
  assert.equal(delegate.kind, 'delegation');
  assert.equal(delegate.risk, 'danger');
  assert.equal(factValue(delegate, 'Delegate to'), ATTACKER);
  assert.ok(delegate.warnings.length > 0);
  for (const fields of [{ type: '0x4' }, { authorizationList: [] }, { authorizationList: 'x' }]) {
    const d = analyze({ method: 'eth_sendTransaction', params: [{ from: ME, to: ME, ...fields }] });
    assert.equal(d.kind, 'delegation', JSON.stringify(fields));
  }
  for (const fields of [{ type: '0x3' }, { type: 3 }, { type: '2' }, { customData: { paymasterParams: {} } }, { blobs: ['0x00'] }]) {
    const u = analyze({ method: 'eth_sendTransaction', params: [{ from: ME, to: ME, ...fields }] });
    assert.equal(u.kind, 'malformed', JSON.stringify(fields));
    assert.equal(u.risk, 'danger', JSON.stringify(fields));
  }
  // The usual fields change nothing.
  const fields = {
    type: '0x2',
    gas: '0x5208',
    maxFeePerGas: '0x1',
    maxPriorityFeePerGas: '0x1',
    nonce: '0x1',
    accessList: [],
    chainId: '0x1',
    gasPrice: null,
  };
  const usual = analyze({ method: 'eth_sendTransaction', params: [{ from: ME, to: USDT, data: call('0x095ea7b3', pad(PERMIT2), uint(1n)), ...fields }] });
  assert.equal(usual.kind, 'approve');
});

test('RA-5: approve(spender, 0) is a revoke only on a token the registry knows; elsewhere it may be NFT #0', () => {
  const zero = call('0x095ea7b3', pad(ATTACKER), uint(0));
  const nft = analyze({ ...tx(BAYC, zero), enrich: { token: { symbol: 'BAYC' }, spenderIsContract: false }, promise: CLAIM });
  assert.equal(nft.kind, 'approve');
  assert.equal(nft.risk, 'danger', 'a claim button over what may give item #0 away');
  assert.match(nft.headline, /item #0/);
  assert.ok(nft.reasons.some((x) => /item #0/.test(x)));
  assert.equal(nft.subject.promise.clash, true);
  assert.equal(
    nft.warnings[0],
    'The button you pressed said “Claim airdrop”, an offer to receive something, but this request may give someone your item #0, if this contract is an NFT collection.',
  );
  const quiet = analyze({ ...tx(BAYC, zero), enrich: { spenderIsContract: true } });
  assert.equal(quiet.risk, 'caution');
  // The registry's token: a revoke, as before. Zero to no one clears either.
  assert.equal(analyze(tx(USDT, zero)).kind, 'revoke');
  assert.equal(analyze(tx(BAYC, call('0x095ea7b3', pad('0x0'), uint(0)))).kind, 'revoke');
  // Decimals the page reports do not make it a token.
  assert.notEqual(analyze({ ...tx(BAYC, zero), enrich: { token: { symbol: 'X', decimals: 18 } } }).risk, 'info');
  // In a batch too.
  const batch = analyze({ method: 'wallet_sendCalls', params: [{ chainId: '0x1', from: ME, calls: [{ to: BAYC, data: zero }] }] });
  assert.notEqual(batch.risk, 'info');
});

test('RA-6 / F7: a sign-in from a site Guardian cannot identify is never "no red flags"', () => {
  const text = `app.uniswap.org wants you to sign in with your Ethereum account:\n${ME}\n\nNonce: 1`;
  const hex = '0x' + Buffer.from(text, 'utf8').toString('hex');
  for (const origin of ['null', '', 'data:text/html,x', 'about:blank', 'blob:https://evil.example/x', 'chrome-extension://abc', undefined]) {
    const r = analyze({ method: 'personal_sign', params: [hex, ME], origin });
    assert.equal(r.kind, 'signIn', String(origin));
    assert.equal(r.risk, 'caution', String(origin));
    assert.equal(r.headline, 'Sign-in request from a site Guardian cannot identify', String(origin));
    assert.equal(r.subject.unknownSite, true);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /cannot tell which site asked/);
  }
  assert.equal(analyze({ method: 'personal_sign', params: [hex, ME], origin: 'https://app.uniswap.org' }).risk, 'info');
  assert.equal(analyze({ method: 'personal_sign', params: [hex, ME], origin: 'https://evil.example' }).risk, 'danger');
});

test('F5 / F4 / RA-2: a balance and accounts the page reports never make a drain look harmless', () => {
  // The page answers eth_getBalance with a huge number and lists the attacker as an account.
  const forged = { accounts: [ME, ATTACKER], balance: `0x${'f'.repeat(64)}` };
  const r = analyze({ ...tx(ATTACKER, '0x', '0xde0b6b3a7640000'), enrich: forged });
  assert.equal(r.risk, 'caution', 'never "No red flags found"');
  assert.equal(factValue(r, 'Amount'), '1 ETH');
  assert.equal(r.facts.find((f) => f.label === 'Amount').note, undefined, 'no "less than 1%"');
  assert.equal(r.facts.find((f) => f.label === 'To').note, undefined, 'not "an address of this wallet"');
  assert.equal(r.subject.toSelf, false);
  // The honest balance still raises it.
  assert.equal(analyze({ ...tx(ATTACKER, '0x', '0xde0b6b3a7640000'), enrich: { balance: '0xde0b6b3a7640000' } }).risk, 'danger');
  // The same for a token.
  const drain = call('0xa9059cbb', pad(ATTACKER), uint(1_000_000_000_000n));
  const token = analyze({ ...tx(USDT, drain), enrich: { ...forged, tokenBalance: `0x${'f'.repeat(64)}` } });
  assert.equal(token.risk, 'caution');
  assert.equal(token.subject.toSelf, false);
  // Tokens taken from an account the page reported, or with no account named, are never "not this wallet".
  const fromReported = analyze({ ...tx(USDT, call('0x23b872dd', pad(ATTACKER), pad(SPENDER), uint(1n))), enrich: { accounts: [ME, ATTACKER] } });
  assert.equal(fromReported.subject.fromSelf, true);
  assert.equal(fromReported.facts.find((f) => f.label === 'From').note, undefined);
  const pull = call('0x23b872dd', pad(ME), pad(ATTACKER), uint(1n));
  const noFrom = analyze({ method: 'eth_sendTransaction', params: [{ to: USDT, data: pull }], chainId: 1 });
  assert.equal(noFrom.subject.fromSelf, true);
  assert.equal(noFrom.headline, 'Send 0.000001 USDT');
});

test('F4 / RA-2 / A9: a test network or one Guardian does not know, only the page named, is shown as unconfirmed', () => {
  const note = (r) => r.facts.find((f) => f.label === 'Network').note;
  // A main network the page names is shown plainly: that claim could not lower anyone's concern.
  for (const [chainId, name] of [[1, 'Ethereum'], [56, 'BNB Chain'], [137, 'Polygon'], [42161, 'Arbitrum'], [8453, 'Base'], [10, 'Optimism']]) {
    const r = analyze({ ...tx(SPENDER, '0x', '0x1'), chainId });
    assert.equal(factValue(r, 'Network'), name);
    assert.equal(note(r), undefined, name);
  }
  // "It's only a testnet", or a network Guardian does not know: unconfirmed.
  for (const chainId of [11155111, 97, 84532, 42220, 999999]) {
    assert.equal(note(analyze({ ...tx(SPENDER, '0x', '0x1'), chainId })), 'unconfirmed', String(chainId));
    assert.equal(note(analyze({ ...tx(USDT, call('0x095ea7b3', pad(SPENDER), uint(MAX))), chainId })), 'unconfirmed', String(chainId));
  }
  // The request naming the test network itself confirms it.
  const sepolia = analyze({ method: 'eth_sendTransaction', params: [{ from: ME, to: SPENDER, value: '0x1', chainId: '0xaa36a7' }], chainId: 11155111 });
  assert.equal(factValue(sepolia, 'Network'), 'Sepolia testnet');
  assert.equal(note(sepolia), undefined);
  const named = analyze({ method: 'eth_sendTransaction', params: [{ from: ME, to: SPENDER, value: '0x1', chainId: '0x1' }], chainId: 1 });
  assert.equal(named.facts.find((f) => f.label === 'Network').note, undefined);
  // The network of the request wins over what the page says.
  const other = analyze({ method: 'eth_sendTransaction', params: [{ from: ME, to: SPENDER, value: '0x1', chainId: '0x1' }], chainId: 11155111 });
  assert.equal(factValue(other, 'Network'), 'Ethereum');
  // A signature names its network in its domain.
  const message = { owner: ME, spender: ATTACKER, value: '1', nonce: 0, deadline: 1900000000 };
  const permit = analyze(signTyped(typedData('Permit', { name: 'USD Coin', chainId: 1, verifyingContract: USDC }, message), { chainId: 11155111 }));
  assert.equal(factValue(permit, 'Network'), 'Ethereum');
  assert.equal(permit.facts.find((f) => f.label === 'Network').note, undefined);
  // No network at all: nothing to confirm.
  assert.equal(analyze({ ...tx(SPENDER, '0x', '0x1'), chainId: null }).facts.find((f) => f.label === 'Network').note, undefined);
});

test('F4 / RA-2: decimals an unregistered token reports are marked unverified', () => {
  const unknown = '0x7777777777777777777777777777777777777777';
  const enrich = { token: { symbol: 'WBTC', decimals: 36 } };
  const r = analyze({ ...tx(unknown, call('0xa9059cbb', pad(ATTACKER), uint(10n ** 10n))), enrich });
  assert.equal(r.facts.find((f) => f.label === 'Amount').note, 'unverified decimals');
  assert.equal(factValue(r, 'Token'), 'WBTC (unverified token)');
  const a = analyze({ ...tx(unknown, call('0x095ea7b3', pad(ATTACKER), uint(10n ** 10n))), enrich });
  assert.equal(a.facts.find((f) => f.label === 'Amount').note, 'unverified decimals');
  // The decimals of a registered token are its own.
  assert.equal(analyze(tx(USDC, call('0x095ea7b3', pad(SPENDER), uint(1n)))).facts.find((f) => f.label === 'Amount').note, undefined);
});

test('F8: eth_signTransaction is read like a transaction and says the site sends it later', () => {
  const data = call('0x095ea7b3', pad(PERMIT2), uint(25_000_000n));
  const sent = analyze(tx(USDC, data));
  const signed = analyze({ ...tx(USDC, data), method: 'eth_signTransaction' });
  assert.equal(sent.risk, 'info');
  assert.equal(signed.headline, sent.headline);
  assert.equal(signed.kind, 'approve');
  assert.equal(signed.risk, 'caution', 'never "No red flags found": the site keeps a signed transaction');
  assert.equal(factValue(signed, 'Sent'), 'Later, by the site: you only sign it now');
  assert.ok(signed.reasons.some((x) => /send it whenever it chooses/.test(x)));
  assert.equal(analyze({ ...tx(USDT, call('0x095ea7b3', pad(SPENDER), uint(MAX))), method: 'eth_signTransaction' }).risk, 'danger');
});

test('F8: a request Guardian has no decoder for says it cannot be read, never "no red flags"', () => {
  for (const method of ['wallet_grantPermissions', 'wallet_requestExecutionPermissions']) {
    const r = analyze({ method, params: [{}] });
    assert.equal(r.kind, 'unknown', method);
    assert.equal(r.risk, 'danger', method);
    assert.ok(r.warnings.length > 0, method);
  }
  for (const method of ['wallet_invokeSnap', 'wallet_snap', 'wallet_requestSnaps', 'eth_somethingNew']) {
    const r = analyze({ method, params: [] });
    assert.equal(r.kind, 'unknown', method);
    assert.equal(r.risk, 'caution', method);
    assert.ok(r.reasons.some((x) => /cannot read this request/.test(x)), method);
  }
});

test('RA-9: long numbers are grouped in linear time', async () => {
  const { formatUnits, toBigInt } = await import('../src/analyzer/abi.js');
  assert.equal(formatUnits(1234567n, 0), '1,234,567');
  assert.equal(formatUnits(123n, 0), '123');
  assert.equal(formatUnits(1234567890123456789n, 18), '1.234567');
  assert.equal(formatUnits(-1234n, 0), '-1,234');
  const started = Date.now();
  assert.equal(formatUnits(10n ** 60000n, 0).length, 60001 + 20000);
  assert.ok(Date.now() - started < 1000, 'quick');
  assert.equal(toBigInt('9'.repeat(81)), null, 'longer than any real number');
  assert.equal(toBigInt(`0x${'f'.repeat(64)}`), (1n << 256n) - 1n);
});

test('RA-7: invisible characters, full-width and lookalike letters do not hide what a button offers', () => {
  const limited = tx(USDC, call('0x095ea7b3', pad(SPENDER), uint(10_000_000_000n)));
  for (const button of ['Claim airdrop', 'Cl​aim air​drop', 'Cl­aim airdrop', 'Clаim аirdrop', 'Ｃｌａｉｍ airdrop']) {
    const r = analyze({ ...limited, promise: { ...CLAIM, button } });
    assert.equal(r.subject.promise.offer, 'receive', button);
    assert.equal(r.risk, 'danger', button);
  }
  const ru = analyze({ ...limited, promise: { ...CLAIM, button: 'Получить бонус' } });
  assert.equal(ru.subject.promise.offer, null, 'a real Russian button is left to Gemini');
});

// ── Re-attack of 2026-11-24 ────────────────────────────────────────────────

const UNI = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';
const LINK = '0x514910771af9ca656af840dff83e8264ecf986ca';
const ROUTER = '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45';
const press = (button) => ({ button, title: 'Revoke.cash', heading: 'Approvals', ageMs: 300 });
const UNI_ENRICH = { accounts: [ME], spenderIsContract: true, token: { symbol: 'UNI', decimals: 18 } };

test('A1: an honest revoke of a token the registry does not list is a check, never a contradiction under "Revoke"', () => {
  const revoke = (spender, extra = {}) => analyze({ ...tx(UNI, call('0x095ea7b3', pad(spender), uint(0))), enrich: UNI_ENRICH, ...extra });
  const r = revoke(ROUTER);
  assert.equal(r.risk, 'caution');
  assert.equal(r.headline, 'Remove a spending permission for UNI, or give permission for item #0 if this is an NFT collection');
  assert.deepEqual(r.warnings, []);
  for (const button of ['Revoke', 'Revoke approval', 'Revoke all', 'Remove permission']) {
    const pressed = revoke(ROUTER, { promise: press(button) });
    assert.equal(pressed.subject.promise.offer, 'revoke', button);
    assert.equal(pressed.subject.promise.clash, false, button);
    assert.equal(pressed.risk, 'caution', button);
    assert.deepEqual(pressed.warnings, [], button);
  }
  // The usual revoke: a permission a drainer's own wallet holds. A personal wallet raises nothing here.
  const drainer = revoke(ATTACKER, { enrich: { ...UNI_ENRICH, spenderIsContract: false }, promise: press('Revoke') });
  assert.equal(drainer.risk, 'caution');
  assert.deepEqual(drainer.warnings, []);
  assert.equal(drainer.facts.find((f) => f.label === 'Spender').note, 'personal wallet');
  assert.notEqual(drainer.facts.find((f) => f.label === 'Spender').tone, 'danger');
  // revoke.cash "Revoke all" as one batch.
  const batch = analyze({
    method: 'wallet_sendCalls',
    params: [{ chainId: '0x1', from: ME, calls: [UNI, LINK].map((to) => ({ to, data: call('0x095ea7b3', pad(ROUTER), uint(0)) })) }],
    promise: press('Revoke all'),
  });
  assert.equal(batch.risk, 'caution');
  assert.equal(batch.subject.promise.clash, false);
  // Under an offer to receive something or to sign in, it still contradicts.
  for (const button of ['Claim airdrop', 'Connect wallet']) {
    const lure = revoke(ATTACKER, { promise: press(button) });
    assert.equal(lure.subject.promise.clash, true, button);
    assert.equal(lure.risk, 'danger', button);
    assert.match(lure.warnings[0], /may give someone your item #0, if this contract is an NFT collection\.$/, button);
  }
  // A real permission next to it, or coins sent with it, still contradict a revoke.
  const mixed = analyze({
    method: 'wallet_sendCalls',
    params: [
      {
        chainId: '0x1',
        from: ME,
        calls: [
          { to: UNI, data: call('0x095ea7b3', pad(ROUTER), uint(0)) },
          { to: USDT, data: call('0x095ea7b3', pad(ATTACKER), uint(MAX)) },
        ],
      },
    ],
    promise: press('Revoke all'),
  });
  assert.equal(mixed.subject.promise.clash, true);
  const paid = revoke(ROUTER, { params: [{ from: ME, to: UNI, data: call('0x095ea7b3', pad(ROUTER), uint(0)), value: '0x1' }], promise: press('Revoke') });
  assert.equal(paid.subject.promise.clash, true);
  // Never "no red flags" on what the page says about the token, and the registry's tokens stay a plain revoke.
  for (const token of [{ symbol: 'UNI', decimals: 18 }, { symbol: 'USDT', decimals: 6 }, { symbol: 'X', decimals: 0 }]) {
    assert.equal(revoke(ROUTER, { enrich: { ...UNI_ENRICH, token } }).risk, 'caution', token.symbol);
  }
  const usdt = analyze({ ...tx(USDT, call('0x095ea7b3', pad(ATTACKER), uint(0))), enrich: { spenderIsContract: false }, promise: press('Revoke') });
  assert.equal(usdt.kind, 'revoke');
  assert.equal(usdt.risk, 'info');
  assert.equal(usdt.headline, 'Remove a spending permission for USDT');
});

test('A2: no coins written plainly (0, "0") and a transaction type as a plain number read as their 0x forms', () => {
  const send = (fields) => analyze({ method: 'eth_sendTransaction', params: [{ from: ME, to: SPENDER, ...fields }], chainId: 1 });
  for (const value of [0, '0', '000', '0x0', '0x']) {
    const r = send({ value });
    assert.equal(r.kind, 'nativeTransfer', JSON.stringify(value));
    assert.equal(r.headline, 'Empty transaction', JSON.stringify(value));
    assert.equal(r.risk, 'info', JSON.stringify(value));
  }
  const approve = call('0x095ea7b3', pad(PERMIT2), uint(MAX));
  for (const [number, hex] of [
    [0, '0x0'],
    [1, '0x1'],
    [2, '0x2'],
  ]) {
    const a = send({ to: USDC, data: approve, type: number });
    assert.equal(a.kind, 'approve', String(number));
    assert.deepEqual(a, send({ to: USDC, data: approve, type: hex }), String(number));
  }
  assert.equal(send({ type: 4 }).kind, 'delegation');
  assert.equal(send({ type: '0x4' }).kind, 'delegation');
  // Any other number, decimal string or hex without 0x may be read differently: cannot read.
  for (const fields of [
    { value: 1 },
    { value: 1000 },
    { value: '10' },
    { value: '0.0' },
    { value: -1 },
    { value: 'ff' },
    { type: 3 },
    { type: 1.5 },
    { type: '2' },
    { type: -0.5 },
  ]) {
    const r = send(fields);
    assert.equal(r.kind, 'malformed', JSON.stringify(fields));
    assert.equal(r.risk, 'danger', JSON.stringify(fields));
  }
});

test('A3: a Celo network fee paid in a token is read and said; a zkSync paymaster still cannot be read', () => {
  const CUSD = '0x765de816845861e75a25fca122bb6898b8b1282a';
  // As viem's Celo formatter writes it (CIP-64), and the legacy form.
  for (const fields of [
    { maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1', feeCurrency: CUSD, type: '0x7b' },
    { gasPrice: '0x1', feeCurrency: CUSD },
    { feeCurrency: CUSD, type: 0x7b },
  ]) {
    const r = analyze({ method: 'eth_sendTransaction', params: [{ from: ME, to: SPENDER, value: '0x2386f26fc10000', ...fields }], chainId: 42220 });
    assert.equal(r.kind, 'nativeTransfer', JSON.stringify(fields));
    assert.equal(factValue(r, 'Network fee'), `Paid in token ${CUSD}`);
    assert.equal(r.risk, 'caution');
    assert.equal(r.subject.feeToken, CUSD);
  }
  // At least a check, even where the request alone raises no flag.
  const revoke = analyze({ method: 'eth_sendTransaction', params: [{ from: ME, to: USDT, data: call('0x095ea7b3', pad(SPENDER), uint(0)), feeCurrency: CUSD }], chainId: 1 });
  assert.equal(revoke.kind, 'revoke');
  assert.equal(revoke.risk, 'caution');
  // Not an address, in a batch call, or Celo's type without a fee token: cannot read.
  assert.equal(analyze({ method: 'eth_sendTransaction', params: [{ from: ME, to: SPENDER, feeCurrency: 'cUSD' }] }).kind, 'malformed');
  assert.equal(analyze({ method: 'eth_sendTransaction', params: [{ from: ME, to: SPENDER, type: '0x7b' }] }).kind, 'malformed');
  const inBatch = analyze({ method: 'wallet_sendCalls', params: [{ chainId: '0x1', calls: [{ to: SPENDER, feeCurrency: CUSD }] }] });
  assert.equal(inBatch.parts[0].kind, 'malformed');
  // zkSync: a paymaster's input can carry a token approval.
  const zk = {
    from: ME,
    to: SPENDER,
    value: '0x1',
    eip712Meta: { gasPerPubdata: '0xc350', paymasterParams: { paymaster: ATTACKER, paymasterInput: [140, 90] } },
    type: '0x71',
  };
  const paymaster = analyze({ method: 'eth_sendTransaction', params: [zk], chainId: 324 });
  assert.equal(paymaster.kind, 'malformed');
  assert.equal(paymaster.risk, 'danger');
});

const PERMIT_FIELDS = typedData('Permit', {}, {}).types.Permit;
const META_TYPES = {
  MetaTransaction: [
    { name: 'nonce', type: 'uint256' },
    { name: 'from', type: 'address' },
    { name: 'functionSignature', type: 'bytes' },
  ],
};
const USDC_PERMIT = { owner: ME, spender: ATTACKER, value: MAX.toString(), nonce: 0, deadline: 1900000000 };
const USDC_DOMAIN = { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC };

test('A4: a primary type that types do not declare, over a form Guardian reads, cannot be read: high risk', () => {
  // ethers signs the struct types declare (the permit), whatever primaryType says.
  for (const primaryType of ['Login', undefined, '', 'permit']) {
    const r = analyze(signTyped({ types: { Permit: PERMIT_FIELDS }, primaryType, domain: USDC_DOMAIN, message: USDC_PERMIT }, { promise: CLAIM }));
    assert.equal(r.kind, 'typedData', String(primaryType));
    assert.equal(r.risk, 'danger', String(primaryType));
    assert.equal(r.headline, 'Signature Guardian cannot read', String(primaryType));
    assert.equal(factValue(r, 'Problem'), 'Its primary type is not one it declares');
    assert.ok(r.warnings.length > 0);
  }
  // The domain's own type as the primary type: ethers drops it and signs the permit.
  const domainType = analyze(signTyped({ ...typedData('Permit', USDC_DOMAIN, USDC_PERMIT), primaryType: 'EIP712Domain' }));
  assert.equal(domainType.risk, 'danger');
  assert.equal(factValue(domainType, 'Problem'), 'Its primary type is not one it declares');
  // A Permit2 form, a signed transfer or a meta-transaction under another name too.
  for (const types of [typedData('PermitSingle', {}, {}).types, AUTH_TYPES('TransferWithAuthorization'), META_TYPES]) {
    assert.equal(analyze(signTyped({ types, primaryType: 'Login', domain: USDC_DOMAIN, message: {} })).risk, 'danger', Object.keys(types).join());
  }
  // Nothing Guardian reads declared: a format it does not recognise, a check.
  const other = analyze(signTyped({ types: { Mail: [{ name: 'contents', type: 'string' }] }, primaryType: 'Login', domain: {}, message: {} }));
  assert.equal(other.risk, 'caution');
  assert.equal(other.headline, 'Structured data signature');
  // The same permit under its own name is read as usual.
  const named = analyze(signTyped({ types: { Permit: PERMIT_FIELDS }, primaryType: 'Permit', domain: USDC_DOMAIN, message: USDC_PERMIT }));
  assert.equal(named.headline, 'Unlimited spending permission for USDC');
});

function AUTH_TYPES(name) {
  return {
    [name]: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };
}
const AUTH = { from: ME, to: ATTACKER, value: '50000000000', validAfter: 0, validBefore: 1900000000, nonce: `0x${'11'.repeat(32)}` };
const authorization = (message = AUTH, name = 'TransferWithAuthorization', extra = {}) =>
  analyze(signTyped({ types: AUTH_TYPES(name), primaryType: name, domain: USDC_DOMAIN, message }, extra));

test('A5: an EIP-3009 signed transfer is read as the transfer it is', () => {
  const r = authorization();
  assert.equal(r.kind, 'authorization');
  assert.equal(r.subject.action, 'transfer');
  assert.equal(r.risk, 'caution');
  assert.equal(r.headline, 'Signature that sends 50,000 USDC');
  assert.equal(factValue(r, 'To'), ATTACKER);
  assert.equal(factValue(r, 'Token'), 'USDC (USD Coin)');
  assert.ok(factValue(r, 'Valid until'));
  assert.ok(r.reasons.some((x) => /costs no gas/.test(x)));
  // A claim button over it contradicts it, as over any payment.
  const lure = authorization(AUTH, 'TransferWithAuthorization', { promise: CLAIM });
  assert.equal(lure.risk, 'danger');
  assert.equal(lure.subject.promise.clash, true);
  assert.match(lure.warnings[0], /lets someone move 50,000 USDC out of your wallet\.$/);
  assert.equal(authorization(AUTH, 'TransferWithAuthorization', { promise: { ...CLAIM, button: 'Pay 50,000 USDC' } }).subject.promise.clash, false);
  // receiveWithAuthorization: only the recipient carries it out; the tokens move all the same.
  const receive = authorization(AUTH, 'ReceiveWithAuthorization');
  assert.equal(receive.kind, 'authorization');
  assert.equal(receive.subject.byRecipient, true);
  assert.equal(receive.risk, 'caution');
  // Not valid yet: says from when.
  assert.ok(factValue(authorization({ ...AUTH, validAfter: Math.floor(Date.now() / 1000) + 86400 }), 'Valid from'));
  // Not in the standard form, or values wallets may read differently: cannot read, high risk.
  const uintNonce = AUTH_TYPES('TransferWithAuthorization').TransferWithAuthorization.map((f) => (f.name === 'nonce' ? { ...f, type: 'uint256' } : f));
  for (const [name, message, types] of [
    ['extra key', { ...AUTH, value2: '1' }],
    ['short nonce', { ...AUTH, nonce: '0x11' }],
    ['value 1e3', { ...AUTH, value: '1e3' }],
    ['missing field', { ...AUTH, validAfter: undefined }],
    ['uint nonce', AUTH, { TransferWithAuthorization: uintNonce }],
  ]) {
    const typed = { types: types || AUTH_TYPES('TransferWithAuthorization'), primaryType: 'TransferWithAuthorization', domain: USDC_DOMAIN, message };
    const bad = analyze(signTyped(JSON.parse(JSON.stringify(typed))));
    assert.equal(bad.risk, 'danger', name);
    assert.equal(bad.headline, 'Token transfer Guardian cannot read', name);
  }
});

const POS_USDT = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
const POS_DOMAIN = { name: '(PoS) Tether USD', version: '1', verifyingContract: POS_USDT, salt: `0x${(137).toString(16).padStart(64, '0')}` };
const metaTx = (functionSignature, extra = {}) =>
  analyze(signTyped({ types: META_TYPES, primaryType: 'MetaTransaction', domain: POS_DOMAIN, message: { nonce: 0, from: ME, functionSignature } }, { chainId: 137, ...extra }));

test('A5: a meta-transaction is read as the call it has the contract make, never below a check', () => {
  const r = metaTx(call('0x095ea7b3', pad(ATTACKER), uint(MAX)), { promise: CLAIM });
  assert.equal(r.kind, 'approve');
  assert.equal(r.risk, 'danger');
  assert.equal(r.headline, 'Signature that performs: Unlimited spending permission for USDT');
  assert.equal(factValue(r, 'Call'), 'Token approval (approve)');
  assert.equal(factValue(r, 'Token'), 'USDT (Tether USD)');
  assert.equal(r.subject.metaTx, true);
  assert.equal(r.subject.promise.clash, true);
  assert.ok(r.reasons.some((x) => /as if you had sent it/.test(x)));
  // A transfer, a revoke, and a call Guardian has no decoder for: at least a check.
  const pay = metaTx(call('0xa9059cbb', pad(ATTACKER), uint(1_000_000n)));
  assert.equal(pay.headline, 'Signature that performs: Send 1 USDT');
  assert.equal(pay.risk, 'caution');
  const revoke = metaTx(call('0x095ea7b3', pad(ATTACKER), uint(0)));
  assert.equal(revoke.kind, 'revoke');
  assert.equal(revoke.risk, 'caution');
  const unknown = metaTx('0xdeadbeef');
  assert.equal(unknown.kind, 'contractCall');
  assert.equal(unknown.risk, 'caution');
  // Call data cut short, or not hex at all: cannot read.
  assert.equal(metaTx(call('0x095ea7b3', pad(ATTACKER), 'f'.repeat(62))).kind, 'malformed');
  const notHex = metaTx('approve(attacker)');
  assert.equal(notHex.risk, 'danger');
  assert.equal(notHex.headline, 'Signature Guardian cannot read');
});

test('A6: increaseAllowance(spender, 0) removes nothing, and a revoke button over it contradicts it', () => {
  const zero = tx(USDT, call('0x39509351', pad(ATTACKER), uint(0)));
  const r = analyze(zero);
  assert.equal(r.kind, 'noChange');
  assert.equal(r.risk, 'info');
  assert.equal(r.headline, 'No change to the spending permission for USDT');
  assert.doesNotMatch(`${r.headline} ${r.reasons.join(' ')}`, /\bremove(d|s)? (a|the|an existing) permission|is removed/i, 'never says a permission is removed');
  const lure = analyze({ ...zero, promise: press('Revoke approvals') });
  assert.equal(lure.subject.promise.clash, true);
  assert.equal(lure.risk, 'danger');
  assert.equal(lure.warnings[0], 'The button you pressed said “Revoke approvals”, an offer to remove a permission, but this request removes no permission.');
  // Next to a real revoke it is no contradiction; approve with 0 stays the revoke.
  const both = analyze({
    method: 'wallet_sendCalls',
    params: [
      {
        chainId: '0x1',
        from: ME,
        calls: [
          { to: USDT, data: call('0x39509351', pad(ATTACKER), uint(0)) },
          { to: USDT, data: call('0x095ea7b3', pad(ATTACKER), uint(0)) },
        ],
      },
    ],
    promise: press('Revoke all'),
  });
  assert.equal(both.subject.promise.clash, false);
  assert.equal(analyze(tx(USDT, call('0x095ea7b3', pad(ATTACKER), uint(0)))).kind, 'revoke');
  // A bigger increase is still an extra permission.
  assert.equal(analyze(tx(USDT, call('0x39509351', pad(ATTACKER), uint(1n)))).kind, 'approve');
});

test('A7: a call Guardian knows, with call data shorter than its arguments, cannot be read', () => {
  for (const [name, to, data] of [
    ['approve, amount cut short', '0xb8c77482e45f1f44de1745f52c74426c631bdd52', call('0x095ea7b3', pad(ATTACKER), 'f'.repeat(62))],
    ['approve, no amount', USDT, call('0x095ea7b3', pad(ATTACKER))],
    ['transfer, one byte short', USDT, call('0xa9059cbb', pad(ATTACKER), uint(1n).slice(2))],
    ['transferFrom, two words', USDT, call('0x23b872dd', pad(ME), pad(ATTACKER))],
    ['setApprovalForAll, no flag', BAYC, call('0xa22cb465', pad(ATTACKER))],
    ['increaseAllowance, cut short', USDT, call('0x39509351', pad(ATTACKER), 'ff')],
    ['Permit2 approve, three words', PERMIT2, call('0x87517c45', pad(USDC), pad(ATTACKER), uint(1n))],
  ]) {
    const r = analyze(tx(to, data));
    assert.equal(r.kind, 'malformed', name);
    assert.equal(r.risk, 'danger', name);
    assert.equal(factValue(r, 'Problem'), 'Its call data is shorter than this function needs', name);
  }
  // Long enough: read as usual (bytes after the arguments change nothing).
  assert.equal(analyze(tx(USDT, `${call('0x095ea7b3', pad(ATTACKER), uint(5n))}00`)).kind, 'approve');
  // The Permit2 selector on another contract is a call Guardian has no decoder for.
  assert.equal(analyze(tx(USDT, call('0x87517c45', pad(USDC)))).kind, 'contractCall');
});

// ── Second re-attack of 2026-11-24 ─────────────────────────────────────────

const ETH_005 = `0x${(5n * 10n ** 16n).toString(16)}`;
const sendCalls = (calls, extra = {}, batchFields = { chainId: '0x1' }) =>
  analyze({ method: 'wallet_sendCalls', params: [{ ...batchFields, from: ME, calls }], chainId: 1, ...extra });
const payments = (n, value = ETH_005) => Array.from({ length: n }, () => ({ to: ATTACKER, value }));

test('B1: small coin payments in one batch add up: more than one is a check, whatever the total', () => {
  for (const [n, total] of [[2, '0.1'], [20, '1']]) {
    const r = sendCalls(payments(n), { promise: { button: 'Mint now', title: 'Mint', heading: 'Free mint', ageMs: 300 } });
    assert.equal(r.risk, 'caution', `${n} calls`);
    assert.equal(r.subject.promise.clash, false, `${n} calls`);
    assert.equal(factValue(r, 'Sends in total'), `${total} ETH`);
    assert.equal(r.facts.find((f) => f.label === 'Sends in total').tone, 'caution');
    assert.ok(r.reasons.includes(`Together, these actions send ${total} ETH out of your wallet.`), `${n} calls`);
    assert.equal(r.subject.total, `${total} ETH`);
  }
  // No button, no network named by the batch, a balance the page reports, other ways to write the value: never info.
  assert.equal(sendCalls(payments(200)).risk, 'caution');
  assert.equal(sendCalls(payments(20), {}, {}).risk, 'caution', 'the batch names no network');
  assert.equal(sendCalls(payments(20), { chainId: null }, {}).risk, 'caution', 'no network at all');
  assert.equal(sendCalls(payments(20), { enrich: { balance: '0xde0b6b3a7640000' } }).risk, 'caution');
  assert.equal(sendCalls(payments(2, `0x${(5n * 10n ** 16n).toString(16).padStart(64, '0')}`)).risk, 'caution', '64 hex digits');
  assert.equal(sendCalls(payments(2, ETH_005.toUpperCase().replace('0X', '0x'))).risk, 'caution', 'upper case');
  for (const button of ['Pay', 'Continue']) assert.equal(sendCalls(payments(20), { promise: { button, ageMs: 300 } }).risk, 'caution', button);
  // Coins attached to a call count too.
  const attached = sendCalls([...payments(1), { to: USDT, data: call('0x095ea7b3', pad(ATTACKER), uint(0)), value: '0x2386f26fc10000' }]);
  assert.equal(attached.risk, 'danger', 'coins attached to a revoke');
  assert.equal(factValue(attached, 'Sends in total'), '0.06 ETH');
  // One small payment, alone or next to an action that raises no flag, stays as it is.
  const one = sendCalls(payments(1));
  assert.equal(one.risk, 'info');
  assert.equal(factValue(one, 'Sends in total'), undefined);
  assert.equal(one.subject.total, undefined);
  assert.equal(sendCalls([...payments(1), { to: USDT, data: call('0x095ea7b3', pad(ATTACKER), uint(0)) }]).risk, 'info', 'with a revoke');
  // Calls that send no coins do not count; one wei more than a small payment, in one call, is a check.
  assert.equal(sendCalls([...payments(1), { to: ATTACKER, value: '0x0' }, { to: ATTACKER, value: '0x' }, { to: ATTACKER, value: 0 }]).risk, 'info');
  assert.equal(sendCalls(payments(1, `0x${(5n * 10n ** 16n + 1n).toString(16)}`)).risk, 'caution');
  // Without coins, a batch is judged by its actions, as before.
  const quiet = sendCalls([{ to: USDT, data: call('0x095ea7b3', pad(ATTACKER), uint(0)) }, { to: USDC, data: call('0x095ea7b3', pad(PERMIT2), uint(1n)) }]);
  assert.equal(quiet.risk, 'info');
  assert.equal(factValue(quiet, 'Sends in total'), undefined);
  // Only a batch carries several payments: a signature for later is always a check.
  assert.equal(analyze({ ...tx(ATTACKER, '0x', ETH_005), method: 'eth_signTransaction' }).risk, 'caution');
});

test('B2: the small-payment rule holds only on a network Guardian knows', () => {
  const pay = (chainId) => analyze({ ...tx(ATTACKER, '0x', ETH_005), chainId });
  const none = pay(null);
  assert.equal(none.risk, 'caution', 'eth_chainId failed or timed out');
  assert.equal(factValue(none, 'Network'), 'chain unknown');
  assert.equal(pay(1).risk, 'info');
  // The network the request names itself counts, whatever the page says.
  assert.equal(analyze({ method: 'eth_sendTransaction', params: [{ from: ME, to: ATTACKER, value: ETH_005, chainId: '0x1' }], chainId: null }).risk, 'info');
  // The demo always has chain 1: its "Send 0.01 ETH" stays without a flag.
  assert.equal(analyze(DEMO_RECORDS.transfer).risk, 'info');
});

const fieldsOf = (spec) => spec.split(',').map((f) => ({ type: f.split(' ')[0], name: f.split(' ')[1] }));
const CYCLE = { Login: [{ name: 'next', type: 'Session' }], Session: [{ name: 'back', type: 'Login' }] };
const DOMAIN_FIELDS = fieldsOf('string name,string version,uint256 chainId,address verifyingContract');
const POS_DOMAIN_FIELDS = fieldsOf('string name,string version,address verifyingContract,bytes32 salt');
const SEAPORT = {
  OrderComponents: fieldsOf(
    'address offerer,address zone,OfferItem[] offer,ConsiderationItem[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter',
  ),
  OfferItem: fieldsOf('uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount'),
  ConsiderationItem: fieldsOf('uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient'),
};
const ORDER = {
  offerer: ME,
  zone: '0x0000000000000000000000000000000000000000',
  offer: [{ itemType: 2, token: BAYC, identifierOrCriteria: '1', startAmount: '1', endAmount: '1' }],
  consideration: [],
  orderType: 0,
  startTime: '0',
  endTime: '1900000000',
  zoneHash: `0x${'0'.repeat(64)}`,
  salt: '1',
  conduitKey: `0x${'0'.repeat(64)}`,
  counter: '0',
};
const SEAPORT_DOMAIN = { name: 'Seaport', version: '1.5', chainId: 1, verifyingContract: '0x00000000000000adc04c56bf30ac9d3c0aaf14dc' };

test('B3: a declared primary type in a cycle of decoy structs cannot hide a form Guardian reads', () => {
  const approveAll = call('0x095ea7b3', pad(ATTACKER), uint(MAX));
  const cannotRead = (r, name) => {
    assert.equal(r.kind, 'typedData', name);
    assert.equal(r.risk, 'danger', name);
    assert.equal(r.headline, 'Signature Guardian cannot read', name);
    assert.equal(factValue(r, 'Problem'), 'It declares another type that some wallets sign instead', name);
    assert.ok(r.warnings.length > 0, name);
    assert.equal(isUndecoded(r), true, `${name}: no AI`);
  };
  const permitCycle = (extra = {}) => ({ EIP712Domain: DOMAIN_FIELDS, Permit: PERMIT_FIELDS, ...CYCLE, ...extra });
  const decoyOf = (name) => ({ Login: [{ name: 'p', type: name }, { name: 'next', type: 'Session' }], Session: [{ name: 'back', type: 'Login' }] });
  // The shapes of the re-attack (a45.mjs): ethers signs the form, the only struct no other one uses.
  for (const [name, types, primaryType, domain, message] of [
    ['P1', permitCycle(), 'Login', USDC_DOMAIN, USDC_PERMIT],
    ['P3', permitCycle(), 'Session', USDC_DOMAIN, USDC_PERMIT],
    ['P4', permitCycle(), 'Login', USDC_DOMAIN, { ...USDC_PERMIT, next: {} }],
    ['P2 self-loop', permitCycle({ Login: [{ name: 'next', type: 'Login' }] }), 'Login', USDC_DOMAIN, USDC_PERMIT],
    ['A1', { EIP712Domain: DOMAIN_FIELDS, ...AUTH_TYPES('TransferWithAuthorization'), ...CYCLE }, 'Login', USDC_DOMAIN, AUTH],
    ['A2', { EIP712Domain: DOMAIN_FIELDS, ...AUTH_TYPES('ReceiveWithAuthorization'), ...CYCLE }, 'Login', USDC_DOMAIN, AUTH],
    ['M1', { EIP712Domain: POS_DOMAIN_FIELDS, ...META_TYPES, ...CYCLE }, 'Login', POS_DOMAIN, { nonce: 0, from: ME, functionSignature: approveAll }],
    ['Permit2', { ...typedData('PermitSingle', {}, {}).types, ...CYCLE }, 'Session', { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 }, {}],
    // A decoy that uses a marketplace order, so the permit its message also carries is the only root.
    ['order', { ...SEAPORT, Permit: PERMIT_FIELDS, ...decoyOf('OrderComponents') }, 'OrderComponents', SEAPORT_DOMAIN, { ...ORDER, ...USDC_PERMIT }],
    // A permit of 0 (a revoke) that only a decoy uses: the signed transfer is the only root.
    ['revoke', { Permit: PERMIT_FIELDS, ...AUTH_TYPES('TransferWithAuthorization'), ...decoyOf('Permit') }, 'Permit', USDC_DOMAIN, { ...USDC_PERMIT, value: '0' }],
  ]) {
    cannotRead(analyze(signTyped({ types, primaryType, domain, message })), name);
    cannotRead(analyze(signTyped({ types, primaryType, domain, message }, { promise: CLAIM })), `${name} under a claim button`);
  }
  // More than one root, and one of them, not the primary type, is a form Guardian reads.
  const mail = { Mail: [{ name: 'contents', type: 'string' }] };
  cannotRead(analyze(signTyped({ types: { Permit: PERMIT_FIELDS, ...mail }, primaryType: 'Mail', domain: USDC_DOMAIN, message: { contents: 'hi' } })), 'two roots');
  // More than one root, none of them another form Guardian reads: as before.
  const other = analyze(signTyped({ types: { ...mail, Note: [{ name: 'text', type: 'string' }] }, primaryType: 'Mail', domain: {}, message: { contents: 'hi' } }));
  assert.equal(other.headline, 'Structured data signature');
  assert.equal(other.risk, 'caution');
  // A form nested in the primary type is signed as part of it: no other root.
  const wrapper = { ...AUTH_TYPES('TransferWithAuthorization'), Wrapper: [{ name: 'inner', type: 'TransferWithAuthorization' }] };
  assert.equal(analyze(signTyped({ types: wrapper, primaryType: 'Wrapper', domain: USDC_DOMAIN, message: { inner: AUTH } })).headline, 'Structured data signature');
  // Honest forms are the only root of their types: read as before.
  const order = analyze(signTyped({ types: { EIP712Domain: DOMAIN_FIELDS, ...SEAPORT }, primaryType: 'OrderComponents', domain: SEAPORT_DOMAIN, message: ORDER }));
  assert.equal(order.kind, 'order');
  assert.equal(order.risk, 'caution');
  assert.equal(order.headline, 'Marketplace order signature');
  assert.equal(factValue(order, 'Items you offer'), '1');
  const bulkTypes = { EIP712Domain: DOMAIN_FIELDS, BulkOrder: [{ name: 'tree', type: 'OrderComponents[2][2]' }], ...SEAPORT };
  const bulk = analyze(signTyped({ types: bulkTypes, primaryType: 'BulkOrder', domain: SEAPORT_DOMAIN, message: { tree: [] } }));
  assert.equal(bulk.headline, 'Several marketplace orders in one signature');
  assert.equal(bulk.risk, 'caution');
  // Permit2 witness transfers, as UniswapX signs them: the witness structs are used by the primary type.
  const uniswapX = {
    TokenPermissions: fieldsOf('address token,uint256 amount'),
    ExclusiveDutchOrder: fieldsOf(
      'OrderInfo info,uint256 decayStartTime,uint256 decayEndTime,address exclusiveFiller,uint256 exclusivityOverrideBps,address inputToken,uint256 inputStartAmount,uint256 inputEndAmount,DutchOutput[] outputs',
    ),
    OrderInfo: fieldsOf('address reactor,address swapper,uint256 nonce,uint256 deadline,address additionalValidationContract,bytes additionalValidationData'),
    DutchOutput: fieldsOf('address token,uint256 startAmount,uint256 endAmount,address recipient'),
  };
  const permit2Domain = { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 };
  const take = { permitted: { token: USDC, amount: '1000000' }, spender: '0x6000da47483062a0d734ba3dc7576ce6a0b645c4', nonce: '1', deadline: 1900000000, witness: {} };
  const single = {
    EIP712Domain: fieldsOf('string name,uint256 chainId,address verifyingContract'),
    PermitWitnessTransferFrom: fieldsOf('TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,ExclusiveDutchOrder witness'),
    ...uniswapX,
  };
  const witness = analyze(signTyped({ types: single, primaryType: 'PermitWitnessTransferFrom', domain: permit2Domain, message: take }));
  assert.equal(witness.subject.action, 'permitTransfer');
  assert.equal(witness.headline, 'Signature that lets someone take up to 1 USDC');
  assert.equal(witness.risk, 'caution');
  const several = {
    PermitBatchWitnessTransferFrom: fieldsOf('TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline,ExclusiveDutchOrder witness'),
    ...uniswapX,
  };
  const witnessBatch = analyze(signTyped({ types: several, primaryType: 'PermitBatchWitnessTransferFrom', domain: permit2Domain, message: { ...take, permitted: [take.permitted] } }));
  assert.equal(witnessBatch.subject.action, 'permitTransfer');
  assert.equal(witnessBatch.risk, 'caution');
  // The usual permits keep their reading.
  assert.equal(analyze(signTyped(typedData('Permit', USDC_DOMAIN, USDC_PERMIT))).headline, 'Unlimited spending permission for USDC');
  assert.equal(analyze(signTyped(daiPermit(DAI_MESSAGE))).headline, 'Unlimited spending permission for DAI');
});

test('B4: EIP-7702: every delegate is listed, and none is left out', () => {
  const delegates = [...[1, 2, 3, 4, 5, 6].map((d) => `0x${String(d).repeat(40)}`), '0xbadbadbadbadbadbadbadbadbadbadbadbadbad0'];
  const delegate = (authorizationList) =>
    analyze({ method: 'eth_sendTransaction', params: [{ from: ME, to: ME, type: '0x4', authorizationList }], chainId: 1 });
  const shown = (r) => r.facts.filter((f) => f.label === 'Delegate to');
  const r = delegate(delegates.map((address) => ({ address, chainId: '0x1', nonce: '0x0' })));
  assert.equal(r.risk, 'danger');
  assert.deepEqual(shown(r).map((f) => f.value), delegates);
  assert.ok(shown(r).every((f) => f.tone === 'danger' && f.mono));
  assert.deepEqual(r.subject.delegates, delegates);
  // An entry Guardian cannot read is said, never dropped; the same delegate twice is listed once.
  const odd = delegate([{ address: ATTACKER }, { address: 'nope' }, null, { contractAddress: SPENDER }, { address: ATTACKER.toUpperCase().replace('0X', '0x') }]);
  assert.deepEqual(shown(odd).map((f) => f.value), [ATTACKER, SPENDER, '2 Guardian cannot read']);
  assert.ok(shown(odd).every((f) => f.tone === 'danger'));
  assert.deepEqual(shown(delegate([7])).map((f) => f.value), ['one Guardian cannot read']);
  assert.deepEqual(shown(delegate([])).map((f) => f.value), ['unknown']);
});

const NPM = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const POSITIONS = { name: 'Uniswap V3 Positions NFT-V1', version: '1', chainId: 1, verifyingContract: NPM };
const ITEM = { spender: ROUTER, tokenId: '12345', nonce: 0, deadline: 1900000000 };
const itemPermit = (message = ITEM, extra = {}, domain = POSITIONS) => analyze(signTyped(typedData('Permit', domain, message, 'NftPermit'), extra));

test('B5: an NFT permit (EIP-4494, Uniswap V3 positions) reads as a permission for one item, never below a check', () => {
  const r = itemPermit(ITEM, { enrich: { spenderIsContract: true } });
  assert.equal(r.kind, 'permit');
  assert.equal(r.risk, 'caution');
  assert.equal(r.headline, 'Permission for item #12345');
  assert.equal(factValue(r, 'Action'), 'Item permission (NFT permit signature)');
  assert.equal(factValue(r, 'Collection'), NPM.toLowerCase());
  assert.equal(factValue(r, 'Item'), '#12345');
  assert.equal(factValue(r, 'Spender'), ROUTER);
  assert.equal(factValue(r, 'Network'), 'Ethereum');
  assert.equal(factValue(r, 'Valid until'), 'More than a year from now');
  assert.equal(r.reasons[0], 'The spender could take your item #12345 of this collection, now or later, without asking again.');
  assert.ok(r.reasons.some((x) => /costs no gas/.test(x)));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.subject.action, 'approve');
  assert.equal(r.subject.item, '12345');
  assert.equal(isUndecoded(r), false, 'read: its AI reading can be checked');
  // HEAD showed caution "Spending permission for unknown": never less now, and never info, even to a well-known spender.
  const known = itemPermit({ ...ITEM, spender: PERMIT2 });
  assert.equal(known.risk, 'caution');
  assert.match(factValue(known, 'Spender'), /Uniswap Permit2/);
  // Under a claim, sign-in or revoke button: a contradiction, high risk, as approve(spender, tokenId) of an NFT.
  for (const button of ['Claim airdrop', 'Sign in', 'Verify wallet', 'Revoke']) {
    const lure = itemPermit(ITEM, { promise: { ...CLAIM, button } });
    assert.equal(lure.risk, 'danger', button);
    assert.equal(lure.subject.promise.clash, true, button);
    assert.match(lure.warnings[0], /gives someone permission to take your item #12345 out of your wallet\.$/, button);
  }
  for (const button of ['Approve', 'Migrate', 'Continue']) {
    const fine = itemPermit(ITEM, { promise: { ...CLAIM, button } });
    assert.equal(fine.risk, 'caution', button);
    assert.equal(fine.subject.promise.clash, false, button);
  }
  // A personal wallet as the spender: high risk, as for approve.
  const personal = itemPermit({ ...ITEM, spender: ATTACKER }, { enrich: { spenderIsContract: false } });
  assert.equal(personal.risk, 'danger');
  assert.equal(personal.facts.find((f) => f.label === 'Spender').note, 'personal wallet');
  assert.ok(personal.warnings.some((x) => /personal wallet/.test(x)));
  // A key the wallet does not sign, or a value wallets may read differently: cannot read.
  unreadable(itemPermit({ ...ITEM, value: '0' }), 'extra key');
  unreadable(itemPermit({ ...ITEM, tokenId: '1e3' }), 'tokenId 1e3');
  unreadable(itemPermit({ ...ITEM, spender: 'nobody' }), 'spender');
  // Declared under another name than the one signed: cannot read.
  const hidden = analyze(signTyped({ ...typedData('Permit', POSITIONS, ITEM, 'NftPermit'), primaryType: 'Login' }, { promise: CLAIM }));
  assert.equal(hidden.risk, 'danger');
  assert.equal(hidden.headline, 'Signature Guardian cannot read');
  // No collection named: said, still a check.
  const { verifyingContract, ...noContract } = POSITIONS;
  const unnamed = itemPermit(ITEM, {}, noContract);
  assert.equal(factValue(unnamed, 'Collection'), 'unknown');
  assert.equal(unnamed.risk, 'caution');
});

// ── Third re-attack of 2026-11-24 ──────────────────────────────────────────

test('C1: a deployment that sends coins says so, and a sign-in, verify or revoke button over it contradicts it', () => {
  // PUSH20 attacker, SELFDESTRUCT: the new contract passes every coin on at once.
  const initCode = `0x73${ATTACKER.slice(2)}ff`;
  const TEN_ETH = '0x8ac7230489e80000';
  const deploy = (fields, extra = {}) => analyze({ method: 'eth_sendTransaction', params: [{ from: ME, ...fields }], chainId: 1, ...extra });
  const coins = 'It also sends 10 ETH to the new contract; its code decides where they go.';
  const r = deploy({ data: initCode, value: TEN_ETH });
  assert.equal(r.kind, 'deploy');
  assert.equal(r.risk, 'caution');
  assert.equal(r.headline, 'Deploy a new contract');
  assert.equal(factValue(r, 'Sends'), '10 ETH');
  assert.equal(r.facts.find((f) => f.label === 'Sends').tone, 'caution');
  assert.ok(r.reasons.includes(coins));
  assert.deepEqual(r.warnings, [coins]);
  assert.equal(r.subject.sends, '10 ETH');
  // A sign-in, verify or revoke never sends coins, as for a contract call Guardian cannot read.
  for (const button of ['Verify wallet', 'Sign in', 'Revoke']) {
    const lure = deploy({ data: initCode, value: TEN_ETH }, { promise: { ...CLAIM, button } });
    assert.equal(lure.risk, 'danger', button);
    assert.equal(lure.subject.promise.clash, true, button);
    assert.match(lure.warnings[0], /but this request sends 10 ETH to a new contract it creates\.$/, button);
    assert.ok(lure.warnings.includes(coins), button);
  }
  // A claim may cost a fee to a contract, and a button that offers nothing code reads is no contradiction.
  for (const button of ['Claim airdrop', 'Deploy']) {
    const fine = deploy({ data: initCode, value: TEN_ETH }, { promise: { ...CLAIM, button } });
    assert.equal(fine.risk, 'caution', button);
    assert.equal(fine.subject.promise.clash, false, button);
  }
  // The same in a batch of one call.
  const batch = sendCalls([{ data: initCode, value: TEN_ETH }]);
  assert.equal(batch.risk, 'caution');
  assert.ok(batch.warnings.includes(coins));
  const signIn = sendCalls([{ data: initCode, value: TEN_ETH }], { promise: { ...CLAIM, button: 'Sign in' } });
  assert.equal(signIn.risk, 'danger');
  assert.equal(signIn.subject.promise.clash, true);
  // A deployment that sends no coins is as it was.
  for (const plain of [deploy({ data: '0x6080' }), deploy({ data: '0x6080', value: '0x0' })]) {
    assert.equal(plain.risk, 'caution');
    assert.deepEqual(plain.facts.map((f) => f.label), ['Action', 'Network']);
    assert.deepEqual(plain.reasons, ['This creates a new contract from your wallet. Sites rarely need this from visitors.']);
    assert.deepEqual(plain.warnings, []);
    assert.deepEqual(plain.subject, { action: 'deploy' });
  }
  assert.equal(deploy({ data: '0x6080' }, { promise: { ...CLAIM, button: 'Verify wallet' } }).subject.promise.clash, false);
});

test('C2: a call of a batch is sent on the batch’s network; a call that names another cannot be read', () => {
  const pay = (chainId) => ({ to: ATTACKER, value: ETH_005, ...(chainId === undefined ? {} : { chainId }) });
  // Its own chainId never moves the network: a payment on a network Guardian does not know stays a check.
  const other = sendCalls([pay('0x1')], {}, { chainId: '0x1e' });
  assert.equal(other.risk, 'danger');
  assert.equal(other.parts[0].kind, 'malformed');
  assert.equal(factValue(other.parts[0], 'Problem'), 'Its network is not the one the batch is sent on');
  assert.equal(sendCalls([pay(1)], {}, { chainId: '0x1e' }).risk, 'danger', 'as a number');
  // The batch's own network, or none: as before.
  for (const chainId of ['0x1e', 30, undefined]) {
    const r = sendCalls([pay(chainId)], {}, { chainId: '0x1e' });
    assert.equal(r.risk, 'caution', String(chainId));
    assert.equal(factValue(r, 'Action 1'), 'Send 0.05 native coin, to 0xbad0…0bad', String(chainId));
  }
  for (const chainId of ['0x1', '0x01', 1, undefined]) assert.equal(sendCalls([pay(chainId)]).risk, 'info', String(chainId));
  // A batch that names no network is sent on the wallet's: a call that names another cannot be read either.
  assert.equal(sendCalls([pay('0x1')], {}, {}).risk, 'info', 'the wallet reported chain 1');
  assert.equal(sendCalls([pay('0x1')], { chainId: 30 }, {}).risk, 'danger', 'the wallet reported chain 30');
  assert.equal(sendCalls([pay('0x1')], { chainId: null }, {}).risk, 'caution', 'no network at all');
});

// ── Last re-attack of 2026-11-24 ───────────────────────────────────────────

test('D1: personal_sign of hex digits without 0x, or with 0X, is read as the data MetaMask signs, never as harmless text', () => {
  // A Safe transaction hash: MetaMask drops a 0x or 0X and signs the 32 bytes the digits stand for.
  const H = '7ec3bb92d42b76d28156c5634ae909bbf56b86253e28923e6020fc9cf45407fb';
  const sign = (params, origin = 'https://site.example') => analyze({ method: 'personal_sign', params, origin, chainId: 1 });
  const twoWays = (r) => r.reasons.some((x) => /written only in hex digits/.test(x));
  for (const [name, params] of [
    ['no 0x', [H, ME]],
    ['0X', [`0X${H}`, ME]],
    ['the older order', [ME, H]],
    ['an odd number of digits', [H.slice(1), ME]],
  ]) {
    const r = sign(params);
    assert.equal(r.risk, 'caution', name);
    assert.equal(r.headline, 'Signature for unreadable data', name);
    assert.ok(twoWays(r), name);
    assert.equal(isUndecoded(r), true, `${name}: no AI`);
  }
  // A sign-in for another site, in hex without 0x or with 0X: what MetaMask signs is what is checked.
  const text = `opensea.io wants you to sign in with your Ethereum account:\n${ME}\n\nNonce: 12345678`;
  const hex = Buffer.from(text, 'utf8').toString('hex');
  for (const message of [hex, `0X${hex}`]) {
    const r = sign([message, ME], 'https://phish.example');
    assert.equal(r.risk, 'danger', message.slice(0, 4));
    assert.equal(r.headline, 'Sign-in request for a different site', message.slice(0, 4));
    assert.equal(r.message, text);
    assert.ok(twoWays(r));
  }
  // Readable text written in hex digits: the text, a check, and why.
  const hello = sign([Buffer.from('Hello').toString('hex'), ME]);
  assert.equal(hello.message, 'Hello');
  assert.equal(hello.risk, 'caution');
  assert.ok(twoWays(hello));
  // Ordinary text, 0x-hex, and "0X" with nothing after it read as before, with no note.
  for (const [message, shown] of [
    ['Hello there', 'Hello there'],
    [`0x${Buffer.from('Hello').toString('hex')}`, 'Hello'],
    ['0X', '0X'],
  ]) {
    const r = sign([message, ME]);
    assert.equal(r.risk, 'info', message);
    assert.equal(r.headline, 'Sign a text message', message);
    assert.equal(r.message, shown, message);
    assert.ok(!twoWays(r), message);
  }
  const hash = sign([`0x${H}`, ME]);
  assert.equal(hash.risk, 'caution');
  assert.equal(hash.headline, 'Signature for unreadable data');
  assert.ok(!twoWays(hash));
});

test('D2: an amount no one holds is unlimited for a token the registry does not list, too', () => {
  const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
  const ONE_INCH = '0x111111125421ca6dc452d289314280a0f8842a65';
  const approve = (token, spender, amount, symbol, decimals) =>
    analyze({ ...tx(token, call('0x095ea7b3', pad(spender), uint(amount))), enrich: { spenderIsContract: true, token: { symbol, decimals } } });
  const unlimited = (r, symbol, what) => {
    assert.equal(r.risk, 'danger', what);
    assert.equal(r.headline, `Unlimited spending permission for ${symbol}`, what);
    assert.equal(factValue(r, 'Amount'), 'Unlimited', what);
    assert.ok(r.warnings.some((x) => x.includes(`any amount of ${symbol}`)), what);
  };
  // A quadrillion tokens by the decimals the token reports, never above 2^128 base units.
  unlimited(approve(LINK, SPENDER, 10n ** 33n, 'LINK', 18), 'LINK', 'a quadrillion of an 18-decimals token');
  unlimited(approve(LINK, SPENDER, 1n << 127n, 'LINK', 18), 'LINK', '2^127 of an 18-decimals token');
  unlimited(approve(WBTC, SPENDER, 1n << 127n, 'WBTC', 8), 'WBTC', '2^127 of an 8-decimals token');
  unlimited(approve(WBTC, SPENDER, 10n ** 30n, 'WBTC', 8), 'WBTC', '10^30 of an 8-decimals token');
  unlimited(approve(WBTC, SPENDER, 10n ** 23n, 'WBTC', 8), 'WBTC', 'a quadrillion WBTC');
  unlimited(approve(LINK, SPENDER, 1n << 128n, 'BIG', 30), 'BIG', '2^128 of a 30-decimals token');
  assert.equal(approve(LINK, SPENDER, (1n << 128n) - 1n, 'BIG', 30).risk, 'caution');
  // Decimals the page reports can only lower the line: fewer of them, a higher risk.
  assert.equal(approve(LINK, SPENDER, 10n ** 29n, 'LINK', 18).risk, 'caution');
  unlimited(approve(LINK, SPENDER, 10n ** 29n, 'LINK', 6), 'LINK', 'the same amount with 6 decimals reported');
  // An EIP-2612 permit, and Permit2 signatures, which read no decimals: from 10^30 base units on.
  const permit = typedData(
    'Permit',
    { name: 'Uniswap', chainId: 1, verifyingContract: UNI },
    { owner: ME, spender: SPENDER, value: (1n << 127n).toString(), nonce: 0, deadline: 1900000000 },
  );
  unlimited(analyze(signTyped(permit, { enrich: { spenderIsContract: true, token: { symbol: 'UNI', decimals: 18 } } })), 'UNI', 'permit 2^127');
  const batch = (amount) =>
    analyze(
      signTyped(
        typedData(
          'PermitBatch',
          { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
          {
            details: [WBTC, LINK, UNI].map((token) => ({ token, amount: amount.toString(), expiration: 1900000000, nonce: 0 })),
            spender: SPENDER,
            sigDeadline: 1900000000,
          },
        ),
        { enrich: { spenderIsContract: true } },
      ),
    );
  for (const amount of [1n << 127n, 10n ** 30n]) {
    const r = batch(amount);
    assert.equal(r.risk, 'danger', String(amount));
    assert.ok(r.parts.every((p) => p.subject.unlimited && p.risk === 'danger'), String(amount));
  }
  assert.equal(batch(10n ** 30n - 1n).risk, 'caution');
  // Ordinary amounts keep their reading.
  const honest = approve(LINK, SPENDER, 1000n * 10n ** 18n, 'LINK', 18);
  assert.equal(honest.risk, 'caution');
  assert.equal(honest.headline, 'Spending permission for 1,000 LINK');
  const swap = approve(LINK, ONE_INCH, 1000n * 10n ** 18n, 'LINK', 18);
  assert.equal(swap.risk, 'info');
  assert.equal(factValue(swap, 'Amount'), '1,000 LINK');
  assert.equal(approve(USDC, ONE_INCH, 1_000_000_000n, 'USDC', 6).risk, 'info');
  assert.equal(factValue(approve(WBTC, SPENDER, 10n ** 23n - 1n, 'WBTC', 8), 'Amount'), '999,999,999,999,999.999999 WBTC');
});

test('an exact approval of a coin with hundreds of trillions out (SHIB, PEPE) keeps its amount', () => {
  const SHIB = '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce';
  const PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
  const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
  const ONE_INCH = '0x111111125421ca6dc452d289314280a0f8842a65';
  const ROUTER = `0x${'22'.repeat(20)}`;
  const approve = (token, spender, amount, symbol, decimals) =>
    analyze({ ...tx(token, call('0x095ea7b3', pad(spender), uint(amount))), enrich: { spenderIsContract: true, token: { symbol, decimals } } });
  // Two trillion SHIB to Permit2, five trillion PEPE to 1inch: an ordinary
  // first step of a swap, with the amount, as for any other token.
  const shib = approve(SHIB, PERMIT2, 2n * 10n ** 30n, 'SHIB', 18);
  assert.equal(shib.risk, 'info');
  assert.equal(shib.headline, 'Spending permission for 2,000,000,000,000 SHIB');
  assert.equal(factValue(shib, 'Amount'), '2,000,000,000,000 SHIB');
  const pepe = approve(PEPE, ONE_INCH, 5n * 10n ** 30n, 'PEPE', 18);
  assert.equal(pepe.risk, 'info');
  assert.equal(factValue(pepe, 'Amount'), '5,000,000,000,000 PEPE');
  // To a contract Guardian does not know: Check carefully, still with the amount.
  const other = approve(SHIB, ROUTER, 2n * 10n ** 30n, 'SHIB', 18);
  assert.equal(other.risk, 'caution');
  assert.equal(other.headline, 'Spending permission for 2,000,000,000,000 SHIB');
  // All of SHIB there is (about 589 trillion) is still an amount; a quadrillion is not.
  assert.equal(factValue(approve(SHIB, PERMIT2, 589n * 10n ** 30n, 'SHIB', 18), 'Amount'), '589,000,000,000,000 SHIB');
  const quadrillion = approve(SHIB, ROUTER, 10n ** 33n, 'SHIB', 18);
  assert.equal(quadrillion.risk, 'danger');
  assert.equal(factValue(quadrillion, 'Amount'), 'Unlimited');
  // A drainer's near-largest number stays unlimited.
  const wbtc = approve(WBTC, ROUTER, 1n << 127n, 'WBTC', 8);
  assert.equal(wbtc.risk, 'danger');
  assert.equal(wbtc.headline, 'Unlimited spending permission for WBTC');
  assert.equal(factValue(wbtc, 'Amount'), 'Unlimited');
});

test('D3: a network fee the request sets itself, above a small payment, is said and checked', () => {
  const hex = (n) => `0x${BigInt(n).toString(16)}`;
  const GWEI = 10n ** 9n;
  const send = (fields, method = 'eth_sendTransaction') =>
    analyze({ method, params: [{ from: ME, to: ATTACKER, value: '0x0', ...fields }], chainId: 1 });
  // An empty transaction whose fee can reach 21 ETH (the re-attack's F1).
  const empty = send({ type: '0x2', gas: hex(21000), maxFeePerGas: hex(10n ** 15n), maxPriorityFeePerGas: hex(10n ** 15n) });
  assert.equal(empty.headline, 'Empty transaction');
  assert.equal(empty.risk, 'caution');
  const fee = empty.facts.find((f) => f.label === 'Network fee');
  assert.equal(fee.value, 'up to 21 ETH (set by the site)');
  assert.equal(fee.tone, 'caution');
  assert.ok(empty.reasons.some((x) => x.startsWith('The site set the network fee itself, and it can reach 21 ETH.')));
  assert.equal(empty.subject.fee, '21 ETH');
  // gasLimit and gasPrice too; a small payment; a transaction signed for later.
  const paid = send({ value: ETH_005, gasLimit: hex(21000), gasPrice: hex(10n ** 15n) });
  assert.equal(paid.risk, 'caution');
  assert.equal(paid.headline, 'Send 0.05 ETH');
  const later = send({ gas: 21000, gasPrice: hex(10n ** 15n) }, 'eth_signTransaction');
  assert.equal(factValue(later, 'Network fee'), 'up to 21 ETH (set by the site)');
  // Ordinary fees, or a fee the request does not set in full: as before.
  for (const fields of [
    { gas: hex(21000), maxFeePerGas: hex(30n * GWEI) },
    { value: ETH_005, gas: hex(21000), gasPrice: hex(30n * GWEI) },
    { gas: hex(500000), gasPrice: hex(100n * GWEI) },
    { gas: hex(30000000) },
    { maxFeePerGas: hex(10n ** 15n), gasPrice: hex(10n ** 15n) },
  ]) {
    const r = send(fields);
    assert.equal(r.risk, 'info', JSON.stringify(fields));
    assert.equal(factValue(r, 'Network fee'), undefined, JSON.stringify(fields));
  }
});

test('D4: a form written with "uint" for "uint256", or next to a struct named like a plain type, cannot hide behind a decoy', () => {
  const alias = (spec) => fieldsOf(spec.replace(/uint256/g, 'uint'));
  const ANOTHER = 'It declares another type that some wallets sign instead';
  const UNDECLARED = 'Its primary type is not one it declares';
  const cannotRead = (r, problem, name) => {
    assert.equal(r.kind, 'typedData', name);
    assert.equal(r.risk, 'danger', name);
    assert.equal(r.headline, 'Signature Guardian cannot read', name);
    assert.equal(factValue(r, 'Problem'), problem, name);
    assert.equal(isUndecoded(r), true, `${name}: no AI`);
  };
  const permitU = alias('address owner,address spender,uint256 value,uint256 nonce,uint256 deadline');
  const authU = alias('address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce');
  const metaU = alias('uint256 nonce,address from,bytes functionSignature');
  const meta = { nonce: 0, from: ME, functionSignature: call('0x095ea7b3', pad(ATTACKER), uint(MAX)) };
  // ethers reads "uint" as "uint256" and signs the very same permit, transfer or meta-transaction (b3-alias U1-U6, V1, V2).
  for (const [name, types, primaryType, domain, message, problem] of [
    ['U1', { EIP712Domain: DOMAIN_FIELDS, Permit: permitU, ...CYCLE }, 'Login', USDC_DOMAIN, USDC_PERMIT, ANOTHER],
    ['U2', { EIP712Domain: DOMAIN_FIELDS, Permit: permitU, ...CYCLE }, 'Session', USDC_DOMAIN, USDC_PERMIT, ANOTHER],
    ['U3', { EIP712Domain: DOMAIN_FIELDS, Permit: permitU, ...CYCLE }, 'Nothing', USDC_DOMAIN, USDC_PERMIT, UNDECLARED],
    ['U4', { EIP712Domain: DOMAIN_FIELDS, Permit: permitU, ...CYCLE }, '', USDC_DOMAIN, USDC_PERMIT, UNDECLARED],
    ['U5', { EIP712Domain: DOMAIN_FIELDS, TransferWithAuthorization: authU, ...CYCLE }, 'Login', USDC_DOMAIN, AUTH, ANOTHER],
    ['U6', { EIP712Domain: POS_DOMAIN_FIELDS, MetaTransaction: metaU, ...CYCLE }, 'Login', POS_DOMAIN, meta, ANOTHER],
    ['V1', { EIP712Domain: DOMAIN_FIELDS, Permit: permitU }, 'Nothing', USDC_DOMAIN, USDC_PERMIT, UNDECLARED],
    ['V2', { EIP712Domain: DOMAIN_FIELDS, Permit: permitU }, 'EIP712Domain', USDC_DOMAIN, USDC_PERMIT, UNDECLARED],
    // A decoy struct named "int" or "uint" (b3-alias K1, K2): ethers still signs the permit.
    ['K1', { EIP712Domain: DOMAIN_FIELDS, Permit: PERMIT_FIELDS, Login: fieldsOf('int next'), int: fieldsOf('Login back') }, 'Login', USDC_DOMAIN, USDC_PERMIT, ANOTHER],
    ['K2', { EIP712Domain: DOMAIN_FIELDS, Permit: PERMIT_FIELDS, Login: fieldsOf('uint next'), uint: fieldsOf('Login back') }, 'Nothing', USDC_DOMAIN, USDC_PERMIT, UNDECLARED],
    ['K3', { Permit: PERMIT_FIELDS, Login: fieldsOf('string a'), address: fieldsOf('Login back') }, 'Login', USDC_DOMAIN, USDC_PERMIT, ANOTHER],
  ]) {
    cannotRead(analyze(signTyped({ types, primaryType, domain, message })), problem, name);
    cannotRead(analyze(signTyped({ types, primaryType, domain, message }, { promise: CLAIM })), problem, `${name} under a claim button`);
  }
  // Written with "uint" under its own name: not the standard form, as before.
  const named = analyze(signTyped({ types: { EIP712Domain: DOMAIN_FIELDS, Permit: permitU }, primaryType: 'Permit', domain: USDC_DOMAIN, message: USDC_PERMIT }));
  assert.equal(named.headline, 'Token permission Guardian cannot read');
  assert.equal(factValue(named, 'Problem'), 'Its fields are not the standard ones');
  // Honest data written with "uint" keeps its reading: a marketplace order, a format Guardian does not know.
  const seaport = Object.fromEntries(Object.entries(SEAPORT).map(([k, v]) => [k, v.map((f) => ({ ...f, type: f.type.replace(/^uint256/, 'uint') }))]));
  const order = analyze(signTyped({ types: { EIP712Domain: DOMAIN_FIELDS, ...seaport }, primaryType: 'OrderComponents', domain: SEAPORT_DOMAIN, message: ORDER }));
  assert.equal(order.headline, 'Marketplace order signature');
  assert.equal(order.risk, 'caution');
  const mail = analyze(
    signTyped({ types: { Mail: fieldsOf('uint id,uint[] tags,string contents') }, primaryType: 'Mail', domain: {}, message: { id: 1, tags: [], contents: 'hi' } }),
  );
  assert.equal(mail.headline, 'Structured data signature');
  assert.equal(mail.risk, 'caution');
  // A struct named "uint" makes "uint" that struct, not uint256 (as ethers reads it): no other permit hides there.
  const struct = analyze(signTyped({ types: { Permit: permitU, uint: fieldsOf('string a') }, primaryType: 'Permit', domain: USDC_DOMAIN, message: USDC_PERMIT }));
  assert.equal(struct.headline, 'Token permission Guardian cannot read');
});
