import analyzeFull from './analyze-full.js';

/**
 * Compatibility wrapper for the production analyze-full endpoint.
 *
 * The market-data hardening intentionally represents unavailable
 * microstructure fields as null instead of fabricated neutral values. The
 * existing dashboard renderer predates that contract and treats any value
 * other than undefined as numeric for bidAskImbalance, then calls .toFixed().
 * A null therefore crashes the entire recommendation row.
 *
 * Keep the underlying API semantics honest while omitting this one unavailable
 * field from the JSON payload until the dashboard renderer itself is migrated
 * to Number.isFinite guards. JSON omission makes the legacy renderer display
 * N/A instead of throwing.
 */
export default async function handler(req, res) {
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    if (body?.marketData?.bidAskImbalance === null) {
      const marketData = { ...body.marketData };
      delete marketData.bidAskImbalance;
      return originalJson({ ...body, marketData });
    }

    return originalJson(body);
  };

  return analyzeFull(req, res);
}
