# IBITI Guardian for Chrome

**Know what you sign.** Wallet drainers rarely hack anything: they ask you to
sign. Guardian holds a wallet request *before your wallet sees it*, decodes it
into plain facts, lets Gemini explain it — on your device first, in the cloud
only if you allow it — and then you decide.

**Try it now, nothing to install: https://ibiti-guardian-chrome.web.app**
(a simulation with a demo wallet that has no keys and no funds; the extension
does the same check in front of your real wallet).

**Video (2:54):** https://youtu.be/1xGWgzLbLEM · **Devpost:** https://devpost.com/software/ibiti-guardian-for-chrome-know-what-you-sign

<a href="https://youtu.be/1xGWgzLbLEM"><img src="docs/video.jpg" alt="Watch the video: IBITI Guardian for Chrome — know what you sign" width="640"></a>

<p>
  <img src="docs/review-on-device.png" alt="Guardian holding an unlimited approval: facts decoded by code, explained on device by Gemini Nano" width="360">
  &nbsp;
  <img src="docs/review-cloud.png" alt="The optional cloud analysis through Firebase AI Logic" width="360">
</p>

Built for #BuildHybridAI 2026.

## What it does

1. **Holds the request.** When a page asks the wallet to sign or send
   (`eth_sendTransaction`, `eth_signTypedData_v4`, `personal_sign`, `eth_sign`,
   `wallet_sendCalls`), Guardian holds it and opens its own window. The wallet
   has not seen the request yet.
2. **Facts first, from code.** A deterministic analyzer decodes it: what
   action, which token (and whether its contract is the real one on that
   network), how much, to whom, on which network, and why it matters. The risk
   level — *High risk*, *Check carefully*, *No red flags found* — is decided by
   code, never by a model.
3. **Gemini reads it too, on your device.** The sentence on what confirming
   does and the warnings are written by code. Gemini Nano reads the decoded
   request on your own computer and answers a short form; code checks its
   reading against the decoder and only then lets it pick the reasons that
   matter most. No AI service is contacted. On a computer without Gemini
   Nano, a one-time permission lets Gemini in the cloud do it instead
   (Firebase AI Logic's hybrid fallback).
4. **A deeper look, only if you ask.** One button sends the decoded facts
   (never your own wallet address) to Gemini in the cloud for a structured
   second opinion: the scam pattern it matches and what to verify, picked
   from fixed lists that code checks against the request.
5. **You decide.** *Reject* returns the standard error 4001 to the site and
   the wallet never sees the request. *Continue* forwards exactly the request
   that was reviewed.

It recognises unlimited approvals, gasless permit signatures (EIP-2612 and
Permit2), NFT `setApprovalForAll`, blind `eth_sign`, fake tokens that borrow a
famous symbol, sign-in messages for a different site, transfers measured
against your balance, marketplace orders and batched calls — and it stays calm
on ordinary requests.

## How the hybrid AI is used

Firebase AI Logic hybrid inference. Gemini reads every request Guardian can
decode, on the computer whenever Gemini Nano is there; once the user has
allowed the cloud, the SDK falls back to Gemini in the cloud on computers
without it. The answer is always a form, never text for the user.

| | Gemini's reading | Gemini's reading, cloud allowed | Deeper analysis |
|---|---|---|---|
| Mode | `ONLY_ON_DEVICE` | `PREFER_ON_DEVICE` | `ONLY_IN_CLOUD` |
| Answer | A JSON form (Prompt API `responseConstraint`) | The same form (`responseConstraint` on device, `responseJsonSchema` in the cloud) | A JSON form (`responseJsonSchema`) |
| Model | Gemini Nano, built into Chrome | Gemini Nano if ready, else `gemini-3.5-flash-lite` | `gemini-3.5-flash-lite` |
| When | By itself (the default) | By itself, after a one-time **Use cloud AI when this computer has none** | Only after the user presses **Ask cloud AI** |
| Sent to an AI service | Nothing | Nothing when Nano answers; otherwise the decoded facts | The decoded facts |
| Protected by | — (no network call) | Firebase App Check | Firebase App Check |

**Who writes what.** Every word in Guardian's window is written by code.
Gemini never writes text the user reads: it answers a form, and code checks
the form against the decoded request before using any of it.

- **Code** (`src/analyzer/`, `src/ai/prompt.js`) writes the facts, the risk
  level, one sentence on what confirming does — for example *If you confirm,
  someone else, an unknown address (a personal wallet), gets permission to
  take any amount of USDT out of your wallet, at any time, without asking you
  again, until you revoke it.* — and the **warnings**: the reasons that alone
  make a request high risk (a personal wallet as the spender, an unlimited
  permission for an unknown address, a token that borrows a famous name, coins
  attached to a token call, a sign-in for a different site, almost the whole
  balance). They are on screen at once, with or without AI, and no AI can
  remove them.
- **Gemini** reads the decoded facts — not the code's sentence, so its reading
  is a second one — and answers a form (`src/ai/reading.js`): what kind of
  request it is, who would gain, which way the user's assets would move,
  whether it is unlimited, and which of the analyzer's reasons matter most.
- **Code compares the form with the decoded request.** If any field differs
  — "you" gain where someone else does, assets "come in" where they go out,
  "limited" where it is unlimited — none of the answer is used. If all fields
  match, the reasons Gemini picked are added under **Most important**, after
  the warnings, in the analyzer's own words. The main view never says that
  Gemini "agrees" (that could read as an all-clear); how its answer was
  checked is under **How Gemini's answer was checked**.
- **The deeper analysis** answers the same reading, plus a scam pattern and
  the things to check, each picked from a fixed list written in code. Code
  checks that the request has what the pattern and each check are about —
  "permit phishing" only on a permit signature, never a known scam on a
  request with no red flags, never "no known pattern" on a high-risk request
  that has one — and adds the checks that must always be shown (marked ⚠).

What this does and does not prove: Gemini cannot put an amount, an address,
a token, a role or a direction on screen that the decoder did not find, and
it cannot hide a warning. It does not prove the rest of Guardian is free of
mistakes: the analyzer and the build are tested on their own (`npm test`,
`npm run test:e2e`), and the analyzer's decoding is what the window stands on.

- The permission is off until the user turns it on, in Guardian's window or
  its toolbar panel (where it can be turned off again). The hosted demo keeps
  it for the visit only.
- **Exactly what would be sent** shows the full text next to the one-time
  permission, and **Exactly what was sent** after every cloud answer. It
  never holds the user's wallet address or balance; for a payment measured
  against the balance, the risk level stays on the computer too.
- Each answer shows where it ran and how long it took (*On device · 3.0 s*,
  *Cloud fallback · 1.6 s*, *Cloud · 2.3 s*), from the SDK's
  `inferenceSource`.
- The SDK falls back when no on-device model is ready (including one that
  still needs downloading; the window then also offers the download). If
  Gemini Nano is there but fails while answering, Guardian's own text stands
  alone that time; the facts and the decision never depend on it.
- **No guessing.** A request the analyzer cannot decode (a blind signature,
  an unknown contract call or data format, a batch with such a call) gets no
  AI at all: a model could only guess.
- Text a website writes itself (an app name, a sign-in domain) goes into
  prompts quoted and short, as data; an unverified token's symbol is kept
  only if it is a plain ticker.
- No Gemini API key is in the extension. Firebase AI Logic is the gateway
  (`src/ai/engine.js`).
- If no AI answers at all (no on-device model and no permission for the
  cloud), the facts, the code's sentence and the decision still work.

## Try it in two minutes

1. Open https://ibiti-guardian-chrome.web.app and press **Claim airdrop**.
   The request is held; read the facts; press **Reject** or **Continue**. The
   log at the bottom says whether the demo wallet ever saw it.
2. Press the other buttons: five things drainers ask for, and four ordinary
   requests that Guardian should not make a fuss about.
3. Press **Turn Guardian off to see the difference** and click again: the
   same request goes straight to the wallet.

On-device explanations need a Chrome that has Gemini Nano (built-in AI).
Without it, press **Use cloud AI when this computer has none** once, and
Gemini in the cloud explains instead for the rest of the visit. The facts, the
decision and the deeper analysis do not depend on either.

<img src="docs/playground.png" alt="The hosted playground" width="640">

## Build the extension

```bash
npm install
cp src/config.example.js src/config.js   # then fill in your Firebase web config
npm run build        # dist/extension (the extension) and dist/site (the hosted demo)
```

Load `dist/extension` in `chrome://extensions` (Developer mode → Load
unpacked). Requires Chrome 139 or newer.

Guardian needs no clicks: it opens its own window when a page asks the wallet
to sign or send. The toolbar icon opens a small panel that says Guardian is on,
whether Gemini Nano and the cloud analysis are available in this build, holds
the switch for the cloud fallback (off until you turn it on, here or in
Guardian's window), and opens the test page.

<img src="docs/popup.png" alt="The toolbar panel" width="300">

`src/config.js` is not in the repository. It needs a Firebase project with AI
Logic (Gemini Developer API) enabled; the cloud analysis in the extension also
needs an App Check debug token registered for that project (extension pages
cannot run reCAPTCHA). The example file says where to find both. Without it
the build still works, and so do the interception and the analyzer; only the
AI explanations need Firebase.

```bash
npm run demo         # local demo site at http://127.0.0.1:5179/demo/index.html
```

The local page uses the keyless demo wallet by default. With
`?wallet=real` it talks to an installed wallet instead, and only while that
wallet is on a test network.

## The hosted demo

`dist/site` is the demo site with a preview of Guardian built in. When the
extension is not installed, the page loads the very same in-page guard
(`src/inpage.js`) and shows the very same review window in a panel inside the
page. It is a preview, not protection: a panel inside a page can be removed by
that page, which is why the extension opens its own window instead.

The published site only ever uses the demo wallet and says so. It proves
itself to App Check with reCAPTCHA Enterprise; the App Check debug token is
never written into the site, and the build fails if it finds it there.

```bash
npm run deploy:site                                       # build, test, publish
SITE_URL=https://ibiti-guardian-chrome.web.app node test/site.mjs           # check the live site
SITE_URL=https://ibiti-guardian-chrome.web.app PHONE=1 node test/site.mjs   # on a phone screen
node test/cloud-live.mjs                                  # live cloud analysis via App Check
```

## Tests

```bash
npm test             # analyzer: decoding and risk rules; what prompts may send to the cloud
npm run test:e2e     # real Chrome: the extension, then the no-install site
```

`npm test` also checks Gemini's part (`test/reading.test.js`): every wrong
value of every field is caught for every kind of request; every high-risk
request carries a warning that stays on screen whatever the model picks; real
Gemini answers recorded live (`test/fixtures/real-forms.json`) get the
verdict they deserve; and two blind sets of right and wrong answers, written
by an author who never saw the checks, stay caught
(`test/fixtures/forms-set-*.json`).

The end-to-end tests check that a held request does not reach the wallet,
that Reject returns error 4001, that Continue forwards the request byte for
byte, that closing the window or losing contact with the extension refuses
the request, and that nothing is sent to the cloud before the user asks.
With a stand-in for Gemini Nano they check what the window shows for a right
reading, a reading that picks no warning, a swapped role, a swapped
direction, an answer with words of its own, and an answer that is not the
form: the warnings always stay, a wrong reading is never used, and no word
of the model reaches the screen.
They also check the unfriendly cases: a wallet that replaces its own
`request()` after start-up stays guarded (`test/swap.mjs`), and a page cannot
change a request while it is being reviewed, hide the method behind a getter,
or slip a transaction through in a batch (`test/tamper.mjs`). `test/site.mjs`
runs all ten scenarios on the hosted demo, on desktop and phone screens.

By hand, with a real browser wallet on test networks: Reject kept the request
from the wallet; Continue delivered the same request to it.

## How it works

- `src/inpage.js` runs in the page before any site script and wraps wallet
  providers (`window.ethereum`, EIP-6963). Guarded methods are accessors, so a
  wallet that replaces its own `request()` later stays guarded. Guardian
  reviews and forwards its own copy of the request.
- `src/bridge.js` and `src/background.js` carry the request to Guardian's own
  window, which the site cannot touch. If that window is closed or the
  extension cannot be reached, the request is refused, never passed.
- `src/analyzer/` decodes the request without AI.
- `src/review.js` is the review window; `src/host.js` lets the same window run
  in the extension and in the hosted preview (`src/web/panel.js`).
- `src/ai/` is the hybrid inference: `engine.js` (the three modes),
  `prompt.js` (prompts from facts only), `appcheck.*.js` (App Check per build).

## Privacy

On-device by default. The cloud is contacted only after an explicit choice:
the one-time permission for computers without Gemini Nano (switched off again
in the toolbar panel; on the hosted demo it lasts for the visit), or the
**Ask cloud AI** button. It receives the decoded facts of the request — the
site, the action, the token, the amount, the other party's address — never
the user's own address or balance. Guardian has no server of its own and keeps
no history.

To describe a request, Guardian reads public context through your wallet's
own connection, the way the wallet itself would: whether the other party is a
contract, the token's symbol and decimals, and your balance of what is being
moved.

## Limits

Guardian wraps the standard provider API. A site that talks to a wallet
through a private channel instead is not covered, and the wallet's own
confirmation remains the last line of defense.

## License

Apache-2.0
