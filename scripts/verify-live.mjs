// Explicit opt-in check: creates one points-only round against a running local backend.
import { randomUUID } from "node:crypto";
import { utimes, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

const origin = "http://localhost:5173";
const session = await fetch(`${origin}/api/session`, {
  method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json" },
  body: "{}",
});
if (!session.ok) throw new Error("Session failed");
const cookie = session.headers.get("set-cookie").split(";")[0];
const headers = {
  Cookie: cookie,
  Origin: origin,
  "Content-Type": "application/json",
};
let accepted;
const key = randomUUID();
for (let i = 0; i < 40; i++) {
  const response = await fetch(`${origin}/api/guesses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ direction: "up", idempotencyKey: key }),
  });
  if (response.ok) {
    accepted = await response.json();
    break;
  }
  if (response.status !== 503)
    throw new Error(`Submission failed ${response.status}`);
  await delay(1000);
}
if (!accepted) throw new Error("Market did not become ready");
console.log(
  JSON.stringify({
    event: "live_round_accepted",
    id: accepted.id,
    startingPrice: accepted.startingTrade?.price ?? null,
    deadline: accepted.deadline,
  }),
);
if (process.argv.includes("--restart")) {
  await delay(10000);
  const file = new URL("../server/src/main.ts", import.meta.url);
  const now = new Date();
  await utimes(file, now, now);
  console.log(JSON.stringify({ event: "requested_local_watch_restart" }));
}
let result;
for (let i = 0; i < 120; i++) {
  try {
    const response = await fetch(`${origin}/api/state`, { headers });
    if (response.ok) {
      const s = await response.json();
      if (s.latestResult?.id === accepted.id) {
        result = s;
        break;
      }
    }
  } catch {}
  await delay(1000);
}
if (!result) throw new Error("Live round did not settle in time");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const {
    rows: [g],
  } = await pool.query("SELECT * FROM guesses WHERE id=$1", [accepted.id]);
  const {
    rows: [expected],
  } = await pool.query(
    `SELECT * FROM trades WHERE product='BTC-USD' AND time_us>=$1 AND time_us<=(SELECT coverage_us FROM market WHERE product='BTC-USD') AND price<>$2 AND trade_id<=(SELECT checkpoint_id FROM market WHERE product='BTC-USD') ORDER BY time_us,trade_id LIMIT 1`,
    [g.deadline_us, g.start_price],
  );
  const {
    rows: [expectedStart],
  } = await pool.query(
    `SELECT * FROM trades WHERE product='BTC-USD' AND time_us<=$1 AND trade_id<=(SELECT checkpoint_id FROM market WHERE product='BTC-USD') ORDER BY time_us DESC,trade_id DESC LIMIT 1`,
    [g.submitted_us],
  );
  if (!expectedStart || expectedStart.trade_id !== g.start_trade_id)
    throw new Error(
      "Starting price did not select last verified trade at/before acceptance",
    );
  if (!expected || expected.trade_id !== g.settlement_trade_id)
    throw new Error(
      "Settlement did not select earliest verified qualifying trade",
    );
  if (result.score !== g.score_delta)
    throw new Error("Score adjustment was not exactly once");
  const evidence = {
    checkedAt: new Date().toISOString(),
    backendRestartRequested: process.argv.includes("--restart"),
    guess: result.latestResult,
    score: result.score,
    verifiedEarliestTrade: true,
    verifiedAcceptanceTrade: true,
  };
  await writeFile(
    new URL("../test/live-verification.json", import.meta.url),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      event: "live_round_verified",
      score: result.score,
      settlementTrade: g.settlement_trade_id,
    }),
  );
} finally {
  await pool.end();
}
