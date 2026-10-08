import { readFile } from "node:fs/promises";
import { buildApp } from "./app.js";
import { createPool, migrate } from "./db.js";
import { collect, leaderLoop, log, settlementWorker } from "./workers.js";

// Production verifies RDS's certificate using AWS's CA bundle, baked into the image.
if (process.env.DB_SSL === "true")
  process.env.DB_CA = await readFile(
    new URL("../certs/global-bundle.pem", import.meta.url),
    "utf8",
  );

const pool = createPool();

await migrate(pool);

const app = await buildApp(pool);

const stop = new AbortController();

const workers = [
  leaderLoop(pool, 2001, stop.signal, collect),
  leaderLoop(pool, 2002, stop.signal, settlementWorker),
];

await app.listen({
  port: Number(process.env.PORT ?? 3000),
  host: process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1",
});

let closing = false;

async function shutdown() {
  if (closing) return;

  closing = true;
  log("shutdown");
  stop.abort();
  await app.close();
  await Promise.allSettled(workers);
  await pool.end();
}

process.on("SIGTERM", () => void shutdown());

process.on("SIGINT", () => void shutdown());
