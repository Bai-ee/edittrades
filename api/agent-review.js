/**
 * EditTrades AI Reasoning Agent
 * 
 * This serverless function sends market JSON to ChatGPT for trade analysis
 * and returns a formatted trade call with reasoning.
 * 
 * Uses raw fetch (not SDK) for better Vercel serverless compatibility
 */

// Market Pulse Intelligence Handler (new adaptive AI)
async function handleMarketPulse(req, res, context, variables) {
  try {
    console.log('🧠 Market Pulse Intelligence handler called');
    console.log('Context keys:', Object.keys(context || {}));
    console.log('Variables:', variables);
    
    // Validate context has minimum required data
    if (!context || !context.symbol) {
      return res.status(400).json({
        error: 'Invalid context: symbol is required',
        fallback: `Market data for ${context?.symbol || 'market'} is currently unavailable. Please check again soon.`
      });
    }
    
    // Get OpenAI API key
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error('❌ OpenAI API key not found');
      // Return fallback message instead of error
      return res.status(200).json({
        success: true,
        pulse: `Market data for ${context.symbol} is currently unavailable. Please check again soon.`,
        context: {
          symbol: context.symbol,
          mode: context.mode,
          tone: variables?.tone,
          depth: variables?.depth,
          target: variables?.target
        },
        timestamp: new Date().toISOString(),
        fallback: true
      });
    }

    // Extract variables with defaults
    let tone = variables?.tone || 'neutral';
    let depth = variables?.depth || 'normal';
    const target = variables?.target || 'dashboard';
    let temperature = aiContract.clampTemperature(variables?.temperature);
    let toneFlavor = variables?.toneFlavor || context?.toneFlavor || null;
    
    // Dev-only prompt tuning (check if in development mode)
    const isDev = process.env.NODE_ENV === 'development' || process.env.VERCEL_ENV !== 'production';
    if (isDev) {
      // Apply dev config overrides if set via environment variables
      const devTone = process.env.PULSE_DEV_TONE;
      const devTemperatureCap = parseFloat(process.env.PULSE_DEV_TEMP_CAP || '0.8');
      const devDepth = process.env[`PULSE_DEV_DEPTH_${target.toUpperCase()}`];
      const devToneFlavor = process.env.PULSE_DEV_TONE_FLAVOR;
      
      if (devTone) tone = devTone;
      if (devDepth) depth = devDepth;
      if (devToneFlavor) toneFlavor = devToneFlavor;
      temperature = aiContract.clampTemperature(Math.min(temperature, devTemperatureCap));
      
      console.log('🔧 Dev config applied:', { tone, depth, temperature, target, toneFlavor: toneFlavor || 'default' });
    }

    // Build trend map from context
    const trendMap = context.trendMap || {};
    const trendState = {
      '3d': trendMap['3d'] || trendMap['3D'] || 'unknown',
      '1d': trendMap['1d'] || trendMap['1D'] || 'unknown',
      '4h': trendMap['4h'] || trendMap['4H'] || 'unknown',
      '1h': trendMap['1h'] || trendMap['1H'] || 'unknown',
      '15m': trendMap['15m'] || trendMap['15m'] || 'unknown'
    };

    // Voice Pack system prompt suffix
    const voicePacks = {
      relatable: `Keep your tone casual and conversational. Speak like a human trader who's explaining things to a peer, not a bot or analyst. Avoid jargon. Use phrases like "the market's been acting..." or "feels like...". Make it feel natural and relatable.`,
      pro: `Use professional, technical language appropriate for institutional traders. Be precise with terminology and data points. Maintain analytical rigor while remaining accessible.`,
      hype: `Use energetic, engaging language that captures momentum and excitement. Be enthusiastic about opportunities while maintaining accuracy.`,
      coach: `Use an educational, supportive tone. Explain concepts clearly and help the trader understand why decisions are being made. Be encouraging and constructive.`
    };
    
    const voiceSuffix = toneFlavor && voicePacks[toneFlavor] ? `\n\n${voicePacks[toneFlavor]}` : '';
    
    // Build system prompt with variable injection
    const systemPrompt = `You are the Market Pulse AI, embedded in a crypto trading system. Your job is to interpret system-generated context and deliver timely, human-like summaries of market posture, strategy logic, and signal availability. Speak clearly, don't speculate, and use judgment calibrated by confidence inputs. Adapt tone and length as requested.

Tone: ${tone} (neutral = balanced, optimistic = positive outlook, cautionary = warning, assertive = confident)
Depth: ${depth} (short = 1-2 lines, normal = 1-2 paragraphs, detailed = multi-section)
Target: ${target} (dashboard = overview, trade-panel = specific symbol, marquee = banner message)
Temperature: ${temperature} (controls creativity/variability)${toneFlavor ? `\nStyle: ${toneFlavor} (${voicePacks[toneFlavor]?.split('.')[0] || 'custom style'})` : ''}

Rules:
- Do not invent signals. If none are present, explain why using current market structure.
- Mention key misalignments or flat trends blocking trades.
- Use trader-oriented reasoning: note what looks promising, what's blocking, and what may trigger next.
- Format appropriately for ${target} context.
- Keep ${depth} length as specified.
- Use ${tone} tone throughout.${voiceSuffix}`;

    // Build user prompt from context
    const contextSummary = [];
    
    if (context.symbol) {
      contextSummary.push(`${context.symbol} context:`);
    }
    
    if (context.volatility3d) {
      contextSummary.push(`Volatility over last 3 days: ${context.volatility3d}`);
    }
    
    // Trend state summary
    const flatTrends = [];
    const activeTrends = [];
    Object.entries(trendState).forEach(([tf, trend]) => {
      if (trend === 'flat' || trend === 'FLAT') {
        flatTrends.push(tf);
      } else if (trend !== 'unknown') {
        activeTrends.push(`${tf}: ${trend}`);
      }
    });
    
    if (flatTrends.length > 0) {
      contextSummary.push(`Flat timeframes: ${flatTrends.join(', ')}`);
    }
    if (activeTrends.length > 0) {
      contextSummary.push(`Active trends: ${activeTrends.join(', ')}`);
    }
    
    if (context.htfBias) {
      const bias = context.htfBias;
      contextSummary.push(`HTF bias: ${bias.direction} (${bias.confidence}% confidence)`);
    }
    
    if (context.volumeQuality) {
      contextSummary.push(`Volume quality: ${context.volumeQuality}`);
    }
    
    if (context.dflowStatus) {
      contextSummary.push(`Prediction markets: ${context.dflowStatus}`);
    }
    
    if (context.activeSignals !== undefined) {
      contextSummary.push(`Active signals: ${context.activeSignals}`);
    }
    
    if (context.mode) {
      contextSummary.push(`Trading mode: ${context.mode}`);
    }
    
    // Temporal awareness: Add time since last signal
    if (context.hoursSinceLastSignal !== null && context.hoursSinceLastSignal !== undefined) {
      const hours = Math.floor(context.hoursSinceLastSignal);
      const minutes = Math.floor((context.hoursSinceLastSignal % 1) * 60);
      
      if (context.hoursSinceLastSignal > 0) {
        if (hours >= 1) {
          contextSummary.push(`Time since last signal: ${hours} hour${hours > 1 ? 's' : ''}${minutes > 0 ? ` ${minutes} minute${minutes > 1 ? 's' : ''}` : ''}`);
        } else {
          contextSummary.push(`Time since last signal: ${minutes} minute${minutes > 1 ? 's' : ''}`);
        }
      } else {
        contextSummary.push(`Last signal: Very recent (within the last minute)`);
      }
    } else if (context.lastSignalAt) {
      contextSummary.push(`Last signal timestamp: ${context.lastSignalAt}`);
    } else if (context.lastSignalTime) {
      contextSummary.push(`Last signal: ${context.lastSignalTime}`);
    }
    
    // Add temporal awareness guidance to prompt
    let temporalGuidance = '';
    if (context.hoursSinceLastSignal !== null && context.hoursSinceLastSignal !== undefined) {
      if (context.hoursSinceLastSignal >= 12) {
        temporalGuidance = `\n\nTemporal context: No trades have fired for ${Math.floor(context.hoursSinceLastSignal)} hours — this usually suggests consolidation or waiting for structure confirmation. Mention this in your analysis if relevant.`;
      } else if (context.hoursSinceLastSignal >= 6) {
        temporalGuidance = `\n\nTemporal context: It's been ${Math.floor(context.hoursSinceLastSignal)} hours since the last signal. The market may be consolidating.`;
      } else if (context.hoursSinceLastSignal >= 1) {
        temporalGuidance = `\n\nTemporal context: Last signal was ${Math.floor(context.hoursSinceLastSignal)} hour${Math.floor(context.hoursSinceLastSignal) > 1 ? 's' : ''} ago.`;
      }
    }
    
    // Dynamic tone blending guidance
    let toneBlendingGuidance = '';
    if (context.toneWeight && context.toneWeight.weight > 0) {
      const scores = context.toneWeight.scores;
      if (scores.cautionary > 0.3 || scores.optimistic > 0.3) {
        toneBlendingGuidance = `\n\nTone blending: The market context suggests a ${context.toneWeight.tone} tone (weight: ${context.toneWeight.weight.toFixed(2)}). Blend this gradually into your response rather than using it as a hard switch.`;
      }
    }

    // Detect signal direction from context for tone matching
    let signalDirection = null;
    if (context.activeSignals && context.activeSignals > 0) {
      // Try to detect direction from trend map or HTF bias
      if (context.htfBias && context.htfBias.direction) {
        signalDirection = context.htfBias.direction;
      } else if (context.trendMap) {
        // Check if trends are mostly up or down
        const trends = Object.values(context.trendMap);
        const upCount = trends.filter(t => t && (t.toLowerCase().includes('up') || t.toLowerCase().includes('bull'))).length;
        const downCount = trends.filter(t => t && (t.toLowerCase().includes('down') || t.toLowerCase().includes('bear'))).length;
        if (upCount > downCount) signalDirection = 'long';
        else if (downCount > upCount) signalDirection = 'short';
      }
    }

    const userPrompt = `${contextSummary.join('\n')}${temporalGuidance}${toneBlendingGuidance}

Based on this context, generate a status update:
${depth === 'short' ? '- Keep it to 1-2 lines maximum' : depth === 'normal' ? '- Write 1-2 paragraphs' : '- Provide detailed multi-section analysis'}

${tone === 'neutral' ? 'Use a balanced, observational tone.' : tone === 'optimistic' ? 'Use a positive, encouraging tone while staying realistic.' : tone === 'cautionary' ? 'Use a warning, careful tone highlighting risks.' : 'Use a confident, assertive tone.'}

${signalDirection ? `IMPORTANT: Match your language to signal direction:
- If signals are LONG: Use bullish language (e.g., "uptrend", "bullish momentum", "buying pressure", "upward movement", "breaking higher")
- If signals are SHORT: Use bearish language (e.g., "downtrend", "bearish momentum", "selling pressure", "downward movement", "breaking lower")
- The tone should reflect the direction of active signals, not just general market conditions` : ''}

${target === 'dashboard' ? 'Format for dashboard overview - concise and actionable.' : target === 'trade-panel' ? 'Format for trade panel - specific to this symbol with actionable insights.' : 'Format for marquee banner - bold, clear trend pulse, very concise.'}

Explain why signals are or aren't appearing. If no signals, explain what needs to happen for signals to trigger.`;

    console.log('📤 Calling OpenAI API for Market Pulse Intelligence...');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: aiContract.AI_MODELS.commentary,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: temperature,
        max_tokens: depth === 'short' ? 100 : depth === 'normal' ? 300 : 600
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ OpenAI API error:', response.status, errorText);
      // Return fallback message instead of error
      return res.status(200).json({
        success: true,
        pulse: `Market data for ${context.symbol} is currently unavailable. Please check again soon.`,
        context: {
          symbol: context.symbol,
          mode: context.mode,
          tone,
          depth,
          target
        },
        timestamp: new Date().toISOString(),
        fallback: true
      });
    }

    const data = await response.json();
    const pulseText = data.choices[0]?.message?.content;

    if (!pulseText) {
      // Return fallback message instead of error
      return res.status(200).json({
        success: true,
        pulse: `Market data for ${context.symbol} is currently unavailable. Please check again soon.`,
        context: {
          symbol: context.symbol,
          mode: context.mode,
          tone,
          depth,
          target
        },
        timestamp: new Date().toISOString(),
        fallback: true
      });
    }

    console.log('✅ Market Pulse Intelligence received:', pulseText.substring(0, 100));

    return res.status(200).json({
      success: true,
      pulse: pulseText.trim(),
      context: {
        symbol: context.symbol,
        mode: context.mode,
        tone,
        depth,
        target
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Market Pulse Intelligence error:', error);
    return res.status(500).json({ 
      error: 'Market Pulse Intelligence failed',
      message: error.message
    });
  }
}

// Market Review Handler (existing - keep for backward compatibility)
/**
 * Fixed, server-side market-review prompt.
 * Replaces the caller-supplied one this handler used to accept.
 */
const MARKET_REVIEW_SYSTEM_PROMPT = `${aiContract.DATA_CONTRACT}

ROLE: You write a concise market review for a trading desk operator.

Given a set of tracked assets and their engine-computed readings, write 1-2
sentences on overall market behaviour and how the assets relate to each other.
Observational, not directive. Quote only figures present in the DATA block. If
the data is thin or degraded, say so instead of generalising.`;

async function handleMarketReview(req, res, tradesData) {
  const systemPrompt = MARKET_REVIEW_SYSTEM_PROMPT;
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

    // serializeDataBlock renders absent fields as "MISSING" rather than
    // letting JSON.stringify drop them, so the model can see what it lacks.
    const userPrompt = `Write a concise 1-2 sentence market review from the data below.

DATA:
${aiContract.serializeDataBlock(tradesData)}

Keep it tight and observational. Quote only numbers present above.`;

    console.log('📤 Calling OpenAI API for market review (using raw fetch)...');

    // Use raw fetch instead of SDK (better Vercel compatibility)
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: aiContract.AI_MODELS.commentary,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: aiContract.clampTemperature(0.3),
        max_tokens: 150
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ OpenAI API error:', response.status, errorText);
      return res.status(500).json({
        error: 'OpenAI API request failed',
        message: `API returned ${response.status}`
      });
    }

    const data = await response.json();
    const review = data.choices[0]?.message?.content;

    if (!review) {
      return res.status(500).json({ 
        error: 'No review from AI' 
      });
    }

    console.log('✅ Market review received:', review);

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

import aiContract from '../services/aiContract.js';

export default async function handler(req, res) {
  console.log('🚀 [AGENT-REVIEW] Handler called');
  console.log('🚀 [AGENT-REVIEW] Method:', req.method);
  
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    console.log('🚀 [AGENT-REVIEW] OPTIONS request, returning 200');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    console.log('🚀 [AGENT-REVIEW] Wrong method, returning 405');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('🚀 [AGENT-REVIEW] POST request received');
    console.log('🚀 [AGENT-REVIEW] Request body exists:', !!req.body);
    console.log('🚀 [AGENT-REVIEW] Request body keys:', Object.keys(req.body || {}));
    const { marketSnapshot, setupType, symbol, tradesData, pulseContext, pulseVariables } = req.body;

    // `systemPrompt` is deliberately NOT read from the request body.
    //
    // It used to be destructured here and passed verbatim as the OpenAI system
    // message. With CORS `*`, no auth and no rate limit, anyone on the internet
    // could set the model's entire instruction set on the operator's API key —
    // which also meant every guardrail on the market-review path was
    // client-side text an attacker could simply replace. Reject the key
    // outright rather than ignoring it, so a stale caller fails loudly.
    if (req.body && 'systemPrompt' in req.body) {
      return res.status(400).json({
        error: 'systemPrompt is not accepted',
        message:
          'The system prompt is fixed server-side. Select behaviour with the `tone` and `depth` variables instead.'
      });
    }
    console.log('🚀 [AGENT-REVIEW] Extracted params:', {
      hasMarketSnapshot: !!marketSnapshot,
      hasSetupType: !!setupType,
      hasSymbol: !!symbol,
      hasTradesData: !!tradesData,
      hasPulseContext: !!pulseContext,
      hasPulseVariables: !!pulseVariables
    });

    // Market Pulse Intelligence mode (new adaptive AI)
    if (pulseContext && pulseVariables) {
      console.log('🧠 [AGENT-REVIEW] Market Pulse Intelligence mode detected');
      return await handleMarketPulse(req, res, pulseContext, pulseVariables);
    }

    // Market review mode (existing - keep for backward compatibility)
    if (tradesData) {
      console.log('🚀 [AGENT-REVIEW] Market review mode detected');
      return await handleMarketReview(req, res, tradesData);
    }

    // Individual trade analysis mode (existing)
    console.log('🚀 [AGENT-REVIEW] Individual trade analysis mode');
    console.log('🚀 [AGENT-REVIEW] Has marketSnapshot:', !!marketSnapshot);
    console.log('🚀 [AGENT-REVIEW] Has setupType:', !!setupType);
    console.log('🚀 [AGENT-REVIEW] Has symbol:', !!symbol);
    console.log('🚀 [AGENT-REVIEW] setupType value:', setupType);
    console.log('🚀 [AGENT-REVIEW] symbol value:', symbol);
    
    if (!marketSnapshot || !setupType || !symbol) {
      console.error('🚀 [AGENT-REVIEW] ❌ Missing required fields');
      console.error('🚀 [AGENT-REVIEW] Missing check:', {
        marketSnapshot: !marketSnapshot,
        setupType: !setupType,
        symbol: !symbol
      });
      return res.status(400).json({ 
        error: 'Missing required fields: marketSnapshot, setupType, symbol OR tradesData' 
      });
    }

    console.log(`🚀 [AGENT-REVIEW] ✅ Analyzing ${symbol} ${setupType} trade...`);

    // Get OpenAI API key from environment variable (same pattern as parse-trade-image.js)
    console.log('🚀 [AGENT-REVIEW] Checking for OPENAI_API_KEY...');
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error('🚀 [AGENT-REVIEW] ❌ OPENAI_API_KEY not found in environment');
      console.error('🚀 [AGENT-REVIEW] Available env vars:', Object.keys(process.env).filter(k => k.includes('OPENAI')));
      return res.status(500).json({ 
        error: 'Server configuration error',
        message: 'OpenAI API key not configured'
      });
    }
    
    console.log('🚀 [AGENT-REVIEW] ✅ API Key found (length:', apiKey.length, ')');

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

    console.log('🚀 [AGENT-REVIEW] Building strategy guidance...');
    const currentGuidance = strategyGuidance[setupType] || strategyGuidance['4h'];
    console.log('🚀 [AGENT-REVIEW] Strategy guidance selected for:', setupType);
    console.log('🚀 [AGENT-REVIEW] Guidance length:', currentGuidance?.length);

    // Construct the system prompt based on the reasoning agent rules
    console.log('🚀 [AGENT-REVIEW] Constructing system prompt...');
    const tradeSystemPrompt = `${aiContract.DATA_CONTRACT}

---

You are the Trading Reasoning Layer for EditTrades.

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

TONE — evidence, not direction:
- Describe what the engine reports and what the supplied inputs show.
- Your confidence must track the quantity and freshness of the supplied
  evidence, NOT the direction of the signal.
- Directional vocabulary is fine when the supplied data supports it. Do not
  adopt a bullish or bearish register merely because the signal has a
  direction.
- If the inputs are thin, degraded, or contradict the signal, say so plainly.
  A well-supported "this long is technically valid but the evidence is thin"
  is a better answer than a confident one.

  (This block previously read: "If the signal direction is LONG, your entire
  analysis should sound bullish." That decoupled tone from evidence by
  instruction — and combined with a payload whose price and per-timeframe
  fields were arriving undefined, it asked for conviction with nothing
  underneath it.)
- If the signal direction is SHORT, your entire analysis should sound bearish

[Opening paragraph: Current setup assessment - is this a good ${setupType.toUpperCase()} trade? State clearly if it's valid or not and why. Use direction-appropriate language (bullish for longs, bearish for shorts).]

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
- Use direction-appropriate language throughout (bullish for longs, bearish for shorts)

[If NO TRADE: Explain what to watch for to make it valid:
- Which timeframes need to change and how
- Specific price levels to monitor (mention actual numbers from the data)
- What conditions need to happen (stoch movements, trend changes, etc.)
- What supplied condition would confirm or invalidate the setup (no timeline: nothing in the data supports predicting when)]

[Closing paragraph: Overall assessment with rating (A+, A, B, or SKIP). Be direct about trade quality. Use direction-appropriate language.]

Important:
- Write like you're talking to a trader, not writing a checklist
- Use natural language and flow between topics
- No bullet points, no dashes, no lists
- Just conversational paragraphs
- Be concise but insightful (3-5 paragraphs total)
- Always mention what to watch for if the trade isn't valid yet
- Match your language tone to the trade direction (bullish for longs, bearish for shorts)`;

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

    console.log('🚀 [AGENT-REVIEW] Building analysis points...');
    const currentPoints = analysisPoints[setupType] || analysisPoints['4h'];
    console.log('🚀 [AGENT-REVIEW] Analysis points selected for:', setupType);

    console.log('🚀 [AGENT-REVIEW] Constructing user prompt...');
    console.log('🚀 [AGENT-REVIEW] Original marketSnapshot size:', JSON.stringify(marketSnapshot).length, 'chars');
    
    // Filter marketSnapshot to only essential fields (avoid sending massive candle arrays)
    // Key names must match what public/index.html actually sends.
    // `createDashboardView()` emits `price`, `change24h` and
    // `signal.confluence`; this filter read `currentPrice`, `priceChange24h`
    // and `analysis`, so all three arrived undefined and JSON.stringify
    // dropped them — the model saw no price at all while being asked for exact
    // price levels. `timeframes` was never copied, so every per-timeframe
    // question in the prompt (15m EMA distance, 5m stoch) referred to data
    // that had been filtered out.
    const essentialSnapshot = {
      symbol: marketSnapshot.symbol || symbol,
      currentPrice: marketSnapshot.price ?? marketSnapshot.currentPrice ?? null,
      priceChange24h: marketSnapshot.change24h ?? marketSnapshot.priceChange24h ?? null,
      signal: marketSnapshot.signal ? {
        direction: marketSnapshot.signal.direction,
        confidence: marketSnapshot.signal.confidence,
        valid: marketSnapshot.signal.valid,
        reason: marketSnapshot.signal.reason,
        entryZone: marketSnapshot.signal.entryZone,
        stopLoss: marketSnapshot.signal.stopLoss,
        targets: marketSnapshot.signal.targets,
        invalidation: marketSnapshot.signal.invalidation
      } : null,
      htfBias: marketSnapshot.htfBias ?? null,
      analysis: marketSnapshot.signal?.confluence ?? marketSnapshot.analysis ?? null,
      timeframes: marketSnapshot.timeframes ?? null,
      macro: marketSnapshot.macro ?? null,
      risk: marketSnapshot.risk ?? null,
      dataHealth: marketSnapshot.dataHealth ?? marketSnapshot.health ?? null
    };
    
    console.log('🚀 [AGENT-REVIEW] Filtered snapshot size:', JSON.stringify(essentialSnapshot).length, 'chars');
    
    const userPrompt = `Analyze this ${setupType.toUpperCase()} setup for ${symbol}:

${JSON.stringify(essentialSnapshot, null, 2)}

Write a conversational analysis (3-5 paragraphs) evaluating:
${currentPoints}

Start by clearly stating whether this is currently a good ${setupType.toUpperCase()} trade or not. Then explain why.

${setupType === 'MicroScalp' ? 
  'Focus ONLY on 1H trend, 15m/5m EMA precision, and stoch alignment. DO NOT mention or evaluate 4H trend - it is completely irrelevant to Micro-Scalp strategy.' :
  'Discuss the trend situation, momentum, stochastic positioning, and entry zone quality. Mention any conflicts between timeframes (HTF vs LTF).'}

Be specific about what's working or what's blocking this setup.

If this is NOT a valid trade, explain what needs to happen to make it valid:
${setupType === 'MicroScalp' ?
  '- Does 1H need to establish a trend (break from FLAT)?\n- Do 15m/5m need to pull back closer to their 21 EMAs? (quote the supplied distances; if not supplied, say so)\n- What stoch movements are needed on 15m and 5m?' :
  '- Which timeframes need to change (e.g., "The 4H needs to break from FLAT and establish a clear UPTREND")\n- Specific price levels to watch (use actual numbers from the data)\n- What conditions need to change (e.g., "The 1H stoch needs to curl up from oversold")\n- Which supplied condition is not yet met (do not estimate how long it will take)'}

Write naturally in flowing paragraphs. No bullet points or lists. Be conversational but insightful.

End with your overall rating: A+, A, B, or SKIP`;

    // Call OpenAI API using fetch (same exact pattern as parse-trade-image.js which works)
    console.log('🚀 [AGENT-REVIEW] 🤖 Step 1: Preparing OpenAI request...');
    console.log('🚀 [AGENT-REVIEW] System prompt length:', tradeSystemPrompt?.length);
    console.log('🚀 [AGENT-REVIEW] User prompt length:', userPrompt?.length);
    
    const requestBody = {
      model: aiContract.AI_MODELS.commentary,
      messages: [
        { role: 'system', content: tradeSystemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 800
    };
    
    console.log('🚀 [AGENT-REVIEW] 🤖 Step 2: Calling OpenAI API...');
    console.log('🚀 [AGENT-REVIEW] Request URL: https://api.openai.com/v1/chat/completions');
    console.log('🚀 [AGENT-REVIEW] Request model:', requestBody.model);
    console.log('🚀 [AGENT-REVIEW] Request messages count:', requestBody.messages.length);
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    console.log('🚀 [AGENT-REVIEW] 🤖 Step 3: Received response');
    console.log('🚀 [AGENT-REVIEW] Response status:', response.status);
    console.log('🚀 [AGENT-REVIEW] Response ok:', response.ok);
    console.log('🚀 [AGENT-REVIEW] Response headers:', Object.fromEntries(response.headers.entries()));

    if (!response.ok) {
      console.error('🚀 [AGENT-REVIEW] ❌ Step 4: Response not OK');
      const errorText = await response.text();
      console.error('🚀 [AGENT-REVIEW] Error text length:', errorText.length);
      console.error('🚀 [AGENT-REVIEW] Error text preview:', errorText.substring(0, 500));
      return res.status(500).json({
        error: 'OpenAI API request failed',
        message: `API returned ${response.status}: ${errorText.substring(0, 200)}`,
        details: 'APIError'
      });
    }

    console.log('🚀 [AGENT-REVIEW] ✅ Step 4: Parsing JSON response...');
    const data = await response.json();
    console.log('🚀 [AGENT-REVIEW] Response data keys:', Object.keys(data || {}));
    console.log('🚀 [AGENT-REVIEW] Choices count:', data.choices?.length);
    
    const agentResponse = data.choices[0]?.message?.content;
    console.log('🚀 [AGENT-REVIEW] Agent response exists:', !!agentResponse);
    console.log('🚀 [AGENT-REVIEW] Agent response length:', agentResponse?.length);

    if (!agentResponse) {
      console.error('🚀 [AGENT-REVIEW] ❌ Step 5: No response content from OpenAI');
      console.error('🚀 [AGENT-REVIEW] Full data object:', JSON.stringify(data, null, 2));
      return res.status(500).json({ 
        error: 'No response from OpenAI',
        message: 'OpenAI returned empty response'
      });
    }
    
    console.log('🚀 [AGENT-REVIEW] ✅ Step 5: Individual trade analysis complete');

    // No grade is scraped out of the model's prose.
    //
    // This used to be a substring match: `.includes('B')` matched any capital
    // B anywhere in the text, so "Bullish structure on BTC. Rating: A" graded
    // as B. Worse, the initial value was 'A', so a response that mentioned no
    // rating at all was emitted as a PASSING grade — and index.html used that
    // grade to colour the trade panel while tracker.html persisted it to
    // Firebase as part of the trade record.
    //
    // Ratings belong to the deterministic engine. The AI is commentary.
    const priority = null;

    return res.status(200).json({
      success: true,
      symbol,
      setupType,
      priority,
      formattedText: agentResponse,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('🚀 [AGENT-REVIEW] ❌ CATCH BLOCK: Error occurred');
    console.error('🚀 [AGENT-REVIEW] Error name:', error.name);
    console.error('🚀 [AGENT-REVIEW] Error message:', error.message);
    console.error('🚀 [AGENT-REVIEW] Error stack:', error.stack);
    console.error('🚀 [AGENT-REVIEW] Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
    
    // Return a graceful JSON error (never HTML) - same pattern as parse-trade-image.js
    return res.status(500).json({ 
      error: 'Failed to analyze trade',
      message: error.message || 'Unknown error occurred. Please try again.',
      details: error.name || 'UnknownError'
    });
  }
}

