import { useState } from "react";
import type { GameState } from "../../server/src/contracts.js";

type Point = { time: string; price: string };

const formatPrice = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    value,
  );

export function PriceChart({
  history,
  serverTime,
  status,
}: {
  history: Point[];
  serverTime: string;
  status: GameState["market"]["status"];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const end = Date.parse(serverTime);
  const start = end - 600_000;
  const points = history.filter(
    (p) => Number.isFinite(Number(p.price)) && Date.parse(p.time) >= start,
  );
  const first = points[0];
  const last = points.at(-1);
  const change = first && last ? Number(last.price) - Number(first.price) : 0;
  const percent = first ? (change / Number(first.price)) * 100 : 0;
  const values = points.map((p) => Number(p.price));
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 0;
  const padding = Math.max((high - low) * 0.15, high * 0.00002, 0.01);

  const x = (point: Point) =>
    8 + ((Date.parse(point.time) - start) / 600_000) * 704;

  const y = (point: Point) =>
    166 -
    ((Number(point.price) - low + padding) / (high - low + padding * 2)) * 150;

  const path = points
    .map((p, i) => `${i ? "L" : "M"} ${x(p).toFixed(2)} ${y(p).toFixed(2)}`)
    .join(" ");
  const selected =
    hover === null ? undefined : points[Math.min(hover, points.length - 1)];
  const sign = change > 0 ? "+" : change < 0 ? "−" : "";
  const trend = change < 0 ? "falling" : "rising";

  return (
    <section
      className={`market-chart ${trend}`}
      aria-label="Bitcoin price history"
    >
      <div className="chart-summary">
        {selected ? (
          <>
            <strong>{formatPrice(Number(selected.price))}</strong>
            <span>{new Date(selected.time).toLocaleTimeString()}</span>
          </>
        ) : points.length > 1 ? (
          <>
            <strong>
              {sign}
              {formatPrice(Math.abs(change))}{" "}
              <span>
                ({sign}
                {Math.abs(percent).toFixed(2)}%)
              </span>
            </strong>
            <span>past 10 minutes</span>
          </>
        ) : (
          <span>Building price history</span>
        )}
      </div>
      <div className="chart-canvas">
        {points.length > 1 ? (
          <svg
            viewBox="0 0 720 190"
            preserveAspectRatio="none"
            role="img"
            aria-label={`Bitcoin price over the last ten minutes, ${change < 0 ? "down" : "up"} ${formatPrice(Math.abs(change))}`}
            onPointerLeave={() => setHover(null)}
            onPointerMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              const target =
                start +
                Math.max(
                  0,
                  Math.min(1, (event.clientX - box.left) / box.width),
                ) *
                  600_000;
              let nearest = 0;

              points.forEach((p, i) => {
                if (
                  Math.abs(Date.parse(p.time) - target) <
                  Math.abs(Date.parse(points[nearest].time) - target)
                )
                  nearest = i;
              });
              setHover(nearest);
            }}
          >
            <path
              className="chart-line"
              d={path}
              vectorEffect="non-scaling-stroke"
            />
            {last && (
              <circle cx={x(last)} cy={y(last)} r="3.5" className="chart-end" />
            )}
            {selected && (
              <>
                <line
                  x1={x(selected)}
                  x2={x(selected)}
                  y1="8"
                  y2="180"
                  className="chart-cursor"
                  vectorEffect="non-scaling-stroke"
                />
                <circle
                  cx={x(selected)}
                  cy={y(selected)}
                  r="4"
                  className="chart-point"
                />
              </>
            )}
          </svg>
        ) : (
          <div className="chart-empty">
            A few verified trades will bring this chart to life.
          </div>
        )}
      </div>
      <div className="chart-caption">
        <span className="chart-period">10 MIN</span>
        <span>{status === "live" ? "LIVE" : "LAST VERIFIED PRICES"}</span>
      </div>
    </section>
  );
}
