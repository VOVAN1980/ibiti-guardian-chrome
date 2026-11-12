// Minimal ABI helpers: just enough to decode the calls a wallet drainer uses.
// No dependencies, BigInt only.

export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_UINT160 = (1n << 160n) - 1n;

/** Amounts at or above this are "unlimited" for any real token supply. */
export const UNLIMITED_THRESHOLD = 1n << 200n;

export function strip0x(hex) {
  return typeof hex === 'string' && hex.startsWith('0x') ? hex.slice(2) : hex || '';
}

export function isHex(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);
}

export function isAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function normAddress(value) {
  return isAddress(value) ? value.toLowerCase() : null;
}

/** 4-byte selector of calldata, lowercase with 0x, or null. */
export function selectorOf(data) {
  const hex = strip0x(data);
  return hex.length >= 8 ? `0x${hex.slice(0, 8).toLowerCase()}` : null;
}

/** The n-th 32-byte argument word of calldata as a hex string (no 0x). */
export function word(data, index) {
  const hex = strip0x(data);
  const start = 8 + index * 64;
  const w = hex.slice(start, start + 64);
  return w.length === 64 ? w : null;
}

export function wordToAddress(w) {
  return w ? `0x${w.slice(24).toLowerCase()}` : null;
}

export function wordToBigInt(w) {
  return w ? BigInt(`0x${w}`) : null;
}

export function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value.length > 0) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

/** "1234.5" style decimal string from base units. Trims trailing zeros. */
export function formatUnits(amount, decimals) {
  const d = BigInt(decimals);
  const base = 10n ** d;
  const whole = amount / base;
  const frac = amount % base;
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (frac === 0n) return wholeStr;
  const fracStr = frac.toString().padStart(Number(d), '0').replace(/0+$/, '');
  return `${wholeStr}.${fracStr.slice(0, 6)}`;
}

export function shortAddress(address) {
  return isAddress(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : String(address);
}

/** Decodes a hex string to text if it is printable UTF-8, else null. */
export function hexToText(hex) {
  const h = strip0x(hex);
  if (h.length === 0 || h.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(h)) return null;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  // Control characters other than tab/newline mean it is binary, not a message.
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) ? null : text;
}
