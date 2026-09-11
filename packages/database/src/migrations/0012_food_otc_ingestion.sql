-- Immutable, completed encounter snapshots. No raw clinical JSON is stored.
CREATE TABLE reported_intake_assessments (
  id uuid PRIMARY KEY,
  resource_type text NOT NULL CHECK (resource_type IN ('FOOD', 'OTC')),
  encounter_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  person_id uuid NOT NULL,
  local_encounter_id uuid NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision = 1),
  response text NULL CHECK (response IN ('REPORTED', 'NONE_REPORTED', 'UNKNOWN', 'DECLINED', 'PREFER_NOT_TO_ANSWER')),
  period_start date NULL,
  period_end date NULL,
  completed_at timestamptz NOT NULL,
  recorded_by_practitioner_id uuid NOT NULL REFERENCES practitioners(id),
  source_content_hash text NOT NULL CHECK (source_content_hash ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL,
  CONSTRAINT ck_reported_intake_response CHECK (resource_type = 'OTC' OR response IS DISTINCT FROM 'NONE_REPORTED'),
  CONSTRAINT ck_reported_intake_period CHECK ((period_start IS NULL AND period_end IS NULL) OR (period_start IS NOT NULL AND period_end IS NOT NULL AND period_start <= period_end)),
  CONSTRAINT fk_reported_intake_encounter FOREIGN KEY (encounter_id, installation_id, person_id)
    REFERENCES screening_encounters(id, installation_id, person_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT uq_reported_intake_source UNIQUE (installation_id, resource_type, local_encounter_id),
  CONSTRAINT uq_reported_intake_encounter UNIQUE (encounter_id, resource_type),
  CONSTRAINT uq_reported_intake_type UNIQUE (id, resource_type)
);
CREATE TABLE reported_food_rows (
  assessment_id uuid NOT NULL,
  resource_type text NOT NULL DEFAULT 'FOOD' CHECK (resource_type = 'FOOD'),
  local_row_id uuid NOT NULL,
  sequence_number integer NOT NULL CHECK (sequence_number BETWEEN 1 AND 100),
  food_code text NULL CHECK (food_code IS NULL OR (length(food_code) BETWEEN 1 AND 100 AND btrim(food_code) <> '')),
  food_name text NOT NULL CHECK (length(food_name) BETWEEN 1 AND 100 AND btrim(food_name) <> ''),
  frequency_code text NULL CHECK (frequency_code IN ('1_DAY', '2_TO_3_DAYS', '4_TO_6_DAYS', 'EVERY_DAY')),
  preparation_note text NULL CHECK (preparation_note IS NULL OR (length(preparation_note) BETWEEN 1 AND 200 AND btrim(preparation_note) <> '')),
  source_type text NOT NULL CHECK (source_type = 'PATIENT_REPORTED'),
  recorded_by_practitioner_id uuid NOT NULL REFERENCES practitioners(id),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (assessment_id, local_row_id),
  UNIQUE (assessment_id, sequence_number),
  FOREIGN KEY (assessment_id, resource_type) REFERENCES reported_intake_assessments(id, resource_type)
);
CREATE TABLE reported_otc_rows (
  assessment_id uuid NOT NULL,
  resource_type text NOT NULL DEFAULT 'OTC' CHECK (resource_type = 'OTC'),
  local_row_id uuid NOT NULL,
  sequence_number integer NOT NULL CHECK (sequence_number BETWEEN 1 AND 100),
  product_name text NOT NULL CHECK (length(product_name) BETWEEN 1 AND 160 AND btrim(product_name) <> ''),
  reason_for_use text NOT NULL CHECK (length(reason_for_use) BETWEEN 1 AND 500 AND btrim(reason_for_use) <> ''),
  dose_text text NULL CHECK (dose_text IS NULL OR (length(dose_text) BETWEEN 1 AND 160 AND btrim(dose_text) <> '')),
  frequency_text text NULL CHECK (frequency_text IS NULL OR (length(frequency_text) BETWEEN 1 AND 160 AND btrim(frequency_text) <> '')),
  duration_text text NULL CHECK (duration_text IS NULL OR (length(duration_text) BETWEEN 1 AND 160 AND btrim(duration_text) <> '')),
  source_of_medication text NULL CHECK (source_of_medication IS NULL OR (length(source_of_medication) BETWEEN 1 AND 160 AND btrim(source_of_medication) <> '')),
  currently_taking boolean NULL,
  source_type text NOT NULL CHECK (source_type = 'PATIENT_REPORTED'),
  recorded_by_practitioner_id uuid NOT NULL REFERENCES practitioners(id),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (assessment_id, local_row_id),
  UNIQUE (assessment_id, sequence_number),
  FOREIGN KEY (assessment_id, resource_type) REFERENCES reported_intake_assessments(id, resource_type)
);
CREATE INDEX ix_reported_intake_person_time ON reported_intake_assessments(person_id, completed_at DESC, id);

CREATE FUNCTION reject_reported_intake_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Finalized reported intake is immutable';
END;
$$;
CREATE TRIGGER tr_reported_intake_assessments_immutable BEFORE UPDATE OR DELETE ON reported_intake_assessments
FOR EACH ROW EXECUTE FUNCTION reject_reported_intake_mutation();
CREATE TRIGGER tr_reported_food_rows_immutable BEFORE UPDATE OR DELETE ON reported_food_rows
FOR EACH ROW EXECUTE FUNCTION reject_reported_intake_mutation();
CREATE TRIGGER tr_reported_otc_rows_immutable BEFORE UPDATE OR DELETE ON reported_otc_rows
FOR EACH ROW EXECUTE FUNCTION reject_reported_intake_mutation();

ALTER TABLE sync_records ADD COLUMN reported_intake_assessment_id uuid NULL;
ALTER TABLE sync_records ADD CONSTRAINT fk_sync_records_reported_intake
  FOREIGN KEY (reported_intake_assessment_id, resource_type)
  REFERENCES reported_intake_assessments(id, resource_type);
ALTER TABLE sync_records DROP CONSTRAINT ck_sync_records_resource_type;
ALTER TABLE sync_records ADD CONSTRAINT ck_sync_records_resource_type CHECK (
  resource_type IN ('PATIENT','SCREENING_SESSION','SCREENING_ENCOUNTER','VITALS','LIFESTYLE','FOOD','OTC')
);
ALTER TABLE sync_records DROP CONSTRAINT ck_sync_records_target_type;
ALTER TABLE sync_records ADD CONSTRAINT ck_sync_records_target_type CHECK (
  (status IN ('PROCESSING','REJECTED','RETRY') AND num_nonnulls(person_id, screening_session_id, screening_encounter_id, screening_vital_set_id, lifestyle_assessment_id, identity_review_case_id, reported_intake_assessment_id) = 0)
  OR (status = 'REVIEW_REQUIRED' AND resource_type = 'PATIENT' AND identity_review_case_id IS NOT NULL AND num_nonnulls(person_id, screening_session_id, screening_encounter_id, screening_vital_set_id, lifestyle_assessment_id, reported_intake_assessment_id) = 0)
  OR (status IN ('ACCEPTED','UNCHANGED') AND identity_review_case_id IS NULL
      AND num_nonnulls(person_id, screening_session_id, screening_encounter_id, screening_vital_set_id, lifestyle_assessment_id, reported_intake_assessment_id) = 1
      AND CASE resource_type
        WHEN 'PATIENT' THEN person_id IS NOT NULL
        WHEN 'SCREENING_SESSION' THEN screening_session_id IS NOT NULL
        WHEN 'SCREENING_ENCOUNTER' THEN screening_encounter_id IS NOT NULL
        WHEN 'VITALS' THEN screening_vital_set_id IS NOT NULL
        WHEN 'LIFESTYLE' THEN lifestyle_assessment_id IS NOT NULL
        WHEN 'FOOD' THEN reported_intake_assessment_id IS NOT NULL
        WHEN 'OTC' THEN reported_intake_assessment_id IS NOT NULL
        ELSE false END)
);
