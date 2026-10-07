import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "./domain.js";
import {
  playerFor,
  roundHistory,
  session,
  state,
  submitGuess,
} from "./store.js";

function sameHostOrigin(origin: string | undefined, host: string | undefined) {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function buildApp(pool: pg.Pool) {
  const app = Fastify({
    logger: { redact: ["req.headers.cookie", "req.headers.authorization"] },
    trustProxy: true,
    bodyLimit: 4096,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff");
    if (
      process.env.ORIGIN_SECRET &&
      req.headers["x-origin-secret"] !== process.env.ORIGIN_SECRET &&
      req.url !== "/healthz"
    )
      throw new HttpError(403, "Forbidden");
    if (req.method === "POST") {
      const origin = req.headers.origin;
      const expected = process.env.APP_ORIGIN;
      const localAlias =
        process.env.NODE_ENV !== "production" &&
        ["http://localhost:5173", "http://127.0.0.1:5173"].includes(
          origin ?? "",
        );
      const sameHost = sameHostOrigin(origin, req.headers.host);
      if (
        req.headers["sec-fetch-site"] === "cross-site" ||
        (origin &&
          expected &&
          origin !== expected &&
          !localAlias &&
          !sameHost) ||
        (!origin && process.env.NODE_ENV === "production")
      )
        throw new HttpError(403, "Request origin is not allowed.");
    }
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof HttpError)
      return reply.code(error.statusCode).send({ message: error.message });
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({ message: "The request contains invalid input." });
    const failure = error as { statusCode?: number; message?: string };
    const status =
      typeof failure.statusCode === "number" ? failure.statusCode : 500;
    if (status >= 500) req.log.error(error);
    return reply.code(status).send({
      message:
        status >= 500
          ? "The server could not complete this request."
          : failure.message,
    });
  });
  app.get("/healthz", async () => {
    await pool.query("SELECT 1");
    return { status: "ok" };
  });
  app.post("/api/session", async (req, reply) => {
    const s = await session(pool, req.cookies.btc_session);
    reply.setCookie("btc_session", s.token, {
      path: "/",
      httpOnly: true,
      secure: process.env.COOKIE_SECURE !== "false",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
    });
    return { ready: true };
  });
  app.get("/api/state", async (req) =>
    state(pool, await playerFor(pool, req.cookies.btc_session)),
  );
  app.get("/api/rounds", async (req) => {
    const { cursor } = z
      .object({ cursor: z.string().max(128).optional() })
      .strict()
      .parse(req.query);
    return roundHistory(
      pool,
      await playerFor(pool, req.cookies.btc_session),
      cursor,
    );
  });
  app.post("/api/guesses", async (req, reply) => {
    const { direction, idempotencyKey } = z
      .object({ direction: z.enum(["up", "down"]), idempotencyKey: z.uuid() })
      .strict()
      .parse(req.body);
    const result = await submitGuess(
      pool,
      await playerFor(pool, req.cookies.btc_session),
      direction,
      idempotencyKey,
    );
    return reply.code(201).send(result);
  });

  // Production image serves the Vite build from the same origin as /api.
  const dist = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if (existsSync(dist)) {
    await app.register(fastifyStatic, {
      root: dist,
      wildcard: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (
        req.method === "GET" &&
        !req.url.startsWith("/api") &&
        req.url !== "/healthz"
      )
        return reply.sendFile("index.html");
      return reply.code(404).send({ message: "Not found." });
    });
  }

  return app;
}
