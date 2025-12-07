/**
 * Volume Analysis Module
 * 
 * Analyzes volume trends and patterns
 */

/**
 * Calculate volume analysis
 * @param {Array} candles - OHLCV array with volume data
 * @param {Number} period - Period for average calculation (default 20)
 * @returns {Object} Volume analysis or null if no volume data
 */
export function calculateVolumeAnalysis(candles, period = 20) {
  if (!Array.isArray(candles) || candles.length < period) {
    return null;
  }

  // Check if volume data exists (at least some candles have volume)
  const hasVolume = candles.some(c => c.volume !== undefined && c.volume !== null && c.volume > 0);
  if (!hasVolume) {
    return null; // No volume data available
  }

  // Get current and recent volumes
  const currentVolume = candles[candles.length - 1].volume;
  const recentVolumes = candles.slice(-period).map(c => c.volume);
  
  // Calculate average volume
  const avgVolume = recentVolumes.reduce((sum, vol) => sum + vol, 0) / period;
  
  // Determine trend (compare last 5 candles avg to previous 5 candles avg)
  let volumeTrend = 'neutral';
  if (candles.length >= 10) {
    const last5Avg = candles.slice(-5).reduce((sum, c) => sum + c.volume, 0) / 5;
    const prev5Avg = candles.slice(-10, -5).reduce((sum, c) => sum + c.volume, 0) / 5;
    
    if (last5Avg > prev5Avg * 1.2) {
      volumeTrend = 'increasing';
    } else if (last5Avg < prev5Avg * 0.8) {
      volumeTrend = 'decreasing';
    }
  }

  return {
    current: parseFloat(currentVolume.toFixed(0)),
    avg20: parseFloat(avgVolume.toFixed(0)),
    trend: volumeTrend
  };
}

