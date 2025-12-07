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
  if (!Array.isArray(candles) || candles.length < 1) {
    return null;
  }

  // Check if volume data exists (at least some candles have volume)
  const hasVolume = candles.some(c => c.volume !== undefined && c.volume !== null && c.volume > 0);
  if (!hasVolume) {
    return null; // No volume data available
  }

  // Get current volume
  const currentVolume = candles[candles.length - 1]?.volume;
  if (!currentVolume || currentVolume <= 0) {
    return null;
  }

  // Calculate average volume (use available candles, minimum 5)
  const availablePeriod = Math.min(period, candles.length);
  const recentVolumes = candles.slice(-availablePeriod)
    .map(c => c.volume)
    .filter(v => v !== undefined && v !== null && v > 0);
  
  if (recentVolumes.length === 0) {
    return null;
  }
  
  const avgVolume = recentVolumes.reduce((sum, vol) => sum + vol, 0) / recentVolumes.length;
  
  // Determine trend (compare last 5 candles avg to previous 5 candles avg)
  let volumeTrend = 'neutral';
  if (candles.length >= 10) {
    const last5 = candles.slice(-5).map(c => c.volume).filter(v => v && v > 0);
    const prev5 = candles.slice(-10, -5).map(c => c.volume).filter(v => v && v > 0);
    
    if (last5.length > 0 && prev5.length > 0) {
      const last5Avg = last5.reduce((sum, vol) => sum + vol, 0) / last5.length;
      const prev5Avg = prev5.reduce((sum, vol) => sum + vol, 0) / prev5.length;
      
      if (last5Avg > prev5Avg * 1.2) {
        volumeTrend = 'up';
      } else if (last5Avg < prev5Avg * 0.8) {
        volumeTrend = 'down';
      }
    }
  }

  return {
    current: parseFloat(currentVolume.toFixed(0)),
    avg20: availablePeriod >= 5 ? parseFloat(avgVolume.toFixed(0)) : null,
    trend: volumeTrend
  };
}

