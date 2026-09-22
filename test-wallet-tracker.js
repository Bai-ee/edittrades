/**
 * Test suite: services/walletTracker.js
 *
 * The rules under test, in order of importance:
 *   1. Margin is stablecoins only. SOL/BTC/ETH must never be counted as risk capital.
 *   2. P&L is measured on margin only, so a market move cannot look like a trade result.
 *   3. An unpriceable position is disclosed and excluded, never valued.
 *   4. A degraded read never fabricates a number that looks like a real balance.
 */

import {
  getAccountSnapshot,
  maskAddress,
  STABLE_MINTS,
  PRICED_MINTS,
  MIN_GAS_SOL
} from './services/walletTracker.js';

const VALID_ADDRESS = 'F48QuZqufNiY7DRuj5fCGEWKkHyuBfTGphqWLNhNKeCi';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const WBTC = '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';
const WETH = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs';
const MEMECOIN = 'DagUX84qhzHfmL7zjVkP5sFCtLLfCueeN5oHZbn9ESgZ';

const PRICES = { SOL: 100, BTC: 80000, ETH: 3000 };

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg} (expected ${expected}, got ${actual})`);
  }
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${error.message}`);
    failed++;
    failures.push(name);
  }
}

/**
 * fetch stub answering both RPC methods from a script.
 * @param {Object} script - { sol: number|Error, tokens: Array<[mint, uiAmount]>|Error }
 */
function makeFetch(script) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);

    if (body.method === 'getBalance') {
      if (script.sol instanceof Error) throw script.sol;
      return { ok: true, json: async () => ({ result: { value: (script.sol ?? 0) * 1e9 } }) };
    }

    if (body.method === 'getTokenAccountsByOwner') {
      if (script.tokens instanceof Error) throw script.tokens;

      // Mirror the real node: the owner filter must carry exactly one key.
      const filter = body.params[1];
      if (!filter || Object.keys(filter).length !== 1) {
        return {
          ok: true,
          json: async () => ({
            error: { message: 'Invalid param at index 1: invalid value: map, expected map with a single key' }
          })
        };
      }

      return {
        ok: true,
        json: async () => ({
          result: {
            value: (script.tokens || []).map(([mint, uiAmount]) => ({
              account: { data: { parsed: { info: { mint, tokenAmount: { uiAmount } } } } }
            }))
          }
        })
      };
    }

    throw new Error(`unexpected rpc method ${body.method}`);
  };
}

const base = {
  address: VALID_ADDRESS,
  rpcUrl: 'https://rpc.test.invalid',
  now: Date.parse('2026-09-22T00:00:00.000Z'),
  prices: PRICES
};

async function run() {
  console.log('\nmargin is stablecoins only');

  await test('margin sums USDC and USDT, and nothing else', async () => {
    const s = await getAccountSnapshot({
      ...base,
      fetchImpl: makeFetch({ sol: 4, tokens: [[USDC, 717.18], [USDT, 99.96], [WBTC, 0.5]] })
    });
    assertEqual(s.margin.usd, 817.14, 'wrong margin total');
    assertEqual(s.margin.byAsset.USDC, 717.18, 'wrong USDC');
    assertEqual(s.margin.byAsset.USDT, 99.96, 'wrong USDT');
    assertEqual(s.margin.byAsset.BTC, undefined, 'BTC leaked into margin');
  });

  await test('native SOL is a holding, never margin', async () => {
    const s = await getAccountSnapshot({
      ...base,
      fetchImpl: makeFetch({ sol: 4, tokens: [[USDC, 100]] })
    });
    assertEqual(s.margin.usd, 100, 'SOL was counted as margin');
    const solHolding = s.holdings.find((h) => h.asset === 'SOL');
    assertEqual(solHolding.amount, 4, 'SOL missing from holdings');
    assertEqual(solHolding.usdValue, 400, 'wrong SOL valuation');
  });

  await test('BTC and ETH are holdings, never margin', async () => {
    const s = await getAccountSnapshot({
      ...base,
      fetchImpl: makeFetch({ sol: 0, tokens: [[WBTC, 0.01], [WETH, 0.1]] })
    });
    assertEqual(s.margin.usd, 0, 'a volatile asset was counted as margin');
    assertEqual(s.holdingsUsd, 1100, 'wrong holdings total');
  });

  await test('a wallet with no stablecoins has zero margin, not null', async () => {
    const s = await getAccountSnapshot({
      ...base,
      fetchImpl: makeFetch({ sol: 4, tokens: [[WBTC, 0.5]] })
    });
    assertEqual(s.margin.usd, 0, 'wrong margin for a stable-free wallet');
    assertEqual(s.status, 'available', 'a stable-free wallet is still a valid read');
  });

  console.log('\nP&L is measured on margin only');

  await test('a flat wallet at baseline shows zero P&L', async () => {
    const s = await getAccountSnapshot({
      ...base,
      baselineUsd: 817.14,
      fetchImpl: makeFetch({ sol: 4, tokens: [[USDC, 717.18], [USDT, 99.96]] })
    });
    assertEqual(s.performance.netPnlUsd, 0, 'wrong P&L');
    assertEqual(s.performance.returnPct, 0, 'wrong return');
    assertEqual(s.performance.source, 'config', 'wrong source');
  });

  await test('a winning trade shows as margin above baseline', async () => {
    const s = await getAccountSnapshot({
      ...base,
      baselineUsd: 800,
      fetchImpl: makeFetch({ sol: 4, tokens: [[USDC, 900]] })
    });
    assertEqual(s.performance.netPnlUsd, 100, 'wrong P&L');
    assertEqual(s.performance.returnPct, 12.5, 'wrong return pct');
  });

  await test('a losing trade shows as margin below baseline', async () => {
    const s = await getAccountSnapshot({
      ...base,
      baselineUsd: 800,
      fetchImpl: makeFetch({ sol: 4, tokens: [[USDC, 700]] })
    });
    assertEqual(s.performance.netPnlUsd, -100, 'wrong P&L');
    assertEqual(s.performance.returnPct, -12.5, 'wrong return pct');
  });

  await test('a BTC price move does NOT move P&L', async () => {
    // The whole point of the margin/holdings split: a market move must not look like a
    // trade result, or the win-rate measurement built on top of it is meaningless.
    const script = { sol: 4, tokens: [[USDC, 800], [WBTC, 1]] };
    const cheap = await getAccountSnapshot({ ...base, baselineUsd: 800, fetchImpl: makeFetch(script) });
    const rich = await getAccountSnapshot({
      ...base,
      baselineUsd: 800,
      prices: { ...PRICES, BTC: 160000 },
      fetchImpl: makeFetch(script)
    });
    assertEqual(cheap.performance.netPnlUsd, 0, 'baseline case should be flat');
    assertEqual(rich.performance.netPnlUsd, 0, 'a BTC doubling leaked into P&L');
    assert(rich.holdingsUsd > cheap.holdingsUsd, 'holdings should still reflect the move');
  });

  await test('no baseline means no P&L claim', async () => {
    // null, not undefined: undefined correctly falls through to the configured env value.
    const s = await getAccountSnapshot({
      ...base,
      baselineUsd: null,
      fetchImpl: makeFetch({ sol: 4, tokens: [[USDC, 900]] })
    });
    assertEqual(s.performance.baselineUsd, null, 'invented a baseline');
    assertEqual(s.performance.netPnlUsd, null, 'claimed P&L without a baseline');
  });

  await test('a nonsense baseline is refused rather than used', async () => {
    for (const bad of ['abc', '0', '-100', '']) {
      const s = await getAccountSnapshot({
        ...base,
        baselineUsd: bad,
        fetchImpl: makeFetch({ sol: 4, tokens: [[USDC, 900]] })
      });
      assertEqual(s.performance.netPnlUsd, null, `accepted a bad baseline: ${bad}`);
    }
  });

  console.log('\nunpriceable positions are disclosed, not valued');

  await test('an unrecognized mint is excluded from capital entirely', async () => {
    const s = await getAccountSnapshot({
      ...base,
      fetchImpl: makeFetch({ sol: 0, tokens: [[USDC, 100], [MEMECOIN, 1366501.98]] })
    });
    assertEqual(s.margin.usd, 100, 'a memecoin leaked into margin');
    assertEqual(s.holdingsUsd, 0, 'a memecoin was given a value');
    assertEqual(s.unpriced.length, 1, 'the memecoin was not disclosed');
    assertEqual(s.unpriced[0].reason, 'unrecognized mint', 'wrong disclosure reason');
  });

  await test('an unrecognized mint does not degrade status', async () => {
    const s = await getAccountSnapshot({
      ...base,
      fetchImpl: makeFetch({ sol: 0, tokens: [[USDC, 100], [MEMECOIN, 999]] })
    });
    assertEqual(s.status, 'available', 'dust tokens should not make the snapshot partial');
    assertEqual(s.reason, null, 'dust tokens should not raise a reason');
  });

  await test('a tracked asset with no price DOES degrade status', async () => {
    const s = await getAccountSnapshot({
      ...base,
      prices: { SOL: null, BTC: 80000, ETH: 3000 },
      fetchImpl: makeFetch({ sol: 4, tokens: [[USDC, 100]] })
    });
    assertEqual(s.status, 'partial', 'a missing SOL price should degrade the snapshot');
    assertEqual(s.margin.usd, 100, 'margin must stay exact regardless');
    assert(s.unpriced.some((u) => u.asset === 'SOL'), 'unpriced SOL not disclosed');
  });

  await test('zero-balance token accounts are dropped', async () => {
    const s = await getAccountSnapshot({
      ...base,
      fetchImpl: makeFetch({ sol: 0, tokens: [[USDC, 100], [MEMECOIN, 0], [WBTC, 0]] })
    });
    assertEqual(s.unpriced.length, 0, 'a closed account was reported as a holding');
    assertEqual(s.holdings.length, 0, 'a zero BTC account was reported as a holding');
  });

  await test('several accounts of one mint are summed', async () => {
    const s = await getAccountSnapshot({
      ...base,
      fetchImpl: makeFetch({ sol: 0, tokens: [[USDC, 10.5], [USDC, 20.25], [USDC, 5]] })
    });
    assertEqual(s.margin.usd, 35.75, 'did not sum every USDC account');
  });

  console.log('\ngas');

  await test('sufficient gas is reported', async () => {
    const s = await getAccountSnapshot({
      ...base,
      fetchImpl: makeFetch({ sol: 4, tokens: [[USDC, 100]] })
    });
    assertEqual(s.gas.sufficient, true, 'wrong gas verdict');
    assertEqual(s.gas.minSol, MIN_GAS_SOL, 'gas floor not disclosed');
  });

  await test('insufficient gas is flagged even with healthy margin', async () => {
    const s = await getAccountSnapshot({
      ...base,
      fetchImpl: makeFetch({ sol: 0.001, tokens: [[USDC, 5000]] })
    });
    assertEqual(s.gas.sufficient, false, 'a wallet that cannot pay fees was not flagged');
    assertEqual(s.margin.usd, 5000, 'margin should be unaffected by the gas verdict');
  });

  console.log('\ndegraded reads and disclosure');

  await test('no tracked address is disabled, not an error', async () => {
    const s = await getAccountSnapshot({ ...base, address: '', fetchImpl: makeFetch({}) });
    assertEqual(s.status, 'disabled', 'wrong status');
    assertEqual(s.margin.usd, null, 'disabled must not report margin');
  });

  await test('a malformed address is rejected before any RPC call', async () => {
    let called = false;
    const s = await getAccountSnapshot({
      ...base,
      address: 'not-a-real-address!!',
      fetchImpl: async () => { called = true; throw new Error('should not be called'); }
    });
    assertEqual(s.status, 'unavailable', 'wrong status');
    assert(!called, 'spent an RPC call on an invalid address');
  });

  await test('a failed balance read reports no capital at all', async () => {
    const s = await getAccountSnapshot({
      ...base,
      fetchImpl: makeFetch({ sol: new Error('node down'), tokens: [[USDC, 100]] })
    });
    assertEqual(s.status, 'unavailable', 'wrong status');
    assertEqual(s.margin.usd, null, 'reported margin despite a failed read');
    assertEqual(s.performance.netPnlUsd, null, 'reported P&L despite a failed read');
    assert(s.reason.includes('node down'), 'reason did not survive');
  });

  await test('a failed token read fails the whole snapshot, not just holdings', async () => {
    // Margin lives in the token accounts, so losing that call means losing margin.
    // Reporting a partial snapshot here would understate risk capital.
    const s = await getAccountSnapshot({
      ...base,
      fetchImpl: makeFetch({ sol: 4, tokens: new Error('token query failed') })
    });
    assertEqual(s.status, 'unavailable', 'wrong status');
    assertEqual(s.margin.usd, null, 'reported margin from a failed token read');
  });

  await test('an HTTP error is surfaced as unavailable', async () => {
    const s = await getAccountSnapshot({
      ...base,
      fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) })
    });
    assertEqual(s.status, 'unavailable', 'wrong status');
    assert(s.reason.includes('429'), 'lost the HTTP status');
  });

  await test('a hung RPC node is bounded by the timeout', async () => {
    const s = await getAccountSnapshot({
      ...base,
      timeoutMs: 40,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })
    });
    assertEqual(s.status, 'unavailable', 'a hung node did not degrade cleanly');
    assert(s.reason.includes('timeout'), 'timeout not disclosed');
  });

  await test('getAccountSnapshot never throws, whatever fetch does', async () => {
    const s = await getAccountSnapshot({
      ...base,
      fetchImpl: () => { throw new Error('synchronous explosion'); }
    });
    assertEqual(s.status, 'unavailable', 'a throwing fetch was not contained');
  });

  await test('only a masked address is emitted', async () => {
    const s = await getAccountSnapshot({
      ...base,
      fetchImpl: makeFetch({ sol: 4, tokens: [[USDC, 100]] })
    });
    assertEqual(s.address, 'F48Q...KeCi', 'address not masked as expected');
    assert(!JSON.stringify(s).includes(VALID_ADDRESS), 'full address leaked into the payload');
  });

  await test('the RPC url never reaches the payload', async () => {
    // A paid endpoint embeds its API key in the url.
    const s = await getAccountSnapshot({
      ...base,
      rpcUrl: 'https://rpc.example.invalid/?api-key=SENTINEL_SECRET',
      fetchImpl: makeFetch({ sol: 4, tokens: [[USDC, 100]] })
    });
    assert(!JSON.stringify(s).includes('SENTINEL_SECRET'), 'snapshot leaked the RPC key');
    assert(!JSON.stringify(s).includes('rpc.example.invalid'), 'snapshot leaked the RPC host');
  });

  await test('maskAddress refuses to guess at a too-short input', () => {
    assertEqual(maskAddress('abc'), null, 'masked a string that was too short');
    assertEqual(maskAddress(null), null, 'masked a non-string');
  });

  await test('the stablecoin and priced mint maps are the canonical ones', () => {
    assertEqual(STABLE_MINTS[USDC], 'USDC', 'wrong USDC mint');
    assertEqual(STABLE_MINTS[USDT], 'USDT', 'wrong USDT mint');
    assertEqual(PRICED_MINTS[WBTC], 'BTC', 'wrong wBTC mint');
    assertEqual(PRICED_MINTS[WETH], 'ETH', 'wrong wETH mint');
    assertEqual(Object.keys(STABLE_MINTS).length, 2, 'unexpected stablecoin count');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\nFAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
}

run();
