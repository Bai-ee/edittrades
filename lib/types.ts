/**
 * TypeScript Type Definitions for Snapshot TradingView JSON Schema
 * 
 * These types match the exact structure of the exported JSON from the frontend
 */

// === Core Root Types ===

export interface StrategySnapshot {
  SAFE_MODE: Record<string, SymbolSnapshot>;
  AGGRESSIVE_MODE: Record<string, SymbolSnapshot>;
  jsonVersion?: string;
}

export interface SymbolSnapshot {
  symbol: string;
  mode: "SAFE" | "AGGRESSIVE";
  currentPrice: number;
  htfBias: HTFBias;
  timeframes: Record<string, TimeframeState>; // "1M" | "1w" | "3d" | "1d" | "4h" | "1h" | "15m" | "5m" | "3m" | "1m"
  analysis?: Record<string, ExtendedTFAnalysis>;
  strategies: StrategiesBlock;
  bestSignal: string | null;
  marketData: MarketData | null;
  dflowData: DflowData | null;
  momentum: MomentumBlock | null;
  schemaVersion: string;
  jsonVersion: string;
  generatedAt: string; // ISO 8601
}

export interface HTFBias {
  direction: "long" | "short" | "neutral";
  confidence: number; // 0-100
  source: string;     // e.g. "4h"
}

// === Timeframe ===

export interface TimeframeState {
  trend: "up" | "down" | "flat" | "range";
  ema21: number | null;
  ema200: number | null;

  stochRsi: {
    k: number | null;
    d: number | null;
    state: "overbought" | "oversold" | "neutral" | "unknown";
  } | null;

  rsi: {
    value: number;
    overbought: boolean;
    oversold: boolean;
    history?: number[];
  } | null;

  candlestickPatterns: CandlestickPatterns | null;
  wickAnalysis: WickAnalysis | null;

  marketStructure?: MarketStructure | null;
  volatility?: Volatility | null;
  volumeProfile?: VolumeProfile | null;
  liquidityZones?: LiquidityZone[];
  fairValueGaps?: FairValueGap[];
  divergences?: Divergence[];

  confluenceScore: number | null;
  structureSummary: string;
  notes: string;
}

// === Extended Analysis (nested under analysis.{timeframe}) ===

export interface ExtendedTFAnalysis {
  indicators: {
    price: {
      current: number;
      high: number;
      low: number;
    };
    ema: {
      ema21: number | null;
      ema200: number | null;
      ema21History?: number[] | null;
      ema200History?: number[] | null;
    };
    stochRSI: {
      k: number | null;
      d: number | null;
      condition: string;
      history?: Array<{k: number; d: number}> | null;
    };
    rsi: {
      value: number;
      history?: number[];
      overbought: boolean;
      oversold: boolean;
    } | null;
    analysis: {
      trend: string;
      pullbackState: string;
      distanceFrom21EMA: number | null;
    };
    candlestickPatterns?: CandlestickPatterns | null;
    wickAnalysis?: WickAnalysis | null;
    trendStrength?: TrendStrength | null;
  };
  structure: {
    swingHigh: number | null;
    swingLow: number | null;
  } | null;
  candleCount: number;
  lastCandle: Candle;
  
  // Advanced modules
  marketStructure?: MarketStructure | null;
  volatility?: Volatility | null;
  volumeProfile?: VolumeProfile | null;
  liquidityZones?: LiquidityZone[];
  fairValueGaps?: FairValueGap[];
  divergences?: Divergence[];
}

// === Candles / Wick / Patterns ===

export interface Candle {
  timestamp?: number;
  time?: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  closeTime?: number;
}

export interface CandlestickPatterns {
  current: string | null;  // e.g. "THREE_BLACK_CROWS"
  bullish: boolean;
  bearish: boolean;
  patterns: string[];
  allPatterns?: CandlestickPatternMeta[];
}

export interface CandlestickPatternMeta {
  name: string;
  bullish: boolean;
  bearish: boolean;
  confidence: number; // 0-1
}

export interface WickAnalysis {
  upperWickDominance: number; // 0-100
  lowerWickDominance: number; // 0-100
  bodyDominance: number;      // 0-100

  exhaustionSignal: string | null; // e.g. "LOWER_WICK_REJECTION"
  upperWickSize: number;
  lowerWickSize: number;
  bodySize: number;
  range: number;

  wickDominance?: {
    upperWickDominance: number;
    lowerWickDominance: number;
    dominantWick: "UPPER" | "LOWER" | "NONE";
    wickRatio: number;
    upperWickSize: number;
    lowerWickSize: number;
    bodySize: number;
  };

  bodyStrength?: {
    bodyStrength: number;
    bodyStrengthCategory: string;
    bodyToRangeRatio: number;
    bodySize: number;
    range: number;
  };

  exhaustionSignals?: {
    exhaustionSignal: string;
    exhaustionType: string;
    confidence: number;
    wickSize: number;
    bodySize: number;
  };
}

export interface TrendStrength {
  adx: number;
  strong: boolean;
  weak: boolean;
  veryStrong: boolean;
  category: "VERY_STRONG" | "STRONG" | "MODERATE" | "WEAK";
}

// === Market Structure ===

export interface MarketStructure {
  currentStructure: "uptrend" | "downtrend" | "flat" | "range" | "unknown";
  lastSwings: SwingPoint[];
  lastBos: StructureEvent;
  lastChoch: StructureEvent;
}

export interface SwingPoint {
  type: "HH" | "HL" | "LH" | "LL";
  price: number;
  timestamp: number;
}

export interface StructureEvent {
  type: "BOS" | "CHOCH";
  direction: "bullish" | "bearish" | "neutral";
  fromSwing: string;
  toSwing: string;
  price: number | null;
  timestamp: number | null;
}

// === Volatility / ATR ===

export interface Volatility {
  atr: number;
  atrPctOfPrice: number;
  state: "low" | "normal" | "high" | "extreme";
}

// === Volume Profile ===

export interface VolumeProfileNode {
  price: number;
  volume: number;
}

export interface VolumeProfile {
  highVolumeNodes: VolumeProfileNode[];
  lowVolumeNodes: VolumeProfileNode[];
  valueAreaHigh: number;
  valueAreaLow: number;
}

// === Liquidity Zones ===

export interface LiquidityZone {
  type: "equal_highs" | "equal_lows" | "swing_high_cluster" | "swing_low_cluster";
  price: number;
  tolerance: number;
  strength: number; // 0-100
  side: "buy" | "sell";
  touches: number;
}

// === Fair Value Gaps ===

export interface FairValueGap {
  direction: "bullish" | "bearish";
  low: number;
  high: number;
  filled: boolean;
  candleIndex?: number;
}

// === Divergences ===

export interface Divergence {
  oscillator?: "RSI" | "StochRSI";
  type?: "regular" | "hidden";
  side?: "bullish" | "bearish";
  pricePointIndex?: number;
  oscPointIndex?: number;
}

// === Strategies ===

export interface StrategiesBlock {
  SWING: StrategySignal;
  TREND_4H: StrategySignal;
  TREND_RIDER: StrategySignal;
  SCALP_1H: StrategySignal;
  MICRO_SCALP: StrategySignal;
  [key: string]: StrategySignal;
}

export interface StrategySignal {
  valid: boolean;
  direction: "long" | "short" | "NO_TRADE";
  confidence: number;
  reason: string;
  entryZone: { min: number | null; max: number | null };
  stopLoss: number | null;
  invalidationLevel: number | null;
  targets: number[];
  riskReward: {
    tp1RR: number | null;
    tp2RR: number | null;
  };
  validationErrors: string[];
}

// === Market Data / DFlow / Momentum ===

export interface MarketData {
  spread: number;
  spreadPercent: number;
  bid: number;
  ask: number;
  bidAskImbalance: number;
  volumeQuality: "LOW" | "MEDIUM" | "HIGH";
  tradeCount24h: number;
  orderBook: {
    bidLiquidity: number | null;
    askLiquidity: number | null;
    imbalance: number | null;
  };
  recentTrades: {
    overallFlow: string;
    buyPressure: number | null;
    sellPressure: number | null;
    volumeImbalance: number | null;
  };
  apiWorking?: boolean;
}

export interface DflowData {
  symbol: string;
  ticker: string;
  events: any[];
  markets: any[];
  message: string;
}

export interface MomentumBlock {
  score?: number;
  notes?: string;
  [key: string]: any;
}
