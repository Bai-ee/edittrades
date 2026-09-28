# T-22 prompt — Custom GPT quotes mark.price (Pyth) as the current price

Owner-approved 2026-09-28 (reviewer: EditTrades Strategies Live Tracking thread). Instructions-only. No engine, payload, openapi, test, bot, or tracker change. Schema 1.29.0 and configVersion 2026.09.27-3 unchanged.

## Problem
Asked which feed it uses, the GPT said the Kraken candle close is "current BTC price" and that mark "comes from the account side". Both wrong: `symbols.<SYM>.mark.price` is the Pyth oracle price (Hermes, `lib/pythMark.js`), the price Jupiter perps fills, stops and liquidates on. `symbols.<SYM>.price` is the last closed Kraken 1m candle, the signal basis. The Instructions box (RISK line) only says to check stops/liquidation against `mark.price`; it never says which price to quote as live. `openapi/scalp-context.yaml` already describes both correctly (`Mark` schema, `price` field) — do not touch it.

## Change (one file: `docs/GPT_INSTRUCTIONS.md`)
1. In the fenced block, DATA or RISK section, add one rule, wording to this effect (compress to the box's style):
   `Current/fill price=mark.price(Pyth,what Jupiter fills/stops/liquidates on);price=last closed Kraken candle=signal basis only. Label which you quote. Plan levels(entry/stop/TP)stay as computed,never rebased to mark. mark.status stale|unavailable:say so,quote price labelled Kraken.`
2. Budget: `npm run check:gpt` must pass (cap 7,990 UTF-16 units; 44 spare now). Fund the new rule by trimming wording elsewhere, same pattern as the 2026-09-24/25 entries in the change log: shorten phrasing or move a field-NAME list to the playbook doc (`docs/PLAYBOOK_ADDENDUM_2026-09-28.md`, append a section 10 bullet if you move one). Never cut a rule. List every trim in the change log entry.
3. Update the doc header ("Current length", "Last updated 2026-09-28 (T-22 mark price …)"), the payload-field table row for `mark.*`, and add a dated change-log bullet at the end in the existing format.
4. Run `npm run check:gpt`. Commit `docs/GPT_INSTRUCTIONS.md` (+ the addendum if touched) by name: `docs(T-22): GPT instructions quote mark.price as the current/fill price`. Do not push, deploy, or touch any other file. Report: units before/after, the exact new rule text, the trims.

Rules: `docs/AGENT_SESSION_RULES.md`. `git add` by file name only. Other sessions share the tree; edit nothing else.
