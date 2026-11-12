import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyzer/index.js';

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

test('limited approve shows the exact amount and is caution', () => {
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
  assert.equal(r.risk, 'caution');
  assert.equal(r.headline, 'Send 0.5 ETH');
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
  const text = 'opensea.io wants you to sign in with your Ethereum account:\n' + ME + '\n\nNonce: 1';
  const hex = '0x' + Buffer.from(text, 'utf8').toString('hex');
  const bad = analyze({ method: 'personal_sign', params: [hex, ME], origin: 'https://free-airdrop.example' });
  assert.equal(bad.kind, 'signIn');
  assert.equal(bad.risk, 'danger');
  const ok = analyze({ method: 'personal_sign', params: [hex, ME], origin: 'https://opensea.io' });
  assert.equal(ok.risk, 'info');
});

test('EIP-2612 permit with unlimited value is danger and notes it is off-chain', () => {
  const typed = {
    primaryType: 'Permit',
    domain: { name: 'USD Coin', chainId: 1, verifyingContract: USDC },
    message: { owner: ME, spender: SPENDER, value: MAX.toString(), nonce: 0, deadline: 99999999999 },
  };
  const r = analyze({ method: 'eth_signTypedData_v4', params: [ME, JSON.stringify(typed)], chainId: 1 });
  assert.equal(r.kind, 'permit');
  assert.equal(r.risk, 'danger');
  assert.equal(factValue(r, 'Amount'), 'Unlimited');
  assert.equal(factValue(r, 'Valid until'), 'More than a year from now');
  assert.ok(r.reasons.some((x) => /costs no gas/.test(x)));
});

test('Permit2 PermitSingle is decoded', () => {
  const typed = {
    primaryType: 'PermitSingle',
    domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
    message: {
      details: { token: USDT, amount: ((1n << 160n) - 1n).toString(), expiration: 1893456000, nonce: 0 },
      spender: SPENDER,
      sigDeadline: 1893456000,
    },
  };
  const r = analyze({ method: 'eth_signTypedData_v4', params: [ME, typed], chainId: 1 });
  assert.equal(r.kind, 'permit2');
  assert.equal(r.risk, 'danger');
  assert.equal(factValue(r, 'Token'), 'USDT (Tether USD)');
  assert.equal(factValue(r, 'Amount'), 'Unlimited');
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
