# Third-Party Documentation Package

**For External Developers Evaluating or Improving the Signal Generation System**

---

## Overview

This package contains all documentation needed to understand how the trading system generates trade signals. The documentation is organized by priority - start with the core specification, then reference the supporting documents as needed.

---

## Essential Documents (Send These First)

### 1. **SIGNAL_GENERATION_SPECIFICATION.md** ⭐ **START HERE**
**Purpose:** Complete technical specification of signal generation logic

**Contains:**
- System overview and evaluation flow
- Data inputs and structure
- HTF Bias computation
- All 5 strategy specifications (SWING, TREND_4H, TREND_RIDER, SCALP_1H, MICRO_SCALP)
- Complete confidence calculation system with hierarchical layers
- Mode differences (STANDARD vs AGGRESSIVE)
- Entry zone, stop loss, and target calculation methods
- Signal output structure

**Why this is essential:** This is the single source of truth for how signals are generated. It documents every gatekeeper condition, setup requirement, and calculation method used by the system.

---

## Supporting Documents (Reference as Needed)

### 2. **STRATEGY_MODES.md**
**Purpose:** Detailed comparison of STANDARD vs AGGRESSIVE modes

**Contains:**
- Threshold differences between modes
- Strategy behavior variations
- Position sizing differences
- When to use each mode
- Mode-specific strategy variants (AGGRO_SCALP_1H, AGGRO_MICRO_SCALP)

**When to reference:** When you need to understand how mode selection affects signal generation.

---

### 3. **STRATEGY_IMPLEMENTATION_GUIDE.md**
**Purpose:** Strategy implementation details and patterns

**Contains:**
- Strategy overview and priority order
- Individual strategy deep-dives
- Confidence scoring details
- Data structure reference

**When to reference:** When you need additional context on strategy implementation patterns or want to see examples.

---

### 4. **COMPLETE_DATA_REFERENCE.md**
**Purpose:** Complete data structure reference

**Contains:**
- All data structures used by the system
- Indicator definitions
- Timeframe data structures
- Market data structures

**When to reference:** When you need to understand the exact structure of input data or output signals.

---

### 5. **SYSTEM_WORKFLOW.md**
**Purpose:** End-to-end system workflow

**Contains:**
- How data flows through the system
- API endpoints and request/response formats
- Integration points

**When to reference:** When you need to understand how the signal generation fits into the larger system architecture.

---

## Quick Reference Guide

### For Understanding Signal Logic:
1. Read **SIGNAL_GENERATION_SPECIFICATION.md** (sections 1-6)
2. Reference **STRATEGY_MODES.md** for mode-specific behavior
3. Check **COMPLETE_DATA_REFERENCE.md** for data structures

### For Evaluating Improvements:
1. Read **SIGNAL_GENERATION_SPECIFICATION.md** (all sections)
2. Review **STRATEGY_IMPLEMENTATION_GUIDE.md** for implementation patterns
3. Check **SYSTEM_WORKFLOW.md** for integration points

### For Implementing New Strategies:
1. Read **SIGNAL_GENERATION_SPECIFICATION.md** (sections 4-6)
2. Review **STRATEGY_IMPLEMENTATION_GUIDE.md** for patterns
3. Check **ADDING_STRATEGIES.md** (if available) for process

---

## Key Concepts to Understand

### 1. Strategy Priority Order
Strategies are evaluated in priority order. The first valid signal found is returned. This means:
- SWING is checked first (most restrictive)
- If SWING finds no trade, TREND_4H is checked
- And so on...

### 2. Gatekeeper Conditions
Each strategy has gatekeeper conditions that MUST pass before setup conditions are evaluated. If gatekeepers fail, the strategy returns null and the next strategy is evaluated.

### 3. Hierarchical Confidence System
Confidence is calculated in layers:
- Base confidence (strategy-specific)
- Trend alignment bonuses
- Stoch alignment bonuses
- HTF bias adjustments
- Volume quality filters
- dFlow alignment
- Macro contradiction caps

### 4. Mode Differences
STANDARD mode is conservative (higher confidence thresholds, stricter gatekeepers).
AGGRESSIVE mode is looser (lower thresholds, allows FLAT trends with HTF bias, wider EMA bands).

### 5. Signal Validation
All signals are validated before being marked `valid: true`. Invalid signals are forced to `valid: false` with `direction: 'NO_TRADE'`.

---

## Implementation Files Reference

If you need to review the actual implementation:

- **Main Strategy Logic:** `services/strategy.js`
  - `evaluateStrategy()` - Main entry point
  - `evaluateSwingSetup()` - SWING strategy
  - `evaluateTrendRider()` - TREND_RIDER strategy
  - `evaluateMicroScalp()` - MICRO_SCALP strategy
  - `computeHTFBias()` - HTF bias calculation
  - `calculateConfidenceWithHierarchy()` - Confidence calculation

- **API Endpoint:** `api/analyze-full.js`
  - Main API handler
  - Data fetching and orchestration
  - Response formatting

---

## Questions to Answer After Review

After reviewing the documentation, you should be able to answer:

1. **What are the 5 strategies and their priority order?**
2. **What are the gatekeeper conditions for each strategy?**
3. **How is confidence calculated? What are the layers?**
4. **What are the differences between STANDARD and AGGRESSIVE modes?**
5. **How are entry zones, stop losses, and targets calculated?**
6. **What is HTF Bias and how is it computed?**
7. **What data inputs are required for signal generation?**
8. **What are the confidence caps and when are they applied?**

---

## Document Status

**Last Updated:** 2025-01-XX  
**Version:** 1.0.0  
**Status:** Complete and accurate as of current implementation

All documentation has been verified against the actual codebase implementation in `services/strategy.js` and `api/analyze-full.js`.

---

## Contact

For questions about the documentation or signal generation logic, refer to the implementation files listed above or contact the development team.
