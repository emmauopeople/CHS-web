ALTER TABLE identity_review_evidence_snapshots
  ADD COLUMN acknowledgment_status text NULL,
  ADD COLUMN patient_status text NULL,
  ADD CONSTRAINT ck_identity_review_evidence_acknowledgment CHECK (
    acknowledgment_status IS NULL
    OR acknowledgment_status IN ('ACKNOWLEDGED', 'DECLINED', 'NOT_REQUESTED')
  ),
  ADD CONSTRAINT ck_identity_review_evidence_patient_status CHECK (
    patient_status IS NULL OR patient_status IN ('ACTIVE', 'INACTIVE')
  ),
  ADD CONSTRAINT ck_identity_review_evidence_resolution_fields CHECK (
    (acknowledgment_status IS NULL AND patient_status IS NULL)
    OR
    (acknowledgment_status IS NOT NULL AND patient_status IS NOT NULL)
  );

ALTER TABLE operations_access_grants
  DROP CONSTRAINT ck_operations_access_grants_permission;

ALTER TABLE operations_access_grants
  ADD CONSTRAINT ck_operations_access_grants_permission CHECK (
    permission_code IN (
      'PATIENT_READ',
      'MEDICAL_ID_RECOVER',
      'SYNC_MONITOR',
      'IDENTITY_REVIEW',
      'IDENTITY_REVIEW_RESOLVE',
      'AUDIT_READ'
    )
  );

CREATE TABLE identity_review_resolutions (
  id uuid PRIMARY KEY,
  review_case_id uuid NOT NULL,
  request_hash text NOT NULL,
  action_code text NOT NULL,
  selected_candidate_person_id uuid NULL,
  resolved_person_id uuid NOT NULL,
  resolved_chs_medical_id text NOT NULL,
  operations_user_id uuid NOT NULL,
  expected_case_updated_at timestamptz NOT NULL,
  resolution_note text NOT NULL,
  resolved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT fk_identity_review_resolutions_case FOREIGN KEY (review_case_id)
    REFERENCES identity_review_cases (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_identity_review_resolutions_selected_person
    FOREIGN KEY (selected_candidate_person_id)
    REFERENCES persons (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_identity_review_resolutions_resolved_person
    FOREIGN KEY (resolved_person_id)
    REFERENCES persons (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_identity_review_resolutions_operations_user
    FOREIGN KEY (operations_user_id)
    REFERENCES operations_users (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_identity_review_resolutions_hash CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ck_identity_review_resolutions_action CHECK (
    action_code IN ('LINK_EXISTING', 'CREATE_NEW')
  ),
  CONSTRAINT ck_identity_review_resolutions_target CHECK (
    (action_code = 'LINK_EXISTING'
      AND selected_candidate_person_id = resolved_person_id)
    OR
    (action_code = 'CREATE_NEW'
      AND selected_candidate_person_id IS NULL)
  ),
  CONSTRAINT ck_identity_review_resolutions_medical_id CHECK (
    length(btrim(resolved_chs_medical_id)) BETWEEN 8 AND 64
  ),
  CONSTRAINT ck_identity_review_resolutions_note CHECK (
    length(btrim(resolution_note)) BETWEEN 10 AND 1000
  ),
  CONSTRAINT ck_identity_review_resolutions_time CHECK (
    created_at = resolved_at
  ),
  CONSTRAINT uq_identity_review_resolutions_case UNIQUE (review_case_id)
);

CREATE INDEX ix_identity_review_resolutions_operator_time
  ON identity_review_resolutions (operations_user_id, resolved_at DESC);
