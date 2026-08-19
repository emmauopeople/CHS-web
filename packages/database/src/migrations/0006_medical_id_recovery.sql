CREATE TABLE medical_id_recovery_cases (
  id uuid PRIMARY KEY,
  operations_user_id uuid NOT NULL,
  status text NOT NULL,
  token_hash text NULL,
  session_fingerprint text NOT NULL,
  candidate_count integer NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revealed_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_medical_id_recovery_cases_user FOREIGN KEY (operations_user_id)
    REFERENCES operations_users (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_medical_id_recovery_cases_status CHECK (
    status IN ('PENDING_CONFIRMATION', 'REVEALED', 'REVIEW_REQUIRED')
  ),
  CONSTRAINT ck_medical_id_recovery_cases_token_hash CHECK (
    token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ck_medical_id_recovery_cases_session CHECK (
    session_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ck_medical_id_recovery_cases_candidate_count CHECK (
    candidate_count BETWEEN 1 AND 1000
  ),
  CONSTRAINT ck_medical_id_recovery_cases_period CHECK (
    expires_at > created_at AND updated_at >= created_at
  ),
  CONSTRAINT ck_medical_id_recovery_cases_state CHECK (
    (
      status = 'PENDING_CONFIRMATION'
      AND token_hash IS NOT NULL
      AND candidate_count = 1
      AND revealed_at IS NULL
    )
    OR
    (
      status = 'REVEALED'
      AND token_hash IS NOT NULL
      AND candidate_count = 1
      AND revealed_at IS NOT NULL
      AND revealed_at >= created_at
    )
    OR
    (
      status = 'REVIEW_REQUIRED'
      AND token_hash IS NULL
      AND candidate_count >= 2
      AND revealed_at IS NULL
    )
  ),
  CONSTRAINT uq_medical_id_recovery_cases_token_hash UNIQUE (token_hash)
);

CREATE TABLE medical_id_recovery_candidates (
  id uuid PRIMARY KEY,
  recovery_case_id uuid NOT NULL,
  person_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT fk_medical_id_recovery_candidates_case
    FOREIGN KEY (recovery_case_id)
    REFERENCES medical_id_recovery_cases (id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_medical_id_recovery_candidates_person FOREIGN KEY (person_id)
    REFERENCES persons (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT uq_medical_id_recovery_candidates_person
    UNIQUE (recovery_case_id, person_id)
);

ALTER TABLE audit_events DROP CONSTRAINT ck_audit_events_outcome;
ALTER TABLE audit_events ADD CONSTRAINT ck_audit_events_outcome CHECK (
  outcome_code IN (
    'SUCCESS',
    'DENIED',
    'NOT_FOUND',
    'REVIEW_REQUIRED',
    'ERROR',
    'UNKNOWN'
  )
);

CREATE INDEX ix_medical_id_recovery_cases_user_time
  ON medical_id_recovery_cases (operations_user_id, created_at DESC);
CREATE INDEX ix_medical_id_recovery_cases_expiry
  ON medical_id_recovery_cases (expires_at)
  WHERE status = 'PENDING_CONFIRMATION';
CREATE INDEX ix_medical_id_recovery_candidates_person
  ON medical_id_recovery_candidates (person_id, created_at DESC);
