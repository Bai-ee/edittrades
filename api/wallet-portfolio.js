/**
 * Wallet Portfolio Endpoint — READ-ONLY
 * GET /api/wallet/portfolio?address=<base58>
 *
 * Current SOL balance, SPL token holdings and USD value for ONE observed
 * Solana address. Address in, data out. No key is accepted, held or used.
 *
 * Query parameters
 *   address     required, base58 32-byte Solana address
 *   refresh     true  bypass the short in-memory cache
 *   includeZero true  keep zero-balance token accounts
 *
 * Status codes
 *   200  balances were read. `complete` may still be false if pricing is
 *        partial — the balances are real, the USD total is qualified.
 *   400  the address is missing or malformed
 *   503  the RPC could not be reached, so there are no balances to report.
 *        This is the case the UI renders as "WALLET DATA UNAVAILABLE".
 *
 * There is no path through this handler that returns a fabricated balance.
 * An unreachable RPC is a 503, never a 200 with zeros.
 */

import { getWalletPortfolio, validateSolanaAddress, describeRpcEndpoint } from '../services/solanaWalletReader.js';

/**
 * Vercel's legacy `routes` rewrites do not always repopulate `req.query`;
 * api/bitcoin-economic-value.js works around the same thing.
 */
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

  try {
    const portfolio = await getWalletPortfolio(address, {
      forceRefresh: query.refresh === 'true',
      includeZero: query.includeZero === 'true'
    });

    const rpcDown = portfolio.warnings.some((w) => w.startsWith('RPC_UNAVAILABLE'));

    if (rpcDown || portfolio.solBalance === null) {
      // No balances were read. Saying "0 SOL" here would be a lie the user
      // could act on, so this is an explicit outage response.
      return res.status(503).json({
        error: 'Wallet data unavailable',
        message: 'The Solana RPC endpoint could not be reached. No balances were read.',
        address,
        complete: false,
        // Kept in the outage shape too, so a UI reading these fields sees an
        // explicit null rather than `undefined` and cannot render a stray 0.
        solBalance: null,
        tokens: [],
        totalUsdValue: null,
        warnings: portfolio.warnings,
        rpcEndpoint: describeRpcEndpoint(),
        at: portfolio.at
      });
    }

    // Balances change on every block, so keep the CDN window short and lean on
    // stale-while-revalidate (same shape as api/bitcoin-economic-value.js).
    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');

    return res.status(200).json(portfolio);
  } catch (error) {
    console.error('[WalletPortfolio] Error:', error.message);
    console.error(error.stack);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
      address
    });
  }
}
