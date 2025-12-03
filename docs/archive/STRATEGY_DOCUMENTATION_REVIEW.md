# Strategy Documentation Review & Recommendations

**Date:** 2025-01-XX  
**Purpose:** Audit all strategy-related .md files for accuracy, organization, and completeness

---

## Executive Summary

After reviewing all strategy-related documentation against the current implementation in `services/strategy.js`, here are the findings:

### Current Strategy Implementation (Verified)
- **SWING**: `evaluateSwingSetup()` - 3D → 1D → 4H structure-based trades
- **TREND_4H**: 4H trend-following strategy
- **TREND_RIDER**: `evaluateTrendRider()` - 4H/1H continuation strategy (NEW)
- **SCALP_1H**: 1H scalp strategy (works when 4H is FLAT)
- **MICRO_SCALP**: `evaluateMicroScalp()` - LTF mean-reversion
- **AGGRESSIVE Mode**: Looser requirements with smaller position sizes
- **Confidence System**: Hierarchical weighting (macro/primary/execution layers)

### Key Current Features
- Hierarchical confidence calculation with penalties and caps
- HTF bias system (replaces hard 4H gates)
- Strategy cascade evaluation (`evaluateAllStrategies`)
- STANDARD vs AGGRESSIVE mode thresholds
- All strategies return canonical JSON structure

---

## Documentation Files Review

### ✅ KEEP & UPDATE (Move to docs/)

#### 1. **STRATEGY_SYSTEM_AUDIT.md** → `docs/STRATEGY_SYSTEM_AUDIT.md`
**Status:** Valuable but needs updates

**Accuracy Issues:**
- ✅ Strategy definitions are mostly accurate
- ⚠️ Data paths may be outdated (references `indicators.pullback` vs `indicators.analysis.pullbackState`)
- ⚠️ Confidence system now uses hierarchical weighting (not documented)
- ⚠️ AGGRESSIVE mode forcing logic needs verification

**Recommendation:**
- Move to `docs/` folder
- Update data paths to match current implementation
- Add hierarchical confidence system documentation
- Verify AGGRESSIVE mode logic matches code
- Keep as reference for system architecture

---

### ⚠️ UPDATE & CONSOLIDATE (Move to docs/)

#### 2. **SWING_STRATEGY_IMPLEMENTATION.md** → Archive or consolidate
**Status:** Partially accurate, but outdated

**Accuracy Issues:**
- ⚠️ References old data paths (`tf3d.indicators?.pullback` should be `tf3d.indicators?.analysis.pullbackState`)
- ⚠️ Confidence calculation now uses hierarchical system (not documented)
- ✅ Gatekeepers and entry logic are accurate
- ✅ SL/TP calculation matches code

**Recommendation:**
- **Option A:** Archive (historical reference)
- **Option B:** Consolidate into new comprehensive strategy guide
- **Action:** Extract accurate parts, update data paths, add to consolidated doc

---

#### 3. **MICRO_SCALP_IMPLEMENTATION.md** → Archive or consolidate
**Status:** Mostly accurate but needs updates

**Accuracy Issues:**
- ✅ Logic matches `evaluateMicroScalp()` function
- ⚠️ Confidence calculation simplified (now 60-75 based on confluence tightness)
- ⚠️ Data paths need verification (`indicators.pullback` vs `indicators.analysis.pullbackState`)

**Recommendation:**
- Consolidate into comprehensive strategy guide
- Update confidence calculation details
- Verify data paths

---

#### 4. **AGGRESSIVE_MODE_IMPLEMENTATION.md** → Update & move to docs/
**Status:** Mostly accurate

**Accuracy Issues:**
- ✅ THRESHOLDS structure matches code
- ⚠️ May need updates for hierarchical confidence system
- ✅ Strategy logic descriptions are accurate

**Recommendation:**
- Move to `docs/STRATEGY_MODES.md`
- Update with hierarchical confidence details
- Keep as reference for mode differences

---

#### 5. **FLEXIBLE_STRATEGY_COMPLETE.md** → Consolidate
**Status:** Accurate but redundant

**Accuracy Issues:**
- ✅ HTF bias system description is accurate
- ✅ Strategy cascade matches implementation
- ⚠️ Some details may be outdated

**Recommendation:**
- Consolidate into comprehensive strategy guide
- Extract key concepts for new documentation

---

#### 6. **FLEXIBLE_STRATEGY_UPDATE.md** → Archive
**Status:** Historical update document

**Recommendation:**
- Archive (historical reference only)
- Key points already in FLEXIBLE_STRATEGY_COMPLETE.md

---

### ✅ KEEP AS-IS (Different Purpose)

#### 7. **BACKTEST_AND_STRATEGY_GUIDE.md**
**Status:** Accurate, different purpose

**Purpose:** Backtest system documentation, not strategy implementation
**Recommendation:** Keep in root or move to `docs/BACKTEST_GUIDE.md`

---

### ❌ ARCHIVE (Outdated/Redundant)

#### 8. **MICRO_SCALP_EXAMPLES.md**
**Status:** Examples may be outdated

**Recommendation:**
- Archive or update with current JSON structure
- Examples may not match current API response format

---

## Recommended Documentation Structure

### New Comprehensive Strategy Documentation

Create these new files in `docs/`:

1. **`docs/STRATEGY_IMPLEMENTATION_GUIDE.md`** (NEW - Comprehensive)
   - Complete strategy reference
   - All 4 strategies (SWING, TREND_4H, SCALP_1H, MICRO_SCALP)
   - Gatekeepers, entry logic, SL/TP, confidence
   - Data paths and structure
   - Examples

2. **`docs/STRATEGY_MODES.md`** (NEW - From AGGRESSIVE_MODE_IMPLEMENTATION.md)
   - STANDARD vs AGGRESSIVE mode differences
   - Thresholds and configuration
   - When to use each mode

3. **`docs/STRATEGY_ARCHITECTURE.md`** (NEW - From STRATEGY_SYSTEM_AUDIT.md)
   - System architecture
   - Data flow
   - Evaluation priority
   - API endpoints

4. **`docs/ADDING_STRATEGIES.md`** (NEW - Best Practices)
   - How to add new strategies
   - Integration points
   - Testing checklist
   - Template code

---

## Data Path Accuracy Issues

### Current Implementation (Verified in code):

**Correct Paths:**
```javascript
// Trend
tf4h.indicators.analysis.trend

// Pullback State
tf4h.indicators.analysis.pullbackState
tf4h.indicators.analysis.distanceFrom21EMA

// EMA
tf4h.indicators.ema.ema21
tf4h.indicators.ema.ema200

// StochRSI
tf4h.indicators.stochRSI.k
tf4h.indicators.stochRSI.d
tf4h.indicators.stochRSI.condition

// Structure
tf4h.structure.swingHigh
tf4h.structure.swingLow
```

**Incorrect Paths in Some Docs:**
```javascript
// ❌ OLD (incorrect)
tf4h.indicators.pullback.state
tf4h.indicators.pullback.distanceFrom21EMA
tf4h.indicators.analysis.ema21
```

**Note:** Some code still uses `indicators.pullback` (e.g., in `evaluateMicroScalp`), suggesting the data structure may vary or there's inconsistency. This needs verification.

---

## Action Plan

### Phase 1: Organize Existing Docs
1. ✅ Move `STRATEGY_SYSTEM_AUDIT.md` → `docs/STRATEGY_SYSTEM_AUDIT.md` (update data paths)
2. ✅ Move `AGGRESSIVE_MODE_IMPLEMENTATION.md` → `docs/STRATEGY_MODES.md` (update)
3. ✅ Archive `SWING_STRATEGY_IMPLEMENTATION.md` (extract useful parts first)
4. ✅ Archive `MICRO_SCALP_IMPLEMENTATION.md` (extract useful parts first)
5. ✅ Archive `FLEXIBLE_STRATEGY_UPDATE.md` (redundant)
6. ✅ Keep `BACKTEST_AND_STRATEGY_GUIDE.md` (different purpose)

### Phase 2: Create New Comprehensive Docs
1. Create `docs/STRATEGY_IMPLEMENTATION_GUIDE.md` (consolidate all strategies)
2. Create `docs/STRATEGY_ARCHITECTURE.md` (system overview)
3. Create `docs/ADDING_STRATEGIES.md` (best practices for new strategies)

### Phase 3: Update Existing Docs
1. Update `STRATEGY_SYSTEM_AUDIT.md` with:
   - Correct data paths
   - Hierarchical confidence system
   - Current AGGRESSIVE mode logic
2. Update `STRATEGY_MODES.md` with:
   - Current thresholds
   - Hierarchical confidence caps
   - Mode-specific behavior

---

## Verification Checklist

Before finalizing documentation, verify:

- [ ] Data paths match actual code structure
- [ ] Confidence calculation matches hierarchical system
- [ ] AGGRESSIVE mode logic matches `evaluateAllStrategies()`
- [ ] Strategy priority order is correct
- [ ] SL/TP calculation formulas match code
- [ ] Entry zone calculations match code
- [ ] JSON structure matches API responses
- [ ] All strategy gatekeepers are documented correctly

---

## Files to Create

1. `docs/STRATEGY_IMPLEMENTATION_GUIDE.md` - Complete strategy reference
2. `docs/STRATEGY_ARCHITECTURE.md` - System architecture
3. `docs/STRATEGY_MODES.md` - STANDARD vs AGGRESSIVE
4. `docs/ADDING_STRATEGIES.md` - Best practices guide

---

## Files to Archive

Move to `docs/archive/` or delete:
- `SWING_STRATEGY_IMPLEMENTATION.md` (after extracting useful parts)
- `MICRO_SCALP_IMPLEMENTATION.md` (after extracting useful parts)
- `FLEXIBLE_STRATEGY_UPDATE.md` (redundant)
- `MICRO_SCALP_EXAMPLES.md` (update or archive)

---

## Next Steps

1. Review this document
2. Verify data paths in actual code
3. Create new comprehensive documentation
4. Archive outdated files
5. Update existing files with corrections

---

**Last Updated:** 2025-01-XX  
**Status:** Review Complete - Awaiting Implementation

