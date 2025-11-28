/**
 * EditTrades AI Reasoning Agent
 * 
 * This serverless function sends market JSON to ChatGPT for trade analysis
 * and returns a formatted trade call with reasoning.
 */

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
    const { marketSnapshot, setupType, symbol } = req.body;

    if (!marketSnapshot || !setupType || !symbol) {
      return res.status(400).json({ 
        error: 'Missing required fields: marketSnapshot, setupType, symbol' 
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

    // Construct the system prompt based on the reasoning agent rules
    const systemPrompt = `You are the Trading Reasoning Layer for EditTrades.

Your job:
- Analyze EditTrades' JSON snapshot for ${setupType} setup
- Apply the Swing / 4H / Scalp / Micro-Scalp rules exactly as defined
- Use higher-level reasoning (momentum, HTF conflict, invalidation integrity)
- Add confluence checks
- Determine if the trade should be taken
- Create a clean human-readable trade call
- Provide analysis that adds value beyond the raw data

Rules:
1. Never override numerical fields from EditTrades (entry, stop, tp1/2/3)
2. You may critique a trade if conditions contradict best practices
3. Use this exact formatting for the trade call:

${symbol} — [LONG/SHORT/NO TRADE] (${setupType})

Confidence: XX%
Direction: 🟢⬆️ / 🔴⬇️ / ⚪
Setup Type: ${setupType}

ENTRY:
$X – $Y

STOP LOSS:
$X – $Y

TARGETS:
TP1: $X
TP2: $X
TP3: $X (if applicable)

RISK / REWARD:
XR (X% risk → X% reward)

INVALIDATION:
[Explain the precise level and what conditions break the setup]

WHY THIS TRADE:
– [Key confluence point 1]
– [Key confluence point 2]
– [Key confluence point 3]
– [Key confluence point 4]

CONDITIONS REQUIRED:
– [Condition 1]
– [Condition 2]
– [Condition 3]

AGENT ANALYSIS:
[Your reasoning about whether this is a high-quality setup, any concerns, momentum assessment, HTF bias, etc.]

4. Be concise but insightful
5. Focus on adding value beyond the raw indicators`;

    const userPrompt = `Analyze this ${setupType} setup for ${symbol}:

${JSON.stringify(marketSnapshot, null, 2)}

Provide your analysis in the exact format specified, adding reasoning about:
- HTF vs LTF alignment quality
- Momentum strength
- Stochastic positioning quality
- Entry zone cleanliness
- Any red flags or concerns
- Overall trade quality (A+, A, B, or SKIP)`;

    // Call OpenAI API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
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

