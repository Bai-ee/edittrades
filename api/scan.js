/**
 * Vercel Serverless Function: Market Scanner Endpoint
 * GET /api/scan?minConfidence=50&maxResults=25&direction=long
 * 
 * Scans all supported coins and returns trading opportunities
 */

import * as scannerService from '../services/scanner.js';

/** Round for display without turning a missing value into a number. */
function round2(value) {
  return Number.isFinite(value) ? parseFloat(value.toFixed(2)) : null;
}

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Parse query parameters
    // 0-100, matching the scale the engine uses everywhere. This was 0.5 and
    // was compared straight against a 0-100 confidence, so the filter passed
    // every signal.
    const minConfidence = parseFloat(req.query.minConfidence) || 50;
    const maxResults = parseInt(req.query.maxResults) || 50;
    const intervals = req.query.intervals 
      ? req.query.intervals.split(',').map(i => i.trim())
      : ['4h', '1h', '15m', '5m'];
    const direction = req.query.direction || null;
    const useAllKrakenPairs = req.query.all === 'true';

    console.log(`[Scan] Starting scan with minConfidence=${minConfidence}, maxResults=${maxResults}`);

    // Run the scanner
    const scanResults = await scannerService.scanAllCoins({
      minConfidence,
      maxResults,
      intervals,
      useAllKrakenPairs
    });

    // Apply direction filter if specified
    let opportunities = scanResults.opportunities;
    if (direction) {
      opportunities = scannerService.filterOpportunities(opportunities, { direction });
    }

    // Build response
    const response = {
      summary: {
        ...scanResults.summary,
        filteredCount: opportunities.length
      },
      // Read the canonical shape { symbol, price, signal, meta }. This mapper
      // previously read snake_case fields — `entry_zone`, `stop_loss`,
      // `reason_summary` — that the scanner has never produced, so any
      // opportunity reaching here would have thrown a TypeError. It never did,
      // only because the scanner's filter was also broken and the list was
      // always empty. Both halves had to be wrong for the endpoint to look fine.
      opportunities: opportunities.map((opp) => {
        const signal = opp.signal || {};
        const targets = Array.isArray(signal.targets) ? signal.targets : [];
        return {
          symbol: opp.symbol,
          direction: String(signal.direction || 'NO_TRADE').toUpperCase(),
          confidence: round2(signal.confidence),
          entryZone: {
            min: round2(signal.entryZone?.min),
            max: round2(signal.entryZone?.max)
          },
          stopLoss: round2(signal.stopLoss),
          targets: { tp1: round2(targets[0]), tp2: round2(targets[1]) },
          currentPrice: round2(opp.price ?? opp.currentPrice),
          priceChange24h: round2(opp.priceChange24h),
          reason: signal.reason ?? null,
          strategy: signal.selectedStrategy ?? null,
          timestamp: opp.meta?.scanTime ?? null
        };
      })
    };

    console.log(`[Scan] Complete: ${opportunities.length} opportunities found`);

    return res.status(200).json(response);

  } catch (error) {
    console.error('[Scan] Error:', error.message);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}

