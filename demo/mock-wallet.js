// A pretend wallet for the demo and for automated tests. It holds no keys and
// sends nothing anywhere: it only records what reaches it, so you can see
// whether Guardian let a request through.

(() => {
  const ACCOUNT = '0x1111111111111111111111111111111111111111';
  const log = (window.__mockWalletLog = []);

  const TOKENS = {
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
    // A fake token that names itself USDT.
    '0x00000000000000000000000000000000deadbeef': { symbol: 'USDT', decimals: 6 },
  };
  // Addresses the demo treats as contracts; everything else is a personal wallet.
  const CONTRACTS = new Set(['0x000000000022d473030f116ddee9f6b43ac78ba3']);

  const abiString = (text) => {
    const hex = Array.from(text, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    return (
      '0x' +
      '20'.padStart(64, '0') +
      text.length.toString(16).padStart(64, '0') +
      hex.padEnd(64, '0')
    );
  };

  const provider = {
    isMockWallet: true,
    async request({ method, params = [] }) {
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [ACCOUNT];
        case 'eth_chainId':
          return '0x1';
        case 'eth_getCode':
          return CONTRACTS.has(String(params[0]).toLowerCase()) ? '0x6080' : '0x';
        case 'eth_call': {
          const call = params[0] || {};
          const token = TOKENS[String(call.to).toLowerCase()];
          if (!token) return '0x';
          if (call.data === '0x95d89b41') return abiString(token.symbol);
          if (call.data === '0x313ce567') return '0x' + token.decimals.toString(16).padStart(64, '0');
          return '0x';
        }
        case 'eth_sendTransaction':
        case 'wallet_sendCalls':
          log.push({ method, params });
          return '0x' + 'ab'.repeat(32);
        case 'personal_sign':
        case 'eth_sign':
        case 'eth_signTypedData_v4':
          log.push({ method, params });
          return '0x' + 'cd'.repeat(65);
        default:
          throw Object.assign(new Error(`Mock wallet: unsupported method ${method}`), { code: 4200 });
      }
    },
    on() {},
    removeListener() {},
  };

  window.ethereum = provider;

  const announce = () =>
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({
          info: {
            uuid: '5b6f0c0e-0000-4000-8000-000000000001',
            name: 'Demo Wallet',
            icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
            rdns: 'dev.ibiti.demo-wallet',
          },
          provider,
        }),
      }),
    );
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
})();
