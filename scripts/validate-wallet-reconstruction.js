#!/usr/bin/env node
/**
 * Wallet + Jupiter Trade Reconstruction — deterministic validation harness
 *
 *   node scripts/validate-wallet-reconstruction.js
 *
 * ZERO NETWORK. Every transaction below is hand-written in the exact shape
 * `connection.getParsedTransactions()` returns, and every expected number is
 * worked out by hand in the comment above the assertion — never by calling the
 * function under test and blessing whatever came back.
 *
 * This harness carries the weight of correctness for this feature, because the
 * environment it was written in cannot reach a Solana RPC or the Jupiter APIs
 * (egress policy returns 403 for api.mainnet-beta.solana.com, lite-api.jup.ag
 * and every other RPC host tried). Nothing here has been checked against live
 * mainnet data. See docs/WALLET_RECONSTRUCTION.md.
 *
 * Exit code 0 = all assertions hold.
 */

import {
  validateSolanaAddress,
  base58Decode,
  symbolForMint,
  SOL_MINT
} from '../services/solanaWalletReader.js';

import {
  reconstructTrades,
  classifySwap,
  computeOwnerDeltas,
  matchLots,
  makeTradeId,
  applyOverrides,
  resolveTrade,
  detectOverrideConflicts,
  CONFIDENCE,
  LOT_MATCHING_POLICY,
  JUPITER_PERPS_PROGRAM_ID,
  JUPITER_SWAP_PROGRAM_IDS
} from '../services/jupiterReconstruction.js';

let failures = 0;
let assertions = 0;

function ok(name, condition, detail = '') {
  assertions++;
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`);
    failures++;
  }
}

function near(name, actual, expected, tolerance = 1e-6) {
  const good = Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
  ok(name, good, `got ${actual}, expected ~${expected}`);
}

function section(title) {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

/* ======================================================================
 * FIXTURES
 * ==================================================================== */

const WALLET = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';   // real base58, 32 bytes
const OTHER  = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const USDC   = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK   = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const JUP_V6 = JUPITER_SWAP_PROGRAM_IDS[0];

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM  = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const T0 = 1_700_000_000; // unix seconds; every fixture is offset from here
const HOUR = 3600;

/**
 * Build a parsed-transaction fixture.
 *
 * `tokens` is a list of `{ mint, decimals, pre, post, owner }` in RAW units,
 * exactly as `meta.pre/postTokenBalances` carries them.
 *
 * `solPre`/`solPost` are the ECONOMIC lamport balances. The builder subtracts
 * the fee from the recorded `postBalances` itself, because a real validator
 * always debits the fee payer — so `solPre === solPost` here means "this
 * transaction moved no SOL except gas", which is the common case. Getting this
 * wrong made every swap look like it had a spurious extra SOL leg.
 */
function tx({
  signature,
  hoursAfterT0 = 0,
  programs = [JUP_V6],
  tokens = [],
  solPre = 5_000_000_000,
  solPost = 5_000_000_000,
  fee = 5000,
  err = null,
  owner = WALLET,
  omitMeta = false,
  omitBalances = false
}) {
  const accountKeys = [
    { pubkey: owner, signer: true, writable: true },
    { pubkey: OTHER, signer: false, writable: true }
  ];

  const base = {
    slot: 100000 + hoursAfterT0,
    blockTime: T0 + hoursAfterT0 * HOUR,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys,
        instructions: programs.map((programId) => ({ programId, accounts: [], data: 'unparsed' }))
      }
    }
  };

  if (omitMeta) return base;

  const meta = {
    err,
    fee,
    preBalances: [solPre, 1_000_000],
    // The fee payer is always debited the fee on-chain.
    postBalances: [solPost - fee, 1_000_000],
    innerInstructions: []
  };

  if (!omitBalances) {
    meta.preTokenBalances = [];
    meta.postTokenBalances = [];
    tokens.forEach((token, index) => {
      const entry = (amount) => ({
        accountIndex: index + 2,
        mint: token.mint,
        owner: token.owner || owner,
        uiTokenAmount: {
          amount: String(amount),
          decimals: token.decimals,
          uiAmount: amount / 10 ** token.decimals,
          uiAmountString: String(amount / 10 ** token.decimals)
        }
      });
      meta.preTokenBalances.push(entry(token.pre));
      meta.postTokenBalances.push(entry(token.post));
    });
  }

  base.meta = meta;
  return base;
}

/** USDC -> BONK buy. `usdcSpent` and `bonkReceived` in human units. */
function buyBonk({ signature, hoursAfterT0, usdcSpent, bonkReceived, usdcStart = 10_000, bonkStart = 0 }) {
  return tx({
    signature,
    hoursAfterT0,
    tokens: [
      { mint: USDC, decimals: 6, pre: Math.round(usdcStart * 1e6), post: Math.round((usdcStart - usdcSpent) * 1e6) },
      { mint: BONK, decimals: 5, pre: Math.round(bonkStart * 1e5), post: Math.round((bonkStart + bonkReceived) * 1e5) }
    ]
  });
}

/** BONK -> USDC sell. */
function sellBonk({ signature, hoursAfterT0, bonkSold, usdcReceived, usdcStart = 0, bonkStart = 1_000_000 }) {
  return tx({
    signature,
    hoursAfterT0,
    tokens: [
      { mint: BONK, decimals: 5, pre: Math.round(bonkStart * 1e5), post: Math.round((bonkStart - bonkSold) * 1e5) },
      { mint: USDC, decimals: 6, pre: Math.round(usdcStart * 1e6), post: Math.round((usdcStart + usdcReceived) * 1e6) }
    ]
  });
}

const run = (transactions, opts = {}) =>
  reconstructTrades({ transactions, address: WALLET, ...opts });

/* ======================================================================
 * 1. ADDRESS VALIDATION
 * ==================================================================== */
section('1. Address validation');

ok('accepts a real mainnet address', validateSolanaAddress(WALLET));
ok('accepts a second real address', validateSolanaAddress(OTHER));
ok('accepts the USDC mint', validateSolanaAddress(USDC));
ok('accepts the wrapped SOL mint', validateSolanaAddress(SOL_MINT));
ok('accepts the system program (all-ones, leading zero bytes)', validateSolanaAddress(SYSTEM_PROGRAM));

ok('rejects empty string', !validateSolanaAddress(''));
ok('rejects null', !validateSolanaAddress(null));
ok('rejects undefined', !validateSolanaAddress(undefined));
ok('rejects a number', !validateSolanaAddress(12345));
ok('rejects plain junk', !validateSolanaAddress('not-an-address'));
ok('rejects an Ethereum address', !validateSolanaAddress('0x742d35Cc6634C0532925a3b844Bc454e4438f44e'));
ok('rejects base58 that is too short', !validateSolanaAddress('5Q544fKrFoe6tsEbD7S8'));
ok('rejects base58 that is too long', !validateSolanaAddress(WALLET + WALLET));
ok('rejects "0" (not in the base58 alphabet)', !validateSolanaAddress('0' + WALLET.slice(1)));
ok('rejects "O" (not in the base58 alphabet)', !validateSolanaAddress('O' + WALLET.slice(1)));
ok('rejects "I" (not in the base58 alphabet)', !validateSolanaAddress('I' + WALLET.slice(1)));
ok('rejects "l" (not in the base58 alphabet)', !validateSolanaAddress('l' + WALLET.slice(1)));
ok('rejects whitespace padding', !validateSolanaAddress(` ${WALLET} `));

// A 44-char string can decode to 33 bytes, which is length-plausible but wrong.
ok('rejects a 33-byte decode', !validateSolanaAddress('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'));

ok('base58Decode returns 32 bytes for a valid address', base58Decode(WALLET)?.length === 32);
ok('base58Decode returns null on a bad character', base58Decode('0OIl') === null);

ok('symbolForMint labels wrapped SOL', symbolForMint(SOL_MINT) === 'SOL');
ok('symbolForMint returns null for an unknown mint', symbolForMint(BONK) === null);

/* ======================================================================
 * 2. DELTA DECODING
 * ==================================================================== */
section('2. Owner balance-delta decoding');

const deltaTx = buyBonk({ signature: 'sig-delta', hoursAfterT0: 0, usdcSpent: 100, bonkReceived: 5_000_000 });
const decoded = computeOwnerDeltas(deltaTx, WALLET);

ok('decodes a transaction with balance arrays', decoded.decoded === true);
near('USDC delta is -100', decoded.deltas.get(USDC).amount, -100);
near('BONK delta is +5,000,000', decoded.deltas.get(BONK).amount, 5_000_000);
ok('fee-only SOL movement is not reported as a leg', !decoded.deltas.has(SOL_MINT),
  'fee is added back so gas does not read as a trade');

// Another wallet's balances in the same transaction must be ignored.
const foreignTx = tx({
  signature: 'sig-foreign',
  tokens: [{ mint: USDC, decimals: 6, pre: 0, post: 500_000_000, owner: OTHER }]
});
ok('ignores token balances belonging to another owner',
  computeOwnerDeltas(foreignTx, WALLET).deltas.size === 0);

// Missing meta must not be silently treated as "nothing happened".
ok('reports undecodable when meta is absent',
  computeOwnerDeltas(tx({ signature: 'sig-nometa', omitMeta: true }), WALLET).decoded === false);

/* ======================================================================
 * 3. CLASSIFICATION
 * ==================================================================== */
section('3. Transaction classification');

ok('classifies a Jupiter swap as SWAP', classifySwap(deltaTx, WALLET).kind === 'SWAP');
ok('marks the swap as Jupiter-routed', classifySwap(deltaTx, WALLET).viaJupiter === true);

const failedTx = buyBonk({ signature: 'sig-failed', hoursAfterT0: 0, usdcSpent: 100, bonkReceived: 5_000_000 });
failedTx.meta.err = { InstructionError: [3, 'Custom'] };
ok('a failed transaction classifies as FAILED', classifySwap(failedTx, WALLET).kind === 'FAILED');

const perpTx = tx({
  signature: 'sig-perp',
  hoursAfterT0: 1,
  programs: [JUPITER_PERPS_PROGRAM_ID],
  tokens: [{ mint: USDC, decimals: 6, pre: 1_000_000_000, post: 500_000_000 }]
});
ok('perps program classifies as PERP_ACTIVITY', classifySwap(perpTx, WALLET).kind === 'PERP_ACTIVITY');

const depositTx = tx({
  signature: 'sig-deposit',
  hoursAfterT0: 1,
  programs: [SYSTEM_PROGRAM],
  solPre: 1_000_000_000,
  solPost: 3_000_000_000
});
ok('an incoming SOL transfer classifies as TRANSFER_IN', classifySwap(depositTx, WALLET).kind === 'TRANSFER_IN');

const withdrawalTx = tx({
  signature: 'sig-withdrawal',
  hoursAfterT0: 2,
  programs: [TOKEN_PROGRAM],
  tokens: [{ mint: USDC, decimals: 6, pre: 500_000_000, post: 200_000_000 }]
});
ok('an outgoing token transfer classifies as TRANSFER_OUT', classifySwap(withdrawalTx, WALLET).kind === 'TRANSFER_OUT');

/* ======================================================================
 * 4. SINGLE BUY -> OPEN POSITION
 *
 * Buy 5,000,000 BONK for 100 USDC.
 * Entry = 100 / 5,000,000 = 0.00002 USD per BONK.
 * ==================================================================== */
section('4. Single buy opens a position at the right entry');

const single = await run([buyBonk({ signature: 'sig-buy-1', hoursAfterT0: 0, usdcSpent: 100, bonkReceived: 5_000_000 })]);

ok('produces exactly one trade', single.trades.length === 1, `got ${single.trades.length}`);

const openTrade = single.trades[0];
ok('trade is OPEN', openTrade.status === 'OPEN', openTrade.status);
ok('trade is CLOSED-at is null while open', openTrade.closedAt === null);
ok('trade is marked ONCHAIN', openTrade.source === 'ONCHAIN');
ok('trade kind is SPOT', openTrade.kind === 'SPOT');
ok('spot trade direction is LONG', openTrade.direction === 'LONG');
ok('asset is the BONK mint', openTrade.assetMint === BONK);
near('entry is 0.00002 USD', openTrade.entry, 0.00002, 1e-12);
near('quantity is 5,000,000', openTrade.quantity, 5_000_000);
near('notional is 100 USD', openTrade.notional, 100, 1e-9);
ok('realized P&L is null while open', openTrade.realizedPnl === null);
ok('unrealized P&L is null (never estimated)', openTrade.unrealizedPnl === null);
ok('stablecoin-quoted buy is VERIFIED', openTrade.dataConfidence === CONFIDENCE.VERIFIED,
  JSON.stringify(openTrade.confidenceReasons));
ok('leg kind is OPEN', openTrade.legs.length === 1 && openTrade.legs[0].kind === 'OPEN');
ok('leg carries its signature', openTrade.legs[0].signature === 'sig-buy-1');
ok('lot policy is recorded on the trade', openTrade.meta.lotPolicy === LOT_MATCHING_POLICY);
ok('position list mirrors the open trade', single.positions.length === 1 && single.positions[0].assetMint === BONK);
ok('stats count one open trade', single.stats.openCount === 1 && single.stats.closedCount === 0);
ok('stats realized P&L is null with no closes', single.stats.realizedPnl === null);

/* ======================================================================
 * 5. BUY THEN FULL SELL -> CLOSED WITH CORRECT REALIZED P&L
 *
 * Buy  5,000,000 BONK for 100 USDC  -> entry 0.00002
 * Sell 5,000,000 BONK for 150 USDC  -> exit  0.00003
 * Realized = (0.00003 - 0.00002) x 5,000,000 = 50 USD
 * ==================================================================== */
section('5. Buy then full sell closes with correct realized P&L');

const roundTrip = await run([
  buyBonk({ signature: 'sig-buy-2', hoursAfterT0: 0, usdcSpent: 100, bonkReceived: 5_000_000 }),
  sellBonk({ signature: 'sig-sell-2', hoursAfterT0: 5, bonkSold: 5_000_000, usdcReceived: 150, bonkStart: 5_000_000 })
]);

ok('produces exactly one trade', roundTrip.trades.length === 1, `got ${roundTrip.trades.length}`);

const closed = roundTrip.trades[0];
ok('trade is CLOSED', closed.status === 'CLOSED', closed.status);
near('entry is 0.00002', closed.entry, 0.00002, 1e-12);
near('exit is 0.00003', closed.exit, 0.00003, 1e-12);
near('realized P&L is +50 USD', closed.realizedPnl, 50, 1e-6);
ok('closedAt is set', typeof closed.closedAt === 'string');
ok('openedAt precedes closedAt', Date.parse(closed.openedAt) < Date.parse(closed.closedAt));
ok('both signatures are attached', closed.signatures.length === 2);
ok('legs are OPEN then CLOSE',
  closed.legs.map((l) => l.kind).join(',') === 'OPEN,CLOSE',
  closed.legs.map((l) => l.kind).join(','));
ok('round trip is VERIFIED', closed.dataConfidence === CONFIDENCE.VERIFIED);
near('stats realized P&L matches the trade', roundTrip.stats.realizedPnl, 50, 1e-6);
ok('stats count one closed trade', roundTrip.stats.closedCount === 1 && roundTrip.stats.openCount === 0);
ok('no open positions remain', roundTrip.positions.length === 0);

// A loss must be reported as a loss, not clamped.
const losing = await run([
  buyBonk({ signature: 'sig-buy-loss', hoursAfterT0: 0, usdcSpent: 100, bonkReceived: 5_000_000 }),
  sellBonk({ signature: 'sig-sell-loss', hoursAfterT0: 5, bonkSold: 5_000_000, usdcReceived: 60, bonkStart: 5_000_000 })
]);
near('a losing round trip reports -40 USD', losing.trades[0].realizedPnl, -40, 1e-6);

/* ======================================================================
 * 6. FIFO LOT MATCHING — buy, buy, partial sell
 *
 * Buy  1,000,000 BONK for  10 USDC  -> lot A @ 0.00001
 * Buy  1,000,000 BONK for  30 USDC  -> lot B @ 0.00003
 * Sell 1,500,000 BONK for  60 USDC  -> exit    0.00004
 *
 * FIFO consumes lot A entirely (1,000,000) then 500,000 of lot B:
 *   lot A: (0.00004 - 0.00001) x 1,000,000 = 30
 *   lot B: (0.00004 - 0.00003) x   500,000 =  5
 *   realized                                = 35
 * Remaining open: 500,000 BONK from lot B.
 *
 * Under LIFO the answer would be 15 + 10 = 25, so this assertion genuinely
 * pins the policy rather than just the arithmetic.
 * ==================================================================== */
section('6. FIFO lot matching across adds and a partial exit');

const fifo = await run([
  buyBonk({ signature: 'sig-lot-a', hoursAfterT0: 0, usdcSpent: 10, bonkReceived: 1_000_000, bonkStart: 0 }),
  buyBonk({ signature: 'sig-lot-b', hoursAfterT0: 1, usdcSpent: 30, bonkReceived: 1_000_000, usdcStart: 9_990, bonkStart: 1_000_000 }),
  sellBonk({ signature: 'sig-partial', hoursAfterT0: 2, bonkSold: 1_500_000, usdcReceived: 60, bonkStart: 2_000_000 })
]);

ok('the three fills form a single trade', fifo.trades.length === 1, `got ${fifo.trades.length}`);

const partial = fifo.trades[0];
ok('trade is still OPEN after a partial exit', partial.status === 'OPEN', partial.status);
near('FIFO realized P&L is +35 USD (LIFO would be 25)', partial.realizedPnl, 35, 1e-6);
near('remaining open quantity is 500,000', partial.quantity, 500_000, 1e-6);
near('total bought is 2,000,000', partial.meta.totalBoughtQty, 2_000_000);
near('total sold is 1,500,000', partial.meta.totalSoldQty, 1_500_000);

// Average entry over both buys: (10 + 30) / 2,000,000 = 0.00002
near('average entry is 0.00002', partial.entry, 0.00002, 1e-12);
// Only one sell, so exit VWAP is that sell's price.
near('exit VWAP is 0.00004', partial.exit, 0.00004, 1e-12);

ok('legs are OPEN, ADD, REDUCE',
  partial.legs.map((l) => l.kind).join(',') === 'OPEN,ADD,REDUCE',
  partial.legs.map((l) => l.kind).join(','));
near('the ADD leg carries its own quantity', partial.legs[1].qty, 1_000_000);
near('the ADD leg carries its own price', partial.legs[1].price, 0.00003, 1e-12);
near('the REDUCE leg carries its own quantity', partial.legs[2].qty, 1_500_000);
ok('every leg names its signature', partial.legs.every((l) => typeof l.signature === 'string' && l.signature.length > 0));
ok('all three signatures are attached', partial.signatures.length === 3);
ok('partial exit stays VERIFIED', partial.dataConfidence === CONFIDENCE.VERIFIED,
  JSON.stringify(partial.confidenceReasons));

// Selling the rest must close it out with the remaining lot-B basis:
//   (0.00005 - 0.00003) x 500,000 = 10, on top of the 35 already realized.
const fifoClosed = await run([
  buyBonk({ signature: 'sig-lot-a', hoursAfterT0: 0, usdcSpent: 10, bonkReceived: 1_000_000, bonkStart: 0 }),
  buyBonk({ signature: 'sig-lot-b', hoursAfterT0: 1, usdcSpent: 30, bonkReceived: 1_000_000, usdcStart: 9_990, bonkStart: 1_000_000 }),
  sellBonk({ signature: 'sig-partial', hoursAfterT0: 2, bonkSold: 1_500_000, usdcReceived: 60, bonkStart: 2_000_000 }),
  sellBonk({ signature: 'sig-final', hoursAfterT0: 3, bonkSold: 500_000, usdcReceived: 25, bonkStart: 500_000, usdcStart: 60 })
]);
ok('the full sequence still forms one trade', fifoClosed.trades.length === 1);
ok('the trade is CLOSED once flat', fifoClosed.trades[0].status === 'CLOSED');
near('cumulative FIFO realized P&L is +45 USD', fifoClosed.trades[0].realizedPnl, 45, 1e-6);
ok('legs are OPEN, ADD, REDUCE, CLOSE',
  fifoClosed.trades[0].legs.map((l) => l.kind).join(',') === 'OPEN,ADD,REDUCE,CLOSE',
  fifoClosed.trades[0].legs.map((l) => l.kind).join(','));

// Re-opening the same asset after a flat close must start a NEW trade record.
const reopened = await run([
  buyBonk({ signature: 'sig-r1', hoursAfterT0: 0, usdcSpent: 100, bonkReceived: 5_000_000 }),
  sellBonk({ signature: 'sig-r2', hoursAfterT0: 1, bonkSold: 5_000_000, usdcReceived: 150, bonkStart: 5_000_000 }),
  buyBonk({ signature: 'sig-r3', hoursAfterT0: 2, usdcSpent: 80, bonkReceived: 2_000_000, bonkStart: 0 })
]);
ok('a re-entry after flat becomes a separate trade', reopened.trades.length === 2, `got ${reopened.trades.length}`);
ok('the two trades have different ids', reopened.trades[0].id !== reopened.trades[1].id);

/* ======================================================================
 * 7. UNDECODABLE TRANSACTIONS -> NEEDS_REVIEW, NEVER A GUESS
 * ==================================================================== */
section('7. Undecodable transactions are flagged, never guessed');

const opaque = await run([
  tx({ signature: 'sig-opaque', hoursAfterT0: 0, programs: [JUP_V6], omitMeta: true })
]);

ok('an opaque Jupiter transaction still surfaces as a trade', opaque.trades.length === 1);
const review = opaque.trades[0];
ok('it is NEEDS_REVIEW', review.dataConfidence === CONFIDENCE.NEEDS_REVIEW, review.dataConfidence);
ok('entry is null, not guessed', review.entry === null);
ok('exit is null, not guessed', review.exit === null);
ok('quantity is null, not guessed', review.quantity === null);
ok('notional is null, not guessed', review.notional === null);
ok('realized P&L is null, not guessed', review.realizedPnl === null);
ok('it explains why', review.confidenceReasons.length > 0, JSON.stringify(review.confidenceReasons));
ok('NEEDS_REVIEW is excluded from stats realized P&L', opaque.stats.realizedPnl === null);
ok('stats count it as needing review', opaque.stats.needsReviewCount === 1);

// A token-to-token swap with no quote asset on either side is ambiguous, not
// a coin flip. It must not be assigned a direction or a price.
const ambiguous = await run([
  tx({
    signature: 'sig-tok2tok',
    hoursAfterT0: 0,
    tokens: [
      { mint: BONK, decimals: 5, pre: 100_000_000, post: 0 },
      { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', decimals: 6, pre: 0, post: 250_000_000 }
    ]
  })
]);
ok('token-to-token swap is NEEDS_REVIEW', ambiguous.trades[0].dataConfidence === CONFIDENCE.NEEDS_REVIEW);
ok('token-to-token swap has no invented price', ambiguous.trades[0].entry === null);
ok('token-to-token swap has no invented direction', ambiguous.trades[0].direction === null);

// A non-Jupiter transaction we cannot decode is a warning, not a phantom trade.
const strayOpaque = await run([
  tx({ signature: 'sig-stray', hoursAfterT0: 0, programs: [SYSTEM_PROGRAM], omitMeta: true })
]);
ok('an undecodable non-Jupiter transaction does not become a trade', strayOpaque.trades.length === 0);
ok('it is reported as a warning instead', strayOpaque.warnings.some((w) => w.startsWith('UNDECODABLE_TX')));

/* ======================================================================
 * 8. PERPETUALS — flagged, never fabricated
 * ==================================================================== */
section('8. Jupiter Perpetuals are flagged, never fabricated');

const perps = await run([perpTx]);
ok('perp activity produces a record', perps.trades.length === 1);

const perp = perps.trades[0];
ok('perp record kind is PERP', perp.kind === 'PERP');
ok('perp record is NEEDS_REVIEW', perp.dataConfidence === CONFIDENCE.NEEDS_REVIEW);
ok('perp entry is null', perp.entry === null);
ok('perp leverage is null', perp.leverage === null);
ok('perp quantity is null', perp.quantity === null);
ok('perp direction is null', perp.direction === null);
ok('perp realized P&L is null', perp.realizedPnl === null);
near('perp collateral movement is recorded (500 USDC left the wallet)', perp.collateral, 500, 1e-6);
ok('perp record says its status is not actually known', perp.meta.statusKnown === false);
ok('perp record explains the limitation', perp.confidenceReasons.length >= 2);
ok('perps are excluded from stats realized P&L', perps.stats.realizedPnl === null);
ok('stats count the perp', perps.stats.perpCount === 1);

const perpsOmitted = await run([perpTx], { perpsMode: 'OMIT' });
ok('perpsMode OMIT drops the record', perpsOmitted.trades.length === 0);
ok('perpsMode OMIT still warns', perpsOmitted.warnings.some((w) => w.startsWith('PERP_OMITTED')));

/* ======================================================================
 * 9. DEPOSITS AND WITHDRAWALS — candidates only
 * ==================================================================== */
section('9. Transfers become unclassified candidate cash flows');

const flows = await run([
  depositTx,
  withdrawalTx,
  buyBonk({ signature: 'sig-with-flows', hoursAfterT0: 3, usdcSpent: 100, bonkReceived: 5_000_000 })
]);

ok('two cash-flow candidates are found', flows.cashFlows.length === 2, `got ${flows.cashFlows.length}`);

const deposit = flows.cashFlows.find((f) => f.type === 'DEPOSIT');
const withdrawal = flows.cashFlows.find((f) => f.type === 'WITHDRAWAL');

ok('the incoming transfer is a DEPOSIT candidate', Boolean(deposit));
ok('the outgoing transfer is a WITHDRAWAL candidate', Boolean(withdrawal));
ok('the deposit is NOT auto-classified', deposit.classified === false);
ok('the withdrawal is NOT auto-classified', withdrawal.classified === false);
near('the deposit records 2 SOL', deposit.movements[0].amount, 2, 1e-9);
ok('the deposit names the SOL mint', deposit.movements[0].mint === SOL_MINT);
near('the withdrawal records 300 USDC', withdrawal.movements[0].amount, 300, 1e-6);
ok('cash flows carry a stable id', typeof deposit.id === 'string' && deposit.id.startsWith('flow-'));

ok('transfers are NOT counted as trades', flows.trades.length === 1, `got ${flows.trades.length} trades`);
ok('the only trade is the actual swap', flows.trades[0].assetMint === BONK);
ok('stats count the cash-flow candidates', flows.stats.cashFlowCandidates === 2);
ok('stats trade count excludes transfers', flows.stats.tradeCount === 1);

/* ======================================================================
 * 10. IDEMPOTENCE
 * ==================================================================== */
section('10. Reconstruction is idempotent');

const idemInput = [
  buyBonk({ signature: 'sig-i1', hoursAfterT0: 0, usdcSpent: 10, bonkReceived: 1_000_000 }),
  buyBonk({ signature: 'sig-i2', hoursAfterT0: 1, usdcSpent: 30, bonkReceived: 1_000_000, usdcStart: 9_990, bonkStart: 1_000_000 }),
  sellBonk({ signature: 'sig-i3', hoursAfterT0: 2, bonkSold: 1_500_000, usdcReceived: 60, bonkStart: 2_000_000 }),
  depositTx,
  perpTx
];

const runA = await run(idemInput);
const runB = await run(idemInput);

ok('two runs produce identical trade ids',
  JSON.stringify(runA.trades.map((t) => t.id)) === JSON.stringify(runB.trades.map((t) => t.id)));
ok('two runs produce byte-identical trades', JSON.stringify(runA.trades) === JSON.stringify(runB.trades));
ok('two runs produce byte-identical cash flows', JSON.stringify(runA.cashFlows) === JSON.stringify(runB.cashFlows));
ok('two runs produce byte-identical stats', JSON.stringify(runA.stats) === JSON.stringify(runB.stats));

// Input order must not change the result — ordering is by blockTime, not array
// position, so a differently-paged RPC response reconstructs the same way.
const shuffled = await run([...idemInput].reverse());
ok('reversed input yields the same trade ids',
  JSON.stringify(runA.trades.map((t) => t.id).sort()) ===
  JSON.stringify(shuffled.trades.map((t) => t.id).sort()));
near('reversed input yields the same realized P&L', shuffled.trades.find((t) => t.assetMint === BONK).realizedPnl, 35, 1e-6);

ok('trade ids are derived from the opening signature',
  runA.trades.find((t) => t.assetMint === BONK).id === makeTradeId('SPOT', BONK, 'sig-i1'));
ok('makeTradeId is a pure function of its inputs',
  makeTradeId('SPOT', BONK, 'sig-i1') === makeTradeId('SPOT', BONK, 'sig-i1'));
ok('different signatures yield different ids',
  makeTradeId('SPOT', BONK, 'sig-i1') !== makeTradeId('SPOT', BONK, 'sig-i2'));

/* ======================================================================
 * 11. OVERRIDES — layered, never destructive
 * ==================================================================== */
section('11. User corrections layer over authoritative on-chain data');

const baseTrade = roundTrip.trades[0];        // VERIFIED, entry 0.00002, realized +50
const corrected = applyOverrides(baseTrade, { entry: 0.000025, fees: 1.25 });

near('the on-chain entry is untouched on the record', corrected.entry, 0.00002, 1e-12);
ok('the correction is stored separately', corrected.overrides.entry === 0.000025);
ok('the original record is not mutated', baseTrade.overrides.entry === undefined);

const view = resolveTrade(corrected);
near('the resolved view shows the corrected entry', view.entry, 0.000025, 1e-12);
near('the resolved view preserves the on-chain entry', view.onchain.entry, 0.00002, 1e-12);
ok('the resolved view lists which fields were overridden',
  view.overriddenFields.includes('entry') && view.overriddenFields.includes('fees'));
ok('provenance stays ONCHAIN after a correction', view.source === 'ONCHAIN');

ok('a correction that contradicts decoded data is flagged', view.hasConflicts === true);
const entryConflict = view.conflicts.find((c) => c.field === 'entry');
ok('the conflict names the field', Boolean(entryConflict));
near('the conflict reports the on-chain value', entryConflict.onchainValue, 0.00002, 1e-12);
near('the conflict reports the override value', entryConflict.overrideValue, 0.000025, 1e-12);
ok('contradicting VERIFIED data is HIGH severity', entryConflict.severity === 'HIGH');

// Filling a gap the chain left null is not a conflict.
ok('overriding a null on-chain field is not a conflict',
  !view.conflicts.some((c) => c.field === 'fees'));

// Correcting an inferred (NEEDS_REVIEW) field is low severity, not high.
const reviewCorrected = resolveTrade(applyOverrides(review, { entry: 1.5, quantity: 10 }));
ok('correcting NEEDS_REVIEW nulls creates no conflict', reviewCorrected.hasConflicts === false);
near('the corrected view shows the user value', reviewCorrected.entry, 1.5);
ok('the on-chain snapshot still shows null', reviewCorrected.onchain.entry === null);

// Overrides must re-attach to the same record on a fresh reconstruction.
const rerun = await run([
  buyBonk({ signature: 'sig-buy-2', hoursAfterT0: 0, usdcSpent: 100, bonkReceived: 5_000_000 }),
  sellBonk({ signature: 'sig-sell-2', hoursAfterT0: 5, bonkSold: 5_000_000, usdcReceived: 150, bonkStart: 5_000_000 })
]);
ok('a re-run yields the same id, so corrections re-attach', rerun.trades[0].id === baseTrade.id);

// Unknown fields are refused rather than silently written.
const bogus = applyOverrides(baseTrade, { signatures: ['forged'], id: 'forged' });
ok('non-overridable fields are rejected', bogus.overrides.signatures === undefined && bogus.overrides.id === undefined);
ok('rejected overrides are reported', (bogus.meta.rejectedOverrides || []).length === 2);
ok('the signature list is untouched', JSON.stringify(bogus.signatures) === JSON.stringify(baseTrade.signatures));
ok('detectOverrideConflicts on a clean trade returns nothing', detectOverrideConflicts(baseTrade).length === 0);

/* ======================================================================
 * 12. NON-STABLE QUOTE -> PARTIAL, AND UNPRICED -> NEEDS_REVIEW
 *
 * Sell 10 SOL for 1,000,000 BONK, i.e. buy BONK quoted in SOL.
 * At SOL = 150 USD the fill is 1,500 USD for 1,000,000 BONK -> 0.0015.
 * ==================================================================== */
section('12. Non-stable quote assets degrade to PARTIAL, never to a guess');

const solQuoted = [
  tx({
    signature: 'sig-sol-quote',
    hoursAfterT0: 0,
    solPre: 20_000_000_000,
    solPost: 10_000_000_000,
    tokens: [{ mint: BONK, decimals: 5, pre: 0, post: 100_000_000_000 }]
  })
];

const priced = await run(solQuoted, { priceResolver: async (mint) => (mint === SOL_MINT ? 150 : null) });
ok('a SOL-quoted swap produces a trade', priced.trades.length === 1);
near('entry converts at the supplied SOL price', priced.trades[0].entry, 0.0015, 1e-9);
ok('an externally-priced fill is PARTIAL, not VERIFIED',
  priced.trades[0].dataConfidence === CONFIDENCE.PARTIAL, priced.trades[0].dataConfidence);
ok('the reason names the external price feed',
  priced.trades[0].confidenceReasons.some((r) => r.includes('external price feed')));

const unpriced = await run(solQuoted);   // no resolver at all
ok('with no price feed the trade still appears', unpriced.trades.length === 1);
ok('with no price feed it is NEEDS_REVIEW', unpriced.trades[0].dataConfidence === CONFIDENCE.NEEDS_REVIEW);
ok('with no price feed entry stays null rather than being estimated', unpriced.trades[0].entry === null);
near('quantity is still exact — it is on-chain', unpriced.trades[0].quantity, 1_000_000, 1e-6);

// A price resolver that throws must not take the whole reconstruction down.
const brokenResolver = await run(solQuoted, {
  priceResolver: async () => { throw new Error('price API 503'); }
});
ok('a failing price resolver does not throw', brokenResolver.trades.length === 1);
ok('a failing price resolver is reported', brokenResolver.warnings.some((w) => w.startsWith('PRICE_RESOLVER_FAILED')));
ok('a failing price resolver leaves entry null', brokenResolver.trades[0].entry === null);

/* ======================================================================
 * 13. UNMATCHED SELL — cost basis outside the window
 * ==================================================================== */
section('13. A sell with no visible buy is not scored');

const orphanSell = await run([
  sellBonk({ signature: 'sig-orphan', hoursAfterT0: 0, bonkSold: 1_000_000, usdcReceived: 40, bonkStart: 1_000_000 })
]);

ok('the sell is recorded', orphanSell.trades.length === 1);
ok('realized P&L is null, not computed against a zero basis', orphanSell.trades[0].realizedPnl === null);
ok('it is NEEDS_REVIEW', orphanSell.trades[0].dataConfidence === CONFIDENCE.NEEDS_REVIEW);
ok('a warning explains the missing basis', orphanSell.warnings.some((w) => w.startsWith('UNMATCHED_SELL')));
ok('stats exclude it from realized P&L', orphanSell.stats.realizedPnl === null);

/* ======================================================================
 * 14. NO-INPUT AND FAILED-RPC BEHAVIOUR
 * ==================================================================== */
section('14. Missing inputs degrade honestly');

const noAddress = await reconstructTrades({ transactions: [], address: null });
ok('reconstruction without an address returns no trades', noAddress.trades.length === 0);
ok('reconstruction without an address says why', noAddress.warnings.some((w) => w.startsWith('NO_ADDRESS')));

const noTx = await run([]);
ok('an empty history yields no trades', noTx.trades.length === 0);
ok('an empty history yields null realized P&L, not zero', noTx.stats.realizedPnl === null);

const onlyFailed = await run([failedTx]);
ok('a failed transaction produces no trade', onlyFailed.trades.length === 0);
ok('a failed transaction produces no cash flow', onlyFailed.cashFlows.length === 0);

/* ----------------------------------------------------------------------
 * A failing RPC must yield complete:false and NEVER a fabricated balance.
 *
 * The connection is injected rather than the network being broken, so this
 * runs offline. Every method rejects, which is what an unreachable or
 * rate-limited RPC looks like to the reader after its retries are spent.
 * -------------------------------------------------------------------- */
section('15. A failing RPC yields complete:false, never a fabricated balance');

const walletReader = await import('../services/solanaWalletReader.js');

const failing = () => Promise.reject(new Error('fetch failed: ECONNREFUSED'));
const deadConnection = {
  getBalance: failing,
  getParsedTokenAccountsByOwner: failing,
  getSignaturesForAddress: failing,
  getParsedTransactions: failing
};

walletReader.clearCache();
const downPortfolio = await walletReader.getWalletPortfolio(WALLET, {
  forceRefresh: true,
  connection: deadConnection
});

ok('a failing RPC gives complete:false', downPortfolio.complete === false);
ok('a failing RPC gives a null SOL balance, not 0', downPortfolio.solBalance === null);
ok('a failing RPC gives a null total, not 0', downPortfolio.totalUsdValue === null);
ok('a failing RPC returns no fabricated holdings', downPortfolio.tokens.length === 0);
ok('a failing RPC says why', downPortfolio.warnings.some((w) => w.startsWith('RPC_UNAVAILABLE')),
  JSON.stringify(downPortfolio.warnings));

const downSigs = await walletReader.getSignatures(WALLET, { maxSignatures: 10, connection: deadConnection });
ok('a failing RPC gives no signatures', downSigs.signatures.length === 0);
ok('a failing RPC marks signatures incomplete', downSigs.complete === false);
ok('a failing RPC explains the signature failure', downSigs.warnings.some((w) => w.startsWith('RPC_UNAVAILABLE')));

const downActivity = await walletReader.getWalletActivity(WALLET, { maxTransactions: 10, connection: deadConnection });
ok('a failing RPC gives no activity', downActivity.transactions.length === 0);
ok('a failing RPC marks activity incomplete', downActivity.complete === false);

// Reconstruction over an empty, incomplete fetch must not invent trades.
const downReconstruction = await run(downActivity.transactions);
ok('no trades are reconstructed from a failed fetch', downReconstruction.trades.length === 0);
ok('realized P&L stays null after a failed fetch', downReconstruction.stats.realizedPnl === null);

walletReader.clearCache();

// An invalid address must never reach the RPC at all.
const badAddressPortfolio = await walletReader.getWalletPortfolio('not-an-address');
ok('an invalid address gives complete:false', badAddressPortfolio.complete === false);
ok('an invalid address gives a null balance', badAddressPortfolio.solBalance === null);
ok('an invalid address is named as the reason',
  badAddressPortfolio.warnings.some((w) => w.startsWith('INVALID_ADDRESS')));

/* ======================================================================
 * 16. matchLots INVARIANT SWEEP
 * ==================================================================== */
section('16. FIFO invariants across generated sequences');

let sweepFailures = 0;
let sweepCount = 0;

for (const buyPrices of [[1, 2], [2, 1], [5, 5], [0.5, 4]]) {
  for (const sellPrice of [0.25, 1, 3, 10]) {
    for (const sellQty of [50, 100, 150, 200]) {
      const fills = [
        { assetMint: BONK, assetDecimals: 5, side: 'BUY', quantity: 100, price: buyPrices[0], confidence: CONFIDENCE.VERIFIED, reasons: [], at: new Date((T0 + 0) * 1000).toISOString(), signature: 's1', feeLamports: 5000 },
        { assetMint: BONK, assetDecimals: 5, side: 'BUY', quantity: 100, price: buyPrices[1], confidence: CONFIDENCE.VERIFIED, reasons: [], at: new Date((T0 + HOUR) * 1000).toISOString(), signature: 's2', feeLamports: 5000 },
        { assetMint: BONK, assetDecimals: 5, side: 'SELL', quantity: sellQty, price: sellPrice, confidence: CONFIDENCE.VERIFIED, reasons: [], at: new Date((T0 + 2 * HOUR) * 1000).toISOString(), signature: 's3', feeLamports: 5000 }
      ];

      const { trades } = matchLots(fills);
      sweepCount++;

      if (trades.length !== 1) { sweepFailures++; continue; }
      const trade = trades[0];

      // Independent FIFO recomputation, written out longhand.
      let remaining = sellQty;
      let expected = 0;
      const lots = [{ q: 100, p: buyPrices[0] }, { q: 100, p: buyPrices[1] }];
      for (const lot of lots) {
        if (remaining <= 0) break;
        const matchedQty = Math.min(remaining, lot.q);
        expected += (sellPrice - lot.p) * matchedQty;
        remaining -= matchedQty;
      }

      const openQty = Math.max(0, 200 - sellQty);
      const shouldBeClosed = openQty === 0;

      if (shouldBeClosed !== (trade.status === 'CLOSED')) { sweepFailures++; continue; }
      if (Math.abs(trade.realizedPnl - expected) > 1e-9) { sweepFailures++; continue; }
      if (trade.status === 'OPEN' && Math.abs(trade.quantity - openQty) > 1e-9) { sweepFailures++; continue; }
      // Legs must always account for every fill.
      if (trade.legs.length !== 3) { sweepFailures++; continue; }
      // Average entry is always the VWAP of the two buys.
      if (Math.abs(trade.entry - (buyPrices[0] + buyPrices[1]) / 2) > 1e-9) sweepFailures++;
    }
  }
}

ok(`all ${sweepCount} generated FIFO sequences hold their invariants`, sweepFailures === 0, `${sweepFailures} failed`);

/* ====================================================================== */

console.log(`\n${'='.repeat(62)}`);
console.log(failures === 0
  ? `All ${assertions} assertions passed.`
  : `${failures} of ${assertions} assertions FAILED.`);
console.log('NOTE: fixture-driven, zero network. Not validated against live mainnet.');
console.log(`${'='.repeat(62)}\n`);

process.exit(failures === 0 ? 0 : 1);
