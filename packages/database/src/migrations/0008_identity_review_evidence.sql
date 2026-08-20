CREATE TABLE identity_review_evidence_snapshots (
  id uuid PRIMARY KEY,
  review_case_id uuid NOT NULL,
  source_record_id uuid NOT NULL,
  source_revision integer NOT NULL,
  schema_version text NOT NULL,
  captured_at timestamptz NOT NULL,
  payload_hash text NOT NULL,
  local_patient_code text NOT NULL,
  claimed_chs_medical_id text NULL,
  display_name text NOT NULL,
  name_normalized text NOT NULL,
  given_name text NULL,
  family_name text NULL,
  other_names text NULL,
  date_of_birth date NULL,
  approximate_age_years smallint NULL,
  age_as_of_date date NULL,
  sex text NOT NULL,
  phone text NULL,
  phone_normalized text NULL,
  village text NULL,
  quarter text NULL,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  CONSTRAINT fk_identity_review_evidence_case FOREIGN KEY (review_case_id)
    REFERENCES identity_review_cases (id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_identity_review_evidence_revision CHECK (source_revision >= 1),
  CONSTRAINT ck_identity_review_evidence_schema CHECK (btrim(schema_version) <> ''),
  CONSTRAINT ck_identity_review_evidence_hash CHECK (
    payload_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ck_identity_review_evidence_local_code CHECK (
    local_patient_code ~ '^PT-[0-9]{6}$'
  ),
  CONSTRAINT ck_identity_review_evidence_claimed_id CHECK (
    claimed_chs_medical_id IS NULL
    OR length(btrim(claimed_chs_medical_id)) BETWEEN 8 AND 64
  ),
  CONSTRAINT ck_identity_review_evidence_display_name CHECK (
    btrim(display_name) <> ''
  ),
  CONSTRAINT ck_identity_review_evidence_normalized_name CHECK (
    btrim(name_normalized) <> ''
  ),
  CONSTRAINT ck_identity_review_evidence_birth_or_age CHECK (
    (date_of_birth IS NOT NULL
      AND approximate_age_years IS NULL
      AND age_as_of_date IS NULL)
    OR
    (date_of_birth IS NULL
      AND approximate_age_years BETWEEN 0 AND 120
      AND age_as_of_date IS NOT NULL)
  ),
  CONSTRAINT ck_identity_review_evidence_sex CHECK (
    sex IN ('FEMALE', 'MALE', 'OTHER', 'UNKNOWN')
  ),
  CONSTRAINT ck_identity_review_evidence_source_time CHECK (
    source_updated_at >= source_created_at
  ),
  CONSTRAINT uq_identity_review_evidence_revision UNIQUE (
    review_case_id,
    source_revision
  ),
  CONSTRAINT uq_identity_review_evidence_record UNIQUE (
    review_case_id,
    source_record_id
  )
);

CREATE INDEX ix_identity_review_evidence_latest
  ON identity_review_evidence_snapshots (
    review_case_id,
    source_revision DESC,
    received_at DESC
  );
