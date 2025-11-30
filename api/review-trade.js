/**
 * Vercel Serverless Function: Trade Review Endpoint
 * POST /api/review-trade
 * 
 * Analyzes a completed trade against its original signal snapshot
 * Returns structured feedback for learning and improvement
 */

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { trade } = req.body;

    if (!trade) {
      return res.status(400).json({ error: 'Missing required parameter: trade' });
    }

    // Validate trade has required fields
    if (!trade.signalSnapshot || !trade.exitPrice || !trade.entry) {
      return res.status(400).json({ 
        error: 'Trade must have signalSnapshot, exitPrice, and entry fields' 
      });
    }

    console.log(`[Review Trade] Analyzing trade: ${trade.symbol} ${trade.direction}`);

    // Build prompt for OpenAI
    const signalSnapshot = trade.signalSnapshot;
    const originalSignal = signalSnapshot.signal;
    const originalHTFBias = signalSnapshot.htfBias;
    
    // Calculate actual performance
    const entry = trade.entry;
    const exit = trade.exitPrice;
    const stopLoss = trade.stopLoss;
    const direction = trade.direction.toUpperCase();
    
    let pnl = 0;
    let pnlPercent = 0;
    let rMultiple = 0;
    
    if (direction === 'LONG') {
      pnl = exit - entry;
      pnlPercent = ((exit - entry) / entry) * 100;
      const risk = entry - stopLoss;
      rMultiple = risk > 0 ? pnl / risk : 0;
    } else {
      pnl = entry - exit;
      pnlPercent = ((entry - exit) / entry) * 100;
      const risk = stopLoss - entry;
      rMultiple = risk > 0 ? pnl / risk : 0;
    }

    const hitTarget1 = trade.target1 && (
      (direction === 'LONG' && exit >= trade.target1) ||
      (direction === 'SHORT' && exit <= trade.target1)
    );
    const hitTarget2 = trade.target2 && (
      (direction === 'LONG' && exit >= trade.target2) ||
      (direction === 'SHORT' && exit <= trade.target2)
    );
    const hitStop = (direction === 'LONG' && exit <= stopLoss) || 
                    (direction === 'SHORT' && exit >= stopLoss);

    const systemPrompt = `You are an expert trading coach analyzing a completed trade. Your job is to provide honest, actionable feedback that helps the trader learn and improve.

Analyze the trade by comparing:
1. What the original signal expected (from signalSnapshot)
2. What actually happened (exit price, P&L, targets hit)
3. Whether the trader followed the original setup correctly
4. What went right and what went wrong

Be direct, specific, and focus on actionable insights. Avoid generic advice.`;

    const userPrompt = `Trade Analysis Request:

ORIGINAL SIGNAL:
- Symbol: ${signalSnapshot.symbol}
- Strategy: ${originalSignal.selectedStrategy || originalSignal.setupType}
- Direction: ${originalSignal.direction}
- Entry Zone: ${originalSignal.entryZone?.min} - ${originalSignal.entryZone?.max}
- Stop Loss: ${originalSignal.stopLoss}
- Targets: ${originalSignal.targets?.[0]}, ${originalSignal.targets?.[1]}
- HTF Bias: ${originalHTFBias.direction} (${originalHTFBias.confidence}% confidence from ${originalHTFBias.source})
- Original Reason: ${originalSignal.reason}
- Confidence: ${(originalSignal.confidence * 100).toFixed(0)}%

ACTUAL TRADE:
- Entry: ${entry}
- Exit: ${exit}
- Stop Loss: ${stopLoss}
- Target 1: ${trade.target1}
- Target 2: ${trade.target2}
- P&L: ${pnl.toFixed(2)} (${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)
- R Multiple: ${rMultiple.toFixed(2)}R
- Hit Target 1: ${hitTarget1 ? 'Yes' : 'No'}
- Hit Target 2: ${hitTarget2 ? 'Yes' : 'No'}
- Hit Stop: ${hitStop ? 'Yes' : 'No'}
- Trade Duration: ${trade.exitTime && trade.entryTime ? 
  Math.round((new Date(trade.exitTime) - new Date(trade.entryTime)) / (1000 * 60)) + ' minutes' : 'Unknown'}

Provide a structured review with:
1. What Went Right: Specific things that worked (entry timing, target management, etc.)
2. What Went Wrong: Specific mistakes or missed opportunities
3. Performance Summary: Overall assessment and key takeaways
4. Lessons: 2-3 actionable lessons for future trades

Keep each section concise (2-3 sentences max). Be honest but constructive.`;

    // Call OpenAI API
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 800,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Review Trade] OpenAI API error:', response.status, errorText);
      return res.status(500).json({ 
        error: 'OpenAI API request failed',
        message: `API returned ${response.status}: ${errorText.substring(0, 200)}`,
        details: 'APIError'
      });
    }

    const data = await response.json();
    const reviewText = data.choices[0]?.message?.content || 'Unable to generate review';

    // Parse the review text into structured format
    // Try to extract sections from the response
    const whatWentRightMatch = reviewText.match(/What Went Right[:\-]?\s*(.+?)(?=What Went Wrong|Performance Summary|Lessons|$)/is);
    const whatWentWrongMatch = reviewText.match(/What Went Wrong[:\-]?\s*(.+?)(?=Performance Summary|Lessons|$)/is);
    const performanceSummaryMatch = reviewText.match(/Performance Summary[:\-]?\s*(.+?)(?=Lessons|$)/is);
    const lessonsMatch = reviewText.match(/Lessons[:\-]?\s*(.+?)$/is);

    const review = {
      whatWentRight: whatWentRightMatch ? whatWentRightMatch[1].trim() : 
                    (reviewText.includes('right') || reviewText.includes('good') ? 
                     reviewText.split('\n').find(line => line.toLowerCase().includes('right') || line.toLowerCase().includes('good')) || 
                     'Review generated - see full text' : ''),
      whatWentWrong: whatWentWrongMatch ? whatWentWrongMatch[1].trim() : 
                    (reviewText.includes('wrong') || reviewText.includes('mistake') ? 
                     reviewText.split('\n').find(line => line.toLowerCase().includes('wrong') || line.toLowerCase().includes('mistake')) || 
                     'Review generated - see full text' : ''),
      performanceSummary: performanceSummaryMatch ? performanceSummaryMatch[1].trim() : 
                          (reviewText.length > 0 ? reviewText.substring(0, 200) + '...' : 'Review generated'),
      lessons: lessonsMatch ? lessonsMatch[1].trim().split('\n').filter(l => l.trim()).slice(0, 3) : 
              (reviewText.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('•')).slice(0, 3) || [])
    };

    // If parsing failed, use the full text as performance summary
    if (!review.whatWentRight && !review.whatWentWrong) {
      review.performanceSummary = reviewText;
    }

    return res.status(200).json({
      review: review,
      fullText: reviewText,
      tradeMetrics: {
        pnl: pnl,
        pnlPercent: pnlPercent,
        rMultiple: rMultiple,
        hitTarget1: hitTarget1,
        hitTarget2: hitTarget2,
        hitStop: hitStop
      }
    });

  } catch (error) {
    console.error('[Review Trade] Error:', error.message);
    console.error('[Review Trade] Stack:', error.stack);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message
    });
  }
}

