CREATE TABLE identity_resolution_deliveries (
  resolution_id uuid PRIMARY KEY,
  installation_id uuid NOT NULL,
  local_patient_id uuid NOT NULL,
  local_patient_code text NOT NULL,
  source_revision integer NOT NULL,
  central_person_id uuid NOT NULL,
  chs_medical_id text NOT NULL,
  resolved_at timestamptz NOT NULL,
  delivery_status text NOT NULL,
  acknowledgment_id uuid NULL,
  desktop_applied_at timestamptz NULL,
  acknowledged_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_identity_resolution_deliveries_resolution
    FOREIGN KEY (resolution_id) REFERENCES identity_review_resolutions (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_identity_resolution_deliveries_installation
    FOREIGN KEY (installation_id) REFERENCES desktop_installations (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_identity_resolution_deliveries_person
    FOREIGN KEY (central_person_id) REFERENCES persons (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_identity_resolution_deliveries_local_code CHECK (
    local_patient_code ~ '^PT-[0-9]{6}$'
  ),
  CONSTRAINT ck_identity_resolution_deliveries_revision CHECK (
    source_revision >= 1
  ),
  CONSTRAINT ck_identity_resolution_deliveries_medical_id CHECK (
    length(btrim(chs_medical_id)) BETWEEN 8 AND 64
  ),
  CONSTRAINT ck_identity_resolution_deliveries_status CHECK (
    delivery_status IN ('PENDING', 'ACKNOWLEDGED')
  ),
  CONSTRAINT ck_identity_resolution_deliveries_acknowledgment CHECK (
    (
      delivery_status = 'PENDING'
      AND acknowledgment_id IS NULL
      AND desktop_applied_at IS NULL
      AND acknowledged_at IS NULL
    )
    OR
    (
      delivery_status = 'ACKNOWLEDGED'
      AND acknowledgment_id IS NOT NULL
      AND desktop_applied_at IS NOT NULL
      AND acknowledged_at IS NOT NULL
      AND acknowledged_at >= resolved_at
    )
  ),
  CONSTRAINT ck_identity_resolution_deliveries_created CHECK (
    created_at = resolved_at AND updated_at >= created_at
  ),
  CONSTRAINT uq_identity_resolution_deliveries_local_patient
    UNIQUE (installation_id, local_patient_id),
  CONSTRAINT uq_identity_resolution_deliveries_acknowledgment
    UNIQUE (acknowledgment_id)
);

CREATE INDEX ix_identity_resolution_deliveries_pending
  ON identity_resolution_deliveries (
    installation_id, resolved_at ASC, resolution_id ASC
  )
  WHERE delivery_status = 'PENDING';

INSERT INTO identity_resolution_deliveries (
  resolution_id,
  installation_id,
  local_patient_id,
  local_patient_code,
  source_revision,
  central_person_id,
  chs_medical_id,
  resolved_at,
  delivery_status,
  created_at,
  updated_at
)
SELECT
  resolution.id,
  review_case.installation_id,
  review_case.local_patient_id,
  source_link.local_patient_code,
  source_link.last_source_revision,
  resolution.resolved_person_id,
  resolution.resolved_chs_medical_id,
  resolution.resolved_at,
  'PENDING',
  resolution.resolved_at,
  resolution.resolved_at
FROM identity_review_resolutions AS resolution
JOIN identity_review_cases AS review_case
  ON review_case.id = resolution.review_case_id
JOIN patient_source_links AS source_link
  ON source_link.installation_id = review_case.installation_id
 AND source_link.local_patient_id = review_case.local_patient_id
 AND source_link.person_id = resolution.resolved_person_id
ON CONFLICT (resolution_id) DO NOTHING;
