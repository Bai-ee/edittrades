# Indicator Integration Checklist

Quick reference checklist for adding a new indicator. Use this alongside `ADDING_INDICATORS.md` for detailed instructions.

## Pre-Integration

- [ ] Indicator calculation method determined
- [ ] Required library identified (or custom implementation)
- [ ] Minimum data requirements known
- [ ] Strategy impact assessed (affects signals? confidence? entry logic?)
- [ ] Display format decided

## Step 1: Calculation Layer

**File:** `services/indicators.js`

- [ ] Create calculation function (e.g., `calculateEMA50`)
- [ ] Add JSDoc comment
- [ ] Validate minimum data requirements
- [ ] Add try/catch block in `calculateAllIndicators()`
- [ ] Extract current value (last element of array)
- [ ] Add to return object structure
- [ ] Include history if applicable
- [ ] Export function (if using named exports)

**Verification:**
- [ ] Function calculates correctly
- [ ] Returns null gracefully with insufficient data
- [ ] No console errors

## Step 2: Strategy Integration (If Applicable)

**File:** `services/strategy.js`

- [ ] Determine where indicator affects strategy
- [ ] Add indicator access: `analysis[tf].indicators.yourIndicator`
- [ ] Add null checks
- [ ] Integrate into logic (trend detection, confidence, entry, etc.)
- [ ] Test strategy behavior

**Verification:**
- [ ] Indicator accessible in strategy functions
- [ ] Strategy logic works correctly
- [ ] Confidence scores reasonable (if used)

## Step 3: Frontend Display

**File:** `public/index.html`

### Details Row Display
- [ ] Locate `createDetailsRow()` function (line ~2963)
- [ ] Add indicator to timeframe card template
- [ ] Add null check
- [ ] Format consistently with other indicators
- [ ] Test visual display

### JSON Export
- [ ] Locate `buildRichSymbolFromScanResults()` function (line ~4023)
- [ ] Add indicator to `timeframes[tf]` object
- [ ] Add null check
- [ ] Verify structure matches calculation structure

**Verification:**
- [ ] Indicator visible in details row
- [ ] Formatting looks correct
- [ ] Null values handled gracefully
- [ ] Mobile display works

## Step 4: JSON Export Verification

**File:** `public/index.html`

- [ ] Test single coin copy button
- [ ] Test all coins copy button
- [ ] Verify indicator in exported JSON
- [ ] Check JSON structure validity
- [ ] Verify values match displayed values

**Verification:**
- [ ] Indicator in single coin JSON
- [ ] Indicator in all coins JSON
- [ ] JSON structure valid
- [ ] Values correct

## Step 5: Documentation

- [ ] Update `INDICATOR_REFERENCE.md` with new indicator specs
- [ ] Update `INDICATOR_ARCHITECTURE.md` if structure changes
- [ ] Document any strategy logic changes
- [ ] Add usage examples if complex

## Step 6: Testing

### Unit Tests
- [ ] Calculation works with sufficient data
- [ ] Calculation handles insufficient data
- [ ] Returns correct data types

### Integration Tests
- [ ] All timeframes work (if applicable)
- [ ] Strategy evaluation works
- [ ] Frontend displays correctly
- [ ] JSON exports correctly

### Regression Tests
- [ ] No breaking changes to existing indicators
- [ ] Existing strategies still work
- [ ] Existing displays still work
- [ ] Existing JSON exports still work

## Quick Reference: File Locations

| Task | File | Location |
|------|------|----------|
| Calculation | `services/indicators.js` | `calculateAllIndicators()` function |
| Strategy | `services/strategy.js` | `evaluateStrategy()` or confidence functions |
| Display | `public/index.html` | `createDetailsRow()` (~line 2963) |
| Export | `public/index.html` | `buildRichSymbolFromScanResults()` (~line 4023) |

## Common Issues & Solutions

### Indicator not showing
- Check null checks in display code
- Verify indicator path matches calculation structure
- Check browser console for errors

### Indicator not in JSON
- Verify added to `buildRichSymbolFromScanResults()`
- Check indicator path matches
- Test copy button and inspect JSON

### Strategy not using indicator
- Verify access path: `analysis[tf].indicators.yourIndicator`
- Check null handling
- Add console.log to debug

### Calculation errors
- Verify minimum data requirements
- Check library import
- Ensure try/catch error handling

## Example: 50 EMA Integration

```
[✓] Pre-Integration: EMA50, 50 candles minimum, affects trend detection
[✓] Step 1: Added calculateEMA50(), integrated into calculateAllIndicators()
[✓] Step 2: Added to trend detection logic in evaluateStrategy()
[✓] Step 3: Added to createDetailsRow() and buildRichSymbolFromScanResults()
[✓] Step 4: Verified in JSON exports
[✓] Step 5: Updated INDICATOR_REFERENCE.md
[✓] Step 6: All tests passing
```

## Notes

- Always test with insufficient data (should return null gracefully)
- Maintain backward compatibility (new indicators shouldn't break existing code)
- Follow existing code patterns and naming conventions
- Update documentation as you go

For detailed instructions, see `ADDING_INDICATORS.md`.

