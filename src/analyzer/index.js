// Deterministic request analyzer: turns a wallet request into verifiable facts
// and a risk level. No AI here. The model later explains these facts in plain
// language; it never decides what the request is or how risky it is.
//
// What the page says about the wallet (the network, the accounts, the
// balance, a token's symbol and decimals: req.chainId and req.enrich) is read
// through the page's own provider, so a hostile page can answer it itself.
// A balance or the accounts may add risk, never make a request look safer: a
// balance can only raise the risk, and "this wallet" is only the account the
// request itself names (the wallet enforces that one). The network and a
// token's decimals are taken as reported (README, Limits): a test network or
// one Guardian does not know, when the request does not name it, is shown as
// unconfirmed, decimals a token reports about itself are marked unverified,
// and no decimals move the "Unlimited" line above 2^128 base units. What the
// request itself says (an amount, an address) is what the wallet acts on. A
// request Guardian cannot read in full, or that is not in the standard form,
// says so and is never shown as harmless.

import {
  UNLIMITED_THRESHOLD,
  formatUnits,
  hexToText,
  isAddress,
  isHex,
  normAddress,
  selectorOf,
  shortAddress,
  strip0x,
  toBigInt,
  uintOf,
  word,
  wordToAddress,
  wordToBigInt,
} from './abi.js';
import { CHAINS, PERMIT2, chainInfo, knownSpender, knownToken } from './registry.js';
import { cleanPromise, readButton } from './promise.js';

const SELECTOR = {
  approve: '0x095ea7b3',
  increaseAllowance: '0x39509351',
  setApprovalForAll: '0xa22cb465',
  transfer: '0xa9059cbb',
  transferFrom: '0x23b872dd',
  permit2Approve: '0x87517c45',
};

const RISK_ORDER = { info: 0, caution: 1, danger: 2 };

// A result's `warnings` are the reasons Guardian always shows first, with or
// without AI: each of them alone is enough to make a request high risk (or
// sends coins the user may not expect). An AI may add emphasis to other
// reasons; it can never hide these.
const BLIND_SIGN =
  'This method signs data you cannot read. The signature can authorize any transaction from your wallet.';
const PERSONAL_WALLET =
  'The spender is a personal wallet, not a contract. Real apps ask you to approve their contract, almost never a person.';
const NONSTANDARD =
  'This transaction is not in the standard form. Guardian cannot read it, and your wallet may read it differently: it could do something other than what it seems.';
const DELEGATION =
  'This would hand control of your account to contract code (EIP-7702). That code could move everything you hold, now or later.';
const CANNOT_READ =
  'Guardian cannot read this request, so it cannot tell what it allows. Check it carefully in your wallet before you confirm.';
const SIGN_ONLY =
  'This only signs the transaction: the site gets it back and can send it whenever it chooses, while it stays valid.';
const MAYBE_ITEM =
  'If this contract is a token, this sets the spender’s allowance to zero: a revoke. If it is an NFT collection, the spender could take your item #0. Guardian cannot tell which.';
const ODD_ACCOUNT =
  'The account in this request is not written the standard way (0x and 40 hex digits), so wallets may differ on which part of it they sign.';
const TWO_WAYS =
  'The message is written only in hex digits, so wallets read it in two ways: some sign the data the digits stand for, others the digits as text. Guardian cannot tell which your wallet signs.';
const STABLE_SYMBOLS = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'FDUSD', 'TUSD']);
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function maxRisk(a, b) {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/**
 * @param {object} req
 * @param {string} req.method   EIP-1193 method
 * @param {Array}  req.params
 * @param {number|null} [req.chainId]
 * @param {string} [req.origin] origin of the page that asked
 * @param {object} [req.enrich] on-chain reads made through the page's provider
 *   (so only hints the page could forge): { token: {symbol, decimals},
 *   spenderIsContract: boolean|null, accounts: string[], balance, tokenBalance }
 * @param {object} [req.promise] the button the user pressed just before the
 *   request, as the in-page guard saw it: { button, title, heading, ageMs }
 */
export function analyze(req) {
  const result = decode(req);
  // Every result lists its warnings, even when there are none.
  return withPromise({ ...result, warnings: result.warnings || [] }, cleanPromise(req.promise));
}

/**
 * The words of the button the user pressed, among the facts; a warning when
 * what they offer plainly contradicts the request (src/analyzer/promise.js).
 */
function withPromise(result, promise) {
  if (!promise) return result;
  const { offers, offer, clash } = readButton(promise.button, result);
  // After the action (or every numbered action or token of a batch).
  const facts = [...result.facts];
  let at = 0;
  while (at < facts.length && /^(?:Action|Token) \d+$/.test(facts[at].label)) at += 1;
  facts.splice(Math.max(at, 1), 0, fact('Button pressed', promise.button, clash ? { tone: 'danger' } : {}));
  return {
    ...result,
    risk: clash ? 'danger' : result.risk,
    facts,
    reasons: clash ? [clash, ...result.reasons] : result.reasons,
    warnings: clash ? [clash, ...result.warnings] : result.warnings,
    subject: { ...result.subject, promise: { ...promise, offer, offers, clash: Boolean(clash) } },
  };
}

function decode(req) {
  const ctx = {
    // As the page reported it (eth_chainId): unconfirmed until the request
    // names the same network itself.
    chainId: typeof req.chainId === 'number' ? req.chainId : null,
    chainConfirmed: false,
    origin: req.origin || '',
    enrich: req.enrich || {},
    // Who "you" are: the account that sends or signs the request. The wallet
    // makes sure it is the user's; the accounts the page reported are not.
    self: new Set(signerAddresses(req)),
    // The accounts the page reported (eth_accounts), used only where they add
    // risk: tokens taken from one of them are taken from the user.
    reported: new Set(reportedAccounts(req)),
  };
  const params = Array.isArray(req.params) ? req.params : [];

  switch (req.method) {
    case 'eth_sendTransaction':
      return analyzeTransaction(params[0], ctx);
    case 'eth_signTransaction':
      return signedForLater(analyzeTransaction(params[0], ctx));
    case 'wallet_sendCalls':
      return analyzeBatch(params[0] || {}, ctx);
    case 'eth_signTypedData_v4':
    case 'eth_signTypedData_v3':
      return analyzeTypedData(params[1], ctx);
    case 'eth_signTypedData':
    case 'eth_signTypedData_v1':
      return analyzeTypedData(isAddress(params[0]) ? params[1] : params[0], ctx);
    case 'personal_sign':
      return personalSign(params, ctx);
    case 'eth_sign':
      return {
        kind: 'blindSign',
        risk: 'danger',
        headline: 'Blind signature request',
        facts: [
          fact('Action', 'Sign raw data (eth_sign)'),
          fact('Data', String(params[1] ?? ''), { mono: true }),
        ],
        reasons: [BLIND_SIGN, 'Legitimate apps no longer use it; most wallets disable it by default.'],
        warnings: [BLIND_SIGN],
        subject: { action: 'eth_sign' },
      };
    default:
      return cannotRead(String(req.method));
  }
}

// Requests for lasting permissions (ERC-7715), and requests to a wallet's
// plug-ins (MetaMask Snaps), which can sign for other networks.
const PERMISSION_METHODS = new Set(['wallet_grantPermissions', 'wallet_requestExecutionPermissions']);
const SNAP_METHODS = new Set(['wallet_invokeSnap', 'wallet_snap', 'wallet_requestSnaps']);

/**
 * A request Guardian has no decoder for. It says so, and never that there is
 * nothing to worry about; a request for lasting permissions is high risk.
 */
function cannotRead(method) {
  const facts = [fact('Method', method.slice(0, 64), { mono: true })];
  const subject = { action: method };
  if (PERMISSION_METHODS.has(method)) {
    const grant =
      'This asks your wallet to give the site lasting permissions, for example to spend your tokens without asking you each time. Guardian cannot read which ones.';
    return {
      kind: 'unknown',
      risk: 'danger',
      headline: 'Permission request Guardian cannot read',
      facts: [fact('Action', 'Give the site permissions'), ...facts],
      reasons: [grant, CANNOT_READ],
      warnings: [grant],
      subject,
    };
  }
  if (SNAP_METHODS.has(method)) {
    return {
      kind: 'unknown',
      risk: 'caution',
      headline: 'Request to a wallet plug-in Guardian cannot read',
      facts: [fact('Action', 'Ask a plug-in of your wallet (a Snap) to act'), ...facts],
      reasons: ['A plug-in of your wallet can sign for other networks, and Guardian cannot read what this one would do.', CANNOT_READ],
      subject,
    };
  }
  return { kind: 'unknown', risk: 'caution', headline: 'Wallet request Guardian cannot read', facts, reasons: [CANNOT_READ], subject };
}

/** eth_signTransaction: the same transaction, signed now and sent by the site later. */
function signedForLater(result) {
  const facts = [...result.facts];
  facts.splice(1, 0, fact('Sent', 'Later, by the site: you only sign it now', { tone: 'caution' }));
  return {
    ...result,
    risk: maxRisk(result.risk, 'caution'),
    facts,
    reasons: [...result.reasons, SIGN_ONLY],
    subject: { ...result.subject, signOnly: true },
  };
}

// ── Networks ───────────────────────────────────────────────────────────────

/** A network a request names itself (tx.chainId, a batch's or a domain's), or null. */
function chainIdOf(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value === 'string' && /^(?:0x[0-9a-fA-F]{1,13}|\d{1,15})$/.test(value)) return Number(value) || null;
  return null;
}

/** The context on the network the request names, if it names one: that one is confirmed. */
function withChain(ctx, own) {
  return own === null ? ctx : { ...ctx, chainId: own, chainConfirmed: true };
}

/** Whether the registry knows this network (a main network or a test network). */
const knownChain = (chainId) => chainId !== null && Object.prototype.hasOwnProperty.call(CHAINS, chainId);

/**
 * The Network fact. A network only the page named is shown as it is, unless
 * that could lower the user's concern: a test network ("it's only a
 * testnet") or one Guardian does not know is unconfirmed until the request
 * names it itself.
 */
function networkFact(ctx) {
  const chain = chainInfo(ctx.chainId);
  const doubtful = ctx.chainId !== null && !ctx.chainConfirmed && (!knownChain(ctx.chainId) || Boolean(chain.testnet));
  return fact('Network', chain.name, doubtful ? { note: 'unconfirmed' } : {});
}

// ── Transactions ───────────────────────────────────────────────────────────

// Transaction fields that do not change what it does, or that Guardian reads.
// The wallet may act on any other one, so Guardian cannot read a request with it.
const TX_FIELDS = new Set([
  'from',
  'to',
  'data',
  'input',
  'value',
  'gas',
  'gasLimit',
  'gasPrice',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'nonce',
  'chainId',
  'type',
  'accessList',
]);
const given = (value) => value !== undefined && value !== null;
// A transaction type every wallet reads the same way: 0, 1 or 2, as 0x-hex or
// as a plain number. Celo's CIP-64 (0x7b) only with a fee token, as it needs one.
const knownType = (type, feeToken) =>
  (typeof type === 'number' && (type === 0 || type === 1 || type === 2 || (feeToken && type === 0x7b))) ||
  (typeof type === 'string' && (/^0x0*[0-2]$/.test(type) || (feeToken && /^0x0*7[bB]$/.test(type))));
// No coins, written plainly: 0 or "0" reads as nothing in every wallet.
const plainZero = (value) => value === 0 || (typeof value === 'string' && /^0+$/.test(value));
// Call data as every wallet reads it: 0x and whole bytes ('' is empty too).
const callData = (value) => (value === '' ? '0x' : typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value) ? value : null);
const isEmptyObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
// The coins a transaction sends, as the wallet reads its value: 0x-hex, at
// most 256 bits. Any other form is no coins here; analyzeTransaction says it
// cannot read it.
const coinsOf = (tx) =>
  Boolean(tx) && typeof tx === 'object' && typeof tx.value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(tx.value) ? BigInt(tx.value) : 0n;
/** Field names a page wrote, shown only if they are plain names. */
const fieldNames = (keys) =>
  `${keys
    .slice(0, 3)
    .map((k) => (/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k) ? k : '…'))
    .join(', ')}${keys.length > 3 ? ', …' : ''}`;

/**
 * A transaction, or one call of a batch (`call`). Only the standard form is
 * read: to, data, input and value as 0x-hex (and no coins written plainly as
 * 0). A wallet may fill in a missing 0x or read a decimal amount as hex, so a
 * field in any other form is never taken as empty, as a deployment or as no
 * coins: Guardian cannot read it.
 */
function analyzeTransaction(tx, outer, { call = false } = {}) {
  if (!tx || typeof tx !== 'object' || Array.isArray(tx)) return malformed('It is not a transaction', outer);
  // A call of a batch is sent on the batch's network (the wallet's, if the
  // batch names none), never on one it names itself: EIP-5792 calls name
  // none. A call that names another network cannot be read.
  const own = chainIdOf(tx.chainId);
  if (call && own !== null && outer.chainId !== null && own !== outer.chainId) {
    return malformed('Its network is not the one the batch is sent on', outer);
  }
  const ctx = call ? outer : withChain(outer, own);
  // EIP-7702: an authorization list hands the account to contract code.
  if (given(tx.authorizationList) || tx.type === 4 || /^0x0*4$/i.test(String(tx.type))) return delegation(tx.authorizationList, ctx);
  // Celo: the network fee paid in a token (feeCurrency). Not in a batch call.
  const feeToken = !call && given(tx.feeCurrency) ? tx.feeCurrency : null;
  const unknown = Object.keys(tx).filter(
    (key) =>
      given(tx[key]) &&
      !TX_FIELDS.has(key) &&
      !(key === 'feeCurrency' && feeToken !== null) &&
      !(call && key === 'capabilities' && isEmptyObject(tx[key])),
  );
  if (unknown.length > 0) return malformed(`It carries fields Guardian does not know: ${fieldNames(unknown)}`, ctx);
  if (feeToken !== null && !isAddress(feeToken)) return malformed('The token it pays the network fee in is not in the standard form', ctx);
  if (given(tx.type) && !knownType(tx.type, feeToken !== null)) return malformed('Its transaction type is not one Guardian knows', ctx);
  if (given(tx.to) && !isAddress(tx.to)) return malformed('The address it goes to is not in the standard form', ctx);
  for (const key of ['data', 'input']) {
    if (given(tx[key]) && callData(tx[key]) === null) return malformed(`Its call data (${key}) is not in the standard form`, ctx);
  }
  if (given(tx.data) && given(tx.input) && callData(tx.data).toLowerCase() !== callData(tx.input).toLowerCase()) {
    return malformed('It carries two different call data fields (data and input)', ctx);
  }
  if (
    given(tx.value) &&
    tx.value !== '' &&
    !plainZero(tx.value) &&
    !(typeof tx.value === 'string' && /^0x[0-9a-fA-F]{0,64}$/.test(tx.value))
  ) {
    return malformed('The amount of coins is not in the standard form', ctx);
  }

  const to = normAddress(tx.to);
  const data = given(tx.data) ? callData(tx.data) : given(tx.input) ? callData(tx.input) : '0x';
  const result = readTransaction(to, data, coinsOf(tx), ctx);
  if (feeToken !== null) return withFeeToken(result, normAddress(feeToken));
  // A batch's fee is the wallet's to set, never one call's.
  return call ? result : withSiteFee(result, tx, ctx);
}

/** The largest of these fields that every wallet reads the same way (uintOf), or null. */
const largest = (tx, keys) =>
  keys.map((key) => (given(tx[key]) ? uintOf(tx[key]) : null)).reduce((a, b) => (b !== null && (a === null || b > a) ? b : a), null);

/**
 * The network fee a transaction sets itself: its gas limit times its price
 * per gas is the most it can cost, and the wallet may keep what the site set.
 * More than a small payment is said, and worth a check.
 */
function withSiteFee(result, tx, ctx) {
  const limit = largest(tx, ['gas', 'gasLimit']);
  const price = largest(tx, ['gasPrice', 'maxFeePerGas']);
  if (limit === null || price === null || limit * price <= SMALL_PAYMENT) return result;
  const fee = `${formatUnits(limit * price, 18)} ${chainInfo(ctx.chainId).native}`;
  return {
    ...result,
    risk: maxRisk(result.risk, 'caution'),
    facts: [...result.facts, fact('Network fee', `up to ${fee} (set by the site)`, { tone: 'caution' })],
    reasons: [
      ...result.reasons,
      `The site set the network fee itself, and it can reach ${fee}. Check the fee in your wallet before you confirm.`,
    ],
    subject: { ...result.subject, fee },
  };
}

/** What a transaction in the standard form does. */
function readTransaction(to, data, value, ctx) {
  const chain = chainInfo(ctx.chainId);

  if (!to) {
    // Coins sent with a deployment go to the new contract, and its code (run
    // in this same transaction) can pass them on to anyone.
    const sends = value > 0n ? `${formatUnits(value, 18)} ${chain.native}` : null;
    const coins = sends ? `It also sends ${sends} to the new contract; its code decides where they go.` : null;
    return {
      kind: 'deploy',
      risk: 'caution',
      headline: 'Deploy a new contract',
      facts: [fact('Action', 'Contract deployment'), networkFact(ctx), ...(sends ? [fact('Sends', sends, { tone: 'caution' })] : [])],
      reasons: ['This creates a new contract from your wallet. Sites rarely need this from visitors.', ...(coins ? [coins] : [])],
      warnings: coins ? [coins] : [],
      subject: { action: 'deploy', ...(sends ? { sends } : {}) },
    };
  }

  if (strip0x(data).length === 0) {
    return nativeTransfer(to, value, chain, ctx);
  }

  const selector = selectorOf(data);
  const decoded = decodeCall(selector, to, data, ctx);
  if (decoded) return value > 0n && decoded.kind !== 'malformed' ? withCoins(decoded, value, chain, to) : decoded;
  return undecodedCall(to, selector, value, ctx);
}

/** A contract call Guardian has no decoder for (and the coins it sends, if any). */
function undecodedCall(to, selector, value, ctx) {
  const chain = chainInfo(ctx.chainId);
  const facts = [
    fact('Action', 'Contract call Guardian cannot decode'),
    fact('Contract', to, { mono: true }),
    fact('Function', selector || 'unknown', { mono: true }),
    networkFact(ctx),
  ];
  if (value > 0n) facts.push(fact('Sends', `${formatUnits(value, 18)} ${chain.native}`));
  return {
    kind: 'contractCall',
    risk: 'caution',
    headline: 'Contract call that cannot be decoded',
    facts,
    reasons: [
      'Guardian cannot tell what this call does, so it cannot confirm it is safe.',
      ...(value > 0n ? [`It also sends ${formatUnits(value, 18)} ${chain.native} to the contract.`] : []),
    ],
    warnings: value > 0n ? [`It also sends ${formatUnits(value, 18)} ${chain.native} to the contract.`] : [],
    subject: {
      action: 'contractCall',
      contract: to,
      selector,
      value: value.toString(),
      ...(value > 0n ? { sends: `${formatUnits(value, 18)} ${chain.native}` } : {}),
    },
  };
}

/** Celo: the network fee is paid in a token, not in the network's own coin. */
function withFeeToken(result, token) {
  return {
    ...result,
    risk: maxRisk(result.risk, 'caution'),
    facts: [...result.facts, fact('Network fee', `Paid in token ${token}`)],
    reasons: [...result.reasons, 'The network fee is paid in a token (named above), not in the network’s own coin.'],
    subject: { ...result.subject, feeToken: token },
  };
}

/** A transaction that is not in the standard form: Guardian cannot read it. */
function malformed(problem, ctx) {
  return {
    kind: 'malformed',
    risk: 'danger',
    headline: 'Transaction Guardian cannot read',
    facts: [fact('Action', 'Transaction in a non-standard form'), fact('Problem', problem, { tone: 'danger' }), networkFact(ctx)],
    reasons: [NONSTANDARD],
    warnings: [NONSTANDARD],
    subject: { action: 'malformed' },
  };
}

/**
 * EIP-7702: the account hands control to the code of the listed contracts.
 * Every delegate is listed, and an entry Guardian cannot read is said: none
 * is ever left out.
 */
function delegation(list, ctx) {
  const entries = Array.isArray(list) ? list : [];
  const read = [];
  let unread = 0;
  for (const a of entries) {
    // viem writes "address"; older versions wrote "contractAddress".
    const named = a && typeof a === 'object' && !Array.isArray(a) ? [a.address, a.contractAddress].filter(given) : [];
    const addresses = named.map(normAddress);
    if (addresses.length === 0 || addresses.some((x) => !x)) unread += 1;
    read.push(...addresses.filter(Boolean));
  }
  const delegates = unique(read);
  const unreadFact =
    unread > 0 ? [fact('Delegate to', unread === 1 ? 'one Guardian cannot read' : `${unread} Guardian cannot read`, { tone: 'danger' })] : [];
  return {
    kind: 'delegation',
    risk: 'danger',
    headline: 'Hand control of your account to a contract',
    facts: [
      fact('Action', 'Account delegation (EIP-7702)'),
      ...delegates.map((a) => fact('Delegate to', a, { mono: true, tone: 'danger' })),
      ...unreadFact,
      ...(delegates.length === 0 && unread === 0 ? [fact('Delegate to', 'unknown', { tone: 'danger' })] : []),
      networkFact(ctx),
    ],
    reasons: [DELEGATION],
    warnings: [DELEGATION],
    subject: { action: 'delegation', delegates },
  };
}

// How many 32-byte arguments each call Guardian reads needs.
const ARGUMENTS = {
  [SELECTOR.approve]: 2,
  [SELECTOR.increaseAllowance]: 2,
  [SELECTOR.setApprovalForAll]: 2,
  [SELECTOR.transfer]: 2,
  [SELECTOR.transferFrom]: 3,
  [SELECTOR.permit2Approve]: 4,
};

/** A token call Guardian can read, or null. */
function decodeCall(selector, to, data, ctx) {
  if (selector === SELECTOR.permit2Approve && to !== PERMIT2) return null;
  // Call data cut short: older tokens read the missing bytes as zeros, so an
  // amount cut short can be almost unlimited. Guardian cannot read it.
  const needs = Object.prototype.hasOwnProperty.call(ARGUMENTS, selector) ? ARGUMENTS[selector] : 0;
  if (needs > 0 && word(data, needs - 1) === null) return malformed('Its call data is shorter than this function needs', ctx);
  switch (selector) {
    case SELECTOR.approve:
    case SELECTOR.increaseAllowance:
      return tokenApproval({
        token: to,
        spender: wordToAddress(word(data, 0)),
        amount: wordToBigInt(word(data, 1)),
        via: selector === SELECTOR.approve ? 'approve' : 'increaseAllowance',
        ctx,
      });
    case SELECTOR.setApprovalForAll:
      return approvalForAll({
        collection: to,
        operator: wordToAddress(word(data, 0)),
        approved: wordToBigInt(word(data, 1)) !== 0n,
        ctx,
      });
    case SELECTOR.transfer:
      return tokenTransfer({
        token: to,
        recipient: wordToAddress(word(data, 0)),
        amount: wordToBigInt(word(data, 1)),
        ctx,
      });
    case SELECTOR.transferFrom:
      return tokenTransfer({
        token: to,
        from: wordToAddress(word(data, 0)),
        recipient: wordToAddress(word(data, 1)),
        amount: wordToBigInt(word(data, 2)),
        ctx,
      });
    case SELECTOR.permit2Approve:
      // approve(token, spender, uint160 amount, uint48 expiration)
      return tokenApproval({
        token: wordToAddress(word(data, 0)),
        spender: wordToAddress(word(data, 1)),
        amount: wordToBigInt(word(data, 2)),
        via: 'Permit2 approve',
        ctx: { ...ctx, enrich: {} },
        expires: wordToBigInt(word(data, 3)),
      });
    default:
      return null;
  }
}

/**
 * Coins sent along with a token call. Approvals, token transfers and
 * collection approvals never need them: the coins simply go to the contract,
 * on top of whatever the call does.
 */
function withCoins(result, value, chain, contract) {
  const coins = `${formatUnits(value, 18)} ${chain.native}`;
  const reason = `It also sends ${coins} to the contract it calls. This kind of request never needs coins attached.`;
  return {
    ...result,
    risk: 'danger',
    facts: [...result.facts, fact('Also sends', coins, { tone: 'danger' })],
    reasons: [reason, ...result.reasons],
    warnings: [reason, ...(result.warnings || [])],
    subject: { ...result.subject, coins, contract },
  };
}

/**
 * The share of the balance a payment takes, in percent. The balance is what
 * the page reported (through its own provider), so it may only raise the
 * risk: most of the balance is what "send a little to claim" scams aim for,
 * while a small share proves nothing (a page can report any balance).
 */
function shareOfBalance(amount, balance) {
  const total = toBigInt(balance);
  if (amount === null || total === null || total <= 0n) return null;
  return Number((amount * 1000n) / total) / 10; // percent, one decimal
}

/**
 * A payment out of the wallet is worth a check (a small payment of coins is
 * not: nativeTransfer); a quarter of the balance or more is said, and almost
 * all of it is high risk. A smaller share is never said: it could only calm.
 */
function transferRisk(share, what) {
  if (share === null || share < 25) return { risk: 'caution', note: null, reasons: [] };
  const percent = share >= 99.95 ? 'all' : `about ${Math.round(share)}%`;
  const note = `${percent === 'all' ? 'All' : percent} of your ${what}`;
  if (share >= 90) {
    return {
      risk: 'danger',
      note,
      reasons: [`This would send ${percent === 'all' ? 'all' : 'almost all'} of the ${what} in this wallet.`],
    };
  }
  return { risk: 'caution', note, reasons: [] };
}

// A small payment of coins: 0.05 of a coin (every network in the registry
// counts its coin in 18 decimals). The amount is the request's own, what the
// wallet sends; only the balance comes from the page. On a network Guardian
// does not know, or when it cannot tell the network at all, it cannot tell
// what a coin is worth, so there it is checked. It holds for one payment
// only: a batch adds up the coins of all its calls (analyzeBatch).
const SMALL_PAYMENT = 5n * 10n ** 16n;

function nativeTransfer(to, value, chain, ctx) {
  const amount = `${formatUnits(value, 18)} ${chain.native}`;
  const toSelf = ctx.self.has(to);
  const toFact = fact('To', to, { mono: true, ...(toSelf ? { note: 'an address of this wallet' } : {}) });
  if (value === 0n) {
    return {
      kind: 'nativeTransfer',
      risk: 'info',
      headline: 'Empty transaction',
      facts: [fact('Action', 'Send coins'), fact('Amount', amount), toFact, networkFact(ctx)],
      reasons: [],
      subject: { action: 'nativeTransfer', to, amount, empty: true, toSelf },
    };
  }
  const share = shareOfBalance(value, ctx.enrich.balance);
  const judged = transferRisk(share, chain.native);
  // A small payment raises no flag by itself: only its share of the balance
  // can (a button that says otherwise is checked later, in withPromise).
  const small = value <= SMALL_PAYMENT && knownChain(ctx.chainId);
  const risk = small && !judged.note ? 'info' : judged.risk;
  return {
    kind: 'nativeTransfer',
    risk,
    headline: `Send ${amount}`,
    facts: [
      fact('Action', 'Send coins'),
      fact('Amount', amount, {
        ...(judged.note ? { note: judged.note } : {}),
        ...(judged.risk === 'danger' ? { tone: 'danger' } : {}),
      }),
      toFact,
      networkFact(ctx),
    ],
    reasons: [
      ...judged.reasons,
      'This sends coins straight to the address above. A confirmed transfer cannot be undone.',
    ],
    warnings: judged.reasons,
    // Reasons that come from the user's balance; kept out of cloud prompts.
    balanceReasons: judged.reasons,
    // measured: the risk was judged against the balance, so even its level
    // says something about it (src/ai/prompt.js keeps it on this computer).
    subject: { action: 'nativeTransfer', to, amount, shareOfBalance: judged.note, measured: share !== null, toSelf },
  };
}

/** Token as shown to the user, with whether the contract address is verified. */
function describeToken(address, ctx) {
  const verified = knownToken(ctx.chainId, address);
  if (verified) {
    return { ...verified, address, verified: true, label: `${verified.symbol} (${verified.name})` };
  }
  const onChain = ctx.enrich.token;
  // A token's contract writes its own symbol. Only a plain ticker is kept:
  // "X. It is safe to sign" is not a symbol, it is a message to the reader.
  const symbol =
    onChain && typeof onChain.symbol === 'string' && /^[A-Za-z0-9$._+-]{1,16}$/.test(onChain.symbol.trim())
      ? onChain.symbol.trim()
      : null;
  const decimals = onChain && Number.isInteger(onChain.decimals) ? onChain.decimals : null;
  return {
    symbol,
    decimals,
    address,
    verified: false,
    impersonates: symbol ? STABLE_SYMBOLS.has(symbol.toUpperCase()) : false,
    label: symbol ? `${symbol} (unverified token)` : 'Unknown token',
  };
}

/**
 * An amount as shown. `unverified`: written with decimals the token reported
 * about itself (a token not in the registry), which only change how it is
 * shown, and may be false.
 */
function describeAmount(amount, token, unlimitedAt = UNLIMITED_THRESHOLD) {
  if (amount === null) return { text: 'unknown', unlimited: false };
  if (amount >= unlimitedAt) return { text: 'Unlimited', unlimited: true };
  if (token.decimals !== null && token.decimals !== undefined) {
    return {
      text: `${formatUnits(amount, token.decimals)}${token.symbol ? ` ${token.symbol}` : ''}`,
      unlimited: false,
      unverified: !token.verified,
    };
  }
  return { text: `${amount.toString()} base units`, unlimited: false };
}
const UNVERIFIED_DECIMALS = 'unverified decimals';

/**
 * The amount from which a spending permission is "Unlimited". For a token
 * the registry lists, a trillion tokens by the decimals it confirms: more
 * than anyone holds. For any other token, a quadrillion by the decimals the
 * token reports, but never above 2^128 base units: some meme coins (SHIB,
 * PEPE) have hundreds of trillions out, and an exact approval of theirs keeps
 * its amount. Where no decimals are read (a Permit2 signature or approve),
 * from 10^30 base units, a trillion of an 18-decimals token. Permit2's
 * largest amount is above every line. A drainer that asks for 2^200 - 1 or
 * 2^127 instead of the largest number gets the same warning as the largest.
 * What only the page says (a network that makes a token verified, the
 * decimals a token reports) never moves the line above 2^128 base units.
 */
const unlimitedFrom = (tok) => {
  if (tok.verified) return 10n ** BigInt(tok.decimals + 12);
  if (!Number.isInteger(tok.decimals) || tok.decimals < 0) return 10n ** 30n;
  // 10^38 is the largest power of ten below 2^128.
  return tok.decimals <= 23 ? 10n ** BigInt(tok.decimals + 15) : 1n << 128n;
};

function spenderFacts(spender, ctx, reasons) {
  const known = knownSpender(spender);
  let risk = 'info';
  if (known) {
    return { risk, known, value: `${known} · ${shortAddress(spender)}` };
  }
  if (ctx.enrich.spenderIsContract === false) {
    risk = 'danger';
    reasons.push(PERSONAL_WALLET);
    return { risk, known: null, value: spender, note: 'personal wallet', warning: PERSONAL_WALLET };
  }
  return { risk, known: null, value: spender };
}

/** A time in seconds as shown to the user: a date, or "more than a year". */
function when(seconds) {
  const far = seconds > BigInt(Math.floor(Date.now() / 1000)) + 365n * 24n * 3600n;
  if (far) return { text: 'More than a year from now', far: true };
  return { text: `${new Date(Number(seconds) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`, far: false };
}

/**
 * How long a spending permission lasts. An ordinary approval or an EIP-2612
 * permit lasts until it is revoked (or used up); a Permit2 allowance also has
 * its own end time, and 0 there means "only in the transaction that sets it".
 */
function lasting(expires) {
  if (expires === null || expires === undefined) {
    return { fact: null, phrase: 'until you revoke it', reason: 'The permission stays active until you revoke it.' };
  }
  if (expires === 0n) {
    return {
      fact: 'In the same transaction only',
      phrase: 'only in the same transaction that sets it',
      reason: 'The permission can be used only in the same transaction that sets it.',
    };
  }
  const end = when(expires);
  return end.far
    ? {
        fact: end.text,
        tone: 'caution',
        phrase: 'for more than a year, unless you revoke it sooner',
        reason: 'The permission stays active for more than a year, unless you revoke it sooner.',
      }
    : {
        fact: end.text,
        phrase: `until ${end.text}, unless you revoke it sooner`,
        reason: `The permission stays active until ${end.text}, unless you revoke it sooner.`,
      };
}

/**
 * A spending permission: approve, increaseAllowance, an EIP-2612 permit, a
 * Permit2 allowance (`expires`: its end time) or a Permit2 transfer signature
 * (`once`: the spender can take the amount one time, until the signature
 * expires; nothing stays behind).
 */
function tokenApproval({ token, spender, amount, via, ctx, expires = null, once = false }) {
  const chain = chainInfo(ctx.chainId);
  const tok = describeToken(token, ctx);
  const amt = describeAmount(amount, tok, unlimitedFrom(tok));
  const symbol = tok.symbol || 'this token';
  const reasons = [];
  // increaseAllowance adds to whatever the spender may already move.
  const more = via === 'increaseAllowance' && !amt.unlimited ? ' more' : '';

  if (amount === 0n && !once) {
    // increaseAllowance adds nothing: whatever the spender may move, it still can.
    if (via === 'increaseAllowance') return noChange(tok, spender, ctx);
    // ERC-721 approve(spender, tokenId) has the same selector as the token
    // approve: on a contract the registry does not confirm is a token, a zero
    // may be item #0 of a collection. (Zero to no one clears either.)
    if (via === 'approve' && !tok.verified && spender !== ZERO_ADDRESS) return maybeItemZero(tok, spender, ctx);
    return {
      kind: 'revoke',
      risk: 'info',
      headline: `Remove a spending permission for ${symbol}`,
      facts: [
        fact('Action', 'Revoke approval'),
        fact('Token', tok.label),
        fact('Spender', spender, { mono: true }),
        networkFact(ctx),
      ],
      reasons: ['This sets the allowance to zero, so the spender can no longer move this token.'],
      subject: { action: 'revoke', token: tok, spender },
    };
  }

  let risk = 'caution';
  const sp = spenderFacts(spender, ctx, reasons);
  risk = maxRisk(risk, sp.risk);

  const what = amt.unlimited ? `any amount of ${symbol}` : `up to ${amt.text}${more}`;
  if (once) {
    reasons.unshift(`The spender could take ${what} from your wallet, once, until this signature expires.`);
  } else if (amt.unlimited) {
    reasons.unshift(`The spender could move ${what} from your wallet, now or later, without asking again.`);
  } else {
    reasons.unshift(`The spender could move ${what} from your wallet without asking again.`);
  }
  const warnings = sp.warning ? [sp.warning] : [];
  if (amt.unlimited) {
    if (!sp.known) {
      risk = 'danger';
      warnings.unshift(reasons[0]); // any amount, to someone Guardian does not know
    }
  } else if (sp.known && sp.risk === 'info') {
    // Bounded amount to a widely used protocol: the ordinary first step of a swap.
    risk = 'info';
  }
  if (!sp.known) reasons.push('Guardian does not recognise the spender address.');
  if (tok.impersonates) {
    risk = 'danger';
    const fake = `This token calls itself ${tok.symbol}, but its contract is not the real ${tok.symbol} on ${chain.name}.`;
    reasons.push(fake);
    warnings.push(fake);
  }
  const lasts = once ? null : lasting(expires);
  if (lasts) reasons.push(lasts.reason);

  let headline;
  if (once) {
    headline = amt.unlimited ? `Signature that lets someone take any amount of ${symbol}` : `Signature that lets someone take up to ${amt.text}`;
  } else if (amt.unlimited) {
    headline = `Unlimited spending permission for ${symbol}`;
  } else {
    headline = more ? `Extra spending permission for ${amt.text}` : `Spending permission for ${amt.text}`;
  }
  return {
    kind: 'approve',
    risk,
    headline,
    facts: [
      fact('Action', once ? 'One-time transfer signature (Permit2)' : `Token approval (${via})`),
      fact('Token', tok.label, tok.verified ? { tone: 'ok', note: 'verified contract' } : {}),
      fact('Amount', `${amt.text}${more}`, {
        ...(amt.unlimited ? { tone: 'danger' } : {}),
        ...(amt.unverified ? { note: UNVERIFIED_DECIMALS } : {}),
      }),
      fact('Spender', sp.value, { mono: !sp.known, ...(sp.note ? { tone: 'danger', note: sp.note } : {}) }),
      networkFact(ctx),
      ...(lasts && lasts.fact ? [fact('Permission ends', lasts.fact, lasts.tone ? { tone: lasts.tone } : {})] : []),
    ],
    reasons,
    warnings,
    subject: {
      action: once ? 'permitTransfer' : 'approve',
      token: tok,
      spender,
      spenderName: sp.known,
      amount: amt.text,
      unlimited: amt.unlimited,
      more: more !== '',
      lasts: lasts ? lasts.phrase : null,
      ends: lasts ? lasts.fact : null,
    },
  };
}

/**
 * increaseAllowance(spender, 0): it adds nothing to what the spender may
 * move. Never shown as a revoke: whatever the spender may move now, it
 * still can.
 */
function noChange(tok, spender, ctx) {
  return {
    kind: 'noChange',
    risk: 'info',
    headline: `No change to the spending permission for ${tok.symbol || 'this token'}`,
    facts: [
      fact('Action', 'Token approval (increaseAllowance)'),
      fact('Token', tok.label, tok.verified ? { tone: 'ok', note: 'verified contract' } : {}),
      fact('Amount', '0 more: no change'),
      fact('Spender', spender, { mono: true }),
      networkFact(ctx),
    ],
    reasons: [
      'This adds nothing to what the spender may move, and removes nothing: whatever the spender may move now, it still can.',
    ],
    subject: { action: 'noChange', token: tok, spender },
  };
}

/**
 * approve(spender, 0) on a contract that may be an NFT collection. On a
 * token it removes a spending permission (the usual revoke, of any token the
 * registry does not list); on a collection it lets the spender take item #0.
 * Guardian cannot tell which, so it says both and asks for a check. A
 * personal wallet as the spender raises nothing here: a permission held by a
 * drainer's own wallet is the one people most often revoke.
 */
function maybeItemZero(tok, spender, ctx) {
  const reasons = [MAYBE_ITEM];
  const known = knownSpender(spender);
  const personal = !known && ctx.enrich.spenderIsContract === false;
  if (!known) reasons.push('Guardian does not recognise the spender address.');
  // A token that borrows a famous name is said, but raises nothing here: a
  // permission removed is removed, whatever the token is.
  if (tok.impersonates) {
    reasons.push(`This token calls itself ${tok.symbol}, but its contract is not the real ${tok.symbol} on ${chainInfo(ctx.chainId).name}.`);
  }
  return {
    kind: 'approve',
    risk: 'caution',
    headline: `Remove a spending permission for ${tok.symbol || 'this token'}, or give permission for item #0 if this is an NFT collection`,
    facts: [
      fact('Action', 'Token approval (approve)'),
      fact('Token', tok.label),
      fact('Amount', '0: no allowance, or item #0 of an NFT collection', { tone: 'caution' }),
      fact('Spender', known ? `${known} · ${shortAddress(spender)}` : spender, { mono: !known, ...(personal ? { note: 'personal wallet' } : {}) }),
      networkFact(ctx),
    ],
    reasons,
    warnings: [],
    subject: {
      action: 'approve',
      token: tok,
      spender,
      spenderName: known,
      amount: 'item #0',
      unlimited: false,
      more: false,
      itemZero: true,
      lasts: null,
      ends: null,
    },
  };
}

function approvalForAll({ collection, operator, approved, ctx }) {
  if (!approved) {
    return {
      kind: 'revoke',
      risk: 'info',
      headline: 'Remove access to a collection',
      facts: [
        fact('Action', 'Revoke approval for all'),
        fact('Collection', collection, { mono: true }),
        fact('Operator', operator, { mono: true }),
        networkFact(ctx),
      ],
      reasons: ['This removes the operator’s access to your items in this collection.'],
      subject: { action: 'revokeAll', collection, operator },
    };
  }
  const reasons = [
    'The operator could transfer every item you own in this collection, now or later, without asking again.',
  ];
  const sp = spenderFacts(operator, ctx, reasons);
  // Every item, to someone Guardian does not know.
  const warnings = [...(sp.known ? [] : [reasons[0]]), ...(sp.warning ? [sp.warning] : [])];
  if (!sp.known) reasons.push('Guardian does not recognise the operator address.');
  reasons.push('The permission stays active until you revoke it.');
  return {
    kind: 'approveAll',
    warnings,
    risk: sp.known ? 'caution' : 'danger',
    headline: 'Access to all your items in a collection',
    facts: [
      fact('Action', 'Approval for all (setApprovalForAll)'),
      fact('Collection', collection, { mono: true }),
      fact('Items', 'All, including ones you get later', { tone: 'danger' }),
      fact('Operator', sp.value, { mono: !sp.known, ...(sp.note ? { tone: 'danger', note: sp.note } : {}) }),
      networkFact(ctx),
    ],
    reasons,
    subject: { action: 'approveAll', collection, operator, operatorName: sp.known },
  };
}

/**
 * transfer, or transferFrom. transferFrom names whose tokens move: this
 * wallet's, or another address's that has allowed this wallet to move them.
 */
function tokenTransfer({ token, from, recipient, amount, ctx }) {
  const tok = describeToken(token, ctx);
  const amt = describeAmount(amount, tok);
  // "This wallet" only for the account the request names. Tokens taken from
  // an account the page reported, or when the request names no account,
  // count as the user's own: Guardian never says they are someone else's.
  const named = Boolean(from) && ctx.self.has(from);
  const fromSelf = !from || named || ctx.self.size === 0 || ctx.reported.has(from);
  const toSelf = ctx.self.has(recipient);
  const share = from ? null : shareOfBalance(amount, ctx.enrich.tokenBalance);
  const judged = transferRisk(share, tok.symbol || 'tokens');
  const note = [judged.note, amt.unverified ? UNVERIFIED_DECIMALS : null].filter(Boolean).join(' · ');
  const facts = [
    fact('Action', from ? 'Token transfer (transferFrom)' : 'Token transfer'),
    fact('Token', tok.label, tok.verified ? { tone: 'ok', note: 'verified contract' } : {}),
    fact('Amount', amt.text, {
      ...(note ? { note } : {}),
      ...(judged.risk === 'danger' ? { tone: 'danger' } : {}),
    }),
  ];
  if (from) {
    facts.push(fact('From', from, { mono: true, ...(named ? { note: 'this wallet' } : !fromSelf ? { note: 'not this wallet' } : {}) }));
  }
  facts.push(
    fact('To', recipient, { mono: true, ...(toSelf ? { note: 'an address of this wallet' } : {}) }),
    networkFact(ctx),
  );
  return {
    kind: 'transfer',
    risk: judged.risk,
    headline: fromSelf ? `Send ${amt.text}` : `Move ${amt.text} from another address`,
    facts,
    reasons: [
      ...judged.reasons,
      ...(fromSelf
        ? []
        : ['The tokens come from the From address, not from this wallet. This works only if that address has allowed this wallet to move them.']),
      'This moves tokens to the address above. A confirmed transfer cannot be undone.',
    ],
    warnings: judged.reasons,
    balanceReasons: judged.reasons,
    subject: {
      action: 'transfer',
      token: tok,
      to: recipient,
      amount: amt.text,
      shareOfBalance: judged.note,
      measured: share !== null,
      from: from || null,
      fromSelf,
      toSelf,
    },
  };
}

function analyzeBatch(batch, ctx) {
  const calls = Array.isArray(batch.calls) ? batch.calls : [];
  const inner = { ...withChain(ctx, chainIdOf(batch.chainId)), enrich: {} };
  const parts = calls.map((c) => analyzeTransaction(c, inner, { call: true }));
  // One confirmation sends the coins of every call. A small payment raises
  // no flag by itself (nativeTransfer), but many of them add up: only one
  // call that sends coins, and no more than a small payment, may stay
  // without a check.
  const paying = calls.filter((c) => coinsOf(c) > 0n);
  const total = paying.reduce((sum, c) => sum + coinsOf(c), 0n);
  const checked = paying.length > 1 || total > SMALL_PAYMENT;
  const risk = parts.reduce((r, p) => maxRisk(r, p.risk), checked ? 'caution' : 'info');
  // Said when more than one call sends coins: no single line shows the sum.
  const sum = paying.length > 1 ? `${formatUnits(total, 18)} ${chainInfo(inner.chainId).native}` : null;
  return {
    kind: 'batch',
    risk: parts.length === 0 ? 'caution' : risk,
    headline: parts.length === 1 ? '1 action in one confirmation' : `${parts.length} actions in one confirmation`,
    facts: [
      ...parts.map((p, i) => fact(`Action ${i + 1}`, withParty(p), p.risk === 'danger' ? { tone: 'danger' } : {})),
      ...(sum ? [fact('Sends in total', sum, { tone: 'caution' })] : []),
    ],
    // The main reason of each part that is high risk or cannot be read, and
    // every part's warnings.
    reasons: unique([
      'One confirmation would carry out every action listed above.',
      ...(sum ? [`Together, these actions send ${sum} out of your wallet.`] : []),
      ...parts
        .filter((p) => p.risk === 'danger' || p.kind === 'contractCall' || p.kind === 'deploy')
        .flatMap((p) => p.reasons.slice(0, 1)),
      ...parts.flatMap((p) => p.warnings || []),
    ]),
    warnings: unique(parts.flatMap((p) => p.warnings || [])),
    parts,
    subject: { action: 'batch', actions: parts.map((p) => p.subject), ...(sum ? { total: sum } : {}) },
  };
}

const unique = (list) => [...new Set(list)];

/** A batch line: what it does and with whom ("Send 0.2 WETH, to 0xa47c1e…00d3b9"). */
function withParty(part) {
  const s = part.subject || {};
  const who = (name, address) => (name ? name : address ? shortAddress(address) : null);
  let party = null;
  if (['approve', 'revoke', 'noChange'].includes(s.action)) party = who(s.spenderName, s.spender) && `spender ${who(s.spenderName, s.spender)}`;
  else if (s.action === 'approveAll' || s.action === 'revokeAll') party = who(s.operatorName, s.operator) && `operator ${who(s.operatorName, s.operator)}`;
  else if (s.action === 'transfer' || s.action === 'nativeTransfer') party = s.to && `to ${shortAddress(s.to)}`;
  else if (s.action === 'contractCall') party = s.contract && `contract ${shortAddress(s.contract)}`;
  return party ? `${part.headline}, ${party}` : part.headline;
}

// ── Signatures ─────────────────────────────────────────────────────────────

const OFFCHAIN_NOTE =
  'This is a signature, not a transaction: it costs no gas and shows nothing in your wallet history until someone uses it.';

// Typed data is read the way the wallet signs it. A wallet signs only the
// fields `types` declares for the primary type (and for the struct types
// those fields use), and ignores any other key in the message. So a permit
// (or a signed transfer, or a call a contract makes for the user) is read
// only through `types`, and only in its standard form: a key that is not
// signed, a missing field, a type that is not the standard one, or a value
// wallets may read differently makes it a signature Guardian cannot read,
// high risk, never a guess.
const DETAILS = 'address token,uint160 amount,uint48 expiration,uint48 nonce';
const TOKEN_PERMISSIONS = 'address token,uint256 amount';
const TAKE = 'permitted,address spender,uint256 nonce,uint256 deadline';
const FORMS = {
  // EIP-2612.
  Permit: { Permit: 'address owner,address spender,uint256 value,uint256 nonce,uint256 deadline' },
  // DAI and the tokens that copied it: all or nothing, and an expiry of 0 never ends.
  DaiPermit: { Permit: 'address holder,address spender,uint256 nonce,uint256 expiry,bool allowed' },
  // EIP-4494 (as Uniswap V3 positions sign it): one item of an NFT collection.
  NftPermit: { Permit: 'address spender,uint256 tokenId,uint256 nonce,uint256 deadline' },
  // Permit2 AllowanceTransfer: an allowance with its own end time.
  PermitSingle: { PermitSingle: 'PermitDetails details,address spender,uint256 sigDeadline', PermitDetails: DETAILS },
  PermitBatch: { PermitBatch: 'PermitDetails[] details,address spender,uint256 sigDeadline', PermitDetails: DETAILS },
  // Permit2 SignatureTransfer: the spender takes the amount once. The
  // witness forms end with one more field, of the app's own struct type.
  PermitTransferFrom: { PermitTransferFrom: `TokenPermissions ${TAKE}`, TokenPermissions: TOKEN_PERMISSIONS },
  PermitBatchTransferFrom: { PermitBatchTransferFrom: `TokenPermissions[] ${TAKE}`, TokenPermissions: TOKEN_PERMISSIONS },
  PermitWitnessTransferFrom: { PermitWitnessTransferFrom: `TokenPermissions ${TAKE},*`, TokenPermissions: TOKEN_PERMISSIONS },
  PermitBatchWitnessTransferFrom: { PermitBatchWitnessTransferFrom: `TokenPermissions[] ${TAKE},*`, TokenPermissions: TOKEN_PERMISSIONS },
};
const PERMIT2_TYPES = new Set([
  'PermitSingle',
  'PermitBatch',
  'PermitTransferFrom',
  'PermitBatchTransferFrom',
  'PermitWitnessTransferFrom',
  'PermitBatchWitnessTransferFrom',
]);
// EIP-3009 (USDC and the tokens that copied it): a token transfer signed now
// and carried out once, between its two times, by whoever holds the
// signature (for "Receive…", only by the recipient).
const AUTHORIZATION = 'address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce';
const AUTH_FORMS = {
  TransferWithAuthorization: { TransferWithAuthorization: AUTHORIZATION },
  ReceiveWithAuthorization: { ReceiveWithAuthorization: AUTHORIZATION },
};
// A meta-transaction (Polygon PoS tokens): the contract carries out the call
// in functionSignature as if the user had sent it.
const META_FORM = { MetaTransaction: 'uint256 nonce,address from,bytes functionSignature' };
// Every form Guardian reads: one of them, declared under another name than
// the one signed, may be what a wallet signs.
const KNOWN_FORMS = [...Object.values(FORMS), ...Object.values(AUTH_FORMS), META_FORM];
// A struct may not take the name of a plain type: a wallet would encode that field as the struct.
const PLAIN_TYPE = /^(?:address|bool|string|bytes\d*|u?int\d*)$/;

const UNREADABLE_PERMIT =
  'It is named like a token permission, but it is not in the standard form, so Guardian cannot tell what your wallet would sign. A signature like this can let someone take your tokens.';
// A signature Guardian cannot read: what it is named like, and why that matters.
const UNREADABLE = {
  permit: { headline: 'Token permission Guardian cannot read', reason: UNREADABLE_PERMIT },
  transfer: {
    headline: 'Token transfer Guardian cannot read',
    reason:
      'It is named like a signed token transfer, but it is not in the standard form, so Guardian cannot tell what your wallet would sign. A signature like this can move your tokens.',
  },
  call: {
    headline: 'Signature Guardian cannot read',
    reason:
      'It is named like a signature that has a contract act for you, but it is not in the standard form, so Guardian cannot tell what your wallet would sign. A signature like this can move your tokens.',
  },
  undeclared: {
    headline: 'Signature Guardian cannot read',
    reason:
      'It declares a token permission, a token transfer or a call made for you, but names another type as the one it signs. Some wallets sign what it declares, so Guardian cannot tell what your wallet would sign. A signature like this can let someone take your tokens.',
  },
};
const META_NOTE = 'Whoever holds this signature can have the contract carry out this call as if you had sent it, at any time until it is used.';
const UNDECLARED = 'Its primary type is not one it declares';
const ANOTHER_ROOT = 'It declares another type that some wallets sign instead';
const NO_TYPES = 'Its type definitions are missing';
const NOT_STANDARD = 'Its fields are not the standard ones';
const NOT_SIGNED = 'Its values do not match the fields that are signed';
const BAD_VALUE = 'A value is in a form wallets may read differently';

const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/** The fields `types` declares for a struct, or null. */
function structFields(types, name) {
  const list = types && own(types, name) ? types[name] : null;
  if (!Array.isArray(list)) return null;
  const names = new Set();
  for (const f of list) {
    if (!plainObject(f) || typeof f.name !== 'string' || typeof f.type !== 'string' || names.has(f.name)) return null;
    names.add(f.name);
  }
  return list;
}

/**
 * Whether `types` declares exactly this standard form (`*`: one more field of
 * a struct type). `loose`: as ethers reads `types`, only to tell whether a
 * form is there at all, never to read it: "uint" and "int" (arrays of them
 * too) are "uint256" and "int256" unless a struct has that name, and a struct
 * named like a plain type does not hide the form.
 */
function isForm(types, form, { loose = false } = {}) {
  if (!loose && Object.keys(types).some((name) => PLAIN_TYPE.test(name))) return false;
  const typeOf = (type) => {
    const alias = loose ? /^(u?int)(\[.*)?$/.exec(type) : null;
    return alias && !own(types, alias[1]) ? `${alias[1]}256${alias[2] || ''}` : type;
  };
  return Object.entries(form).every(([name, shape]) => {
    const fields = structFields(types, name);
    if (!fields) return false;
    const written = fields.map((f) => `${typeOf(f.type)} ${f.name}`);
    if (!shape.endsWith(',*')) return written.join(',') === shape;
    return (
      fields.length === shape.split(',').length &&
      written.slice(0, -1).join(',') === shape.slice(0, -2) &&
      Boolean(structFields(types, fields[fields.length - 1].type))
    );
  });
}

/**
 * The structs `types` declares that no declared struct uses as a field type
 * (the domain's own type aside, and array brackets dropped). ethers signs the
 * one such struct, whatever primaryType says; two decoy structs that only use
 * each other are not among them, so they cannot hide it.
 */
function rootsOf(types) {
  const names = Object.keys(types).filter((name) => name !== 'EIP712Domain' && Array.isArray(types[name]));
  const used = new Set();
  for (const name of names) {
    for (const f of types[name]) {
      if (plainObject(f) && typeof f.type === 'string') used.add(f.type.split('[')[0]);
    }
  }
  return names.filter((name) => !used.has(name));
}

/**
 * Whether some wallets would sign another struct than the declared primary
 * type, and `types` declares a form Guardian reads: then Guardian cannot tell
 * which one the wallet signs.
 */
function signsAnother(types, primaryType) {
  // Forms as ethers reads them (isForm, loose): one written with "uint" signs the same.
  const other = (form) => Object.keys(form)[0] !== primaryType && isForm(types, form, { loose: true });
  // A struct named like a plain type, next to a form other than the primary
  // type: wallets differ on which fields are that struct, so on what they sign.
  if (Object.keys(types).some((name) => PLAIN_TYPE.test(name)) && KNOWN_FORMS.some(other)) return true;
  const roots = rootsOf(types);
  if (roots.length === 1) return roots[0] !== primaryType && KNOWN_FORMS.some((form) => isForm(types, form, { loose: true }));
  // Several roots: one of them, other than the primary type, is a form Guardian reads.
  return roots.some((root) => root !== primaryType && KNOWN_FORMS.some((form) => Object.keys(form)[0] === root && other(form)));
}

/** A struct's value as the wallet signs it: exactly its declared keys, or null. */
function signedStruct(types, name, value) {
  const fields = structFields(types, name);
  if (!fields || !plainObject(value)) return null;
  return Object.keys(value).length === fields.length && fields.every((f) => own(value, f.name)) ? value : null;
}

function analyzeTypedData(raw, ctx) {
  let typed = raw;
  if (typeof raw === 'string') {
    try {
      typed = JSON.parse(raw);
    } catch {
      typed = null;
    }
  }
  if (!plainObject(typed)) {
    return {
      kind: 'typedData',
      risk: 'caution',
      headline: 'Structured data signature',
      facts: [fact('Action', 'Sign structured data')],
      reasons: ['Guardian could not read the data in this request.'],
      subject: { action: 'signTypedData' },
    };
  }

  const primaryType = typeof typed.primaryType === 'string' ? typed.primaryType : '';
  const domain = plainObject(typed.domain) ? typed.domain : {};
  const message = plainObject(typed.message) ? typed.message : {};
  const types = plainObject(typed.types) ? typed.types : null;
  const inner = {
    // The domain's network is part of what is signed.
    ...withChain(ctx, chainIdOf(domain.chainId)),
    // On-chain reads were made for the transaction target, not for this token.
    enrich: { spenderIsContract: ctx.enrich.spenderIsContract ?? null, token: ctx.enrich.token },
  };
  const verifying = normAddress(domain.verifyingContract);
  const unreadable = (problem, what = 'permit') => unreadablePermit(primaryType, domain, verifying, problem, what);

  // A primary type that `types` declares, while the struct the types lead
  // to (rootsOf) is another one: ethers signs that one. If `types` declares
  // a form Guardian reads, it cannot tell which one the wallet would sign.
  const declared = primaryType !== 'EIP712Domain' && Boolean(structFields(types, primaryType));
  if (types && declared && signsAnother(types, primaryType)) return unreadable(ANOTHER_ROOT, 'undeclared');

  if (primaryType === 'Permit') return permitSignature(types, message, verifying, inner, unreadable);
  if (PERMIT2_TYPES.has(primaryType) || verifying === PERMIT2) {
    return permit2Signature(types, primaryType, message, inner, unreadable);
  }
  // A primary type that `types` does not declare (or none, or the domain's
  // own type): some wallets then sign the struct `types` does declare (ethers
  // takes the one no other struct uses, the domain aside). If that is a form
  // Guardian reads (as ethers reads `types`: isForm, loose), it cannot tell
  // which one the wallet would sign.
  if (types && !declared && KNOWN_FORMS.some((form) => isForm(types, form, { loose: true }))) {
    return unreadable(UNDECLARED, 'undeclared');
  }
  if (ORDER_TYPES.has(primaryType) || BULK_ORDER_TYPES.has(primaryType)) {
    return marketOrder(primaryType, types, domain, message);
  }
  if (own(AUTH_FORMS, primaryType)) {
    return transferAuthorization(types, primaryType, message, verifying, inner, (problem) => unreadable(problem, 'transfer'));
  }
  if (primaryType === 'MetaTransaction') {
    return metaTransaction(types, message, verifying, inner, (problem) => unreadable(problem, 'call'));
  }

  return {
    kind: 'typedData',
    risk: 'caution',
    headline: 'Structured data signature',
    facts: [
      fact('Action', 'Sign structured data'),
      fact('Type', primaryType || 'unknown', { mono: true }),
      fact('App', String(domain.name || 'unknown')),
      ...(verifying ? [fact('Contract', verifying, { mono: true })] : []),
    ],
    reasons: ['Guardian does not recognise this data format, so it cannot tell what the signature allows.', OFFCHAIN_NOTE],
    subject: { action: 'signTypedData', type: primaryType, app: String(domain.name || '') },
  };
}

/**
 * A permit (or another signature that can move tokens: `what`, in UNREADABLE)
 * Guardian cannot read: never a guess at what it allows.
 */
function unreadablePermit(primaryType, domain, verifying, problem, what = 'permit') {
  const { headline, reason } = UNREADABLE[what];
  return {
    kind: 'typedData',
    risk: 'danger',
    headline,
    facts: [
      fact('Action', 'Sign structured data'),
      fact('Type', primaryType || 'unknown', { mono: true }),
      fact('App', String(domain.name || 'unknown')),
      ...(verifying ? [fact('Contract', verifying, { mono: true })] : []),
      fact('Problem', problem, { tone: 'danger' }),
    ],
    reasons: [reason, OFFCHAIN_NOTE],
    warnings: [reason],
    subject: { action: 'signTypedData', type: primaryType, app: String(domain.name || ''), unreadable: true },
  };
}

/**
 * An EIP-3009 transfer signature: `value` of the token moves from `from` to
 * `to`, once, when whoever holds the signature (for "Receive…", the
 * recipient) carries it out. Read as the transfer it is.
 */
function transferAuthorization(types, primaryType, message, token, ctx, unreadable) {
  if (!structFields(types, primaryType)) return unreadable(NO_TYPES);
  if (!isForm(types, AUTH_FORMS[primaryType])) return unreadable(NOT_STANDARD);
  const m = signedStruct(types, primaryType, message);
  if (!m) return unreadable(NOT_SIGNED);
  const from = normAddress(m.from);
  const to = normAddress(m.to);
  const value = uintOf(m.value);
  const after = uintOf(m.validAfter);
  const before = uintOf(m.validBefore);
  const nonce = typeof m.nonce === 'string' && /^0x[0-9a-fA-F]{64}$/.test(m.nonce);
  if (!from || !to || value === null || after === null || before === null || !nonce) return unreadable(BAD_VALUE);
  const sent = tokenTransfer({ token, from, recipient: to, amount: value, ctx });
  const s = sent.subject;
  const byRecipient = primaryType === 'ReceiveWithAuthorization';
  // Not valid yet: it can be carried out only from then on.
  const starts = after > BigInt(Math.floor(Date.now() / 1000)) ? when(after).text : null;
  return withOffchainNote(
    {
      ...sent,
      risk: maxRisk(sent.risk, 'caution'),
      headline: s.fromSelf ? `Signature that sends ${s.amount}` : `Signature that moves ${s.amount} from another address`,
      facts: [
        fact('Action', `Token transfer by signature (${primaryType})`),
        ...sent.facts.slice(1),
        ...(starts ? [fact('Valid from', starts)] : []),
      ],
      reasons: [
        ...sent.reasons,
        byRecipient
          ? 'Only the recipient can carry out this transfer, once, until the signature expires.'
          : 'Whoever holds this signature can carry out this transfer, once, until it expires.',
      ],
      subject: { ...s, authorization: true, byRecipient },
    },
    'authorization',
    before,
  );
}

/**
 * A meta-transaction: the contract (the domain's verifyingContract) carries
 * out the call in functionSignature as if the user had sent it, whenever
 * someone submits the signature. Read as that call, never below a check.
 */
function metaTransaction(types, message, contract, ctx, unreadable) {
  if (!structFields(types, 'MetaTransaction')) return unreadable(NO_TYPES);
  if (!isForm(types, META_FORM)) return unreadable(NOT_STANDARD);
  const m = signedStruct(types, 'MetaTransaction', message);
  if (!m) return unreadable(NOT_SIGNED);
  const data = callData(m.functionSignature);
  if (uintOf(m.nonce) === null || !normAddress(m.from) || data === null) return unreadable(BAD_VALUE);
  const selector = selectorOf(data);
  const call = (contract && decodeCall(selector, contract, data, ctx)) || undecodedCall(contract, selector, 0n, ctx);
  return {
    ...call,
    risk: maxRisk(call.risk, 'caution'),
    headline: `Signature that performs: ${call.headline}`,
    facts: [
      fact('Action', 'Signature that has a contract act for you (meta-transaction)'),
      ...call.facts.map((f) => (f.label === 'Action' ? fact('Call', f.value) : f)),
      fact('Carried out', 'Later, by whoever holds this signature', { tone: 'caution' }),
    ],
    reasons: [...call.reasons, META_NOTE, OFFCHAIN_NOTE],
    warnings: call.warnings || [],
    subject: { ...call.subject, metaTx: true },
  };
}

/** EIP-2612, DAI-style or NFT (EIP-4494) permit, told apart by the fields `types` declares. */
function permitSignature(types, message, token, ctx, unreadable) {
  if (!structFields(types, 'Permit')) return unreadable(NO_TYPES);
  if (isForm(types, FORMS.NftPermit)) return itemPermit(types, message, token, ctx, unreadable);
  const dai = isForm(types, FORMS.DaiPermit);
  if (!dai && !isForm(types, FORMS.Permit)) return unreadable(NOT_STANDARD);
  const m = signedStruct(types, 'Permit', message);
  if (!m) return unreadable(NOT_SIGNED);
  const spender = normAddress(m.spender);
  const owner = normAddress(dai ? m.holder : m.owner);
  const nonce = uintOf(m.nonce);
  const deadline = uintOf(dai ? m.expiry : m.deadline);
  // DAI: all or nothing. Only a real true or false reads the same in every
  // wallet; to some, the text "false" is true.
  const amount = dai ? (m.allowed === true ? UNLIMITED_THRESHOLD : m.allowed === false ? 0n : null) : uintOf(m.value);
  if (!spender || !owner || nonce === null || deadline === null || amount === null) return unreadable(BAD_VALUE);
  const result = tokenApproval({ token, spender, amount, via: 'permit signature', ctx });
  return withOffchainNote(result, 'permit', deadline, { zeroNeverEnds: dai });
}

/**
 * An NFT permit (EIP-4494, as Uniswap V3 positions sign it): the spender may
 * take one item of the collection (the domain's verifyingContract), as with
 * approve(spender, tokenId) on it. One item may be worth anything, so it is
 * never below a check.
 */
function itemPermit(types, message, collection, ctx, unreadable) {
  const m = signedStruct(types, 'Permit', message);
  if (!m) return unreadable(NOT_SIGNED);
  const spender = normAddress(m.spender);
  const item = uintOf(m.tokenId);
  const deadline = uintOf(m.deadline);
  if (!spender || item === null || uintOf(m.nonce) === null || deadline === null) return unreadable(BAD_VALUE);
  const reasons = [`The spender could take your item #${item} of this collection, now or later, without asking again.`];
  const sp = spenderFacts(spender, ctx, reasons);
  if (!sp.known) reasons.push('Guardian does not recognise the spender address.');
  reasons.push('The permission stays active until you revoke it.');
  return withOffchainNote(
    {
      kind: 'permit',
      risk: maxRisk('caution', sp.risk),
      headline: `Permission for item #${item}`,
      facts: [
        fact('Action', 'Item permission (NFT permit signature)'),
        fact('Collection', collection || 'unknown', { mono: Boolean(collection) }),
        fact('Item', `#${item}`),
        fact('Spender', sp.value, { mono: !sp.known, ...(sp.note ? { tone: 'danger', note: sp.note } : {}) }),
        networkFact(ctx),
      ],
      reasons,
      warnings: sp.warning ? [sp.warning] : [],
      subject: {
        action: 'approve',
        item: item.toString(),
        collection,
        spender,
        spenderName: sp.known,
        amount: `item #${item}`,
        unlimited: false,
        more: false,
        lasts: 'until you revoke it',
        ends: null,
      },
    },
    'permit',
    deadline,
  );
}

/**
 * A Permit2 signature. Its kind comes from the primary type, never from which
 * keys the message happens to have: AllowanceTransfer ("details") is an
 * allowance with its own end time; SignatureTransfer ("permitted") lets the
 * spender take the amount once, before the signature's deadline.
 */
function permit2Signature(types, primaryType, message, ctx, unreadable) {
  if (!PERMIT2_TYPES.has(primaryType)) return unreadable(NOT_STANDARD);
  if (!structFields(types, primaryType)) return unreadable(NO_TYPES);
  if (!isForm(types, FORMS[primaryType])) return unreadable(NOT_STANDARD);
  const m = signedStruct(types, primaryType, message);
  if (!m) return unreadable(NOT_SIGNED);
  const once = /TransferFrom$/.test(primaryType);
  const field = once ? 'permitted' : 'details';
  const list = primaryType.includes('Batch') ? m[field] : [m[field]];
  const items = Array.isArray(list) ? list.map((v) => signedStruct(types, once ? 'TokenPermissions' : 'PermitDetails', v)) : [];
  if (items.length === 0 || items.some((i) => !i)) return unreadable(NOT_SIGNED);
  const spender = normAddress(m.spender);
  const deadline = uintOf(once ? m.deadline : m.sigDeadline);
  const read = items.map((i) => ({
    token: normAddress(i.token),
    amount: uintOf(i.amount, once ? 256 : 160),
    expires: once ? null : uintOf(i.expiration, 48),
    nonce: once ? uintOf(m.nonce) : uintOf(i.nonce, 48),
  }));
  if (!spender || deadline === null || read.some((r) => !r.token || r.amount === null || r.nonce === null || (!once && r.expires === null))) {
    return unreadable(BAD_VALUE);
  }
  const parts = read.map((r) =>
    tokenApproval({
      token: r.token,
      spender,
      amount: r.amount,
      via: 'Permit2 signature',
      ctx: { ...ctx, enrich: { spenderIsContract: ctx.enrich.spenderIsContract } },
      expires: r.expires,
      once,
    }),
  );
  if (parts.length === 1) {
    return withOffchainNote(parts[0], 'permit2', deadline);
  }
  const risk = parts.reduce((r, p) => maxRisk(r, p.risk), 'info');
  const ends = unique(parts.map((p) => p.subject.ends).filter(Boolean));
  return withOffchainNote(
    {
      kind: 'permit2',
      risk,
      headline: once ? `Signature that lets someone take ${parts.length} tokens` : `Spending permissions for ${parts.length} tokens`,
      facts: [
        ...parts.map((p, i) => fact(`Token ${i + 1}`, p.headline, p.risk === 'danger' ? { tone: 'danger' } : {})),
        ...parts[0].facts.filter((f) => f.label === 'Spender' || f.label === 'Network'),
        ...(ends.length === 1
          ? [fact('Permissions end', ends[0], ends[0] === 'More than a year from now' ? { tone: 'caution' } : {})]
          : ends.length > 1
            ? parts.map((p, i) => fact(`Token ${i + 1} ends`, p.subject.ends || 'unknown'))
            : []),
      ],
      // Every token's reasons: a fake token may be any one of them.
      reasons: unique(parts.flatMap((p) => p.reasons)),
      warnings: unique(parts.flatMap((p) => p.warnings || [])),
      parts,
      subject: {
        action: 'permit2Batch',
        once,
        spender,
        spenderName: parts[0].subject.spenderName,
        actions: parts.map((p) => p.subject),
      },
    },
    'permit2',
    deadline,
  );
}

const ORDER_TYPES = new Set(['OrderComponents', 'Order']);
// Seaport's bulk listing (a tree of orders) and Blur's (a Merkle root of
// them): one signature, many orders, and their items are not shown.
const BULK_ORDER_TYPES = new Set(['BulkOrder', 'Root']);

function marketOrder(primaryType, types, domain, message) {
  const app = String(domain.name || 'unknown');
  const subject = { action: 'marketOrder', app: String(domain.name || '') };
  if (BULK_ORDER_TYPES.has(primaryType)) {
    return {
      kind: 'order',
      risk: 'caution',
      headline: 'Several marketplace orders in one signature',
      facts: [
        fact('Action', 'Sign several marketplace orders at once'),
        fact('App', app),
        fact('Items', 'Marketplace orders: Guardian cannot show their items', { tone: 'caution' }),
      ],
      reasons: [
        'One signature can complete every order it covers, and Guardian cannot show which items they include: it may be every item you own on that marketplace.',
        'Check the price: scam orders list valuable items for almost nothing.',
        OFFCHAIN_NOTE,
      ],
      subject: { ...subject, bulk: true },
    };
  }
  // How many items are offered, only from a field the wallet signs.
  const signed = (structFields(types, primaryType) || []).some((f) => f.name === 'offer' && f.type.endsWith('[]'));
  const offer = signed && Array.isArray(message.offer) ? message.offer.length : null;
  return {
    kind: 'order',
    risk: 'caution',
    headline: 'Marketplace order signature',
    facts: [
      fact('Action', 'Sign a marketplace order'),
      fact('App', app),
      ...(offer !== null ? [fact('Items you offer', String(offer))] : []),
    ],
    reasons: [
      'Whoever holds this signature can complete the trade it describes, including transferring the items you offer.',
      'Check the price: scam orders list valuable items for almost nothing.',
      OFFCHAIN_NOTE,
    ],
    subject,
  };
}

/** `deadline`: when the signature stops being valid (DAI-style: 0 is never). */
function withOffchainNote(result, kind, deadline, { zeroNeverEnds = false } = {}) {
  const facts = [...result.facts];
  if (zeroNeverEnds && deadline === 0n) {
    facts.push(fact('Valid until', 'Never expires', { tone: 'caution' }));
  } else if (deadline !== null && deadline !== undefined) {
    const end = when(deadline);
    facts.push(fact('Valid until', end.text, end.far ? { tone: 'caution' } : {}));
  }
  return { ...result, kind: result.kind === 'revoke' ? 'revoke' : kind, facts, reasons: [...result.reasons, OFFCHAIN_NOTE] };
}

/**
 * personal_sign(message, account). MetaMask also takes the older order
 * (account, message): when the first of two parameters has the length of an
 * address and the second does not, whatever its letters ("0X…" too).
 * Guardian picks the message the same way. An account not written the
 * standard way is never shown as harmless: another wallet may read the two
 * parameters the other way round.
 */
function personalSign(params, ctx) {
  const addressLength = (value) => typeof value === 'string' && value.length === 42;
  const swapped = params.length > 1 && addressLength(params[0]) && !addressLength(params[1]);
  const result = analyzeMessage(swapped ? params[1] : params[0], ctx);
  if (params.length < 2 || isAddress(swapped ? params[0] : params[1])) return result;
  return { ...result, risk: maxRisk(result.risk, 'caution'), reasons: [...result.reasons, ODD_ACCOUNT] };
}

/**
 * A personal_sign message, read as MetaMask signs it: a leading 0x or 0X is
 * dropped, and when only hex digits are left, the wallet signs the data they
 * stand for (a 32-byte hash, or text written in hex). Other wallets sign
 * such a message without 0x, or with 0X, as the text it is written in: then
 * it is read both ways, the higher risk is kept, and it is never harmless.
 */
function analyzeMessage(raw, ctx) {
  const digits = typeof raw === 'string' && !isHex(raw) ? /^(?:0X)?([0-9a-fA-F]+)$/.exec(raw) : null;
  if (!digits) return readMessage(raw, ctx);
  const data = readMessage(`0x${digits[1]}`, ctx);
  const text = readMessage(raw, ctx);
  const shown = RISK_ORDER[text.risk] > RISK_ORDER[data.risk] ? text : data;
  return { ...shown, risk: maxRisk(shown.risk, 'caution'), reasons: [...shown.reasons, TWO_WAYS] };
}

function readMessage(raw, ctx) {
  const text = isHex(raw) ? hexToText(raw) : typeof raw === 'string' ? raw : null;
  if (text === null) {
    return {
      kind: 'message',
      risk: 'caution',
      headline: 'Signature for unreadable data',
      facts: [fact('Action', 'Sign a message'), fact('Data', String(raw ?? ''), { mono: true })],
      reasons: ['The message is not readable text, so you cannot see what you would be agreeing to.'],
      subject: { action: 'signMessage', readable: false },
    };
  }

  const siwe = /^(\S+) wants you to sign in with your Ethereum account/.exec(text);
  if (siwe) {
    const claimed = siwe[1].replace(/^https?:\/\//, '').toLowerCase();
    // The site that asked. A sandboxed or hidden frame has no origin ("null"):
    // then Guardian cannot compare the two, and says so.
    let host = '';
    try {
      const url = new URL(ctx.origin);
      if (url.protocol === 'https:' || url.protocol === 'http:') host = url.host.toLowerCase();
    } catch {
      host = '';
    }
    if (!host) {
      const unknown = `Guardian cannot tell which site asked for this sign-in (it came from a sandboxed or hidden frame). It signs you in to ${claimed}: continue only if you opened ${claimed} yourself.`;
      return {
        kind: 'signIn',
        risk: 'caution',
        headline: 'Sign-in request from a site Guardian cannot identify',
        facts: [
          fact('Action', 'Sign-in message'),
          fact('Sign-in for', claimed, { tone: 'caution' }),
          fact('You are on', 'a site Guardian cannot identify'),
        ],
        reasons: [unknown, 'This proves you own the wallet. It does not move funds or grant spending permissions.'],
        warnings: [unknown],
        subject: { action: 'signIn', domain: claimed, mismatch: false, unknownSite: true },
        message: text,
      };
    }
    const mismatch = claimed !== host;
    return {
      kind: 'signIn',
      risk: mismatch ? 'danger' : 'info',
      headline: mismatch ? 'Sign-in request for a different site' : `Sign in to ${claimed}`,
      facts: [
        fact('Action', 'Sign-in message'),
        fact('Sign-in for', claimed, mismatch ? { tone: 'danger' } : {}),
        fact('You are on', host),
      ],
      reasons: mismatch
        ? [`The message signs you in to ${claimed}, but you are on ${host}. A signature made here could be used to log in there as you.`]
        : ['This proves you own the wallet. It does not move funds or grant spending permissions.'],
      warnings: mismatch
        ? [`The message signs you in to ${claimed}, but you are on ${host}. A signature made here could be used to log in there as you.`]
        : [],
      subject: { action: 'signIn', domain: claimed, mismatch },
      message: text,
    };
  }

  return {
    kind: 'message',
    risk: 'info',
    headline: 'Sign a text message',
    facts: [fact('Action', 'Sign a message')],
    reasons: ['Signing readable text does not move funds by itself. Read it before you sign.'],
    subject: { action: 'signMessage', readable: true },
    message: text,
  };
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * The account that sends or signs the request. The wallet signs only with
 * one of the user's own accounts, so this is the user's.
 */
function signerAddresses(req) {
  const out = new Set();
  // "0X…" too: the wallet compares the account in lower case.
  const add = (v) => {
    if (typeof v === 'string' && /^0[xX][0-9a-fA-F]{40}$/.test(v)) out.add(v.toLowerCase());
  };
  const params = Array.isArray(req && req.params) ? req.params : [];
  const method = String((req && req.method) || '');
  if (/^eth_send|^wallet_sendCalls|^eth_signTransaction/.test(method)) {
    add(params[0] && params[0].from);
  } else if (/sign/i.test(method)) {
    // personal_sign(message, address), eth_sign(address, data),
    // eth_signTypedData*(address, data): the account is the address param.
    params.slice(0, 2).forEach(add);
  }
  return [...out];
}

/** The wallet's accounts as the page reported them (eth_accounts): any address a page wants. */
function reportedAccounts(req) {
  const accounts = req && req.enrich && Array.isArray(req.enrich.accounts) ? req.enrich.accounts : [];
  return [...new Set(accounts.filter((v) => typeof v === 'string' && ADDRESS_PATTERN.test(v)).map((v) => v.toLowerCase()))].slice(0, 10);
}

/**
 * The user's address(es) in a request, to keep out of anything that may
 * leave the computer. The account that sends or signs it comes first, as a
 * string: the user's own. The other accounts the page reported follow as
 * { address, reported: true }: kept out too, but never called the user's
 * own (src/ai/guard.js), since a page can report any address.
 */
export function ownAddresses(req) {
  const signers = signerAddresses(req);
  const reported = reportedAccounts(req).filter((a) => !signers.includes(a));
  return [...signers, ...reported.map((address) => ({ address, reported: true }))];
}

function fact(label, value, extra = {}) {
  return { label, value: value === null || value === undefined ? 'unknown' : String(value), ...extra };
}
