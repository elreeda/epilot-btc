---
name: btc-guess-change
description: >-
  How to change the BTC-minute product safely: API, domain, UI, and test touch
  points, plus verify-before-done. Use when adding or modifying game behavior,
  endpoints, scoring UX, round history, or related refactors.
---

# Safe product change (BTC guess)

Kitchen-checklist workflow for feature or bugfix work. Prefer small, reviewable diffs that keep settlement fair.

## Before coding

1. Read `settlement-fairness` if the change touches guesses, prices, market health, or scores.
2. Name the user-visible behavior and the authoritative source of each field (server state vs display-only).
3. Prefer extending existing contracts in `server/src/contracts.ts` over ad-hoc shapes.

## Touch points (usual set)

| Layer | Where to look |
| --- | --- |
| HTTP API | `server/src/app.ts` — `/api/session`, `/api/state`, `/api/guesses`, `/api/rounds`, `/healthz` |
| Domain rules | `server/src/domain.ts` |
| Persistence / transactions | `server/src/store.ts`, `server/migrations/*.sql` |
| Ingestion / settlement workers | `server/src/workers.ts`, `server/src/recovery.ts`, `server/src/main.ts` |
| UI | `web/src/main.tsx`, `web/src/price-chart.tsx`, `web/src/round-history.tsx` |
| Unit tests | `server/test/domain.test.ts`, `server/test/recovery.test.ts` |
| Integration | `server/test/store.integration.test.ts` (needs `btc_test` DB) |
| Browser | `web/test/game.spec.ts` (Playwright fixtures; not live Coinbase) |
| Live local round | `pnpm verify:live` via `scripts/verify-live.mjs` (optional, needs `pnpm dev`) |
| Deploy shape | `sst.config.ts`, `Dockerfile` — only if runtime topology changes |

## Change order

1. **Domain / store** — keep invariants in one place; schema migrations when columns/constraints change.
2. **API** — update request validation and responses; do not accept client prices or outcomes.
3. **UI** — bind to `/api/state` and round history; never compute settlement locally.
4. **Tests** — unit for rule edges; integration for transactions; Playwright for UI states you changed.
5. **Verify** — follow `verify-btc-guess` / `pnpm verify` before claiming done.

## Done means

- Behavior matches the stated rule; fairness checklist in `settlement-fairness` still holds.
- `pnpm verify` (or the subset you ran) passed, with evidence noted in the PR/commit message.
- No secrets, `.env`, or `.sst/` artifacts in the diff.
