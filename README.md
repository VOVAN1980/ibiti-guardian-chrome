# IBITI Guardian for Chrome

Know what you sign. Guardian holds a wallet request before it reaches your
wallet, shows what it would allow in plain facts, and lets you reject it.

Status: work in progress for #BuildHybridAI 2026. Interception, the fact
analyzer and the hybrid AI explanation are in place; the hosted demo and the
design pass are next.

## How the AI is used

Facts and the risk level come from a deterministic analyzer, never from a
model. Firebase AI Logic hybrid inference then explains those facts:

- **On device** (`InferenceMode.ONLY_ON_DEVICE`, Gemini Nano in Chrome): starts
  as soon as the review window opens. Nothing about the request leaves the
  computer.
- **In the cloud** (`InferenceMode.ONLY_IN_CLOUD`, Gemini through Firebase):
  a deeper, structured analysis, sent only when the user presses the button.

Each answer shows where it came from and how long it took. Prompts contain
the decoded facts only, never the user's own wallet address. No Gemini API
key is in the extension: Firebase AI Logic is the server-side gateway, guarded
by App Check.

## Try it

```bash
npm install
cp src/config.example.js src/config.js   # then fill in your Firebase web config
npm run build        # unpacked extension in dist/extension
npm run demo         # demo site at http://127.0.0.1:5179/demo/index.html?mock=1
```

`src/config.js` is not in the repository. It needs a Firebase project with
AI Logic (Gemini Developer API) enabled and an App Check debug token; the
example file says where to find both. Without it the interception and the
analyzer still work; only the AI explanations need Firebase.

Load `dist/extension` in `chrome://extensions` (Developer mode → Load
unpacked), open the demo site and press any button. The demo wallet holds no
keys; it only records which requests reach it.

## Tests

```bash
npm test             # analyzer: decoding and risk rules
npm run test:e2e     # real Chrome with the extension loaded
```

The end-to-end test checks that a held request does not reach the wallet,
that Reject returns error 4001, that Continue forwards the request byte for
byte, that closing the window or losing contact with the extension refuses
the request, and that nothing is sent to the cloud before the user asks.

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
