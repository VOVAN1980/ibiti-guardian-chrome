// Small built-in registries. A token that only *calls itself* USDT is not USDT:
// "verified" below means the contract address matches this list.

export const CHAINS = {
  1: { name: 'Ethereum', native: 'ETH' },
  56: { name: 'BNB Chain', native: 'BNB' },
  137: { name: 'Polygon', native: 'POL' },
  42161: { name: 'Arbitrum', native: 'ETH' },
  8453: { name: 'Base', native: 'ETH' },
  10: { name: 'Optimism', native: 'ETH' },
  11155111: { name: 'Sepolia testnet', native: 'ETH' },
};

const token = (symbol, name, decimals) => ({ symbol, name, decimals });

/** chainId → lowercase address → token */
export const TOKENS = {
  1: {
    '0xdac17f958d2ee523a2206206994597c13d831ec7': token('USDT', 'Tether USD', 6),
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': token('USDC', 'USD Coin', 6),
    '0x6b175474e89094c44da98b954eedeac495271d0f': token('DAI', 'Dai Stablecoin', 18),
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': token('WETH', 'Wrapped Ether', 18),
  },
  56: {
    '0x55d398326f99059ff775485246999027b3197955': token('USDT', 'Tether USD', 18),
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': token('USDC', 'USD Coin', 18),
  },
  137: {
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': token('USDT', 'Tether USD', 6),
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': token('USDC', 'USD Coin', 6),
  },
  42161: {
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': token('USDT', 'Tether USD', 6),
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': token('USDC', 'USD Coin', 6),
  },
  8453: {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': token('USDC', 'USD Coin', 6),
  },
};

/** Widely used contracts that legitimately ask for approvals (any chain). */
export const KNOWN_SPENDERS = {
  '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Uniswap Permit2',
  '0x0000000000001ff3684f28c67538d4d072c22734': '0x AllowanceHolder',
  '0x111111125421ca6dc452d289314280a0f8842a65': '1inch Aggregation Router v6',
};

export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';

export function chainInfo(chainId) {
  return CHAINS[chainId] || { name: `chain ${chainId ?? 'unknown'}`, native: 'native coin' };
}

export function knownToken(chainId, address) {
  const list = TOKENS[chainId];
  return (list && address && list[address.toLowerCase()]) || null;
}

export function knownSpender(address) {
  return (address && KNOWN_SPENDERS[address.toLowerCase()]) || null;
}
