/**
 * Wallet Tracker Service
 *
 * Read-only balance reader for a single dedicated trading wallet. It exists so the risk
 * layer has an honest capital base and an honest P&L meter.
 *
 * The central distinction, and the reason this file is shaped the way it is:
 *
 *   MARGIN (stablecoins) is risk capital. Perps on this stack are stablecoin-collateralized
 *   (see services/jupiterPerps.js), so only USDC/USDT can actually back a position. Margin
 *   is also the P&L meter: it moves only when a trade settles, so "margin before vs margin
 *   after" is a clean trade result.
 *
 *   HOLDINGS (SOL, BTC, ETH, everything else) are NOT risk capital and NOT part of P&L.
 *   They drift with the market on their own, so folding them into equity would make every
 *   market move look like a trade outcome and destroy the win-rate measurement. They are
 *   reported only so a consumer can see existing correlated exposure before stacking
 *   another same-direction position on top.
 *
 * Read-only by construction:
 *   - Reads a PUBLIC address from TRACKED_WALLET_ADDRESS. It never reads the hot wallet's
 *     signing secret and never imports the hot-wallet module, so no signing key can reach
 *     this path or anything consuming it. (The signing env var is not named anywhere in
 *     this file on purpose - the MCP isolation suite greps this source for secret-bearing
 *     identifiers.)
 *   - Speaks raw Solana JSON-RPC over fetch rather than @solana/web3.js, keeping the
 *     keypair-capable SDK out of the read-only bundle entirely.
 *
 * Never throws. Every failure is reported as a status on the returned snapshot, so a
 * degraded read can never break a context build or fabricate a balance.
 */

import 'dotenv/config';

/** SPL Token program. Used as a single-key owner filter to enumerate every token account. */
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/**
 * Stablecoin mints that count as margin. Only assets that can collateralize a perp
 * position belong here.
 */
export const STABLE_MINTS = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT'
};

/**
 * Non-margin mints this build can price, using the symbol prices the caller already has.
 * Anything absent from this map is reported unpriced rather than guessed at.
 */
export const PRICED_MINTS = {
  So11111111111111111111111111111111111111112: 'SOL',
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 'BTC',
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: 'BTC',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'ETH'
};

/** SOL kept for transaction fees. Below this, the wallet cannot reliably transact. */
export const MIN_GAS_SOL = 0.02;

/** Upper bound on a single RPC round trip, so a slow node cannot stall a context build. */
export const RPC_TIMEOUT_MS = 5000;

export const LAMPORTS_PER_SOL = 1e9;

const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';

// Base58 alphabet, 32-44 chars: rejects obvious typos before spending an RPC call.
const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * @param {*} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @param {*} value
 * @param {number} decimals
 * @returns {number|null}
 */
function roundN(value, decimals) {
  if (!isFiniteNumber(value)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Shorten an address for display. The address is public chain data, but the payload
 * travels to a third-party model, so only enough is emitted to identify the wallet.
 *
 * @param {string} address
 * @returns {string|null}
 */
export function maskAddress(address) {
  if (typeof address !== 'string' || address.length < 12) return null;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/**
 * Snapshot carrying no balances. Used for every non-success path so consumers always
 * receive the same shape.
 *
 * @param {string} status - 'disabled' | 'unavailable'
 * @param {string|null} reason
 * @param {Object} [extra]
 * @returns {Object}
 */
export function emptySnapshot(status, reason, extra = {}) {
  return {
    status,
    reason: reason || null,
    address: null,
    fetchedAt: null,
    margin: { usd: null, byAsset: {} },
    holdings: [],
    holdingsUsd: null,
    unpriced: [],
    gas: { sol: null, minSol: MIN_GAS_SOL, sufficient: null },
    performance: { baselineUsd: null, netPnlUsd: null, returnPct: null, source: null },
    ...extra
  };
}

/**
 * One Solana JSON-RPC call with a hard timeout.
 *
 * @param {string} url
 * @param {string} method
 * @param {Array} params
 * @param {Object} [deps]
 * @param {number} [deps.timeoutMs]
 * @param {Function} [deps.fetchImpl] - injectable for tests
 * @returns {Promise<*>} the RPC `result`
 */
export async function rpcCall(url, method, params, deps = {}) {
  const { timeoutMs = RPC_TIMEOUT_MS, fetchImpl = fetch } = deps;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`rpc http ${response.status}`);
    }

    const body = await response.json();

    if (body && body.error) {
      // RPC error messages can be verbose; keep only the short message.
      throw new Error(`rpc error: ${body.error.message || 'unknown'}`);
    }

    return body ? body.result : null;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`rpc timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the native SOL balance, in SOL.
 *
 * @param {string} url
 * @param {string} address
 * @param {Object} [deps]
 * @returns {Promise<number>}
 */
async function fetchSolBalance(url, address, deps) {
  const result = await rpcCall(url, 'getBalance', [address, { commitment: 'confirmed' }], deps);
  const lamports = result && isFiniteNumber(result.value) ? result.value : null;

  if (lamports === null) {
    throw new Error('getBalance returned no value');
  }

  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Enumerate every SPL token account the address owns, as { mint, amount } pairs.
 *
 * Filters by programId, not by mint: one call returns the whole wallet, and the caller
 * classifies. The filter must carry exactly one key - a two-key filter is rejected by the
 * node with "expected map with a single key".
 *
 * A wallet keeps zero-balance accounts around after a position is closed, so those are
 * dropped here rather than reported as holdings.
 *
 * @param {string} url
 * @param {string} address
 * @param {Object} [deps]
 * @returns {Promise<Array<{mint:string, amount:number}>>}
 */
async function fetchTokenBalances(url, address, deps) {
  const result = await rpcCall(
    url,
    'getTokenAccountsByOwner',
    [address, { programId: TOKEN_PROGRAM_ID }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    deps
  );

  const accounts = result && Array.isArray(result.value) ? result.value : [];
  const byMint = new Map();

  for (const entry of accounts) {
    const info = entry && entry.account && entry.account.data && entry.account.data.parsed
      ? entry.account.data.parsed.info
      : null;
    if (!info || typeof info.mint !== 'string') continue;

    const amount = info.tokenAmount ? info.tokenAmount.uiAmount : null;
    if (!isFiniteNumber(amount) || amount === 0) continue;

    // A wallet can hold several accounts for one mint, so sum rather than overwrite.
    byMint.set(info.mint, (byMint.get(info.mint) || 0) + amount);
  }

  return Array.from(byMint, ([mint, amount]) => ({ mint, amount }));
}

/**
 * Read the tracked wallet, split into margin and holdings, and measure P&L against the
 * configured starting value.
 *
 * Statuses:
 *   disabled    - TRACKED_WALLET_ADDRESS not set. Feature is off; not an error.
 *   unavailable - address invalid, or a balance read failed. No capital figures at all.
 *   partial     - balances read, but some non-margin holding could not be priced. Margin
 *                 is exact and safe to size against; holdingsUsd is incomplete.
 *   available   - fully read and priced.
 *
 * @param {Object} [options]
 * @param {Object} [options.prices] - { SOL, BTC, ETH } USD prices from the caller's own market data
 * @param {number} [options.now]
 * @param {string} [options.address] - overrides TRACKED_WALLET_ADDRESS
 * @param {string} [options.rpcUrl] - overrides SOLANA_RPC_URL
 * @param {number} [options.baselineUsd] - overrides ACCOUNT_BASELINE_USD
 * @param {Function} [options.fetchImpl] - injectable for tests
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Object>} snapshot; never throws
 */
export async function getAccountSnapshot(options = {}) {
  const {
    prices = {},
    now = Date.now(),
    address = process.env.TRACKED_WALLET_ADDRESS,
    rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL,
    baselineUsd = process.env.ACCOUNT_BASELINE_USD,
    fetchImpl,
    timeoutMs
  } = options || {};

  const trimmed = typeof address === 'string' ? address.trim() : '';

  if (!trimmed) {
    return emptySnapshot('disabled', 'TRACKED_WALLET_ADDRESS not set');
  }

  if (!BASE58_ADDRESS_RE.test(trimmed)) {
    return emptySnapshot('unavailable', 'TRACKED_WALLET_ADDRESS is not a valid base58 address');
  }

  const deps = {};
  if (fetchImpl) deps.fetchImpl = fetchImpl;
  if (isFiniteNumber(timeoutMs)) deps.timeoutMs = timeoutMs;

  const fetchedAt = new Date(isFiniteNumber(now) ? now : Date.now()).toISOString();
  const masked = maskAddress(trimmed);

  // Both reads are required: without either one the capital picture is incomplete, and a
  // half-read wallet must not be presented as a whole one.
  let sol;
  let tokens;
  try {
    [sol, tokens] = await Promise.all([
      fetchSolBalance(rpcUrl, trimmed, deps),
      fetchTokenBalances(rpcUrl, trimmed, deps)
    ]);
  } catch (error) {
    console.error('[WalletTracker] balance read failed:', error.message);
    return emptySnapshot('unavailable', `balance read failed - ${error.message}`, {
      address: masked,
      fetchedAt
    });
  }

  // --- classify -------------------------------------------------------------
  const marginByAsset = {};
  let marginUsd = 0;

  const holdings = [];
  const unpriced = [];
  let holdingsUsd = 0;
  // Only a RECOGNIZED asset that could not be priced degrades the snapshot. An
  // unrecognized mint (memecoin, airdrop, LP token) is expected in a real wallet: it is
  // disclosed in `unpriced`, excluded from capital by design, and is not a data problem.
  let unpricedKnownAsset = false;

  // Native SOL is a holding, never margin: it is the gas asset and it drifts with market.
  if (sol > 0) {
    const solPrice = isFiniteNumber(prices.SOL) && prices.SOL > 0 ? prices.SOL : null;
    if (solPrice === null) {
      unpriced.push({ asset: 'SOL', mint: 'native', amount: roundN(sol, 6), reason: 'no SOL price' });
      unpricedKnownAsset = true;
    } else {
      const usdValue = sol * solPrice;
      holdings.push({ asset: 'SOL', mint: 'native', amount: roundN(sol, 6), usdValue: roundN(usdValue, 2) });
      holdingsUsd += usdValue;
    }
  }

  for (const { mint, amount } of tokens) {
    const stable = STABLE_MINTS[mint];
    if (stable) {
      // Stablecoins are counted at 1 USD. A depeg would overstate margin slightly; that is
      // accepted here rather than introducing a separate price feed for it.
      marginByAsset[stable] = roundN((marginByAsset[stable] || 0) + amount, 2);
      marginUsd += amount;
      continue;
    }

    const symbol = PRICED_MINTS[mint];
    const price = symbol && isFiniteNumber(prices[symbol]) && prices[symbol] > 0 ? prices[symbol] : null;

    if (symbol && price !== null) {
      const usdValue = amount * price;
      holdings.push({ asset: symbol, mint, amount: roundN(amount, 8), usdValue: roundN(usdValue, 2) });
      holdingsUsd += usdValue;
      continue;
    }

    // Unknown mints (memecoins, LP tokens, airdrops) are disclosed but never valued.
    // Guessing a price here would inflate the capital base with something unsellable.
    unpriced.push({
      asset: symbol || null,
      mint,
      amount: roundN(amount, 8),
      reason: symbol ? `no ${symbol} price` : 'unrecognized mint'
    });
    if (symbol) unpricedKnownAsset = true;
  }

  // --- performance ----------------------------------------------------------
  // Measured on margin only, so a market move in SOL/BTC/ETH can never masquerade as a
  // trade result. Baseline is the wallet's starting margin, set once in config.
  const baseline = isFiniteNumber(Number(baselineUsd)) && Number(baselineUsd) > 0
    ? Number(baselineUsd)
    : null;

  const performance = baseline === null
    ? { baselineUsd: null, netPnlUsd: null, returnPct: null, source: null }
    : {
        baselineUsd: roundN(baseline, 2),
        netPnlUsd: roundN(marginUsd - baseline, 2),
        returnPct: roundN(((marginUsd - baseline) / baseline) * 100, 2),
        source: 'config'
      };

  const status = unpricedKnownAsset ? 'partial' : 'available';

  console.log(
    `[WalletTracker] status=${status} marginUsd=${roundN(marginUsd, 2)} holdingsUsd=${roundN(holdingsUsd, 2)} unpriced=${unpriced.length} gasSol=${roundN(sol, 4)}`
  );

  return {
    status,
    reason: unpricedKnownAsset
      ? 'a tracked asset could not be priced; holdingsUsd is incomplete'
      : null,
    address: masked,
    fetchedAt,

    // Risk capital and P&L meter. Size against margin.usd, nothing else.
    margin: {
      usd: roundN(marginUsd, 2),
      byAsset: marginByAsset
    },

    // Context only: existing market exposure. Never risk capital.
    holdings,
    holdingsUsd: roundN(holdingsUsd, 2),
    unpriced,

    gas: {
      sol: roundN(sol, 6),
      minSol: MIN_GAS_SOL,
      sufficient: sol >= MIN_GAS_SOL
    },

    performance
  };
}

export default {
  getAccountSnapshot,
  maskAddress,
  emptySnapshot,
  rpcCall,
  STABLE_MINTS,
  PRICED_MINTS,
  TOKEN_PROGRAM_ID,
  MIN_GAS_SOL
};
