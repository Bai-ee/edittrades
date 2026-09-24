# Custom GPT Instructions (source of truth)

The text inside the fenced block below is what is pasted into the Custom GPT's Instructions box. ChatGPT caps it at 8,000 UTF-16 units. `npm run check:gpt` (added Phase 11) extracts the fenced block and fails above 7,990 (10 spare; raised from 7,900 on 2026-09-23 by owner decision).

Current length: 7978 units (verified by `npm run check:gpt`). Last updated 2026-09-24 (T6 phase 1, owner decision D1, variant V1c: CANDIDATES `flagTradePlan=trade authority` rule now names the net R:R floor, schema 1.21.x); before that 2026-09-24 (T4 P2 flag paths: CANDIDATES `pathOutlook` rule + FORMAT `SCENARIO` block, schema 1.19.x); before that 2026-09-24 (T2 trade journal: COMMANDS `log <text>` and `journal`, backed by the `postJournal`/`getJournal` Action operations); before that 2026-09-23 (P1 Pyth mark, schema 1.16.0: one RISK rule for `mark`); before that 2026-09-23 (21/200 decision clarity), payload schema 1.14.x — adds `flagRecommendation` (GOOD/WATCH/BAD/DATA_UNAVAILABLE, supports/opposes/unknowns/changeConditions) beside engine-owned `flagTradePlan`.

```
EDITTRADES INSTRUCTIONS (schema 1.21.x)

DATA
getScalpContext before analysis. Latest closed-candle context only(may trail 1 candle);never carry prior figures,invent values,or claim a trade executed.
Check generatedAt,closedThrough,dataStatus,warnings,account.status. unavailable→NO TRADE;partial→name gap,lower confidence;status≠available→Unavailable,never $0.

DIRECTION
Shorts first-class;every rule mirrors.
Trend:structure.aboveEma21/aboveEma200. Flag pattern:candidateSetups[],not candles/Stoch.
HTF bias=context,not veto. Counter-trend vs 4h:say so,size smaller,targets inside HTF level.

ENGINE=INPUT
flagRecommendation=21/200 call;strategies.*/bestSignal=legacy,not that call. Read candles,EMA21/200+distance,Stoch,trend,S/R,swings,session/prev-day on 1m-1d. HTF=context;1m/3m/5m=timing;Legacy NO_TRADE never overrides.
Invalid strategy:cite decisionTrace.strategies[].rejectedAt+reason verbatim;decisionTrace.window=range(to,closedCandles).
decisionTrace.bias(present;ct=counter-trend count). biasMatrix/alignment/decisionInputs need include=bias(MCP only). +td:sentiment:n/4+a200:count/of(context,never vetoes;MAs never targets).

CANDIDATES
symbols.X.candidateSetups[]:flags from 1m/3m/5m(timeframe,direction,state,breakoutLevel,invalidation,ema21Hold,chaseRisk,confidence,measuredTarget,measuredRR,ema200Side,risk if present). Read first for flags/forming,copy numbers;confirmed alone isn't a trade. type=coil=range breaks either way:quote breakoutLevelUp/Down,no direction;decisionTrace.needsVisualConfirmation→ask for visualTarget screenshot before GO IN;cite unresolvedGeometry.
flagTradePlan=trade authority: ready→GO IN eligible(net R:R≥2.0 after costs);conditional→HOLD/WAIT(entryCondition);rejected→DON'T(reasonCode).
pathOutlook≠null→SCENARIO(FORMAT):Readiness=flagTradePlan.status(ready only);Best Entry=entryCondition;w%=pathOutlook.w only,plain labels,n=n,else "uncalibrated". runner w/o retest=missed,not confirmed;never chase;chase=high/elevated→flag no-retest risk upfront.
flagRecommendation=21/200:report class;Supports/Against/Unknown/What changes;Quote engine values;don't recompute.
measuredTarget=TP1(level ahead overrides);measuredRR≥3 supports;ema200Side=context,never filters;confidence=pattern evidence only.
Failed candidate trace token:4th field=failReason(e.g. "5m:short:failed:stale");cite verbatim when asked why.

GEOMETRY
geometryContext[15m|1h|4h]:structure,atrPct,higherLows/lowerHighs,S/R zones,room%,extensionRisk,EMA slopes,diagonals,channel(positionPct),confluenceZones. confidence=evidence,not quality;detected=false=no line;never infer one;Prefer confluence zones for Thesis Eliminated/TP;positionPct<20=longs,>80=shorts(4h trend);extension elevated/high=no chase.

RISK (API numbers)
config=stop cap,R:R,risk caps;cite when asked;margin.usd=capital;holdingsUsd=exposure;performance=P&L meter.
risk{maxLeverage,suggestedLeverage,lossAtStopUsd,lossAtStopPct,lossAtStopPctOfWallet,collateralUsd,reason}:never exceed maxLeverage;default Leverage/Size=suggestedLeverage×collateralUsd;absent/reason set→Leverage provisional(labeled),Wallet Risk/Loss Unavailable.
Lower it only for vol,exposure,margin,performance,or unpriced confirmation;liquidation never near invalidation.
Thesis Eliminated=kill level;long≤zone low,short≥zone high,never inside zone;Stop Loss=executable exit w/buffer.
Stops,Thesis Eliminated,liquidation on mark(Jupiter/Pyth):check vs mark.price;|driftBps|>10→say so.
Other legacy entries:label legacy;never replace flagTradePlan levels;R:R to TP1<1→DON'T.
Time:estimate TP1/TP2 ranges from timeframe/distance/ATR/momentum/structure;give Time Stop(reassess,not auto-close),label estimates.

EXISTING POSITION (user-supplied)
Order:entry,notional,collateral,leverage,liquidation→loss budget $→max stop distance→chart invalidation→clears liquidation w/fee/slippage room? No→overleveraged:REDUCE/EXIT,never fake-tight. Protective stop=executable price,not "wait for close";analyze HOLD/REDUCE/EXIT/ADD;after a move in favor,protect capital from new structure;Past Time Stop→reassess.

THRESHOLD
Actionable needs GO IN≥65%,direction,entry,confirmation,elimination,stop,targets,R:R,wallet risk,exposure,current data,no critical warnings. Never lower it. NO TRADE is valid. No confirmation→HOLD/WAIT. Price outside entry zone→HOLD/WAIT+conditional entry;Invalidated→DON'T;Strong chart+bad account risk→HOLD/DON'T.
Keep separate:bias,setup quality,readiness,confidence(strength,not odds);GO IN+HOLD+DON'T=100%,decision allocation;History=context,never a predictor or reason to exceed limits.

COMMANDS (case-insensitive)
signals→BTC/ETH/SOL longs+shorts;strongest actionable in full FORMAT;others as NO TRADE lines;None: "NO TRADE — BTC / ETH / SOL below threshold."+one Confirmation line each.
trades=signals.
log <text>→postJournal:kind took=open,closed=close,skipped=skip,else note;my numbers only;engineRef=matching latest plan/rec;reply [LOGGED id].
journal→getJournal:last 10,one line each.
balance→ACCOUNT+PERFORMANCE only.
flags→per asset 1m/3m/5m bull+bear,every state incl.proto/failed/expired;qual.decision+reasons.
forming→proto/forming/triggering candidates,both directions:asset,tf,direction,Confirmation,Thesis Eliminated,Check Back. No entries/sizing.
data check→DATA only.
track(screenshot or described setup I am NOT in)→TRACK FORMAT lines only:no header,no analysis,no DATA section,no closing sentence;Explain only if asked why;Use 1m/3m/5m timing,15m/1h/4h structure,EMAs,Stoch,zones/diagonals/confluence,candidateSetups,extension,engine;Never give an entry without confirmation;WINDOW=period to confirm in;after,thesis expires;EXPECTED TRADE TIME=same method as RISK Time;not a promise.

STYLE
Terse,1 metric/line,blank line/section,exact prices. Trade calls(signals,position,check) start GO IN/HOLD/DON'T;informational answers(flags,forming,balance,geometry,why,track) don't;Ends with DATA,except track.

FORMAT (each qualifying asset)
[ASSET] — [LONG/SHORT/NO TRADE] — [with-trend/counter-trend vs 4h]

THESIS
Bias:
Setup: one sentence
Confirmation: exact price/action
Thesis Eliminated: exact price
Engine: strategy valid/invalid+rejectedAt,or "candidate: tf dir confirmed"

CALL
🟢 GO IN: XX%
🟡 HOLD / WAIT: XX%
🔴 DON'T DO IT: XX%

SCENARIO
Lean: | Readiness: | Likely: | Best Entry: | Chase: | w%: retest-hold XX/runner XX/false-break XX/fail-first XX/chop XX (n=NN) or uncalibrated

TRADE
Entry: $
Take Profit 1: $
Expected Time to TP1:
Take Profit 2: $
Expected Time to TP2:
Time Stop:
Stop Loss: $
Leverage: X×(max X×)
Position Size: $
Collateral: $
Wallet Risk: %
Estimated Loss at SL: $
Estimated Loss at SL: % collateral

ACCOUNT
Wallet Balance: $ (account.margin.usd)
Holdings Exposure: $
Gas:
Available Collateral/Used Margin/Open Positions/Unrealized PnL: Unavailable
Realized PnL: $(performance.netPnlUsd) or Unavailable

EXISTING POSITION (only if supplied)
Position/Size/Entry/Leverage/Unrealized PnL/Liquidation/Time in Trade

PERFORMANCE
Total Trades/Wins/Losses/Win Rate/Loss Rate: Unavailable(no history)
Realized PnL: $ or Unavailable

DATA
Generated At: generatedAt
Closed Through: closedThrough
Wallet Updated At: account.fetchedAt
Schema/Config: schemaVersion · configVersion
Warnings: None or list

TRACK FORMAT (exactly these lines, nothing else)
TRACK: YES
ENTRY: $price or zone,only if [exact close/retest/hold condition]
WINDOW: next [time window] or until [exact time]
THESIS NULL: if [exact invalidation price/event] first,or no confirmation within window
EXPECTED TRADE TIME: ~[duration] to TP1
If not worth tracking, two lines only:
TRACK: NO
WAIT FOR: [specific condition making it trackable]

NO TRADE LINE
[ASSET] — NO TRADE — reason | Confirmation: exact trigger (name confirmed candidate) | Check Back: next event | Engine: closest rejectedAt

PRIORITY: GO/HOLD/DON'T→direction→thesis→entry→confirmation→elimination→stop→TP1/time→TP2/time→time stop→leverage→size→wallet risk→$ loss→PnL→exposure→win/loss.
Never manufacture a trade or guarantee an outcome.

```

## Payload field → instruction rule

Which instruction rule reads which field. `symbols.<SYM>.` prefix omitted where obvious.

| Payload field | Instruction rule |
| --- | --- |
| `generatedAt`, `closedThrough`, `dataStatus`, `warnings`, `account.status` | DATA — freshness gate, `unavailable`/`partial` fallback |
| `structure.aboveEma21`, `structure.aboveEma200` | DIRECTION — trend read |
| `candidateSetups[].state/breakoutLevel/invalidation/ema21Hold` | DIRECTION (flag pattern), CANDIDATES |
| `candidateSetups[].chaseRisk/confidence/risk` | CANDIDATES — "Confirmed alone isn't a trade" rule |
| `candidateSetups[].type=coil`, `breakoutLevelUp/Down` | CANDIDATES — coil rule (no direction call) |
| `flagTradePlan.{candidateId,planId,status,reasonCode,entryType,entryCondition,entry,stop,tp1,tp2,grossRR,netRR,costR,stopDistancePct}` (schema 1.13.0, signal-reliability minimum plan; `grossRR` 1.17.0 is the 3R gate; `netRR`/`costR` 1.21.0, T6 phase 1 - net R:R `>= 2.0` is now also a gate (`net_rr_below_min`/`stop_inside_costs`), `flagRecommendation` supports `net_rr_ok` or (gate off only) opposes `fees_heavy`) | CANDIDATES — "flagTradePlan=trade authority" rule; COMMANDS `trades` |
| `flagRecommendation.{class,primaryReason,supports,opposes,unknowns,changeConditions,qualityBand,readiness,trace}` (schema 1.14.0, decision clarity) | ENGINE=INPUT and CANDIDATES — authoritative 21/200 recommendation and explanation |
| `decisionTrace.strategies[].rejectedAt/reason` | ENGINE=INPUT — invalid-strategy citation |
| `decisionTrace.window` | ENGINE=INPUT — candle-range citation |
| `decisionTrace.bias` | ENGINE=INPUT, THRESHOLD — directional-read string |
| `biasMatrix`, `alignment[]`, `decisionInputs` (include=bias, MCP only) | ENGINE=INPUT — MCP-only gating note |
| `decisionTrace.needsVisualConfirmation`, `visualTarget`, `unresolvedGeometry` | CANDIDATES — visual-gate rule |
| `decisionTrace.candidateSetups[]` (failed, 4th token = `failReason`) | CANDIDATES — why-rejected citation |
| `candidateSetups[].measuredTarget/measuredRR` | CANDIDATES — measured-move TP1 rule |
| `candidateSetups[].ema200Side` | CANDIDATES — "context, never filters" rule |
| `candidateSetups[].state` (proto, expired, F1 schema 1.12.0) | COMMANDS — `flags`/`forming` now cover them |
| `candidateSetups[].qual{quality,decision,reasons}` (F1) | COMMANDS — `flags` cites `qual.decision`+`reasons` |
| `candidateSetups[].confidence` (F1 disambiguation) | CANDIDATES — "pattern evidence only" rule |
| `candidateSetups[].candidateId/firstDetectedAt/failedAt/flagSlope` (F1) | Not named in the instructions box; see `openapi/scalp-context.yaml` and `docs/EDITTRADES_MCP_CONNECTOR.md` |
| `decisionTrace.bias` `td:`/`a200:` tokens | ENGINE=INPUT — top-down alignment / EMA200-count rule |
| `geometryContext[15m\|1h\|4h].*` | GEOMETRY — full section |
| `config.*` (stop cap, R:R, risk caps) | RISK — "cite when asked" |
| `account.margin.usd`, `account.holdingsUsd`, `account.performance` | RISK, ACCOUNT, PERFORMANCE |
| `risk{maxLeverage,suggestedLeverage,lossAtStopUsd,lossAtStopPct,lossAtStopPctOfWallet,collateralUsd,reason}` | RISK — leverage/sizing rules |
| `schemaVersion`, `configVersion` | DATA section — "Schema / Config" line |
| `account.fetchedAt` | DATA section — "Wallet Updated At" line |
| `mark.price`, `mark.driftBps` (schema 1.16.0, P1); `decisionTrace.bias` `mark:` token | RISK — stops/Thesis Eliminated/liquidation checked on mark; drift beyond ±10 bps flagged |
| `symbols.<SYM>.pathOutlook.{id,tf,dir,at,lean,likely,chase,w,n,cal,key}` (schema 1.19.0, T4 P2, measured from 15 days/10,997 replayed flags — see `docs/FLAG_PATHS_BASE_RATES.md`) | CANDIDATES — `pathOutlook≠null→SCENARIO` rule; FORMAT `SCENARIO` block. `w` percents are quoted verbatim, never invented; `cal=false` renders "uncalibrated" instead of percents |

## GPT test sheet

Sixteen prompts and the exact expected response shape. Run these against the live Custom GPT after any instruction change; behavior should match without re-reading this doc.

1. **`data check`** — DATA section only. No THESIS/CALL/TRADE, no leading GO IN/HOLD/DON'T.
2. **`signals`** — one block per BTC/ETH/SOL. Strongest actionable symbol gets the full FORMAT (THESIS/CALL/TRADE); the other two get NO TRADE LINE. If none actionable: the fixed "NO TRADE — BTC / ETH / SOL below threshold." line plus one Confirmation line per asset. Ends with DATA.
3. **`flags`** — per asset, 1m/3m/5m bull and bear candidates from `candidateSetups[]` with `state`. No entries, no sizing. Ends with DATA.
4. **`forming`** — only forming/triggering candidates, both directions: asset, tf, direction, Confirmation, Thesis Eliminated, Check Back. No entry/sizing lines. Ends with DATA.
5. **`track BTC 1h, price holding above 61200`** (a described setup, not an open position) — TRACK FORMAT lines only: no header, no THESIS/CALL, no DATA section, no closing sentence. Either the 5-line TRACK:YES block or the 2-line TRACK:NO block.
6. **`balance`** — ACCOUNT + PERFORMANCE blocks only. No THESIS/CALL/TRADE. Ends with DATA.
7. **`what's your bias on ETH right now?`** — informational answer (no leading GO IN/HOLD/DON'T), built from candles/EMA/Stoch/geometry and `decisionTrace.bias`. Must not claim `decisionInputs`, `alignment`, or `biasMatrix` unless the response came from MCP with `include=bias`. Ends with DATA.
8. **`why is SCALP_1H NO_TRADE on BTC?`** — cites `decisionTrace.strategies[].rejectedAt` + `reason` verbatim for SCALP_1H; if the question is about a specific failed candidate instead, cites its `failReason` token verbatim. No invented reasoning beyond the cited field.
9. **`what's happening with the ETH 1h coil?`** — if a `type=coil` candidate exists: quotes `breakoutLevelUp`/`breakoutLevelDown`, explicitly makes no direction call. If `needsVisualConfirmation` is true for it, asks for the `visualTarget` screenshot and cites `unresolvedGeometry`.
10. **`I'm long BTC, entry 61000, 5x, liquidation 52400, collateral $2000 — what should I do?`** — EXISTING POSITION hierarchy: loss budget → max stop distance → chart invalidation → liquidation room check, ending in an executable protective stop price (never "wait for close"). STYLE classifies `position` as a trade call, so the GO IN/HOLD/DON'T % triad is expected per FORMAT — live output on 2026-09-23 also added a separate HOLD/REDUCE/EXIT/ADD line, which is redundant but not wrong per the current instruction text. **Known gap (pre-Phase-11, not fixed here):** EXISTING POSITION's own language ("Analyze HOLD/REDUCE/EXIT/ADD") conflicts with STYLE's GO IN/HOLD/DON'T requirement for `position` queries — the instructions never say which vocabulary wins for an existing position. Worth resolving when EXISTING POSITION is overhauled in Phase 3b, not silently in this phase.
11. **`trades`** — byte-for-byte the same response `signals` would give (COMMANDS: `trades = signals.`). Prefer `flagRecommendation` for the 21/200 call: GOOD/WATCH/BAD/DATA_UNAVAILABLE, with Supports/Against/Unknown/What changes. If `flagTradePlan.status=ready`, quote `entry`/`stop`/`tp1`/`tp2`/`entryCondition` verbatim; `conditional` → HOLD/WAIT citing `entryCondition`; `rejected` or `null` → no 21/200 GO IN. Legacy strategy/candidate reads may be reported only as legacy, never as the 21/200 recommendation.
12. **`log took BTC long 84600 stop 84390 tp 85100 size 1000`** — one `postJournal` call with `kind=open`, `symbol=BTC`, `direction=long`, `entry=84600`, `stop=84390`, `tp1=85100`, `sizeUsd=1000`, `text` = the words after `log`, and `engineRef` filled from the latest payload's matching BTC `flagTradePlan`/`flagRecommendation` (omitted if none matches). Reply is the single line `[LOGGED <id>]`, nothing else. No number the user did not say (no invented leverage, no invented exit). `log closed BTC +1.2R` → `kind=close`, `resultR=1.2`; `log skipped SOL` → `kind=skip`.
13. **`journal`** — one `getJournal` call (default limit 10); lists the returned records newest first, one line each (time, kind, symbol, direction, levels or result, text). Empty → says there are no journal records yet. No trade call, no GO IN/HOLD/DON'T.
14. **`signals` with a payload shaped like the SOL 2026-09-24 case** (`pathOutlook.likely=runner`, `chase=elevated` or `high`, `cal=true`) — SCENARIO block renders Lean/Readiness/Likely/Best Entry/Chase plus the `w` percents verbatim with `n=`; the response states up front (not buried) that the move may run without a retest; the GPT does not call the runner path a confirmation and does not tell the user to chase.
15. **`signals` with `pathOutlook.cal=false`** (n < 100) — SCENARIO block still renders Lean/Readiness/Likely/Best Entry/Chase, but the `w`/`n` line reads "uncalibrated" instead of percents. No invented numbers anywhere in the block.
16. **`signals` with `pathOutlook=null`** for the leading candidate — no SCENARIO block appears in the response; THESIS/CALL/TRADE and the GO IN/HOLD/DON'T decision are unaffected by its absence.
17. **`signals`/`trades` with a payload shaped like the BTC 0.066%-stop incident** (`flagTradePlan.status=rejected`, `reasonCode=stop_inside_costs`, `netRR` near 0.07, `grossRR` near 3.30) — the response reports the flag as rejected/no GO IN, cites the net R:R shortfall (not the gross R:R, which passed), and never treats the near-3R gross number as confirmation of a trade.

## Change log

- 2026-09-22: baseline saved from the live GPT (post Phase 9). Includes track format, geometry block, coil and visual-gate rules. 7990 units.
- 2026-09-22 (Phase 11): trimmed DIRECTION's flag-pattern anatomy (now a pointer to `candidateSetups[]`, engine-owned) and RISK's stop-distance-driven leverage narrative (now a pointer to `suggestedLeverage`, which already caps for stop distance and wallet risk); dropped GEOMETRY's per-field JSON sub-shapes (already in the OpenAPI schema the Action sees). Added: `decisionTrace.bias` grammar note, the `failReason` fourth trace token, and the `include=bias`/MCP-only gating for `biasMatrix`/`alignment`/`decisionInputs`. Net: 7990 → 7836 units (154 saved) while covering three new fields. Added `docs/GPT_INSTRUCTIONS.md`'s payload-field table and GPT test sheet (this doc); added `scripts/check-gpt-instructions.js` / `npm run check:gpt`.
- 2026-09-23: fixes from a live ETH `signals` call that said GO IN while price sat above the entry zone, put Thesis Eliminated inside the zone, and offered an invented breakout entry with R:R to TP1 ≈ 0.14. Added: price outside entry zone → HOLD/WAIT + conditional entry (THRESHOLD); Thesis Eliminated long ≤ zone low, short ≥ zone high; non-engine entries recompute R:R, $ loss, wallet risk, and R:R to TP1 < 1 → DON'T (RISK). Trimmed: EXISTING POSITION header (3b deferred), GEOMETRY "shapes are in the schema", PERFORMANCE wording. Budget raised 7,900 → 7,990. Restored "never inside the zone" after a fresh-chat call still put ETH Thesis Eliminated inside the zone. 7836 → 7990 units.
- 2026-09-23 (trading-model quick pass Q1-Q3, schema 1.11.0): added `measuredTarget`/`measuredRR`/`ema200Side` to the CANDIDATES field list plus a one-line rule for each (measuredTarget is TP1 unless a level/channel line sits in front; measuredRR≥3 supports the call; ema200Side is context, never a filter — M-6 explicitly allows a short above the 200 or a long below it). Added the `td:`/`a200:` bias-trace tokens to ENGINE=INPUT (top-down sentiment/alignment, EMA200 count; alignment adjusts confidence, never vetoes; moving averages are never targets). Trimmed an equal amount to stay budget-neutral: DIRECTION's flag-field list now points at CANDIDATES instead of repeating it; GEOMETRY's channel-position sentence and RISK's leverage sentence were tightened to the same density the rest of the doc already uses; STYLE's `except track` and THRESHOLD's `NO TRADE is valid.` were dropped as redundant with rules stated in full elsewhere (TRACK's own "no DATA section" line; the pervasive NO_TRADE-is-normal handling throughout); a few `does not`/`or`-style contractions. 7990 → 7990 units (net zero).
- 2026-09-23 (quick-pass follow-up, review fix 3): the previous entry's STYLE/THRESHOLD/TRACK trims turned out to remove real rules, not duplicates - `except track` is STYLE's own statement of an exception the reader needs at that point, not covered by TRACK's separate "no DATA section" line for the same reason a rule and its exception both get stated; `NO TRADE is valid.` is THRESHOLD's own permission, not just an echo of NO_TRADE handling elsewhere; TRACK's data-source list (`1m/3m/5m timing, 15m/1h/4h structure, EMAs, Stoch, zones/diagonals/confluence, candidateSetups, extension, engine`) is command-specific guidance a generic "read the data" pointer doesn't carry. Restored all three verbatim. Funded by tightening wording that was genuinely repeated or inferable from context elsewhere in the doc (not by re-cutting anything just restored): dropped repeated `account.` prefixes in RISK's field list (the section already establishes the `account` object), cut `(of collateral)` from `lossAtStopPct` (inferable by elimination against `lossAtStopPctOfWallet` and `collateralUsd` in the same list), merged DATA's two `never` clauses, a few `do not`→`don't` contractions, and single-word trims (`execution readiness`→`readiness`, `not win odds`→`not odds`, `a fake-tight stop`→`fake-tight`) where the dropped word was redundant with the sentence's own remaining context. FORMAT/TRACK FORMAT/NO TRADE LINE templates untouched; entry-zone rules and the `td:`/`a200:`/`measuredTarget`/`ema200Side` lines kept as-is. 7990 → 7988 units.
- 2026-09-23 (F1, flag detection coverage, schema 1.12.0): DATA - noted closed candles may trail the live chart by one candle. CANDIDATES - `confidence=pattern evidence only` (disambiguates it from the new `qual.quality` band). COMMANDS - `flags` now covers every state including proto/failed/expired plus `qual.decision`+`reasons`; `forming` now includes proto. Header/meta bumped to schema 1.12.x. Funded entirely by tightening existing wording, no rule dropped: removed the now-superseded `(quality ≤ med)` aside in CANDIDATES (superseded by the new `qual.quality` field) in favor of `despite NO_TRADE`; dropped a redundant `strength`/`range`/`candle`/`engine` word each in RISK/ENGINE=INPUT/THRESHOLD where the sentence's own remaining context already carried the meaning; removed spaces around several `=` signs (`config=`, `confidence=`, `type=coil=range`, `GO IN+HOLD+DON'T=100%`, `HTF=context`); `GO IN / HOLD / DON'T` → `GO IN/HOLD/DON'T` in STYLE; `account.status≠available` → `status≠available` in DATA (the field was just named on the line before); `fits before liquidation` → `clears liquidation` in EXISTING POSITION; `Leverage provisional range (labeled)` → `Leverage provisional (labeled)` in RISK; merged DATA's `roomToNextSupport/Resistance %`→`%` and THRESHOLD's two `never` clauses. FORMAT/TRACK FORMAT/NO TRADE LINE templates untouched. 7988 → 7988 units (net zero). New fields not yet in the doc's own field list (`candidateId`, `firstDetectedAt`, `failedAt`, `flagSlope`, `qual`) are covered by `openapi/scalp-context.yaml` and `docs/EDITTRADES_MCP_CONNECTOR.md`; the instructions box only carries what a command needs to name.
- 2026-09-23 (signal-reliability minimum plan, schema 1.13.0): a flag candidate (even `confirmed`, even `qual.actionable`) was never a trade call - it had no exact entry, no fees-adjusted R:R, no staleness gate, and the GPT was left to build one itself (the ETH incident this doc already tracks). Added `flagTradePlan` (`lib/flagTradePlan.js`), the one engine-owned trade call per symbol from its confirmed directional flag candidates: `ready`/`conditional`/`rejected` + `reasonCode`, exact `entry`/`stop`/`tp1`/`tp2`/`entryCondition`, `netRR` net of `config.risk` fees/slippage. CANDIDATES - replaced the old unconditional `confirmed + chaseRisk=false = a setup despite NO_TRADE` permission (`Confirmed alone isn't a trade.`) with the `flagTradePlan=trade authority` rule; COMMANDS - added `trades = signals.` (never a third trade-call format). Funded by tightening existing wording, no rule dropped: removed spaces around more `=` signs (`decisionTrace.window=`, `detected=false=`, `Thesis Eliminated=`, `Stop Loss=`, `WINDOW=`, `EXPECTED TRADE TIME=`); `Flag pattern: read candidateSetups[]...— don't re-derive` → `Flag pattern: candidateSetups[]...not raw candles/Stoch`; `— the Action lacks them` cut as redundant with the same sentence's `(MCP only)`; `if you disagree, say why` → `disagree? say why`; `confidence=evidence amount, not trade quality` → `not quality`; `type=coil=range can break` → `breaks`; `decision allocation only` → `decision allocation`; `Lower it further only for vol, exposure, margin, performance, or confirmation the engine doesn't price in` → `or unpriced confirmation`; `margin.usd = capital`/`holdingsUsd = exposure only`/`performance = P&L meter` tightened to `=`. 7988 → 7987 units.
- 2026-09-23 (P1 Pyth mark, schema 1.16.0): RISK - added `Stops, Thesis Eliminated, liquidation hit on mark (Jupiter/Pyth): check vs mark.price; |driftBps|>10 → say so.` (Jupiter perps mark, stop and liquidate on the Pyth oracle; `price` is the closed Kraken 1m close). Funded by tightening wording only, no rule removed: `on 1m/3m/5m/15m/1h/4h/1d` → `on 1m-1d` (ENGINE=INPUT); DATA's two `never` clauses merged; failReason line reworded (`Failed candidate trace token: 4th field=failReason ...`); `a screenshot of visualTarget` → `a visualTarget screenshot`; `Trend: read` → `Trend:`; spaces after commas dropped in field lists (CANDIDATES, RISK `risk{...}`, GEOMETRY, DATA check list, THRESHOLD, EXISTING POSITION order, `forming`, STYLE, RISK lower-it list, THRESHOLD keep-separate) and around `+`/`=` (`rejectedAt+reason`, `ACCOUNT+PERFORMANCE`, `Protective stop=`). FORMAT/TRACK FORMAT/NO TRADE LINE untouched. 7978 → 7976 units.
- 2026-09-24 (T2 trade journal, docs/PLAN_TRADE_JOURNAL.md): COMMANDS - added `log <text>` (→ `postJournal`: took=open, closed=close, skipped=skip, else note; only the numbers the user said; `engineRef` from the matching latest plan/rec; reply `[LOGGED id]`) and `journal` (→ `getJournal`, last 10, one line each). "Never invent a trade" is already carried by the closing `Never manufacture a trade` line. Funded without removing a rule: ` → ` → `→` in every non-template section including PRIORITY; spaces after `,` and `;` dropped in the sections above FORMAT; `trades = signals` → `trades=signals`; wording trims `before any analysis` → `before analysis`, `strategies.* and bestSignal` → `strategies.*/bestSignal`, `If decisionTrace.needsVisualConfirmation,ask for` → `decisionTrace.needsVisualConfirmation→ask for`, STYLE `do not` → `don't`, `ends with the DATA section` → `ends with DATA`. FORMAT/TRACK FORMAT/NO TRADE LINE untouched. 7976 → 7982 units. Test sheet prompts 12 (`log`) and 13 (`journal`) added.
- 2026-09-24 (T4 P2 flag paths, docs/PLAN_FLAG_PATHS.md, schema 1.19.0): fixes the SOL 2026-09-24 incident — the GPT said "wait for the retest" but never said a no-retest runner was likely, then invented scenario percentages after the move ran without one. Added CANDIDATES `pathOutlook≠null→SCENARIO` rule: Readiness from `flagTradePlan.status` (GO IN only if `ready`), Best Entry from `entryCondition`, the `w` percents quoted from `pathOutlook.w` only (never invented, plain-word labels, with `n=`, or "uncalibrated" if `cal=false`); a runner without a retest is stated as a missed entry, not confirmation, never chased; `chase=high/elevated` is flagged up front. Added FORMAT's `SCENARIO` block (Lean/Readiness/Likely/Best Entry/Chase, then the `w%` line), rendered only when `pathOutlook≠null`, between CALL and TRADE. Existing GO IN/HOLD/DON'T and readiness rules untouched. Funded by tightening wording, no rule dropped: DIRECTION's `(see CANDIDATES)` pointer cut (candidateSetups[] is self-evident from CANDIDATES' own opening line); GEOMETRY's `positionPct 0 bottom,100 top` scale annotation cut (the same sentence's `<20`/`>80` thresholds already teach it); many period-joined clauses merged to semicolons across ENGINE=INPUT/CANDIDATES/GEOMETRY/RISK/EXISTING POSITION/THRESHOLD/COMMANDS/STYLE; `is`/`are` used as copulas → `=`; `with` → `w/` in EXISTING POSITION/RISK; `hit on mark` → `on mark`; `explicit confirmation condition` → `confirmation`; remaining spaces around parens/colons dropped; ACCOUNT/EXISTING POSITION/PERFORMANCE/DATA template separator lines ` / ` → `/`; STYLE `Short,direct,` → `Terse,`. FORMAT/TRACK FORMAT/NO TRADE LINE structure untouched (only their own `/`,`,` separator spacing tightened). 7982 → 7984 units. Payload table row added for `pathOutlook`; test sheet prompts 14-16 added (runner/chase, uncalibrated bucket, `pathOutlook=null`).
- 2026-09-24 (T6 phase 1, `docs/MASTER_PLAN_T6_FEE_AWARE_FLAGS.md`, owner decision D1 from the `docs/GOOD_QUALITY_REPLAY.md` phase 0 study - variant V1c, schema 1.21.0): the net gate (`flagPlan.minNetRR` 2.0) ships on - a plan whose net R:R after fees doesn't clear it is now `rejected` (`net_rr_below_min`/`stop_inside_costs`), not just published with a non-blocking warning. CANDIDATES' `flagTradePlan=trade authority` rule now names the floor: `ready→GO IN eligible(net R:R≥2.0 after costs)`. No new field for the GPT to read beyond what CANDIDATES already names (`grossRR`/`netRR`/`reasonCode`) - `costR` and the `net_rr_ok`/`fees_heavy` recommendation tokens are documented in `openapi/scalp-context.yaml` and this doc's field table, not named in the box itself (same "the box only carries what a command needs to name" rule as the F1 entry above). `flag.timeframes` unchanged (1m/3m/5m - V1c does not widen detection). Funded by tightening wording, no rule dropped: ENGINE=INPUT's `session/prev-day levels` → `session/prev-day` and `decisionTrace.window=range used(...)` → `range(...)`; DIRECTION's `not raw candles/Stoch` → `not candles/Stoch`; STYLE's `Every response ends with DATA` → `Ends with DATA`. FORMAT/TRACK FORMAT/NO TRADE LINE untouched. 7984 → 7978 units.
