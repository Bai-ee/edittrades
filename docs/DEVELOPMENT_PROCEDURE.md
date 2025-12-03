# Development Procedure Guide

**Purpose:** Standardized order of operations for enhancing trade calls while avoiding common development pitfalls.

**Last Updated:** 2025-01-27  
**Version:** 1.0.0

---

## Table of Contents

1. [Pre-Development Checklist](#pre-development-checklist)
2. [Development Workflow](#development-workflow)
3. [Common Pitfalls & Solutions](#common-pitfalls--solutions)
4. [Testing Requirements](#testing-requirements)
5. [Deployment Checklist](#deployment-checklist)
6. [Documentation Updates](#documentation-updates)

---

## Pre-Development Checklist

### Before Making Any Changes

1. **✅ Review Current System State**
   - Read `docs/SYSTEM_CONTEXT.md` - Complete system reference
   - Review `docs/STRATEGY_IMPLEMENTATION_GUIDE.md` - Current strategy logic
   - Check `docs/STRATEGY_MODES.md` - STANDARD vs AGGRESSIVE differences
   - Understand `docs/SYSTEM_WORKFLOW.md` - Data flow and element impact

2. **✅ Verify Data Paths**
   - **CRITICAL:** Always use correct data access paths:
     ```javascript
     // CORRECT:
     analysis[tf].indicators.analysis.trend
     analysis[tf].indicators.analysis.pullbackState
     analysis[tf].indicators.ema.ema21
     
     // WRONG (will break):
     analysis[tf].indicators.trend
     analysis[tf].pullbackState
     ```
   - Reference `docs/SYSTEM_CONTEXT.md` section "Data Access Paths"

3. **✅ Understand Current Behavior**
   - Test locally with `test-strategy-override.js` or similar
   - Review recent commits for context
   - Check `docs/STRATEGY_SYSTEM_AUDIT.md` for system architecture

4. **✅ Plan Changes**
   - Document what you're changing and why
   - Identify affected files and functions
   - Consider impact on both STANDARD and AGGRESSIVE modes
   - Plan rollback strategy if needed

---

## Development Workflow

### Step 1: Local Testing Setup

```bash
# 1. Ensure you're on latest main branch
git checkout main
git pull origin main

# 2. Create a test branch
git checkout -b feature/your-feature-name

# 3. Set up local test environment
# Use test-strategy-override.js or create new test file
```

### Step 2: Make Changes

**Order of Operations:**

1. **Update Core Logic First** (`services/strategy.js`)
   - Add null guards for all data access
   - Implement new logic with proper error handling
   - Use existing helper functions (`calculateEntryZone`, `calculateSLTP`, `computeHTFBias`)
   - Follow existing code patterns

2. **Add Null Guards (CRITICAL)**
   ```javascript
   // ALWAYS use this pattern for htfBias:
   let htfBiasRaw = null;
   try {
     htfBiasRaw = computeHTFBias(multiTimeframeData);
   } catch (biasError) {
     console.error(`[functionName] ${symbol} ERROR computing HTF bias:`, biasError.message);
   }
   const htfBias = htfBiasRaw ?? { direction: 'neutral', confidence: 0, source: 'fallback' };
   
   // Then use htfBias.direction, htfBias.confidence, etc.
   ```

3. **Update Strategy Functions**
   - Follow existing function signatures
   - Include `overrideUsed` and `overrideNotes` parameters if modifying override logic
   - Return canonical signal structure (see `docs/SYSTEM_CONTEXT.md`)

4. **Update Frontend (if needed)** (`public/index.html`)
   - Update UI to reflect new fields
   - Ensure JSON export includes new data
   - Test copy buttons work on mobile and desktop

5. **Update API Endpoints (if needed)** (`api/analyze-full.js`, etc.)
   - Ensure new data flows through API
   - Add proper error handling
   - Maintain backward compatibility

### Step 3: Local Testing

**Required Tests:**

1. **Unit Tests**
   ```bash
   # Run test script
   node test-strategy-override.js
   # Or create custom test for your changes
   ```

2. **Test Both Modes**
   - Test STANDARD mode behavior
   - Test AGGRESSIVE mode behavior
   - Verify override logic works correctly

3. **Test Edge Cases**
   - Missing data (null/undefined)
   - Empty timeframes
   - Invalid htfBias
   - API failures

4. **Test Frontend**
   - Open `http://localhost:3000` (or your dev server)
   - Test all symbols (BTCUSDT, ETHUSDT, SOLUSDT)
   - Test both modes
   - Verify copy buttons work
   - Check JSON output format

### Step 4: Code Review

**Self-Review Checklist:**

- [ ] All data access uses correct paths
- [ ] Null guards are in place for htfBias and all data access
- [ ] Both STANDARD and AGGRESSIVE modes tested
- [ ] Override logic works correctly (if modified)
- [ ] Frontend displays new data correctly
- [ ] JSON export includes all new fields
- [ ] No console errors in browser
- [ ] No breaking changes to existing functionality

### Step 5: Commit & Push

```bash
# 1. Stage changes
git add services/strategy.js
git add public/index.html
git add api/analyze-full.js
# ... other changed files

# 2. Commit with descriptive message
git commit -m "Feature: Description of changes

- What changed
- Why it changed
- Impact on system"

# 3. Push to GitHub
git push origin feature/your-feature-name

# 4. Create PR or merge to main
```

### Step 6: Deploy

**Vercel Deployment:**

```bash
# Option 1: Manual deploy via CLI
vercel --prod

# Option 2: Use deploy hook (if configured)
curl -X POST "https://api.vercel.com/v1/integrations/deploy/..."
```

**Post-Deployment Verification:**

- [ ] Check live site loads correctly
- [ ] Test API endpoints return expected data
- [ ] Verify no console errors
- [ ] Test copy buttons on mobile and desktop
- [ ] Verify JSON output matches expected format

---

## Common Pitfalls & Solutions

### Pitfall 1: htfBias Null Reference Exception

**Problem:**
```javascript
// WRONG - Will crash if htfBias is null
if (htfBias.direction === 'long') { ... }
```

**Solution:**
```javascript
// CORRECT - Always use fallback pattern
let htfBiasRaw = null;
try {
  htfBiasRaw = computeHTFBias(multiTimeframeData);
} catch (biasError) {
  console.error(`[functionName] ERROR computing HTF bias:`, biasError.message);
}
const htfBias = htfBiasRaw ?? { direction: 'neutral', confidence: 0, source: 'fallback' };

// Now safe to use
if (htfBias.direction === 'long') { ... }
```

**Where to Apply:**
- All strategy functions (`evaluateSwingSetup`, `evaluateStrategy`, `evaluateTrendRider`, `evaluateMicroScalp`)
- `evaluateAllStrategies` function
- Any function that accesses `htfBias`

---

### Pitfall 2: Incorrect Data Access Paths

**Problem:**
```javascript
// WRONG - Will return undefined
const trend = analysis['4h'].indicators.trend;
const pullback = analysis['4h'].pullbackState;
```

**Solution:**
```javascript
// CORRECT - Use documented paths
const trend = analysis['4h'].indicators.analysis.trend;
const pullbackState = analysis['4h'].indicators.analysis.pullbackState;
const distanceFrom21EMA = analysis['4h'].indicators.analysis.distanceFrom21EMA;
const ema21 = analysis['4h'].indicators.ema.ema21;
```

**Reference:** `docs/SYSTEM_CONTEXT.md` section "Data Access Paths"

---

### Pitfall 3: Override Logic Not Triggering

**Problem:**
SAFE mode override conditions not met even when they should be.

**Solution:**
```javascript
// CORRECT override check in evaluateAllStrategies:
const biasStrong = htfBias && typeof htfBias.confidence === 'number' && htfBias.confidence >= 60;
const desiredDirection = htfBias?.direction;
const trend1hMatches = isSameDirection(trend1h, desiredDirection);
const trend15mMatches = isSameDirection(trend15m, desiredDirection);
const stoch1hK = stoch1h?.k;
const momentumOK = desiredDirection && typeof stoch1hK === 'number' ? (
  (desiredDirection === 'long' && stoch1hK < 60) ||
  (desiredDirection === 'short' && stoch1hK > 40)
) : true;

const canOverride = biasStrong && trend1hMatches && trend15mMatches && momentumOK;

if (canOverride) {
  overrideUsed = true;
  overrideNotes = [
    'SAFE override: HTF bias + 1H/15m trend alignment',
    `HTF bias: ${htfBias.direction} (${htfBias.confidence}%)`,
    // ... more notes
  ];
}
```

**Key Requirements:**
- HTF bias confidence >= 60%
- 1H trend matches HTF bias direction
- 15m trend matches HTF bias direction
- 1H Stoch K < 60 (for longs) or > 40 (for shorts)

---

### Pitfall 4: AGGRESSIVE Mode Not Receiving Data

**Problem:**
AGGRESSIVE mode returns null for `currentPrice`, `timeframes`, `marketData`, `dflowData`.

**Solution:**
```javascript
// Ensure buildMarketContext is called before strategy evaluation
const context = await buildMarketContext(symbol, mode);
if (!context || !context.currentPrice) {
  console.warn(`Missing context for ${symbol}, using fallback`);
  context = await buildFallbackContext(symbol);
}

// Then pass context to evaluateAllStrategies
const result = evaluateAllStrategies(
  symbol,
  context.analysis, // multiTimeframeData
  mode,
  context.marketData,
  context.dflowData
);
```

---

### Pitfall 5: Breaking Existing Functionality

**Problem:**
Changes break existing strategies or frontend display.

**Solution:**
- Always test existing functionality after changes
- Use feature flags for major changes
- Maintain backward compatibility in API responses
- Test all symbols and both modes

---

### Pitfall 6: Copy Buttons Not Working

**Problem:**
Copy buttons fail on mobile or desktop.

**Solution:**
- Use `copyToClipboardSync()` function (already implemented)
- Ensure copy happens within user gesture context
- Test on both mobile Safari and Chrome
- Add proper error handling and user feedback

---

## Testing Requirements

### Required Tests Before Deployment

1. **Local Unit Tests**
   - Create test file (e.g., `test-strategy-override.js`)
   - Test with mock data
   - Verify expected outputs

2. **Integration Tests**
   - Test full API flow
   - Test frontend rendering
   - Test JSON export

3. **Mode Tests**
   - Test STANDARD mode
   - Test AGGRESSIVE mode
   - Verify mode-specific behavior

4. **Edge Case Tests**
   - Missing data
   - Null values
   - API failures
   - Invalid inputs

5. **Browser Tests**
   - Desktop (Chrome, Firefox, Safari)
   - Mobile (iOS Safari, Android Chrome)
   - Copy button functionality

---

## Deployment Checklist

### Pre-Deployment

- [ ] All tests pass locally
- [ ] Code reviewed (self-review or peer review)
- [ ] Documentation updated
- [ ] No console errors
- [ ] No breaking changes

### Deployment

- [ ] Push to GitHub
- [ ] Deploy to Vercel (via CLI or hook)
- [ ] Verify deployment succeeded

### Post-Deployment

- [ ] Live site loads correctly
- [ ] API endpoints return expected data
- [ ] Frontend displays correctly
- [ ] Copy buttons work
- [ ] JSON output matches expected format
- [ ] No console errors on live site

---

## Documentation Updates

### When to Update Documentation

**Always update docs when:**
- Adding new strategies
- Changing strategy logic
- Modifying data paths
- Adding new indicators
- Changing mode behavior
- Updating API responses

### Which Docs to Update

1. **`docs/SYSTEM_CONTEXT.md`**
   - Update data access paths
   - Update strategy structure
   - Update mode differences
   - Add new patterns/examples

2. **`docs/STRATEGY_IMPLEMENTATION_GUIDE.md`**
   - Update strategy logic
   - Update gatekeepers
   - Update confidence scoring

3. **`docs/STRATEGY_MODES.md`**
   - Update mode thresholds
   - Update mode behavior
   - Update override logic

4. **`docs/STRATEGY_SYSTEM_AUDIT.md`**
   - Update system architecture
   - Update data flow diagrams
   - Update API endpoints

5. **`docs/README.md`**
   - Update documentation index
   - Update quick start guides

### Documentation Standards

- Use clear, concise language
- Include code examples
- Document edge cases
- Cross-reference related docs
- Keep examples up-to-date
- Test all code examples

---

## Quick Reference

### Critical Patterns

**htfBias Null Guard:**
```javascript
let htfBiasRaw = null;
try {
  htfBiasRaw = computeHTFBias(multiTimeframeData);
} catch (biasError) {
  console.error(`[functionName] ERROR:`, biasError.message);
}
const htfBias = htfBiasRaw ?? { direction: 'neutral', confidence: 0, source: 'fallback' };
```

**Data Access:**
```javascript
analysis[tf].indicators.analysis.trend
analysis[tf].indicators.analysis.pullbackState
analysis[tf].indicators.ema.ema21
```

**Override Logic:**
```javascript
const canOverride = 
  htfBias.confidence >= 60 &&
  trend1hMatches &&
  trend15mMatches &&
  momentumOK;
```

**Confidence Calculation:**
```javascript
const confidenceResult = calculateConfidenceWithHierarchy(
  multiTimeframeData,
  direction,
  mode
);
```

---

## Related Documentation

- `docs/SYSTEM_CONTEXT.md` - Complete system reference
- `docs/STRATEGY_IMPLEMENTATION_GUIDE.md` - Strategy details
- `docs/STRATEGY_MODES.md` - Mode differences
- `docs/SYSTEM_WORKFLOW.md` - Data flow and element impact
- `docs/STRATEGY_SYSTEM_AUDIT.md` - System architecture

---

**Last Updated:** 2025-01-27  
**Version:** 1.0.0

