/**
 * Vercel Serverless Function: Market Scanner Endpoint
 * GET /api/scan?minConfidence=0.5&maxResults=25&direction=long
 * 
 * Scans all supported coins and returns trading opportunities
 */

import * as scannerService from '../services/scanner.js';

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
    const minConfidence = parseFloat(req.query.minConfidence) || 0.5;
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
      opportunities: opportunities.map(opp => ({
        symbol: opp.symbol,
        direction: opp.direction.toUpperCase(),
        confidence: parseFloat(opp.confidence.toFixed(2)),
        entryZone: {
          min: parseFloat(opp.entry_zone.min.toFixed(2)),
          max: parseFloat(opp.entry_zone.max.toFixed(2))
        },
        stopLoss: parseFloat(opp.stop_loss.toFixed(2)),
        targets: {
          tp1: parseFloat(opp.targets[0].toFixed(2)),
          tp2: parseFloat(opp.targets[1].toFixed(2))
        },
        currentPrice: parseFloat(opp.currentPrice.toFixed(2)),
        priceChange24h: parseFloat(opp.priceChange24h.toFixed(2)),
        reason: opp.reason_summary,
        trend: opp.trend,
        timestamp: opp.scanTime
      }))
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

