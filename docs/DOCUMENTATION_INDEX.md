# Documentation Index

**Last Updated:** 2025-01-XX  
**Status:** Production Ready  
**Milestone Tag:** `v1.0-data-parity`

---

## Quick Navigation

### 🏗️ Architecture & Pipeline
- **[DATA_PIPELINE_ARCHITECTURE.md](./DATA_PIPELINE_ARCHITECTURE.md)** - Complete data flow from ingestion to export
- **[SYSTEM_WORKFLOW.md](./SYSTEM_WORKFLOW.md)** - End-to-end system workflow
- **[SYSTEM_CONTEXT.md](./SYSTEM_CONTEXT.md)** - Complete system context for AI/strategy updates

### 🔧 Development Guides
- **[MODULE_DEVELOPMENT_GUIDE.md](./MODULE_DEVELOPMENT_GUIDE.md)** - How to add new analysis modules
- **[STRATEGY_INTEGRATION_GUIDE.md](./STRATEGY_INTEGRATION_GUIDE.md)** - How strategies use data, adding new strategies
- **[ADDING_STRATEGIES.md](./ADDING_STRATEGIES.md)** - Strategy addition process
- **[ADDING_INDICATORS.md](./ADDING_INDICATORS.md)** - Indicator addition process

### 🐛 Troubleshooting
- **[TROUBLESHOOTING_GUIDE.md](./TROUBLESHOOTING_GUIDE.md)** - Common issues, solutions, diagnostic commands
- **[STRATEGY_MODES.md](./STRATEGY_MODES.md)** - STANDARD vs AGGRESSIVE mode differences

### 📊 Data Reference
- **[COMPLETE_DATA_REFERENCE.md](./COMPLETE_DATA_REFERENCE.md)** - Complete data structure, usage patterns, guarantees
- **[STRATEGY_IMPLEMENTATION_GUIDE.md](./STRATEGY_IMPLEMENTATION_GUIDE.md)** - Strategy implementation details
- **[SIGNAL_GENERATION_SPECIFICATION.md](./SIGNAL_GENERATION_SPECIFICATION.md)** - Complete technical specification of signal generation logic

### 🤖 AI System
- **[AI_SYSTEM_DOCUMENTATION.md](./AI_SYSTEM_DOCUMENTATION.md)** - AI analysis components and integration

### 📈 Chart Analysis
- **[CHART_ANALYSIS_GUIDE.md](./CHART_ANALYSIS_GUIDE.md)** - Chart analysis features
- **[CHART_ANALYSIS_DATA_POINTS.md](./CHART_ANALYSIS_DATA_POINTS.md)** - Chart data points reference

---

## Documentation by Use Case

### I want to...

**Add a new analysis module:**
1. Read [MODULE_DEVELOPMENT_GUIDE.md](./MODULE_DEVELOPMENT_GUIDE.md)
2. Follow the step-by-step template
3. Ensure structured fallbacks (never null)
4. Test with low candle counts

**Add a new strategy:**
1. Read [STRATEGY_INTEGRATION_GUIDE.md](./STRATEGY_INTEGRATION_GUIDE.md)
2. Review [COMPLETE_DATA_REFERENCE.md](./COMPLETE_DATA_REFERENCE.md) for available data
3. Use advanced modules in strategy logic
4. Follow confidence calculation patterns

**Troubleshoot data issues:**
1. Read [TROUBLESHOOTING_GUIDE.md](./TROUBLESHOOTING_GUIDE.md)
2. Run diagnostic commands
3. Check three-layer fallback system
4. Verify validation layer

**Understand data flow:**
1. Read [DATA_PIPELINE_ARCHITECTURE.md](./DATA_PIPELINE_ARCHITECTURE.md)
2. Review [SYSTEM_WORKFLOW.md](./SYSTEM_WORKFLOW.md)
3. Check [COMPLETE_DATA_REFERENCE.md](./COMPLETE_DATA_REFERENCE.md)

**Route new data sources:**
1. Read [DATA_PIPELINE_ARCHITECTURE.md](./DATA_PIPELINE_ARCHITECTURE.md) - "Adding New Modules"
2. Follow integration steps
3. Add to validation layer
4. Update export functions

---

## Key Concepts

### Three-Layer Fallback System

1. **Calculation Layer:** Module functions return structured objects/arrays
2. **Validation Layer:** `validateTimeframeAnalysis()` ensures all modules exist
3. **Export Layer:** Frontend functions apply final fallbacks

### Data Guarantees

- All modules guaranteed to exist (never null)
- Arrays always arrays (never null, empty if no data)
- Objects always objects (never null, default structure if no data)
- Volatility state always classified (never null)

### Strategy Integration

- All strategies have access to complete advanced module data
- Data guaranteed to exist (no null checks needed)
- Use patterns from [STRATEGY_INTEGRATION_GUIDE.md](./STRATEGY_INTEGRATION_GUIDE.md)
- Follow confidence calculation hierarchy

---

## Milestone Reference

**Tag:** `v1.0-data-parity`

**Achievement:** Complete TradingView-level data parity

**Status:** Production ready - all modules present, structured fallbacks, no null values

**Use as fallback:** `git checkout v1.0-data-parity`
