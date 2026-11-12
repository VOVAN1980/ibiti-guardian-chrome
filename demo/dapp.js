// Demo site: every button sends one kind of wallet request, the way real
// sites (and real drainers) do. Nothing here touches real funds when the demo
// wallet is used.

// The connected account. Until a wallet is connected, the demo wallet's address.
let ME = '0x1111111111111111111111111111111111111111';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const FAKE_USDT = '0x00000000000000000000000000000000DeaDBeef';
const NFT = '0x2222222222222222222222222222222222222222';
const ATTACKER = '0x9F3a00000000000000000000000000000000c21E';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const MAX = 'f'.repeat(64);

const pad = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const uint = (n) => BigInt(n).toString(16).padStart(64, '0');
const toHex = (text) =>
  '0x' + Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('');

const sendTx = (to, data, value) => ({
  method: 'eth_sendTransaction',
  params: [{ from: ME, to, data, ...(value ? { value } : {}) }],
});

const SCENARIOS = {
  claim: () => sendTx(USDT, `0x095ea7b3${pad(ATTACKER)}${MAX}`),
  fake: () => sendTx(FAKE_USDT, `0x095ea7b3${pad(ATTACKER)}${uint(1000000n)}`),
  limited: () => sendTx(USDC, `0x095ea7b3${pad(PERMIT2)}${uint(25_000_000n)}`),
  nft: () => sendTx(NFT, `0xa22cb465${pad(ATTACKER)}${uint(1)}`),
  transfer: () => sendTx(ATTACKER, '0x', '0x2386f26fc10000'),
  revoke: () => sendTx(USDT, `0x095ea7b3${pad(ATTACKER)}${uint(0)}`),
  blind: () => ({ method: 'eth_sign', params: [ME, '0x' + '5a'.repeat(32)] }),
  permit: () => ({
    method: 'eth_signTypedData_v4',
    params: [
      ME,
      JSON.stringify({
        types: {},
        primaryType: 'Permit',
        domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC },
        message: {
          owner: ME,
          spender: ATTACKER,
          value: BigInt('0x' + MAX).toString(),
          nonce: 0,
          deadline: 4102444800,
        },
      }),
    ],
  }),
  signin: () => ({
    method: 'personal_sign',
    params: [
      toHex(
        `${location.host} wants you to sign in with your Ethereum account:\n${ME}\n\nSign in to the demo.\n\nNonce: 8f2c1d`,
      ),
      ME,
    ],
  }),
  phish: () => ({
    method: 'personal_sign',
    params: [
      toHex(`nft-market.example wants you to sign in with your Ethereum account:\n${ME}\n\nNonce: 77aa01`),
      ME,
    ],
  }),
};

const logEl = document.getElementById('log');

const query = new URLSearchParams(location.search);

// Is anything standing between this site and the wallet?
const guardEl = document.getElementById('guard');
const toggleEl = document.getElementById('guard-toggle');
const preview = Boolean(window.__ibitiGuardianPreview);
const guarded = preview || Boolean(window.__ibitiGuardian);
if (!guarded || preview) {
  // The preview can be left out, to compare. An installed extension cannot
  // be switched off by a page, which is the point of it.
  const url = new URL(location.href);
  if (preview) url.searchParams.set('guardian', 'off');
  else url.searchParams.delete('guardian');
  toggleEl.href = url.href;
  toggleEl.textContent = preview ? 'Turn Guardian off to see the difference.' : 'Turn Guardian back on.';
  toggleEl.hidden = false;
}
guardEl.dataset.state = guarded ? 'on' : 'off';
guardEl.textContent = preview
  ? 'Guardian is on (preview, nothing to install)'
  : guarded
    ? 'IBITI Guardian extension is on'
    : 'Guardian is off: requests go straight to the wallet';
const state = (window.__dapp = { last: null, history: [], wallets: [] });

// ── Which wallet ───────────────────────────────────────────────────────────
// With several wallets installed, window.ethereum belongs to whichever one
// grabbed it last. Modern sites ask every wallet to introduce itself
// (EIP-6963) and let the person choose; this page does the same.
const wallets = new Map(); // rdns → { info, provider }
const pickEl = document.getElementById('pick');
const walletEl = document.getElementById('wallet');
let chosen = null; // rdns chosen by the person, if any

const DEMO_WALLET = 'dev.ibiti.demo-wallet';
// The published playground is a simulation: it only ever talks to the demo
// wallet, whatever else is installed. (Set by the build for dist/site.)
const PUBLIC = window.__playgroundPublic === true;
// Locally, the demo wallet is the default too; ?wallet=real starts with an
// installed wallet instead, for testing the extension with a real one.
const preferReal = !PUBLIC && query.get('wallet') === 'real';
state.public = PUBLIC;

function currentWallet() {
  const demo = wallets.get(DEMO_WALLET);
  if (PUBLIC) return demo || null;
  if (chosen && wallets.has(chosen)) return wallets.get(chosen);
  const real =
    wallets.get('io.metamask') || Array.from(wallets.values()).find((w) => w.info.rdns !== DEMO_WALLET);
  const first = preferReal ? real || demo : demo || real;
  if (first) return first;
  return window.ethereum ? { info: { name: 'Browser wallet', rdns: '' }, provider: window.ethereum } : null;
}

const isDemo = (wallet) => Boolean(wallet) && wallet.info.rdns === DEMO_WALLET;
let shown = null; // the wallet the controls below were last drawn for
let SIM_TEXT = null; // the page's own "Simulation" note, kept to restore it

function renderWallets() {
  state.wallets = Array.from(wallets.values(), (w) => w.info.rdns);
  const current = currentWallet();
  pickEl.replaceChildren();
  for (const { info } of wallets.values()) {
    const option = document.createElement('option');
    option.value = info.rdns;
    option.textContent = info.rdns === DEMO_WALLET ? 'Demo wallet (no keys, nothing real)' : info.name;
    option.selected = Boolean(current) && current.info.rdns === info.rdns;
    pickEl.append(option);
  }
  pickEl.hidden = PUBLIC || wallets.size < 2;
  state.wallet = current ? current.info.rdns : null;
  document.getElementById('wallet-section').hidden = PUBLIC;

  // Say plainly which wallet this page is talking to: the "Simulation" note
  // is true only for the demo wallet.
  const simEl = document.getElementById('sim');
  const simText = document.getElementById('sim-text');
  if (!SIM_TEXT) SIM_TEXT = Array.from(simText.childNodes, (node) => node.cloneNode(true));
  if (current && !isDemo(current)) {
    simEl.dataset.real = '';
    simText.replaceChildren();
    const title = document.createElement('b');
    title.textContent = 'Real wallet test (local page).';
    simText.append(
      title,
      ` This page is talking to ${current.info.name}, not to the demo wallet. It sends requests only while the wallet is on a test network. In the wallet, always press Reject: these are examples of what not to sign.`,
    );
    document.title = `Guardian local test: ${current.info.name}`;
  } else if (simEl.dataset.real !== undefined) {
    delete simEl.dataset.real;
    simText.replaceChildren(...SIM_TEXT.map((node) => node.cloneNode(true)));
    document.title = 'IBITI Guardian playground';
  }

  // The demo wallet needs no connecting and has no networks to switch.
  document.getElementById('connect').hidden = isDemo(current);
  document.getElementById('testnet').hidden = isDemo(current);
  document.getElementById('real-note').hidden = !current || isDemo(current);
  if (current && current.provider !== shown) {
    shown = current.provider;
    walletEl.textContent = 'Not connected.';
    if (isDemo(current)) connect();
  }
}

window.addEventListener('eip6963:announceProvider', (event) => {
  const detail = event.detail;
  if (!detail || !detail.info || !detail.provider || typeof detail.info.rdns !== 'string') return;
  wallets.set(detail.info.rdns, { info: detail.info, provider: detail.provider });
  renderWallets();
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

pickEl.addEventListener('change', () => {
  chosen = pickEl.value;
  renderWallets();
});

function report(entry) {
  state.last = entry;
  state.history.push(entry);
  const button = document.querySelector(`[data-scenario="${entry.scenario}"]`);
  const name = button ? button.textContent.trim() : entry.scenario;
  const line = document.createElement('div');
  if (entry.ok) {
    line.className = `line ${guarded ? 'passed' : 'unguarded'}`;
    const where = isDemo(currentWallet()) ? 'the demo wallet' : 'the wallet';
    line.textContent = guarded
      ? `${name}: reached ${where}, after you let it through`
      : `${name}: reached ${where} with nothing in between`;
  } else if (entry.code === 'not sent') {
    line.className = 'line wallet';
    line.textContent = `${name}: not sent. ${entry.message}`;
  } else if (/^IBITI Guardian/.test(entry.message)) {
    line.className = 'line stopped';
    line.textContent = `${name}: stopped by Guardian. The ${isDemo(currentWallet()) ? 'demo ' : ''}wallet never saw it.`;
  } else {
    line.className = 'line wallet';
    line.textContent = `${name}: not signed (${entry.code ?? 'error'}) ${entry.message}`;
  }
  logEl.prepend(line);
}

async function run(scenario) {
  const wallet = currentWallet();
  if (!wallet) {
    report({ scenario, ok: false, message: 'No wallet found.' });
    return;
  }
  const provider = wallet.provider;
  // These are examples of what not to sign. A real wallet gets them only on a
  // test network, so a wrong click here can never cost real money.
  if (!isDemo(wallet)) {
    let chainId = NaN;
    try {
      chainId = parseInt(await provider.request({ method: 'eth_chainId' }), 16);
    } catch {
      // unknown network: treated as real
    }
    if (!TESTNETS[chainId]) {
      report({
        scenario,
        ok: false,
        code: 'not sent',
        message: `${wallet.info.name} is on ${chainName(chainId)}. Switch it to a test network first: the demo sends nothing to a real network.`,
      });
      return;
    }
  }
  try {
    const request = SCENARIOS[scenario]();
    state.sent = JSON.parse(JSON.stringify(request)); // what the site asked for
    const result = await provider.request(request);
    report({ scenario, ok: true, result });
  } catch (error) {
    report({ scenario, ok: false, code: error && error.code, message: String((error && error.message) || error) });
  }
}

for (const button of document.querySelectorAll('[data-scenario]')) {
  button.addEventListener('click', () => run(button.dataset.scenario));
}

// ── Real wallets: connect first, and prefer a test network ────────────────

const TESTNETS = {
  11155111: 'Sepolia test network',
  17000: 'Holesky test network',
  97: 'BNB Chain test network',
  80002: 'Polygon Amoy test network',
  421614: 'Arbitrum Sepolia test network',
  84532: 'Base Sepolia test network',
  11155420: 'Optimism Sepolia test network',
};
const MAINNETS = { 1: 'Ethereum mainnet', 56: 'BNB Chain', 137: 'Polygon', 42161: 'Arbitrum', 8453: 'Base', 10: 'Optimism' };
const chainName = (id) =>
  TESTNETS[id] || MAINNETS[id] || (Number.isFinite(id) ? `chain ${id}` : 'an unknown network');

async function connect() {
  const wallet = currentWallet();
  if (!wallet) {
    walletEl.textContent = 'No wallet found.';
    return;
  }
  const provider = wallet.provider;
  try {
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (accounts && accounts[0]) ME = accounts[0];
    const chainId = parseInt(await provider.request({ method: 'eth_chainId' }), 16);
    walletEl.textContent = isDemo(wallet)
      ? 'Demo wallet: no keys, no real funds. It only records which requests reach it.'
      : `Connected with ${wallet.info.name}: ${ME.slice(0, 6)}…${ME.slice(-4)} on ${chainName(chainId)}${
          TESTNETS[chainId] ? ' (test network, ready)' : '. Real network: the buttons above will not send anything until you switch to a test network.'
        }`;
    state.account = ME;
    state.chainId = chainId;
  } catch (error) {
    walletEl.textContent = `Not connected: ${String((error && error.message) || error)}`;
  }
}

async function useTestnet() {
  const wallet = currentWallet();
  if (!wallet) return;
  try {
    await wallet.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] });
    await connect();
  } catch (error) {
    walletEl.textContent = `Could not switch network: ${String((error && error.message) || error)}`;
  }
}

document.getElementById('connect').addEventListener('click', connect);
document.getElementById('testnet').addEventListener('click', useTestnet);
renderWallets();
