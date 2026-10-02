# Owner decisions 2026-10-02 — trade lock

Source: owner interview (2026-10-02, two rounds) plus the four follow-up answers in the same day's
build thread. These are owner decisions, not proposals. Do not reopen them without the owner.

## The problem

The owner tracks a setup, it confirms, they ask "now?", and the system names a new retest or a better
entry. Then price runs and the setup is called extended. Owner: "the entries as is seem to be pretty
accurate, it's how the trade is managed at time of entry that's killing the UX."

Where it comes from in code (verified 2026-10-02):

| Cause | Where |
| --- | --- |
| Levels rebuilt from scratch every build. The detector re-picks the newest window, so the trigger, void level and candidateId can jump | `lib/patternDetector.js:186-299`, `lib/flagTradePlan.js:507` |
| `ready` needs a retest even after confirmation | `lib/flagTradePlan.js:253-284`, `:423-430` |
| Chase is re-measured against the current close every tick (1.5 ATR), plus a 5-candle expiry, which gives "wait for a retest" | `lib/patternDetector.js:245-256`, `lib/flagTradePlan.js:576-597` |
| Track follows the live candidate: trigger and void are overwritten each tick, a re-picked flag shows GONE, and GET IN NOW fires only on a ready retest | `lib/telegram.js` `diffTracked` |
| GPT told to re-judge from the newest candle; no rule to honor a plan that already triggered | `docs/GPT_INSTRUCTIONS.md` lines 11, 29, 35 |
| No MISSED state anywhere | — |

## Trading rules (from the owner's GPT session, adopted)

1. **No moving confirmation.** Once trigger, confirmation, entry method and invalidation are defined, they are frozen for that setup.
2. **Confirmation cannot become a new waiting condition.** If the required close happens, it is TAKE or PASS. No new retest.
3. **"Don't chase" is quantified beforehand.** The max extension is fixed when the setup is locked.
4. **Lower-TF confirmation is one-shot.** It delays entry once and never becomes a resetting gate.
5. **A missed entry does not move the entry.** If the valid entry passes unexecuted, it is MISSED.
6. **Live calls reference the frozen plan.** "now?" is answered against the locked conditions, not redesigned from the newest candle.

## Decisions

| # | Topic | Decision |
| --- | --- | --- |
| D1 | Where to lock | 🔒 Lock button on the Telegram card **and** a GPT command, sharing one engine-side lock. |
| D2 | What can end or change a lock | Invalidation close → INVALIDATED. Close past the extension cap before a fill → MISSED. Time expiry → EXPIRED. A major TA shift **warns** ("thesis broken") and never moves levels. Owner unlock. |
| D3 | Confluence | Gate at confirmation, then re-score while locked and warn if it decays. Levels stay frozen. Show the recommendation **and** the checklists. |
| D4 | "now?" after lock | Lock state + confluence delta since the lock. |
| D5 | Lockable entries | All: flag breakout/retest, HTF entry, RETEST 1H, a level the owner names. Trade up to the daily (daily swings, intraday, scalps). Other-TF support/resistance does not override the lock unless it is a significant level (which would block the recommendation). Allow a little more looseness than today. |
| D6 | TF stack | Show every timeframe (1m–1D) as a checkmark row. |
| D7 | MA model | EMA21 + EMA200. The core model: the two are close together and price flags out above the 21, above the 200 (mirror for shorts), with Stoch RSI and volume supporting, on any timeframe. Each timeframe is read as pushing price toward or away from those MAs. |
| D8 | Recommendation line | TAKE / WAIT / PASS. |
| D9 | MISSED cap | 1.5 ATR of the trigger timeframe past the trigger level, **fixed at lock time** (never re-measured). |
| D10 | Expiry | 6 candles of the trigger timeframe after the lock, while unfilled. |
| D11 | Major TA shift | A close on the wrong side of EMA200 on one of the 1–2 timeframes above the trigger timeframe, when it was on the right side at lock. Warning only. |
| D12 | Entry timeframes | Use the fetched 1m/3m/5m/15m. No 10m fetch. |

## Build order

Built on branch `trade-lock` (worktree `../snapshot_tradingview-trade-lock`). Not deployed.

| Phase | Scope | Status |
| --- | --- | --- |
| L0 | This doc | done |
| L1 | `lib/tradeLock.js`: pure lock model (freeze, evaluate on closed candles, MISSED / INVALIDATED / EXPIRED, thesis warning, per-TF confluence checklist, TAKE / WAIT / PASS, delta since lock) + tests | see CHANGELOG |
| L2 | Telegram: 🔒 Lock / Unlock buttons, `/locks`, a locked Took it, cron alerts on lock transitions; a locked candidate's generic and Track alerts are suppressed | see CHANGELOG |
| L3 | REST payload `locks` (bearer only, never MCP) + GPT LOCK rule | see CHANGELOG |
| L4 | Top-down entry-TF selector: EMA21/200 flag model on every TF, pick the safest entry TF, SL/TP from that TF's structure | planned, not built |

## Deliberate limits

- Lock constants live in `lib/tradeLock.js`, not `config/engine.json`. A lock manages a trade the owner chose; it does not change a signal, so `configVersion` (and the tracker's epoch boundaries) stays put.
- GPT can **read** locks (REST only). Writing a lock from the GPT is deferred: the REST Action is a bearer GET on the same function MCP rewrites to, and adding a write there or a new function (Hobby cap) needs its own owner decision.
- The engine's own signals, plans, chase and retest rules are unchanged. The lock sits on top of them.
