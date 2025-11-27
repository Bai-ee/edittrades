# Changelog

## [Latest] - 2025-11-27

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

