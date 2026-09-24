# Playbook additions — 2026-09-24 (T6 completion plan B3)

Source: `docs/PLAN_T6_COMPLETION_V2.md` "B3 — free ≥ 150 instruction units by moving
procedure lines into the playbook doc."

The Custom GPT reads a second knowledge file besides the Instructions box:
`EditTrades_Living_Scalp_Playbook_updated.docx` (owner's copy:
`/Users/bballi/Downloads/EditTrades_Living_Scalp_Playbook_updated.docx`, per
`docs/PLAN_STRATEGY_DOCS_ALIGNMENT.md`). That file has no 8,000-unit cap, so
reference/data-dictionary text that doesn't change per-request belongs there instead
of in the Instructions box. **This doc is not applied automatically** — the owner
pastes the sections below into the playbook docx by hand, same pattern as pasting
`docs/GPT_INSTRUCTIONS.md`'s fenced block into the Custom GPT.

Budget: `docs/GPT_INSTRUCTIONS.md` 7978 → **7744 units** (234 freed, target was ≥150).
Nothing behavioral was cut — every trim below removed a **field-name list already
visible in the live JSON response and the OpenAPI schema**, not a rule. The Instructions
box now points at "the schema" instead of repeating field names inline.

## What moved

### 1. GEOMETRY field list

Instructions before: `geometryContext[15m|1h|4h]:structure,atrPct,higherLows/lowerHighs,S/R zones,room%,extensionRisk,EMA slopes,diagonals,channel(positionPct),confluenceZones.`
Instructions after: `geometryContext[15m|1h|4h]:fields per the schema.`

Paste into the playbook (a `geometryContext[tf]` reference section, if one doesn't
already exist):

> **geometryContext fields** (per timeframe, 15m/1h/4h): `structure`, `atrPct`,
> `higherLows`/`lowerHighs`, S/R zones, `room%`, `extensionRisk`, EMA slopes,
> diagonals, `channel` (with `positionPct`), `confluenceZones`. Full shapes are in
> `openapi/scalp-context.yaml`'s `GeometryContext`/`Diagonal`/`Channel`/`ConfluenceZone`
> schemas - the live API response carries these exact keys.

### 2. CANDIDATES (`candidateSetups[]`) field list

Instructions before: `symbols.X.candidateSetups[]:flags from 1m/3m/5m(timeframe,direction,state,breakoutLevel,invalidation,ema21Hold,chaseRisk,confidence,measuredTarget,measuredRR,ema200Side,risk if present).`
Instructions after: `symbols.X.candidateSetups[]:flags from 1m/3m/5m,fields per the schema(risk only if present).`

Paste into the playbook:

> **candidateSetups[] fields** (1m/3m/5m flags): `timeframe`, `direction`, `state`,
> `breakoutLevel`, `invalidation`, `ema21Hold`, `chaseRisk`, `confidence`,
> `measuredTarget`, `measuredRR`, `ema200Side`, and `risk` (present only when `state`
> is `triggering` or `confirmed` and `chaseRisk` is false). Full shapes:
> `openapi/scalp-context.yaml`'s `CandidateSetup` schema.

### 3. RISK "Time" estimation method

Instructions before: `Time:estimate TP1/TP2 ranges from timeframe/distance/ATR/momentum/structure;give Time Stop(reassess,not auto-close),label estimates.`
Instructions after: `Time:give a labeled TP1/TP2/Time Stop estimate(reassess,not auto-close) - method in the playbook.`

Paste into the playbook (near any existing time-to-target guidance):

> **Estimating time to TP1/TP2:** derive from the candidate's own timeframe, the
> price distance to the target, ATR, momentum, and structure (e.g. a tighter
> timeframe + strong momentum + clean structure implies a shorter estimate than a
> wide-target/choppy setup on a slower timeframe). Always label it an estimate, and
> always pair it with a Time Stop - a point to reassess the thesis, never an
> instruction to auto-close the position.

## Not moved (considered, kept in the box)

- **TRACK's data-source list** (`1m/3m/5m timing,15m/1h/4h structure,EMAs,Stoch,
  zones/diagonals/confluence,candidateSetups,extension,engine`) - already tried and
  reverted once (2026-09-23, review fix 3): it's command-specific guidance, not a
  generic "read the data" pointer the playbook could substitute for.
- **EXISTING POSITION's risk-math order** (entry→notional→collateral→...→liquidation
  check→REDUCE/EXIT) - this is the live-position risk procedure itself, not a data
  dictionary; moving it out of the same context window as the user's actual position
  numbers was judged too risky for a budget-freeing pass.
