/**
 * Wallet Trade History Endpoint — READ-ONLY
 * GET /api/wallet/trades?address=<base58>
 *
 * Trade history reconstructed from on-chain Jupiter activity for ONE observed
 * Solana address. Address in, data out. No key is accepted, held or used.
 *
 * Query parameters
 *   address           required, base58 32-byte Solana address
 *   maxTransactions   1..1000, default 100. Bounded so the first page returns
 *                     before a public RPC rate-limits the walk.
 *   before            signature cursor for the next page (from `nextBefore`)
 *   perpsMode         FLAG (default) | OMIT — see the note below
 *   prices            true (default) resolve non-stable quote assets to USD
 *                     via the Jupiter Price API. Anything priced this way is
 *                     marked PARTIAL, never VERIFIED.
 *
 * A note the caller should propagate to the UI: Jupiter PERPETUALS positions
 * are NOT reconstructed. They come back as `kind: 'PERP'` records with
 * `dataConfidence: 'NEEDS_REVIEW'` and null numbers, and they are excluded
 * from `stats.realizedPnl`. services/jupiterReconstruction.js explains why in
 * full. Nothing here estimates a perp entry, size or P&L.
 *
 * Status codes
 *   200  activity was read and reconstructed
 *   400  the address is missing or malformed
 *   503  the RPC could not be reached, so there is no history to reconstruct
 */

import {
  getWalletActivity,
  createCurrentPriceResolver,
  validateSolanaAddress,
  describeRpcEndpoint
} from '../services/solanaWalletReader.js';
import {
  reconstructTrades,
  LOT_MATCHING_POLICY,
  JUPITER_PERPS_PROGRAM_ID
} from '../services/jupiterReconstruction.js';

function readQuery(req) {
  const query = { ...(req.query || {}) };
  if (req.url && req.url.includes('?')) {
    const parsed = new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1));
    for (const [key, value] of parsed.entries()) {
      if (query[key] === undefined) query[key] = value;
    }
  }
  return query;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  const query = readQuery(req);
  const address = (query.address || '').trim();

  if (!address) {
    return res.status(400).json({
      error: 'Missing address',
      message: 'Provide ?address=<your Solana wallet address>'
    });
  }

  if (!validateSolanaAddress(address)) {
    return res.status(400).json({
      error: 'Invalid Solana address',
      message: 'Address must be base58 and decode to 32 bytes.',
      address
    });
  }

  const requested = parseInt(query.maxTransactions, 10);
  const maxTransactions = Number.isFinite(requested)
    ? Math.max(1, Math.min(requested, 1000))
    : 100;

  const perpsMode = query.perpsMode === 'OMIT' ? 'OMIT' : 'FLAG';

  try {
    const activity = await getWalletActivity(address, {
      maxTransactions,
      before: query.before || undefined
    });

    const rpcDown = activity.warnings.some((w) => w.startsWith('RPC_UNAVAILABLE'));
    if (rpcDown && activity.transactions.length === 0) {
      return res.status(503).json({
        error: 'Wallet data unavailable',
        message: 'The Solana RPC endpoint could not be reached. No transaction history was read.',
        address,
        complete: false,
        // Present and empty rather than absent, so the UI never has to guess
        // whether "no trades" means none exist or none could be read.
        trades: [],
        positions: [],
        cashFlows: [],
        warnings: activity.warnings,
        rpcEndpoint: describeRpcEndpoint()
      });
    }

    const priceResolver = query.prices === 'false' ? null : createCurrentPriceResolver();

    const result = await reconstructTrades({
      transactions: activity.transactions,
      address,
      priceResolver,
      perpsMode
    });

    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');

    return res.status(200).json({
      address,
      trades: result.trades,
      positions: result.positions,
      cashFlows: result.cashFlows,
      stats: result.stats,
      // The scan window is bounded, so say exactly what was looked at.
      window: {
        transactionsScanned: activity.transactions.length,
        signaturesSeen: activity.signatures.length,
        maxTransactions,
        hasMore: activity.hasMore,
        nextBefore: activity.nextBefore
      },
      complete: activity.complete,
      warnings: [...activity.warnings, ...result.warnings],
      methodology: {
        lotPolicy: LOT_MATCHING_POLICY,
        pnlBasis: 'GROSS_EXCLUDING_FEES',
        perpsMode,
        perpsSupported: false,
        perpsNote:
          'Jupiter Perpetuals positions are not reconstructed. Fills are executed by a keeper in a ' +
          'separate transaction this wallet does not sign, and position state lives in an ' +
          `Anchor-encoded account of program ${JUPITER_PERPS_PROGRAM_ID} that requires the program ` +
          'IDL to decode. Perp records are returned as NEEDS_REVIEW with null values and are ' +
          'excluded from realized P&L.',
        cashFlowNote:
          'Deposits and withdrawals are candidates only (classified: false). Confirm them before ' +
          'they are excluded from performance; the engine never auto-classifies them.'
      },
      rpcEndpoint: describeRpcEndpoint(),
      at: new Date().toISOString()
    });
  } catch (error) {
    console.error('[WalletTrades] Error:', error.message);
    console.error(error.stack);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
      address
    });
  }
}
