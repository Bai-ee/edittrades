# Prompt — T-3 agent D (Jupiter perps correctness). Paste into a separate Claude Code session (Opus).

You are agent D for EditTrades T-3: correct the Jupiter perps integration code. Repo /Users/bballi/Documents/Repos/snapshot_tradingview, branch upgrade-signal-engine at local HEAD (do NOT pull/rebase; leave PRODUCT.md and docs/ARCHITECTURE_MAP.verify.json alone). CODE-ONLY: no network calls, no RPC, no wallet loading, no env changes, no deploy; tests use mocked connections and fake keys.

Read docs/PLAN_TELEGRAM_EXECUTION.md, CLAUDE.md, services/jupiterPerps.js (all), services/jup-perps-wrapper.cjs and the patched node_modules/jup-perps-client (IDL, instruction builders, account encoders), patches/, lib/execution/executor.js + gates.js (which `live_*_unsupported` refusals exist; how open/close/update/quote/markets/custody are called), test-execution.js, services/perpsProvider.js.

Known defects: openPerpPosition passes side 0/1 but the program enum is None=0, Long=1, Short=2 (a short would open as a long); custody-by-index mapping unverified (resolve by mint); SL/TP not placed on chain; closePerpPosition/updatePerpPosition are stubs; perpsProvider.js expects an array from getPerpPositions.

Do, in services/jupiterPerps.js (+ helpers) with tests in test-jupiter-perps.js (npm `test:jupiter`):
1. Fix the side enum. Resolve custodies/collateral custodies by mint with an explicit table (asset custody for longs; stable custody for shorts), validated against fetched pool/custody accounts via an injected connection (mocked in tests).
2. Build the real Perps v2 request flow per the IDL: increase-position request with SL/TP trigger prices where supported, else separate trigger (decrease) requests after the open; close = full-size decrease (market); update stops = create/replace trigger requests. Compute-budget/priority-fee instructions; ATA-create when missing. Cite IDL instruction names in comments.
3. Separate BUILD from SEND: each operation returns `{ transaction, simulate(connection), send(signer, connection) }`; the only broadcast path is one exported `sendSigned(tx, signer, connection)` the executor calls in live mode. `JUPITER_SIMULATE_ONLY=true` → open/close/update return `{ simulated:true, logs, unitsConsumed, err }` from simulateTransaction (mocked in tests).
4. getPerpPositions keeps `{ok, positions, error}`; update services/perpsProvider.js to read `.positions`.
5. lib/execution/gates.js: enable gate `TRADE_EXECUTION_ENABLED` → `EXECUTION_ENABLED` (executor's own flag; legacy REST keeps its own); update docs/EDITTRADES_MCP_CONNECTOR.md env table and test-execution.js. Remove `live_*_unsupported` refusals only for operations genuinely implemented; list what remains.
6. Tests: side enum; custody-by-mint table; instruction encode/decode round trip against the IDL for open (with SL/TP), close, update; ATA-create inclusion; simulate path; no send outside sendSigned; getPerpPositions shape; perpsProvider compatibility.

All suites green, git diff --check. Commit locally only: "feat(jupiter): side/custody fix, on-chain SL/TP, real close/update, build-simulate-send split; EXECUTION_ENABLED flag (T-3 D)". DO NOT PUSH. Report under 300 words: live-capable vs still unsupported, instruction names, test counts, sha.
