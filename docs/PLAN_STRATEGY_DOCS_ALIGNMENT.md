# Strategy Docs Alignment — single implementer pass

Last updated: 2026-09-23
Status: plan only. Not started.
Branch: `upgrade-signal-engine`
Scope: documentation only (plus one small build script). No engine, payload, test, or GPT-instruction change.

## Why

The Custom GPT reads a knowledge file, `EditTrades_Living_Scalp_Playbook_updated.docx` (owner's copy: `/Users/bballi/Downloads/EditTrades_Living_Scalp_Playbook_updated.docx`), when it gives suggestions. That playbook was written 2026-09-22, before the owner defined the trading model in `docs/MASTER_PLAN_TRADING_MODEL.md` (M-1…M-9). Result today:

- The playbook is missing most of the model (top-down alignment, channels, measured-move targets and the 3R minimum, EMA21/200 as direction, divergence, flag-border entries, the 30% win-rate risk logic).
- Three playbook rules contradict the model (timeframe frame, second-class shorts, tight stops vs "never tighten a stop").
- The master plan is missing four things the playbook already gets right (capital-protection mode, visual gate + chase rule for `FLAG_21`, stop hierarchy for `FLAG_21` sizing, miss-log discipline).
- The payload now carries `td:`/`a200:` tokens and `measuredTarget`/`measuredRR` (schema 1.11.0), so the GPT sees fields its playbook does not explain.

This pass makes one source of truth for the strategy, fixes the master plan, and produces Playbook v2 for the GPT.

Runs after `docs/PLAN_FLAG_DETECTION_COVERAGE.md` (F1). The playbook and `docs/TRADING_MODEL.md` must describe F1's behavior: candidate states proto → forming → triggering → confirmed → failed / expired, failed flags kept visible with a reason, the `qual` object (quality, decision, reason codes), "detect first, decide second", and the one-candle lag between the live chart and closed data. Add Miss 003 (2026-09-23 BTC/ETH/SOL 1m flags hidden after failure) to the playbook's miss log using the update template, citing `test/fixtures/misses/MISS_003`.

## Deliverables

| # | Deliverable | Path |
| --- | --- | --- |
| T1 | Strategy source of truth | `docs/TRADING_MODEL.md` (new) |
| T2 | Master plan patch | `docs/MASTER_PLAN_TRADING_MODEL.md` (edit) |
| T3 | Playbook v2 source | `docs/EDITTRADES_PLAYBOOK.md` (new) |
| T4 | Playbook v2 Word file for the GPT | `scripts/build-playbook.js` (new) → `/Users/bballi/Downloads/EditTrades_Living_Scalp_Playbook_v2.docx` (not committed) |
| T5 | Index + changelog | `docs/DOCUMENTATION_INDEX.md`, `CHANGELOG.md` |

## Rules for this pass

1. Docs only. Do not edit any file under `services/`, `lib/`, `api/`, `config/`, `openapi/`, any `test-*.js`, `docs/GPT_INSTRUCTIONS.md`, `public/index.html`, or `CLAUDE.md`.
2. The owner's words win. Source order: `docs/MASTER_PLAN_TRADING_MODEL.md` sections "The trading model" and "Owner decisions" → this plan's "Resolutions" → the old playbook → everything else. Never invent a rule, a number, or a threshold. A default the owner has not confirmed is labeled `(default, owner to confirm)`.
3. Long and short are written as one rule with both wordings, never long-only.
4. Engine field names are exact (check them in `docs/EDITTRADES_MCP_CONNECTOR.md` and `openapi/scalp-context.yaml`). Mark each rule's engine support as `live (schema 1.11.0)` or `planned (master plan M<n>)`.
5. Preserve the old playbook's Miss 001, Miss 002, High-Leverage Stop Hierarchy, change log, and update template verbatim, except where a Resolution below changes a rule; then keep the old text and mark it `Superseded 2026-09-23 by …`.
6. No new npm dependencies. The docx build uses macOS `textutil` (present; `pandoc` is not installed).
7. No commit, push, or deploy. Do not upload anything to the GPT. Stop after the report.

## Resolutions (owner-confirmed direction; apply everywhere)

- **Timeframes.** Direction comes top-down from 1W → 1D → 4H → 1H (higher timeframes weigh more; small timeframes are noisy). Entries are timed on lower timeframes. Flags are hunted on all timeframes. Supersedes the playbook's "15m/1h/4h for context and 1m/3m/5m for execution" as the whole frame; 1m/3m/5m remain the execution timeframes for scalps.
- **Shorts are first-class.** Bear flags are the inverted bull flag. Shorts against the overall sentiment (e.g. a channel-top short in a bullish market, even above the EMA200) are valid with a breakout read on the edge. Supersedes "Short equivalent may be considered below EMA21 when broader context is bearish."
- **Stops (merged rule).** Two stop types: `structure` (beyond the nearest major support/resistance behind the entry) and `tight` (just beyond the flag channel's bottom for a bull flag, top for a bear flag). A tight stop is valid only when it sits on a real flag border; it is never placed arbitrarily to make leverage fit. Leverage and size are then derived from the chosen stop under the High-Leverage Stop Hierarchy (dollar-loss cap first, stop safely before liquidation, never tighten to justify leverage). The playbook's hierarchy stays in force.
- **Targets.** Flag TP1 = measured move (pole length from the base of the first move to the flag start, projected from the breakout; payload `measuredTarget`, `measuredRR`). A major level or channel line in front of it becomes TP1 first. Minimum 3R to TP1. Moving averages are never targets.
- **Alignment.** `td:<sentiment>:<n>/4` is the biggest confidence input and never a veto. `a200:<count>/<of>` adds weight (more timeframes above the 200 = stronger bull case, mirror for bears). The EMA200 never filters a trade.
- **Entries.** Breakout (from the flag top / bottom), retest, or flag-border (catching the bottom / top of the flag's own channel while it forms). All respect the chase rule and the 3R minimum.
- **Divergence.** Stoch RSI divergence confirms; standard and hidden both count; the closer to live price and to the traded timeframe, the stronger. Engine support is planned (master plan M5); until then the GPT reads it from candles and Stoch only when evident, and says so.
- **Win rate and survival.** Expect about 3 wins in 10. Break-even average win is 2.33R, hence the 3R minimum. Size so a losing run of ~13 (expected in 100 trades at 30%) is survivable.

## T1 — `docs/TRADING_MODEL.md`

Plain trader language, no code. Sections:

1. **Header**: purpose (the strategy's single source of truth; the playbook and the GPT instructions derive from it), last updated, owner.
2. **Rules** R-1…R-n. Carry M-1…M-9 (including M-5b, M-6b) from the master plan, plus the playbook rules that are strategy (not GPT procedure): chase rule, visual confirmation, NO_TRADE never vetoes a clean flag, confidence separation, margin vs holdings, stop hierarchy. Each rule: one-paragraph statement, long wording, short wording, engine support (`live` field names or `planned M<n>`), source (`owner 2026-09-23`, `playbook 2026-09-22`, `Miss 002`).
3. **Setup anatomy**: bull flag and bear flag (mirror) as short step lists: impulse, compression on the EMA21, borders, breakout/retest, measured move.
4. **Entries, stops, targets**: the Resolutions above as a table (type · long · short · rule).
5. **Risk**: stop hierarchy (verbatim from the playbook), 3R minimum, 30% win-rate math, losing-run survival.
6. **Open defaults**: timeframe pairing detail, per-trade wallet risk and streak drawdown limit, divergence lookback — each `(default, owner to confirm)` with the master plan's default value.
7. **Misses**: one-line pointers to Miss 001 / Miss 002 in the playbook and `test/fixtures/misses/`.

## T2 — Master plan patch (`docs/MASTER_PLAN_TRADING_MODEL.md`)

Additive edits only; re-read the file first (other sessions edit it).

1. Add under "Owner decisions": "`docs/TRADING_MODEL.md` is the strategy source of truth; this plan builds it. The GPT playbook derives from it."
2. M0: mark build step 1 (`docs/TRADING_MODEL.md`) as delivered by this pass; M0 then remains the owner-labeled fixtures and open decisions.
3. M7 (`FLAG_21`) additions:
   - Respect the visual gate: when `decisionTrace.needsVisualConfirmation` points at the FLAG_21 flag, FLAG_21 publishes but its confidence is capped (config `model.visualGateConfidenceCap`) and the trace says why.
   - Respect the chase rule: a flag with `chaseRisk: true` cannot be a `breakout` entry; it may only publish a `retest` entry at the breakout level.
   - Sizing follows the High-Leverage Stop Hierarchy (`lib/riskEngine.js` `stopHierarchy`): the chosen stop (`structure` or `tight`) is never moved to fit leverage; leverage is derived from it.
   - Add `retest` as a third `entryType` beside `breakout` and `flag-border`.
4. New phase row and section **M7b — Trade management hints**: after FLAG_21 publishes, add `management = { protectAfterR, protectTo }` (config; default: after price reaches 1.5R in favor, protect to the last flag border or breakeven, whichever is further in favor), so the GPT can switch to capital-protection mode (playbook Miss 002). Read-only hints; no position tracking (3b stays deferred). Tests mirrored long/short. Execution order: M7 → M7b → M8.
5. Governing rules: add "Every miss becomes (a) a replay fixture under `test/fixtures/misses/`, (b) a playbook entry using the update template, (c) a rule change here if the rule was wrong. No miss is fixed in only one place."
6. M10: the GPT deliverable includes regenerating Playbook v2 from `docs/EDITTRADES_PLAYBOOK.md` (T4 script) alongside the instructions.

## T3 — `docs/EDITTRADES_PLAYBOOK.md` (Playbook v2 source)

Same section order as the old playbook so the GPT's habits carry over, updated per the Resolutions:

1. Operating Principle — keep; replace the timeframe line with the top-down Resolution; add "Read `decisionTrace.bias` `td:` and `a200:` first."
2. Priority Setup — Flags on the EMA21 (all timeframes; 1m is the scalp priority): bull and bear written as mirrors; entries (breakout, retest, flag-border); measured-move TP1; 3R minimum; chase rule kept.
3. Top-Down, Channels and Moving Averages — new: alignment as confidence not veto, channel edges as targets, counter-sentiment trades need a breakout read, EMA21/200 as direction and pull, never targets, major levels override.
4. Confirmation — divergence (standard + hidden, recency), with "until the engine publishes it (planned), state it only when evident in candles/Stoch".
5. Visual Confirmation Rule — keep verbatim.
6. Confidence Discipline — keep; add "alignment raises or lowers confidence; it never vetoes."
7. Risk & High Leverage — keep verbatim; add the merged stop rule, 3R, 30% win-rate survival.
8. Miss / Correction Log — Miss 001 and Miss 002 verbatim (with the High-Leverage Stop Hierarchy).
9. Required Scan Checklist — keep every existing item; add: `td:` alignment and `a200` read; channel position and nearest edge; flag `measuredTarget` / `measuredRR` ≥ 3; divergence checked; entry type chosen; stop type chosen and leverage derived from it.
10. Ongoing Change Log — keep the 2026-09-22 entry; add 2026-09-23: model rules added, three conflicts resolved (list them), schema 1.11.0 fields explained.
11. Update Template — keep verbatim.

Payload field names must match schema 1.11.0 exactly. The playbook must not contradict `docs/GPT_INSTRUCTIONS.md`; if it would, keep the playbook wording aligned to the instructions and list the conflict in the report instead of editing the instructions.

## T4 — Playbook docx build

`scripts/build-playbook.js` (Node, no dependencies): reads `docs/EDITTRADES_PLAYBOOK.md`, converts the Markdown subset it uses (headings `#`–`###`, paragraphs, `-` and `1.` lists, `- [ ]` checkboxes as ☐, `**bold**`, `` `code` ``, pipe tables) to a single HTML file in the OS temp directory, then runs `textutil -convert docx -output <out> <html>`. Default output `/Users/bballi/Downloads/EditTrades_Living_Scalp_Playbook_v2.docx`; `--out <path>` overrides. Add npm script `build:playbook`. Never overwrite the owner's original `..._updated.docx`.

Verify: run it; convert the result back with `textutil -convert txt` and confirm every section heading and both miss entries are present.

## T5 — Index and changelog

`docs/DOCUMENTATION_INDEX.md`: add `docs/TRADING_MODEL.md` (strategy source of truth), `docs/EDITTRADES_PLAYBOOK.md` (GPT knowledge-file source), this plan, and the build script. `CHANGELOG.md`: one 2026-09-23 line for this pass.

## Verification before reporting

- `git diff --check` on touched files.
- Grep the three docs for each schema 1.11.0 field they name and confirm it exists in `openapi/scalp-context.yaml`.
- Cross-check: every Resolution appears in T1 and T3; every M-rule appears in T1; no long-only rule anywhere.
- The docx round-trip check from T4.
- `npm run check:gpt` still passes (proves the instructions were not touched).

## Implementer prompt (paste into a fresh Sonnet thread)

```
You are the implementer for the EditTrades strategy docs alignment pass.

Repo: /Users/bballi/Documents/Repos/snapshot_tradingview (branch upgrade-signal-engine).

Your source of truth is docs/PLAN_STRATEGY_DOCS_ALIGNMENT.md. Read it in full, then read, in order:
1. docs/MASTER_PLAN_TRADING_MODEL.md ("The trading model" and "Owner decisions" are the owner's words)
2. The current GPT playbook: /Users/bballi/Downloads/EditTrades_Living_Scalp_Playbook_updated.docx
   (convert to text with: textutil -convert txt -stdout "<path>")
3. docs/GPT_INSTRUCTIONS.md, docs/EDITTRADES_MCP_CONNECTOR.md, openapi/scalp-context.yaml (field names)
4. CLAUDE.md

Deliver T1 -> T5 in one pass exactly as the plan specifies, then verify, then report and stop.

Non-negotiables:
- Docs only (plus scripts/build-playbook.js and its npm script). Do not touch services/, lib/, api/,
  config/, openapi/, test files, docs/GPT_INSTRUCTIONS.md, public/index.html, or CLAUDE.md.
- Never invent a rule, number, or threshold; unconfirmed defaults are labeled "(default, owner to confirm)".
- Long and short in every rule. Exact schema 1.11.0 field names.
- Keep Miss 001, Miss 002, the High-Leverage Stop Hierarchy, the change log and the update template
  verbatim; mark superseded text instead of deleting it.
- No new dependencies. No commit, push, deploy, or GPT upload. Never overwrite the owner's original docx.

Report (compact): files created/changed; for T1-T5 what was done; the Resolutions each landed in; any
conflict found between the playbook and docs/GPT_INSTRUCTIONS.md (listed, not fixed); verification
results including the docx round-trip; the output docx path. Then stop.
```
