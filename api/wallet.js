import walletPortfolio from './wallet-portfolio.js';
import walletTrades from './wallet-trades.js';

// Read-only wallet API multiplexer. One serverless function preserves the
// Hobby-plan function budget while keeping the public URLs stable.
export default async function handler(req, res) {
  const path = req.url?.split('?')[0] || '';
  if (path === '/api/wallet/portfolio') return walletPortfolio(req, res);
  if (path === '/api/wallet/trades') return walletTrades(req, res);
  return res.status(404).json({ error: 'Unknown wallet route' });
}
