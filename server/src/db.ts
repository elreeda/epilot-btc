import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (connectionString)
    return new pg.Pool({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 5000,
    });
  const username = process.env.DB_USER,
    password = process.env.DB_PASSWORD,
    database = process.env.DB_NAME ?? "btc";
  if (!process.env.DB_HOST || !username || !password)
    throw new Error(
      "Database config missing: set DATABASE_URL or DB_HOST + credentials",
    );
  return new pg.Pool({
    host: process.env.DB_HOST,
    user: username,
    password,
    database,
    port: Number(process.env.DB_PORT ?? 5432),
    max: 10,
    connectionTimeoutMillis: 5000,
    ssl:
      process.env.DB_SSL === "true"
        ? { rejectUnauthorized: true, ca: process.env.DB_CA }
        : undefined,
  });
}
export async function migrate(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(1000)");
    await client.query("BEGIN");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(directory))
      .filter((n) => /^\d+.*\.sql$/.test(n))
      .sort()) {
      const sql = await readFile(new URL(name, directory), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const {
        rows: [previous],
      } = await client.query(
        "SELECT checksum FROM schema_migrations WHERE name=$1",
        [name],
      );
      if (previous) {
        if (previous.checksum !== checksum)
          throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations(name,checksum) VALUES ($1,$2)",
        [name, checksum],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    await client.query("SELECT pg_advisory_unlock(1000)");
    client.release();
  }
}
export async function transaction<T>(
  pool: pg.Pool,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await run(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
