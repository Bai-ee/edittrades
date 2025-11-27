# Changelog

## [Latest] - 2025-11-27

### 📊 Professional Trading Indicators - VWAP, ATR, Bollinger, MA Stack

- **VWAP (Volume Weighted Average Price)** - Intraday timeframes (5m, 15m, 1h):
  - Value and distance percentage
  - Above/below detection and bias direction
  - AtVWAP flag (within 0.2%)
  - Reversion zone detection (> 2% away)
  - Trapped longs/shorts positioning logic
  
- **ATR (Average True Range)** - All timeframes:
  - ATR value and percentage of price
  - Volatility state classification (LOW/NORMAL/HIGH)
  - Guides position sizing and stop-loss placement
  
- **Bollinger Bands** - 4h, 1h, 15m:
  - Upper, middle, lower bands
  - Band width percentage
  - Squeeze detection (bandwidth < 2%)
  - Price position percentage (0-100 scale)
  - Overbought/oversold zones
  
- **MA Stack Analysis** - 4h & 1h:
  - EMA 50 added to existing 21 & 200
  - Bull/Bear/Flat stack detection
  - Trend structure confirmation
  
- **New Module**: `lib/advancedIndicators.js` with all calculations
- **Documentation**: `ADVANCED_INDICATORS_GUIDE.md` - Complete usage guide with thresholds

### 🎯 Advanced Candle Analysis & Price Action
- **Candle Metrics** (all timeframes):
  - Direction: bull/bear/doji
  - Body percentage (0-100%)
  - Upper/lower wick percentages
  - Close position within range
  - EMA21 relationship (above/below)
  - Full OHLC range

- **Price Action Patterns** (all timeframes):
  - Rejection Up/Down (wick-based reversals)
  - Engulfing Bull/Bear patterns
  - Inside Bar detection
  - Pattern detection from last 2 candles

- **Support & Resistance Levels** (4h & 1h only):
  - Nearest resistance/support prices
  - Distance to levels (percentage)
  - At level detection (within 0.5%)
  - Break detection (closed through level)

- **Recent Candles** (5m only):
  - Last 5 candles for LLM context
  - OHLC for each candle
  - Ordered oldest → newest

- **UI Updates**:
  - Removed colors from prices (EMAs, Swing High/Low)
  - Only trend indicators keep colors (UPTREND/DOWNTREND/FLAT)
  - Cleaner, more minimal appearance

- **New Modules**:
  - `lib/candleFeatures.js` - Candle analysis and pattern detection
  - `lib/levels.js` - Support/resistance calculation
  
- **Documentation**: `ENRICHED_SCHEMA.md` - Complete field reference and examples

### 📊 Expandable Detailed Timeframe Analysis
- **Show/Hide Details**: Click "Show" button on any coin to expand full timeframe breakdown
- **4 Detailed Cards**: Each timeframe (4h, 1h, 15m, 5m) displays:
  - Current Price
  - 21 EMA & 200 EMA
  - Stoch RSI (%K, %D, condition)
  - Pullback State (with distance from 21 EMA)
  - Swing High & Swing Low
  - Trend badge (color-coded border)
- **Responsive Grid**: 1 column on mobile, 2 on tablet, 4 on desktop
- **Color Indicators**: Green border for uptrend, red for downtrend, gray for flat
- **Collapsible**: Click "Hide" to collapse details and keep table compact

### 🚀 Auto-Run Homepage + Detailed Table View
- **Auto-Scan on Load**: Homepage automatically scans BTC, ETH, SOL on page load (no button click needed)
- **Detailed Table View**: Shows full trading info (price, signal, confidence, entry, stop loss, targets, timeframes)
- **Responsive Columns**: Hide less important columns on mobile (Entry on SM, Stop on MD, Targets on LG)
- **Click Row for Details**: Click any row to see full analysis in popup
- **Individual Copy**: Copy button for each coin in table
- **Copy All**: Export all 3 coins together
- **Unified UI**: Scanner page now matches homepage styling
- **Parallel Fetching**: All 3 coins fetched simultaneously (~3-4 seconds total)
- **Timeframe Badges**: Compact indicators showing trend for 4h, 1h, 15m, 5m

### 🎨 Major UI Redesign - Mobile-First Dark Theme
- **New Homepage**: Single-button scan for BTC, ETH, SOL
- **Dark Theme**: Pure black/off-white color scheme, no gradients or glows
- **Mobile-First**: Optimized for phone screens, minimal scrolling
- **Multi-Coin View**: Display all 3 coins in compact cards
- **Trade Opportunities Summary**: Quick overview of valid setups
- **Individual Copy Buttons**: Copy each coin separately
- **Copy All**: Export all 3 coins in single JSON
- **Compact Timeframe Display**: 2x2 grid on mobile, 4x1 on desktop
- **Visual Indicators**: Green/red left borders on cards with valid trades
- **Documentation**: `NEW_UI_GUIDE.md` with full design specs

### 📊 Added - Dashboard View JSON Copy Button
- **New Button**: 📊 View - Copies exactly what's displayed on dashboard as compact JSON
- **Auto-syncs**: Automatically includes any new fields we add to the dashboard
- **Size**: ~2-3KB (smaller than full API, includes all timeframes unlike LLM compact)
- **Use Cases**: Sharing analysis, trading journals, documentation, historical review
- **Documentation**: `DASHBOARD_VIEW_JSON.md` with examples and field reference

## [Previous] - 2025-11-27

### 🤖 Added - Compact API for LLM/ChatGPT Integration
- **New Endpoint**: `/api/analyze-compact/{symbol}` - Streamlined API response optimized for LLM ingestion
- **Size Reduction**: 99.75% smaller (470 bytes vs 192KB) - perfect for ChatGPT token limits
- **UI Integration**: Added 🤖 LLM button to dashboard and scanner for one-click copy to clipboard
- **Documentation**: 
  - `COMPACT_SCHEMA.md` - Complete JSON schema and field reference
  - `LLM_QUICK_START.md` - Quick start guide with ChatGPT prompt templates

### 🐛 Fixed - Mobile Error
- Added defensive null checks for `data.analysis` to prevent `Object.entries` error on mobile devices
- Enhanced error logging for better debugging across devices

### 📊 Features
- Compact response includes all essential trading data:
  - Trade signal (valid/invalid)
  - Direction (long/short/NO_TRADE)
  - Confidence score (0-100%)
  - Entry zone, stop loss, targets
  - Risk/reward ratio
  - 4H and 1H trend analysis
  - Key indicators (EMA21, EMA200, Stoch RSI)
  - Market structure (swing high/low)

### 📝 What's Removed (for size optimization)
- Raw candlestick OHLCV data
- 15m and 5m timeframe data
- Verbose nested indicator objects
- Debug information
- Redundant metadata

---

## Previous Updates

### 2025-11-26 - Copy Buttons for API Data
- Added copy-to-clipboard functionality for API endpoints
- Added copy buttons for full JSON responses
- Visual feedback for successful copies

### 2025-11-25 - Vercel Deployment
- Migrated from Express server to Vercel serverless functions
- Created `/api/analyze`, `/api/indicators`, `/api/scan` endpoints
- Added deployment protection configuration
- Fixed routing issues for path parameters

### Initial Release
- 4H Set & Forget trading strategy automation
- Multi-timeframe analysis (4h, 1h, 15m, 5m)
- Market scanner for finding opportunities
- Technical indicators: EMA, Stoch RSI, market structure
- Confidence scoring system

