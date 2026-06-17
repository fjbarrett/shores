-- fivenines storage schema (DigitalOcean self-hosted Postgres, db "fivenines").
-- Replaces the old Vercel Blob layout:
--   shores/history.jsonl        -> table history   (flat per-provider rows)
--   shores/latest.json          -> table snapshots (newest row)
--   shores/regions/<key>.json   -> derived on read from the last 90 snapshots
-- checked_at is stored as text so ISO-8601 lexical sort == chronological order,
-- matching the assumption the app/uploader already relied on.

CREATE TABLE IF NOT EXISTS snapshots (
  checked_at text PRIMARY KEY,         -- run id == ISO timestamp
  vantage    text,
  data       jsonb NOT NULL            -- full {checked_at, vantage, results:[...]} run object
);

CREATE TABLE IF NOT EXISTS history (
  checked_at text NOT NULL,            -- run id
  provider   text NOT NULL,            -- provider key
  row        jsonb NOT NULL,           -- the flat history Row
  PRIMARY KEY (checked_at, provider)
);

CREATE INDEX IF NOT EXISTS history_checked_at_idx ON history (checked_at);
