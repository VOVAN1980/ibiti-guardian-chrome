# IBITI Guardian for Chrome

Know what you sign. Guardian holds a wallet request before it reaches your
wallet, shows what it would allow in plain facts, and lets you reject it.

Status: working prototype of the interception and the fact analyzer. The
on-device and cloud explanations (Firebase AI Logic hybrid inference) come next.

## Try it

```bash
npm install
npm run build        # unpacked extension in dist/extension
npm run demo         # demo site at http://127.0.0.1:5179/demo/index.html?mock=1
```

Load `dist/extension` in `chrome://extensions` (Developer mode → Load
unpacked), open the demo site and press any button. The demo wallet holds no
keys; it only records which requests reach it.

## Tests

```bash
npm test             # analyzer: decoding and risk rules
npm run test:e2e     # real Chrome: a held request never reaches the wallet
```

## How it works

- `src/inpage.js` runs in the page before any site script and wraps wallet
  providers (`window.ethereum`, EIP-6963). Requests that move funds or sign data
  wait for a decision.
- `src/bridge.js` and `src/background.js` carry the request to Guardian's own
  window, which the site cannot touch.
- `src/analyzer/` decodes the request without AI: what action, which token,
  how much, to whom, and why it is risky.

## Limits

Guardian wraps the standard provider API. A site that talks to a wallet
through a private channel instead is not covered, and the wallet's own
confirmation remains the last line of defense.

## License

Apache-2.0
