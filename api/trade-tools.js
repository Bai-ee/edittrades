import parseTradeImage from './parse-trade-image.js';
import reviewTrade from './review-trade.js';

// One Vercel function, two existing public routes. This keeps the Hobby-plan
// function count flat while preserving the handlers and URLs unchanged.
export default async function handler(req, res) {
  const path = req.url?.split('?')[0] || '';
  if (path === '/api/parse-trade-image') return parseTradeImage(req, res);
  if (path === '/api/review-trade') return reviewTrade(req, res);
  return res.status(404).json({ error: 'Unknown trade tool route' });
}
