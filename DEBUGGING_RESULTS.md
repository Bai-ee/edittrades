# Debugging Results: Advanced Modules Missing in Export

> **Legacy (Nov–Dec 2025).** Not updated for the September 2026 scalp-context engine (payload schema 1.10.0). Current docs: [docs/DOCUMENTATION_INDEX.md](./docs/DOCUMENTATION_INDEX.md).

## ✅ CONFIRMED: API Returns All Advanced Modules

**Test Result:** Local API test confirms `/api/analyze-full` returns ALL advanced modules:
- ✅ marketStructure: PRESENT
- ✅ volatility: PRESENT  
- ✅ volumeProfile: PRESENT
- ✅ liquidityZones: PRESENT
- ✅ fairValueGaps: PRESENT
- ✅ divergences: PRESENT

**Location:** `/api/analyze-full?symbol=BTCUSDT&mode=STANDARD`

## ❌ ROOT CAUSE: Frontend Export Function

**Problem:** `copyCoinView()` function uses `buildRichSymbolFromScanResults()` which:
1. Only builds a `timeframes` summary (not full analysis)
2. Was missing the `analysis` object in its return value
3. Doesn't preserve advanced modules from `richSymbol.analysis`

**Location:** `public/index.html` line 4958-5015

## 🔧 FIXES APPLIED

### Fix 1: Updated `copyCoinView()` to use richSymbol with full analysis
- Now checks if `scanData.richSymbol` exists with full `analysis` object
- Falls back to `buildRichSymbolFromScanResults()` only if needed
- Ensures `analysis` object is included in `signalSnapshot`

### Fix 2: Updated `buildRichSymbolFromScanResults()` to include analysis
- Now extracts `analysis` from `data.richSymbol?.analysis || data.analysis`
- Includes `analysis` object in return value (was missing before)

## 📋 TESTING INSTRUCTIONS

1. **Restart server** (if needed):
   ```bash
   npm start
   ```

2. **Clear browser cache** and reload frontend

3. **Run scan** to populate `scanResults` with `richSymbol` data

4. **Click COPY** on any coin

5. **Verify exported JSON** contains:
   - `analysis` object at top level
   - Each timeframe in `analysis` has:
     - `marketStructure`
     - `volatility`
     - `volumeProfile`
     - `liquidityZones`
     - `fairValueGaps`
     - `divergences`

## 🔍 VERIFICATION

The exported JSON should have this structure:
```json
{
  "symbol": "BTCUSDT",
  "mode": "SAFE",
  "currentPrice": 89292.6,
  "htfBias": {...},
  "timeframes": {...},
  "analysis": {
    "1M": {
      "indicators": {...},
      "structure": {...},
      "marketStructure": {...},  // ✅ Should be present
      "volatility": {...},       // ✅ Should be present
      "volumeProfile": {...},    // ✅ Should be present
      "liquidityZones": [...],   // ✅ Should be present
      "fairValueGaps": [...],    // ✅ Should be present
      "divergences": [...]       // ✅ Should be present
    },
    ...
  },
  "strategies": {...},
  "signalSnapshot": {...}
}
```

## ⚠️ IMPORTANT NOTES

- The `analysis` object comes from the API response (`/api/analyze-full`)
- It's stored in `scanResults[symbol].richSymbol.analysis` during scan
- If scan hasn't run yet, `copyCoinView` will use fallback (may be missing advanced modules)
- **Solution:** Always run scan first, or make `copyCoinView` fetch from API directly

## 🚀 NEXT STEPS (Optional Enhancement)

Consider making `copyCoinView` fetch directly from API if `richSymbol` is not available:
```javascript
// If richSymbol not in scanResults, fetch from API
if (!richSymbol || !richSymbol.analysis) {
  const response = await fetch(`/api/analyze-full?symbol=${symbol}&mode=${currentMode}`);
  signalSnapshot = await response.json();
}
```

This ensures advanced modules are always present, even if scan hasn't run.
