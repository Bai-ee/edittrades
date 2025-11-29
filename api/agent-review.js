/**
 * EditTrades AI Reasoning Agent
 * 
 * This serverless function sends market JSON to ChatGPT for trade analysis
 * and returns a formatted trade call with reasoning.
 */

// Market Review Handler (new)
async function handleMarketReview(req, res, tradesData, systemPrompt) {
  try {
    console.log('🔍 Market review handler called');
    console.log('TradesData keys:', Object.keys(tradesData || {}));
    
    // Get OpenAI API key
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error('❌ OpenAI API key not found');
      return res.status(500).json({ 
        error: 'OpenAI API key not configured' 
      });
    }

    console.log('✅ API key found');

    const userPrompt = `Analyze this market data and provide a concise 1-2 sentence market review:

${JSON.stringify(tradesData, null, 2)}

Remember: Keep it tight, observational, and focused on overall market behavior and correlation between assets.`;

    console.log('📤 Calling OpenAI API...');

    // Use native fetch (available in Node 18+)
    const fetchFn = globalThis.fetch || (await import('node-fetch')).default;
    const response = await fetchFn('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: userPrompt
          }
        ],
        temperature: 0.7,
        max_tokens: 150
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API error:', response.status, errorText);
      return res.status(response.status).json({ 
        error: `OpenAI API error: ${response.status}` 
      });
    }

    const data = await response.json();
    const review = data.choices[0]?.message?.content;

    if (!review) {
      return res.status(500).json({ 
        error: 'No review from AI' 
      });
    }

    return res.status(200).json({
      success: true,
      review: review.trim(),
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Market review error:', error);
    console.error('Error stack:', error.stack);
    return res.status(500).json({ 
      error: 'Market review failed',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('📥 Request body keys:', Object.keys(req.body || {}));
    const { marketSnapshot, setupType, symbol, tradesData, systemPrompt } = req.body;

    // Market review mode (new)
    if (tradesData && systemPrompt) {
      console.log('📊 Market review mode detected');
      console.log('System prompt length:', systemPrompt?.length);
      console.log('Trades data:', JSON.stringify(tradesData).substring(0, 200) + '...');
      return await handleMarketReview(req, res, tradesData, systemPrompt);
    }

    // Individual trade analysis mode (existing)
    if (!marketSnapshot || !setupType || !symbol) {
      return res.status(400).json({ 
        error: 'Missing required fields: marketSnapshot, setupType, symbol OR tradesData, systemPrompt' 
      });
    }

    // Get OpenAI API key from environment variable
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error('OPENAI_API_KEY environment variable is not set');
      return res.status(500).json({ 
        error: 'OpenAI API key not configured in environment variables' 
      });
    }
    
    // Log key format for debugging (only first/last few chars for security)
    console.log(`API Key found: ${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 4)}`);
    console.log(`API Key length: ${apiKey.length}`);

    // Strategy-specific guidance
    const strategyGuidance = {
      'Swing': `
SWING TRADE SPECIFIC ANALYSIS:
- This is a 3D → 1D → 4H multi-timeframe swing setup
- CRITICAL: 4H trend must NOT be FLAT (instant disqualification)
- Evaluate 3D oversold/overbought pivot quality
- Check 1D reclaim/rejection strength
- Confirm 4H is providing structural support
- Stop loss should be at 3D/1D swing levels (HTF invalidation)
- Targets should be 3R, 4R, 5R minimum
- This is a larger position, longer hold time
- Focus on: HTF momentum alignment, macro trend integrity, structural confluence`,
      
      'Scalp': `
SCALP TRADE SPECIFIC ANALYSIS:
- This is a 15m/5m lower timeframe scalp
- CRITICAL: 4H trend must be clear (NOT FLAT) and aligned
- 1H must confirm direction
- Both 15m and 5m must be in ENTRY_ZONE near 21 EMA
- Stoch must show strong momentum curl in direction
- Stop loss should be at 5m/15m swing levels (tight LTF stops)
- Targets are typically 1.5R to 3R (quick in/out)
- This is smaller position, fast execution
- Focus on: LTF momentum quality, tight confluence, clean entry zone`,
      
      '4h': `
4-HOUR TRADE SPECIFIC ANALYSIS:
- This is the core "set and forget" strategy
- CRITICAL: 4H trend must be clear (UPTREND/DOWNTREND, not FLAT)
- 1H must align with 4H direction
- Price must be in ENTRY_ZONE (near 4H 21 EMA, ±1%)
- 4H pullback state must be RETRACING or ENTRY_ZONE
- Stoch must show curl in trade direction on 4H
- Stop loss at 4H swing high/low
- Targets are 1:1 and 1:2 R (TP1/TP2)
- This is medium position, medium hold time
- Focus on: 4H trend clarity, EMA alignment, stoch momentum quality`,

      'MicroScalp': `
MICRO-SCALP SPECIFIC ANALYSIS:
‼️ CRITICAL: This strategy COMPLETELY DISREGARDS 4H TREND ‼️
- DO NOT evaluate 4H trend - it is 100% IRRELEVANT to Micro-Scalp
- DO NOT mention "4H must be X" or "4H trend is..." - IGNORE IT ENTIRELY
- 4H can be UPTREND, DOWNTREND, or FLAT - DOESN'T MATTER AT ALL
- This is a LOWER TIMEFRAME ONLY strategy (1H/15m/5m)

WHAT ACTUALLY MATTERS FOR MICRO-SCALP:
- 1H trend must be clear (UPTREND or DOWNTREND, not FLAT)
- 1H pullback state must be ENTRY_ZONE or RETRACING
- 15m price within ±0.25% of 15m EMA21
- 5m price within ±0.25% of 5m EMA21
- Stoch aligned on BOTH 15m and 5m (oversold+bullish for long, overbought+bearish for short)
- Very tight stops at 15m/5m swing levels
- Quick targets (1.0R, 1.5R only)
- Smallest position size, fastest execution

Focus ONLY on: 1H trend quality, 15m/5m EMA precision, stoch alignment on LTF
DO NOT MENTION 4H TREND IN YOUR ANALYSIS - IT IS NOT A FACTOR`
    };

    const currentGuidance = strategyGuidance[setupType] || strategyGuidance['4h'];

    // Construct the system prompt based on the reasoning agent rules
    const systemPrompt = `You are the Trading Reasoning Layer for EditTrades.

Your job:
- Analyze EditTrades' JSON snapshot for ${setupType.toUpperCase()} setup
- Apply strategy-specific rules for this trade type
- Use higher-level reasoning (momentum, HTF conflict, invalidation integrity)
- Add confluence checks
- Determine if THIS SPECIFIC TRADE TYPE is recommended
- Create a clean human-readable trade call
- Provide analysis that adds value beyond the raw data

${currentGuidance}

Rules:
1. Never override numerical fields from EditTrades (entry, stop, tp1/2/3)
2. You may critique a trade if conditions contradict best practices for THIS strategy
3. Your analysis should be SPECIFIC to ${setupType.toUpperCase()} - don't suggest a different strategy
4. Write in CONVERSATIONAL PARAGRAPHS, not bulleted lists
5. Structure your response as natural flowing text

Write your response in this conversational style:

[Opening paragraph: Current setup assessment - is this a good ${setupType.toUpperCase()} trade? State clearly if it's valid or not and why.]

[Body paragraphs: Discuss the key factors FOR THIS SPECIFIC STRATEGY:
${setupType === 'MicroScalp' ? 
  '- 1H trend situation (must be UPTREND/DOWNTREND, not FLAT) - IGNORE 4H COMPLETELY' :
  '- The trend situation on relevant timeframes (4H must not be FLAT for Swing/Scalp/4H strategies)'}
- Momentum strength and stochastic positioning on the timeframes that matter for THIS strategy
- Entry zone quality and price positioning relative to the EMAs that matter
${setupType === 'MicroScalp' ? 
  '- 15m and 5m precision (±0.25% from EMA21 on both is critical)' :
  '- Any conflicts between higher and lower timeframes'}
- What's working or what's blocking this setup]

[If NO TRADE: Explain what to watch for to make it valid:
- Which timeframes need to change and how
- Specific price levels to monitor (mention actual numbers from the data)
- What conditions need to happen (stoch movements, trend changes, etc.)
- Timeline expectations (how many hours/candles)]

[Closing paragraph: Overall assessment with rating (A+, A, B, or SKIP). Be direct about trade quality.]

Important:
- Write like you're talking to a trader, not writing a checklist
- Use natural language and flow between topics
- No bullet points, no dashes, no lists
- Just conversational paragraphs
- Be concise but insightful (3-5 paragraphs total)
- Always mention what to watch for if the trade isn't valid yet`;

    // Strategy-specific analysis points
    const analysisPoints = {
      'Swing': `
- 3D timeframe pivot quality (is it truly oversold/overbought?)
- 1D reclaim/rejection strength and conviction
- 4H structural support (is 4H clear, not FLAT?)
- HTF invalidation levels (3D/1D swing integrity)
- Is this a clean HTF swing setup with 3R+ potential?
- Why this IS or ISN'T a good SWING trade`,
      
      'Scalp': `
- 4H trend clarity (must be clear, NOT FLAT)
- 1H alignment with 4H direction
- 15m and 5m entry zone quality (both near 21 EMA?)
- LTF stoch momentum alignment (both curling in direction?)
- Is this a clean LTF scalp with tight confluence?
- Why this IS or ISN'T a good SCALP trade`,
      
      '4h': `
- 4H trend clarity (UPTREND/DOWNTREND vs FLAT)
- 1H alignment with 4H
- Price position relative to 4H 21 EMA (±1%?)
- 4H stoch curl quality
- 4H pullback state validity
- Why this IS or ISN'T a good 4-HOUR trade`,
      
      'MicroScalp': `
‼️ DO NOT ANALYZE 4H TREND - IT IS IRRELEVANT ‼️
- 1H trend: Is it UPTREND or DOWNTREND? (FLAT = no trade)
- 1H pullback state: ENTRY_ZONE or RETRACING? (OVEREXTENDED = no trade)
- 15m EMA21 precision: Price within ±0.25%? (exact percentage from data)
- 5m EMA21 precision: Price within ±0.25%? (exact percentage from data)
- 15m stoch: Aligned with direction? (oversold/bullish for long, overbought/bearish for short)
- 5m stoch: Aligned with 15m? Must match
- Risk: This is highest risk, countertrend to HTF (doesn't matter - it's independent)
- Final verdict: Is this a VALID MICRO-SCALP based ONLY on 1H/15m/5m? Be critical.`
    };

    const currentPoints = analysisPoints[setupType] || analysisPoints['4h'];

    const userPrompt = `Analyze this ${setupType.toUpperCase()} setup for ${symbol}:

${JSON.stringify(marketSnapshot, null, 2)}

Write a conversational analysis (3-5 paragraphs) evaluating:
${currentPoints}

Start by clearly stating whether this is currently a good ${setupType.toUpperCase()} trade or not. Then explain why.

${setupType === 'MicroScalp' ? 
  'Focus ONLY on 1H trend, 15m/5m EMA precision, and stoch alignment. DO NOT mention or evaluate 4H trend - it is completely irrelevant to Micro-Scalp strategy.' :
  'Discuss the trend situation, momentum, stochastic positioning, and entry zone quality. Mention any conflicts between timeframes (HTF vs LTF).'}

Be specific about what's working or what's blocking this setup.

If this is NOT a valid trade, explain what needs to happen to make it valid:
${setupType === 'MicroScalp' ?
  '- Does 1H need to establish a trend (break from FLAT)?\n- Do 15m/5m need to pull back closer to their 21 EMAs? (give specific percentages)\n- What stoch movements are needed on 15m and 5m?\n- Timeline: Usually 1-4 hours for LTF alignment' :
  '- Which timeframes need to change (e.g., "The 4H needs to break from FLAT and establish a clear UPTREND")\n- Specific price levels to watch (use actual numbers from the data)\n- What conditions need to change (e.g., "The 1H stoch needs to curl up from oversold")\n- How long this might take (e.g., "This could take 4-8 hours for the 4H to establish direction")'}

Write naturally in flowing paragraphs. No bullet points or lists. Be conversational but insightful.

End with your overall rating: A+, A, B, or SKIP`;

    // Call OpenAI API
    const fetchFn = globalThis.fetch || (await import('node-fetch')).default;
    const response = await fetchFn('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: userPrompt
          }
        ],
        temperature: 0.3,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API error:');
      console.error('Status:', response.status);
      console.error('Response:', errorText);
      
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch (e) {
        errorData = { message: errorText };
      }
      
      return res.status(response.status).json({ 
        error: `OpenAI API returned ${response.status}`,
        details: errorData,
        hint: response.status === 401 ? 
          'API key may be invalid. Check https://platform.openai.com/api-keys' : 
          'Check OpenAI API status'
      });
    }

    const data = await response.json();
    const agentResponse = data.choices[0]?.message?.content;

    if (!agentResponse) {
      return res.status(500).json({ 
        error: 'No response from AI agent' 
      });
    }

    // Parse the response to extract priority rating if present
    let priority = 'A';
    if (agentResponse.includes('A+')) priority = 'A+';
    else if (agentResponse.includes('SKIP')) priority = 'SKIP';
    else if (agentResponse.includes('B')) priority = 'B';

    return res.status(200).json({
      success: true,
      symbol,
      setupType,
      priority,
      formattedText: agentResponse,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Agent review error:', error);
    return res.status(500).json({ 
      error: 'Agent review failed',
      message: error.message 
    });
  }
}

