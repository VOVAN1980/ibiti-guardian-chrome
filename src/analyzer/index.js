// Deterministic request analyzer: turns a wallet request into verifiable facts
// and a risk level. No AI here. The model later explains these facts in plain
// language; it never decides what the request is or how risky it is.

import {
  MAX_UINT160,
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
  word,
  wordToAddress,
  wordToBigInt,
} from './abi.js';
import { PERMIT2, chainInfo, knownSpender, knownToken } from './registry.js';

const SELECTOR = {
  approve: '0x095ea7b3',
  increaseAllowance: '0x39509351',
  setApprovalForAll: '0xa22cb465',
  transfer: '0xa9059cbb',
  transferFrom: '0x23b872dd',
  permit2Approve: '0x87517c45',
};

const RISK_ORDER = { info: 0, caution: 1, danger: 2 };
const STABLE_SYMBOLS = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'FDUSD', 'TUSD']);

export function maxRisk(a, b) {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/**
 * @param {object} req
 * @param {string} req.method   EIP-1193 method
 * @param {Array}  req.params
 * @param {number|null} [req.chainId]
 * @param {string} [req.origin] origin of the page that asked
 * @param {object} [req.enrich] on-chain reads made through the user's wallet:
 *   { token: {symbol, decimals}, spenderIsContract: boolean|null }
 */
export function analyze(req) {
  const ctx = {
    chainId: typeof req.chainId === 'number' ? req.chainId : null,
    origin: req.origin || '',
    enrich: req.enrich || {},
  };
  const params = Array.isArray(req.params) ? req.params : [];

  switch (req.method) {
    case 'eth_sendTransaction':
      return analyzeTransaction(params[0] || {}, ctx);
    case 'wallet_sendCalls':
      return analyzeBatch(params[0] || {}, ctx);
    case 'eth_signTypedData_v4':
    case 'eth_signTypedData_v3':
      return analyzeTypedData(params[1], ctx);
    case 'eth_signTypedData':
    case 'eth_signTypedData_v1':
      return analyzeTypedData(isAddress(params[0]) ? params[1] : params[0], ctx);
    case 'personal_sign':
      return analyzeMessage(isAddress(params[0]) && !isAddress(params[1]) ? params[1] : params[0], ctx);
    case 'eth_sign':
      return {
        kind: 'blindSign',
        risk: 'danger',
        headline: 'Blind signature request',
        facts: [
          fact('Action', 'Sign raw data (eth_sign)'),
          fact('Data', String(params[1] ?? ''), { mono: true }),
        ],
        reasons: [
          'This method signs data you cannot read. The signature can authorize any transaction from your wallet.',
          'Legitimate apps no longer use it; most wallets disable it by default.',
        ],
        subject: { action: 'eth_sign' },
      };
    default:
      return {
        kind: 'unknown',
        risk: 'caution',
        headline: `Wallet request: ${req.method}`,
        facts: [fact('Method', String(req.method), { mono: true })],
        reasons: ['Guardian does not recognise this request type.'],
        subject: { action: String(req.method) },
      };
  }
}

// ── Transactions ───────────────────────────────────────────────────────────

function analyzeTransaction(tx, ctx) {
  const to = normAddress(tx.to);
  const data = isHex(tx.data) ? tx.data : isHex(tx.input) ? tx.input : '0x';
  const value = toBigInt(tx.value) ?? 0n;
  const chain = chainInfo(ctx.chainId);

  if (!to) {
    return {
      kind: 'deploy',
      risk: 'caution',
      headline: 'Deploy a new contract',
      facts: [fact('Action', 'Contract deployment'), fact('Network', chain.name)],
      reasons: ['This creates a new contract from your wallet. Sites rarely need this from visitors.'],
      subject: { action: 'deploy' },
    };
  }

  if (strip0x(data).length === 0) {
    return nativeTransfer(to, value, chain);
  }

  const selector = selectorOf(data);
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
      if (to === PERMIT2) {
        return tokenApproval({
          token: wordToAddress(word(data, 0)),
          spender: wordToAddress(word(data, 1)),
          amount: wordToBigInt(word(data, 2)),
          via: 'Permit2 approve',
          ctx: { ...ctx, enrich: {} },
          unlimitedAt: MAX_UINT160,
        });
      }
      break;
    default:
      break;
  }

  const facts = [
    fact('Action', 'Contract call Guardian cannot decode'),
    fact('Contract', to, { mono: true }),
    fact('Function', selector || 'unknown', { mono: true }),
    fact('Network', chain.name),
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
    subject: { action: 'contractCall', contract: to, selector, value: value.toString() },
  };
}

function nativeTransfer(to, value, chain) {
  const amount = `${formatUnits(value, 18)} ${chain.native}`;
  return {
    kind: 'nativeTransfer',
    risk: value > 0n ? 'caution' : 'info',
    headline: value > 0n ? `Send ${amount}` : 'Empty transaction',
    facts: [
      fact('Action', 'Send coins'),
      fact('Amount', amount),
      fact('To', to, { mono: true }),
      fact('Network', chain.name),
    ],
    reasons:
      value > 0n
        ? ['This sends coins straight to the address above. A confirmed transfer cannot be undone.']
        : [],
    subject: { action: 'nativeTransfer', to, amount },
  };
}

/** Token as shown to the user, with whether the contract address is verified. */
function describeToken(address, ctx) {
  const verified = knownToken(ctx.chainId, address);
  if (verified) {
    return { ...verified, address, verified: true, label: `${verified.symbol} (${verified.name})` };
  }
  const onChain = ctx.enrich.token;
  const symbol = onChain && typeof onChain.symbol === 'string' ? onChain.symbol.slice(0, 24) : null;
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

function describeAmount(amount, token, unlimitedAt = UNLIMITED_THRESHOLD) {
  if (amount === null) return { text: 'unknown', unlimited: false };
  if (amount >= unlimitedAt) return { text: 'Unlimited', unlimited: true };
  if (token.decimals !== null && token.decimals !== undefined) {
    return {
      text: `${formatUnits(amount, token.decimals)}${token.symbol ? ` ${token.symbol}` : ''}`,
      unlimited: false,
    };
  }
  return { text: `${amount.toString()} base units`, unlimited: false };
}

function spenderFacts(spender, ctx, reasons) {
  const known = knownSpender(spender);
  let risk = 'info';
  if (known) {
    return { risk, known, value: `${known} · ${shortAddress(spender)}` };
  }
  if (ctx.enrich.spenderIsContract === false) {
    risk = 'danger';
    reasons.push(
      'The spender is a personal wallet, not a contract. Real apps ask you to approve their contract, almost never a person.',
    );
    return { risk, known: null, value: spender, note: 'personal wallet' };
  }
  return { risk, known: null, value: spender };
}

function tokenApproval({ token, spender, amount, via, ctx, unlimitedAt }) {
  const chain = chainInfo(ctx.chainId);
  const tok = describeToken(token, ctx);
  const amt = describeAmount(amount, tok, unlimitedAt);
  const symbol = tok.symbol || 'this token';
  const reasons = [];

  if (amount === 0n) {
    return {
      kind: 'revoke',
      risk: 'info',
      headline: `Remove a spending permission for ${symbol}`,
      facts: [
        fact('Action', 'Revoke approval'),
        fact('Token', tok.label),
        fact('Spender', spender, { mono: true }),
        fact('Network', chain.name),
      ],
      reasons: ['This sets the allowance to zero, so the spender can no longer move this token.'],
      subject: { action: 'revoke', token: tok, spender },
    };
  }

  let risk = 'caution';
  const sp = spenderFacts(spender, ctx, reasons);
  risk = maxRisk(risk, sp.risk);

  if (amt.unlimited) {
    reasons.unshift(
      `The spender could move any amount of ${symbol} from your wallet, now or later, without asking again.`,
    );
    if (!sp.known) risk = 'danger';
  } else {
    reasons.unshift(`The spender could move up to ${amt.text} from your wallet without asking again.`);
  }
  if (!sp.known) reasons.push('Guardian does not recognise the spender address.');
  if (tok.impersonates) {
    risk = 'danger';
    reasons.push(
      `This token calls itself ${tok.symbol}, but its contract is not the real ${tok.symbol} on ${chain.name}.`,
    );
  }
  reasons.push('The permission stays active until you revoke it.');

  return {
    kind: 'approve',
    risk,
    headline: amt.unlimited
      ? `Unlimited spending permission for ${symbol}`
      : `Spending permission for ${amt.text}`,
    facts: [
      fact('Action', `Token approval (${via})`),
      fact('Token', tok.label, tok.verified ? { tone: 'ok', note: 'verified contract' } : {}),
      fact('Amount', amt.text, amt.unlimited ? { tone: 'danger' } : {}),
      fact('Spender', sp.value, { mono: !sp.known, ...(sp.note ? { tone: 'danger', note: sp.note } : {}) }),
      fact('Network', chain.name),
    ],
    reasons,
    subject: { action: 'approve', token: tok, spender, spenderName: sp.known, amount: amt.text },
  };
}

function approvalForAll({ collection, operator, approved, ctx }) {
  const chain = chainInfo(ctx.chainId);
  if (!approved) {
    return {
      kind: 'revoke',
      risk: 'info',
      headline: 'Remove access to a collection',
      facts: [
        fact('Action', 'Revoke approval for all'),
        fact('Collection', collection, { mono: true }),
        fact('Operator', operator, { mono: true }),
        fact('Network', chain.name),
      ],
      reasons: ['This removes the operator’s access to your items in this collection.'],
      subject: { action: 'revokeAll', collection, operator },
    };
  }
  const reasons = [
    'The operator could transfer every item you own in this collection, now or later, without asking again.',
  ];
  const sp = spenderFacts(operator, ctx, reasons);
  if (!sp.known) reasons.push('Guardian does not recognise the operator address.');
  reasons.push('The permission stays active until you revoke it.');
  return {
    kind: 'approveAll',
    risk: sp.known ? 'caution' : 'danger',
    headline: 'Access to all your items in a collection',
    facts: [
      fact('Action', 'Approval for all (setApprovalForAll)'),
      fact('Collection', collection, { mono: true }),
      fact('Items', 'All, including ones you get later', { tone: 'danger' }),
      fact('Operator', sp.value, { mono: !sp.known, ...(sp.note ? { tone: 'danger', note: sp.note } : {}) }),
      fact('Network', chain.name),
    ],
    reasons,
    subject: { action: 'approveAll', collection, operator, operatorName: sp.known },
  };
}

function tokenTransfer({ token, from, recipient, amount, ctx }) {
  const chain = chainInfo(ctx.chainId);
  const tok = describeToken(token, ctx);
  const amt = describeAmount(amount, tok);
  const facts = [
    fact('Action', from ? 'Token transfer (transferFrom)' : 'Token transfer'),
    fact('Token', tok.label, tok.verified ? { tone: 'ok', note: 'verified contract' } : {}),
    fact('Amount', amt.text),
  ];
  if (from) facts.push(fact('From', from, { mono: true }));
  facts.push(fact('To', recipient, { mono: true }), fact('Network', chain.name));
  return {
    kind: 'transfer',
    risk: 'caution',
    headline: `Send ${amt.text}`,
    facts,
    reasons: ['This moves tokens to the address above. A confirmed transfer cannot be undone.'],
    subject: { action: 'transfer', token: tok, to: recipient, amount: amt.text },
  };
}

function analyzeBatch(batch, ctx) {
  const calls = Array.isArray(batch.calls) ? batch.calls : [];
  const chainId = toBigInt(batch.chainId);
  const inner = { ...ctx, chainId: chainId !== null ? Number(chainId) : ctx.chainId, enrich: {} };
  const parts = calls.map((c) => analyzeTransaction(c || {}, inner));
  const risk = parts.reduce((r, p) => maxRisk(r, p.risk), 'info');
  return {
    kind: 'batch',
    risk: parts.length === 0 ? 'caution' : risk,
    headline: `${parts.length} actions in one confirmation`,
    facts: parts.map((p, i) => fact(`Action ${i + 1}`, p.headline, p.risk === 'danger' ? { tone: 'danger' } : {})),
    reasons: [
      'One confirmation would carry out every action listed above.',
      ...parts.filter((p) => p.risk === 'danger').flatMap((p) => p.reasons.slice(0, 1)),
    ],
    parts,
    subject: { action: 'batch', actions: parts.map((p) => p.subject) },
  };
}

// ── Signatures ─────────────────────────────────────────────────────────────

const OFFCHAIN_NOTE =
  'This is a signature, not a transaction: it costs no gas and shows nothing in your wallet history until someone uses it.';

function analyzeTypedData(raw, ctx) {
  let typed = raw;
  if (typeof raw === 'string') {
    try {
      typed = JSON.parse(raw);
    } catch {
      typed = null;
    }
  }
  if (!typed || typeof typed !== 'object' || Array.isArray(typed)) {
    return {
      kind: 'typedData',
      risk: 'caution',
      headline: 'Structured data signature',
      facts: [fact('Action', 'Sign structured data')],
      reasons: ['Guardian could not read the data in this request.'],
      subject: { action: 'signTypedData' },
    };
  }

  const primaryType = String(typed.primaryType || '');
  const domain = typed.domain && typeof typed.domain === 'object' ? typed.domain : {};
  const message = typed.message && typeof typed.message === 'object' ? typed.message : {};
  const domainChain = toBigInt(domain.chainId);
  const inner = {
    ...ctx,
    chainId: domainChain !== null ? Number(domainChain) : ctx.chainId,
    // On-chain reads were made for the transaction target, not for this token.
    enrich: { spenderIsContract: ctx.enrich.spenderIsContract ?? null, token: ctx.enrich.token },
  };
  const verifying = normAddress(domain.verifyingContract);

  if (primaryType === 'Permit' && normAddress(message.spender)) {
    const daiStyle = 'allowed' in message && !('value' in message);
    const amount = daiStyle
      ? message.allowed === true || message.allowed === 'true'
        ? UNLIMITED_THRESHOLD
        : 0n
      : toBigInt(message.value);
    const result = tokenApproval({
      token: verifying,
      spender: normAddress(message.spender),
      amount,
      via: 'permit signature',
      ctx: inner,
    });
    return withOffchainNote(result, 'permit', message.deadline ?? message.expiry);
  }

  if (verifying === PERMIT2 || /^Permit(Single|Batch|TransferFrom|BatchTransferFrom|WitnessTransferFrom|BatchWitnessTransferFrom)$/.test(primaryType)) {
    const spender = normAddress(message.spender);
    const details = message.details ?? message.permitted;
    const items = (Array.isArray(details) ? details : [details]).filter((d) => d && typeof d === 'object');
    if (spender && items.length > 0) {
      const parts = items.map((item) =>
        tokenApproval({
          token: normAddress(item.token),
          spender,
          amount: toBigInt(item.amount),
          via: 'Permit2 signature',
          ctx: { ...inner, enrich: { spenderIsContract: inner.enrich.spenderIsContract } },
          unlimitedAt: MAX_UINT160,
        }),
      );
      if (parts.length === 1) {
        return withOffchainNote(parts[0], 'permit2', message.sigDeadline ?? message.deadline);
      }
      const risk = parts.reduce((r, p) => maxRisk(r, p.risk), 'info');
      return withOffchainNote(
        {
          kind: 'permit2',
          risk,
          headline: `Spending permissions for ${parts.length} tokens`,
          facts: parts.map((p, i) => fact(`Token ${i + 1}`, p.headline, p.risk === 'danger' ? { tone: 'danger' } : {})),
          reasons: parts[0].reasons,
          parts,
          subject: { action: 'permit2Batch', actions: parts.map((p) => p.subject) },
        },
        'permit2',
        message.sigDeadline ?? message.deadline,
      );
    }
  }

  if (primaryType === 'OrderComponents' || primaryType === 'Order') {
    const offer = Array.isArray(message.offer) ? message.offer.length : null;
    return {
      kind: 'order',
      risk: 'caution',
      headline: 'Marketplace order signature',
      facts: [
        fact('Action', 'Sign a marketplace order'),
        fact('App', String(domain.name || 'unknown')),
        ...(offer !== null ? [fact('Items you offer', String(offer))] : []),
      ],
      reasons: [
        'Whoever holds this signature can complete the trade it describes, including transferring the items you offer.',
        'Check the price: scam orders list valuable items for almost nothing.',
        OFFCHAIN_NOTE,
      ],
      subject: { action: 'marketOrder', app: String(domain.name || '') },
    };
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

function withOffchainNote(result, kind, deadline) {
  const facts = [...result.facts];
  const d = toBigInt(deadline);
  if (d !== null) {
    const farFuture = d > BigInt(Math.floor(Date.now() / 1000)) + 365n * 24n * 3600n;
    facts.push(
      fact(
        'Valid until',
        farFuture ? 'More than a year from now' : new Date(Number(d) * 1000).toISOString().slice(0, 16).replace('T', ' '),
        farFuture ? { tone: 'caution' } : {},
      ),
    );
  }
  return { ...result, kind: result.kind === 'revoke' ? 'revoke' : kind, facts, reasons: [...result.reasons, OFFCHAIN_NOTE] };
}

function analyzeMessage(raw, ctx) {
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
    let host = '';
    try {
      host = new URL(ctx.origin).host.toLowerCase();
    } catch {
      host = '';
    }
    const mismatch = host !== '' && claimed !== host;
    return {
      kind: 'signIn',
      risk: mismatch ? 'danger' : 'info',
      headline: mismatch ? 'Sign-in request for a different site' : `Sign in to ${claimed}`,
      facts: [
        fact('Action', 'Sign-in message'),
        fact('Sign-in for', claimed, mismatch ? { tone: 'danger' } : {}),
        ...(host ? [fact('You are on', host)] : []),
      ],
      reasons: mismatch
        ? [`The message signs you in to ${claimed}, but you are on ${host}. A signature made here could be used to log in there as you.`]
        : ['This proves you own the wallet. It does not move funds or grant spending permissions.'],
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

function fact(label, value, extra = {}) {
  return { label, value: value === null || value === undefined ? 'unknown' : String(value), ...extra };
}
