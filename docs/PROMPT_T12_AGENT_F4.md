# Master prompt — Agent F4 (Sonnet): score GOOD calls from the per-minute alert log (T-12)

Work in a worktree: `cd /Users/bballi/Documents/Repos/snapshot_tradingview && git worktree add ../snapshot_tradingview-tracker-1min -b tracker-1min && cd ../snapshot_tradingview-tracker-1min && ln -s ../snapshot_tradingview/node_modules node_modules`. Read `CLAUDE.md`, `docs/AGENT_SESSION_RULES.md`, `docs/GAP_CHECK_2026-09-26.md` (the finding: the tracker's 10-minute capture misses ~70 % of GOOD calls because a GOOD window lasts 2–5 min; the Telegram cron logs every GOOD / GOOD_ENDED at 1-minute resolution), `scripts/tracker/collect.js`, `scripts/tracker/alerts.js`, `scripts/tracker/aggregate.js`, `scripts/tracker/build-page.js`, `scripts/tracker/walk-outcome.js`, `lib/telegramLog.js` (`alertLogLine` fields), `test-tracker.js`. The tracker repo is `/Users/bballi/Documents/Repos/edittrades-tracker` (scripts are synced from this repo with `npm run tracker:sync`; read `origin/main:data/…` for real data; do not commit there).

Goal: the tracker's GOOD-call record and scoreboard count every GOOD the engine actually emitted, using the Telegram cron's per-minute GOOD / GOOD_ENDED log (`data/alerts.jsonl`, already ingested) as the primary source of GOOD calls, with the 10-minute captures kept for everything else (levels, WATCH/BAD counterfactuals, wallet).

## Deliverables
T12-1 `collect.js`: build GOOD call records from alert-log lines of kind GOOD (first line per `symbol + candidateId` = the call; its entry/stop/tp1 from the line's plan fields; `calledAt` = the alert's sent time; `source: 'alert-1m'`). Merge with capture-derived GOOD calls by `symbol + candidateId`: keep the earlier `calledAt`, keep capture levels only when the alert line has none, record `sources: ['alert-1m','capture']`. No duplicates.
T12-2 Scoring: `walk-outcome` from `calledAt` on the alert-sourced calls exactly as for captured ones (fill window, TP1/stop, gross and net R with the direction costs). The 30-plan target and expectancy now count alert-sourced GOOD calls; the report says so.
T12-3 Page + report: the GOOD row shows `calls (1-min log)` and `of which captured`; a one-line note under the scoreboard: "GOOD calls come from the engine's 1-minute alert log since <first ingest date>; before that from 10-minute captures." Backfill: re-score every GOOD line already in `data/alerts.jsonl` (since 2026-09-24) so the record is continuous.
T12-4 GOOD_ENDED lines: use them to record `endedAt` and the GOOD window length on each call (minutes), shown as a column and a median in the report.
T12-5 Tests in `test-tracker.js`: merge/dedup, alert-sourced scoring, backfill idempotent, capture-only fallback when the alert log is missing, window length. All 14 suites + `test:tracker` green; `git diff --check`.
T12-6 Docs: `docs/PLAN_CALL_TRACKER.md` section, CHANGELOG line, tracker `how-to` sentence. Commit on `tracker-1min` by file name; do not push; do not run `tracker:sync` or touch the tracker repo (the orchestrator syncs and deploys).

## Hard rules
No engine, alert, or rule changes. The tracker stays read-only toward the engine and wallet. Never stage files you did not change.
