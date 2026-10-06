CREATE TABLE IF NOT EXISTS trades (
  product text NOT NULL CHECK (product = 'BTC-USD'),
  trade_id bigint NOT NULL,
  time_us bigint NOT NULL,
  price numeric NOT NULL CHECK (price > 0),
  PRIMARY KEY (product, trade_id)
);
CREATE INDEX IF NOT EXISTS trades_time ON trades (product, time_us, trade_id);
CREATE TABLE IF NOT EXISTS market (
  product text PRIMARY KEY,
  checkpoint_id bigint,
  coverage_us bigint,
  latest_trade_id bigint,
  heartbeat_at timestamptz,
  verified_at timestamptz,
  status text NOT NULL DEFAULT 'recovering' CHECK (status IN ('live', 'recovering', 'error')),
  error text
);
INSERT INTO market(product) VALUES ('BTC-USD') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS players (
  id uuid PRIMARY KEY,
  token_hash text UNIQUE NOT NULL,
  score integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guesses (
  id uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES players(id),
  idempotency_key uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('up','down')),
  submitted_us bigint NOT NULL,
  deadline_us bigint NOT NULL CHECK (deadline_us = submitted_us + 60000000),
  start_trade_id bigint NOT NULL,
  start_time_us bigint NOT NULL,
  start_price numeric NOT NULL,
  rule_version text NOT NULL DEFAULT 'first-differing-trade-v1',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved')),
  settlement_trade_id bigint,
  settlement_time_us bigint,
  settlement_price numeric,
  score_delta integer CHECK (score_delta IN (-1,1)),
  resolved_at timestamptz,
  UNIQUE(player_id, idempotency_key),
  CHECK ((status = 'pending' AND settlement_trade_id IS NULL AND score_delta IS NULL)
      OR (status = 'resolved' AND settlement_trade_id IS NOT NULL AND settlement_time_us IS NOT NULL AND settlement_price IS NOT NULL AND score_delta IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_guess ON guesses(player_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS pending_deadlines ON guesses(deadline_us) WHERE status='pending';
CREATE INDEX IF NOT EXISTS player_history ON guesses(player_id, submitted_us DESC);
