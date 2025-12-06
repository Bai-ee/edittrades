/**
 * Position Manager Service
 * Tracks and manages perpetual positions
 * Handles position data storage, P&L calculation, and position queries
 */

import * as jupiterPerps from './jupiterPerps.js';

// In-memory position storage (for MVP - can be moved to database later)
const positions = new Map(); // { positionId: positionData }

/**
 * Track a new perpetual position
 * @param {string} positionId - Position ID from Jupiter Perps
 * @param {Object} signal - Original strategy signal
 * @param {number} leverage - Leverage used
 * @param {Object} executionResult - Execution result from tradeExecution
 * @returns {Object} Tracked position data
 */
export function trackPerpPosition(positionId, signal, leverage, executionResult) {
  try {
    console.log('[PositionManager] Tracking new perpetual position...');
    console.log('[PositionManager] Position ID:', positionId);
    console.log('[PositionManager] Symbol:', signal.symbol);
    console.log('[PositionManager] Leverage:', leverage, 'x');

    const position = {
      positionId,
      symbol: signal.symbol || signal.pair,
      direction: signal.direction,
      leverage,
      entryZone: signal.entryZone,
      entryPrice: executionResult.entryPrice || (signal.entryZone.min + signal.entryZone.max) / 2,
      stopLoss: signal.stopLoss,
      targets: signal.targets,
      size: executionResult.size,
      marginRequired: executionResult.marginRequired,
      liquidationPrice: executionResult.liquidationPrice,
      signature: executionResult.signature,
      openedAt: new Date().toISOString(),
      status: 'OPEN',
      pnl: 0,
      pnlPercent: 0,
      currentPrice: null,
      fundingFees: 0,
    };

    positions.set(positionId, position);

    console.log('[PositionManager] ✅ Position tracked');
    return position;
  } catch (error) {
    console.error('[PositionManager] ❌ Error tracking position:', error.message);
    throw error;
  }
}

/**
 * Get all tracked positions
 * @param {string} symbol - Optional symbol filter
 * @returns {Array} Array of position objects
 */
export function getTrackedPositions(symbol = null) {
  const allPositions = Array.from(positions.values());
  
  if (symbol) {
    return allPositions.filter(p => p.symbol === symbol);
  }
  
  return allPositions;
}

/**
 * Get a specific position by ID
 * @param {string} positionId - Position ID
 * @returns {Object|null} Position data or null if not found
 */
export function getPosition(positionId) {
  return positions.get(positionId) || null;
}

/**
 * Update position P&L from on-chain data
 * @param {string} positionId - Position ID
 * @returns {Promise<Object>} Updated position with P&L
 */
export async function updatePerpPositionPnl(positionId) {
  try {
    console.log('[PositionManager] Updating P&L for position:', positionId);
    
    const position = positions.get(positionId);
    if (!position) {
      throw new Error(`Position not found: ${positionId}`);
    }

    // Get position details from Jupiter Perps
    const perpDetails = await jupiterPerps.getPerpPositionDetails(positionId);
    
    // Update position with current data
    position.currentPrice = perpDetails.currentPrice;
    position.pnl = perpDetails.pnl || 0;
    position.pnlPercent = perpDetails.pnlPercent || 0;
    position.liquidationPrice = perpDetails.liquidationPrice || position.liquidationPrice;
    position.fundingFees = perpDetails.fundingFees || 0;
    position.status = perpDetails.status || position.status;

    positions.set(positionId, position);

    console.log('[PositionManager] ✅ P&L updated');
    console.log('[PositionManager] P&L:', position.pnl, 'USD');
    console.log('[PositionManager] P&L %:', position.pnlPercent, '%');

    return position;
  } catch (error) {
    console.error('[PositionManager] ❌ Error updating P&L:', error.message);
    throw error;
  }
}

/**
 * Check if position is at liquidation risk
 * @param {string} positionId - Position ID
 * @returns {Promise<Object>} Risk assessment
 */
export async function checkLiquidationRisk(positionId) {
  try {
    const position = positions.get(positionId);
    if (!position) {
      throw new Error(`Position not found: ${positionId}`);
    }

    // Update P&L first
    await updatePerpPositionPnl(positionId);

    const currentPrice = position.currentPrice;
    const liquidationPrice = position.liquidationPrice;
    const entryPrice = position.entryPrice;

    if (!currentPrice || !liquidationPrice) {
      return {
        atRisk: false,
        reason: 'Price data unavailable',
      };
    }

    // Calculate distance to liquidation
    let distanceToLiquidation;
    if (position.direction === 'long') {
      distanceToLiquidation = ((currentPrice - liquidationPrice) / currentPrice) * 100;
    } else {
      distanceToLiquidation = ((liquidationPrice - currentPrice) / currentPrice) * 100;
    }

    // Risk levels
    let riskLevel = 'LOW';
    if (distanceToLiquidation < 5) {
      riskLevel = 'CRITICAL';
    } else if (distanceToLiquidation < 10) {
      riskLevel = 'HIGH';
    } else if (distanceToLiquidation < 20) {
      riskLevel = 'MEDIUM';
    }

    const atRisk = distanceToLiquidation < 20;

    return {
      atRisk,
      riskLevel,
      distanceToLiquidation: Math.abs(distanceToLiquidation),
      currentPrice,
      liquidationPrice,
      entryPrice,
      pnl: position.pnl,
      pnlPercent: position.pnlPercent,
    };
  } catch (error) {
    console.error('[PositionManager] ❌ Error checking liquidation risk:', error.message);
    throw error;
  }
}

/**
 * Close a tracked position
 * @param {string} positionId - Position ID
 * @returns {Promise<Object>} Closed position data
 */
export async function closeTrackedPosition(positionId) {
  try {
    console.log('[PositionManager] Closing tracked position:', positionId);

    const position = positions.get(positionId);
    if (!position) {
      throw new Error(`Position not found: ${positionId}`);
    }

    // Update final P&L
    await updatePerpPositionPnl(positionId);

    // Mark as closed
    position.status = 'CLOSED';
    position.closedAt = new Date().toISOString();

    positions.set(positionId, position);

    console.log('[PositionManager] ✅ Position closed');
    return position;
  } catch (error) {
    console.error('[PositionManager] ❌ Error closing position:', error.message);
    throw error;
  }
}

/**
 * Get all open positions
 * @returns {Array} Array of open positions
 */
export function getOpenPositions() {
  return Array.from(positions.values()).filter(p => p.status === 'OPEN');
}

/**
 * Get all closed positions
 * @returns {Array} Array of closed positions
 */
export function getClosedPositions() {
  return Array.from(positions.values()).filter(p => p.status === 'CLOSED');
}

/**
 * Save positions to localStorage (for persistence across page refreshes)
 * @returns {void}
 */
export function savePositionsToStorage() {
  try {
    const positionsArray = Array.from(positions.values());
    localStorage.setItem('perpPositions', JSON.stringify(positionsArray));
    console.log('[PositionManager] ✅ Positions saved to localStorage');
  } catch (error) {
    console.error('[PositionManager] ❌ Error saving positions:', error.message);
  }
}

/**
 * Load positions from localStorage
 * @returns {void}
 */
export function loadPositionsFromStorage() {
  try {
    const stored = localStorage.getItem('perpPositions');
    if (!stored) {
      console.log('[PositionManager] No stored positions found');
      return;
    }

    const positionsArray = JSON.parse(stored);
    positions.clear();

    positionsArray.forEach(position => {
      positions.set(position.positionId, position);
    });

    console.log('[PositionManager] ✅ Loaded', positionsArray.length, 'positions from localStorage');
  } catch (error) {
    console.error('[PositionManager] ❌ Error loading positions:', error.message);
  }
}


