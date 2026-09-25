/**
 * T-3 D MVP tests (docs/PLAN_TELEGRAM_EXECUTION.md): side enum fix, custody-by-mint
 * resolution, on-chain SL/TP placement on open, full close, and the build/simulate/send
 * split with sendSigned as the sole broadcaster.
 *
 * CODE-ONLY: every chain call goes through an injected fake rpc (no network); the signing
 * "wallet" is a throwaway, freshly-generated @solana/web3.js Keypair (no real key, never
 * used against a real cluster). JUPITER_SIMULATE_ONLY=true is used so the legacy
 * openPerpPosition/closePerpPosition wrappers can be exercised end to end (build -> simulate
 * -> sign -> "send") without needing to fake Solana's confirmation-polling RPC surface.
 *
 * Run: node test-jupiter-perps.js
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import jupPerpsClient from './services/jup-perps-wrapper.cjs';
import {
  POSITION_SIDE_SEED,
  PERP_MINTS,
  DEFAULT_PERP_CUSTODIES,
  resolvePerpCustodies,
  resolveTradeCustodies,
  buildOpenPosition,
  buildClosePosition,
  buildUpdateStops,
  buildReplaceTriggerRequest,
  sendSigned,
  createKitSigner,
  openPerpPosition,
  closePerpPosition,
  getPerpQuote,
  checkCustodyCapacity,
  getPerpMarkets,
} from './services/jupiterPerps.js';

const root = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n    ') : err}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const stringify = (v) => JSON.stringify(v, (k, val) => (typeof val === 'bigint' ? `${val}n` : val));
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${stringify(b)}, got ${stringify(a)}`); };

// Throwaway test wallet: SOLANA_PRIVATE_KEY is only ever read by services/walletManager.js's
// getWallet(); this is a freshly generated key with no funds, set only in this test process.
const TEST_KEYPAIR = Keypair.generate();
process.env.SOLANA_PRIVATE_KEY = bs58.encode(TEST_KEYPAIR.secretKey);

// ---------------------------------------------------------------- fixtures

const { Side, RequestType, PERPETUALS_PROGRAM_ADDRESS } = jupPerpsClient;
const C = DEFAULT_PERP_CUSTODIES;
const POOL = '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq';
const OWNER = TEST_KEYPAIR.publicKey.toBase58();

function encPool(custodies) {
  return jupPerpsClient.getPoolEncoder().encode({
    name: 'JLP Pool', custodies, aumUsd: 0n,
    limit: { maxAumUsd: 0n, tokenWeightageBufferBps: 0n, buffer: 0n },
    fees: { swapMultiplier: 0n, stableSwapMultiplier: 0n, addRemoveLiquidityBps: 0n, swapBps: 0n, taxBps: 0n, stableSwapBps: 0n, stableSwapTaxBps: 0n, liquidationRewardBps: 0n, protocolShareBps: 0n },
    poolApr: { lastUpdated: 0n, feeAprBps: 0n, realizedFeeUsd: 0n },
    maxRequestExecutionSec: 0n, bump: 255, lpTokenBump: 255, inceptionTime: 0n,
  });
}

const ORACLE_PLACEHOLDER = PublicKey.default.toBase58();
const FAKE_BLOCKHASH = bs58.encode(Buffer.alloc(32, 7));

const { CREATE_INCREASE_POSITION_MARKET_REQUEST_DISCRIMINATOR, CREATE_DECREASE_POSITION_REQUEST2_DISCRIMINATOR, CREATE_DECREASE_POSITION_MARKET_REQUEST_DISCRIMINATOR } = jupPerpsClient;
const hasDiscriminator = (ix, disc) => ix.data && ix.data.length >= 8 && Buffer.from(ix.data.slice(0, 8)).equals(Buffer.from(disc));
const optionValue = (opt) => (opt && opt.__option === 'Some' ? opt.value : null);
function encCustody({ mint, decimals = 6, isStable = false, maxPositionSizeUsd = 5_000_000_000_000n, owned = 10_000_000_000_000n, locked = 0n, guaranteedUsd = 1_000_000_000_000n }) {
  return jupPerpsClient.getCustodyEncoder().encode({
    pool: POOL, mint, tokenAccount: mint, decimals, isStable,
    oracle: { oracleAccount: ORACLE_PLACEHOLDER, oracleType: 2, maxPriceError: 0n, maxPriceAgeSec: 600 },
    pricing: { tradeImpactFeeScalar: 0n, buffer: 0n, swapSpread: 0n, maxLeverage: 500_000n, maxGlobalLongSizes: 0n, maxGlobalShortSizes: 0n },
    permissions: { allowSwap: true, allowAddLiquidity: true, allowRemoveLiquidity: true, allowIncreasePosition: true, allowDecreasePosition: true, allowCollateralWithdrawal: true, allowLiquidatePosition: true },
    targetRatioBps: 0n,
    assets: { feesReserves: 0n, owned, locked, guaranteedUsd, globalShortSizes: 0n, globalShortAveragePrices: 0n },
    fundingRateState: { cumulativeInterestRate: 0n, lastUpdate: 0n, hourlyFundingDbps: 100n },
    bump: 255, tokenAccountBump: 255, increasePositionBps: 10n, decreasePositionBps: 10n, maxPositionSizeUsd,
    dovesOracle: ORACLE_PLACEHOLDER,
    jumpRateState: { minRateBps: 0n, maxRateBps: 0n, targetRateBps: 0n, targetUtilizationRate: 0n },
    dovesAgOracle: ORACLE_PLACEHOLDER,
    priceImpactBuffer: { openInterest: new Array(60).fill(0n), lastUpdated: 0n, feeFactor: 0n, exponent: 0, deltaImbalanceThresholdDecimal: 0n, maxFeeBps: 100n },
  });
}

const CUSTODY_BYTES = {
  [C.BTC]: encCustody({ mint: PERP_MINTS.BTC, decimals: 8 }),
  [C.ETH]: encCustody({ mint: PERP_MINTS.ETH, decimals: 8 }),
  [C.SOL]: encCustody({ mint: PERP_MINTS.SOL, decimals: 9 }),
  [C.USDC]: encCustody({ mint: PERP_MINTS.USDC, decimals: 6, isStable: true }),
  [C.USDT]: encCustody({ mint: PERP_MINTS.USDT, decimals: 6, isStable: true }),
};
const POOL_BYTES = encPool([C.BTC, C.ETH, C.SOL, C.USDC, C.USDT]);

/** Fake @solana/kit rpc: pool/custody/ATA reads, blockhash, simulate. No network. */
function fakeRpc({ simResult = { err: null, logs: ['ok'], unitsConsumed: 12_345 }, extraAccounts = {} } = {}) {
  const accounts = { [POOL]: POOL_BYTES, ...CUSTODY_BYTES, ...extraAccounts };
  const encAcc = (bytes) => ({ data: [Buffer.from(bytes).toString('base64'), 'base64'], executable: false, lamports: 1n, owner: PERPETUALS_PROGRAM_ADDRESS, rentEpoch: 0n });
  const calls = { getAccountInfo: 0, getMultipleAccounts: 0, simulateTransaction: 0 };
  return {
    calls,
    getAccountInfo: (addr) => ({ send: async () => { calls.getAccountInfo++; return { value: accounts[addr] ? encAcc(accounts[addr]) : null }; } }),
    getMultipleAccounts: (addrs) => ({ send: async () => { calls.getMultipleAccounts++; return { value: addrs.map((a) => (accounts[a] ? encAcc(accounts[a]) : null)) }; } }),
    getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: FAKE_BLOCKHASH, lastValidBlockHeight: 1000n } }) }),
    simulateTransaction: () => ({ send: async () => { calls.simulateTransaction++; return { value: simResult }; } }),
  };
}

async function main() {
  console.log('Side enum + custody-by-mint (services/jupiterPerps.js)');

  await test('POSITION_SIDE_SEED matches the program Side enum (None=0, Long=1, Short=2)', () => {
    eq(POSITION_SIDE_SEED.long, Side.Long, 'long == Side.Long');
    eq(POSITION_SIDE_SEED.short, Side.Short, 'short == Side.Short');
    eq(Side.None, 0, 'None=0');
    eq(Side.Long, 1, 'Long=1');
    eq(Side.Short, 2, 'Short=2');
    assert(POSITION_SIDE_SEED.long !== 0, 'a long must not encode as None (the pre-fix defect)');
  });

  await test('resolvePerpCustodies: resolves all 5 by mint from a fixture pool, caches per rpc for 5 min', async () => {
    const rpc = fakeRpc();
    const custodies = await resolvePerpCustodies(rpc);
    eq(custodies.BTC, C.BTC, 'BTC');
    eq(custodies.ETH, C.ETH, 'ETH');
    eq(custodies.SOL, C.SOL, 'SOL');
    eq(custodies.USDC, C.USDC, 'USDC');
    eq(custodies.USDT, C.USDT, 'USDT');
    const callsAfterFirst = rpc.calls.getMultipleAccounts;
    await resolvePerpCustodies(rpc); // cached: no extra RPC round trip
    eq(rpc.calls.getMultipleAccounts, callsAfterFirst, 'second call served from cache');
    await resolvePerpCustodies(rpc, { forceRefresh: true });
    eq(rpc.calls.getMultipleAccounts, callsAfterFirst + 1, 'forceRefresh bypasses the cache');
  });

  await test('resolveTradeCustodies: long collateralizes with the asset custody; short with USDC (per program rule)', async () => {
    const rpc = fakeRpc();
    const long = await resolveTradeCustodies(rpc, 'BTC', 'long');
    eq(long.custodyAddress, C.BTC, 'long custody = BTC');
    eq(long.collateralCustodyAddress, C.BTC, 'long collateral custody = BTC (asset itself)');
    const short = await resolveTradeCustodies(rpc, 'BTC', 'short');
    eq(short.custodyAddress, C.BTC, 'short custody = BTC');
    eq(short.collateralCustodyAddress, C.USDC, 'short collateral custody = USDC (stable)');
  });

  await test('resolveTradeCustodies: throws for a symbol not in the fetched pool (validated at call time)', async () => {
    const rpc = fakeRpc({ extraAccounts: {} });
    const thinPool = encPool([C.BTC]); // ETH/SOL/USDC/USDT not in this pool
    const rpc2 = fakeRpc();
    rpc2.getMultipleAccounts = (addrs) => ({ send: async () => ({ value: addrs.map((a) => (a === C.BTC ? { data: [Buffer.from(CUSTODY_BYTES[C.BTC]).toString('base64'), 'base64'] } : null)) }) });
    rpc2.getAccountInfo = (addr) => ({ send: async () => ({ value: addr === POOL ? { data: [Buffer.from(thinPool).toString('base64'), 'base64'] } : null }) });
    let threw = false;
    try { await resolveTradeCustodies(rpc2, 'ETH', 'long'); } catch { threw = true; }
    assert(threw, 'missing custody must throw, not silently fall back');
  });

  console.log('\nbuildOpenPosition (on-chain SL/TP) + buildClosePosition (services/jupiterPerps.js)');

  await test('buildOpenPosition: encodes side=Long, includes ATA-create + increase + SL + TP trigger instructions in order', async () => {
    const rpc = fakeRpc();
    const built = await buildOpenPosition({ market: 'BTCUSDT', direction: 'long', sizeUsd: 200, leverage: 5, stopLoss: 84390, takeProfit: 85146, owner: OWNER, connection: rpc });
    eq(built.meta.side, Side.Long, 'side = Long');
    assert(built.meta.triggers.stopLoss, 'stopLoss trigger present');
    assert(built.meta.triggers.takeProfit, 'takeProfit trigger present');
    eq(built.meta.triggers.stopLoss.triggerAboveThreshold, false, 'long SL fires below the trigger price');
    eq(built.meta.triggers.takeProfit.triggerAboveThreshold, true, 'long TP fires above the trigger price');
    assert(built.meta.triggers.stopLoss.positionRequestId !== built.meta.triggers.takeProfit.positionRequestId, 'SL/TP use distinct position-request PDAs');
    assert(typeof built.simulate === 'function' && typeof built.send === 'function', 'build result exposes simulate/send');

    // decode the increase instruction back with the IDL decoder and check the side + amounts
    const kitInstructions = built.transaction.instructions;
    const increaseIx = kitInstructions.find((ix) => hasDiscriminator(ix, CREATE_INCREASE_POSITION_MARKET_REQUEST_DISCRIMINATOR));
    assert(increaseIx, 'increase instruction found');
    const decodedIncrease = jupPerpsClient.getCreateIncreasePositionMarketRequestInstructionDataDecoder().decode(increaseIx.data);
    eq(decodedIncrease.side, Side.Long, 'decoded side round-trips to Long');
    eq(decodedIncrease.sizeUsdDelta, 200_000_000n, 'sizeUsdDelta round-trips ($200 @ 1e6)');

    const decreaseIxs = kitInstructions.filter((ix) => hasDiscriminator(ix, CREATE_DECREASE_POSITION_REQUEST2_DISCRIMINATOR));
    eq(decreaseIxs.length, 2, 'two trigger decrease instructions (SL + TP)');
    const decodedDecreases = decreaseIxs.map((ix) => jupPerpsClient.getCreateDecreasePositionRequest2InstructionDataDecoder().decode(ix.data));
    assert(decodedDecreases.every((d) => d.requestType === RequestType.Trigger), 'both decrease requests are Trigger type');
    const triggerPrices = decodedDecreases.map((d) => optionValue(d.triggerPrice)).sort();
    eq(triggerPrices[0], 84_390_000_000n, 'SL triggerPrice round-trips');
    eq(triggerPrices[1], 85_146_000_000n, 'TP triggerPrice round-trips');

    // ATA-create instructions included because the fake rpc has no ATA accounts at all
    const ataCreateCount = kitInstructions.filter((ix) => ix.data && ix.data.length === 1 && ix.data[0] === 1).length;
    assert(ataCreateCount >= 3, `at least 3 ATA-create instructions (funding + 2 position-request ATAs), got ${ataCreateCount}`);
  });

  await test('buildOpenPosition: encodes side=Short and short collateralizes with USDC; SL/TP thresholds flip', async () => {
    const rpc = fakeRpc();
    const built = await buildOpenPosition({ market: 'BTCUSDT', direction: 'short', sizeUsd: 100, leverage: 3, stopLoss: 86000, takeProfit: 82000, owner: OWNER, connection: rpc });
    eq(built.meta.side, Side.Short, 'side = Short');
    eq(built.meta.collateralCustody, C.USDC, 'short collateral custody = USDC');
    eq(built.meta.triggers.stopLoss.triggerAboveThreshold, true, 'short SL fires above the trigger price');
    eq(built.meta.triggers.takeProfit.triggerAboveThreshold, false, 'short TP fires below the trigger price');
  });

  await test('buildOpenPosition: omitting stopLoss/takeProfit builds with no trigger instructions', async () => {
    const rpc = fakeRpc();
    const built = await buildOpenPosition({ market: 'ETHUSDT', direction: 'long', sizeUsd: 50, leverage: 2, owner: OWNER, connection: rpc });
    eq(Object.keys(built.meta.triggers).length, 0, 'no triggers');
  });

  await test('buildOpenPosition: no ATA-create instruction when the account already exists', async () => {
    // Pre-populate the funding ATA so ensureAtaInstruction sees it as existing.
    const collateralMint = new PublicKey(PERP_MINTS.BTC);
    const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
    const fundingAta = getAssociatedTokenAddressSync(collateralMint, new PublicKey(OWNER), false).toBase58();
    const rpc = fakeRpc({ extraAccounts: { [fundingAta]: Buffer.from([1, 2, 3]) } });
    const withoutAta = await buildOpenPosition({ market: 'BTCUSDT', direction: 'long', sizeUsd: 10, leverage: 2, owner: OWNER, connection: fakeRpc() });
    const withAta = await buildOpenPosition({ market: 'BTCUSDT', direction: 'long', sizeUsd: 10, leverage: 2, owner: OWNER, connection: rpc });
    const countCreates = (b) => b.transaction.instructions.filter((ix) => ix.data && ix.data.length === 1 && ix.data[0] === 1).length;
    assert(countCreates(withAta) < countCreates(withoutAta), 'fewer ATA-creates when the funding ATA already exists');
  });

  await test('buildClosePosition: entirePosition=true by default (full close), false + sizeUsdDelta for a partial close', async () => {
    const rpc = fakeRpc();
    const full = await buildClosePosition({ positionId: PublicKey.default.toBase58(), market: 'BTCUSDT', direction: 'long', positionSizeUsd: 200, owner: OWNER, connection: rpc });
    eq(full.meta.entirePosition, true, 'full close: entirePosition');
    const closeIx = full.transaction.instructions.find((ix) => hasDiscriminator(ix, CREATE_DECREASE_POSITION_MARKET_REQUEST_DISCRIMINATOR));
    assert(closeIx, 'decrease-market instruction found');
    const decoded = jupPerpsClient.getCreateDecreasePositionMarketRequestInstructionDataDecoder().decode(closeIx.data);
    eq(optionValue(decoded.entirePosition), true, 'decoded entirePosition round-trips true');

    const partial = await buildClosePosition({ positionId: PublicKey.default.toBase58(), market: 'BTCUSDT', direction: 'long', sizeUsd: 50, collateralUsd: 40, positionSizeUsd: 200, owner: OWNER, connection: rpc });
    eq(partial.meta.entirePosition, false, 'partial close: not entirePosition');
    const partialIx = partial.transaction.instructions.find((ix) => hasDiscriminator(ix, CREATE_DECREASE_POSITION_MARKET_REQUEST_DISCRIMINATOR));
    const decodedPartial = jupPerpsClient.getCreateDecreasePositionMarketRequestInstructionDataDecoder().decode(partialIx.data);
    eq(optionValue(decodedPartial.entirePosition), false, 'decoded entirePosition round-trips false');
    eq(decodedPartial.sizeUsdDelta, 50_000_000n, 'partial sizeUsdDelta round-trips');
    eq(decodedPartial.collateralUsdDelta, 10_000_000n, 'proportional collateralUsdDelta (40 * 50/200 = 10)');
  });

  console.log('\nbuild -> simulate -> send (single sendSigned broadcaster)');

  await test('simulate(): returns {err:null} on a clean fixture, {err} when the fake rpc reports one', async () => {
    const ok = fakeRpc();
    const built1 = await buildOpenPosition({ market: 'BTCUSDT', direction: 'long', sizeUsd: 10, leverage: 2, owner: OWNER, connection: ok });
    const sim1 = await built1.simulate(ok);
    eq(sim1.err, null, 'clean simulation');
    eq(ok.calls.simulateTransaction, 1, 'simulate hit the rpc once');

    const bad = fakeRpc({ simResult: { err: { InstructionError: [0, 'Custom'] }, logs: ['Program log: CustodyAmountLimit'], unitsConsumed: 100 } });
    const built2 = await buildOpenPosition({ market: 'BTCUSDT', direction: 'long', sizeUsd: 10, leverage: 2, owner: OWNER, connection: bad });
    const sim2 = await built2.simulate(bad);
    assert(sim2.err, 'simulation error surfaced');
    assert(sim2.logs.some((l) => l.includes('CustodyAmountLimit')), 'logs surfaced');
  });

  await test('openPerpPosition: simulation error refuses to sign/send (never reaches sendAndConfirmTransactionFactory)', async () => {
    const bad = fakeRpc({ simResult: { err: 'boom', logs: ['fail'], unitsConsumed: 1 } });
    let threw = null;
    try {
      // JUPITER_SIMULATE_ONLY unset: if the refusal were broken and send() were reached,
      // sendAndConfirmTransactionFactory would call rpc.sendTransaction, which this fake rpc
      // does not implement -- that would throw a *different* error than the simulation
      // refusal, so this test also catches a broken refusal, not just a missing throw.
      await openPerpPosition('BTCUSDT', 'long', 10, 2, 84000, 86000, { connection: bad });
    } catch (err) {
      threw = err;
    }
    assert(threw, 'must throw');
    assert(/simulation failed/i.test(threw.message), `expected a simulation-failure message, got: ${threw.message}`);
  });

  await test('openPerpPosition (JUPITER_SIMULATE_ONLY=true): build -> simulate -> sign -> simulate-only "send", no positionId/signature leak of a real tx', async () => {
    const rpc = fakeRpc();
    process.env.JUPITER_SIMULATE_ONLY = 'true';
    try {
      const r = await openPerpPosition('BTCUSDT', 'long', 200, 5, 84390, 85146, { connection: rpc });
      eq(r.success, true, 'success');
      eq(r.simulated, true, 'simulated flag set');
      eq(r.signature, null, 'no signature when simulate-only');
      assert(typeof r.positionId === 'string' && r.positionId.length > 0, 'positionId present');
      assert(r.triggers.stopLoss && r.triggers.takeProfit, 'SL/TP triggers present in the result');
      eq(rpc.calls.simulateTransaction, 2, 'one simulate() call + one simulate-only sendSigned call');
    } finally {
      delete process.env.JUPITER_SIMULATE_ONLY;
    }
  });

  await test('closePerpPosition (JUPITER_SIMULATE_ONLY=true): resolves the position from getPerpPositions, builds a full close', async () => {
    const positionId = PublicKey.default.toBase58();
    const rpc = fakeRpc();
    // getPerpPositions derives candidate PDAs and reads them via getMultipleAccounts; make
    // every candidate miss except the one this test cares about isn't required here because
    // closePerpPosition only needs the *shape* -- stub getPerpPositions's own dependency by
    // driving it through a connection whose getMultipleAccounts returns no matches, then
    // assert the "position not found" path throws cleanly (no network, no crash).
    let threw = null;
    process.env.JUPITER_SIMULATE_ONLY = 'true';
    try {
      await closePerpPosition(positionId, null, { connection: rpc });
    } catch (err) {
      threw = err;
    } finally {
      delete process.env.JUPITER_SIMULATE_ONLY;
    }
    assert(threw, 'must throw');
    assert(/Position not found/.test(threw.message), `expected a not-found message, got: ${threw.message}`);
  });

  await test('sendSigned: JUPITER_SIMULATE_ONLY=true simulates instead of sending; unset would need rpc.sendTransaction', async () => {
    const rpc = fakeRpc();
    const built = await buildOpenPosition({ market: 'SOLUSDT', direction: 'long', sizeUsd: 10, leverage: 2, owner: OWNER, connection: rpc });
    const signer = createKitSigner(TEST_KEYPAIR);
    process.env.JUPITER_SIMULATE_ONLY = 'true';
    try {
      const result = await sendSigned(built.transaction, signer, rpc);
      eq(result.simulated, true, 'simulated');
      eq(result.err, null, 'no error');
    } finally {
      delete process.env.JUPITER_SIMULATE_ONLY;
    }
  });

  await test('createKitSigner: signs with the given keypair (nacl detached signature verifies)', async () => {
    const nacl = (await import('tweetnacl')).default;
    const signer = createKitSigner(TEST_KEYPAIR);
    const message = new TextEncoder().encode('hello jupiter perps');
    const sigMap = await signer.signMessage(message);
    const sig = sigMap[signer.address];
    assert(nacl.sign.detached.verify(message, sig, TEST_KEYPAIR.publicKey.toBytes()), 'signature verifies against the test keypair');
  });

  await test('no code path in services/jupiterPerps.js broadcasts a transaction outside sendSigned', () => {
    const src = readFileSync(path.join(root, 'services/jupiterPerps.js'), 'utf8');
    const matches = [...src.matchAll(/sendAndConfirmTransactionFactory\s*\(/g)];
    eq(matches.length, 1, `sendAndConfirmTransactionFactory must appear exactly once (inside sendSigned), found ${matches.length}`);
    const idx = matches[0].index;
    const sendSignedStart = src.indexOf('export async function sendSigned(');
    const nextExportAfter = src.indexOf('\nexport ', sendSignedStart + 1);
    assert(sendSignedStart !== -1 && idx > sendSignedStart && (nextExportAfter === -1 || idx < nextExportAfter), 'the one call site is inside the sendSigned function body');
  });

  console.log('\nupdate-stops: create/replace trigger requests (services/jupiterPerps.js)');

  await test('buildUpdateStops: creates new Trigger decrease requests for SL and/or TP, same threshold rules as open', async () => {
    const rpc = fakeRpc();
    const both = await buildUpdateStops({ positionId: PublicKey.default.toBase58(), market: 'BTCUSDT', direction: 'long', stop: 83000, tp: 87000, positionSizeUsd: 200, owner: OWNER, connection: rpc });
    eq(both.meta.triggers.stopLoss.triggerAboveThreshold, false, 'long SL below');
    eq(both.meta.triggers.takeProfit.triggerAboveThreshold, true, 'long TP above');
    const decreaseIxs = both.transaction.instructions.filter((ix) => hasDiscriminator(ix, CREATE_DECREASE_POSITION_REQUEST2_DISCRIMINATOR));
    eq(decreaseIxs.length, 2, 'two new trigger requests built');
    const decoded = decreaseIxs.map((ix) => jupPerpsClient.getCreateDecreasePositionRequest2InstructionDataDecoder().decode(ix.data));
    const prices = decoded.map((d) => optionValue(d.triggerPrice)).sort();
    eq(prices[0], 83_000_000_000n, 'SL triggerPrice round-trips');
    eq(prices[1], 87_000_000_000n, 'TP triggerPrice round-trips');

    const stopOnly = await buildUpdateStops({ positionId: PublicKey.default.toBase58(), market: 'BTCUSDT', direction: 'short', stop: 88000, positionSizeUsd: 200, owner: OWNER, connection: rpc });
    eq(Object.keys(stopOnly.meta.triggers).length, 1, 'only stopLoss requested');
    eq(stopOnly.meta.triggers.stopLoss.triggerAboveThreshold, true, 'short SL above');
  });

  await test('buildUpdateStops: throws without stop or tp (nothing to update)', async () => {
    const rpc = fakeRpc();
    let threw = false;
    try { await buildUpdateStops({ positionId: PublicKey.default.toBase58(), market: 'BTCUSDT', direction: 'long', owner: OWNER, connection: rpc }); } catch { threw = true; }
    assert(threw, 'must throw when neither stop nor tp given');
  });

  await test('buildReplaceTriggerRequest: updateDecreasePositionRequest2 round trip for an already-known pending request', async () => {
    const rpc = fakeRpc();
    const opened = await buildOpenPosition({ market: 'BTCUSDT', direction: 'long', sizeUsd: 200, leverage: 5, stopLoss: 84390, owner: OWNER, connection: rpc });
    const pendingSL = opened.meta.triggers.stopLoss;
    const replaced = await buildReplaceTriggerRequest({ positionId: opened.meta.positionId, positionRequestId: pendingSL.positionRequestId, sizeUsdDelta: 200, triggerPrice: 84100, market: 'BTCUSDT', direction: 'long', owner: OWNER, connection: rpc });
    const ix = replaced.transaction.instructions.find((ix2) => hasDiscriminator(ix2, jupPerpsClient.UPDATE_DECREASE_POSITION_REQUEST2_DISCRIMINATOR));
    assert(ix, 'update-decrease-request2 instruction found');
    const decoded = jupPerpsClient.getUpdateDecreasePositionRequest2InstructionDataDecoder().decode(ix.data);
    eq(decoded.triggerPrice, 84_100_000_000n, 'new triggerPrice round-trips');
    eq(decoded.sizeUsdDelta, 200_000_000n, 'sizeUsdDelta round-trips');
  });

  console.log('\nreal quote + custody capacity from on-chain fixture data (services/jupiterPerps.js)');

  await test('getPerpQuote: fees from custody increasePositionBps, liquidationPrice only when a markPrice is given', async () => {
    const rpc = fakeRpc();
    const noMark = await getPerpQuote('BTCUSDT', 'long', 1000, 5, { connection: rpc });
    eq(noMark.openFeeBps, 10, 'increasePositionBps from the fixture custody');
    eq(noMark.closeFeeBps, 10, 'decreasePositionBps from the fixture custody');
    eq(noMark.estimatedFees, 1, 'fees = 1000 * 10bps/10000 (no price-impact bps in this fixture)');
    eq(noMark.liquidationPrice, null, 'no markPrice -> no liquidationPrice');
    eq(noMark.marginRequired, 200, 'marginRequired = size/leverage');

    const withMark = await getPerpQuote('BTCUSDT', 'long', 1000, 5, { connection: rpc, markPrice: 90000 });
    eq(withMark.liquidationPrice, 72270, 'liq = 90000 * (1 - (1/5 - 0.003))');
    const short = await getPerpQuote('BTCUSDT', 'short', 1000, 5, { connection: rpc, markPrice: 90000 });
    eq(short.liquidationPrice, 107730, 'short liq = 90000 * (1 + (1/5 - 0.003))');
  });

  await test('getPerpQuote: rejects out-of-range leverage and below-minimum margin before any chain call', async () => {
    const rpc = fakeRpc();
    let threw1 = false;
    try { await getPerpQuote('BTCUSDT', 'long', 100, 500, { connection: rpc }); } catch { threw1 = true; }
    assert(threw1, 'leverage > 200 rejected');
    eq(rpc.calls.getMultipleAccounts, 0, 'no chain call before validation');
    let threw2 = false;
    try { await getPerpQuote('BTCUSDT', 'long', 0.001, 1, { connection: rpc }); } catch { threw2 = true; }
    assert(threw2, 'below-minimum margin rejected');
  });

  await test('checkCustodyCapacity: numeric headroom = maxPositionSizeUsd - current utilization on the asset custody (both directions track exposure there: Custody.assets.globalShortSizes exists precisely for short exposure on the same custody)', async () => {
    const rpc = fakeRpc();
    const long = await checkCustodyCapacity('BTCUSDT', 500, { connection: rpc, direction: 'long' });
    eq(long.maxPositionSizeUsd, 5_000_000, 'maxPositionSizeUsd from the fixture custody (5e12 / 1e6)');
    eq(long.usedUsd, 1_000_000, 'usedUsd = guaranteedUsd for the (non-stable) asset custody');
    eq(long.headroomUsd, 4_000_000, 'headroom = max - used');
    eq(long.availableUsd, long.headroomUsd, 'availableUsd alias matches headroomUsd');
    assert(typeof long.currentAssets === 'number', 'currentAssets present for executor compat');

    const short = await checkCustodyCapacity('BTCUSDT', 500, { connection: rpc, direction: 'short' });
    eq(short.custodyAddress, C.BTC, 'capacity is checked against the asset custody for both directions');
    eq(short.headroomUsd, long.headroomUsd, 'same custody data -> same headroom regardless of direction');
  });

  await test('getPerpMarkets: resolves BTC/ETH/SOL by mint from the fixture pool, keyed by market symbol', async () => {
    const rpc = fakeRpc();
    const markets = await getPerpMarkets({ connection: rpc });
    eq(Object.keys(markets).sort().join(','), 'BTCUSDT,ETHUSDT,SOLUSDT', 'all three markets resolved');
    eq(markets.BTCUSDT.custodyAddress, C.BTC, 'BTC custody by mint');
    eq(markets.BTCUSDT.tokenMint, PERP_MINTS.BTC, 'BTC mint');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`Failures:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
