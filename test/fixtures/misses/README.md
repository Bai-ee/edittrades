# Miss log

One JSON file per logged miss: a read the system got wrong, what the chart (or the corrected math) showed, and what feature closes the gap. The miss log is repo fixtures, never a write API (plan, "Out of scope"). `npm run test:replay` validates every file here against the schema below and checks that every referenced regression test exists.

## Schema

| Field | Type | Rule |
| --- | --- | --- |
| `id` | string | `MISS_NNN`, equal to the file name without `.json` |
| `date` | string | `YYYY-MM-DD`, the day of the miss |
| `symbol` | string | `BTC`, `SOL` or `ETH` |
| `timeframe` | string | one of `1m 3m 5m 15m 1h 4h 1d` |
| `preImageRead` | string | what was said before the chart or correction, non-empty |
| `missingFeature` | string | what the payload lacked, non-empty |
| `postImageRead` | string | what the chart or corrected math showed, non-empty |
| `missClass` | string | one of the classes below |
| `fixLocation` | string | module(s) that own the fix, non-empty |
| `proposedFeature` | string | the feature that closes the gap, non-empty |
| `status` | string | `proposed`, `implemented`, `validated` or `superseded` |
| `regressionTest` | array | `[{ file, name }]`. `file` is a repo-root test file. `name` is a test title in that file; a template title (`${label}`) matches any value in its placeholder. Required non-empty unless `status` is `proposed`. |
| `source` | string | optional: where the narrative comes from |

Miss classes (handoff §7): `MISSED_FLAG`, `MISSED_DIAGONAL_SUPPORT`, `MISSED_DIAGONAL_RESISTANCE`, `MISSED_HORIZONTAL_ZONE`, `MISSED_CONFLUENCE`, `FALSE_BREAKOUT`, `WICK_VS_ACCEPTANCE_ERROR`, `MISSED_COMPRESSION`, `OVERWEIGHTED_ENGINE_SIGNAL`, `OVERCONFIDENT_WITHOUT_VISUAL`, `CHASED_EXTENSION`, `OTHER`.

## Status lifecycle

`proposed` (logged, no fix yet) → `implemented` (fix and regression test merged) → `validated` (the replay harness shows the fix holding on real history, not only on fixtures) → `superseded` (a later miss or feature replaced it; keep the file).

## Adding a miss

1. Copy an existing file, take the next id, fill every field.
2. While the fix is `proposed`, `regressionTest` may be empty.
3. When the fix lands, add its test titles and set `status: implemented`. `npm run test:replay` fails if a referenced title does not exist.

## Log

| Id | Class | Status | Regression |
| --- | --- | --- | --- |
| MISS_001 | MISSED_FLAG | implemented | `test-pattern-detector.js` REGRESSION_001 tests, `test-replay.js` REGRESSION_001 via replay |
| MISS_002 | OTHER (leverage/stop incompatibility; no class fits) | implemented | `test-risk-engine.js` MISS_002 fixture tests |
| MISS_003 | MISSED_FLAG | validated | `test-replay.js` MISS_003 via replay, `test-pattern-detector.js` F1 items 1/3/4/5/6/8 |

MISS_002 is the playbook's leverage miss. It is not the handoff's REGRESSION_002, which is the 4h diagonal + demand confluence (`test-geometry.js`, `test-replay.js`).

MISS_003 (F1, `docs/PLAN_FLAG_DETECTION_COVERAGE.md`) is the 2026-09-23 flag-visibility incident: failed candidates vanishing, a too-short impulse lookback missing a longer pump, a confirmed flag silently dropped past `maxBreakoutAge`, and detection lagging the live chart. Fixed by the proto/reclaim/failed-TTL/expired states and the wider impulse lookback; validated by replaying `test/fixtures/history/2026-09-23` and checking the exact incident timeline.
