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
 *   { token: {symbol, decimals}, spenderIsContract: boolean|null, accounts: string[] }
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
    chainId: typeof req.chainId === 'number' ? req.chainId : null,
    origin: req.origin || '',
    enrich: req.enrich || {},
    // The user's own addresses: who "you" are in this request.
    self: new Set(ownAddresses(req)),
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
        reasons: [BLIND_SIGN, 'Legitimate apps no longer use it; most wallets disable it by default.'],
        warnings: [BLIND_SIGN],
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
    return nativeTransfer(to, value, chain, ctx);
  }

  const selector = selectorOf(data);
  const decoded = decodeCall(selector, to, data, ctx);
  if (decoded) return value > 0n ? withCoins(decoded, value, chain, to) : decoded;

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

/** A token call Guardian can read, or null. */
function decodeCall(selector, to, data, ctx) {
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
      if (to !== PERMIT2) return null;
      // approve(token, spender, uint160 amount, uint48 expiration)
      return tokenApproval({
        token: wordToAddress(word(data, 0)),
        spender: wordToAddress(word(data, 1)),
        amount: wordToBigInt(word(data, 2)),
        via: 'Permit2 approve',
        ctx: { ...ctx, enrich: {} },
        unlimitedAt: MAX_UINT160,
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
 * A payment's risk is bounded by its amount. With the wallet balance known,
 * a small share is an ordinary payment; most of the balance is what "send a
 * little to claim" scams aim for. Without the balance, it stays "check".
 */
function shareOfBalance(amount, balance) {
  const total = toBigInt(balance);
  if (amount === null || total === null || total <= 0n) return null;
  return Number((amount * 1000n) / total) / 10; // percent, one decimal
}

function transferRisk(share, what) {
  if (share === null) {
    return { risk: 'caution', note: null, reasons: [] };
  }
  const percent = share >= 99.95 ? 'all' : share < 1 ? 'less than 1%' : `about ${Math.round(share)}%`;
  const note = `${percent === 'all' ? 'All' : percent} of your ${what}`;
  if (share >= 90) {
    return {
      risk: 'danger',
      note,
      reasons: [`This would send ${percent === 'all' ? 'all' : 'almost all'} of the ${what} in this wallet.`],
    };
  }
  if (share >= 25) return { risk: 'caution', note, reasons: [] };
  return { risk: 'info', note, reasons: [] };
}

function nativeTransfer(to, value, chain, ctx) {
  const amount = `${formatUnits(value, 18)} ${chain.native}`;
  const toSelf = ctx.self.has(to);
  const toFact = fact('To', to, { mono: true, ...(toSelf ? { note: 'an address of this wallet' } : {}) });
  if (value === 0n) {
    return {
      kind: 'nativeTransfer',
      risk: 'info',
      headline: 'Empty transaction',
      facts: [fact('Action', 'Send coins'), fact('Amount', amount), toFact, fact('Network', chain.name)],
      reasons: [],
      subject: { action: 'nativeTransfer', to, amount, empty: true, toSelf },
    };
  }
  const judged = transferRisk(shareOfBalance(value, ctx.enrich.balance), chain.native);
  return {
    kind: 'nativeTransfer',
    risk: judged.risk,
    headline: `Send ${amount}`,
    facts: [
      fact('Action', 'Send coins'),
      fact('Amount', amount, {
        ...(judged.note ? { note: judged.note } : {}),
        ...(judged.risk === 'danger' ? { tone: 'danger' } : {}),
      }),
      toFact,
      fact('Network', chain.name),
    ],
    reasons: [
      ...judged.reasons,
      'This sends coins straight to the address above. A confirmed transfer cannot be undone.',
    ],
    warnings: judged.reasons,
    // Reasons that come from the user's balance; kept out of cloud prompts.
    balanceReasons: judged.reasons,
    subject: { action: 'nativeTransfer', to, amount, shareOfBalance: judged.note, toSelf },
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
function tokenApproval({ token, spender, amount, via, ctx, unlimitedAt, expires = null, once = false }) {
  const chain = chainInfo(ctx.chainId);
  const tok = describeToken(token, ctx);
  const amt = describeAmount(amount, tok, unlimitedAt);
  const symbol = tok.symbol || 'this token';
  const reasons = [];
  // increaseAllowance adds to whatever the spender may already move.
  const more = via === 'increaseAllowance' && !amt.unlimited ? ' more' : '';

  if (amount === 0n && !once) {
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
      fact('Amount', `${amt.text}${more}`, amt.unlimited ? { tone: 'danger' } : {}),
      fact('Spender', sp.value, { mono: !sp.known, ...(sp.note ? { tone: 'danger', note: sp.note } : {}) }),
      fact('Network', chain.name),
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
      fact('Network', chain.name),
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
  const chain = chainInfo(ctx.chainId);
  const tok = describeToken(token, ctx);
  const amt = describeAmount(amount, tok);
  const fromSelf = !from || ctx.self.has(from);
  const toSelf = ctx.self.has(recipient);
  const judged = transferRisk(
    from ? null : shareOfBalance(amount, ctx.enrich.tokenBalance),
    tok.symbol || 'tokens',
  );
  const facts = [
    fact('Action', from ? 'Token transfer (transferFrom)' : 'Token transfer'),
    fact('Token', tok.label, tok.verified ? { tone: 'ok', note: 'verified contract' } : {}),
    fact('Amount', amt.text, {
      ...(judged.note ? { note: judged.note } : {}),
      ...(judged.risk === 'danger' ? { tone: 'danger' } : {}),
    }),
  ];
  if (from) facts.push(fact('From', from, { mono: true, note: fromSelf ? 'this wallet' : 'not this wallet' }));
  facts.push(
    fact('To', recipient, { mono: true, ...(toSelf ? { note: 'an address of this wallet' } : {}) }),
    fact('Network', chain.name),
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
      from: from || null,
      fromSelf,
      toSelf,
    },
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
    facts: parts.map((p, i) =>
      fact(`Action ${i + 1}`, withParty(p), p.risk === 'danger' ? { tone: 'danger' } : {}),
    ),
    // The main reason of each part that is high risk or cannot be read, and
    // every part's warnings.
    reasons: unique([
      'One confirmation would carry out every action listed above.',
      ...parts
        .filter((p) => p.risk === 'danger' || p.kind === 'contractCall' || p.kind === 'deploy')
        .flatMap((p) => p.reasons.slice(0, 1)),
      ...parts.flatMap((p) => p.warnings || []),
    ]),
    warnings: unique(parts.flatMap((p) => p.warnings || [])),
    parts,
    subject: { action: 'batch', actions: parts.map((p) => p.subject) },
  };
}

const unique = (list) => [...new Set(list)];

/** A batch line: what it does and with whom ("Send 0.2 WETH, to 0xa47c1e…00d3b9"). */
function withParty(part) {
  const s = part.subject || {};
  const who = (name, address) => (name ? name : address ? shortAddress(address) : null);
  let party = null;
  if (s.action === 'approve' || s.action === 'revoke') party = who(s.spenderName, s.spender) && `spender ${who(s.spenderName, s.spender)}`;
  else if (s.action === 'approveAll' || s.action === 'revokeAll') party = who(s.operatorName, s.operator) && `operator ${who(s.operatorName, s.operator)}`;
  else if (s.action === 'transfer' || s.action === 'nativeTransfer') party = s.to && `to ${shortAddress(s.to)}`;
  else if (s.action === 'contractCall') party = s.contract && `contract ${shortAddress(s.contract)}`;
  return party ? `${part.headline}, ${party}` : part.headline;
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
    // Two kinds of Permit2 signature. AllowanceTransfer ("details"): an
    // allowance with its own end time. SignatureTransfer ("permitted"): the
    // spender may take the amount once, before the signature's deadline.
    const once = message.details === undefined && message.permitted !== undefined;
    const details = once ? message.permitted : message.details;
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
          expires: once ? null : toBigInt(item.expiration),
          once,
        }),
      );
      const deadline = once ? message.deadline : message.sigDeadline ?? message.deadline;
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
    const end = when(d);
    facts.push(fact('Valid until', end.text, end.far ? { tone: 'caution' } : {}));
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

/**
 * The user's own address(es) in a request: the wallet's connected accounts
 * (read by the in-page guard) and the account that sends or signs it.
 */
export function ownAddresses(req) {
  const out = new Set();
  const add = (v) => {
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) out.add(v.toLowerCase());
  };
  const params = Array.isArray(req && req.params) ? req.params : [];
  const method = String((req && req.method) || '');
  const accounts = req && req.enrich && Array.isArray(req.enrich.accounts) ? req.enrich.accounts : [];
  accounts.forEach(add);
  if (/^eth_send|^wallet_sendCalls|^eth_signTransaction/.test(method)) {
    add(params[0] && params[0].from);
  } else if (/sign/i.test(method)) {
    // personal_sign(message, address), eth_sign(address, data),
    // eth_signTypedData*(address, data): the account is the address param.
    params.slice(0, 2).forEach(add);
  }
  return [...out];
}

function fact(label, value, extra = {}) {
  return { label, value: value === null || value === undefined ? 'unknown' : String(value), ...extra };
}
