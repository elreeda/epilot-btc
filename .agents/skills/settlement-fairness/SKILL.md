---
name: settlement-fairness
description: >-
  Domain guardrails for BTC-minute settlement and scoring so agents do not
  break money-adjacent fairness. Use when changing guesses, settlement,
  Coinbase ingestion/recovery, market health, scores, or round evidence.
---

# Settlement fairness

This app awards points from Coinbase BTC-USD trades. Treat settlement like a checklist, not improvisation.

## Non-negotiables

1. **Server owns open and close prices.** Admission captures `start_*` from the verified market snapshot in PostgreSQL. Settlement picks the first verified trade at or after `deadline_us` with a price different from `start_price`. Never use browser clocks, client-submitted prices, or UI chart samples to resolve a round.
2. **Never trust client-submitted prices for resolve.** `POST /api/guesses` accepts only `direction` and `idempotencyKey`. Outcomes, scores, start/settlement trades, and timestamps come from the server.
3. **Round lifecycle:** open (market live + fresh) → guess window (pending until `deadline_us` = submit + 60s) → settle (worker finds qualifying trade inside verified coverage) → score (`score_delta` ±1 on the player row). Equal prices keep the round pending.
4. **One rule version:** `first-differing-trade-v1` in `server/src/domain.ts` (`chooseSettlement`, `scoreDelta`) and `guesses.rule_version`.

## Coinbase feed expectations

Implemented in `server/src/workers.ts` (collector) and `server/src/recovery.ts`:

- Subscribe to `matches` + `heartbeat`. Buffer live trades; do not treat `last_match` alone as continuous coverage.
- On disconnect or **5s without heartbeat**, invalidate the connection generation and block new admissions (`market.status` recovering/error).
- Reconnect with exponential backoff/jitter, then REST-reconcile from checkpoint through the heartbeat `last_trade_id` before advancing coverage.
- Persist verified trades + checkpoint in one transaction via `commitCoverage` in `server/src/store.ts`. Fail closed on conflicts, truncated history, or timestamp regression; leave checkpoint unchanged.
- Settlement may use **already verified** historical coverage even if the socket is down. A gap must not be filled by a later unverified trade.

## Authoritative files

| Concern | Path |
| --- | --- |
| Rule / ordering / score | `server/src/domain.ts` |
| Admit guess, settle, coverage, state | `server/src/store.ts` (`submitGuess`, `settle`, `commitCoverage`, `state`) |
| WS collector + settlement loop | `server/src/workers.ts` |
| REST gap recovery | `server/src/recovery.ts` |
| HTTP API surface | `server/src/app.ts` |
| Schema (guesses, trades, market) | `server/migrations/001_initial.sql`, `002_websocket_evidence.sql` |
| Unit boundaries | `server/test/domain.test.ts`, `server/test/recovery.test.ts` |
| DB transactions | `server/test/store.integration.test.ts` |

## Agent checklist before claiming a settlement change is done

- [ ] No client clock or client price influences open, deadline, or resolve.
- [ ] Settlement still reads only trades inside verified `coverage_us` / checkpoint.
- [ ] Pending + locks still prevent double awards; crash leaves unresolved guesses pending.
- [ ] UI still displays server evidence only (start trade, deadline, settlement trade).
- [ ] Ran the verify skill / `pnpm verify` (or equivalent) and recorded what passed.
