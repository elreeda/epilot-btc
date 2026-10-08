# Minute / BTC project guide

This guide explains the product, architecture, correctness rules, and code layout for humans and coding agents working on the project. Use the [README](../README.md) for setup and deployment instructions. Coding agents should also read [AGENTS.md](../AGENTS.md) and the relevant repository skills before making changes.

The [shared tldraw engineering board](https://www.tldraw.com/f/fW_iaGZHE_WFKlawnExWh?d=v-452.-507.4774.3291.page) illustrates the architecture, round lifecycle, recovery, engineering decisions, and contributing with AI and repository skills. Edit the diagrams directly in tldraw.

## What we are building

A player predicts whether Coinbase's BTC-USD price will go higher or lower after one minute. A correct call adds one point; an incorrect call subtracts one. The player can leave and return in the same browser without losing their score or pending round.

Our product priority is **a result the player can trust and understand**. A responsive screen, recent price context, clear waiting states, and personal round history support that priority. This is a points game, not a money-backed product.

Personal round history helps players understand their decisions and inspect results. A global leaderboard is outside the current scope: anonymous browser identities do not provide a reliable basis for competitive ranking.

### The rules we must preserve

1. At most one pending guess per player, including across tabs.
2. A resolved round changes the score exactly once, even under retries or restart.
3. A result uses verified market history; a later observed price cannot stand in for missing earlier trades.

The [README's rules](../README.md#rules-and-fairness) define acceptance, deferred starting-price locking, and settlement. The browser displays the server's decisions; its price and countdown never determine a result.

## Start here

Use the README for [local setup](../README.md#run-locally), [verification](../README.md#verification), and [AWS deployment](../README.md#deploy-to-aws-sst-v4). Complete a round, open a second tab while pending, and refresh to check continuity. The browser tests use API fixtures; real Coinbase recovery requires the separate live check described in the README.

## Follow one round

| Step                  | Owner                  | What happens                                                                                                                                                                      |
| --------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Return to the game    | API + PostgreSQL       | An opaque cookie identifies the player. Only its hash is stored; the client cannot choose another player's ID.                                                                    |
| Submit Up/Down        | API + PostgreSQL       | Validate direction/key, serialize on the player, return an existing idempotent submission or create one pending round. Freeze direction/server time after the freshness gate. Starting evidence stays empty until history covers acceptance. |
| Wait                  | Browser                | Poll authoritative state every two seconds. Show the countdown and pending feedback; do not compute the result.                                                                   |
| Verify market history | Collector + PostgreSQL | Receive WebSocket matches/heartbeats, reconcile the target interval through REST, persist canonical trades and checkpoint atomically.                                             |
| Settle                | Worker + PostgreSQL    | Every second, fill pending starting evidence from the last verified trade at/before acceptance, then lock eligible guesses. Select the earliest qualifying verified trade. Save the result and increment the score in the same transaction.                      |
| Explain the outcome   | Browser + history API  | Show the last result immediately. Fetch personal history separately and expose starting trade, deadline, settlement trade, and points.                                            |

### Code map

| Area                        | Start reading                                                                                    | Why                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Screen and state refresh    | [web/src/main.tsx](../web/src/main.tsx)                                                          | The player journey, request retry key, and server-adjusted countdown.                                     |
| Chart and personal history  | [price-chart.tsx](../web/src/price-chart.tsx), [round-history.tsx](../web/src/round-history.tsx) | Chart samples are display-only. History has its own loading, pagination, and error states.                |
| HTTP boundary               | [server/src/app.ts](../server/src/app.ts), [contracts.ts](../server/src/contracts.ts)            | Session ownership, validation, errors, and shared public types.                                           |
| Domain and database changes | [domain.ts](../server/src/domain.ts), [store.ts](../server/src/store.ts)                         | Exact comparison, acceptance transaction, actual SQL settlement selection, and private cursor pagination. |
| Feed and recovery           | [workers.ts](../server/src/workers.ts), [recovery.ts](../server/src/recovery.ts)                 | Leadership, connection generations, coverage verification, and provider pagination.                       |
| Persistence lifecycle       | [db.ts](../server/src/db.ts), [migrations](../server/migrations)                                 | Checksum-recorded migrations, transactions, schema constraints, and indexes.                              |

The `players` table owns identity and score. `guesses` owns the round and its result evidence. `trades` stores canonical price/time and optional original WebSocket time. `market` stores verified coverage, checkpoint, latest trade, and feed health. `schema_migrations` records applied migrations. Add migrations for schema changes; do not edit an applied migration. See the README for [disposable database resets](../README.md#reset-disposable-demo-data).

## Failure behavior is part of the product

| Situation                              | Player experience                                        | Engineering guarantee                                                                                           |
| -------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Two tabs submit                        | One round is accepted; the other conflicts.              | Player-row serialization and a partial unique index enforce one pending guess.                                  |
| Submission response is lost            | Retry the same call.                                     | The idempotency key returns the original guess; a new key is not silently substituted.                          |
| Starting price is still locking | “Locking price…” with the original countdown or expired deadline. | Wait for complete acceptance coverage. Retries/restart preserve direction and deadline, even if verification takes over a minute. |
| Price is unchanged after 60 seconds    | “Waiting for the first trade at a different price.”      | No tie is turned into a win or loss.                                                                            |
| WebSocket disconnects or goes quiet    | New guesses are blocked; accepted rounds remain visible. | Invalidate the connection generation, reconnect, and verify history before advancing coverage.                  |
| Earlier trade is missing               | Result may be delayed.                                   | REST recovery restores the actual interval; settlement cannot jump over the gap.                                |
| Backend restarts                       | Round resumes from persisted state.                      | Database session locks elect new workers; pending guesses need no in-memory timer or scheduled-message handoff. |
| Database write fails during settlement | Round remains pending.                                   | Result and score roll back together.                                                                            |
| History cannot load                    | Game remains usable; history can retry.                  | The private history request is independent of the core state request.                                           |

Previously verified historical rounds can still settle while the current feed is disconnected. “Feed unhealthy” does not invalidate evidence we already persisted and verified.

## Engineering decisions

- **Continuously running Node service:** a natural home for the exchange connection and workers. PostgreSQL session advisory locks prevent competing leaders during overlap. This supports recovery, not a claim of high availability.
- **Deferred starting price:** a fast external feed could exploit a stale verified snapshot as the starting reference. Lock intent first, then establish the historical acceptance trade after verification. This adds a visible locking state while keeping the deadline fixed. Server/exchange UTC clocks must be aligned.
- **Conservative REST verification:** WebSocket supplies trades and the heartbeat boundary; advancing intervals are verified through REST even when connected. This avoids assuming that the last trade ID proves every intervening event arrived. It costs requests and can add lag.
- **Canonical REST timestamps:** the transports can differ by a microsecond. Preserve both timestamps; use one consistent clock for all settlements. Price contradictions still halt verification.
- **Bounded recovery:** 200 REST pages and 100,000 buffered WebSocket events. A long outage can require operator intervention. The safe result is pending, not a fabricated outcome.
- **Anonymous returning identity:** low signup friction; clearing the cookie loses access and different browsers count as different players. It is not strong person-level identity.
- **Personal history:** server-scoped to the current session, newest first, pages of twenty. Keyset pagination uses submission time and ID to avoid skipping tied timestamps.

## Known limits and next priorities

The demo is deployed over HTTP. It uses cryptographic browser-generated idempotency keys that work in this environment, but the session cookie cannot have the Secure flag until HTTPS is configured. HTTPS remains a deployment priority.

Recovery waits one second for REST publication, fetches the target trade and preceding history, and follows Coinbase's pagination cursors back to the saved checkpoint. Missing evidence keeps affected rounds pending until recovery succeeds. The five-second freshness gate can also block new guesses when no new trade arrives despite a healthy connection.

Security priorities include tightening `trustProxy`, validating security configuration at startup, strengthening session-creation limits, and separating runtime database privileges from migrations. The current in-memory rate limiter is per process. These are known gaps, not protections we claim already exist.

Before longer operation, establish ledger retention that preserves pending-round coverage and result evidence. Before greater traffic, measure state/history query latency and provider verification lag, then optimize against those measurements. Do not add caching that weakens result correctness without an explicit consistency policy.

## Making changes

Start with the relevant area in the code map, then trace the behavior through its public contract, database operations, and tests. Keep prices, acceptance time, settlement, and score server-owned. Preserve the three invariants above when changing game behavior.

For UI changes, check loading, pending, recovery, offline, empty, and error states as applicable, including keyboard and mobile use. Browser fixtures verify the UI contract; they do not prove exchange-data correctness.

For ingestion or settlement changes, test missing and out-of-order events, reconnects, retries, and transaction failures. Never fill a coverage gap by selecting a later observed price. Review the repository's [settlement-fairness skill](../.agents/skills/settlement-fairness/SKILL.md) for the detailed guardrails.

Run `pnpm verify` before completing a change. Add the relevant PostgreSQL integration or browser checks when the behavior crosses those boundaries, and record what was checked and any remaining limitations. Deployment and database resets are separate operations; consult the README and the requested scope before running them.
