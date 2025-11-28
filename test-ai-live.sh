#!/bin/bash

# Test AI Agent on Live Vercel Deployment

echo "🧪 Testing AI Reasoning Agent on Live Site..."
echo ""

BASE_URL="https://snapshottradingview-ggr7v5xbw-baiees-projects.vercel.app"
SYMBOL="BTCUSDT"
SETUP_TYPE="4h"

# Step 1: Fetch market data
echo "📊 Fetching market data for ${SYMBOL}..."
MARKET_DATA=$(curl -s "${BASE_URL}/api/analyze/${SYMBOL}?intervals=4h,1h,15m,5m")

if [ $? -ne 0 ]; then
  echo "❌ Failed to fetch market data"
  exit 1
fi

echo "✅ Market data fetched"
echo ""

# Step 2: Create simplified test payload
echo "🤖 Sending to AI Agent for ${SETUP_TYPE} analysis..."
echo ""

# Create test request
TEST_REQUEST=$(cat <<EOF
{
  "symbol": "${SYMBOL}",
  "setupType": "${SETUP_TYPE}",
  "marketSnapshot": ${MARKET_DATA}
}
EOF
)

# Step 3: Call agent endpoint
echo "⏳ Waiting for AI response (this may take 3-10 seconds)..."
echo ""

AGENT_RESPONSE=$(curl -s -X POST "${BASE_URL}/api/agent-review" \
  -H "Content-Type: application/json" \
  -d "${TEST_REQUEST}")

# Check for errors
if echo "$AGENT_RESPONSE" | grep -q '"error"'; then
  echo "❌ AI Agent Error:"
  echo "$AGENT_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$AGENT_RESPONSE"
  echo ""
  exit 1
fi

# Check for success
if echo "$AGENT_RESPONSE" | grep -q '"success".*true'; then
  echo "✅✅✅ AI AGENT IS WORKING! ✅✅✅"
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
" 2>/dev/null
  
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "🎉 AI Reasoning Agent is fully operational!"
  echo ""
  echo "✅ Test it in the browser:"
  echo "   ${BASE_URL}"
  echo ""
else
  echo "⚠️ Unexpected response:"
  echo "$AGENT_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$AGENT_RESPONSE"
fi

