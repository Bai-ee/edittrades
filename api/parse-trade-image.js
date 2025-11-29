/**
 * Parse trade details from an uploaded image using OpenAI Vision API
 * Uses raw fetch instead of SDK for better serverless compatibility
 */

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Check for API key
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error('❌ OPENAI_API_KEY not found in environment');
      return res.status(500).json({ 
        error: 'Server configuration error',
        message: 'OpenAI API key not configured'
      });
    }

    const { imageData } = req.body;

    if (!imageData) {
      return res.status(400).json({ error: 'No image data provided' });
    }

    console.log('🖼️ Parsing trade image with OpenAI Vision...');

    // Call OpenAI Vision API using fetch (better serverless compatibility)
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `You are a trading assistant. Analyze this trading screenshot and extract the following information:
              
- Symbol/Coin (e.g., BTC, ETH, SOL) - return as BTCUSDT, ETHUSDT, or SOLUSDT
- Direction (LONG or SHORT)
- Entry Price (numeric value)
- Stop Loss (numeric value)

Return ONLY a JSON object with these exact keys: symbol, direction, entry, stopLoss

If you cannot determine a value with confidence, use null for that field.

Example response format:
{
  "symbol": "BTCUSDT",
  "direction": "LONG",
  "entry": 42000,
  "stopLoss": 41000
}

Be precise with numbers. Do not include any markdown formatting or explanation, just the raw JSON object.`
              },
              {
                type: 'image_url',
                image_url: {
                  url: imageData
                }
              }
            ]
          }
        ],
        max_tokens: 300,
        temperature: 0.1
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ OpenAI API error:', response.status, errorText);
      return res.status(500).json({
        error: 'OpenAI API request failed',
        message: `API returned ${response.status}: ${errorText.substring(0, 200)}`,
        details: 'APIError'
      });
    }

    const result = await response.json();
    const content = result.choices[0]?.message?.content;
    
    if (!content) {
      return res.status(500).json({ 
        error: 'No response from OpenAI',
        message: 'OpenAI returned empty response'
      });
    }

    console.log('📋 Raw response:', content);

    // Parse the JSON response
    let tradeData;
    try {
      // Remove any markdown code blocks if present
      const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      tradeData = JSON.parse(cleanContent);
    } catch (parseError) {
      console.error('Failed to parse OpenAI response:', content);
      return res.status(500).json({ 
        error: 'Failed to parse trade data from image',
        message: 'Could not extract structured data from the image. Try a clearer screenshot.'
      });
    }

    // Validate extracted data
    if (!tradeData.symbol && !tradeData.direction && !tradeData.entry && !tradeData.stopLoss) {
      return res.status(400).json({ 
        error: 'Could not extract trade information from image',
        message: 'Please ensure the image clearly shows the coin, direction, entry price, and stop loss'
      });
    }

    console.log('✅ Extracted trade data:', tradeData);

    return res.status(200).json({
      success: true,
      data: tradeData
    });

  } catch (error) {
    console.error('❌ Error parsing trade image:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    
    // Return a graceful JSON error (never HTML)
    return res.status(500).json({ 
      error: 'Failed to analyze image',
      message: error.message || 'Unknown error occurred. Please try again.',
      details: error.name || 'UnknownError'
    });
  }
}
