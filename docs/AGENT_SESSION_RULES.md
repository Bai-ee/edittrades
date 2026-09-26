# Rules for every agent session on this repo (2026-09-26)

Live perps trading is ON in production (EXECUTION_MODE=live, simulate-only OFF, caps $20 / 2x / $2 / $25 / 1). One orchestrator thread ("EditTrades Live Perps Execution") owns live orders, env, and deploys.

1. Never place, confirm, or suggest a Telegram order. `/order`, `/confirm`, Open buttons move real money.
2. Never deploy (`vercel --prod`), never touch Vercel env, never read `.env*` values.
3. Never `git add -A` or `git add .`. Stage your files by name. Other sessions have uncommitted work in the same tree; do not edit, revert, or commit files you did not change.
4. Commit before handing back. Do not push unless your prompt says so.
5. If your task touches `lib/telegram.js`, `api/telegram-cron.js`, `api/telegram-webhook.js`, or `test-telegram.js` and another session is mid-edit there, work in your own worktree: `git worktree add ../snapshot_tradingview-<slug> -b <slug>`; the orchestrator merges.
6. Engine rules and thresholds are frozen until 2026-10-08. Presentation, routing, and execution plumbing only.
7. Hard rules in `CLAUDE.md` always apply (no execution tool in MCP, wallet tracker read-only, no secrets in logs, 3 % scalp stop, no live-mode weakening).

Current queue (orchestrator-enforced): A agent G focus mode (in progress, shared tree) → C alert clarity Phase A (worktree `alert-clarity`) → D wallet risk policy (`docs/PROMPT_T8_AGENT_H.md`). Volume-context work (schema 1.26) commits when its own session says it is test-clean.
