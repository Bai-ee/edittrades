# WP9 — MACD + OBV indicator evidence (2026-09-27)

Research only. Registration: `docs/research/harness/WP9_REGISTRATION.md` (read first; definitions
here match it exactly, nothing was changed after seeing results). Card 5 (`RESEARCH_BACKLOG.md`).

**Command:** `node scripts/research/edge/indicator-evidence.js`
**Code:** `scripts/research/edge/lib.js` (`macd()`, `obv()` appended), `scripts/research/edge/indicator-evidence.js`.
**Tests:** `node test-macd-obv.js` (5/5 pass — hand-computed fixtures, append-future invariance, real-data warmup boundary).
**Outputs:** `var/research/wp9/{h1.json,h2.json,console-output.md}` (gitignored).
**Data:** H1 perps + H2 on `test/fixtures/history/deep2y-2026-09-26` (BTC/SOL/ETH, 2024-10 → 2026-09,
same as `families.js`/`run.js`); H1 spot on `var/edge/4h-long` (2017/2020 → 2026-09, same as Card 1).

## H1 — MACD cross entries

### Perps (4h / 1h, base costs: 0.20% long / 0.14% short round trip + 0.02%/h borrow)

| config | phase | n | win% | gross R | net R | t | margin | max borrow %/h |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MACD-cross-4h-perps-all | train | 613 | 30% | 0.111 | **-0.191** | -4.0 | -1.89× | 0.0038 |
| MACD-cross-4h-perps-long | train | 306 | 31% | 0.129 | -0.183 | -2.7 | -1.35× | 0.0044 |
| MACD-cross-4h-perps-short | train | 307 | 30% | 0.094 | -0.199 | -3.0 | -2.65× | 0.0033 |
| MACD-cross-1h-perps-all | train | 2499 | 29% | 0.012 | **-0.269** | -11.4 | -0.83× | -0.0201 |
| MACD-cross-1h-perps-long | train | 1248 | 29% | 0.018 | -0.286 | -8.6 | -0.67× | -0.0233 |
| MACD-cross-1h-perps-short | train | 1251 | 29% | 0.006 | -0.251 | -7.5 | -1.07× | -0.0170 |

Neither timeframe clears the pre-registered holdout gate (`n ≥ 10 and margin > 1`), so **no
holdout run** — this is the pre-registered outcome, not a post-hoc skip.

- 4h has a small positive gross edge (+0.11R) but max tolerable borrow is 0.004%/h against an
  actual ≈0.02%/h — same "borrow kills" shape as every other slow perps family in Card 6.
- 1h is worse than random: gross ≈ 0, net strongly negative with t = -11.4 (n=2499). The exit rule
  (opposite cross or 2R/timeout) does not rescue a signal with no gross edge.
- Both directions lose about equally; this is not a long/short asymmetry.

### Spot variant (4h, 0.15%/side, long while macd > signal else cash) vs SMA200 (Card 1)

| sym | MACD net CAGR (train) | B&H (train) | MACD net CAGR (full 2017/20→26) | B&H (full) | switches (full) | maxDD (full) | SMA200 net CAGR (Card 1, full) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 8% | 45% | 8% | 40% | 1481 | 80% | 42% |
| SOL | 20% | 95% | 12% | 79% | 1043 | 82% | 102% |
| ETH | 14% | 31% | 10% | 27% | 1509 | 82% | 71% |

Train-phase result already fails the pre-registered promotion bar (loses to both B&H and SMA200
on every symbol), so **no holdout run** for the spot variant either, per the same "pass train
first" rule.

- MACD-on-close whipsaws far more than the existing trend filters: ≈163 switches/year over 9.1
  years, vs Card 1's ≈61 sides/year for the SMA200 rule on the same data. It flips almost 3× as
  often.
- Every symbol's MACD-spot net CAGR is roughly a third of the SMA200 net CAGR, and it also loses
  to plain buy-and-hold on all three (the SMA200 rule matches or beats B&H). The 12-bar EMA on 4h
  closes reacts too fast for a long/cash spot filter; it does not carry the SMA200 rule's core
  benefit (staying out of drawdowns without excess switching).
- Consistent with the honest prior in Card 5: MACD is close to `EMA(12) − EMA(26)`, which overlaps
  the momentum families already tested — here it is measurably worse than the existing 4h SMA200
  filter, not neutral.

## H2 — OBV confirmation of F1 4h Donchian breakouts

Own-20-bar-Donchian-channel OBV confirmation (registration §H2), train phase only, 8 F1-4h
configs from `var/edge/train-r1.json` (read-only).

| config | split | n | win% | gross R | net R | t | margin |
| --- | --- | --- | --- | --- | --- | --- | --- |
| N20-k2 | confirmed | 236 | 32% | 0.129 | **-0.112** | -1.7 | -1.29× |
| N20-k2 | unconfirmed | 123 | 32% | 0.032 | -0.200 | -1.8 | -3.01× |
| N20-k2-reg | confirmed | 128 | 36% | 0.130 | **-0.104** | -1.2 | -1.17× |
| N20-k2-reg | unconfirmed | 70 | 29% | 0.030 | -0.207 | -1.5 | -3.37× |
| N20-k3 | confirmed | 165 | 30% | 0.116 | -0.177 | -2.4 | -4.59× |
| N20-k3 | unconfirmed | 85 | 29% | 0.154 | -0.202 | -1.8 | -4.81× |
| N20-k3-reg | confirmed | 94 | 35% | 0.222 | **-0.093** | -0.9 | -2.00× |
| N20-k3-reg | unconfirmed | 45 | 29% | 0.092 | -0.237 | -1.7 | -6.37× |
| N55-k2 | confirmed | 153 | 36% | 0.142 | -0.087 | -1.1 | -0.73× |
| N55-k2 | unconfirmed | 44 | 32% | 0.112 | -0.119 | -0.5 | -1.34× |
| N55-k2-reg | confirmed | 105 | 37% | 0.149 | **-0.075** | -0.8 | -0.52× |
| N55-k2-reg | unconfirmed | 34 | 32% | -0.037 | -0.267 | -1.6 | -4.31× |
| N55-k3 | confirmed | 121 | 33% | 0.081 | -0.199 | -2.4 | -5.14× |
| N55-k3 | unconfirmed | 28 | 29% | 0.228 | **-0.101** | -0.4 | -1.81× |
| N55-k3-reg | confirmed | 84 | 31% | 0.089 | -0.203 | -2.0 | -5.48× |
| N55-k3-reg | unconfirmed | 21 | 24% | 0.080 | -0.200 | -1.2 | -4.70× |

(Full 24-row table incl. "all" per config in `var/research/wp9/h2.json`.)

- **In 6 of 8 configs, OBV-confirmed trades have a clearly less negative net R than unconfirmed**
  (e.g. N20-k2-reg: -0.104 vs -0.207; N55-k2-reg: -0.075 vs -0.267 — its best margin, -0.52×, is
  the closest any H2 split gets to breakeven). This holds at both N20 and N55 and with/without the
  daily regime filter, at the tighter k2 stop.
- **The pattern reverses at the wider k3 stop for N55**: unconfirmed is *better* than confirmed
  (N55-k3: -0.101 vs -0.199; N55-k3-reg: roughly tied). N20-k3 shows almost no separation either.
  So the OBV effect is not universal — it shows up cleanest at k2, weakens or flips at k3.
- **Nothing survives costs.** Every split, confirmed or not, is negative at base perps costs; this
  matches Card 6's finding that the whole F1-don-4h family is borrow-killed. OBV confirmation
  changes the *relative* ranking of trades, not the family's viability on Jupiter perps.
- Sample sizes on the unconfirmed side are thin for several k3 rows (n=21–45), so the reversal at
  k3 could be noise as easily as a real regime difference — a wider or block-bootstrapped
  significance test (WP3) is needed before trusting the split, in either direction.
- Gross R does **not** track the same story (unconfirmed gross beats confirmed gross in 3 of 8
  rows, e.g. N20-k3, N55-k3), so the net-R separation partly reflects hold-time/risk differences
  between the two groups, not a pure win-rate or R-multiple effect. This needs the per-trade
  hold-time breakdown before it's trusted as "OBV predicts direction," not just "OBV correlates
  with shorter/cheaper trades."

## Verdict per hypothesis

- **H1 (MACD cross): REJECT.** No perps config clears fees-plus-borrow at train; the spot variant
  underperforms both buy-and-hold and the existing SMA200 filter on all three symbols, with ~2.7×
  the turnover. MACD adds nothing beyond the trend filters already in evidence — it is
  measurably worse here, not merely redundant.
- **H2 (OBV confirmation): INCONCLUSIVE, mild positive lean.** OBV-confirmed breakouts have
  better net R than unconfirmed ones in 6 of 8 F1-4h configs (best margin -0.52×, still short of
  breakeven), but the effect reverses at the wider k3 stop for N55 and is thin on n for several
  splits. It separates *relative* quality within a family that fails costs either way; it does not
  turn a losing family into a winning one.

## Recommendation on Card 5.3 (engine/MCP context fields)

**Not worth it, on this evidence.** Card 5.3 (add MACD/OBV as display-only context fields, no
gate) was conditioned on 5.2 showing evidence. MACD shows a clear negative result (worse than
what the engine/tracker already runs). OBV shows a real but small and stop-dependent effect on a
family that doesn't survive live costs — not a basis for a new context field. If OBV is revisited,
it should be as part of the already-parked volume-context work (Card 5's "current state" note:
volume-context change parked at commit `2330db1`, schema 1.26, owner-deferred 2026-09-26), and
only after WP3's significance test confirms the k2 split isn't noise. Recommend closing Card
5.1/5.2 as done with these results and leaving 5.3 BLOCKED/PARKED, not promoting it.
