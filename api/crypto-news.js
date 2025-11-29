// Crypto News API - CryptoPanic integration
// Vercel Serverless Function

let newsCache = null;
let lastNewsFetch = 0;
const NEWS_CACHE_DURATION = 300000; // 5 minutes (300 seconds) - CryptoPanic has strict rate limits

const mockNews = [
  { title: "Bitcoin ETF sees record $1B inflows as institutional interest surges", url: "https://www.coindesk.com/markets/", source: "CoinDesk", currencies: ["BTC"] },
  { title: "Ethereum upgrade successfully deployed on mainnet", url: "https://www.theblock.co/", source: "The Block", currencies: ["ETH"] },
  { title: "Solana TVL hits new all-time high of $4.5B", url: "https://defillama.com/chain/Solana", source: "DeFi Llama", currencies: ["SOL"] },
  { title: "Federal Reserve signals potential rate cuts in Q2", url: "https://www.bloomberg.com/markets", source: "Bloomberg", currencies: ["BTC", "ETH"] },
  { title: "Major exchange announces support for Solana staking", url: "https://cryptoslate.com/", source: "CryptoSlate", currencies: ["SOL"] },
  { title: "Bitcoin breaks above key resistance level at $92K", url: "https://www.tradingview.com/markets/cryptocurrencies/", source: "TradingView", currencies: ["BTC"] }
];

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');

  // Handle OPTIONS request for CORS preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const now = Date.now();
    
    // Return cached news if still fresh
    if (newsCache && (now - lastNewsFetch) < NEWS_CACHE_DURATION) {
      return res.status(200).json({
        success: true,
        cached: true,
        news: newsCache
      });
    }

    // Fetch from CryptoPanic
    const API_KEY = process.env.CRYPTOPANIC_API_KEY || '7762b2058d34382d241b7bc409130a4c07074441';
    const params = new URLSearchParams({
      auth_token: API_KEY,
      filter: 'hot',
      currencies: 'BTC,ETH,SOL'
    });

    const apiUrl = `https://cryptopanic.com/api/v1/posts/?${params}`;
    console.log('Fetching crypto news from CryptoPanic...');
    
    const response = await fetch(apiUrl);
    
    if (!response.ok) {
      throw new Error(`CryptoPanic API error: ${response.status}`);
    }

    const data = await response.json();
    console.log('CryptoPanic news received:', data.results ? data.results.length : 0, 'items');
    
    // Normalize to simple format
    const normalizedNews = (data.results || []).slice(0, 20).map(item => ({
      title: item.title,
      url: item.url,
      source: item.source?.title || 'Unknown',
      published: item.published_at,
      currencies: item.currencies?.map(c => c.code) || []
    }));

    // Update cache
    newsCache = normalizedNews.length > 0 ? normalizedNews : mockNews;
    lastNewsFetch = now;

    return res.status(200).json({
      success: true,
      cached: false,
      news: newsCache
    });

  } catch (error) {
    console.error('Crypto news API error:', error.message || error);
    
    // Return cached news if available, even if stale
    if (newsCache) {
      console.log('⚠️ Using stale cached news due to API error');
      return res.status(200).json({
        success: true,
        cached: true,
        fallback: true,
        news: newsCache
      });
    }

    // Fallback to mock data
    console.log('⚠️ Using mock news data (API rate limited or unavailable)');
    return res.status(200).json({
      success: true,
      mock: true,
      news: mockNews
    });
  }
}

