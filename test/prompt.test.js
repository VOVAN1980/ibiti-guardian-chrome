// What may be sent to the cloud: the decoded facts, never the user's wallet
// address or how much of their balance a payment takes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyzer/index.js';
import { deepPrompt, explainPrompt } from '../src/ai/prompt.js';

const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const OTHER = '0x9f3a000000000000000000000000000000c21e00';
const ME = '0x1111111111111111111111111111111111111111';
const pad = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const uint = (n) => BigInt(n).toString(16).padStart(64, '0');
const tx = (to, data, value) => ({
  method: 'eth_sendTransaction',
  params: [{ from: ME, to, data, ...(value ? { value } : {}) }],
  chainId: 1,
});

const BALANCE = /of your |in this wallet/;

const cases = {
  // 2 ETH out of 2 ETH
  'a coin payment of the whole balance': analyze({
    ...tx(OTHER, '0x', '0x1bc16d674ec80000'),
    enrich: { balance: '0x1bc16d674ec80000' },
  }),
  // 1000 USDT out of 1000 USDT
  'a token payment of the whole balance': analyze({
    ...tx(USDT, `0xa9059cbb${pad(OTHER)}${uint(1_000_000_000n)}`),
    enrich: { tokenBalance: '1000000000' },
  }),
};

for (const [name, result] of Object.entries(cases)) {
  test(`${name}: the balance stays on this computer`, () => {
    // On the device, the explanation may use it.
    assert.match(explainPrompt(result, 'shop.example'), BALANCE);
    for (const prompt of [explainPrompt(result, 'shop.example', { cloud: true }), deepPrompt(result, 'shop.example')]) {
      assert.doesNotMatch(prompt, BALANCE);
      assert.ok(!prompt.toLowerCase().includes(ME), 'the user’s address is not sent');
      assert.match(prompt, /Amount: /, 'the facts are still there');
      assert.match(prompt, /cannot be undone/, 'other reasons are still there');
    }
  });
}

test('an approval keeps all its reasons in the cloud prompt', () => {
  const result = analyze(tx(USDT, `0x095ea7b3${pad(OTHER)}${uint((1n << 256n) - 1n)}`));
  const cloud = explainPrompt(result, 'shop.example', { cloud: true });
  const why = cloud.split('Why it matters:\n')[1].split('\n');
  assert.equal(why.length, result.reasons.length, 'every reason is there');
  assert.equal(cloud, explainPrompt(result, 'shop.example'), 'nothing about the balance to leave out');
});
