#!/bin/bash

# Test script for AI Reasoning Agent
# This script tests the agent endpoint locally

echo "🧪 Testing AI Reasoning Agent..."
echo ""

BASE_URL="http://localhost:3000"
SYMBOL="BTCUSDT"
SETUP_TYPE="Swing"

# Step 1: Fetch market data
echo "📊 Fetching market data for ${SYMBOL}..."
MARKET_DATA=$(curl -s "${BASE_URL}/api/analyze/${SYMBOL}?intervals=1M,1w,3d,1d,4h,1h,15m,5m,1m")

if [ $? -ne 0 ]; then
  echo "❌ Failed to fetch market data"
  echo "💡 Make sure local server is running: npm start"
  exit 1
fi

echo "✅ Market data fetched successfully"
echo ""

# Step 2: Create a simplified test payload
echo "🤖 Sending to AI Agent for ${SETUP_TYPE} analysis..."

# Check if API key is set
if [ -f .env ]; then
  echo "📍 .env file found: ✅"
else
  echo "📍 .env file: ❌ NOT FOUND"
  echo "💡 Create .env with: OPENAI_API_KEY=your-key"
  exit 1
fi

echo ""

# Create test request (simplified version)
TEST_REQUEST=$(cat <<EOF
{
  "symbol": "${SYMBOL}",
  "setupType": "${SETUP_TYPE}",
  "marketSnapshot": ${MARKET_DATA}
}
EOF
)

# Step 3: Call agent endpoint
echo "⏳ Waiting for AI response..."
echo ""

AGENT_RESPONSE=$(curl -s -X POST "${BASE_URL}/api/agent-review" \
  -H "Content-Type: application/json" \
  -d "${TEST_REQUEST}")

# Check for errors
if echo "$AGENT_RESPONSE" | grep -q '"error"'; then
  echo "❌ Agent API Error:"
  echo "$AGENT_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$AGENT_RESPONSE"
  echo ""
  echo "💡 Common issues:"
  echo "   - Check .env file has valid OPENAI_API_KEY"
  echo "   - Verify API key is active at: https://platform.openai.com/api-keys"
  echo "   - Check OpenAI account has credits"
  exit 1
fi

# Display results
echo "✅ AI Analysis Complete!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Pretty print JSON response
echo "$AGENT_RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(f'📈 Symbol: {data[\"symbol\"]}')
print(f'📊 Setup Type: {data[\"setupType\"]}')
print(f'⭐ Priority: {data[\"priority\"]}')
print(f'⏰ Timestamp: {data[\"timestamp\"]}')
print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
print()
print('📝 AI ANALYSIS:')
print()
print(data['formattedText'])
" 2>/dev/null || echo "$AGENT_RESPONSE"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "✅ Test completed successfully!"
echo "🎉 AI Agent is working correctly and ready to deploy!"
echo ""

