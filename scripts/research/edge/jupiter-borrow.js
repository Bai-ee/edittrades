// WP6 (Card 6.1) — measure REAL Jupiter Perps borrow rates (research only, read-only).
// docs/research/harness/WP6_JUPITER_BORROW.md
//   node scripts/research/edge/jupiter-borrow.js [--fixture <path-to-saved-account-dump.json>]
//
// Reads the Jupiter Perps pool + custody accounts from a PUBLIC Solana RPC endpoint
// (https://api.mainnet-beta.solana.com, hardcoded — never reads SOLANA_RPC_URL or any env
// var) and decodes them with the app's own on-chain client library, `jup-perps-client`
// (already a dependency; imported read-only here, no signing, no wallet, no keypair).
// Pool address, custody constants and the FundingRateState/JumpRateState field names +
// units all come from services/jupiterPerps.js (read-only reference) and
// node_modules/jup-perps-client/dist/{accounts,types}/*.d.ts (same package the live app
// uses) — this script does not edit or import that service module (it imports
// walletManager.js, which is out of scope for this WP).
//
// Output: var/research/wp6-borrow/borrow.json
import { createSolanaRpc } from '@solana/kit';
import * as jupPerpsClient from 'jup-perps-client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

// Public RPC only — never read from env (COMMON RULES: no .env reads, no RPC URL from env).
const PUBLIC_RPC_URL = 'https://api.mainnet-beta.solana.com';

// Jupiter Perps pool address (mainnet), from services/jupiterPerps.js JUPITER_PERPS_POOL.
const JUPITER_PERPS_POOL = '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq';

// Mint addresses, from services/jupiterPerps.js PERP_MINTS (public, non-sensitive).
const PERP_MINTS = Object.freeze({
  SOL: 'So11111111111111111111111111111111111111112',
  BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
  ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
});

// Fallback published mainnet custody accounts (services/jupiterPerps.js DEFAULT_PERP_CUSTODIES),
// used only if the pool account can't be read (e.g. offline test / fixture mode).
const DEFAULT_PERP_CUSTODIES = Object.freeze({
  SOL: '7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz',
  ETH: 'AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn',
  BTC: '5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm',
  USDC: 'G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa',
  USDT: '4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk',
});

/**
 * Convert a decoded Custody account's FundingRateState + Assets into the borrow-rate figures
 * this report needs. Pure function (no I/O) so it can be unit-tested against a fixture.
 *
 * Unit note (see docs/research/harness/WP6_JUPITER_BORROW.md "Units" section): the app's own
 * code (services/jupiterPerps.js getPerpQuote) computes
 *   fundingRatePerHour = Number(hourlyFundingDbps) / 1_000_000
 * and treats the result directly as a per-hour fraction (e.g. 0.0002 => 0.02%/h). This script
 * reproduces that exact formula rather than inventing a new one, since the task is to measure
 * what the live app would compute, not to relitigate the app's unit convention. We flag the
 * discrepancy against the on-chain program's own "1 dbps = 1e-5" comment in the report.
 */
const HOURS_PER_YEAR = 24 * 365; // 8760; simple APR<->hourly convention (no leap adjustment)

/**
 * Two-slope "jump rate" / kink model (Compound-style): linear from minRate at 0% utilization
 * to targetRate at targetUtilization, then a steeper linear leg from targetRate to maxRate as
 * utilization goes from targetUtilization to 100%. Pure function, unit-tested directly.
 * @param {number} utilizationPct - 0-100
 * @param {{minRateAprPct:number,maxRateAprPct:number,targetRateAprPct:number,targetUtilizationPct:number}} jumpRate
 * @returns {number} APR percent at this utilization
 */
export function jumpRateAprAt(utilizationPct, jumpRate) {
  const { minRateAprPct, maxRateAprPct, targetRateAprPct, targetUtilizationPct } = jumpRate;
  if (!(targetUtilizationPct > 0) || !(targetUtilizationPct < 100)) return targetRateAprPct;
  if (utilizationPct <= targetUtilizationPct) {
    return minRateAprPct + ((targetRateAprPct - minRateAprPct) * utilizationPct) / targetUtilizationPct;
  }
  const over = (utilizationPct - targetUtilizationPct) / (100 - targetUtilizationPct);
  return targetRateAprPct + (maxRateAprPct - targetRateAprPct) * over;
}

export function custodyToBorrowRow(symbol, custody) {
  const c = custody.data ?? custody;
  const frs = c.fundingRateState;
  const jrs = c.jumpRateState;
  const assets = c.assets;
  const rawHourlyFundingDbps = frs ? Number(frs.hourlyFundingDbps) : null;
  // App convention (services/jupiterPerps.js): value / 1_000_000 => per-hour fraction.
  const appFractionPerHour = rawHourlyFundingDbps !== null ? rawHourlyFundingDbps / 1_000_000 : null;
  const appPercentPerHour = appFractionPerHour !== null ? appFractionPerHour * 100 : null;
  // On-chain program doc convention ("1 dbps = 1e-5 as a fraction"): value / 100_000.
  const docFractionPerHour = rawHourlyFundingDbps !== null ? rawHourlyFundingDbps / 100_000 : null;
  const docPercentPerHour = docFractionPerHour !== null ? docFractionPerHour * 100 : null;

  const owned = assets ? Number(assets.owned) : null;
  const locked = assets ? Number(assets.locked) : null;
  const utilizationPct = owned && owned > 0 ? (locked / owned) * 100 : null;

  // minRateBps/maxRateBps/targetRateBps: "Bps" = hundredths of a percent (raw/100 = percent).
  // Empirically these are ANNUALIZED (APR-style) rates, not per-hour: at raw=3500 (SOL
  // targetRateBps) a per-hour reading (35%/h) would be nonsensical (>1e11% APR compounded),
  // while 35% APR matches the public Gauntlet/Chaos Labs recommendations (see report, ~10-150%
  // APR range historically). targetUtilizationRate is a SEPARATE fixed-point scale (1e9 = 100%,
  // i.e. raw/1e7 = percent) — confirmed against the live SOL/ETH/BTC value 800_000_000 => 80%,
  // matching every public Gauntlet/Chaos Labs post's stated "80% target utilization" (2024-2025).
  const jumpRate = jrs
    ? {
        minRateAprPct: Number(jrs.minRateBps) / 100,
        maxRateAprPct: Number(jrs.maxRateBps) / 100,
        targetRateAprPct: Number(jrs.targetRateBps) / 100,
        targetUtilizationPct: Number(jrs.targetUtilizationRate) / 1e7,
      }
    : null;

  const modelAprPct = jumpRate && utilizationPct !== null ? jumpRateAprAt(utilizationPct, jumpRate) : null;
  const modelPctPerHour = modelAprPct !== null ? modelAprPct / HOURS_PER_YEAR : null;

  return {
    symbol,
    custodyAddress: custody.address ? String(custody.address) : null,
    mint: c.mint ? String(c.mint) : null,
    rawHourlyFundingDbps,
    appPercentPerHour: appPercentPerHour !== null ? Number(appPercentPerHour.toFixed(6)) : null,
    docPercentPerHour: docPercentPerHour !== null ? Number(docPercentPerHour.toFixed(6)) : null,
    cumulativeInterestRate: frs ? frs.cumulativeInterestRate.toString() : null,
    lastUpdate: frs ? Number(frs.lastUpdate) : null,
    utilizationPct: utilizationPct !== null ? Number(utilizationPct.toFixed(3)) : null,
    ownedRaw: owned !== null ? owned.toString() : null,
    lockedRaw: locked !== null ? locked.toString() : null,
    jumpRate,
    modelAprPct: modelAprPct !== null ? Number(modelAprPct.toFixed(4)) : null,
    modelPctPerHour: modelPctPerHour !== null ? Number(modelPctPerHour.toFixed(6)) : null,
  };
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), [])
  );

  let symbolsToCustody;
  let custodyAccounts; // Array<{address, data}> shape compatible with custodyToBorrowRow

  if (args.fixture) {
    // Offline / test path: decode a saved base64 account-data fixture instead of hitting RPC.
    const fixture = JSON.parse(fs.readFileSync(args.fixture, 'utf8'));
    const decoder = jupPerpsClient.getCustodyDecoder();
    custodyAccounts = fixture.custodies.map((entry) => {
      const bytes = Buffer.from(entry.dataBase64, 'base64');
      const decoded = decoder.decode(bytes);
      return { address: entry.address, data: decoded };
    });
    symbolsToCustody = Object.fromEntries(fixture.custodies.map((e) => [e.symbol, e.address]));
  } else {
    const rpc = createSolanaRpc(PUBLIC_RPC_URL);
    let poolCustodies;
    try {
      const pool = await jupPerpsClient.fetchPool(rpc, JUPITER_PERPS_POOL);
      poolCustodies = pool.data.custodies.map((a) => String(a));
    } catch (err) {
      console.error(`[jupiter-borrow] fetchPool failed (${err.message}); falling back to DEFAULT_PERP_CUSTODIES`);
      poolCustodies = Object.values(DEFAULT_PERP_CUSTODIES);
    }
    const fetched = await jupPerpsClient.fetchAllCustody(rpc, poolCustodies);
    const symbolOfMint = Object.fromEntries(Object.entries(PERP_MINTS).map(([k, v]) => [v, k]));
    custodyAccounts = [];
    symbolsToCustody = {};
    for (const acct of fetched) {
      const sym = symbolOfMint[String(acct.data.mint)];
      if (!sym) continue;
      custodyAccounts.push({ address: acct.address, data: acct.data });
      symbolsToCustody[sym] = String(acct.address);
    }
  }

  const bySymbol = {};
  for (const acct of custodyAccounts) {
    const sym = Object.entries(symbolsToCustody).find(([, addr]) => addr === String(acct.address))?.[0];
    if (!sym) continue;
    bySymbol[sym] = custodyToBorrowRow(sym, acct);
  }

  const out = {
    generatedAtUtc: new Date().toISOString(),
    rpc: args.fixture ? `fixture:${args.fixture}` : PUBLIC_RPC_URL,
    pool: JUPITER_PERPS_POOL,
    custodies: bySymbol,
  };

  const outDir = path.join(REPO_ROOT, 'var/research/wp6-borrow');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'borrow.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`Wrote ${outFile}`);
  for (const [sym, row] of Object.entries(bySymbol)) {
    console.log(
      `${sym}: model=${row.modelPctPerHour}%/h (${row.modelAprPct}% APR) util=${row.utilizationPct}% ` +
      `hourlyFundingDbps(legacy)=${row.rawHourlyFundingDbps}`
    );
  }
  return out;
}

// Only run when executed directly (so `import { custodyToBorrowRow }` in tests is side-effect-free).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[jupiter-borrow] failed:', err);
    process.exitCode = 1;
  });
}
