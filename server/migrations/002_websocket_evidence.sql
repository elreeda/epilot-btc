-- REST timestamp is canonical for settlement; preserve the observed WS timestamp separately.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ws_time_us bigint;
