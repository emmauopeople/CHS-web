-- Opaque, short-lived pagination state; clinical content is never cached here.
CREATE TABLE patient_history_cursors (
  id uuid PRIMARY KEY,
  owner_key text NOT NULL CHECK (owner_key ~ '^[0-9a-f]{64}$'),
  query_key text NOT NULL CHECK (query_key ~ '^[0-9a-f]{64}$'),
  data_version text NOT NULL CHECK (data_version ~ '^[0-9a-f]{32}$'),
  after_time timestamptz NOT NULL,
  after_type text NOT NULL,
  after_id uuid NOT NULL,
  retrieved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > retrieved_at AND expires_at <= retrieved_at + interval '15 minutes'),
  UNIQUE (owner_key, query_key, data_version, after_time, after_type, after_id, retrieved_at)
);
CREATE INDEX ix_patient_history_cursors_expiry ON patient_history_cursors(expires_at);
