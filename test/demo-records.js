// The demo page's ten requests (demo/dapp.js), as the demo wallet answers
// Guardian's context reads (test/fixtures answers were recorded on this page).
export const ME = '0x1111111111111111111111111111111111111111';
export const HOST = '127.0.0.1:5179';

const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const FAKE_USDT = '0x00000000000000000000000000000000DeaDBeef';
const NFT = '0x2222222222222222222222222222222222222222';
const ATTACKER = '0x9F3a00000000000000000000000000000000c21E';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const MAX = 'f'.repeat(64);
const pad = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const uint = (n) => BigInt(n).toString(16).padStart(64, '0');
const toHex = (text) => `0x${Buffer.from(text).toString('hex')}`;
const base = { chainId: 1, origin: `http://${HOST}` };
const send = (to, data, value, enrich) => ({
  ...base,
  method: 'eth_sendTransaction',
  params: [{ from: ME, to, data, ...(value ? { value } : {}) }],
  ...(enrich ? { enrich } : {}),
});

// The standard EIP-712 types of each permit, as a wallet needs them to sign
// (and as the analyzer reads a permit: only through them).
const fields = (spec) =>
  spec.split(',').map((f) => {
    const [type, name] = f.split(' ');
    return { name, type };
  });
const DETAILS = fields('address token,uint160 amount,uint48 expiration,uint48 nonce');
const TOKEN_PERMISSIONS = fields('address token,uint256 amount');
const TAKE = 'permitted,address spender,uint256 nonce,uint256 deadline';
export const PERMIT_TYPES = {
  Permit: { Permit: fields('address owner,address spender,uint256 value,uint256 nonce,uint256 deadline') },
  DaiPermit: { Permit: fields('address holder,address spender,uint256 nonce,uint256 expiry,bool allowed') },
  // EIP-4494: one item of an NFT collection (Uniswap V3 positions).
  NftPermit: { Permit: fields('address spender,uint256 tokenId,uint256 nonce,uint256 deadline') },
  PermitSingle: { PermitSingle: fields('PermitDetails details,address spender,uint256 sigDeadline'), PermitDetails: DETAILS },
  PermitBatch: { PermitBatch: fields('PermitDetails[] details,address spender,uint256 sigDeadline'), PermitDetails: DETAILS },
  PermitTransferFrom: { PermitTransferFrom: fields(`TokenPermissions ${TAKE}`), TokenPermissions: TOKEN_PERMISSIONS },
  PermitBatchTransferFrom: { PermitBatchTransferFrom: fields(`TokenPermissions[] ${TAKE}`), TokenPermissions: TOKEN_PERMISSIONS },
  PermitWitnessTransferFrom: {
    PermitWitnessTransferFrom: fields(`TokenPermissions ${TAKE},Witness witness`),
    TokenPermissions: TOKEN_PERMISSIONS,
    Witness: [],
  },
};
const DOMAIN_TYPES = { name: 'string', version: 'string', chainId: 'uint256', verifyingContract: 'address' };

/**
 * Typed data as a dapp sends it: the standard types of its primary type (or
 * of `form`, e.g. 'DaiPermit'), and an EIP712Domain for the domain it has.
 */
export function typedData(primaryType, domain, message, form = primaryType) {
  return {
    types: {
      EIP712Domain: Object.keys(domain)
        .filter((name) => name in DOMAIN_TYPES)
        .map((name) => ({ name, type: DOMAIN_TYPES[name] })),
      ...PERMIT_TYPES[form],
    },
    primaryType,
    domain,
    message,
  };
}

export const DEMO_RECORDS = {
  claim: send(USDT, `0x095ea7b3${pad(ATTACKER)}${MAX}`, null, { spenderIsContract: false }),
  fake: send(FAKE_USDT, `0x095ea7b3${pad(ATTACKER)}${uint(1000000n)}`, null, {
    spenderIsContract: false,
    token: { symbol: 'USDT', decimals: 6 },
  }),
  limited: send(USDC, `0x095ea7b3${pad(PERMIT2)}${uint(25_000_000n)}`),
  nft: send(NFT, `0xa22cb465${pad(ATTACKER)}${uint(1)}`, null, { spenderIsContract: false }),
  transfer: send(ATTACKER, '0x', '0x2386f26fc10000', { balance: '0x1bc16d674ec80000' }),
  revoke: send(USDT, `0x095ea7b3${pad(ATTACKER)}${uint(0)}`),
  blind: { ...base, method: 'eth_sign', params: [ME, `0x${'5a'.repeat(32)}`] },
  permit: {
    ...base,
    method: 'eth_signTypedData_v4',
    params: [
      ME,
      JSON.stringify(
        typedData(
          'Permit',
          { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC },
          { owner: ME, spender: ATTACKER, value: BigInt(`0x${MAX}`).toString(), nonce: 0, deadline: 4102444800 },
        ),
      ),
    ],
    enrich: { spenderIsContract: false },
  },
  signin: {
    ...base,
    method: 'personal_sign',
    params: [toHex(`${HOST} wants you to sign in with your Ethereum account:\n${ME}\n\nSign in to the demo.\n\nNonce: 8f2c1d`), ME],
  },
  phish: {
    ...base,
    method: 'personal_sign',
    params: [toHex(`nft-market.example wants you to sign in with your Ethereum account:\n${ME}\n\nNonce: 77aa01`), ME],
  },
};
