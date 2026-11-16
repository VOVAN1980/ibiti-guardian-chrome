// Blind sets: explanations written by an independent author who saw only the
// decoded facts of each request (never Guardian's checks or tests). Each set
// was run once as written; its first-run score is in the notes below. What
// it revealed was fixed, and the set stays here so it cannot come back.
//
//   set A (2026-11-17, 132 entries): first run 61/66 correct shown,
//   51/66 wrong blocked. Gaps it found: networks, site names, "verified",
//   funds "arriving", scope ("every NFT in your wallet"), shortened
//   collection addresses read as numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { analyze } from '../src/analyzer/index.js';
import { meaning } from '../src/ai/prompt.js';
import { answerChecker, ownAddresses } from '../src/ai/guard.js';

const dir = new URL('./fixtures/', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));

for (const file of readdirSync(dir).filter((f) => /^blind-set-.*\.json$/.test(f)).sort()) {
  const records = read(file.replace('blind-set-', 'blind-records-'));
  const host = new URL(Object.values(records)[0].origin).host;
  test(`${file}: correct explanations are shown, wrong ones are not`, () => {
    const wrong = [];
    for (const entry of read(file)) {
      const record = records[entry.scenario];
      const result = analyze(record);
      const checker = answerChecker(result, meaning(result, host), { own: ownAddresses(record), chainId: record.chainId, host });
      checker.push(entry.text);
      const out = checker.finish(entry.text);
      const got = out.problem === null ? 'show' : 'block';
      if (got !== entry.expected) {
        wrong.push(`${entry.expected === 'show' ? 'wrongly blocked' : 'missed'} [${entry.scenario}${entry.error ? `/${entry.error}` : ''}] ${entry.text}${out.problem ? ` -> ${out.problem} (${out.detail})` : ''}`);
      }
    }
    assert.deepEqual(wrong, []);
  });
}
