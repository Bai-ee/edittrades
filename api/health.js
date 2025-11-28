/**
 * Health Check Endpoint
 * GET /api/health
 * 
 * Simple endpoint to verify Vercel deployment is working
 */

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Check environment variables
    const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
    
    // Return health status
    return res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      environment: {
        nodeVersion: process.version,
        hasOpenAIKey: hasOpenAIKey
      },
      message: 'EditTrades API is running'
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
}

