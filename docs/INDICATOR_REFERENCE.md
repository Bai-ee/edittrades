# Indicator Reference Catalog

Complete reference for all indicators currently implemented in the system.

## Moving Averages

### EMA21 (21-Period Exponential Moving Average)

**Purpose:** Primary trend indicator and entry zone reference

**Calculation:**
- Period: 21
- Formula: EMA = (Close - EMA_prev) × (2 / (21 + 1)) + EMA_prev
- Library: `technicalindicators.EMA`

**Data Requirements:**
- Minimum candles: 21
- Timeframes: All (1m, 3m, 5m, 15m, 1h, 4h, 1d, 3d, 1w, 1M)

**Object Structure:**
```javascript
{
  ema: {
    ema21: number | null,           // Current value
    ema21History: Array<number>     // Full history
  }
}
```

**Usage in Strategies:**
- Entry zone calculation (price near EMA21)
- Trend detection (price > EMA21 = bullish)
- Pullback state calculation
- Distance measurement for entry timing

**Display Format:**
- Frontend: `$${value.toLocaleString()}`
- JSON: `number | null`

**Access Path:**
```javascript
analysis[tf].indicators.ema.ema21
```

---

### EMA200 (200-Period Exponential Moving Average)

**Purpose:** Long-term trend filter and macro bias indicator

**Calculation:**
- Period: 200
- Formula: EMA = (Close - EMA_prev) × (2 / (200 + 1)) + EMA_prev
- Library: `technicalindicators.EMA`

**Data Requirements:**
- Minimum candles: 200
- Timeframes: All (may be null on lower timeframes with insufficient history)

**Object Structure:**
```javascript
{
  ema: {
    ema200: number | null,          // Current value
    ema200History: Array<number>     // Full history
  }
}
```

**Usage in Strategies:**
- Macro trend detection (EMA21 > EMA200 = uptrend)
- HTF bias calculation
- Long-term structure analysis
- Swing trade validation

**Display Format:**
- Frontend: `$${value.toLocaleString()}`
- JSON: `number | null`

**Access Path:**
```javascript
analysis[tf].indicators.ema.ema200
```

---

## Momentum Indicators

### Stochastic RSI (StochRSI)

**Purpose:** Momentum oscillator for entry timing and overbought/oversold detection

**Calculation:**
- RSI Period: 14
- Stochastic Period: 14
- %K Period: 3
- %D Period: 3
- Library: `technicalindicators.StochasticRSI`

**Data Requirements:**
- Minimum candles: 28 (14 + 14)
- Timeframes: All

**Object Structure:**
```javascript
{
  stochRSI: {
    k: number | null,              // %K value (0-100, clamped)
    d: number | null,              // %D value (0-100, clamped)
    condition: string,             // 'OVERBOUGHT' | 'OVERSOLD' | 'BULLISH' | 'BEARISH' | 'NEUTRAL'
    history: Array<{k: number, d: number}>
  }
}
```

**Condition Logic:**
- `OVERBOUGHT`: k > 80 AND d > 80
- `OVERSOLD`: k < 20 AND d < 20
- `BULLISH`: k > d (and not overbought/oversold)
- `BEARISH`: k < d (and not overbought/oversold)
- `NEUTRAL`: Default state

**Usage in Strategies:**
- Entry timing (wait for oversold in uptrend, overbought in downtrend)
- Momentum confirmation
- Lower timeframe alignment
- Exhaustion detection

**Display Format:**
- Frontend: `K: ${k.toFixed(1)} | D: ${d.toFixed(1)}` with condition badge
- JSON: `{ k: number, d: number, state: string }`

**Access Path:**
```javascript
analysis[tf].indicators.stochRSI
```

**Curl Detection (Frontend):**
The frontend calculates "curl" direction by comparing current k/d to previous values:
- `up`: k increasing, d increasing
- `down`: k decreasing, d decreasing
- `flat`: no clear direction

---

## Derived Indicators

### Trend

**Purpose:** Overall market direction based on EMA alignment

**Calculation:**
Derived from price and EMA relationship:
- `UPTREND`: price > EMA21 > EMA200
- `DOWNTREND`: price < EMA21 < EMA200
- `FLAT`: Neither condition met

**Data Requirements:**
- Requires: EMA21 and EMA200 (both must be non-null)

**Object Structure:**
```javascript
{
  analysis: {
    trend: 'UPTREND' | 'DOWNTREND' | 'FLAT'
  }
}
```

**Usage in Strategies:**
- Primary direction filter
- Entry validation (only trade with trend)
- Confidence scoring
- HTF bias calculation

**Display Format:**
- Frontend: Badge with color coding (green=uptrend, red=downtrend, gray=flat)
- JSON: `string` (lowercase in exports)

**Access Path:**
```javascript
analysis[tf].indicators.analysis.trend
```

**Normalization:**
The `normalizeTrend()` function in `services/strategy.js` converts all variations to lowercase:
- "UPTREND", "uptrend", "UP" → "uptrend"
- "DOWNTREND", "downtrend", "DOWN" → "downtrend"
- Everything else → "flat"

---

### Pullback State

**Purpose:** Identifies price position relative to 21 EMA for entry timing

**Calculation:**
Based on distance from 21 EMA:
```javascript
distanceFrom21EMA = ((currentPrice - ema21) / ema21) * 100
```

**States:**
- `ENTRY_ZONE`: |distance| < 0.5% (price at EMA21)
- `RETRACING`: 0.5% ≤ |distance| ≤ 3% (approaching EMA21)
- `OVEREXTENDED`: |distance| > 3% (far from EMA21)
- `UNKNOWN`: EMA21 not available

**Data Requirements:**
- Requires: EMA21

**Object Structure:**
```javascript
{
  analysis: {
    pullbackState: 'ENTRY_ZONE' | 'RETRACING' | 'OVEREXTENDED' | 'UNKNOWN',
    distanceFrom21EMA: number | null  // Percentage
  }
}
```

**Usage in Strategies:**
- Entry zone validation
- Confidence scoring (ENTRY_ZONE = higher confidence)
- Trade timing
- Risk assessment

**Display Format:**
- Frontend: Badge with state name + distance percentage
- JSON: `{ state: string, distanceFrom21EMA: number | null }`

**Access Path:**
```javascript
analysis[tf].indicators.analysis.pullbackState
analysis[tf].indicators.analysis.distanceFrom21EMA
```

---

## Market Structure

### Swing Points

**Purpose:** Identifies recent swing highs and lows for support/resistance

**Calculation:**
- Lookback: 20 candles (default)
- Swing High: Maximum high in lookback period
- Swing Low: Minimum low in lookback period

**Data Requirements:**
- Minimum candles: 20 (or specified lookback)

**Object Structure:**
```javascript
{
  structure: {
    swingHigh: number | null,
    swingLow: number | null
  }
}
```

**Usage in Strategies:**
- Stop loss placement
- Target calculation
- Invalidation levels
- Risk/reward assessment

**Display Format:**
- Frontend: `Swing High: $${value}` / `Swing Low: $${value}`
- JSON: `{ swingHigh: number | null, swingLow: number | null }`

**Access Path:**
```javascript
analysis[tf].structure.swingHigh
analysis[tf].structure.swingLow
```

**Note:** Calculated separately from indicators via `detectSwingPoints()` function.

---

## Price Data

### Current Price

**Purpose:** Most recent close price

**Object Structure:**
```javascript
{
  price: {
    current: number,    // Last close price
    high: number,       // Highest high in dataset
    low: number         // Lowest low in dataset
  }
}
```

**Note:** VWAP and trade count are available in raw candle data from Kraken but are not currently stored in the indicator object structure.

**Access Path:**
```javascript
analysis[tf].indicators.price.current
```

---

## Indicator Access Patterns

### In Strategy Evaluation

```javascript
// Get 4H timeframe data
const tf4h = analysis['4h'];

// Access indicators
const ema21 = tf4h.indicators.ema.ema21;
const ema200 = tf4h.indicators.ema.ema200;
const trend = tf4h.indicators.analysis.trend;
const stoch = tf4h.indicators.stochRSI;
const pullbackState = tf4h.indicators.analysis.pullbackState;
const distanceFrom21EMA = tf4h.indicators.analysis.distanceFrom21EMA;
```

### In Frontend Display

```javascript
// In createDetailsRow() - timeframe card
const ind = analysis.indicators;
const ema21 = ind.ema?.ema21 || null;
const trend = ind.analysis?.trend || 'UNKNOWN';
const stoch = ind.stochRSI || {};
```

### In JSON Export

```javascript
// In buildRichSymbolFromScanResults()
timeframes[tf] = {
  trend: tfData.indicators.analysis?.trend || 'UNKNOWN',
  ema21: tfData.indicators.ema?.ema21 || null,
  ema200: tfData.indicators.ema?.ema200 || null,
  stochRsi: {
    k: tfData.indicators.stochRSI?.k || null,
    d: tfData.indicators.stochRSI?.d || null,
    state: /* calculated state */
  }
};
```

## Indicator Dependencies

Some indicators depend on others:

- **Trend** requires: EMA21, EMA200
- **Pullback State** requires: EMA21
- **StochRSI Condition** requires: StochRSI k and d values

Always check for null values when using dependent indicators.

## Adding New Indicators

When adding a new indicator:

1. Add calculation function to `services/indicators.js`
2. Integrate into `calculateAllIndicators()`
3. Update this reference document
4. Add to frontend display
5. Add to JSON exports
6. Update strategy logic (if applicable)

See `ADDING_INDICATORS.md` for detailed instructions.

