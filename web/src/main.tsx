import { useEffect, useRef, useState } from "react";

function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

import { createRoot } from "react-dom/client";
import "./style.css";
import type { GameState as State } from "../../server/src/contracts.js";
import { PriceChart } from "./price-chart.js";
import { RoundHistory } from "./round-history.js";

const money = (value: string | null) =>
  value === null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(Number(value));
async function request(path: string, body?: unknown) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok)
    throw Object.assign(new Error(data.message ?? "Could not connect."), {
      status: res.status,
    });
  return data;
}
function App() {
  const [state, setState] = useState<State | null>(null),
    [error, setError] = useState(""),
    [offline, setOffline] = useState(false),
    [busy, setBusy] = useState(false),
    [now, setNow] = useState(Date.now());
  const offset = useRef(0),
    alive = useRef(true),
    sessionReady = useRef(false),
    inflight = useRef(false);
  // Retain the key after an ambiguous network failure; retrying must not create a new round.
  const pendingRequest = useRef<{
    direction: "up" | "down";
    idempotencyKey: string;
  } | null>(null);
  async function refresh() {
    if (inflight.current) return;
    inflight.current = true;
    try {
      if (!sessionReady.current) {
        await request("/api/session", {});
        sessionReady.current = true;
      }
      const started = Date.now();
      const next: State = await request("/api/state");
      if (alive.current) {
        offset.current =
          Date.parse(next.serverTime) - (started + Date.now()) / 2;
        setState(next);
        setOffline(false);
      }
    } catch (e) {
      if (alive.current) {
        setOffline(true);
        if (errorStatus(e) === 401) sessionReady.current = false;
      }
    } finally {
      inflight.current = false;
    }
  }
  // Mount-only poll/listeners; refresh closes over latest refs/state setters.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional empty deps
  useEffect(() => {
    alive.current = true;
    void refresh();
    const polling = setInterval(() => void refresh(), 2000),
      tick = setInterval(() => setNow(Date.now()), 250);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    window.addEventListener("online", focus);
    return () => {
      alive.current = false;
      clearInterval(polling);
      clearInterval(tick);
      window.removeEventListener("focus", focus);
      window.removeEventListener("online", focus);
    };
  }, []);
  async function guess(direction: "up" | "down") {
    if (busy) return;
    setBusy(true);
    setError("");
    const payload = pendingRequest.current ?? {
      direction,
      idempotencyKey: crypto.randomUUID(),
    };
    pendingRequest.current = payload;
    try {
      await request("/api/guesses", payload);
      pendingRequest.current = null;
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      const status = errorStatus(e);
      if (status && status < 500) pendingRequest.current = null;
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  const active = state?.activeGuess,
    remaining = active
      ? Math.max(
          0,
          Math.ceil(
            (Date.parse(active.deadline) - now - offset.current) / 1000,
          ),
        )
      : 60;
  const healthy = state?.market.status === "live" && !offline,
    disabled = !healthy || !!active || busy || pendingRequest.current !== null;
  const status = offline
    ? "Connection lost"
    : healthy
      ? "Market live"
      : state?.market.status === "error"
        ? "Recovery paused"
        : state?.market.status === "stale"
          ? "Price delayed"
          : "Connecting to market";
  const locking = !!active && active.startingTrade === null;
  const prompt = active
    ? locking
      ? "Locking price…"
      : remaining > 0
        ? "Your call is in."
        : "The minute is up."
    : state?.latestResult
      ? "Ready for another round?"
      : "Where will Bitcoin go next?";
  const help = active
    ? locking
      ? "Your direction is saved. Verifying the last Coinbase trade at or before acceptance. The deadline stays fixed."
      : remaining > 0
        ? "Watch the market. Your prediction settles after the minute ends."
        : !healthy
          ? "Verifying trades before deciding your result."
          : "Waiting for the first trade at a different price."
    : offline
      ? "Your last known score is shown. Reconnecting automatically."
      : !healthy
        ? "You can make a call once fresh market data is verified."
        : "Make your call. One minute. One point on the line.";
  const result = state?.latestResult;
  return (
    <main>
      <header>
        <a className="brand" href="/" aria-label="Minute home">
          <span className="brand-mark">m/</span> minute
          <span className="brand-note">THE BTC PREDICTION GAME</span>
        </a>
        <div className="connection">
          <span className={healthy ? "dot live" : "dot"} />
          {status}
        </div>
      </header>
      <div className="layout">
        <section className="game" aria-labelledby="game-title">
          <div className="eyebrow">
            <span>01 / MAKE YOUR CALL</span>
            <span>BTC · USD</span>
          </div>
          <div className="asset-heading">
            <h1 id="game-title">Bitcoin</h1>
            <span className="asset-source">Coinbase Exchange</span>
          </div>
          <div
            className="price"
            role="status"
            aria-label="Latest Bitcoin price"
          >
            {money(state?.market.price ?? null)}
            <span>USD</span>
          </div>
          <div className="price-foot">
            {state?.market.time
              ? `${healthy ? "Latest verified trade" : "Last verified trade"} · ${new Date(state.market.time).toLocaleTimeString()}`
              : "Waiting for a verified trade"}
          </div>
          <PriceChart
            history={state?.market.history ?? []}
            serverTime={state?.serverTime ?? new Date(now).toISOString()}
            status={offline ? "stale" : (state?.market.status ?? "recovering")}
          />
          <div className="divider" />
          <div className="round-heading">
            <h2>{prompt}</h2>
            <span className="duration">60 SEC ROUND</span>
          </div>
          <p className="help" role="status">
            {help}
          </p>
          {active ? (
            <div className="active-round">
              <div>
                <span className="small-label">YOUR PREDICTION</span>
                <strong>
                  {active.direction === "up" ? "↗ Higher" : "↘ Lower"}
                </strong>
                <span>
                  {active.startingTrade
                    ? `From ${money(active.startingTrade.price)}`
                    : "Starting price is being verified"}
                </span>
              </div>
              <div className="clock">
                <strong>
                  {remaining > 0
                    ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`
                    : "…"}
                </strong>
                <span>
                  {remaining > 0
                    ? "TO DEADLINE"
                    : locking
                      ? "LOCKING PRICE"
                      : "AWAITING RESULT"}
                </span>
              </div>
              <div
                className="progress"
                role="progressbar"
                aria-label="Round countdown"
                aria-valuemin={0}
                aria-valuemax={60}
                aria-valuenow={60 - remaining}
              >
                <i style={{ width: `${((60 - remaining) / 60) * 100}%` }} />
              </div>
            </div>
          ) : (
            <div className="choices">
              <button
                type="button"
                className="up"
                disabled={disabled}
                onClick={() => void guess("up")}
              >
                <span className="arrow">↗</span>
                <span>
                  Higher<small>I think the price will rise</small>
                </span>
              </button>
              <button
                type="button"
                className="down"
                disabled={disabled}
                onClick={() => void guess("down")}
              >
                <span className="arrow">↘</span>
                <span>
                  Lower<small>I think the price will fall</small>
                </span>
              </button>
            </div>
          )}
          {busy && <p role="status">Submitting your call…</p>}
          {error && (
            <div className="error" role="alert">
              {error}
              {pendingRequest.current && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void guess(pendingRequest.current!.direction)}
                >
                  Retry the same call
                </button>
              )}
            </div>
          )}
          <p className="micro">
            One active call at a time. Your round keeps running when you leave.
          </p>
        </section>
        <aside>
          <section className="score-panel">
            <span className="eyebrow">YOUR RUNNING SCORE</span>
            <div className="score">
              {state ? `${state.score > 0 ? "+" : ""}${state.score}` : "—"}
              <span>PTS</span>
            </div>
            <div className="score-rule">
              <span>
                Correct call <b>+1</b>
              </span>
              <span>
                Wrong call <b>−1</b>
              </span>
            </div>
            <p>
              Start at zero. Follow your instincts.
              <br />
              Saved for your next visit.
            </p>
          </section>
          <section className="result-panel" aria-live="polite">
            <span className="eyebrow">LAST ROUND</span>
            {result ? (
              <>
                <h3 className={result.scoreDelta === 1 ? "won" : "lost"}>
                  {result.scoreDelta === 1 ? "Good call." : "Next time."}
                  <span>{result.scoreDelta === 1 ? "+1" : "−1"} PT</span>
                </h3>
                <p>
                  You called{" "}
                  <strong>
                    {result.direction === "up" ? "higher" : "lower"}
                  </strong>
                  .
                </p>
                <div className="result-prices">
                  <span>
                    Starting price<b>{money(result.startingTrade.price)}</b>
                  </span>
                  <span>
                    Settlement price
                    <b>{money(result.settlementTrade!.price)}</b>
                  </span>
                </div>
                <details>
                  <summary>View settlement evidence</summary>
                  <p>Rule: {result.ruleVersion}</p>
                  <p>
                    Starting trade #{result.startingTrade.id}
                    <br />
                    {result.startingTrade.time}
                  </p>
                  <p>Deadline: {result.deadline}</p>
                  <p>
                    Settlement trade #{result.settlementTrade!.id}
                    <br />
                    {result.settlementTrade!.time}
                  </p>
                </details>
              </>
            ) : (
              <>
                <div className="empty-icon">↗ ↘</div>
                <h3>Your first call awaits.</h3>
                <p>
                  Your latest result will appear here, with the prices behind
                  it.
                </p>
              </>
            )}
          </section>
        </aside>
      </div>
      <RoundHistory
        ready={!!state}
        latestId={state?.latestResult?.id}
        offline={offline}
      />
      <footer>
        <span>HOW IT WORKS</span>
        <p>
          Your direction and deadline are saved immediately. We verify the last
          trade at or before server acceptance as your starting price. After 60
          seconds, the first Coinbase BTC-USD trade at a different price decides
          your result. Equal price? We wait. Missing trades? We recover them
          before settling.
        </p>
        <span className="points-only">
          PLAY FOR POINTS.
          <br />
          FOLLOW THE MARKET.
        </span>
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
