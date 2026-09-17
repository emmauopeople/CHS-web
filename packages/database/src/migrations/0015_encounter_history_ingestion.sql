-- Immutable encounter annotations and review lifecycle events, owned by the source installation.
CREATE TABLE encounter_history_resources (
 id uuid PRIMARY KEY,
 installation_id uuid NOT NULL REFERENCES desktop_installations(id),
 resource_type text NOT NULL CHECK (resource_type IN ('ENCOUNTER_ADDENDUM','ENCOUNTER_REVIEW_FLAG','ENCOUNTER_REVIEW_STATUS')),
 local_resource_id uuid NOT NULL,
 source_revision integer NOT NULL CHECK (source_revision = 1),
 source_content_hash text NOT NULL CHECK (source_content_hash ~ '^[0-9a-f]{64}$'),
 received_at timestamptz NOT NULL,
 UNIQUE (installation_id, resource_type, local_resource_id),
 UNIQUE (id, resource_type),
 UNIQUE (id, installation_id)
);
CREATE TABLE encounter_addenda (
 id uuid PRIMARY KEY,
 installation_id uuid NOT NULL,
 resource_type text NOT NULL DEFAULT 'ENCOUNTER_ADDENDUM' CHECK (resource_type = 'ENCOUNTER_ADDENDUM'),
 encounter_id uuid NOT NULL,
 person_id uuid NOT NULL,
 note_text text NOT NULL CHECK (length(btrim(note_text)) BETWEEN 1 AND 2000),
 created_by_practitioner_id uuid NOT NULL REFERENCES practitioners(id),
 created_at timestamptz NOT NULL,
 FOREIGN KEY (id, installation_id) REFERENCES encounter_history_resources(id, installation_id),
 FOREIGN KEY (id, resource_type) REFERENCES encounter_history_resources(id, resource_type),
 FOREIGN KEY (encounter_id, installation_id, person_id) REFERENCES screening_encounters(id, installation_id, person_id)
);
CREATE INDEX ix_encounter_addenda_encounter ON encounter_addenda(encounter_id, created_at, id);
CREATE TABLE encounter_review_flags (
 id uuid PRIMARY KEY,
 installation_id uuid NOT NULL,
 resource_type text NOT NULL DEFAULT 'ENCOUNTER_REVIEW_FLAG' CHECK (resource_type = 'ENCOUNTER_REVIEW_FLAG'),
 encounter_id uuid NOT NULL,
 person_id uuid NOT NULL,
 category text NOT NULL CHECK (category IN ('POSSIBLE_DATA_ERROR','MISSING_INFORMATION','WRONG_PATIENT','DUPLICATE_ENCOUNTER','OTHER')),
 description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 1000),
 opened_by_practitioner_id uuid NOT NULL REFERENCES practitioners(id),
 opened_at timestamptz NOT NULL,
 UNIQUE (id, installation_id),
 FOREIGN KEY (id, installation_id) REFERENCES encounter_history_resources(id, installation_id),
 FOREIGN KEY (id, resource_type) REFERENCES encounter_history_resources(id, resource_type),
 FOREIGN KEY (encounter_id, installation_id, person_id) REFERENCES screening_encounters(id, installation_id, person_id)
);
CREATE INDEX ix_encounter_review_flags_encounter ON encounter_review_flags(encounter_id, opened_at, id);
CREATE TABLE encounter_review_status_events (
 id uuid PRIMARY KEY,
 installation_id uuid NOT NULL,
 resource_type text NOT NULL DEFAULT 'ENCOUNTER_REVIEW_STATUS' CHECK (resource_type = 'ENCOUNTER_REVIEW_STATUS'),
 flag_id uuid NOT NULL,
 sequence_number integer NOT NULL CHECK (sequence_number >= 1),
 from_status text NULL CHECK (from_status IN ('OPEN','RESOLVED','DISMISSED')),
 to_status text NOT NULL CHECK (to_status IN ('OPEN','RESOLVED','DISMISSED')),
 change_reason text NULL CHECK (length(btrim(change_reason)) BETWEEN 1 AND 1000),
 changed_by_practitioner_id uuid NOT NULL REFERENCES practitioners(id),
 changed_at timestamptz NOT NULL,
 FOREIGN KEY (id, installation_id) REFERENCES encounter_history_resources(id, installation_id),
 FOREIGN KEY (id, resource_type) REFERENCES encounter_history_resources(id, resource_type),
 FOREIGN KEY (flag_id, installation_id) REFERENCES encounter_review_flags(id, installation_id),
 UNIQUE (flag_id, sequence_number),
 CHECK ((sequence_number = 1 AND from_status IS NULL AND to_status = 'OPEN' AND change_reason IS NULL)
   OR (sequence_number > 1 AND from_status IS NOT NULL AND change_reason IS NOT NULL AND
       ((from_status = 'OPEN' AND to_status IN ('RESOLVED','DISMISSED')) OR
        (from_status IN ('RESOLVED','DISMISSED') AND to_status = 'OPEN'))))
);
CREATE FUNCTION reject_encounter_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Encounter history is immutable';
END;
$$;
CREATE TRIGGER tr_encounter_history_resources_immutable BEFORE UPDATE OR DELETE ON encounter_history_resources
FOR EACH ROW EXECUTE FUNCTION reject_encounter_history_mutation();
CREATE TRIGGER tr_encounter_addenda_immutable BEFORE UPDATE OR DELETE ON encounter_addenda
FOR EACH ROW EXECUTE FUNCTION reject_encounter_history_mutation();
CREATE TRIGGER tr_encounter_review_flags_immutable BEFORE UPDATE OR DELETE ON encounter_review_flags
FOR EACH ROW EXECUTE FUNCTION reject_encounter_history_mutation();
CREATE TRIGGER tr_encounter_review_status_events_immutable BEFORE UPDATE OR DELETE ON encounter_review_status_events
FOR EACH ROW EXECUTE FUNCTION reject_encounter_history_mutation();
ALTER TABLE sync_records ADD COLUMN encounter_history_resource_id uuid NULL;
ALTER TABLE sync_records ADD CONSTRAINT fk_sync_records_encounter_history_resource FOREIGN KEY (encounter_history_resource_id, resource_type) REFERENCES encounter_history_resources(id, resource_type);
ALTER TABLE sync_records ADD CONSTRAINT fk_sync_records_encounter_history_installation FOREIGN KEY (encounter_history_resource_id, installation_id) REFERENCES encounter_history_resources(id, installation_id);
ALTER TABLE sync_records DROP CONSTRAINT ck_sync_records_resource_type;
ALTER TABLE sync_records ADD CONSTRAINT ck_sync_records_resource_type CHECK (
  resource_type IN ('PATIENT','SCREENING_SESSION','SCREENING_ENCOUNTER','VITALS','LIFESTYLE','FOOD','OTC','REFERRAL','REFERRAL_STATUS','REFERRAL_FOLLOWUP','ENCOUNTER_ADDENDUM','ENCOUNTER_REVIEW_FLAG','ENCOUNTER_REVIEW_STATUS')
);
ALTER TABLE sync_records DROP CONSTRAINT ck_sync_records_target_type;
ALTER TABLE sync_records ADD CONSTRAINT ck_sync_records_target_type CHECK (
  (status IN ('PROCESSING','REJECTED','RETRY') AND num_nonnulls(person_id, screening_session_id, screening_encounter_id, screening_vital_set_id, lifestyle_assessment_id, identity_review_case_id, reported_intake_assessment_id, referral_resource_id, encounter_history_resource_id) = 0)
  OR (status = 'REVIEW_REQUIRED' AND resource_type = 'PATIENT' AND identity_review_case_id IS NOT NULL AND num_nonnulls(person_id, screening_session_id, screening_encounter_id, screening_vital_set_id, lifestyle_assessment_id, reported_intake_assessment_id, referral_resource_id, encounter_history_resource_id) = 0)
  OR (status IN ('ACCEPTED','UNCHANGED') AND identity_review_case_id IS NULL
      AND num_nonnulls(person_id, screening_session_id, screening_encounter_id, screening_vital_set_id, lifestyle_assessment_id, reported_intake_assessment_id, referral_resource_id, encounter_history_resource_id) = 1
      AND CASE resource_type
        WHEN 'PATIENT' THEN person_id IS NOT NULL
        WHEN 'SCREENING_SESSION' THEN screening_session_id IS NOT NULL
        WHEN 'SCREENING_ENCOUNTER' THEN screening_encounter_id IS NOT NULL
        WHEN 'VITALS' THEN screening_vital_set_id IS NOT NULL
        WHEN 'LIFESTYLE' THEN lifestyle_assessment_id IS NOT NULL
        WHEN 'FOOD' THEN reported_intake_assessment_id IS NOT NULL
        WHEN 'OTC' THEN reported_intake_assessment_id IS NOT NULL
        WHEN 'REFERRAL' THEN referral_resource_id IS NOT NULL
        WHEN 'REFERRAL_STATUS' THEN referral_resource_id IS NOT NULL
        WHEN 'REFERRAL_FOLLOWUP' THEN referral_resource_id IS NOT NULL
        WHEN 'ENCOUNTER_ADDENDUM' THEN encounter_history_resource_id IS NOT NULL
        WHEN 'ENCOUNTER_REVIEW_FLAG' THEN encounter_history_resource_id IS NOT NULL
        WHEN 'ENCOUNTER_REVIEW_STATUS' THEN encounter_history_resource_id IS NOT NULL
        ELSE false END)
);
