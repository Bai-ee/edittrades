/**
 * Jupiter Perpetuals API Integration
 * Handles perpetual futures trading via Jupiter Perps on Solana (Perps v2 program).
 * Supports leverage up to 200x.
 *
 * Uses jup-perps-client library (patched, see patches/) for on-chain program interaction:
 * codama-generated IDL instruction builders, account encoders/decoders.
 *
 * T-3 D (docs/PLAN_TELEGRAM_EXECUTION.md): side enum fix, custody-by-mint resolution, real
 * on-chain SL/TP placement, real close/update, real quote/capacity, and a strict
 * build/simulate/send separation. Every "build*" function below only builds an unsigned
 * transaction message; nothing in this module broadcasts except `sendSigned`, the single
 * exported send path. `JUPITER_SIMULATE_ONLY=true` makes `sendSigned` simulate instead of
 * sending. `openPerpPosition` / `closePerpPosition` / `updatePerpPosition` keep their
 * original simple signatures (the frozen executor contract, PLAN.md "Contract between
 * agents") but now build -> simulate -> refuse on simulation error -> sendSigned internally.
 */

// Use CommonJS wrapper to work around ES module compatibility issues
import jupPerpsClient from './jup-perps-wrapper.cjs';
import {
  createSolanaRpc,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  compileTransaction,
  pipe,
  address,
} from '@solana/kit';
import { getBase64EncodedWireTransaction, getSignatureFromTransaction } from '@solana/transactions';
import { getConnection, getWallet } from './walletManager.js';
import { PublicKey, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import { randomInt } from 'crypto';
import nacl from 'tweetnacl';
import 'dotenv/config';

// Extract needed exports from wrapper
const {
  fetchPool,
  fetchCustody,
  fetchPerpetuals,
  PERPETUALS_PROGRAM_ADDRESS,
  Side,
  RequestType,
  getCreateIncreasePositionMarketRequestInstruction,
  getCreateDecreasePositionRequest2Instruction,
  getCreateDecreasePositionMarketRequestInstruction,
  getUpdateDecreasePositionRequest2Instruction,
  getClosePositionRequestInstruction,
} = jupPerpsClient;

// Jupiter Perps Pool Address (mainnet)
const JUPITER_PERPS_POOL = '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq';

// Event Authority PDA required on every program instruction (Anchor `#[event_cpi]`): seeds
// [b"__event_authority"] under the Perps program. Derived, then asserted against the
// published address before any instruction is built (T-3 E; was hard-coded).
export const EXPECTED_EVENT_AUTHORITY = '37hJBDnntwqhGbK7L6M1bLyvccj4u55CCUiLPdYkiqBN';
const EVENT_AUTHORITY_SEED = Buffer.from('__event_authority');

/** Event Authority PDA of `programAddress` (base58). Pure. */
export function deriveEventAuthority(programAddress = PERPETUALS_PROGRAM_ADDRESS) {
  const [pda] = PublicKey.findProgramAddressSync([EVENT_AUTHORITY_SEED], new PublicKey(programAddress));
  return pda.toBase58();
}

let eventAuthorityCache = null;
/** Derived Event Authority, asserted equal to EXPECTED_EVENT_AUTHORITY (throws on mismatch). */
export function eventAuthority() {
  if (eventAuthorityCache) return eventAuthorityCache;
  const derived = deriveEventAuthority();
  if (derived !== EXPECTED_EVENT_AUTHORITY) {
    throw new Error(`eventAuthority mismatch: derived ${derived}, expected ${EXPECTED_EVENT_AUTHORITY}`);
  }
  eventAuthorityCache = derived;
  return derived;
}

// Perpetuals account address (derived PDA)
// Seeds: [b"perpetuals", pool]
const PERPETUALS_ACCOUNT_SEED = Buffer.from('perpetuals');

// Create RPC connection (@solana/kit rpc; used for every on-chain read/build/simulate/send
// below). services/walletManager.js's getConnection() returns a @solana/web3.js Connection,
// used only for its own getBalance() helper -- unrelated to this module's rpc client.
const rpc = createSolanaRpc(
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
);

const USD_DECIMALS = 1_000_000;
const TRADED = Object.freeze(['BTC', 'ETH', 'SOL']);
const isPosNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const n6 = (v) => Number(v) / USD_DECIMALS;
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/** Default max slippage for market requests: 1% (100 bps). */
export const DEFAULT_MAX_SLIPPAGE_BPS = 100;

/**
 * `priceSlippage` for the Perps request instructions (T-3 E fix). The program reads it as the
 * worst acceptable execution PRICE in USD with 6 decimals, not as bps: the max price when
 * the request buys (increase long, decrease short) and the min price when it sells
 * (increase short, decrease long). The old code passed a raw 100 (= $0.0001), so every long
 * failed and no short had real price protection.
 * @param {Object} p
 * @param {number} p.referencePrice - USD reference (mark / expected fill, or the trigger price)
 * @param {'long'|'short'} p.direction - the position's side
 * @param {'increase'|'decrease'} p.change
 * @param {number} [p.maxSlippageBps=DEFAULT_MAX_SLIPPAGE_BPS] - 0 < bps <= 1000
 * @returns {bigint} USD, 6 decimals
 */
export function slippagePriceUsd6({ referencePrice, direction, change, maxSlippageBps = DEFAULT_MAX_SLIPPAGE_BPS } = {}) {
  if (!isPosNum(referencePrice)) throw new Error('referencePrice (USD) is required for the slippage bound');
  if (direction !== 'long' && direction !== 'short') throw new Error('direction must be "long" or "short"');
  if (change !== 'increase' && change !== 'decrease') throw new Error('change must be "increase" or "decrease"');
  if (!(isPosNum(maxSlippageBps) && maxSlippageBps <= 1000)) throw new Error('maxSlippageBps must be in (0, 1000]');
  const buying = (change === 'increase') === (direction === 'long');
  const bound = referencePrice * (buying ? 1 + maxSlippageBps / 10_000 : 1 - maxSlippageBps / 10_000);
  return BigInt(Math.round(bound * USD_DECIMALS));
}

/**
 * Derive Position PDA
 * Seeds: [b"position", owner, pool, custody, collateralCustody, side]
 * Based on position account structure which includes collateralCustody
 * @param {PublicKey} owner - Owner public key
 * @param {PublicKey} pool - Pool public key
 * @param {PublicKey} custody - Custody public key (trading asset)
 * @param {PublicKey} collateralCustody - Collateral custody public key (USDC)
 * @param {number} side - 0 for long, 1 for short
 * @returns {Promise<[PublicKey, number]>} [PDA, bump]
 */
async function derivePositionPDA(owner, pool, custody, collateralCustody, side) {
  const programId = new PublicKey(PERPETUALS_PROGRAM_ADDRESS);
  const sideBuffer = Buffer.allocUnsafe(1);
  sideBuffer.writeUInt8(side, 0);

  const seeds = [
    Buffer.from('position'),
    owner.toBuffer(),
    pool.toBuffer(),
    custody.toBuffer(),
    collateralCustody.toBuffer(),
    sideBuffer,
  ];

  const [pda, bump] = PublicKey.findProgramAddressSync(seeds, programId);
  return [pda, bump];
}

/**
 * Derive Position Request PDA
 * Based on official example: https://github.com/julianfssen/jupiter-perps-anchor-idl-parsing
 * Seeds: [b"position_request", position, counter (little endian), requestChange]
 * Reference: src/examples/generate-position-and-position-request-pda.ts
 * @param {PublicKey} position - Position PDA
 * @param {number} counter - Request counter (random integer seed for uniqueness)
 * @param {string} requestChange - "increase" or "decrease"
 * @returns {Promise<[PublicKey, number]>} [PDA, bump]
 */
async function derivePositionRequestPDA(position, counter = 0, requestChange = "increase") {
  const programId = new PublicKey(PERPETUALS_PROGRAM_ADDRESS);

  // Counter must be in LITTLE ENDIAN format (not big endian!)
  const counterBuffer = Buffer.allocUnsafe(8);
  counterBuffer.writeBigUInt64LE(BigInt(counter), 0); // Little endian!

  // RequestChange: [1] for increase, [2] for decrease (not 0/1!)
  const requestChangeEnum = requestChange === "increase" ? [1] : [2];
  const requestChangeBuffer = Buffer.from(requestChangeEnum);

  // Seeds: [b"position_request", position, counter (le), requestChange]
  const seeds = [
    Buffer.from('position_request'),
    position.toBuffer(),  // Position account address
    counterBuffer,        // Counter in LITTLE ENDIAN format
    requestChangeBuffer,  // [1] for increase, [2] for decrease
  ];

  const [pda, bump] = PublicKey.findProgramAddressSync(seeds, programId);
  return [pda, bump];
}

/**
 * Derive Perpetuals PDA
 * Seeds: [b"perpetuals"] (singleton account, not per-pool)
 * @returns {Promise<[PublicKey, number]>} [PDA, bump]
 */
async function derivePerpetualsPDA() {
  const programId = new PublicKey(PERPETUALS_PROGRAM_ADDRESS);

  // Perpetuals account is a singleton, derived with just [b"perpetuals"]
  const seeds = [
    PERPETUALS_ACCOUNT_SEED,
  ];

  const [pda, bump] = PublicKey.findProgramAddressSync(seeds, programId);
  return [pda, bump];
}

// ------------------------------------------------------------ side enum + custody resolution
//
// On-chain program Side enum (node_modules/jup-perps-client/dist/types/side.d.ts):
// None=0, Long=1, Short=2. The old code sent 0/1 for long/short (a short opened as a long).
// POSITION_SIDE_SEED is the single source of truth for this value, used both for the
// Position PDA seed and the increase-position instruction's `side` arg.
export const POSITION_SIDE_SEED = Object.freeze({ long: 1, short: 2 });

/** Mints of the traded assets and the stable collateral, used to find custodies by mint. */
export const PERP_MINTS = Object.freeze({
  SOL: 'So11111111111111111111111111111111111111112',
  BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
  ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
});

/** Published mainnet custody accounts (fallback when the pool cannot be read). */
export const DEFAULT_PERP_CUSTODIES = Object.freeze({
  SOL: '7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz',
  ETH: 'AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn',
  BTC: '5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm',
  USDC: 'G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa',
  USDT: '4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk',
});

/** resolvePerpCustodies() result cache: rpcClient -> {ts, data}, 5 min TTL. */
export const CUSTODY_CACHE_TTL_MS = 5 * 60 * 1000;
const custodyCache = new WeakMap();

/**
 * {SOL, BTC, ETH, USDC, USDT} -> custody address, resolved from the live pool by mint
 * (fetchPool + fetchAllCustody through the injected connection), cached for
 * CUSTODY_CACHE_TTL_MS per connection instance.
 * @param {Object} rpcClient - @solana/kit rpc (tests inject a fake)
 * @param {Object} [opts]
 * @param {number} [opts.ttlMs] - override the cache TTL (0 disables caching)
 * @param {boolean} [opts.forceRefresh]
 * @returns {Promise<Object<string,string>>}
 */
export async function resolvePerpCustodies(rpcClient, opts = {}) {
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : CUSTODY_CACHE_TTL_MS;
  if (!opts.forceRefresh && ttlMs > 0) {
    const cached = custodyCache.get(rpcClient);
    if (cached && Date.now() - cached.ts < ttlMs) return cached.data;
  }
  const pool = await fetchPool(rpcClient, JUPITER_PERPS_POOL);
  const custodies = await jupPerpsClient.fetchAllCustody(rpcClient, pool.data.custodies);
  const bySymbol = {};
  const symbolOfMint = Object.fromEntries(Object.entries(PERP_MINTS).map(([k, v]) => [v, k]));
  for (const c of custodies) {
    const sym = symbolOfMint[String(c.data.mint)];
    if (sym) bySymbol[sym] = String(c.address);
  }
  if (ttlMs > 0) custodyCache.set(rpcClient, { ts: Date.now(), data: bySymbol });
  return bySymbol;
}

/**
 * Resolve + fetch the custody and collateral custody for a trade, validated against the
 * live pool/custody accounts (throws if either mint isn't found in the fetched pool).
 * Program rule: a long's collateral custody is the traded asset's own custody; a short's
 * collateral custody is a stable custody (USDC preferred, USDT fallback).
 * @param {Object} rpcClient
 * @param {'BTC'|'ETH'|'SOL'} symbol
 * @param {'long'|'short'} direction
 * @param {Object} [opts] - forwarded to resolvePerpCustodies (ttlMs, forceRefresh)
 */
export async function resolveTradeCustodies(rpcClient, symbol, direction, opts = {}) {
  if (!TRADED.includes(symbol)) throw new Error(`Unsupported symbol: ${symbol}`);
  if (direction !== 'long' && direction !== 'short') throw new Error(`Unsupported direction: ${direction}`);
  const custodies = await resolvePerpCustodies(rpcClient, opts);
  const custodyAddress = custodies[symbol];
  if (!custodyAddress) throw new Error(`Custody not found for ${symbol} (checked pool custodies by mint)`);
  let collateralSymbol = direction === 'long' ? symbol : 'USDC';
  let collateralCustodyAddress = custodies[collateralSymbol];
  if (!collateralCustodyAddress && direction === 'short') {
    collateralSymbol = 'USDT';
    collateralCustodyAddress = custodies.USDT;
  }
  if (!collateralCustodyAddress) throw new Error(`Collateral custody not found for ${symbol} ${direction} (checked ${collateralSymbol})`);
  const sameAccount = collateralCustodyAddress === custodyAddress;
  const custody = await fetchCustody(rpcClient, custodyAddress);
  const collateralCustody = sameAccount ? custody : await fetchCustody(rpcClient, collateralCustodyAddress);
  return { symbol, direction, custodyAddress, collateralCustodyAddress, collateralSymbol, custody, collateralCustody };
}

/** 'btc' | 'BTCUSDT' | 'BTC-PERP' -> 'BTC' | 'ETH' | 'SOL', or null. */
function symbolFromMarket(market) {
  const m = typeof market === 'string' ? market.toUpperCase() : '';
  const s = m.replace(/(-PERP|PERP|USDT|USDC|USD)$/, '');
  return TRADED.includes(s) ? s : null;
}

// Perp markets mapping (legacy symbol -> market address; populated at runtime by getPerpMarkets)
const PERP_MARKETS = {
  'BTCUSDT': null,
  'ETHUSDT': null,
  'SOLUSDT': null,
};

/**
 * Get available perpetual markets, resolved by mint (not custody index order).
 * @param {Object} [opts]
 * @returns {Promise<Object>} market symbol (e.g. 'BTCUSDT') -> market info
 */
export async function getPerpMarkets(opts = {}) {
  const rpcClient = opts.connection || opts.rpc || rpc;
  try {
    const custodies = await resolvePerpCustodies(rpcClient, opts);
    const markets = {};
    for (const symbol of TRADED) {
      const custodyAddress = custodies[symbol];
      if (!custodyAddress) continue;
      try {
        const custody = await fetchCustody(rpcClient, custodyAddress);
        const market = `${symbol}USDT`;
        markets[market] = {
          symbol,
          market,
          custodyAddress,
          tokenMint: custody.data.mint,
          decimals: custody.data.decimals,
          // pricing.maxLeverage is a bps-like on-chain scale (Jupiter Perps IDL PricingParams);
          // /10_000 approximates an x-leverage figure for display, not an exact protocol value.
          maxLeverage: Number(custody.data.pricing.maxLeverage) / 10_000,
          maxPositionSizeUsd: r2(n6(custody.data.maxPositionSizeUsd)),
          assetsOwned: custody.data.assets.owned.toString(),
          minMargin: 0.01,
        };
        PERP_MARKETS[market] = custodyAddress;
      } catch (err) {
        console.warn(`[JupiterPerps] Could not fetch custody for ${symbol}:`, err.message);
      }
    }
    return markets;
  } catch (error) {
    throw new Error(`Failed to get perpetual markets: ${error.message}`);
  }
}

/**
 * Check custody capacity for a given market (real numeric headroom from the custody account:
 * maxPositionSizeUsd minus current utilization), resolved by mint.
 * @param {string} market
 * @param {number} requiredSize - USD
 * @param {Object} [opts] - opts.direction ('long'|'short', default 'long'), opts.connection
 * @returns {Promise<Object>}
 */
export async function checkCustodyCapacity(market, requiredSize, opts = {}) {
  const rpcClient = opts.connection || opts.rpc || rpc;
  const symbol = symbolFromMarket(market);
  if (!symbol) throw new Error(`Unsupported market: ${market}`);
  const direction = opts.direction === 'short' ? 'short' : 'long';
  const { custodyAddress, custody } = await resolveTradeCustodies(rpcClient, symbol, direction, opts);
  const c = custody.data;
  const maxUsd = n6(c.maxPositionSizeUsd);
  // resolveTradeCustodies always returns the traded asset's own custody here (BTC/ETH/SOL,
  // never USDC/USDT), for both directions -- Custody.assets.globalShortSizes exists
  // precisely so short exposure is also tracked on this same custody. guaranteedUsd is
  // already USD (Custody.assets, jup-perps-client Assets type). This is a best-effort
  // utilization proxy -- the exact CustodyAmountLimit check is enforced on-chain and may
  // reject a transaction this estimate would have allowed.
  const usedUsd = n6(c.assets.guaranteedUsd);
  const currentAssets = n6(c.assets.owned);
  const headroomUsd = maxUsd > 0 ? r2(maxUsd - usedUsd) : null;
  return {
    market,
    symbol,
    direction,
    custodyAddress,
    currentAssets: r2(currentAssets),
    requiredSize,
    maxPositionSizeUsd: r2(maxUsd),
    usedUsd: r2(usedUsd),
    headroomUsd,
    availableUsd: headroomUsd,
    custodyData: c,
    note: headroomUsd === null
      ? 'maxPositionSizeUsd not set on custody; capacity unknown'
      : 'headroomUsd = maxPositionSizeUsd - current utilization (on-chain custody account data)'
  };
}

/** Conservative liquidation price estimate (same model as decodePerpPositionAccount). */
function estimateLiquidationPrice(entryPrice, leverage, direction, maintenanceMarginPct = 0.3) {
  const liqDist = 1 / leverage - maintenanceMarginPct / 100;
  if (!(liqDist > 0)) return null;
  return r2(direction === 'long' ? entryPrice * (1 - liqDist) : entryPrice * (1 + liqDist));
}

/**
 * Get a real perpetual quote: fees (open/close bps) and price impact from the on-chain
 * custody account, and an estimated liquidation price when a mark price is supplied.
 * @param {string} market
 * @param {string} direction - 'long' or 'short'
 * @param {number} size - USD
 * @param {number} [leverage]
 * @param {Object} [opts] - opts.markPrice (for liquidationPrice/expectedFillPrice), opts.connection
 * @returns {Promise<Object>}
 */
export async function getPerpQuote(market, direction, size, leverage = 1, opts = {}) {
  if (leverage < 1 || leverage > 200) throw new Error('Leverage must be between 1x and 200x');
  const marginRequired = size / leverage;
  if (marginRequired < 0.01) throw new Error(`Margin required ($${marginRequired.toFixed(2)}) is below minimum ($0.01)`);
  if (direction !== 'long' && direction !== 'short') throw new Error('Direction must be "long" or "short"');
  const rpcClient = opts.connection || opts.rpc || rpc;
  const symbol = symbolFromMarket(market);
  if (!symbol) throw new Error(`Unsupported market: ${market}`);

  const { custody, custodyAddress, collateralCustodyAddress } = await resolveTradeCustodies(rpcClient, symbol, direction, opts);
  const c = custody.data;
  const openFeeBps = Number(c.increasePositionBps);
  const closeFeeBps = Number(c.decreasePositionBps);
  const buf = c.priceImpactBuffer;
  // Price impact estimate bounded by priceImpactBuffer.maxFeeBps, scaled by feeFactor against
  // size (Jupiter Perps IDL PriceImpactBuffer type). The exact curve isn't public; this is a
  // best-effort estimate, not a placeholder constant.
  const priceImpactBps = buf ? Math.min(Number(buf.maxFeeBps), (size * Number(buf.feeFactor)) / 1e10) : 0;
  const estimatedFees = r2((size * openFeeBps) / 10_000 + (size * priceImpactBps) / 10_000);
  // FundingRateState.hourlyFundingDbps is deci-bps (1 dbps = 1e-5 as a fraction).
  const fundingRatePerHour = c.fundingRateState ? Number(c.fundingRateState.hourlyFundingDbps) / 1_000_000 : null;
  const markPrice = isPosNum(opts.markPrice) ? opts.markPrice : null;
  const liquidationPrice = markPrice ? estimateLiquidationPrice(markPrice, leverage, direction, opts.maintenanceMarginPct ?? 0.3) : null;

  return {
    market,
    direction,
    size,
    leverage,
    marginRequired: r2(marginRequired),
    estimatedFees,
    openFeeBps,
    closeFeeBps,
    priceImpactBps: r2(priceImpactBps),
    fundingRatePerHour,
    fundingRate: fundingRatePerHour, // legacy alias
    markPrice,
    expectedFillPrice: markPrice,
    liquidationPrice,
    custodyAddress,
    collateralCustodyAddress,
  };
}

// ------------------------------------------------------------ instruction helpers

/** @solana/web3.js TransactionInstruction -> @solana/kit instruction. */
function toKitInstruction(web3Ix) {
  return {
    programAddress: address(web3Ix.programId.toBase58()),
    accounts: web3Ix.keys.map((key) => ({
      address: address(key.pubkey.toBase58()),
      role: key.isSigner
        ? (key.isWritable ? 'writableSigner' : 'readonlySigner')
        : (key.isWritable ? 'writable' : 'readonly'),
    })),
    data: web3Ix.data,
  };
}

const DEFAULT_COMPUTE_UNIT_LIMIT = 300_000;
const DEFAULT_PRIORITY_FEE_MICROLAMPORTS = 5_000;

/** Compute-budget + priority-fee instructions, prepended to every built transaction. */
function computeBudgetInstructions({ unitLimit = DEFAULT_COMPUTE_UNIT_LIMIT, priorityFeeMicroLamports = DEFAULT_PRIORITY_FEE_MICROLAMPORTS } = {}) {
  return [
    toKitInstruction(ComputeBudgetProgram.setComputeUnitLimit({ units: unitLimit })),
    toKitInstruction(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports })),
  ];
}

/**
 * An idempotent ATA-create instruction when `ata` doesn't exist yet, else null. Existence is
 * checked through the injected connection (mocked in tests); a failed check falls back to
 * including the (safe, idempotent) create instruction, same as the pre-T-3-D code did.
 */
async function ensureAtaInstruction(connection, { payer, ata, owner, mint }) {
  if (connection && typeof connection.getAccountInfo === 'function') {
    try {
      const info = await connection.getAccountInfo(ata.toBase58(), { commitment: 'confirmed' }).send();
      if (info && info.value) return null;
    } catch {
      // fall through: include the create instruction idempotently
    }
  }
  const ix = createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  return toKitInstruction(ix);
}

function buildTransactionMessage(feePayerAddress, instructions, latestBlockhash) {
  let msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayerAddress, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
  );
  for (const ix of instructions) msg = appendTransactionMessageInstruction(ix, msg);
  return msg;
}

/** simulate(connection) for an unsigned transaction message: sigVerify:false, replaces the blockhash. */
function makeSimulate(transactionMessage) {
  return async (connection) => {
    const rpcClient = connection || rpc;
    const compiled = compileTransaction(transactionMessage);
    const wireTransaction = getBase64EncodedWireTransaction(compiled);
    const sim = await rpcClient.simulateTransaction(wireTransaction, {
      commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: true, encoding: 'base64',
    }).send();
    return { err: sim.value.err ?? null, logs: sim.value.logs || [], unitsConsumed: sim.value.unitsConsumed ?? null };
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** landTransaction defaults (T-3 F, docs/PLAN_LIVE_PERPS_TEST.md "Transaction landing"). */
export const DEFAULT_LAND_REBROADCAST_MS = 2000;
export const DEFAULT_LAND_OBSERVE_POLL_MS = 1000;
export const DEFAULT_LAND_MAX_WAIT_MS = 90000;

/**
 * Land an already-signed transaction: rebroadcast the IDENTICAL signed bytes every
 * `rebroadcastEveryMs` while the outcome is unknown (a single send is routinely dropped
 * between RPC and leader; resending the same signed bytes is idempotent on chain and can
 * only help it land, never execute twice -- never resigns, never builds a new transaction).
 * Declares EXPIRED only once the FINALIZED block height has passed the transaction's
 * `lastValidBlockHeight` AND a fresh `getSignatureStatuses` lookup still finds nothing (a
 * transaction with an expired blockhash cannot land in any future block, so nothing was
 * charged). `maxWaitMs` is a last-resort ceiling: if neither a terminal status nor the
 * expiry condition is reached by then, the transaction is reported EXPIRED without
 * further waiting (the caller should treat this the same as a normal expiry -- nothing is
 * known to have landed).
 * @param {Object} signedTx - a signed @solana/kit transaction (messageBytes + signatures
 *   [+ lifetimeConstraint.lastValidBlockHeight]), e.g. the internal result of
 *   `signTransactionMessageWithSigners`
 * @param {Object} [connection] - @solana/kit rpc; defaults to this module's rpc
 * @param {Object} [opts]
 * @param {number} [opts.rebroadcastEveryMs=2000]
 * @param {number} [opts.observePollMs=1000]
 * @param {number} [opts.maxWaitMs=90000]
 * @returns {Promise<{status:'confirmed'|'expired'|'failed', signature:string, slot:number|null, err:*, logs:string[]|null}>}
 */
export async function landTransaction(signedTx, connection, opts = {}) {
  const rpcClient = connection || rpc;
  const rebroadcastEveryMs = Number.isFinite(opts.rebroadcastEveryMs) ? opts.rebroadcastEveryMs : DEFAULT_LAND_REBROADCAST_MS;
  const observePollMs = Number.isFinite(opts.observePollMs) ? opts.observePollMs : DEFAULT_LAND_OBSERVE_POLL_MS;
  const maxWaitMs = Number.isFinite(opts.maxWaitMs) ? opts.maxWaitMs : DEFAULT_LAND_MAX_WAIT_MS;
  const signature = getSignatureFromTransaction(signedTx);
  const wireTransaction = getBase64EncodedWireTransaction(signedTx);
  const lastValidBlockHeight = signedTx.lifetimeConstraint && signedTx.lifetimeConstraint.lastValidBlockHeight !== undefined
    ? BigInt(signedTx.lifetimeConstraint.lastValidBlockHeight) : null;

  const fetchStatus = async () => {
    const res = await rpcClient.getSignatureStatuses([signature], { searchTransactionHistory: false }).send();
    return res && Array.isArray(res.value) ? res.value[0] || null : null;
  };
  const toResult = (status) => ({
    status: status.err ? 'failed' : 'confirmed',
    signature, slot: status.slot !== undefined && status.slot !== null ? Number(status.slot) : null,
    err: status.err ?? null, logs: null,
  });
  const broadcast = async () => {
    try {
      await rpcClient.sendTransaction(wireTransaction, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send();
    } catch {
      // A rebroadcast rejection (e.g. "already processed") is not itself a failure signal;
      // the outcome is read from getSignatureStatuses, never from this call's own result.
    }
  };

  const startMs = Date.now();
  await broadcast();
  let lastBroadcastMs = Date.now();
  while (Date.now() - startMs < maxWaitMs) {
    const status = await fetchStatus();
    if (status && (status.err || status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      return toResult(status);
    }
    if (lastValidBlockHeight !== null) {
      let finalizedHeight = null;
      try { finalizedHeight = BigInt(await rpcClient.getBlockHeight({ commitment: 'finalized' }).send()); } catch { finalizedHeight = null; }
      if (finalizedHeight !== null && finalizedHeight > lastValidBlockHeight) {
        const recheck = await fetchStatus();
        if (!recheck) return { status: 'expired', signature, slot: null, err: null, logs: null };
        if (recheck.err || recheck.confirmationStatus === 'confirmed' || recheck.confirmationStatus === 'finalized') return toResult(recheck);
        return { status: 'expired', signature, slot: null, err: null, logs: null };
      }
    }
    if (Date.now() - lastBroadcastMs >= rebroadcastEveryMs) {
      await broadcast();
      lastBroadcastMs = Date.now();
    }
    await sleep(observePollMs);
  }
  return { status: 'expired', signature, slot: null, err: null, logs: null };
}

/**
 * The ONLY function in this module that broadcasts a transaction. Signs `transactionMessage`
 * with `signer` (a @solana/kit TransactionSigner) and either lands it (rebroadcast +
 * expiry via `landTransaction`), or, when JUPITER_SIMULATE_ONLY=true, simulates it and
 * returns without sending. Never resigns: exactly one signed transaction is produced and
 * the same bytes are (re)broadcast until landTransaction reaches a terminal status.
 * @param {Object} transactionMessage - unsigned kit transaction message (a `build*` result's `.transaction`)
 * @param {Object} signer - @solana/kit signer (see createKitSigner)
 * @param {Object} [connection] - @solana/kit rpc; defaults to this module's rpc
 * @param {Object} [opts] - forwarded to landTransaction (rebroadcastEveryMs, observePollMs, maxWaitMs)
 * @returns {Promise<{simulated:boolean, signature?:string, slot?:number|null, logs?:string[], unitsConsumed?:number|null, err?:*}>}
 */
export async function sendSigned(transactionMessage, signer, connection, opts = {}) {
  const rpcClient = connection || rpc;
  const messageWithSigner = setTransactionMessageFeePayerSigner(signer, transactionMessage);
  const signedTransaction = await signTransactionMessageWithSigners(messageWithSigner);
  if (String(process.env.JUPITER_SIMULATE_ONLY).toLowerCase() === 'true') {
    const wireTransaction = getBase64EncodedWireTransaction(signedTransaction);
    const sim = await rpcClient.simulateTransaction(wireTransaction, {
      commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: true, encoding: 'base64',
    }).send();
    return { simulated: true, logs: sim.value.logs || [], unitsConsumed: sim.value.unitsConsumed ?? null, err: sim.value.err ?? null };
  }
  const landed = await landTransaction(signedTransaction, rpcClient, opts);
  if (landed.status !== 'confirmed') {
    const err = new Error(`Transaction ${landed.status}${landed.err ? `: ${JSON.stringify(landed.err)}` : ''} (signature ${landed.signature})`);
    err.landResult = landed;
    throw err;
  }
  return { simulated: false, signature: landed.signature, slot: landed.slot };
}

/** Wrap a @solana/web3.js Keypair as a @solana/kit signer (nacl-backed, same as the pre-T-3-D code). */
export function createKitSigner(keypair) {
  const signerAddress = address(keypair.publicKey.toBase58());
  return {
    address: signerAddress,
    async signTransactions(transactions) {
      return transactions.map((tx) => {
        const messageBytes = tx.messageBytes || tx;
        const message = Buffer.from(messageBytes);
        const signature = nacl.sign.detached(message, keypair.secretKey);
        return { [signerAddress]: signature };
      });
    },
    async signMessage(message) {
      const msgBuffer = Buffer.from(message);
      const signature = nacl.sign.detached(msgBuffer, keypair.secretKey);
      return { [signerAddress]: signature };
    },
  };
}

// ------------------------------------------------------------ build (no sign/send)

/**
 * Build (do not sign/send) a Jupiter Perps v2 open, with on-chain SL/TP.
 *
 * IDL instructions used (jup-perps-client, codama-generated):
 *  - createIncreasePositionMarketRequest: opens/increases the position. This IDL version has
 *    no SL/TP fields on the increase itself.
 *  - createDecreasePositionRequest2 (requestType=Trigger): one per SL/TP, submitted in the
 *    SAME transaction as the increase so they land atomically with the open. triggerPrice is
 *    the stop/target; triggerAboveThreshold selects the crossing direction (true = execute
 *    when price >= triggerPrice, false = execute when price <= triggerPrice): long SL=false,
 *    long TP=true, short SL=true, short TP=false. entirePosition=true (SL/TP always closes
 *    the whole position).
 *
 * @param {Object} p
 * @param {string} p.market - e.g. 'BTCUSDT'
 * @param {'long'|'short'} p.direction
 * @param {number} p.sizeUsd
 * @param {number} [p.leverage]
 * @param {number|null} [p.stopLoss]
 * @param {number|null} [p.takeProfit]
 * @param {string} p.owner - base58 owner address (no signer needed to build)
 * @param {Object} [p.connection] - @solana/kit rpc; defaults to this module's rpc
 * @returns {Promise<{transaction:Object, meta:Object, simulate:Function, send:Function}>}
 */
export async function buildOpenPosition({ market, direction, sizeUsd, leverage = 1, stopLoss = null, takeProfit = null, owner, referencePrice, maxSlippageBps = DEFAULT_MAX_SLIPPAGE_BPS, connection } = {}) {
  eventAuthority(); // derived + asserted before any instruction is built
  const rpcClient = connection || rpc;
  if (direction !== 'long' && direction !== 'short') throw new Error('direction must be "long" or "short"');
  if (!isPosNum(sizeUsd)) throw new Error('sizeUsd must be > 0');
  if (!(leverage >= 1 && leverage <= 200)) throw new Error('leverage must be between 1x and 200x');
  if (!owner) throw new Error('owner (base58 address) is required');
  const symbol = symbolFromMarket(market);
  if (!symbol) throw new Error(`Unsupported market: ${market}`);
  const increaseSlippage = slippagePriceUsd6({ referencePrice, direction, change: 'increase', maxSlippageBps });

  const side = POSITION_SIDE_SEED[direction]; // program Side enum: None=0, Long=1, Short=2
  const { custodyAddress, collateralCustodyAddress, custody, collateralCustody } = await resolveTradeCustodies(rpcClient, symbol, direction);

  const ownerPubkey = new PublicKey(owner);
  const poolPubkey = new PublicKey(JUPITER_PERPS_POOL);
  const custodyPubkey = new PublicKey(custodyAddress);
  const collateralCustodyPubkey = new PublicKey(collateralCustodyAddress);
  const [positionPDA] = await derivePositionPDA(ownerPubkey, poolPubkey, custodyPubkey, collateralCustodyPubkey, side);
  const [perpetualsPDA] = await derivePerpetualsPDA();

  const increaseCounter = randomInt(1, 2 ** 31 - 1);
  const [positionRequestPDA] = await derivePositionRequestPDA(positionPDA, increaseCounter, 'increase');

  const collateralMint = new PublicKey(collateralCustody.data.mint);
  const fundingAccount = getAssociatedTokenAddressSync(collateralMint, ownerPubkey, false);
  const positionRequestAta = getAssociatedTokenAddressSync(collateralMint, positionRequestPDA, true);

  // TODO(T-3 E follow-up, owner 2026-09-25): long collateral is the asset token, but collateralTokenDelta below is sized in USD-6, not the asset's decimals/price; fix in a later phase.
  const marginRequired = sizeUsd / leverage;
  const sizeUsdDelta = BigInt(Math.floor(sizeUsd * USD_DECIMALS));
  const collateralTokenDelta = BigInt(Math.floor(marginRequired * USD_DECIMALS));

  const increaseIx = getCreateIncreasePositionMarketRequestInstruction({
    owner: ownerPubkey.toBase58(),
    fundingAccount: fundingAccount.toBase58(),
    perpetuals: perpetualsPDA.toBase58(),
    pool: poolPubkey.toBase58(),
    position: positionPDA.toBase58(),
    positionRequest: positionRequestPDA.toBase58(),
    positionRequestAta: positionRequestAta.toBase58(),
    custody: custodyAddress,
    collateralCustody: collateralCustodyAddress,
    inputMint: collateralCustody.data.mint,
    referral: null,
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    eventAuthority: eventAuthority(),
    program: PERPETUALS_PROGRAM_ADDRESS,
    sizeUsdDelta,
    collateralTokenDelta,
    side,
    priceSlippage: increaseSlippage, // worst acceptable price, USD 6 decimals (see slippagePriceUsd6)
    jupiterMinimumOut: null,
    counter: BigInt(increaseCounter),
  }, { programAddress: PERPETUALS_PROGRAM_ADDRESS });

  // Only the owner's collateral (funding) ATA is created when missing. The position-request
  // ATA is created by the program itself inside createIncreasePositionMarketRequest (T-3 E:
  // pre-creating it made the program's own init fail).
  const preInstructions = [];
  const fundingAtaIx = await ensureAtaInstruction(rpcClient, { payer: ownerPubkey, ata: fundingAccount, owner: ownerPubkey, mint: collateralMint });
  if (fundingAtaIx) preInstructions.push(fundingAtaIx);

  // Custody's dedicated Doves oracle account vs. its primary oracle account (typically the
  // Pythnet feed). jup-perps-client's Custody decoder exposes both separately (dovesOracle,
  // oracle.oracleAccount); this mapping is a documented assumption pending official IDL docs.
  const custodyDovesPriceAccount = String(custody.data.dovesOracle);
  const custodyPythnetPriceAccount = custody.data.oracle?.oracleAccount ? String(custody.data.oracle.oracleAccount) : PublicKey.default.toBase58();

  const triggerIxs = [];
  const triggers = {};
  const addTrigger = async (kind, triggerPrice, triggerAboveThreshold) => {
    const counter = randomInt(1, 2 ** 31 - 1);
    const [reqPDA] = await derivePositionRequestPDA(positionPDA, counter, 'decrease');
    // Position-request ATA: created by the program in createDecreasePositionRequest2 (not here).
    const reqAta = getAssociatedTokenAddressSync(collateralMint, reqPDA, true);
    const ix = getCreateDecreasePositionRequest2Instruction({
      owner: ownerPubkey.toBase58(),
      receivingAccount: fundingAccount.toBase58(),
      perpetuals: perpetualsPDA.toBase58(),
      pool: poolPubkey.toBase58(),
      position: positionPDA.toBase58(),
      positionRequest: reqPDA.toBase58(),
      positionRequestAta: reqAta.toBase58(),
      custody: custodyAddress,
      custodyDovesPriceAccount,
      custodyPythnetPriceAccount,
      collateralCustody: collateralCustodyAddress,
      desiredMint: collateralCustody.data.mint,
      referral: null,
      tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      systemProgram: SystemProgram.programId.toBase58(),
      eventAuthority: eventAuthority(),
      program: PERPETUALS_PROGRAM_ADDRESS,
      collateralUsdDelta: BigInt(0),
      sizeUsdDelta,
      requestType: RequestType.Trigger,
      // A stop must fill, so the SL carries no price bound (None). The TP is bounded off its
      // own trigger price (a decrease sells a long / buys back a short).
      priceSlippage: kind === 'stopLoss' ? null : slippagePriceUsd6({ referencePrice: triggerPrice, direction, change: 'decrease', maxSlippageBps }),
      jupiterMinimumOut: null,
      triggerPrice: BigInt(Math.floor(triggerPrice * USD_DECIMALS)),
      triggerAboveThreshold,
      entirePosition: true,
      counter: BigInt(counter),
    }, { programAddress: PERPETUALS_PROGRAM_ADDRESS });
    triggerIxs.push(ix);
    triggers[kind] = { positionRequestId: reqPDA.toBase58(), counter, triggerPrice, triggerAboveThreshold };
  };

  if (isPosNum(stopLoss)) await addTrigger('stopLoss', stopLoss, direction === 'long' ? false : true);
  if (isPosNum(takeProfit)) await addTrigger('takeProfit', takeProfit, direction === 'long' ? true : false);

  const { value: latestBlockhash } = await rpcClient.getLatestBlockhash().send();
  // TODO(T-3 E follow-up, owner 2026-09-25): SL/TP trigger requests ride in the same tx as the increase, before the keeper has filled the position; likely an ordering bug, fix in a later phase.
  const instructions = [...computeBudgetInstructions(), ...preInstructions, increaseIx, ...triggerIxs];
  const transactionMessage = buildTransactionMessage(address(ownerPubkey.toBase58()), instructions, latestBlockhash);

  return {
    transaction: transactionMessage,
    meta: {
      positionId: positionPDA.toBase58(),
      positionRequestId: positionRequestPDA.toBase58(),
      custody: custodyAddress,
      collateralCustody: collateralCustodyAddress,
      counter: increaseCounter,
      side,
      triggers,
    },
    simulate: makeSimulate(transactionMessage),
    send: (signer, conn) => sendSigned(transactionMessage, signer, conn || rpcClient),
  };
}

/**
 * Build (do not sign/send) a full or partial close.
 *
 * IDL instruction used: createDecreasePositionMarketRequest (immediate market decrease;
 * `entirePosition: true` closes the whole position, ignoring sizeUsdDelta).
 *
 * @param {Object} p
 * @param {string} p.positionId - Position PDA (base58)
 * @param {string} p.market
 * @param {'long'|'short'} p.direction
 * @param {number|null} [p.sizeUsd] - USD to close; null/omitted = full close
 * @param {number|null} [p.collateralUsd] - current position collateral, for a proportional partial-close withdrawal
 * @param {number|null} [p.positionSizeUsd] - current position size, for a proportional partial-close withdrawal
 * @param {string} p.owner
 * @param {Object} [p.connection]
 */
export async function buildClosePosition({ positionId, market, direction, sizeUsd = null, collateralUsd = null, positionSizeUsd = null, owner, referencePrice, maxSlippageBps = DEFAULT_MAX_SLIPPAGE_BPS, connection } = {}) {
  eventAuthority(); // derived + asserted before any instruction is built
  const rpcClient = connection || rpc;
  if (!positionId) throw new Error('positionId is required');
  if (!owner) throw new Error('owner (base58 address) is required');
  if (direction !== 'long' && direction !== 'short') throw new Error('direction must be "long" or "short"');
  const symbol = symbolFromMarket(market);
  if (!symbol) throw new Error(`Unsupported market: ${market}`);

  const decreaseSlippage = slippagePriceUsd6({ referencePrice, direction, change: 'decrease', maxSlippageBps });
  const { custodyAddress, collateralCustodyAddress, collateralCustody } = await resolveTradeCustodies(rpcClient, symbol, direction);
  const ownerPubkey = new PublicKey(owner);
  const poolPubkey = new PublicKey(JUPITER_PERPS_POOL);
  const positionPDA = new PublicKey(positionId);
  const [perpetualsPDA] = await derivePerpetualsPDA();
  const collateralMint = new PublicKey(collateralCustody.data.mint);
  const ownerAta = getAssociatedTokenAddressSync(collateralMint, ownerPubkey, false);

  const entirePosition = !isPosNum(sizeUsd);
  const counter = randomInt(1, 2 ** 31 - 1);
  const [positionRequestPDA] = await derivePositionRequestPDA(positionPDA, counter, 'decrease');
  const positionRequestAta = getAssociatedTokenAddressSync(collateralMint, positionRequestPDA, true);

  const sizeUsdDelta = BigInt(Math.floor((entirePosition ? (positionSizeUsd || 0) : sizeUsd) * USD_DECIMALS));
  const collateralUsdDelta = !entirePosition && isPosNum(collateralUsd) && isPosNum(positionSizeUsd)
    ? BigInt(Math.floor(collateralUsd * (sizeUsd / positionSizeUsd) * USD_DECIMALS))
    : BigInt(0);

  const closeIx = getCreateDecreasePositionMarketRequestInstruction({
    owner: ownerPubkey.toBase58(),
    receivingAccount: ownerAta.toBase58(),
    perpetuals: perpetualsPDA.toBase58(),
    pool: poolPubkey.toBase58(),
    position: positionPDA.toBase58(),
    positionRequest: positionRequestPDA.toBase58(),
    positionRequestAta: positionRequestAta.toBase58(),
    custody: custodyAddress,
    collateralCustody: collateralCustodyAddress,
    desiredMint: collateralCustody.data.mint,
    referral: null,
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    systemProgram: SystemProgram.programId.toBase58(),
    eventAuthority: eventAuthority(),
    program: PERPETUALS_PROGRAM_ADDRESS,
    collateralUsdDelta,
    sizeUsdDelta,
    priceSlippage: decreaseSlippage, // worst acceptable price, USD 6 decimals
    jupiterMinimumOut: null,
    entirePosition,
    counter: BigInt(counter),
  }, { programAddress: PERPETUALS_PROGRAM_ADDRESS });

  // Only the owner's receiving ATA is created when missing; the position-request ATA is
  // created by the program in createDecreasePositionMarketRequest.
  const preInstructions = [];
  const ownerAtaIx = await ensureAtaInstruction(rpcClient, { payer: ownerPubkey, ata: ownerAta, owner: ownerPubkey, mint: collateralMint });
  if (ownerAtaIx) preInstructions.push(ownerAtaIx);

  const { value: latestBlockhash } = await rpcClient.getLatestBlockhash().send();
  const instructions = [...computeBudgetInstructions(), ...preInstructions, closeIx];
  const transactionMessage = buildTransactionMessage(address(ownerPubkey.toBase58()), instructions, latestBlockhash);

  return {
    transaction: transactionMessage,
    meta: { positionId, positionRequestId: positionRequestPDA.toBase58(), counter, entirePosition, sizeUsd: entirePosition ? null : sizeUsd },
    simulate: makeSimulate(transactionMessage),
    send: (signer, conn) => sendSigned(transactionMessage, signer, conn || rpcClient),
  };
}

/**
 * Build (do not sign/send) new SL/TP trigger requests for an existing position ("update
 * stops = create/replace trigger requests"). Any previously pending trigger request from the
 * open (or an earlier update) is NOT cancelled by this call -- it remains outstanding
 * on-chain until it executes or expires. Cancelling a specific pending request requires its
 * positionRequest PDA/counter (see buildReplaceTriggerRequest, which updates one in place).
 *
 * IDL instruction used: createDecreasePositionRequest2 (requestType=Trigger), same
 * semantics as the open's SL/TP triggers (see buildOpenPosition).
 */
export async function buildUpdateStops({ positionId, market, direction, stop = null, tp = null, positionSizeUsd = null, owner, maxSlippageBps = DEFAULT_MAX_SLIPPAGE_BPS, connection } = {}) {
  eventAuthority(); // derived + asserted before any instruction is built
  const rpcClient = connection || rpc;
  if (!positionId) throw new Error('positionId is required');
  if (!owner) throw new Error('owner (base58 address) is required');
  if (direction !== 'long' && direction !== 'short') throw new Error('direction must be "long" or "short"');
  if (!isPosNum(stop) && !isPosNum(tp)) throw new Error('stop or tp is required');
  const symbol = symbolFromMarket(market);
  if (!symbol) throw new Error(`Unsupported market: ${market}`);

  const { custodyAddress, collateralCustodyAddress, custody, collateralCustody } = await resolveTradeCustodies(rpcClient, symbol, direction);
  const ownerPubkey = new PublicKey(owner);
  const poolPubkey = new PublicKey(JUPITER_PERPS_POOL);
  const positionPDA = new PublicKey(positionId);
  const [perpetualsPDA] = await derivePerpetualsPDA();
  const collateralMint = new PublicKey(collateralCustody.data.mint);
  const ownerAta = getAssociatedTokenAddressSync(collateralMint, ownerPubkey, false);
  const custodyDovesPriceAccount = String(custody.data.dovesOracle);
  const custodyPythnetPriceAccount = custody.data.oracle?.oracleAccount ? String(custody.data.oracle.oracleAccount) : PublicKey.default.toBase58();

  const sizeUsdDelta = BigInt(Math.floor((positionSizeUsd || 0) * USD_DECIMALS));
  const preInstructions = [];
  const ixs = [];
  const triggers = {};

  const addTrigger = async (kind, triggerPrice, triggerAboveThreshold) => {
    const counter = randomInt(1, 2 ** 31 - 1);
    const [reqPDA] = await derivePositionRequestPDA(positionPDA, counter, 'decrease');
    // Position-request ATA: created by the program in createDecreasePositionRequest2 (not here).
    const reqAta = getAssociatedTokenAddressSync(collateralMint, reqPDA, true);
    const ix = getCreateDecreasePositionRequest2Instruction({
      owner: ownerPubkey.toBase58(),
      receivingAccount: ownerAta.toBase58(),
      perpetuals: perpetualsPDA.toBase58(),
      pool: poolPubkey.toBase58(),
      position: positionPDA.toBase58(),
      positionRequest: reqPDA.toBase58(),
      positionRequestAta: reqAta.toBase58(),
      custody: custodyAddress,
      custodyDovesPriceAccount,
      custodyPythnetPriceAccount,
      collateralCustody: collateralCustodyAddress,
      desiredMint: collateralCustody.data.mint,
      referral: null,
      tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      systemProgram: SystemProgram.programId.toBase58(),
      eventAuthority: eventAuthority(),
      program: PERPETUALS_PROGRAM_ADDRESS,
      collateralUsdDelta: BigInt(0),
      sizeUsdDelta,
      requestType: RequestType.Trigger,
      // A stop must fill, so the SL carries no price bound (None). The TP is bounded off its
      // own trigger price (a decrease sells a long / buys back a short).
      priceSlippage: kind === 'stopLoss' ? null : slippagePriceUsd6({ referencePrice: triggerPrice, direction, change: 'decrease', maxSlippageBps }),
      jupiterMinimumOut: null,
      triggerPrice: BigInt(Math.floor(triggerPrice * USD_DECIMALS)),
      triggerAboveThreshold,
      entirePosition: true,
      counter: BigInt(counter),
    }, { programAddress: PERPETUALS_PROGRAM_ADDRESS });
    ixs.push(ix);
    triggers[kind] = { positionRequestId: reqPDA.toBase58(), counter, triggerPrice, triggerAboveThreshold };
  };

  if (isPosNum(stop)) await addTrigger('stopLoss', stop, direction === 'long' ? false : true);
  if (isPosNum(tp)) await addTrigger('takeProfit', tp, direction === 'long' ? true : false);

  const { value: latestBlockhash } = await rpcClient.getLatestBlockhash().send();
  const instructions = [...computeBudgetInstructions(), ...preInstructions, ...ixs];
  const transactionMessage = buildTransactionMessage(address(ownerPubkey.toBase58()), instructions, latestBlockhash);

  return {
    transaction: transactionMessage,
    meta: { positionId, triggers },
    simulate: makeSimulate(transactionMessage),
    send: (signer, conn) => sendSigned(transactionMessage, signer, conn || rpcClient),
  };
}

/**
 * Build (do not sign/send) an in-place update of ONE already-known pending trigger request
 * (its positionRequest PDA / counter must already be known, e.g. from a prior
 * buildOpenPosition/buildUpdateStops `meta.triggers` result) -- a true "replace" that doesn't
 * leave the old request outstanding, unlike buildUpdateStops.
 *
 * IDL instruction used: updateDecreasePositionRequest2.
 */
export async function buildReplaceTriggerRequest({ positionId, positionRequestId, sizeUsdDelta, triggerPrice, market, direction, owner, connection } = {}) {
  eventAuthority(); // derived + asserted before any instruction is built
  const rpcClient = connection || rpc;
  if (!positionId || !positionRequestId) throw new Error('positionId and positionRequestId are required');
  if (!owner) throw new Error('owner (base58 address) is required');
  const symbol = symbolFromMarket(market);
  if (!symbol) throw new Error(`Unsupported market: ${market}`);
  const { custodyAddress, custody } = await resolveTradeCustodies(rpcClient, symbol, direction);
  const ownerPubkey = new PublicKey(owner);
  const poolPubkey = new PublicKey(JUPITER_PERPS_POOL);
  const positionPDA = new PublicKey(positionId);
  const [perpetualsPDA] = await derivePerpetualsPDA();
  const custodyDovesPriceAccount = String(custody.data.dovesOracle);
  const custodyPythnetPriceAccount = custody.data.oracle?.oracleAccount ? String(custody.data.oracle.oracleAccount) : PublicKey.default.toBase58();

  const ix = getUpdateDecreasePositionRequest2Instruction({
    owner: ownerPubkey.toBase58(),
    perpetuals: perpetualsPDA.toBase58(),
    pool: poolPubkey.toBase58(),
    position: positionPDA.toBase58(),
    positionRequest: positionRequestId,
    custody: custodyAddress,
    custodyDovesPriceAccount,
    custodyPythnetPriceAccount,
    sizeUsdDelta: BigInt(Math.floor((sizeUsdDelta || 0) * USD_DECIMALS)),
    triggerPrice: BigInt(Math.floor(triggerPrice * USD_DECIMALS)),
  }, { programAddress: PERPETUALS_PROGRAM_ADDRESS });

  const { value: latestBlockhash } = await rpcClient.getLatestBlockhash().send();
  const instructions = [...computeBudgetInstructions(), ix];
  const transactionMessage = buildTransactionMessage(address(ownerPubkey.toBase58()), instructions, latestBlockhash);

  return {
    transaction: transactionMessage,
    meta: { positionId, positionRequestId, triggerPrice },
    simulate: makeSimulate(transactionMessage),
    send: (signer, conn) => sendSigned(transactionMessage, signer, conn || rpcClient),
  };
}

/**
 * Build (do not sign/send) a cancel of a not-yet-filled increase-position request,
 * reclaiming its escrowed collateral back to the owner's ATA and closing the request
 * account (rent back to the owner).
 *
 * IDL instruction used: closePositionRequest. ASSUMPTION (T-3 F, unverified against a live
 * cluster -- see the F master-prompt handback): this instruction's account list requires a
 * `keeper` signer and a (non-signer) `owner`; this module passes the SAME wallet address for
 * both (the requester cancelling its own unfilled request, acting as its own keeper), which
 * matches the existing pattern elsewhere in this file of passing plain address strings for
 * "signer" IDL fields and letting the fee-payer signature (the same wallet) cover them. The
 * `position` account is passed readonly and not required to already hold decoded data --
 * unverified whether the program tolerates this for a position that has never been filled.
 * @param {Object} p
 * @param {string} p.positionId - Position PDA (base58)
 * @param {string} p.positionRequestId - the unfilled increase request's PDA (base58)
 * @param {string} p.market
 * @param {'long'|'short'} p.direction
 * @param {string} p.owner
 * @param {Object} [p.connection]
 */
export async function buildCancelIncreaseRequest({ positionId, positionRequestId, market, direction, owner, connection } = {}) {
  eventAuthority(); // derived + asserted before any instruction is built
  const rpcClient = connection || rpc;
  if (!positionId || !positionRequestId) throw new Error('positionId and positionRequestId are required');
  if (!owner) throw new Error('owner (base58 address) is required');
  const symbol = symbolFromMarket(market);
  if (!symbol) throw new Error(`Unsupported market: ${market}`);
  const { collateralCustody } = await resolveTradeCustodies(rpcClient, symbol, direction);
  const ownerPubkey = new PublicKey(owner);
  const poolPubkey = new PublicKey(JUPITER_PERPS_POOL);
  const positionPDA = new PublicKey(positionId);
  const positionRequestPDA = new PublicKey(positionRequestId);
  const collateralMint = new PublicKey(collateralCustody.data.mint);
  const ownerAta = getAssociatedTokenAddressSync(collateralMint, ownerPubkey, false);
  const positionRequestAta = getAssociatedTokenAddressSync(collateralMint, positionRequestPDA, true);

  const ix = getClosePositionRequestInstruction({
    keeper: ownerPubkey.toBase58(),
    owner: ownerPubkey.toBase58(),
    ownerAta: ownerAta.toBase58(),
    pool: poolPubkey.toBase58(),
    positionRequest: positionRequestPDA.toBase58(),
    positionRequestAta: positionRequestAta.toBase58(),
    position: positionPDA.toBase58(),
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    eventAuthority: eventAuthority(),
    program: PERPETUALS_PROGRAM_ADDRESS,
  }, { programAddress: PERPETUALS_PROGRAM_ADDRESS });

  const { value: latestBlockhash } = await rpcClient.getLatestBlockhash().send();
  const instructions = [...computeBudgetInstructions(), ix];
  const transactionMessage = buildTransactionMessage(address(ownerPubkey.toBase58()), instructions, latestBlockhash);

  return {
    transaction: transactionMessage,
    meta: { positionId, positionRequestId },
    simulate: makeSimulate(transactionMessage),
    send: (signer, conn) => sendSigned(transactionMessage, signer, conn || rpcClient),
  };
}

/** {data:Uint8Array}-shaped getMultipleAccounts/getAccountInfo row -> raw account bytes, or null. */
function accountBytes(acc) {
  if (!acc || !acc.data) return null;
  const raw = Array.isArray(acc.data) ? acc.data[0] : acc.data;
  return typeof raw === 'string' ? Buffer.from(raw, 'base64') : raw;
}

/**
 * Which of `addresses` currently exist on chain (non-null account with data), in order.
 * Used to confirm a set of trigger-request PDAs actually landed (F3 "verify").
 * @param {Array<string>} addresses
 * @param {Object} [connection]
 * @returns {Promise<boolean[]>}
 */
export async function fetchAccountsExist(addresses, connection) {
  const rpcClient = connection || rpc;
  const addrs = (addresses || []).map((a) => address(String(a)));
  if (!addrs.length) return [];
  const res = await rpcClient.getMultipleAccounts(addrs, { encoding: 'base64', commitment: 'confirmed' }).send();
  const values = res && Array.isArray(res.value) ? res.value : [];
  return addrs.map((_, i) => Boolean(accountBytes(values[i])));
}

/** waitForFill defaults (T-3 F, docs/PLAN_LIVE_PERPS_TEST.md "Keeper fill is asynchronous"). */
export const DEFAULT_FILL_POLL_MS = 1000;
export const DEFAULT_FILL_MAX_WAIT_MS = 60000;

/**
 * Poll until a submitted increase-position request is filled by the keeper (Perps v2:
 * `buildOpenPosition` only SUBMITS a request; a keeper fills it seconds later).
 *
 * Filled: the request account is gone or decodes `executed:true`, AND the position
 * account decodes with `sizeUsd > 0`. Not filled: both accounts are gone (the keeper
 * rejected/cancelled the request without ever creating a position) -> `reason:'rejected'`;
 * or `maxWaitMs` elapses with the request still pending -> `reason:'timeout'`.
 *
 * ASSUMPTION (T-3 F, unverified against a live cluster): PositionRequest has no explicit
 * "rejected" status field beyond `executed:boolean` (see node_modules/jup-perps-client
 * dist/accounts/positionRequest.d.ts) -- "both accounts gone" is inferred to mean the
 * keeper closed the request without filling it, not confirmed from IDL docs.
 * @param {string} positionRequestPDA
 * @param {string} positionPDA
 * @param {Object} [connection] - @solana/kit rpc; defaults to this module's rpc
 * @param {Object} [opts]
 * @param {number} [opts.pollMs=1000]
 * @param {number} [opts.maxWaitMs=60000]
 * @param {Object<string,string>} [opts.symbolByCustody]
 * @param {Object<string,number>} [opts.markPrices]
 * @returns {Promise<{filled:true, position:Object}|{filled:false, reason:'timeout'|'rejected'}>}
 */
export async function waitForFill(positionRequestPDA, positionPDA, connection, opts = {}) {
  const rpcClient = connection || rpc;
  const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : DEFAULT_FILL_POLL_MS;
  const maxWaitMs = Number.isFinite(opts.maxWaitMs) ? opts.maxWaitMs : DEFAULT_FILL_MAX_WAIT_MS;
  const reqAddr = address(String(positionRequestPDA));
  const posAddr = address(String(positionPDA));

  const startMs = Date.now();
  for (;;) {
    const res = await rpcClient.getMultipleAccounts([reqAddr, posAddr], { encoding: 'base64', commitment: 'confirmed' }).send();
    const values = res && Array.isArray(res.value) ? res.value : [null, null];
    const reqBytes = accountBytes(values[0]);
    const posBytes = accountBytes(values[1]);

    let executed = false;
    if (reqBytes) {
      try { executed = Boolean(jupPerpsClient.getPositionRequestDecoder().decode(reqBytes).executed); } catch { executed = false; }
    }
    let position = null;
    if (posBytes) {
      try {
        position = decodePerpPositionAccount(posBytes, {
          positionId: String(positionPDA), symbolByCustody: opts.symbolByCustody || {}, markPrices: opts.markPrices || {},
        });
      } catch { position = null; }
    }
    if ((!reqBytes || executed) && position && position.sizeUsd > 0) return { filled: true, position };
    if (!reqBytes && !position) return { filled: false, reason: 'rejected' };
    if (Date.now() - startMs >= maxWaitMs) return { filled: false, reason: 'timeout' };
    await sleep(pollMs);
  }
}

// ------------------------------------------------------------ legacy simple-signature API
//
// Kept for the frozen executor contract (docs/PLAN_TELEGRAM_EXECUTION.md "Contract between
// agents"): openPerpPosition(market, direction, size, leverage, stop, tp),
// closePerpPosition(positionId, size), updatePerpPosition(positionId, stop, tp). Each now
// builds -> simulates -> refuses on simulation error -> sendSigned internally, using the
// signing wallet from services/walletManager.js (same as before T-3 D).

/**
 * Open a perpetual position with on-chain SL/TP.
 * @param {Object} [opts] - test injection points; never passed by the executor.
 * @param {Object} [opts.connection] - @solana/kit rpc, defaults to this module's rpc
 * @param {Object} [opts.wallet] - @solana/web3.js Keypair, defaults to walletManager.getWallet()
 * @param {Object} [opts.signer] - @solana/kit signer, defaults to createKitSigner(wallet)
 * @param {number} opts.referencePrice - USD mark / expected fill for the slippage bound (required)
 * @param {number} [opts.maxSlippageBps]
 * @returns {Promise<Object>} Execution result with position ID and signature
 */
export async function openPerpPosition(market, direction, size, leverage = 1, stopLoss = null, takeProfit = null, opts = {}) {
  const rpcClient = opts.connection || rpc;
  if (!isPosNum(opts.referencePrice)) throw new Error('referencePrice (USD) is required for the slippage bound');
  const wallet = opts.wallet || getWallet();
  if (!wallet) throw new Error('Wallet not initialized');
  const owner = wallet.publicKey.toBase58();
  const built = await buildOpenPosition({ market, direction, sizeUsd: size, leverage, stopLoss, takeProfit, owner, referencePrice: opts.referencePrice, maxSlippageBps: opts.maxSlippageBps, connection: rpcClient });
  const sim = await built.simulate(rpcClient);
  if (sim.err) {
    const tail = sim.logs && sim.logs.length ? ` | ${sim.logs.slice(-5).join(' | ')}` : '';
    throw new Error(`Transaction simulation failed: ${JSON.stringify(sim.err)}${tail}`);
  }
  const signer = opts.signer || createKitSigner(wallet);
  const result = await built.send(signer, rpcClient);
  if (result.simulated) {
    return {
      success: true, simulated: true, positionId: built.meta.positionId, signature: null,
      logs: result.logs, unitsConsumed: result.unitsConsumed, market, direction, size, leverage,
      stopLoss, takeProfit, triggers: built.meta.triggers,
    };
  }
  return {
    success: true,
    positionId: built.meta.positionId,
    signature: result.signature,
    market, direction, size, leverage,
    marginRequired: size / leverage,
    stopLoss, takeProfit,
    explorerUrl: `https://solscan.io/tx/${result.signature}`,
    positionPDA: built.meta.positionId,
    positionRequestPDA: built.meta.positionRequestId,
    triggers: built.meta.triggers,
  };
}

/**
 * Close a perpetual position (full, or partial when `size` is given).
 * @param {string} positionId
 * @param {number|null} [size]
 * @param {Object} [opts] - test injection points; never passed by the executor (see openPerpPosition)
 * @returns {Promise<Object>}
 */
export async function closePerpPosition(positionId, size = null, opts = {}) {
  const rpcClient = opts.connection || rpc;
  const wallet = opts.wallet || getWallet();
  if (!wallet) throw new Error('Wallet not initialized');
  const owner = wallet.publicKey.toBase58();
  const r = await getPerpPositions(owner, { rpc: rpcClient, markPrices: opts.markPrices });
  if (!r.ok) throw new Error(r.error || 'position read unavailable');
  const p = r.positions.find((x) => x.positionId === positionId);
  if (!p) throw new Error(`Position not found: ${positionId}`);
  const referencePrice = isPosNum(opts.referencePrice) ? opts.referencePrice : p.markPrice;
  const built = await buildClosePosition({
    positionId, market: p.market, direction: p.direction, sizeUsd: size,
    collateralUsd: p.collateralUsd, positionSizeUsd: p.sizeUsd, owner, referencePrice,
    maxSlippageBps: opts.maxSlippageBps, connection: rpcClient,
  });
  const sim = await built.simulate(rpcClient);
  if (sim.err) {
    const tail = sim.logs && sim.logs.length ? ` | ${sim.logs.slice(-5).join(' | ')}` : '';
    throw new Error(`Transaction simulation failed: ${JSON.stringify(sim.err)}${tail}`);
  }
  const signer = opts.signer || createKitSigner(wallet);
  const result = await built.send(signer, rpcClient);
  if (result.simulated) {
    return { success: true, simulated: true, positionId, signature: null, logs: result.logs, unitsConsumed: result.unitsConsumed, sizeClosed: size || 'full' };
  }
  return { success: true, positionId, signature: result.signature, sizeClosed: size || 'full', explorerUrl: `https://solscan.io/tx/${result.signature}` };
}

/**
 * Update stop loss / take profit for a position (creates new trigger requests; see
 * buildUpdateStops for the "doesn't cancel the old request" caveat).
 * @param {string} positionId
 * @param {number|null} [stopLoss]
 * @param {number|null} [takeProfit]
 * @param {Object} [opts] - test injection points; never passed by the executor (see openPerpPosition)
 * @returns {Promise<Object>}
 */
export async function updatePerpPosition(positionId, stopLoss = null, takeProfit = null, opts = {}) {
  if (!stopLoss && !takeProfit) throw new Error('Must provide at least stopLoss or takeProfit');
  const rpcClient = opts.connection || rpc;
  const wallet = opts.wallet || getWallet();
  if (!wallet) throw new Error('Wallet not initialized');
  const owner = wallet.publicKey.toBase58();
  const r = await getPerpPositions(owner, { rpc: rpcClient });
  if (!r.ok) throw new Error(r.error || 'position read unavailable');
  const p = r.positions.find((x) => x.positionId === positionId);
  if (!p) throw new Error(`Position not found: ${positionId}`);
  const built = await buildUpdateStops({
    positionId, market: p.market, direction: p.direction, stop: stopLoss, tp: takeProfit,
    positionSizeUsd: p.sizeUsd, owner, connection: rpcClient,
  });
  const sim = await built.simulate(rpcClient);
  if (sim.err) {
    const tail = sim.logs && sim.logs.length ? ` | ${sim.logs.slice(-5).join(' | ')}` : '';
    throw new Error(`Transaction simulation failed: ${JSON.stringify(sim.err)}${tail}`);
  }
  const signer = opts.signer || createKitSigner(wallet);
  const result = await built.send(signer, rpcClient);
  if (result.simulated) {
    return { success: true, simulated: true, positionId, signature: null, logs: result.logs, unitsConsumed: result.unitsConsumed, stopLoss, takeProfit };
  }
  return { success: true, positionId, signature: result.signature, stopLoss, takeProfit, explorerUrl: `https://solscan.io/tx/${result.signature}` };
}

// ------------------------------------------------------------ position read (T-3 A)
//
// On-chain Position PDA side seed is the program's Side enum (None=0, Long=1, Short=2),
// see node_modules/jup-perps-client/dist/types/side.d.ts and the official PDA example.
// (POSITION_SIDE_SEED is defined above, shared with the open/close/update builders.)

/**
 * Every Position PDA the wallet could own: each traded custody x side x collateral
 * custody (the asset itself for longs, USDC/USDT for shorts; all three are tried for
 * both sides so a position opened either way is found). Pure; same derivePositionPDA as
 * openPerpPosition, with the program's Side enum as the side seed.
 * @param {string} walletAddress
 * @param {Object} custodies - {SOL, BTC, ETH, USDC, USDT} custody addresses
 * @returns {Promise<Array<{address:string, symbol:string, direction:string, custody:string, collateralCustody:string}>>}
 */
export async function derivePerpPositionCandidates(walletAddress, custodies = DEFAULT_PERP_CUSTODIES) {
  const owner = new PublicKey(walletAddress);
  const pool = new PublicKey(JUPITER_PERPS_POOL);
  const out = [];
  for (const symbol of TRADED) {
    if (!custodies[symbol]) continue;
    const custody = new PublicKey(custodies[symbol]);
    for (const [direction, sideSeed] of Object.entries(POSITION_SIDE_SEED)) {
      for (const coll of [symbol, 'USDC', 'USDT']) {
        if (!custodies[coll]) continue;
        const collateralCustody = new PublicKey(custodies[coll]);
        const [pda] = await derivePositionPDA(owner, pool, custody, collateralCustody, sideSeed);
        out.push({ address: pda.toBase58(), symbol, direction, custody: custody.toBase58(), collateralCustody: collateralCustody.toBase58() });
      }
    }
  }
  return out;
}

/**
 * Decode one Position account's bytes into the executor's position row. Pure.
 * `sizeUsd === 0` means a closed (empty) position account: returns null.
 * liquidationPrice is an ESTIMATE (the account does not store it): the conservative
 * riskEngine model, distance = collateral/size - maintenanceMarginPct/100.
 * @param {Uint8Array} bytes
 * @param {Object} o
 * @param {string} o.positionId
 * @param {Object<string,string>} [o.symbolByCustody] - custody address -> BTC|ETH|SOL
 * @param {Object<string,number>} [o.markPrices] - BTC|ETH|SOL -> USD mark
 * @param {number} [o.maintenanceMarginPct=0.3]
 * @returns {Object|null}
 */
export function decodePerpPositionAccount(bytes, { positionId, symbolByCustody = {}, markPrices = {}, maintenanceMarginPct = 0.3 } = {}) {
  const p = jupPerpsClient.getPositionDecoder().decode(bytes);
  const sizeUsd = n6(p.sizeUsd);
  if (!(sizeUsd > 0)) return null;
  const direction = Number(p.side) === 1 ? 'long' : Number(p.side) === 2 ? 'short' : null;
  if (!direction) return null;
  const symbol = symbolByCustody[String(p.custody)] || null;
  const entryPrice = n6(p.price);
  const collateralUsd = n6(p.collateralUsd);
  const liqDist = collateralUsd / sizeUsd - maintenanceMarginPct / 100;
  const liquidationPrice = entryPrice > 0 && liqDist > 0
    ? r2(direction === 'long' ? entryPrice * (1 - liqDist) : entryPrice * (1 + liqDist))
    : null;
  const mark = symbol && Number.isFinite(markPrices[symbol]) ? markPrices[symbol] : null;
  const unrealizedPnlUsd = mark && entryPrice > 0
    ? r2(sizeUsd * ((direction === 'long' ? mark - entryPrice : entryPrice - mark) / entryPrice))
    : null;
  const openSec = Number(p.openTime);
  return {
    positionId,
    market: symbol ? `${symbol}USDT` : null,
    symbol,
    direction,
    sizeUsd: r2(sizeUsd),
    collateralUsd: r2(collateralUsd),
    leverage: collateralUsd > 0 ? r2(sizeUsd / collateralUsd) : null,
    entryPrice,
    markPrice: mark,
    liquidationPrice,
    liquidationPriceSource: 'estimate',
    unrealizedPnlUsd,
    realisedPnlUsd: r2(n6(p.realisedPnlUsd)),
    openedAt: openSec > 0 ? new Date(openSec * 1000).toISOString() : null,
    collateralCustody: String(p.collateralCustody),
  };
}

/**
 * Open Jupiter perp positions for a wallet (BTC/ETH/SOL, long and short), read from
 * chain in one getMultipleAccounts call.
 *
 * Never throws. Always returns `{ ok, positions, error }`:
 *   ok:true  positions: [...] (empty array = no open position), error: null
 *   ok:false positions: [],   error: short message (RPC/decode failure; NOT "no positions")
 * @param {string|null} walletAddress - public address; null -> the signing wallet's address
 * @param {Object} [opts]
 * @param {Object} [opts.rpc] - @solana/kit rpc (tests pass a fake with getMultipleAccounts)
 * @param {Object} [opts.custodies] - skip the pool read ({SOL,BTC,ETH,USDC,USDT} addresses)
 * @param {Object<string,number>} [opts.markPrices] - for unrealizedPnlUsd
 * @param {number} [opts.maintenanceMarginPct]
 * @returns {Promise<{ok:boolean, positions:Array<Object>, error:string|null}>}
 */
export async function getPerpPositions(walletAddress = null, opts = {}) {
  const rpcClient = opts.rpc || rpc;
  try {
    const owner = walletAddress || getWallet().publicKey.toBase58();
    let custodies = opts.custodies || null;
    if (!custodies) {
      try { custodies = await resolvePerpCustodies(rpcClient); } catch { custodies = null; }
      if (!custodies || TRADED.some((s) => !custodies[s])) custodies = { ...DEFAULT_PERP_CUSTODIES, ...(custodies || {}) };
    }
    const symbolByCustody = Object.fromEntries(TRADED.filter((s) => custodies[s]).map((s) => [custodies[s], s]));
    const candidates = await derivePerpPositionCandidates(owner, custodies);
    const res = await rpcClient.getMultipleAccounts(candidates.map((c) => address(c.address)), { encoding: 'base64', commitment: 'confirmed' }).send();
    const values = res && Array.isArray(res.value) ? res.value : null;
    if (!values) return { ok: false, positions: [], error: 'rpc returned no account list' };
    const positions = [];
    values.forEach((acc, i) => {
      const bytes = accountBytes(acc);
      if (!bytes) return;
      const row = decodePerpPositionAccount(bytes, {
        positionId: candidates[i].address,
        symbolByCustody,
        markPrices: opts.markPrices || {},
        maintenanceMarginPct: Number.isFinite(opts.maintenanceMarginPct) ? opts.maintenanceMarginPct : 0.3,
      });
      if (row) positions.push(row);
    });
    return { ok: true, positions, error: null };
  } catch (error) {
    const msg = String((error && error.message) || error || 'unknown error').replace(/https?:\/\/\S+/g, '[url]').slice(0, 200);
    return { ok: false, positions: [], error: `position read failed: ${msg}` };
  }
}

/**
 * Get position details
 * @param {string} positionId - Position ID
 * @returns {Promise<Object>} Position details including P&L, margin, etc.
 */
export async function getPerpPositionDetails(positionId) {
  try {
    console.log('[JupiterPerps] Getting position details...');
    console.log('[JupiterPerps] Position ID:', positionId);

    // TODO: Query position from on-chain program
    // This will require:
    // 1. Finding position account
    // 2. Parsing position data
    // 3. Calculating current P&L
    // 4. Getting margin health

    const position = {
      positionId,
      market: null,
      direction: null,
      size: null,
      leverage: null,
      entryPrice: null,
      currentPrice: null,
      margin: null,
      pnl: null,
      pnlPercent: null,
      liquidationPrice: null,
      stopLoss: null,
      takeProfit: null,
    };

    console.log('[JupiterPerps] ✅ Position details retrieved');
    return position;
  } catch (error) {
    console.error('[JupiterPerps] ❌ Error getting position details:', error.message);
    throw new Error(`Failed to get perpetual position details: ${error.message}`);
  }
}
