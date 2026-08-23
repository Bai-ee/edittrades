/**
 * Jupiter Trade Reconstruction.
 *
 * Turns parsed Solana transactions for ONE observed address into trade records.
 * Pure and dependency-free: no imports, no network, no clock reads except the
 * `at` stamps that come from the transactions themselves. Everything it knows
 * comes from the `transactions` array it is handed, which is what makes the
 * fixture harness able to pin its behaviour exactly.
 *
 * The governing rule is that a missing number stays missing. There is no
 * estimation path in this file. If entry price cannot be derived from decoded
 * on-chain data, `entry` is `null` and `dataConfidence` says why. A wrong
 * P&L figure in a trading journal is worse than an absent one, because the
 * absent one is visibly absent.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS RELIABLE AND WHAT IS NOT — read this before trusting the output
 * ---------------------------------------------------------------------------
 *
 * RELIABLE (dataConfidence: 'VERIFIED')
 *   Spot swaps settled against a stablecoin. The owner's net token balance
 *   deltas come from `meta.preTokenBalances` / `meta.postTokenBalances`, which
 *   the validator itself produced. Quantity, entry price, exit price and
 *   realized P&L are then arithmetic over those deltas. Nothing is inferred.
 *
 * PARTIAL
 *   Spot swaps settled against SOL or another non-stable quote asset. The
 *   token ratio is on-chain; converting it to USD needs an external price at
 *   that block, which is an input this module did not observe. Also swaps
 *   where account-rent movements forced a "largest delta is the real leg"
 *   choice.
 *
 * NEEDS_REVIEW
 *   Jupiter Perpetuals activity, and any Jupiter transaction whose balance
 *   data could not be decoded. See PERPETUALS below.
 *
 * ---------------------------------------------------------------------------
 * PERPETUALS — the honest answer
 * ---------------------------------------------------------------------------
 * Jupiter Perpetuals positions CANNOT be reconstructed from the data this
 * module can reach. Not "not yet" — not from these inputs. Concretely:
 *
 *   1. The perps program is an Anchor program. `getParsedTransaction` only
 *      decodes native programs (System, SPL Token, Stake, Vote). For any other
 *      program the RPC hands back raw base58 instruction data. Side, size,
 *      leverage, entry price and collateral all live inside that opaque blob.
 *      Decoding it needs the program IDL, which this repo does not carry.
 *
 *   2. Even with the IDL, a single signature is not a fill. Jupiter Perps is
 *      request/fulfil: the trader submits an increase or decrease *request*,
 *      and a keeper executes it in a *separate* transaction that the trader's
 *      address does not sign — so it never appears in
 *      `getSignaturesForAddress(trader)`. Reconstructing from the trader's
 *      signatures alone systematically misses the executions.
 *
 *   3. Position state (size, entry, collateral, accrued funding) lives in a
 *      program-owned Position account, not in the trader's token balances.
 *      Reading it needs `getAccountInfo` plus the account layout from the IDL,
 *      and reading it *now* tells you nothing about entry six weeks ago.
 *
 * What this module does instead: it detects that a transaction touched the
 * perps program — that much IS an on-chain fact — records the owner's
 * collateral token movement, and emits a NEEDS_REVIEW stub with every derived
 * numeric field null. Those stubs are excluded from `stats.realizedPnl`.
 *
 * To do perps properly you need one of: (a) the Jupiter Perpetuals IDL plus an
 * indexer that follows the keeper's fulfilment transactions, or (b) a
 * third-party position-history API. Both are outside V1's read-only scope.
 */

/* ------------------------------------------------------------------ *
 * Program identifiers
 * ------------------------------------------------------------------ */

/** Jupiter aggregator program IDs across versions. v6 is current. */
export const JUPITER_SWAP_PROGRAM_IDS = Object.freeze([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // v6
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // v4
  'JUP3c2Uh3WA4Ng34tw6kPd2G4C5BB21Xo36Je1s32Ph', // v3
  'JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uJvfo'  // v2
]);

/** Jupiter Perpetuals. Detected, never decoded — see the header. */
export const JUPITER_PERPS_PROGRAM_ID = 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu';

/** Limit orders and DCA settle as swaps but through their own programs. */
export const JUPITER_ANCILLARY_PROGRAM_IDS = Object.freeze([
  'jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu', // Limit Order v1
  'j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X', // Limit Order v2
  'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M' // DCA
]);

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_DECIMALS = 9;

/**
 * Mints whose USD price is 1.00 by construction. A swap with one of these on
 * one side yields a USD price with no external price feed involved, which is
 * the only way a trade reaches VERIFIED.
 */
export const STABLE_MINTS = Object.freeze({
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA: 'USDS',
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': 'PYUSD'
});

/**
 * Assets that count as the "quote" side of a pair when no stablecoin is
 * present. SOL is the de facto quote for most Solana pairs.
 */
export const QUOTE_MINTS = Object.freeze([...Object.keys(STABLE_MINTS), SOL_MINT]);

/**
 * Lot-matching policy. FIFO: the oldest open lot is consumed first by a sell.
 *
 * Stated explicitly and exported because it changes reported P&L. FIFO is the
 * default for crypto tax treatment in most jurisdictions and is the only
 * policy implemented; LIFO/HIFO would each produce different realized numbers
 * from identical on-chain data, so the number is only meaningful alongside
 * this label. Every trade record carries `lotPolicy` for that reason.
 */
export const LOT_MATCHING_POLICY = 'FIFO';

export const CONFIDENCE = Object.freeze({
  VERIFIED: 'VERIFIED',
  PARTIAL: 'PARTIAL',
  NEEDS_REVIEW: 'NEEDS_REVIEW'
});

/** Below this share of a position, "flat" is flat — floating-point residue. */
const DUST_RATIO = 1e-9;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

export function isJupiterSwapProgram(programId) {
  return JUPITER_SWAP_PROGRAM_IDS.includes(programId) || JUPITER_ANCILLARY_PROGRAM_IDS.includes(programId);
}

export function isStableMint(mint) {
  return Object.prototype.hasOwnProperty.call(STABLE_MINTS, mint);
}

export function isQuoteMint(mint) {
  return QUOTE_MINTS.includes(mint);
}

function toNumber(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

/** FNV-1a, for short stable ids. Not cryptographic — collision-resistant
 *  enough for de-duplicating trades within one wallet's history. */
function shortHash(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Every program id touched by a transaction, outer and inner instructions. */
export function collectProgramIds(tx) {
  const ids = new Set();
  const push = (instruction) => {
    const id = instruction?.programId;
    if (!id) return;
    ids.add(typeof id === 'string' ? id : id.toBase58?.() ?? String(id));
  };

  for (const instruction of tx?.transaction?.message?.instructions || []) push(instruction);
  for (const inner of tx?.meta?.innerInstructions || []) {
    for (const instruction of inner?.instructions || []) push(instruction);
  }
  return [...ids];
}

function accountKeyStrings(tx) {
  return (tx?.transaction?.message?.accountKeys || []).map((key) => {
    if (typeof key === 'string') return key;
    const pubkey = key?.pubkey;
    if (!pubkey) return null;
    return typeof pubkey === 'string' ? pubkey : pubkey.toBase58?.() ?? String(pubkey);
  });
}

function signatureOf(tx) {
  return tx?.transaction?.signatures?.[0] || tx?.signature || null;
}

function timestampOf(tx) {
  const blockTime = tx?.blockTime;
  return Number.isFinite(blockTime) ? new Date(blockTime * 1000).toISOString() : null;
}

/**
 * Net balance change per mint for the observed owner.
 *
 * Native lamports are folded into the wSOL mint, because Jupiter routes wrap
 * and unwrap SOL transparently — treating native SOL and wSOL as two assets
 * would show a phantom leg on every SOL-quoted swap. The transaction fee is
 * added back so that "SOL left the wallet" means trading, not gas.
 *
 * @returns {{ deltas: Map<string, object>, feeLamports: number|null, decoded: boolean, reason: string|null }}
 */
export function computeOwnerDeltas(tx, address) {
  const meta = tx?.meta;
  if (!meta) {
    return { deltas: new Map(), feeLamports: null, decoded: false, reason: 'transaction has no meta block' };
  }

  const keys = accountKeyStrings(tx);
  const ownerIndex = keys.indexOf(address);
  const feeLamports = toNumber(meta.fee);

  const deltas = new Map();
  const bump = (mint, decimals, rawDelta) => {
    const existing = deltas.get(mint);
    if (existing) {
      existing.raw += rawDelta;
      existing.amount = existing.raw / 10 ** existing.decimals;
    } else {
      deltas.set(mint, {
        mint,
        decimals,
        raw: rawDelta,
        amount: rawDelta / 10 ** decimals
      });
    }
  };

  // --- SPL token balances -------------------------------------------------
  const pre = new Map();
  const post = new Map();
  const decimalsByMint = new Map();

  const index = (entries, into) => {
    for (const entry of entries || []) {
      if (!entry || entry.owner !== address) continue;
      const mint = entry.mint;
      const amountInfo = entry.uiTokenAmount || {};
      const raw = toNumber(amountInfo.amount);
      const decimals = toNumber(amountInfo.decimals);
      if (raw === null || decimals === null) continue;
      decimalsByMint.set(mint, decimals);
      // One owner can hold several accounts for the same mint; sum them.
      into.set(mint, (into.get(mint) || 0) + raw);
    }
  };

  index(meta.preTokenBalances, pre);
  index(meta.postTokenBalances, post);

  const hadTokenBalanceData =
    Array.isArray(meta.preTokenBalances) && Array.isArray(meta.postTokenBalances);

  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const delta = (post.get(mint) || 0) - (pre.get(mint) || 0);
    if (delta === 0) continue;
    bump(mint, decimalsByMint.get(mint) ?? 0, delta);
  }

  // --- Native SOL ---------------------------------------------------------
  let nativeDecoded = false;
  if (ownerIndex >= 0 && Array.isArray(meta.preBalances) && Array.isArray(meta.postBalances)) {
    const before = toNumber(meta.preBalances[ownerIndex]);
    const after = toNumber(meta.postBalances[ownerIndex]);
    if (before !== null && after !== null) {
      nativeDecoded = true;
      const isFeePayer = ownerIndex === 0;
      const raw = after - before + (isFeePayer && feeLamports !== null ? feeLamports : 0);
      if (raw !== 0) bump(SOL_MINT, SOL_DECIMALS, raw);
    }
  }

  const decoded = hadTokenBalanceData || nativeDecoded;
  return {
    deltas,
    feeLamports,
    decoded,
    reason: decoded ? null : 'no token balance arrays and owner not present in accountKeys'
  };
}

/* ------------------------------------------------------------------ *
 * classifySwap
 * ------------------------------------------------------------------ */

/**
 * Identify what one transaction did for the observed owner.
 *
 * @param {object} tx        parsed transaction (getParsedTransaction shape)
 * @param {string} address   observed owner
 * @returns {{kind: string, ...}} kind is one of:
 *   SWAP           — one mint out, one mint in
 *   PERP_ACTIVITY  — touched the perps program; not decodable (see header)
 *   TRANSFER_IN    — value arrived with nothing leaving
 *   TRANSFER_OUT   — value left with nothing arriving
 *   FAILED         — the transaction errored; it moved nothing
 *   UNDECODABLE    — balance data missing or unusable
 *   UNKNOWN        — decoded, but the delta pattern is not a swap or transfer
 */
export function classifySwap(tx, address) {
  const signature = signatureOf(tx);
  const at = timestampOf(tx);
  const programs = collectProgramIds(tx);
  const viaJupiter = programs.some(isJupiterSwapProgram);
  const viaPerps = programs.includes(JUPITER_PERPS_PROGRAM_ID);

  const base = { signature, at, slot: tx?.slot ?? null, programs, viaJupiter, viaPerps };

  if (tx?.meta?.err) {
    return { ...base, kind: 'FAILED', reason: 'transaction failed on-chain; no balances moved' };
  }

  const { deltas, feeLamports, decoded, reason } = computeOwnerDeltas(tx, address);
  const withFee = { ...base, feeLamports };

  if (!decoded) {
    return { ...withFee, kind: 'UNDECODABLE', reason };
  }

  const moves = [...deltas.values()];
  const inbound = moves.filter((m) => m.raw > 0).sort((a, b) => Math.abs(b.raw) - Math.abs(a.raw));
  const outbound = moves.filter((m) => m.raw < 0).sort((a, b) => Math.abs(b.raw) - Math.abs(a.raw));

  if (viaPerps) {
    return {
      ...withFee,
      kind: 'PERP_ACTIVITY',
      inbound,
      outbound,
      reason:
        'Jupiter Perpetuals instruction data is Anchor-encoded and was not decoded; ' +
        'side, size, leverage and entry are not derivable from this transaction'
    };
  }

  if (inbound.length === 0 && outbound.length === 0) {
    return { ...withFee, kind: 'UNKNOWN', reason: 'no net balance change for the observed owner' };
  }

  // --- Swap ---------------------------------------------------------------
  if (inbound.length >= 1 && outbound.length >= 1) {
    const received = inbound[0];
    const sent = outbound[0];

    // Extra legs are almost always account rent (creating an ATA moves ~0.002
    // SOL) rather than a second trade leg. Taking the largest magnitude as the
    // real leg is an inference, so it is surfaced and downgrades confidence.
    const incidental = [...inbound.slice(1), ...outbound.slice(1)];

    return {
      ...withFee,
      kind: 'SWAP',
      received,
      sent,
      incidental,
      ambiguousLegs: incidental.length > 0,
      reason: null
    };
  }

  // --- Transfer -----------------------------------------------------------
  if (inbound.length >= 1) {
    return { ...withFee, kind: 'TRANSFER_IN', moves: inbound, reason: null };
  }
  return { ...withFee, kind: 'TRANSFER_OUT', moves: outbound, reason: null };
}

/* ------------------------------------------------------------------ *
 * Pricing a swap
 * ------------------------------------------------------------------ */

/**
 * Work out which side of a swap is the traded asset and what it cost.
 *
 * Returns a normalised "fill": `{ assetMint, side, quantity, quoteMint,
 * quoteAmount, price, priceBasis, confidence, reasons }`.
 *
 * `price` is USD per unit of asset when it can be derived honestly:
 *   - stable quote  -> exact, from the swap itself         (priceBasis QUOTE_STABLE)
 *   - other quote   -> needs an external USD price for the quote asset
 *                      (priceBasis QUOTE_CONVERTED, confidence PARTIAL)
 *   - neither       -> null                                (NEEDS_REVIEW)
 */
function describeFill(classified, quotePriceUsd) {
  const { received, sent } = classified;
  const reasons = [];
  let confidence = CONFIDENCE.VERIFIED;

  if (classified.ambiguousLegs) {
    confidence = CONFIDENCE.PARTIAL;
    reasons.push(
      `swap had ${classified.incidental.length} extra balance leg(s) (likely account rent); ` +
      'the largest inbound and outbound legs were taken as the trade'
    );
  }

  const sentIsQuote = isQuoteMint(sent.mint);
  const receivedIsQuote = isQuoteMint(received.mint);

  let assetLeg;
  let quoteLeg;
  let side;

  if (sentIsQuote && !receivedIsQuote) {
    assetLeg = received; quoteLeg = sent; side = 'BUY';
  } else if (receivedIsQuote && !sentIsQuote) {
    assetLeg = sent; quoteLeg = received; side = 'SELL';
  } else if (sentIsQuote && receivedIsQuote) {
    // Quote-to-quote, e.g. USDC -> SOL. Treat the non-stable side as the
    // asset; a stable-to-stable hop is a conversion, not a trade.
    if (isStableMint(sent.mint) && !isStableMint(received.mint)) {
      assetLeg = received; quoteLeg = sent; side = 'BUY';
    } else if (isStableMint(received.mint) && !isStableMint(sent.mint)) {
      assetLeg = sent; quoteLeg = received; side = 'SELL';
    } else {
      return {
        kind: 'CONVERSION',
        reasons: ['stablecoin-to-stablecoin swap; recorded as a conversion, not a trade']
      };
    }
  } else {
    // Token-to-token with no quote asset on either side. Which one is "the
    // trade" is genuinely ambiguous, so neither is asserted.
    return {
      kind: 'AMBIGUOUS',
      reasons: [
        `token-to-token swap (${sent.mint} -> ${received.mint}) with no quote asset on either side; ` +
        'direction and price cannot be assigned without an external price for one side'
      ]
    };
  }

  const quantity = Math.abs(assetLeg.amount);
  const quoteAmount = Math.abs(quoteLeg.amount);

  if (!(quantity > 0) || !(quoteAmount > 0)) {
    return { kind: 'AMBIGUOUS', reasons: ['swap leg resolved to a zero amount'] };
  }

  const quotePerAsset = quoteAmount / quantity;

  let price = null;
  let priceBasis;

  if (isStableMint(quoteLeg.mint)) {
    price = quotePerAsset;
    priceBasis = 'QUOTE_STABLE';
  } else if (Number.isFinite(quotePriceUsd) && quotePriceUsd > 0) {
    price = quotePerAsset * quotePriceUsd;
    priceBasis = 'QUOTE_CONVERTED';
    confidence = CONFIDENCE.PARTIAL;
    reasons.push(
      `priced via ${STABLE_MINTS[quoteLeg.mint] || quoteLeg.mint} -> USD from an external price feed, ` +
      'not from the transaction itself'
    );
  } else {
    priceBasis = 'UNPRICED';
    confidence = CONFIDENCE.NEEDS_REVIEW;
    reasons.push(
      `quote asset ${quoteLeg.mint} has no USD price available; ` +
      'token ratio is on-chain but USD entry/exit and P&L are left null'
    );
  }

  return {
    kind: 'FILL',
    assetMint: assetLeg.mint,
    assetDecimals: assetLeg.decimals,
    side,
    quantity,
    quoteMint: quoteLeg.mint,
    quoteAmount,
    quotePerAsset,
    price,
    priceBasis,
    confidence,
    reasons
  };
}

/* ------------------------------------------------------------------ *
 * matchLots — FIFO
 * ------------------------------------------------------------------ */

/**
 * Pair buys and sells into trades using FIFO.
 *
 * An "episode" is one trade: it opens when the position for a mint goes from
 * flat to non-zero and closes when it returns to flat. Buys inside an open
 * episode are ADD legs, sells are REDUCE legs, and the sell that takes the
 * position to zero is the CLOSE leg. That is what produces adds and partial
 * exits inside a single record rather than a stream of disconnected fills.
 *
 * Realized P&L is GROSS — it is (exit price - lot entry price) x matched
 * quantity and excludes transaction fees, which are reported separately in
 * lamports because converting them to USD needs an external price.
 *
 * @param {Array} fills  chronological fills from `describeFill`
 * @returns {{ trades: Array, positions: Array, warnings: string[] }}
 */
export function matchLots(fills) {
  const ordered = [...fills].sort((a, b) => {
    const ta = a.at ? Date.parse(a.at) : 0;
    const tb = b.at ? Date.parse(b.at) : 0;
    if (ta !== tb) return ta - tb;
    // Stable tie-break so equal timestamps never reorder between runs.
    return String(a.signature).localeCompare(String(b.signature));
  });

  const warnings = [];
  const byMint = new Map();   // mint -> episode under construction
  const finished = [];

  const newEpisode = (mint, decimals) => ({
    assetMint: mint,
    assetDecimals: decimals,
    lots: [],            // FIFO queue: { qty, price, at, signature }
    legs: [],
    signatures: [],
    openedAt: null,
    closedAt: null,
    boughtQty: 0,
    soldQty: 0,
    buyCostUsd: 0,       // only counts buys whose price was derivable
    buyQtyPriced: 0,
    sellProceedsUsd: 0,
    sellQtyPriced: 0,
    realizedPnl: 0,
    realizedKnown: true, // false once a matched lot had no usable price
    feeLamports: 0,
    reasons: new Set(),
    confidences: new Set()
  });

  for (const fill of ordered) {
    let episode = byMint.get(fill.assetMint);
    if (!episode) {
      episode = newEpisode(fill.assetMint, fill.assetDecimals);
      byMint.set(fill.assetMint, episode);
    }

    episode.signatures.push(fill.signature);
    if (Number.isFinite(fill.feeLamports)) episode.feeLamports += fill.feeLamports;
    for (const reason of fill.reasons || []) episode.reasons.add(reason);
    episode.confidences.add(fill.confidence);

    if (fill.side === 'BUY') {
      const isOpen = episode.lots.length > 0;
      if (!episode.openedAt) episode.openedAt = fill.at;

      episode.lots.push({
        qty: fill.quantity,
        price: fill.price,
        at: fill.at,
        signature: fill.signature
      });
      episode.boughtQty += fill.quantity;
      if (Number.isFinite(fill.price)) {
        episode.buyCostUsd += fill.quantity * fill.price;
        episode.buyQtyPriced += fill.quantity;
      }

      episode.legs.push({
        at: fill.at,
        kind: isOpen ? 'ADD' : 'OPEN',
        qty: fill.quantity,
        price: fill.price,
        signature: fill.signature
      });
      continue;
    }

    // ---- SELL: consume the oldest lots first -----------------------------
    let remaining = fill.quantity;

    if (episode.lots.length === 0) {
      // Selling something this wallet was never seen buying. Usually the
      // buy is older than the fetched window; sometimes it was airdropped.
      // Either way the cost basis is unknown and must not be assumed zero.
      episode.realizedKnown = false;
      episode.reasons.add(
        `sold ${fill.quantity} of ${fill.assetMint} with no matching open lot in the fetched window; ` +
        'cost basis unknown, so realized P&L is not reported'
      );
      warnings.push(`UNMATCHED_SELL: ${fill.signature} sold ${fill.assetMint} with no prior buy in range`);
      episode.confidences.add(CONFIDENCE.NEEDS_REVIEW);
      if (!episode.openedAt) episode.openedAt = fill.at;
    }

    while (remaining > 0 && episode.lots.length > 0) {
      const lot = episode.lots[0];
      const matched = Math.min(remaining, lot.qty);

      if (Number.isFinite(lot.price) && Number.isFinite(fill.price)) {
        episode.realizedPnl += (fill.price - lot.price) * matched;
      } else {
        // One side of the match has no price. Refuse to score it.
        episode.realizedKnown = false;
        episode.reasons.add(
          'a FIFO match had no usable USD price on one side; realized P&L is not reported'
        );
      }

      lot.qty -= matched;
      remaining -= matched;
      if (lot.qty <= lot.qty * DUST_RATIO || lot.qty === 0) episode.lots.shift();
    }

    if (remaining > 0) {
      // Sold more than the tracked lots held.
      episode.realizedKnown = false;
      episode.reasons.add(
        `sell exceeded tracked open quantity by ${remaining}; part of the cost basis predates the fetched window`
      );
      episode.confidences.add(CONFIDENCE.NEEDS_REVIEW);
    }

    episode.soldQty += fill.quantity;
    if (Number.isFinite(fill.price)) {
      episode.sellProceedsUsd += fill.quantity * fill.price;
      episode.sellQtyPriced += fill.quantity;
    }

    const openQty = episode.lots.reduce((sum, lot) => sum + lot.qty, 0);
    const flat = openQty <= Math.max(episode.boughtQty * DUST_RATIO, 0);

    episode.legs.push({
      at: fill.at,
      kind: flat ? 'CLOSE' : 'REDUCE',
      qty: fill.quantity,
      price: fill.price,
      signature: fill.signature
    });

    if (flat) {
      episode.closedAt = fill.at;
      finished.push(episode);
      byMint.delete(episode.assetMint);
    }
  }

  const open = [...byMint.values()];
  const trades = [...finished, ...open].map((episode) => buildTradeRecord(episode));

  // Sort newest-first, matching how the UI lists activity.
  trades.sort((a, b) => Date.parse(b.openedAt || 0) - Date.parse(a.openedAt || 0));

  const positions = trades
    .filter((trade) => trade.status === 'OPEN')
    .map((trade) => ({
      assetMint: trade.assetMint,
      asset: trade.asset,
      quantity: trade.quantity,
      averageEntry: trade.entry,
      openedAt: trade.openedAt,
      tradeId: trade.id,
      dataConfidence: trade.dataConfidence
    }));

  return { trades, positions, warnings };
}

/* ------------------------------------------------------------------ *
 * Trade records
 * ------------------------------------------------------------------ */

function resolveConfidence(confidences) {
  if (confidences.has(CONFIDENCE.NEEDS_REVIEW)) return CONFIDENCE.NEEDS_REVIEW;
  if (confidences.has(CONFIDENCE.PARTIAL)) return CONFIDENCE.PARTIAL;
  return CONFIDENCE.VERIFIED;
}

/**
 * Deterministic trade id.
 *
 * Derived from kind + asset mint + the signature that opened the episode, so
 * re-running reconstruction over the same history yields byte-identical ids
 * and a user's manual corrections re-attach to the same record.
 *
 * Caveat, stated because it is a real limitation: the opening signature is
 * the earliest one *in the fetched window*. Widening the window backwards can
 * pull in an earlier buy, which moves the episode's start and therefore its
 * id. Ids are stable for a fixed window, not across a re-scan that reaches
 * further back.
 */
export function makeTradeId(kind, assetMint, openingSignature) {
  const seed = `${kind}|${assetMint}|${openingSignature}`;
  return `onchain-${kind.toLowerCase()}-${shortHash(seed)}`;
}

function buildTradeRecord(episode) {
  const openQty = episode.lots.reduce((sum, lot) => sum + lot.qty, 0);
  const status = episode.closedAt ? 'CLOSED' : 'OPEN';
  const openingSignature = episode.signatures[0];

  const entry = episode.buyQtyPriced > 0 ? episode.buyCostUsd / episode.buyQtyPriced : null;
  const exit = episode.sellQtyPriced > 0 ? episode.sellProceedsUsd / episode.sellQtyPriced : null;

  const reasons = [...episode.reasons];
  const confidences = new Set(episode.confidences);

  if (episode.buyQtyPriced > 0 && episode.buyQtyPriced < episode.boughtQty) {
    confidences.add(CONFIDENCE.PARTIAL);
    reasons.push('average entry covers only the buys that could be priced');
  }

  const realizedPnl = episode.realizedKnown && episode.soldQty > 0 ? episode.realizedPnl : null;

  if (episode.soldQty > 0 && realizedPnl === null) {
    confidences.add(CONFIDENCE.NEEDS_REVIEW);
  }

  // Spot is long-only: you cannot hold a negative token balance.
  const quantity = status === 'OPEN' ? openQty : episode.boughtQty;
  const notional = Number.isFinite(entry) && Number.isFinite(quantity) ? entry * quantity : null;

  return {
    id: makeTradeId('SPOT', episode.assetMint, openingSignature),
    source: 'ONCHAIN',

    asset: episode.assetMint,
    assetMint: episode.assetMint,
    direction: 'LONG',
    kind: 'SPOT',

    openedAt: episode.openedAt,
    closedAt: episode.closedAt,
    status,

    entry,
    exit,
    quantity,
    notional,

    leverage: null,
    collateral: null,

    realizedPnl,
    // Never estimated. A caller with a trusted mark price can compute this and
    // layer it in; this module does not guess at one.
    unrealizedPnl: null,
    // Fees are known in lamports (on-chain) but converting to USD needs an
    // external SOL price, so the USD field stays null.
    fees: null,

    dataConfidence: resolveConfidence(confidences),
    confidenceReasons: reasons,

    signatures: [...new Set(episode.signatures)],
    legs: episode.legs,
    overrides: {},

    meta: {
      lotPolicy: LOT_MATCHING_POLICY,
      pnlBasis: 'GROSS_EXCLUDING_FEES',
      feeLamports: episode.feeLamports,
      feeSol: episode.feeLamports / 10 ** SOL_DECIMALS,
      totalBoughtQty: episode.boughtQty,
      totalSoldQty: episode.soldQty,
      openQty
    }
  };
}

/** A Jupiter transaction we could see but not decode. Numbers stay null. */
function buildNeedsReviewRecord(classified, kindLabel, extra = {}) {
  return {
    id: makeTradeId(kindLabel, extra.assetMint || 'UNKNOWN', classified.signature),
    source: 'ONCHAIN',

    asset: extra.assetMint || null,
    assetMint: extra.assetMint || null,
    direction: null,
    kind: kindLabel === 'PERP' ? 'PERP' : 'SPOT',

    openedAt: classified.at,
    closedAt: null,
    status: 'OPEN',

    entry: null,
    exit: null,
    quantity: null,
    notional: null,
    leverage: null,
    collateral: extra.collateral ?? null,

    realizedPnl: null,
    unrealizedPnl: null,
    fees: null,

    dataConfidence: CONFIDENCE.NEEDS_REVIEW,
    confidenceReasons: [classified.reason, ...(extra.reasons || [])].filter(Boolean),

    signatures: [classified.signature],
    legs: [],
    overrides: {},

    meta: {
      lotPolicy: LOT_MATCHING_POLICY,
      programs: classified.programs,
      feeLamports: classified.feeLamports ?? null,
      // 'OPEN' above is a schema requirement, not an observation.
      statusKnown: false,
      ...(extra.meta || {})
    }
  };
}

/* ------------------------------------------------------------------ *
 * Cash flows
 * ------------------------------------------------------------------ */

/**
 * Plain transfers in and out, surfaced as CANDIDATES only.
 *
 * `classified: false` always. Nothing here is auto-classified, because the
 * engine cannot tell a genuine deposit from a transfer between two wallets the
 * same person owns, and getting that wrong silently corrupts every performance
 * figure downstream. Only flows a human has confirmed (`classified: true`) are
 * excluded from performance.
 */
function buildCashFlow(classified) {
  const type = classified.kind === 'TRANSFER_IN' ? 'DEPOSIT' : 'WITHDRAWAL';
  const moves = classified.moves || [];

  return {
    id: `flow-${shortHash(`${classified.signature}|${type}`)}`,
    type,
    classified: false,
    source: 'ONCHAIN',
    at: classified.at,
    signature: classified.signature,
    movements: moves.map((move) => ({
      mint: move.mint,
      amount: Math.abs(move.amount),
      decimals: move.decimals
    })),
    // Candidate, not conclusion.
    note:
      'Candidate cash flow. Confirm whether this is a real external deposit/withdrawal ' +
      'or a transfer between wallets you own; unconfirmed flows are not applied to performance.'
  };
}

/* ------------------------------------------------------------------ *
 * reconstructTrades
 * ------------------------------------------------------------------ */

/**
 * Reconstruct trades, positions and candidate cash flows for one address.
 *
 * @param {object}   input
 * @param {Array}    input.transactions   parsed transactions (any order)
 * @param {string}   input.address        the observed owner
 * @param {Function} [input.priceResolver] async (mint, atIso) => usd|null.
 *                   Used ONLY to convert a non-stable quote asset to USD.
 *                   Anything it prices is marked PARTIAL, because it is an
 *                   external input rather than on-chain arithmetic.
 * @param {'FLAG'|'OMIT'} [input.perpsMode='FLAG']
 *                   FLAG emits NEEDS_REVIEW perp stubs; OMIT drops them and
 *                   records a warning instead.
 * @returns {Promise<{trades, positions, cashFlows, stats, warnings}>}
 */
export async function reconstructTrades({
  transactions = [],
  address,
  priceResolver = null,
  perpsMode = 'FLAG'
} = {}) {
  const warnings = [];

  if (!address) {
    return {
      trades: [], positions: [], cashFlows: [],
      stats: emptyStats(),
      warnings: ['NO_ADDRESS: reconstruction requires the observed wallet address']
    };
  }

  const classifiedAll = transactions.map((tx) => classifySwap(tx, address));

  const fills = [];
  const extraTrades = [];
  const cashFlows = [];

  // Quote-asset USD prices are memoised per mint so one resolver call serves
  // every swap quoted in that asset.
  const quotePriceCache = new Map();
  const resolveQuotePrice = async (mint, at) => {
    if (isStableMint(mint)) return 1;
    if (!priceResolver) return null;
    if (quotePriceCache.has(mint)) return quotePriceCache.get(mint);
    let price = null;
    try {
      price = await priceResolver(mint, at);
    } catch (error) {
      warnings.push(`PRICE_RESOLVER_FAILED: ${mint} (${error.message})`);
    }
    const usable = Number.isFinite(price) && price > 0 ? price : null;
    quotePriceCache.set(mint, usable);
    return usable;
  };

  for (const classified of classifiedAll) {
    switch (classified.kind) {
      case 'FAILED':
        // Moved nothing. Not a trade, not a warning worth surfacing.
        break;

      case 'UNDECODABLE': {
        if (classified.viaJupiter || classified.viaPerps) {
          // Jupiter activity we can see but not read. This IS trade activity,
          // so it must appear — flagged, with every number null.
          extraTrades.push(buildNeedsReviewRecord(classified, 'SPOT'));
        } else {
          warnings.push(`UNDECODABLE_TX: ${classified.signature} could not be decoded (${classified.reason})`);
        }
        break;
      }

      case 'PERP_ACTIVITY': {
        if (perpsMode === 'OMIT') {
          warnings.push(
            `PERP_OMITTED: ${classified.signature} touched Jupiter Perpetuals and was omitted (perpsMode=OMIT)`
          );
          break;
        }
        const collateralMove = (classified.outbound || [])[0] || (classified.inbound || [])[0] || null;
        extraTrades.push(
          buildNeedsReviewRecord(classified, 'PERP', {
            assetMint: null,
            collateral: collateralMove ? Math.abs(collateralMove.amount) : null,
            reasons: [
              'Jupiter Perpetuals fills are executed by a keeper in a separate transaction that this ' +
              'wallet does not sign, so the trader signature alone does not contain the fill',
              'position size, entry price and leverage live in a program-owned account that requires ' +
              'the program IDL to decode'
            ],
            meta: {
              collateralMint: collateralMove ? collateralMove.mint : null,
              perpsProgram: JUPITER_PERPS_PROGRAM_ID
            }
          })
        );
        break;
      }

      case 'TRANSFER_IN':
      case 'TRANSFER_OUT':
        cashFlows.push(buildCashFlow(classified));
        break;

      case 'SWAP': {
        const quoteCandidate = isQuoteMint(classified.sent.mint) ? classified.sent.mint : classified.received.mint;
        const quotePriceUsd = await resolveQuotePrice(quoteCandidate, classified.at);
        const fill = describeFill(classified, quotePriceUsd);

        if (fill.kind === 'FILL') {
          fills.push({ ...fill, at: classified.at, signature: classified.signature, feeLamports: classified.feeLamports });
        } else if (fill.kind === 'CONVERSION') {
          warnings.push(`CONVERSION: ${classified.signature} — ${fill.reasons.join('; ')}`);
        } else {
          extraTrades.push(
            buildNeedsReviewRecord(
              { ...classified, reason: fill.reasons[0] },
              'SPOT',
              { assetMint: classified.received.mint, reasons: fill.reasons.slice(1) }
            )
          );
        }
        break;
      }

      default:
        warnings.push(`UNCLASSIFIED_TX: ${classified.signature} (${classified.reason || 'no reason'})`);
    }
  }

  const matched = matchLots(fills);
  const trades = [...matched.trades, ...extraTrades];
  warnings.push(...matched.warnings);

  return {
    trades,
    positions: matched.positions,
    cashFlows,
    stats: summarise(trades, cashFlows),
    warnings
  };
}

function emptyStats() {
  return {
    tradeCount: 0, openCount: 0, closedCount: 0,
    verifiedCount: 0, partialCount: 0, needsReviewCount: 0,
    realizedPnl: null, realizedPnlTradeCount: 0,
    perpCount: 0, cashFlowCandidates: 0,
    lotPolicy: LOT_MATCHING_POLICY, pnlBasis: 'GROSS_EXCLUDING_FEES'
  };
}

function summarise(trades, cashFlows) {
  const stats = emptyStats();
  stats.tradeCount = trades.length;
  stats.cashFlowCandidates = cashFlows.length;

  let pnlSum = 0;
  let pnlCount = 0;

  for (const trade of trades) {
    if (trade.status === 'OPEN') stats.openCount++;
    else stats.closedCount++;

    if (trade.kind === 'PERP') stats.perpCount++;

    if (trade.dataConfidence === CONFIDENCE.VERIFIED) stats.verifiedCount++;
    else if (trade.dataConfidence === CONFIDENCE.PARTIAL) stats.partialCount++;
    else stats.needsReviewCount++;

    // NEEDS_REVIEW never contributes to a headline number.
    if (
      Number.isFinite(trade.realizedPnl) &&
      trade.dataConfidence !== CONFIDENCE.NEEDS_REVIEW
    ) {
      pnlSum += trade.realizedPnl;
      pnlCount++;
    }
  }

  stats.realizedPnl = pnlCount > 0 ? pnlSum : null;
  stats.realizedPnlTradeCount = pnlCount;
  return stats;
}

/* ------------------------------------------------------------------ *
 * Overrides — user corrections layered over authoritative on-chain data
 * ------------------------------------------------------------------ */

/** Fields a user may correct. Everything else is on-chain fact only. */
export const OVERRIDABLE_FIELDS = Object.freeze([
  'asset', 'direction', 'kind', 'openedAt', 'closedAt', 'status',
  'entry', 'exit', 'quantity', 'notional', 'leverage', 'collateral',
  'realizedPnl', 'unrealizedPnl', 'fees'
]);

const CONFLICT_TOLERANCE = 1e-9;

function differs(a, b) {
  if (a === null || a === undefined) return false; // nothing on-chain to conflict with
  if (typeof a === 'number' && typeof b === 'number') {
    const scale = Math.max(Math.abs(a), Math.abs(b), 1);
    return Math.abs(a - b) > CONFLICT_TOLERANCE * scale;
  }
  return a !== b;
}

/**
 * Attach user corrections WITHOUT destroying the on-chain values.
 *
 * The corrections are stored in `trade.overrides` and nothing else on the
 * record changes, so `trade.entry` still reads the decoded on-chain number
 * after this call. Reading the corrected view is a separate, explicit step
 * (`resolveTrade`). That asymmetry is deliberate: overwriting in place would
 * make the on-chain value unrecoverable after one bad edit.
 */
export function applyOverrides(trade, overrides = {}) {
  const accepted = {};
  const rejected = [];

  for (const [field, value] of Object.entries(overrides)) {
    if (OVERRIDABLE_FIELDS.includes(field)) accepted[field] = value;
    else rejected.push(field);
  }

  const next = {
    ...trade,
    overrides: { ...(trade.overrides || {}), ...accepted }
  };

  if (rejected.length > 0) {
    next.meta = {
      ...(trade.meta || {}),
      rejectedOverrides: rejected
    };
  }

  return next;
}

/**
 * Where a correction disagrees with a non-null on-chain value.
 *
 * A correction on a field the chain left null is not a conflict — it is the
 * user filling a gap. A correction that contradicts a decoded number is, and
 * the UI should show both.
 */
export function detectOverrideConflicts(trade) {
  const overrides = trade?.overrides || {};
  const conflicts = [];

  for (const [field, overrideValue] of Object.entries(overrides)) {
    const onchainValue = trade[field];
    if (differs(onchainValue, overrideValue)) {
      conflicts.push({
        field,
        onchainValue,
        overrideValue,
        severity: trade.dataConfidence === CONFIDENCE.VERIFIED ? 'HIGH' : 'LOW',
        message:
          trade.dataConfidence === CONFIDENCE.VERIFIED
            ? `${field} was decoded directly from chain data; the correction contradicts it`
            : `${field} was inferred, so the correction may well be right`
      });
    }
  }

  return conflicts;
}

/**
 * The read-time view: on-chain record with corrections layered on top.
 *
 * Returns a NEW object. `onchain` carries an untouched snapshot of every
 * overridden field, so the original value is always recoverable and the UI can
 * show "you said X, chain says Y".
 */
export function resolveTrade(trade) {
  const overrides = trade?.overrides || {};
  const fields = Object.keys(overrides).filter((f) => OVERRIDABLE_FIELDS.includes(f));

  if (fields.length === 0) {
    return { ...trade, onchain: {}, overriddenFields: [], conflicts: [], hasConflicts: false };
  }

  const onchain = {};
  const resolved = { ...trade };
  for (const field of fields) {
    onchain[field] = trade[field];
    resolved[field] = overrides[field];
  }

  const conflicts = detectOverrideConflicts(trade);

  return {
    ...resolved,
    source: trade.source,          // still ONCHAIN; corrections do not re-label provenance
    onchain,
    overriddenFields: fields,
    conflicts,
    hasConflicts: conflicts.length > 0
  };
}

export default {
  LOT_MATCHING_POLICY,
  CONFIDENCE,
  JUPITER_SWAP_PROGRAM_IDS,
  JUPITER_PERPS_PROGRAM_ID,
  STABLE_MINTS,
  QUOTE_MINTS,
  SOL_MINT,
  isJupiterSwapProgram,
  isStableMint,
  isQuoteMint,
  collectProgramIds,
  computeOwnerDeltas,
  classifySwap,
  matchLots,
  reconstructTrades,
  makeTradeId,
  applyOverrides,
  detectOverrideConflicts,
  resolveTrade,
  OVERRIDABLE_FIELDS
};
