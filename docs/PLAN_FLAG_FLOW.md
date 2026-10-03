# Flag flow — the four-step Telegram UX (owner-approved 2026-10-02)

Owner: "I just want an easy to follow setup." The product is a flag finder on every timeframe
(1m, 3m, 5m, 15m, 1h, 4h) using EMA21/EMA200, volume and Stoch RSI. Today the bot sends many
message kinds (WATCH, TRIGGERING, BREAKOUT, SETUP, GOOD, TRACK, HTF, RETEST, …), each a different
angle. The flag flow replaces that, by default, with four steps and one message kind each:

1. **🔍 FOUND** — a flag that passes the confluence gate, any timeframe 1m–4h, before its trigger.
2. **🎯 READY** — that flag confirmed (trigger-TF close past the breakout level), still inside the
   no-chase cap. Levels: entry = breakout level, stop = invalidation, target = measured move (pure).
   One 🔒 Lock button.
3. **🔒 LOCKED / IN** — the existing trade lock (`lib/tradeLock.js`, `lib/telegramLock.js`).
4. **✅ / ❌ DONE** — the existing lock terminal states (TP1 hit / stopped / missed / …).

`/signals` becomes a board: the top 3 flags right now + one 24h line. Classic alerts stay
available behind a mode switch.

Levels are structural (owner decision 2026-10-02): stop = flag invalidation (no 3% cap here),
target = pure measured move (`measuredTarget`). R:R is information. The engine's own
`flagTradePlan` is unchanged and still drives classic mode, the GPT and the tracker.

The 3% guard on the scalp *strategies* (`SCALP_1H`, `MICRO_SCALP`, CLAUDE.md hard rule) is
untouched — it is a different code path.

## Interfaces (fixed — agents build against these)

### B. Engine: `flagBoard` (services/scalpContext.js)

`buildScalpContext(options)` gains `options.includeFlagBoard === true`. When set, the payload gets a
top-level key:

```js
flagBoard: {
  BTC: [ { id, tf, dir, st, brk, inv, tgt, rr, conf, at, chase } , ... ],
  ETH: [...], SOL: [...]
}
```

- Source: that symbol's `modelCandidateSetups` (already built for every `ENGINE_CONFIG.model.flagTimeframes`
  = 1m/3m/5m/15m/1h/4h, already snapped and carrying `measuredTarget`/`measuredRR`).
- Only `type === 'flag'` with state in `proto | forming | triggering | confirmed` (drop `failed`, `expired`, coils).
- Fields: `id` = candidateId, `tf` = timeframe, `dir` = direction, `st` = state, `brk` = breakoutLevel,
  `inv` = invalidation, `tgt` = measuredTarget (null if absent), `rr` = measuredRR (null if absent),
  `conf` = confidence, `at` = firstDetectedAt, `chase` = chaseRisk (boolean).
- Numbers rounded to 2 decimals (`round2`). Candidates with a null `id` are skipped.
- **Absent unless the option is set.** REST and MCP never set it, so their payloads are byte-identical
  to today. `filterPayload` must keep the key when present (top level, like `account`).
- A failure building it is logged, never warned, never changes `dataStatus`.

### A. Pure module `lib/flagFlow.js` (+ `test-flag-flow.js`, `npm run test:flow`)

Imports allowed: `./tradeLock.js` (confluenceChecklist, closedCandles, simpleAtr, LOCK_TF_MS,
LOCK_TIMEFRAMES) and the exported helpers of `./telegram.js` (escapeHtml, msgHeader, codeBlock,
joinSections, fmtLvl, shortRef). No I/O.

```js
export const FLOW_DEFAULTS = { capAtr: 1.5, boardSize: 3, foundCooldownMs: 15*60_000 };
export const FLOW_STATE_RANK = { confirmed: 4, triggering: 3, forming: 2, proto: 1 };

// One board entry for a flagBoard candidate, scored against that symbol's payload timeframes.
// timeframes = payload.symbols[sym].timeframes (FULL build: candles present).
export function scoreFlag(symbol, c, timeframes, price, opts)
  -> { symbol, id, ref /* shortRef(id) */, tf, dir, st,
       levels: { entry: c.brk, stop: c.inv, target: c.tgt, rr: c.rr, cap },
       // cap = brk + dir * capAtr * ATR(tf candles) ; null when ATR unmeasurable
       check,   // confluenceChecklist(timeframes, dir, tf) result
       gate, score, of,
       stage }  // 'found' | 'ready' | 'missed' | 'watch'
// stage rules:
//   missed : st === 'confirmed' and price is past cap (dir-aware)
//   ready  : st === 'confirmed' and not missed and gate
//   found  : st in triggering|forming|proto and gate
//   watch  : anything else (gate not met) — shown on the board only if nothing better

export function rankFlags(flagBoard, symbols, opts) -> Array<entry>
// all symbols' entries, sorted: stage (ready > found > watch; missed dropped), then score/of desc,
// then FLOW_STATE_RANK desc, then higher timeframe first, then rr desc.

export function snapshotOf(entry) -> object   // for state.buttons[ref] so Lock resolves it:
// { symbol, candidateId: id, timeframe: tf, direction: dir, state: st,
//   entry: brk, stop: inv, tp1: tgt, breakoutLevel: brk, invalidation: inv,
//   measuredTarget: tgt, measuredRR: rr, recClass: 'FLOW', planStatus: stage }

export function formatFoundCard(entry, nowMs) -> html string
export function formatReadyCard(entry, nowMs) -> html string
export function formatBoard(ranked, pulse, nowMs) -> html string
export function flowKeyboard(entry) -> { inline_keyboard } // [🔒 Lock (lock:<ref>), Chart (chart:SYM:TF)]

// 24h pulse from state.flow (see C). Pure.
export function pulseOf(flowState, nowMs) -> { found, ready, locked, since }
export function pulseLine(pulse) -> "24h: 12 flags found · 4 ready · 1 locked"
```

Card copy (short, ≤ 600 chars each, mobile-first):

- FOUND: header `🔍 FOUND` via msgHeader(dot,'BTC','1h','long','🔍 FOUND'); line
  `<b>Watch</b> — 1h flag, checklist 6/7. Trigger on a 1h close above 86,400.`; code block
  trigger / stop / target / R:R; checklist line `1m✅ 3m✅ …` (use tradeLock.checklistLine on the check).
- READY: header `🎯 READY`; line `<b>Trigger hit</b> — entry 86,400 · stop 85,900 · target 87,600 (2.4R).`;
  code block entry / stop / target / R:R / no-chase cap; checklist line; `Tap 🔒 Lock to freeze these levels.`
- Board: title `🧭 FLAGS NOW`, then `pulseLine`, then up to `boardSize` entries, one compact block each
  (`🎯 READY` / `🔍 FOUND` / `· watching` tag, symbol tf dir, levels one line, checklist score). Empty:
  `No flags passing the checklist right now.` plus the pulse line.

### C. Integration (lib/telegram.js, api/telegram-cron.js, api/telegram-webhook.js, lib/telegramLock.js)

- **Mode pref**: `state.prefs.mode` = `'flow'` (default for new and migrated states) | `'classic'`.
  `/mode flow` · `/mode classic` (+ `/help` lines). Classic = today's behaviour exactly.
- **Cron in flow mode** (build with `includeFlagBoard: true`; classic mode can ignore the field):
  - `diffFlow(state, payload, nowMs)` (new, in a new file `lib/telegramFlow.js`) returns alerts
    `{kind:'FOUND'|'READY', symbol, candidateId, ref, text, replyMarkup}`:
    FOUND once per candidateId (and at most one FOUND per symbol+tf per `foundCooldownMs`);
    READY once per candidateId. Keeps `state.flow = { found:{id:atIso}, ready:{id:atIso}, lastFoundAt:{'SYM|tf':atIso} }`
    pruned to 24h. Stores `snapshotOf(entry)` in `state.buttons[ref]` for every sent FOUND/READY so
    🔒 Lock resolves 15m/1h/4h flags (resolveRef already falls back to state.buttons).
  - In flow mode, drop these kinds from the classic diff: WATCH, TRIGGERING, BREAKOUT, SETUP, GOOD,
    GOOD_ENDED, TRACK, NUDGE, and the always-on HTF_* / RETEST_1H* / SLOW_TREND alerts. Keep LOCK and
    health kinds (MARK, DATA, DATA_OK, FOCUS) and execution/trail alerts. Classic state bookkeeping
    still runs (so switching back is seamless) — only the sends are dropped.
  - A locked candidate (open lock) gets no FOUND/READY.
  - `state.flow.locked` counts locks created in 24h for the pulse (or derive from state.locks lockedAt).
- **/signals in flow mode** → `formatBoard(rankFlags(...), pulseOf(state.flow), now)` with one
  `flowKeyboard` row per board entry (stack rows). `/signals all` → classic. Classic mode unchanged.
- **Lock vocabulary** (lib/telegramLock.js titles only): `LOCK · CONFIRMED` stays (it is the
  READY-under-lock moment), filled → `🔒 IN`, `LOCK · TP1 HIT` → `✅ DONE · TARGET HIT`,
  `LOCK · STOP HIT` → `❌ DONE · STOPPED`, `LOCK · MISSED` → `❌ DONE · MISSED`, invalidated/expired →
  `❌ DONE · INVALIDATED` / `⚪ DONE · EXPIRED`. Update the tests that assert the old titles.
- Lock created from a FOUND/READY snapshot uses its structural levels (entry=brk, stop=inv, tp1=tgt)
  through the existing createLock path (snapshot fields already match `lockLevels`).
- Tests: flow mode default; FOUND then READY once each; cooldown; locked candidate silent; classic
  kinds suppressed in flow; `/mode` toggle persists; `/signals` board in flow and classic list in
  classic; Lock from a 1h READY resolves via state.buttons. Keep the existing classic tests passing
  by seeding `prefs.mode='classic'` in the test harness where they assume classic.

## Not in this phase

Scorecard (win % target-before-stop, ghost R:R), rolling DONE counts for unlocked flags, GPT
changes, public site. The pulse line counts found / ready / locked only.
