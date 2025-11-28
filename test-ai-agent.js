/**
 * Test script for AI Reasoning Agent
 * 
 * This script tests the agent endpoint locally by:
 * 1. Fetching market data from /api/analyze
 * 2. Sending it to /api/agent-review
 * 3. Displaying the AI's response
 */

const fetch = require('node-fetch');

const BASE_URL = 'http://localhost:3000';
const SYMBOL = 'BTCUSDT';
const SETUP_TYPE = 'Swing';

async function testAIAgent() {
  console.log('🧪 Testing AI Reasoning Agent...\n');
  
  try {
    // Step 1: Fetch market data
    console.log(`📊 Fetching market data for ${SYMBOL}...`);
    const analyzeUrl = `${BASE_URL}/api/analyze/${SYMBOL}?intervals=1M,1w,3d,1d,4h,1h,15m,5m,1m`;
    
    const analyzeResponse = await fetch(analyzeUrl);
    if (!analyzeResponse.ok) {
      throw new Error(`Failed to fetch market data: ${analyzeResponse.status}`);
    }
    
    const marketData = await analyzeResponse.json();
    console.log('✅ Market data fetched successfully\n');
    
    // Create the market snapshot (same as COPY GPT button)
    const marketSnapshot = {
      symbol: marketData.symbol,
      price: marketData.currentPrice,
      change24h: marketData.priceChange24h,
      signal: marketData.tradeSignal,
      timeframes: {},
      timestamp: marketData.timestamp
    };
    
    // Add timeframe data
    const timeframes = ['1m', '5m', '15m', '1h', '4h', '1d', '3d', '1w', '1M'];
    for (const tf of timeframes) {
      if (marketData.analysis && marketData.analysis[tf]) {
        const tfData = marketData.analysis[tf];
        marketSnapshot.timeframes[tf] = {
          trend: tfData.indicators?.analysis?.trend,
          ema21: tfData.indicators?.ema?.ema21,
          ema200: tfData.indicators?.ema?.ema200,
          stoch: tfData.indicators?.stochRSI,
          pullback: tfData.indicators?.pullback,
          swingHigh: tfData.structure?.swingHigh,
          swingLow: tfData.structure?.swingLow
        };
      }
    }
    
    console.log(`🤖 Sending to AI Agent for ${SETUP_TYPE} analysis...`);
    console.log(`📍 API Key present: ${process.env.OPENAI_API_KEY ? 'YES ✅' : 'NO ❌'}\n`);
    
    // Step 2: Send to AI agent
    const agentUrl = `${BASE_URL}/api/agent-review`;
    const agentResponse = await fetch(agentUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        symbol: SYMBOL,
        setupType: SETUP_TYPE,
        marketSnapshot
      })
    });
    
    if (!agentResponse.ok) {
      const errorData = await agentResponse.json();
      throw new Error(`Agent API failed: ${agentResponse.status} - ${JSON.stringify(errorData)}`);
    }
    
    const agentResult = await agentResponse.json();
    
    // Step 3: Display results
    console.log('✅ AI Analysis Complete!\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📈 Symbol: ${agentResult.symbol}`);
    console.log(`📊 Setup Type: ${agentResult.setupType}`);
    console.log(`⭐ Priority: ${agentResult.priority}`);
    console.log(`⏰ Timestamp: ${new Date(agentResult.timestamp).toLocaleString()}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    console.log('📝 AI ANALYSIS:\n');
    console.log(agentResult.formattedText);
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    console.log('\n✅ Test completed successfully!');
    console.log('🎉 AI Agent is working correctly and ready to deploy!\n');
    
  } catch (error) {
    console.error('\n❌ Test Failed!\n');
    console.error('Error:', error.message);
    
    if (error.message.includes('OPENAI_API_KEY')) {
      console.error('\n💡 Tip: Make sure .env file exists with OPENAI_API_KEY');
    }
    
    if (error.message.includes('Failed to fetch')) {
      console.error('\n💡 Tip: Make sure local server is running on port 3000');
      console.error('   Run: npm start');
    }
    
    console.error('');
    process.exit(1);
  }
}

// Run the test
testAIAgent();

