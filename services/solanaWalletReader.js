/**
 * Solana Wallet Reader — READ-ONLY.
 *
 * V1 observes exactly ONE Solana address. Every function here takes an address
 * (a base58 public key) and nothing else. There is no seed phrase, no private
 * key, no signing, and no transaction submission anywhere in this module. If
 * you ever find yourself importing `getWallet` from walletManager.js here,
 * stop — that is the hot-wallet path and it does not belong in the observer.
 *
 * What is reused rather than rebuilt:
 *   - `getConnection()` from ./walletManager.js  — the repo already has one
 *     RPC endpoint convention (SOLANA_RPC_URL, else mainnet-beta) and one
 *     cached Connection. Reading it from there keeps a single endpoint config.
 *     `getConnection()` never touches SOLANA_PRIVATE_KEY, so importing
 *     walletManager does not drag the signing path in.
 *   - `getSupportedSymbols`/`getTokenAddress` from ./tokenMapping.js for
 *     cosmetic mint -> symbol labels.
 *
 * THE HARD RULE: this module never invents a number. If the RPC is down, the
 * portfolio comes back with `complete: false` and a reason, and the balance
 * fields are `null` — not zero, not a cached guess, not a synthetic figure.
 * `services/marketData.js` has a `generateSyntheticData()` random-walk
 * fallback; nothing in that family is allowed anywhere near this file.
 */

import { PublicKey } from '@solana/web3.js';
import axios from 'axios';
import { getConnection } from './walletManager.js';
import { getSupportedSymbols, getTokenAddress } from './tokenMapping.js';
import 'dotenv/config';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Wrapped SOL. Native lamports are reported under this mint so that a
 *  wrap/unwrap inside a Jupiter route does not read as two different assets. */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_DECIMALS = 9;

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/**
 * Jupiter's public Price API. No key required.
 * v3 is the current endpoint; v2 is kept as a fallback because the public
 * hosts have been renamed more than once (`quote-api.jup.ag` is already dead —
 * see services/jupiterSwap.js, which had to move to lite-api.jup.ag).
 */
const PRICE_ENDPOINTS = [
  { id: 'JUPITER_PRICE_V3', url: 'https://lite-api.jup.ag/price/v3' },
  { id: 'JUPITER_PRICE_V2', url: 'https://api.jup.ag/price/v2' }
];

const PRICE_BATCH_SIZE = 50;
const SIGNATURE_PAGE_SIZE = 1000; // RPC hard maximum for getSignaturesForAddress
const DEFAULT_MAX_SIGNATURES = 200;
const TRANSACTION_BATCH_SIZE = 25;
const DEFAULT_MAX_TRANSACTIONS = 100;

/** Short TTL. Vercel lambdas are ephemeral, so this only helps within a single
 *  warm instance; the real caching lever is the `s-maxage` CDN header set by
 *  the API layer (same pattern as api/bitcoin-economic-value.js). */
const PORTFOLIO_TTL_MS = 30_000;
const PRICE_TTL_MS = 30_000;

/* ------------------------------------------------------------------ *
 * Address validation — pure, dependency-free
 * ------------------------------------------------------------------ */

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX = (() => {
  const map = Object.create(null);
  for (let i = 0; i < B58_ALPHABET.length; i++) map[B58_ALPHABET[i]] = i;
  return map;
})();

/**
 * Decode base58 to bytes. Returns null on any character outside the alphabet.
 * Written out rather than delegated to `bs58` or `new PublicKey()` so that
 * validation stays a pure function with no import graph — the test harness
 * checks it without a network stack or an RPC client.
 */
export function base58Decode(input) {
  if (typeof input !== 'string' || input.length === 0) return null;

  // Starts empty, not [0]: seeding a zero byte here would be counted a second
  // time by the leading-zero pass below, and an all-'1' address (the System
  // Program, 32 zero bytes) would decode to 33 bytes and fail validation.
  const bytes = [];
  for (const ch of input) {
    const value = B58_INDEX[ch];
    if (value === undefined) return null;

    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Every leading '1' in base58 is one leading zero byte.
  for (let i = 0; i < input.length && input[i] === '1'; i++) bytes.push(0);

  return Uint8Array.from(bytes.reverse());
}

/**
 * True for a well-formed Solana address: base58 that decodes to exactly 32
 * bytes. Deliberately does NOT require the point to be on the ed25519 curve —
 * program-derived addresses are legitimate addresses to observe.
 *
 * @param {string} address
 * @returns {boolean}
 */
export function validateSolanaAddress(address) {
  if (typeof address !== 'string') return false;
  // 32 bytes encodes to 32..44 base58 characters.
  if (address.length < 32 || address.length > 44) return false;
  const decoded = base58Decode(address);
  return decoded !== null && decoded.length === 32;
}

/* ------------------------------------------------------------------ *
 * Small infrastructure: cache + bounded retry
 * ------------------------------------------------------------------ */

const cache = new Map();

function cacheGet(key, ttl) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  return null;
}

function cacheSet(key, value) {
  cache.set(key, { value, at: Date.now() });
}

/** Exposed for the validation harness and for `?refresh=true`. */
export function clearCache() {
  cache.clear();
}

/**
 * The RPC client to use. Defaults to walletManager's cached Connection.
 *
 * `opts.connection` exists so callers — including the validation harness — can
 * supply their own client. ES module namespaces are sealed, so a test cannot
 * monkey-patch `getConnection`; without an injection point the "RPC is down"
 * branch could only be covered by actually breaking the network, and that
 * branch is the one guarding against reporting a fabricated balance. It is
 * worth an explicit seam.
 */
function resolveConnection(opts = {}) {
  return opts.connection || getConnection();
}

function isRetryable(error) {
  const status = error?.response?.status;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('429') ||
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('socket hang up')
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bounded exponential backoff. Public Solana RPCs rate-limit aggressively, so
 * every network call goes through here. Bounded on purpose: a serverless
 * function that retries forever just burns the request budget and then fails
 * anyway. When the attempts run out the error propagates and the caller turns
 * it into `complete: false`.
 */
async function withRetry(fn, { attempts = 3, baseDelayMs = 400, label = 'rpc' } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1 || !isRetryable(error)) break;
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(`[SolanaWalletReader] ${label} attempt ${attempt + 1} failed (${error.message}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
}

/* ------------------------------------------------------------------ *
 * Symbol labels
 * ------------------------------------------------------------------ */

/**
 * Mint -> symbol, derived from services/tokenMapping.js.
 *
 * Caveat worth knowing: tokenMapping.js carries `TODO: Verify actual WBTC/WETH
 * token address` against its BTC and ETH entries. Those labels are therefore
 * not trustworthy. The MINT is always the authoritative identifier in every
 * record this module emits; `symbol` is a display convenience and may be null.
 */
const MINT_TO_SYMBOL = (() => {
  const map = Object.create(null);
  for (const symbol of getSupportedSymbols()) {
    const mint = getTokenAddress(symbol);
    if (!mint) continue;
    // Prefer the bare ticker ('SOL') over the pair alias ('SOLUSDT').
    const existing = map[mint];
    if (!existing || symbol.length < existing.length) map[mint] = symbol;
  }
  return map;
})();

export function symbolForMint(mint) {
  return MINT_TO_SYMBOL[mint] || null;
}

/* ------------------------------------------------------------------ *
 * Prices
 * ------------------------------------------------------------------ */

/**
 * Normalise the two Jupiter Price response shapes into `{ mint: number }`.
 * v3 returns a flat map of `{ usdPrice }`; v2 wraps it in `data` with `price`.
 * Anything that is not a finite positive number is dropped rather than coerced.
 */
function normalisePriceResponse(body) {
  const out = Object.create(null);
  if (!body || typeof body !== 'object') return out;

  const table = body.data && typeof body.data === 'object' ? body.data : body;
  for (const [mint, entry] of Object.entries(table)) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry.usdPrice !== undefined ? entry.usdPrice : entry.price;
    const price = typeof raw === 'string' ? Number(raw) : raw;
    if (Number.isFinite(price) && price > 0) out[mint] = price;
  }
  return out;
}

/**
 * USD prices for a list of mints.
 *
 * @returns {Promise<{ prices: Object, source: string|null, failures: string[] }>}
 *   `prices` only contains mints the provider actually answered for. A mint
 *   that is missing stays missing — it is never back-filled from a stale copy
 *   or a sibling token.
 */
export async function getTokenPrices(mints, opts = {}) {
  const unique = [...new Set((mints || []).filter(Boolean))];
  if (unique.length === 0) return { prices: {}, source: null, failures: [] };

  const cacheKey = `prices:${unique.slice().sort().join(',')}`;
  if (!opts.forceRefresh) {
    const hit = cacheGet(cacheKey, PRICE_TTL_MS);
    if (hit) return hit;
  }

  const failures = [];

  for (const endpoint of PRICE_ENDPOINTS) {
    try {
      const prices = Object.create(null);

      for (let i = 0; i < unique.length; i += PRICE_BATCH_SIZE) {
        const batch = unique.slice(i, i + PRICE_BATCH_SIZE);
        const response = await withRetry(
          () => axios.get(endpoint.url, {
            params: { ids: batch.join(',') },
            timeout: opts.timeoutMs || 10_000
          }),
          { attempts: 2, label: endpoint.id }
        );
        Object.assign(prices, normalisePriceResponse(response.data));
      }

      // An endpoint that answers 200 with nothing usable is a failure, not a
      // success with zero prices — fall through and try the next one.
      if (Object.keys(prices).length === 0) {
        failures.push(`${endpoint.id}: responded with no usable prices`);
        continue;
      }

      const result = { prices, source: endpoint.id, failures };
      cacheSet(cacheKey, result);
      return result;
    } catch (error) {
      failures.push(`${endpoint.id}: ${error.message}`);
    }
  }

  return { prices: {}, source: null, failures };
}

/* ------------------------------------------------------------------ *
 * Portfolio
 * ------------------------------------------------------------------ */

function emptyPortfolio(address, warnings) {
  return {
    address,
    solBalance: null,
    tokens: [],
    totalUsdValue: null,
    at: new Date().toISOString(),
    complete: false,
    warnings
  };
}

/**
 * Current holdings and USD value for one observed address.
 *
 * @param {string} address                  base58 public key
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh]     bypass the in-memory cache
 * @param {boolean} [opts.includeZero]      keep zero-balance token accounts
 * @returns {Promise<{
 *   address: string,
 *   solBalance: number|null,
 *   tokens: Array<{mint,symbol,amount,decimals,usdValue,priceSource}>,
 *   totalUsdValue: number|null,
 *   at: string,
 *   complete: boolean,
 *   warnings: string[]
 * }>}
 *
 * `complete: false` means at least one input was unavailable. The UI shows
 * "WALLET DATA UNAVAILABLE" on that flag; the warnings say which input failed.
 */
export async function getWalletPortfolio(address, opts = {}) {
  if (!validateSolanaAddress(address)) {
    return emptyPortfolio(address, ['INVALID_ADDRESS: not a base58-encoded 32-byte Solana address']);
  }

  const cacheKey = `portfolio:${address}:${opts.includeZero ? 'all' : 'nonzero'}`;
  if (!opts.forceRefresh) {
    const hit = cacheGet(cacheKey, PORTFOLIO_TTL_MS);
    if (hit) return { ...hit, cached: true };
  }

  const warnings = [];
  const owner = new PublicKey(address);
  const connection = resolveConnection(opts);

  // ---- 1. On-chain balances. A failure here is fatal: with no balances there
  //         is no portfolio, and an empty one would read as "wallet is empty".
  let lamports;
  let tokenAccounts = [];
  try {
    const [balance, ...accountSets] = await Promise.all([
      withRetry(() => connection.getBalance(owner), { label: 'getBalance' }),
      ...[TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) =>
        withRetry(
          () => connection.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(programId) }),
          { label: `getParsedTokenAccountsByOwner(${programId.slice(0, 6)})` }
        )
      )
    ]);

    lamports = balance;
    for (const set of accountSets) tokenAccounts.push(...(set?.value || []));
  } catch (error) {
    console.error('[SolanaWalletReader] RPC read failed:', error.message);
    return emptyPortfolio(address, [`RPC_UNAVAILABLE: ${error.message}`]);
  }

  const solBalance = lamports / 10 ** SOL_DECIMALS;

  // ---- 2. Shape the holdings. Amounts come straight from the parsed account
  //         data; nothing is derived or rounded up.
  const holdings = [];
  for (const { account } of tokenAccounts) {
    const info = account?.data?.parsed?.info;
    if (!info) continue;

    const amountInfo = info.tokenAmount || {};
    const decimals = Number(amountInfo.decimals);
    const amount = Number(amountInfo.uiAmountString ?? amountInfo.uiAmount ?? 0);
    if (!Number.isFinite(amount)) continue;
    if (!opts.includeZero && amount === 0) continue;

    holdings.push({
      mint: info.mint,
      symbol: symbolForMint(info.mint),
      amount,
      decimals: Number.isFinite(decimals) ? decimals : null,
      usdValue: null,
      priceSource: null
    });
  }

  holdings.unshift({
    mint: SOL_MINT,
    symbol: 'SOL',
    amount: solBalance,
    decimals: SOL_DECIMALS,
    usdValue: null,
    priceSource: null,
    native: true
  });

  // ---- 3. Prices. A price outage degrades the portfolio; it does not void it.
  //         Balances are still real facts, so they are returned with
  //         `complete: false` and null USD values rather than dropped.
  const { prices, source, failures } = await getTokenPrices(
    holdings.map((h) => h.mint),
    { forceRefresh: opts.forceRefresh }
  );

  if (!source) {
    warnings.push(
      `PRICES_UNAVAILABLE: no price provider answered (${failures.join('; ') || 'no detail'})`
    );
  }

  let pricedTotal = 0;
  let unpriced = 0;
  for (const holding of holdings) {
    const price = prices[holding.mint];
    if (Number.isFinite(price)) {
      holding.usdValue = holding.amount * price;
      holding.priceSource = source;
      pricedTotal += holding.usdValue;
    } else {
      // Stays null. An unpriced token contributes nothing to the total and is
      // counted so the caller can say "value excludes N unpriced tokens".
      holding.usdValue = null;
      holding.priceSource = 'UNAVAILABLE';
      unpriced++;
    }
  }

  if (unpriced > 0 && source) {
    warnings.push(
      `PARTIAL_PRICING: ${unpriced} of ${holdings.length} holdings have no USD price; totalUsdValue excludes them`
    );
  }

  const complete = Boolean(source) && unpriced === 0;

  const portfolio = {
    address,
    solBalance,
    tokens: holdings,
    // If nothing at all could be priced, the total is unknown — not zero.
    totalUsdValue: source ? pricedTotal : null,
    at: new Date().toISOString(),
    complete,
    warnings,
    meta: {
      rpcEndpoint: describeRpcEndpoint(),
      priceSource: source,
      pricedCount: holdings.length - unpriced,
      unpricedCount: unpriced
    }
  };

  cacheSet(cacheKey, portfolio);
  return portfolio;
}

/** The configured endpoint, host only — never log a key-bearing RPC URL. */
export function describeRpcEndpoint() {
  const url = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

/* ------------------------------------------------------------------ *
 * Signatures and transactions
 * ------------------------------------------------------------------ */

/**
 * Paginated transaction signatures, newest first.
 *
 * Bounded on purpose. Public RPCs rate-limit hard, so the first page has to
 * come back fast: `maxSignatures` caps the walk and `hasMore` + `nextBefore`
 * let a caller continue explicitly rather than the reader silently paging
 * through a whale's ten-year history inside one lambda invocation.
 *
 * @returns {Promise<{signatures: Array, complete: boolean, warnings: string[],
 *                    hasMore: boolean, nextBefore: string|null}>}
 */
export async function getSignatures(address, opts = {}) {
  if (!validateSolanaAddress(address)) {
    return { signatures: [], complete: false, warnings: ['INVALID_ADDRESS'], hasMore: false, nextBefore: null };
  }

  const maxSignatures = Math.max(1, Math.min(opts.maxSignatures || DEFAULT_MAX_SIGNATURES, 10_000));
  const owner = new PublicKey(address);
  const connection = resolveConnection(opts);

  const warnings = [];
  const collected = [];
  let before = opts.before || undefined;
  let hasMore = false;

  try {
    while (collected.length < maxSignatures) {
      const pageSize = Math.min(SIGNATURE_PAGE_SIZE, maxSignatures - collected.length);
      const page = await withRetry(
        () => connection.getSignaturesForAddress(owner, {
          limit: pageSize,
          before,
          until: opts.until || undefined
        }),
        { label: 'getSignaturesForAddress' }
      );

      if (!page || page.length === 0) break;

      for (const item of page) {
        collected.push({
          signature: item.signature,
          slot: item.slot ?? null,
          blockTime: item.blockTime ?? null,
          at: item.blockTime ? new Date(item.blockTime * 1000).toISOString() : null,
          err: item.err ?? null
        });
      }

      before = page[page.length - 1].signature;

      // A short page means the address history is exhausted.
      if (page.length < pageSize) break;
      if (collected.length >= maxSignatures) hasMore = true;
    }
  } catch (error) {
    console.error('[SolanaWalletReader] getSignatures failed:', error.message);
    return {
      signatures: collected,
      complete: false,
      warnings: [...warnings, `RPC_UNAVAILABLE: ${error.message}`],
      hasMore: collected.length > 0,
      nextBefore: before || null
    };
  }

  if (collected.some((s) => s.blockTime === null)) {
    warnings.push('MISSING_BLOCKTIME: some signatures have no blockTime; their timestamps are null');
  }

  return {
    signatures: collected,
    complete: true,
    warnings,
    hasMore,
    nextBefore: hasMore ? before : null
  };
}

/**
 * Parsed transactions for a list of signatures, batched.
 *
 * A signature the RPC cannot return (pruned from the ledger, or a batch that
 * failed after its retries) is reported in `missing` and the result is marked
 * incomplete. It is never replaced with a placeholder object, because a
 * placeholder would flow downstream and be reconstructed as a trade.
 *
 * @returns {Promise<{transactions: Array, complete: boolean, warnings: string[], missing: string[]}>}
 */
export async function getTransactions(signatures, opts = {}) {
  const list = (signatures || [])
    .map((s) => (typeof s === 'string' ? s : s?.signature))
    .filter(Boolean);

  if (list.length === 0) return { transactions: [], complete: true, warnings: [], missing: [] };

  const cap = Math.max(1, Math.min(opts.maxTransactions || DEFAULT_MAX_TRANSACTIONS, 1000));
  const wanted = list.slice(0, cap);

  const warnings = [];
  if (list.length > cap) {
    warnings.push(`TRUNCATED: ${list.length} signatures requested, ${cap} fetched (maxTransactions)`);
  }

  const connection = resolveConnection(opts);
  const transactions = [];
  const missing = [];
  let rpcFailed = false;

  for (let i = 0; i < wanted.length; i += TRANSACTION_BATCH_SIZE) {
    const batch = wanted.slice(i, i + TRANSACTION_BATCH_SIZE);
    try {
      const results = await withRetry(
        () => connection.getParsedTransactions(batch, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed'
        }),
        { label: 'getParsedTransactions' }
      );

      results.forEach((tx, index) => {
        if (tx) transactions.push(tx);
        else missing.push(batch[index]);
      });
    } catch (error) {
      console.error('[SolanaWalletReader] getParsedTransactions batch failed:', error.message);
      warnings.push(`BATCH_FAILED: ${batch.length} transactions could not be fetched (${error.message})`);
      missing.push(...batch);
      rpcFailed = true;
    }
  }

  if (missing.length > 0 && !rpcFailed) {
    warnings.push(`MISSING_TRANSACTIONS: ${missing.length} signatures returned no transaction (likely ledger pruning)`);
  }

  return {
    transactions,
    complete: missing.length === 0 && list.length <= cap,
    warnings,
    missing
  };
}

/**
 * Convenience: signatures + parsed transactions in one bounded pass, shaped
 * for `reconstructTrades({ transactions, address })`.
 */
export async function getWalletActivity(address, opts = {}) {
  const maxTransactions = Math.max(1, Math.min(opts.maxTransactions || DEFAULT_MAX_TRANSACTIONS, 1000));

  const sigs = await getSignatures(address, {
    maxSignatures: maxTransactions,
    before: opts.before,
    until: opts.until,
    connection: opts.connection
  });

  if (sigs.signatures.length === 0) {
    return {
      transactions: [],
      signatures: [],
      complete: sigs.complete,
      warnings: sigs.warnings,
      hasMore: sigs.hasMore,
      nextBefore: sigs.nextBefore
    };
  }

  // Failed transactions moved no funds. Skip them before spending RPC budget.
  const succeeded = sigs.signatures.filter((s) => !s.err);
  const skipped = sigs.signatures.length - succeeded.length;

  const txs = await getTransactions(succeeded, { maxTransactions, connection: opts.connection });

  const warnings = [...sigs.warnings, ...txs.warnings];
  if (skipped > 0) warnings.push(`SKIPPED_FAILED_TX: ${skipped} failed transactions excluded (they moved no funds)`);

  return {
    transactions: txs.transactions,
    signatures: sigs.signatures,
    complete: sigs.complete && txs.complete,
    warnings,
    hasMore: sigs.hasMore,
    nextBefore: sigs.nextBefore
  };
}

/**
 * Price resolver factory for `reconstructTrades`. Resolves CURRENT USD price,
 * not the price at `at`.
 *
 * This distinction matters and is why the reconstruction layer marks anything
 * that leans on it as PARTIAL: Jupiter's public Price API serves spot, not
 * history. A swap settled against USDC needs no resolver at all — its USD
 * price is on-chain arithmetic. A swap settled against SOL needs the SOL/USD
 * price *at that block*, and this resolver cannot supply it.
 */
export function createCurrentPriceResolver(options = {}) {
  const memo = new Map();

  return async function resolvePrice(mint /* , atIso */) {
    if (memo.has(mint)) return memo.get(mint);
    const { prices, source } = await getTokenPrices([mint], options);
    const price = source && Number.isFinite(prices[mint]) ? prices[mint] : null;
    memo.set(mint, price);
    return price;
  };
}

export default {
  SOL_MINT,
  SOL_DECIMALS,
  validateSolanaAddress,
  base58Decode,
  symbolForMint,
  getTokenPrices,
  getWalletPortfolio,
  getSignatures,
  getTransactions,
  getWalletActivity,
  createCurrentPriceResolver,
  describeRpcEndpoint,
  clearCache
};
