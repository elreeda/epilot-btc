-- Existing v1 rounds retain their starting evidence and settlement rule.
-- New v2 rounds freeze intent/time first and obtain their start from verified history later.
ALTER TABLE guesses ALTER COLUMN start_trade_id DROP NOT NULL;
ALTER TABLE guesses ALTER COLUMN start_time_us DROP NOT NULL;
ALTER TABLE guesses ALTER COLUMN start_price DROP NOT NULL;
ALTER TABLE guesses ALTER COLUMN rule_version SET DEFAULT 'verified-acceptance-first-differing-v2';
ALTER TABLE guesses ADD CONSTRAINT complete_start_evidence CHECK (
  (start_trade_id IS NOT NULL AND start_time_us IS NOT NULL AND start_price IS NOT NULL)
  OR (start_trade_id IS NULL AND start_time_us IS NULL AND start_price IS NULL
      AND status='pending' AND rule_version='verified-acceptance-first-differing-v2')
);
ALTER TABLE guesses ADD CONSTRAINT acceptance_start_time CHECK (
  rule_version<>'verified-acceptance-first-differing-v2' OR start_time_us<=submitted_us
);
CREATE INDEX locking_guesses ON guesses(submitted_us) WHERE status='pending' AND start_trade_id IS NULL;
