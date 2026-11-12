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
      toHex(`opensea.io wants you to sign in with your Ethereum account:\n${ME}\n\nNonce: 77aa01`),
      ME,
    ],
  }),
};

const logEl = document.getElementById('log');

// Is anything standing between this site and the wallet?
const guardEl = document.getElementById('guard');
if (window.__ibitiGuardianPreview) {
  guardEl.textContent = 'Guardian preview is on: nothing to install';
  guardEl.dataset.state = 'on';
} else if (window.__ibitiGuardian) {
  guardEl.textContent = 'IBITI Guardian extension is on';
  guardEl.dataset.state = 'on';
} else {
  guardEl.textContent = 'Guardian is off: requests go straight to the wallet';
  guardEl.dataset.state = 'off';
}
const state = (window.__dapp = { last: null, history: [], wallets: [] });

// ── Which wallet ───────────────────────────────────────────────────────────
// With several wallets installed, window.ethereum belongs to whichever one
// grabbed it last. Modern sites ask every wallet to introduce itself
// (EIP-6963) and let the person choose; this page does the same.
const wallets = new Map(); // rdns → { info, provider }
const pickEl = document.getElementById('pick');
const walletEl = document.getElementById('wallet');
let chosen = null; // rdns chosen by the person, if any

function currentWallet() {
  if (chosen && wallets.has(chosen)) return wallets.get(chosen);
  const demo = wallets.get('dev.ibiti.demo-wallet');
  if (demo) return demo;
  const metamask = wallets.get('io.metamask');
  if (metamask) return metamask;
  const first = wallets.values().next().value;
  if (first) return first;
  return window.ethereum ? { info: { name: 'Browser wallet', rdns: '' }, provider: window.ethereum } : null;
}

function renderWallets() {
  state.wallets = Array.from(wallets.values(), (w) => w.info.rdns);
  const current = currentWallet();
  pickEl.replaceChildren();
  for (const { info } of wallets.values()) {
    const option = document.createElement('option');
    option.value = info.rdns;
    option.textContent = info.name;
    option.selected = Boolean(current) && current.info.rdns === info.rdns;
    pickEl.append(option);
  }
  pickEl.hidden = wallets.size < 2;
  state.wallet = current ? current.info.rdns : null;
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
  walletEl.textContent = 'Not connected.';
});

function report(entry) {
  state.last = entry;
  state.history.push(entry);
  const line = document.createElement('div');
  line.className = `line ${entry.ok ? 'ok' : 'blocked'}`;
  line.textContent = entry.ok
    ? `${entry.scenario}: the wallet received the request`
    : `${entry.scenario}: stopped (${entry.code ?? 'error'}) ${entry.message}`;
  logEl.prepend(line);
}

async function run(scenario) {
  const wallet = currentWallet();
  if (!wallet) {
    report({ scenario, ok: false, message: 'No wallet found. Open this page with ?mock=1 to use the demo wallet.' });
    return;
  }
  const provider = wallet.provider;
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

const CHAIN_NAMES = { 1: 'Ethereum mainnet', 11155111: 'Sepolia test network' };

async function connect() {
  const wallet = currentWallet();
  if (!wallet) {
    walletEl.textContent = 'No wallet found. Add ?mock=1 to the address to use the demo wallet.';
    return;
  }
  const provider = wallet.provider;
  try {
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (accounts && accounts[0]) ME = accounts[0];
    const chainId = parseInt(await provider.request({ method: 'eth_chainId' }), 16);
    walletEl.textContent = `Connected with ${wallet.info.name}: ${ME.slice(0, 6)}…${ME.slice(-4)} on ${CHAIN_NAMES[chainId] || `chain ${chainId}`}`;
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
if (window.ethereum && window.ethereum.isMockWallet) connect();
