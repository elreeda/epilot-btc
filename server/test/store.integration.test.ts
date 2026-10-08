import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { buildApp } from "../src/app.js";
import { createPool, migrate } from "../src/db.js";
import { isoUs, timestampUs } from "../src/domain.js";
import {
  commitCoverage,
  roundHistory,
  session,
  settle,
  state,
  submitGuess,
} from "../src/store.js";
import { collect } from "../src/workers.js";

const pool = createPool(process.env.TEST_DATABASE_URL);

async function seed(price = "100") {
  const now = BigInt(Date.now()) * 1000n;
  const c = await pool.connect();

  try {
    await commitCoverage(
      c,
      [{ id: "1", timeUs: now, price }],
      "1",
      now,
      new Date(),
      () => true,
    );
  } finally {
    c.release();
  }

  return now;
}

async function eligible(player: string, direction: "up" | "down" = "up") {
  const now = await seed();
  const g = await submitGuess(pool, player, direction, randomUUID());

  // Backdate this fixture only: production timing is always database-owned.
  await pool.query(
    "UPDATE guesses SET submitted_us=$2,deadline_us=$3 WHERE id=$1",
    [g!.id, (now - 61000000n).toString(), (now - 1000000n).toString()],
  );
  // Preserve a historical floor trade for the fixture's acceptance time.
  await pool.query("UPDATE trades SET time_us=$1 WHERE trade_id=1", [
    (now - 61000000n).toString(),
  ]);

  return { g: g!, now };
}

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error("Integration tests need an isolated TEST_DATABASE_URL");

  await migrate(pool);
});

beforeEach(async () => {
  await pool.query("TRUNCATE guesses,players,trades CASCADE");
  await pool.query(
    "UPDATE market SET checkpoint_id=NULL,coverage_us=NULL,latest_trade_id=NULL,heartbeat_at=NULL,verified_at=NULL,status='recovering'",
  );
});

afterAll(() => pool.end());

describe("transactional game state", () => {
  it("locks the historical acceptance price only after coverage passes acceptance", async () => {
    const p = await session(pool);

    await seed();

    const key = randomUUID();
    const g = (await submitGuess(pool, p.id, "up", key))!;
    const accepted = timestampUs(g.submittedAt);

    expect(g.startingTrade).toBeNull();
    expect(g).not.toHaveProperty("ruleVersion");
    expect(timestampUs(g.deadline) - accepted).toBe(60000000n);

    const c = await pool.connect();

    try {
      // Same timestamp: higher ID is the last trade. A later trade must not become the start.
      await commitCoverage(
        c,
        [
          { id: "2", timeUs: accepted - 1n, price: "102" },
          { id: "3", timeUs: accepted, price: "103" },
          { id: "4", timeUs: accepted, price: "104" },
        ],
        "4",
        accepted,
        new Date(),
        () => true,
      );
      expect(await settle(c, () => true)).toBe(0);
      expect((await state(pool, p.id)).activeGuess!.startingTrade).toBeNull();
      await commitCoverage(
        c,
        [{ id: "5", timeUs: accepted + 1n, price: "999" }],
        "5",
        accepted + 1n,
        new Date(),
        () => true,
      );
      // An unverified row with a larger ID cannot influence the historical starting trade.
      await pool.query(
        "INSERT INTO trades(product,trade_id,time_us,price) VALUES ('BTC-USD',9,$1,1000)",
        [accepted.toString()],
      );
      await pool.query("UPDATE market SET status='recovering'");
      await settle(c, () => true);
    } finally {
      c.release();
    }

    const locked = (await state(pool, p.id)).activeGuess!;

    expect(locked.startingTrade).toEqual({
      id: "4",
      time: isoUs(accepted),
      price: "104",
    });
    expect(locked.deadline).toBe(g.deadline);
    expect((await submitGuess(pool, p.id, "up", key))!.startingTrade).toEqual(
      locked.startingTrade,
    );
    await expect(submitGuess(pool, p.id, "down", key)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await state(pool, p.id)).score).toBe(0);
  });

  it("freezes intent across retry, stale feed and a new worker connection", async () => {
    const p = await session(pool);

    await seed();

    const key = randomUUID();
    const original = (await submitGuess(pool, p.id, "down", key))!;

    await pool.query("UPDATE market SET status='recovering'");
    expect(await submitGuess(pool, p.id, "down", key)).toEqual(original);
    await expect(
      submitGuess(pool, p.id, "up", randomUUID()),
    ).rejects.toMatchObject({ statusCode: 409 });

    const first = await pool.connect();

    expect(await settle(first, () => true)).toBe(0);
    first.release(true);

    const restarted = await pool.connect();

    try {
      await commitCoverage(
        restarted,
        [],
        "1",
        timestampUs(original.submittedAt) + 1n,
        new Date(),
        () => true,
      );
      await settle(restarted, () => true);
    } finally {
      restarted.release();
    }

    const restored = (await state(pool, p.id)).activeGuess!;

    expect(restored.id).toBe(original.id);
    expect(restored.direction).toBe("down");
    expect(restored.deadline).toBe(original.deadline);
    expect(restored.startingTrade!.id).toBe("1");
  });

  it.each(["up", "down"] as const)(
    "uses the recovered start when verification spans the deadline (%s)",
    async (direction) => {
      const p = await session(pool);
      const { g, now } = await eligible(p.id, direction);
      const submitted = now - 61000000n,
        deadline = now - 1000000n;
      const c = await pool.connect();

      try {
        await commitCoverage(
          c,
          [
            { id: "2", timeUs: submitted, price: "102.00000001" },
            { id: "3", timeUs: submitted + 1n, price: "105" },
            { id: "4", timeUs: deadline, price: "101" },
            { id: "5", timeUs: now, price: "103" },
          ],
          "5",
          now,
          new Date(),
          () => true,
        );
        expect(await settle(c, () => true)).toBe(1);
        expect(await settle(c, () => true)).toBe(0);
      } finally {
        c.release();
      }

      const result = (await state(pool, p.id)).latestResult!;

      expect(result.id).toBe(g.id);
      expect(result.startingTrade).toEqual({
        id: "2",
        time: isoUs(submitted),
        price: "102.00000001",
      });
      expect(result.settlementTrade.id).toBe("4");
      expect(result.scoreDelta).toBe(direction === "up" ? -1 : 1);
      expect((await state(pool, p.id)).score).toBe(result.scoreDelta);
    },
  );

  it("rolls back a price lock on leadership loss and retries without changing acceptance", async () => {
    const p = await session(pool);

    await seed();

    const original = (await submitGuess(pool, p.id, "up", randomUUID()))!;
    const c = await pool.connect();

    try {
      await commitCoverage(
        c,
        [],
        "1",
        timestampUs(original.submittedAt) + 1n,
        new Date(),
        () => true,
      );

      let checks = 0;

      await expect(settle(c, () => ++checks < 2)).rejects.toThrow("leadership");
      expect((await state(pool, p.id)).activeGuess!.startingTrade).toBeNull();
      await settle(c, () => true);
    } finally {
      c.release();
    }

    const locked = (await state(pool, p.id)).activeGuess!;

    expect(locked.startingTrade!.id).toBe("1");
    expect(locked.submittedAt).toBe(original.submittedAt);
    expect(locked.deadline).toBe(original.deadline);
  });

  it("enforces complete start evidence and acceptance time for every round", async () => {
    const p = await session(pool);
    const { g, now } = await eligible(p.id);

    await expect(
      pool.query("UPDATE guesses SET start_trade_id=1 WHERE id=$1", [g.id]),
    ).rejects.toThrow("complete_start_evidence");
    await expect(
      pool.query(
        "UPDATE guesses SET status='resolved',settlement_trade_id=2,settlement_time_us=$2,settlement_price=101,score_delta=1 WHERE id=$1",
        [g.id, now.toString()],
      ),
    ).rejects.toThrow("complete_start_evidence");
    await expect(
      pool.query(
        "UPDATE guesses SET start_trade_id=1,start_time_us=submitted_us+1,start_price=100 WHERE id=$1",
        [g.id],
      ),
    ).rejects.toThrow("acceptance_start_time");

    const { rows } = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='guesses' AND column_name='rule_version'",
    );

    expect(rows).toHaveLength(0);
  });

  it("round history is private, newest first, and paginates without duplicates at timestamp ties", async () => {
    const owner = await session(pool),
      other = await session(pool);
    const base = BigInt(Date.now()) * 1000n;

    async function add(player: string, index: number) {
      const time = base + BigInt(Math.floor(index / 2));

      await pool.query(
        `INSERT INTO guesses(id,player_id,idempotency_key,direction,submitted_us,deadline_us,start_trade_id,start_time_us,start_price,status,settlement_trade_id,settlement_time_us,settlement_price,score_delta,resolved_at)
        VALUES ($1,$2,$3,'up',$4,$5,1,$4,100,'resolved',2,$6,101,1,now())`,
        [
          randomUUID(),
          player,
          randomUUID(),
          time.toString(),
          (time + 60000000n).toString(),
          (time + 60000001n).toString(),
        ],
      );
    }

    for (let i = 0; i < 25; i++) await add(owner.id, i);

    await add(other.id, 100);
    await pool.query(
      "UPDATE players SET score=CASE WHEN id=$1 THEN 25 ELSE 1 END",
      [owner.id],
    );

    const first = await roundHistory(pool, owner.id);

    expect(first.rounds).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();

    const next = await roundHistory(pool, owner.id, first.nextCursor!);

    expect(next.rounds).toHaveLength(5);
    expect(next.nextCursor).toBeNull();

    const combined = [...first.rounds, ...next.rounds];

    expect(new Set(combined.map((r) => r!.id)).size).toBe(25);
    expect(
      combined.every(
        (r, i) => i === 0 || r!.submittedAt <= combined[i - 1]!.submittedAt,
      ),
    ).toBe(true);
    expect((await roundHistory(pool, other.id)).rounds).toHaveLength(1);
    await expect(
      roundHistory(pool, owner.id, "bad-cursor"),
    ).rejects.toMatchObject({ statusCode: 400 });

    const app = await buildApp(pool);

    try {
      expect((await app.inject({ url: "/api/rounds" })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("chart samples include verified closing prices and exclude unverified trades", async () => {
    const player = await session(pool);
    const now = await seed();
    const c = await pool.connect();

    try {
      await commitCoverage(
        c,
        [{ id: "2", timeUs: now + 1n, price: "101" }],
        "2",
        now + 1n,
        new Date(),
        () => true,
      );
    } finally {
      c.release();
    }

    await pool.query(
      "INSERT INTO trades(product,trade_id,time_us,price) VALUES ('BTC-USD',3,$1,999)",
      [(now + 2n).toString()],
    );

    const snapshot = await state(pool, player.id);

    expect(snapshot.market.history).toEqual([
      { time: isoUs(now + 1n), price: "101" },
    ]);
  });

  it("serializes concurrent guesses across tabs", async () => {
    const p = await session(pool);

    await seed();

    const results = await Promise.allSettled([
      submitGuess(pool, p.id, "up", randomUUID()),
      submitGuess(pool, p.id, "down", randomUUID()),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await state(pool, p.id)).activeGuess).not.toBeNull();
  });
  it("reuses a submission key and rejects changed intent", async () => {
    const p = await session(pool);

    await seed();

    const key = randomUUID();
    const a = await submitGuess(pool, p.id, "up", key),
      b = await submitGuess(pool, p.id, "up", key);

    expect(a!.id).toBe(b!.id);
    await expect(submitGuess(pool, p.id, "down", key)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
  it("settles once, even with concurrent worker retries; permits negative scores", async () => {
    const p = await session(pool);
    const { now } = await eligible(p.id);
    const a = await pool.connect(),
      b = await pool.connect();

    try {
      await commitCoverage(
        a,
        [{ id: "2", timeUs: now, price: "99" }],
        "2",
        now,
        new Date(),
        () => true,
      );
      await Promise.all([settle(a, () => true), settle(b, () => true)]);
      await settle(a, () => true);
    } finally {
      a.release();
      b.release();
    }

    const s = await state(pool, p.id);

    expect(s.score).toBe(-1);
    expect(s.activeGuess).toBeNull();
    expect(s.latestResult!.settlementTrade!.id).toBe("2");
  });
  it("holds a round until missing earlier trade evidence is recovered", async () => {
    const p = await session(pool);
    const { now } = await eligible(p.id);

    await pool.query(
      "INSERT INTO trades(product,trade_id,time_us,price) VALUES ($1,$2,$3,$4)",
      ["BTC-USD", "3", now.toString(), "101"],
    );

    const c = await pool.connect();

    try {
      expect(await settle(c, () => true)).toBe(0);
      await commitCoverage(
        c,
        [
          { id: "2", timeUs: now - 500000n, price: "99" },
          { id: "3", timeUs: now, price: "101" },
        ],
        "3",
        now,
        new Date(),
        () => true,
      );
      await settle(c, () => true);
    } finally {
      c.release();
    }

    const s = await state(pool, p.id);

    expect(s.score).toBe(-1);
    expect(s.latestResult!.settlementTrade!.id).toBe("2");
  });
  it("rolls back result and score on database failure", async () => {
    const p = await session(pool);
    const { now } = await eligible(p.id);
    const c = await pool.connect();

    try {
      await commitCoverage(
        c,
        [{ id: "2", timeUs: now, price: "101" }],
        "2",
        now,
        new Date(),
        () => true,
      );
      await c.query(
        "CREATE FUNCTION fail_score() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$",
      );
      await c.query(
        "CREATE TRIGGER fail_score BEFORE UPDATE ON players FOR EACH ROW EXECUTE FUNCTION fail_score()",
      );
      await expect(settle(c, () => true)).rejects.toThrow("injected");
    } finally {
      await c.query("DROP TRIGGER IF EXISTS fail_score ON players");
      await c.query("DROP FUNCTION IF EXISTS fail_score()");
      c.release();
    }

    const s = await state(pool, p.id);

    expect(s.score).toBe(0);
    expect(s.activeGuess).not.toBeNull();
    expect(s.activeGuess!.startingTrade).toBeNull();
  });
  it("rolls back trades and checkpoint when leadership is lost", async () => {
    await seed();

    const c = await pool.connect();
    let checks = 0;

    try {
      await expect(
        commitCoverage(
          c,
          [{ id: "2", timeUs: BigInt(Date.now()) * 1000n, price: "101" }],
          "2",
          BigInt(Date.now()) * 1000n,
          new Date(),
          () => ++checks < 2,
        ),
      ).rejects.toThrow("leadership");
    } finally {
      c.release();
    }

    expect(
      (await pool.query("SELECT checkpoint_id FROM market")).rows[0]
        .checkpoint_id,
    ).toBe("1");
    expect(
      (await pool.query("SELECT * FROM trades WHERE trade_id=2")).rowCount,
    ).toBe(0);
  });
  it("equal price remains pending and stale feeds reject new guesses", async () => {
    const p = await session(pool);

    await eligible(p.id);

    const c = await pool.connect();

    try {
      expect(await settle(c, () => true)).toBe(0);
    } finally {
      c.release();
    }

    const other = await session(pool);

    await pool.query(
      "UPDATE market SET heartbeat_at=now()-interval '10 seconds'",
    );
    await expect(
      submitGuess(pool, other.id, "up", randomUUID()),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
  it("cookie restores identity; validates input and refuses cross-site writes", async () => {
    process.env.COOKIE_SECURE = "false";
    process.env.APP_ORIGIN = "http://localhost:5173";

    const app = await buildApp(pool);

    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/session",
        payload: {},
      });
      const cookie = first.headers["set-cookie"]!.toString().split(";")[0];
      const s = await app.inject({ url: "/api/state", headers: { cookie } });

      expect(s.json().score).toBe(0);

      const again = await app.inject({
        method: "POST",
        url: "/api/session",
        headers: { cookie },
        payload: {},
      });

      expect(again.headers["set-cookie"]!.toString().split(";")[0]).toBe(
        cookie,
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/guesses",
            headers: { cookie },
            payload: { direction: "sideways" },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/guesses",
            headers: { origin: "https://evil.example", cookie },
            payload: { direction: "up", idempotencyKey: randomUUID() },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
  it("accepts HTTP ALB same-origin writes and rejects mismatched origins", async () => {
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      COOKIE_SECURE: process.env.COOKIE_SECURE,
      APP_ORIGIN: process.env.APP_ORIGIN,
    };

    process.env.NODE_ENV = "production";
    process.env.COOKIE_SECURE = "false";
    delete process.env.APP_ORIGIN;

    const app = await buildApp(pool);
    const headers = {
      host: "demo.elb.amazonaws.com",
      origin: "http://demo.elb.amazonaws.com",
      "sec-fetch-site": "same-origin",
    };

    try {
      expect((await app.inject({ url: "/api/state" })).statusCode).toBe(401);
      expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);

      const first = await app.inject({
        method: "POST",
        url: "/api/session",
        headers,
        payload: {},
      });

      expect(first.statusCode).toBe(200);
      expect(first.headers["set-cookie"]).not.toContain("Secure");

      const cookie = first.headers["set-cookie"]!.toString().split(";")[0];

      expect(
        (
          await app.inject({
            url: "/api/state",
            headers: { ...headers, cookie },
          })
        ).statusCode,
      ).toBe(200);

      const again = await app.inject({
        method: "POST",
        url: "/api/session",
        headers: { ...headers, cookie },
        payload: {},
      });

      expect(again.headers["set-cookie"]!.toString().split(";")[0]).toBe(
        cookie,
      );
      expect(again.headers["cache-control"]).toBe("no-store");
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/session",
            headers: { ...headers, origin: "https://evil.example" },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/session",
            headers: { ...headers, origin: "" },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      await seed();

      const call = await app.inject({
        method: "POST",
        url: "/api/guesses",
        headers: { ...headers, cookie },
        payload: { direction: "up", idempotencyKey: randomUUID() },
      });

      expect(call.statusCode).toBe(201);
    } finally {
      await app.close();

      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  it("recovers a dropped WebSocket trade using REST before awarding points", async () => {
    const p = await session(pool);
    const { now } = await eligible(p.id);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });

    await new Promise<void>((resolve) => server.once("listening", resolve));

    const port = (server.address() as { port: number }).port;
    const timers: ReturnType<typeof setInterval>[] = [];
    let firstHeartbeatSentAt = 0;

    server.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "match",
          product_id: "BTC-USD",
          trade_id: 3,
          time: isoUs(now),
          price: "101",
        }),
      );

      const heartbeat = () => {
        firstHeartbeatSentAt ||= Date.now();
        socket.send(
          JSON.stringify({
            type: "heartbeat",
            product_id: "BTC-USD",
            last_trade_id: 3,
            time: isoUs(BigInt(Date.now()) * 1000n),
          }),
        );
      };

      heartbeat();

      const timer = setInterval(heartbeat, 100);

      timers.push(timer);

      socket.on("close", () => clearInterval(timer));
    });

    const c = await pool.connect();
    let running = true;
    const requestedCursors: (string | undefined)[] = [];
    const task = collect(c, () => running, {
      socketUrl: `ws://127.0.0.1:${port}`,
      fetchPage: async (after) => {
        expect(Date.now() - firstHeartbeatSentAt).toBeGreaterThanOrEqual(1000);
        requestedCursors.push(after);

        // Newer-direction queries would be empty at the live edge. The first
        // older page includes the target; its provider cursor retrieves the gap.
        if (after === "4")
          return {
            trades: [{ id: "3", timeUs: now, price: "101" }],
            after: "3",
          };

        if (after === "3")
          return {
            trades: [
              { id: "2", timeUs: now - 500000n, price: "99" },
              { id: "1", timeUs: now - 61000000n, price: "100" },
            ],
            after: null,
          };

        return { trades: [], after: null };
      },
    });

    // The fixture's baseline was at acceptance, while this historical round was backdated.
    // Ensure the checkpoint timestamp precedes the recovered trades, as on the real exchange.
    await pool.query("UPDATE trades SET time_us=$1 WHERE trade_id=1", [
      (now - 61000000n).toString(),
    ]);

    try {
      for (let i = 0; i < 50; i++) {
        if (
          (await pool.query("SELECT checkpoint_id FROM market")).rows[0]
            .checkpoint_id === "3"
        )
          break;

        await delay(100);
      }

      expect(
        (await pool.query("SELECT checkpoint_id FROM market")).rows[0]
          .checkpoint_id,
      ).toBe("3");
      expect(requestedCursors).toEqual(["4", "3"]);
      running = false;
      await task;
      await settle(c, () => true);

      const result = await state(pool, p.id);

      expect(result.score).toBe(-1);
      expect(result.latestResult!.settlementTrade!.id).toBe("2");
    } finally {
      running = false;
      await task;

      for (const timer of timers) clearInterval(timer);

      for (const socket of server.clients) socket.terminate();

      await new Promise<void>((resolve) => server.close(() => resolve()));
      c.release();
    }
  });
});
