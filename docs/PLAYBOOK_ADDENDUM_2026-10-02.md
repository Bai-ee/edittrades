# Playbook addendum — 2026-10-02 (appended to the GPT knowledge file)

Section 13 of `EditTrades_Living_Scalp_Playbook_v2.docx`, after `docs/PLAYBOOK_ADDENDUM_2026-09-28.md` sections 10–12. Same rebuild as that file: `textutil -convert html` the current docx, append this file's HTML, `textutil -convert docx`.

## 13. Trade locks and fields moved out of the Instructions box (2026-10-02)

**Why locks exist.** The owner tracks a setup, it confirms, and the old flow then asked for a new retest or a better entry while price ran. Owner decisions: `docs/OWNER_DECISIONS_2026-10-02_TRADE_LOCK.md`. Six rules, all in force:

1. No moving confirmation. Once trigger, confirmation, entry and invalidation are set, they are frozen for that setup.
2. Confirmation is never a new waiting condition. The required close happened: TAKE or PASS (WAIT only while confluence is partial and price is still inside the cap).
3. "Don't chase" is a number fixed at lock time: the cap (`lv.cap`).
4. Lower-TF confirmation is one-shot. A pullback to the trigger after confirmation is the entry, not a reset.
5. A missed entry does not move the entry. Past the cap unfilled = MISSED.
6. "now?" is answered from the lock, not redesigned from the newest candle.

**`locks[]` fields** (REST `getScalpContext` only, when the owner has locks; empty or absent otherwise):

| Field | Meaning |
| --- | --- |
| `ref` | 8-hex id (the Telegram button ref) |
| `sym`, `tf`, `dir` | symbol, trigger timeframe, long/short |
| `src` | `flag` · `htf` · `retest1h` · `manual` |
| `st` | `armed` (waiting for a trigger-TF close past `trg`) · `confirmed` (that close happened) · `filled` (owner is in) · `missed` · `invalidated` · `expired` · `stopped` · `tp1` · `unlocked` · `ended` |
| `verdict` | `TAKE` · `WAIT` · `PASS` (open, unfilled) · `IN TRADE` (filled) · `DONE` (closed) |
| `why` | one plain sentence for the verdict, quote it |
| `lv.trg` / `lv.inv` | trigger / void (a trigger-TF close past `inv` before a fill = invalidated) |
| `lv.ent` / `lv.sl` / `lv.tp1` | entry / stop / TP1, frozen |
| `lv.cap` | no-chase cap: trigger ± 1.5 × ATR of the trigger timeframe, measured once at lock |
| `at` / `exp` | lock time / expiry (6 trigger-TF candles, unfilled) |
| `conf_at`, `fill` | confirmation time, fill price |
| `conf.score`, `conf.gate` | ✅ count over 1m–1D, and whether the gate passes (trigger-TF EMA21/200 + price side with the trade, plus 2 of: next TF up MAs, trigger Stoch, trigger volume, the 21/200 model) |
| `conf.tfs` | the checklist, e.g. `1m✅ 3m✅ 5m⚠️ 15m✅ 1h❌ 4h✅ 1d✅` |
| `conf.delta` | changes since the lock, e.g. `1h ✅→❌` |
| `thesis` | timeframes above the trigger TF that closed on the wrong side of EMA200 since the lock: a warning, never new levels |

**How to answer "now?" on a locked setup:** `verdict` + `why`, then the frozen levels, then `conf.tfs` and `conf.delta`, then any `thesis` warning. Never name a different entry, a new retest, or a re-measured "extended" call. MISSED is final: say so, do not suggest chasing.

**Locking** happens in Telegram (🔒 Lock on a signal card, or `/lock BTC long 5m entry X stop Y tp Z`). The GPT reads locks; it cannot create one.

**Moved out of the box 2026-10-02 (field dictionaries, rules unchanged):**
- `config` = stop cap, R:R minimums, risk caps. `account.margin.usd` = capital; `account.holdingsUsd` = exposure; `account.performance` = the P&L meter.
- `decisionTrace.bias` is present on every response; `ct` = counter-trend count. Trace tokens `+td:<sentiment>:<n>/4` (top-down vote) and `+a200:<count>/<of>` (EMA200 side count) are context: they never veto, and MAs are never targets.

**Frozen plans in the GPT's own track flow (no engine lock needed).** `track` replies now carry a `CAP:` line, the no-chase price, set before the move. From then on the TRACK lines are frozen: `now?` answers only FIRED (GO IN at those levels) / NOT YET / MISSED (past CAP, unfilled) / NULL (thesis null or window over). Never a new retest zone, a better entry, or a re-measured "extended" call. A lock in `locks[]` for the same setup wins over the chat's TRACK lines.

**Moved out of the box 2026-10-02, second pass (lists, rules unchanged):**
- PRIORITY order when space is short: GO/HOLD/DON'T > direction > thesis > entry > confirmation > elimination > stop > TP1/time > TP2/time > time stop > leverage > size > wallet risk > $ loss > PnL > exposure > win/loss.
- `track` sources: 1m–5m timing, 15m–4h structure, EMAs, Stoch, zones/diagonals/confluence, `candidateSetups`, extension, the engine.
- Trend fields: `structure.aboveEma21` / `structure.aboveEma200`.
- `biasMatrix` / `alignment` / `decisionInputs` exist only on the MCP tool (with `include=bias`); the compact REST call never has them.
