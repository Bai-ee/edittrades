# Documentation Index

Complete documentation for the trading system, including strategies, indicators, and best practices.

---

## Strategy Documentation

### Core Strategy Guides

- **`STRATEGY_IMPLEMENTATION_GUIDE.md`** - Complete reference for all 5 strategies (SWING, TREND_4H, TREND_RIDER, SCALP_1H, MICRO_SCALP)
  - Gatekeepers, entry logic, SL/TP calculations
  - Confidence scoring
  - Data structure reference

- **`STRATEGY_MODES.md`** - STANDARD vs AGGRESSIVE mode differences
  - Thresholds and configuration
  - Position sizing
  - When to use each mode

- **`ADDING_STRATEGIES.md`** - Best practices for adding new strategies
  - Step-by-step integration guide
  - Code templates
  - Testing checklist

- **`STRATEGY_SYSTEM_AUDIT.md`** - System architecture and comprehensive audit
  - Data flow diagrams
  - API endpoints
  - Identified inconsistencies

### Strategy Documentation Review

- **`STRATEGY_DOCUMENTATION_REVIEW.md`** - Review of all strategy docs
- **`STRATEGY_DOCS_RECOMMENDATIONS.md`** - Recommendations and action plan

---

## Indicator Documentation

### Core Indicator Guides

- **`INDICATOR_ARCHITECTURE.md`** - System overview and data flow
  - How indicators propagate through the system
  - Integration points
  - Indicator object structure

- **`ADDING_INDICATORS.md`** - Step-by-step guide for adding indicators
  - Complete 50 EMA example
  - Common patterns
  - Troubleshooting

- **`INDICATOR_REFERENCE.md`** - Current indicators catalog
  - EMA21, EMA200, Stochastic RSI
  - Trend, Pullback State, Swing Points
  - Specifications and usage

- **`INDICATOR_INTEGRATION_CHECKLIST.md`** - Quick reference checklist

- **`INDICATOR_DOCUMENTATION_INDEX.md`** - Documentation index and quick start

### Indicator Templates

Located in `docs/templates/`:

- **`indicator-calculation-template.js`** - Calculation layer template
- **`indicator-strategy-template.js`** - Strategy usage template
- **`indicator-frontend-template.html`** - Frontend display template
- **`indicator-json-template.js`** - JSON export template

---

## System Workflow Documentation

- **`SYSTEM_WORKFLOW.md`** - Complete system workflow and element impact guide
  - Data flow from API → indicators → strategies → frontend
  - How tweaking elements (indicators, market data, parameters) affects strategies
  - Element impact matrix
  - Strategy evaluation flow
  - Confidence calculation flow
  - Frontend rendering flow

- **`SYSTEM_CONTEXT.md`** - **PLUG & PLAY REFERENCE FOR AI ASSISTANTS**
  - Complete system context for generating strategy updates
  - Data access paths (CRITICAL - avoid common mistakes)
  - Strategy signal structure (required fields)
  - Confidence calculation (mandatory patterns)
  - Mode differences (STANDARD vs AGGRESSIVE)
  - Integration points and file locations
  - Example code patterns
  - Do's and Don'ts checklist
  - **Use this when working with other AI assistants to generate strategy updates**

- **`DEVELOPMENT_PROCEDURE.md`** - **STANDARDIZED DEVELOPMENT WORKFLOW**
  - Pre-development checklist
  - Step-by-step development workflow
  - Common pitfalls and solutions
  - Testing requirements
  - Deployment checklist
  - Documentation update guidelines
  - **Use this to avoid development pitfalls and maintain code quality**

## AI System Documentation

- **`AI_SYSTEM_DOCUMENTATION.md`** - Complete AI analysis system reference
  - Marquee AI (market review)
  - Details Section AI (individual trade analysis)
  - Trade Tracker AI (active position analysis)
  - System prompts for each component
  - LLM configuration (OpenAI GPT-4o-mini)
  - Enhancement guide
  - Troubleshooting

## Other Documentation

- **`BACKTEST_GUIDE.md`** - Backtest system documentation
- **`MARKETDATA_MODULE.md`** - Market data module reference
- **`technical-data-requirements.md`** - Technical data requirements

---

## Archived Documentation

Historical strategy documentation has been moved to `docs/archive/`:

- `SWING_STRATEGY_IMPLEMENTATION.md` (consolidated into STRATEGY_IMPLEMENTATION_GUIDE.md)
- `MICRO_SCALP_IMPLEMENTATION.md` (consolidated into STRATEGY_IMPLEMENTATION_GUIDE.md)
- `AGGRESSIVE_MODE_IMPLEMENTATION.md` (replaced by STRATEGY_MODES.md)
- `FLEXIBLE_STRATEGY_COMPLETE.md` (consolidated)
- `FLEXIBLE_STRATEGY_UPDATE.md` (historical)
- `MICRO_SCALP_EXAMPLES.md` (may be outdated)

See `docs/archive/README.md` for details.

---

## Quick Start

### Adding a New Indicator

1. Read `INDICATOR_ARCHITECTURE.md` - Understand the system
2. Follow `ADDING_INDICATORS.md` - Step-by-step guide
3. Use templates in `docs/templates/` - Code patterns
4. Reference `INDICATOR_REFERENCE.md` - Current indicators

### Adding a New Strategy

1. Read `STRATEGY_IMPLEMENTATION_GUIDE.md` - Current strategies
2. Follow `ADDING_STRATEGIES.md` - Integration guide
3. Review `STRATEGY_MODES.md` - Mode differences
4. Test thoroughly using checklist

### Understanding the System

1. Start with **`SYSTEM_WORKFLOW.md`** - Complete workflow and element impact
2. Review **`STRATEGY_SYSTEM_AUDIT.md`** - System architecture and audit
3. Check **`STRATEGY_IMPLEMENTATION_GUIDE.md`** - Strategy details
4. Reference **`INDICATOR_ARCHITECTURE.md`** - Indicator system
5. Use specific guides as needed

### Before Making Changes

1. **Read `DEVELOPMENT_PROCEDURE.md`** - Standardized workflow and pitfalls to avoid
2. Review **`SYSTEM_CONTEXT.md`** - Complete system reference
3. Understand current behavior - Test locally first
4. Plan changes - Document what and why
5. Follow the workflow - Test, review, deploy

---

## Documentation Structure

```
docs/
├── README.md (this file)
├── Strategy Documentation
│   ├── STRATEGY_IMPLEMENTATION_GUIDE.md
│   ├── STRATEGY_MODES.md
│   ├── ADDING_STRATEGIES.md
│   ├── STRATEGY_SYSTEM_AUDIT.md
│   ├── STRATEGY_DOCUMENTATION_REVIEW.md
│   └── STRATEGY_DOCS_RECOMMENDATIONS.md
├── Indicator Documentation
│   ├── INDICATOR_ARCHITECTURE.md
│   ├── ADDING_INDICATORS.md
│   ├── INDICATOR_REFERENCE.md
│   ├── INDICATOR_INTEGRATION_CHECKLIST.md
│   └── INDICATOR_DOCUMENTATION_INDEX.md
├── Templates
│   ├── indicator-calculation-template.js
│   ├── indicator-strategy-template.js
│   ├── indicator-frontend-template.html
│   └── indicator-json-template.js
├── Archive
│   ├── README.md
│   └── [archived files]
└── Other
    ├── BACKTEST_GUIDE.md
    ├── MARKETDATA_MODULE.md
    └── technical-data-requirements.md
```

---

## Maintenance

When updating documentation:

1. **Keep it current** - Update docs when code changes
2. **Verify accuracy** - Check data paths and logic match code
3. **Test examples** - Ensure code examples work
4. **Cross-reference** - Link related documents
5. **Archive old versions** - Move outdated docs to archive

---

**Last Updated:** 2025-01-XX  
**Version:** 1.0.0

