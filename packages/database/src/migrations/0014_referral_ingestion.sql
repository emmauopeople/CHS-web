-- Source-owned referral snapshots and separately delivered immutable histories.
CREATE TABLE referral_resources (
 id uuid PRIMARY KEY,
 installation_id uuid NOT NULL REFERENCES desktop_installations(id),
 resource_type text NOT NULL CHECK (resource_type IN ('REFERRAL','REFERRAL_STATUS','REFERRAL_FOLLOWUP')),
 local_resource_id uuid NOT NULL,
 source_revision integer NOT NULL CHECK (source_revision >= 1),
 source_content_hash text NOT NULL CHECK (source_content_hash ~ '^[0-9a-f]{64}$'),
 received_at timestamptz NOT NULL,
 UNIQUE (installation_id, resource_type, local_resource_id),
 UNIQUE (id, resource_type),
 UNIQUE (id, installation_id),
 CHECK (resource_type = 'REFERRAL' OR source_revision = 1)
);
CREATE TABLE referral_snapshots (
 id uuid PRIMARY KEY,
 installation_id uuid NOT NULL,
 encounter_id uuid NOT NULL,
 person_id uuid NOT NULL,
 created_by_practitioner_id uuid NOT NULL REFERENCES practitioners(id),
 updated_by_practitioner_id uuid NOT NULL REFERENCES practitioners(id),
 closed_by_practitioner_id uuid NULL REFERENCES practitioners(id),
 reason_codes text[] NOT NULL CHECK (cardinality(reason_codes) BETWEEN 1 AND 20),
 reason_text text NULL,
 urgency text NOT NULL CHECK (urgency IN ('STANDARD','URGENT')),
 destination_name text NULL,
 due_date date NULL,
 status text NOT NULL CHECK (status IN ('OPEN','CONTACTED','SEEN','UNABLE_TO_CONFIRM','CLOSED')),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 closed_at timestamptz NULL,
 closure_reason text NULL,
 UNIQUE (id, installation_id),
 FOREIGN KEY (id, installation_id) REFERENCES referral_resources(id, installation_id),
 FOREIGN KEY (encounter_id, installation_id, person_id) REFERENCES screening_encounters(id, installation_id, person_id),
 CHECK (updated_at >= created_at),
 CHECK ((status = 'CLOSED' AND closed_at = updated_at AND closed_by_practitioner_id = updated_by_practitioner_id AND closed_at IS NOT NULL AND closed_by_practitioner_id IS NOT NULL AND closure_reason IS NOT NULL)
 OR (status <> 'CLOSED' AND closed_at IS NULL AND closed_by_practitioner_id IS NULL AND closure_reason IS NULL))
);
CREATE INDEX ix_referral_snapshots_person ON referral_snapshots(person_id, created_at DESC, id);
CREATE TABLE referral_status_events (
 id uuid PRIMARY KEY,
 installation_id uuid NOT NULL,
 referral_id uuid NOT NULL,
 sequence_number integer NOT NULL CHECK (sequence_number >= 1),
 from_status text NULL CHECK (from_status IN ('OPEN','CONTACTED','SEEN','UNABLE_TO_CONFIRM','CLOSED')),
 to_status text NOT NULL CHECK (to_status IN ('OPEN','CONTACTED','SEEN','UNABLE_TO_CONFIRM','CLOSED')),
 change_reason text NULL,
 changed_by_practitioner_id uuid NOT NULL REFERENCES practitioners(id),
 changed_at timestamptz NOT NULL,
 FOREIGN KEY (id, installation_id) REFERENCES referral_resources(id, installation_id),
 FOREIGN KEY (referral_id, installation_id) REFERENCES referral_snapshots(id, installation_id),
 UNIQUE (referral_id, sequence_number)
);
CREATE TABLE referral_followups (
 id uuid PRIMARY KEY,
 installation_id uuid NOT NULL,
 referral_id uuid NOT NULL,
 contact_date date NOT NULL,
 contact_method text NOT NULL,
 information_source text NOT NULL,
 provider_seen boolean NULL,
 facility_name text NULL,
 date_seen date NULL,
 reported_outcome text NULL,
 reported_medications_or_advice text NULL,
 next_action text NULL,
 next_followup_date date NULL,
 source_type text NOT NULL,
 recorded_by_practitioner_id uuid NOT NULL REFERENCES practitioners(id),
 recorded_at timestamptz NOT NULL,
 FOREIGN KEY (id, installation_id) REFERENCES referral_resources(id, installation_id),
 FOREIGN KEY (referral_id, installation_id) REFERENCES referral_snapshots(id, installation_id)
);
CREATE INDEX ix_referral_followups_parent ON referral_followups(referral_id, recorded_at, id);
CREATE TABLE referral_treatment_actions (
 followup_id uuid NOT NULL REFERENCES referral_followups(id),
 local_action_id uuid NOT NULL,
 sequence_number integer NOT NULL CHECK (sequence_number BETWEEN 1 AND 3),
 action_code text NOT NULL CHECK (action_code IN ('TREATMENT_INITIATED','TREATMENT_MODIFIED','NEW_MEDICATION')),
 PRIMARY KEY (followup_id, local_action_id), UNIQUE (followup_id, sequence_number), UNIQUE (followup_id, action_code)
);
CREATE TABLE referral_medication_changes (
 followup_id uuid NOT NULL REFERENCES referral_followups(id),
 local_medication_change_id uuid NOT NULL,
 sequence_number integer NOT NULL CHECK (sequence_number BETWEEN 1 AND 20),
 change_type text NOT NULL CHECK (change_type IN ('TREATMENT_MODIFIED','NEW_MEDICATION')),
 medication_name text NOT NULL,
 dosage text NULL,
 frequency text NULL,
 PRIMARY KEY (followup_id, local_medication_change_id), UNIQUE (followup_id, sequence_number),
 FOREIGN KEY (followup_id, change_type) REFERENCES referral_treatment_actions(followup_id, action_code)
);
CREATE FUNCTION reject_referral_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Referral history is immutable';
END;
$$;
CREATE TRIGGER tr_referral_status_events_immutable BEFORE UPDATE OR DELETE ON referral_status_events
FOR EACH ROW EXECUTE FUNCTION reject_referral_history_mutation();
CREATE TRIGGER tr_referral_followups_immutable BEFORE UPDATE OR DELETE ON referral_followups
FOR EACH ROW EXECUTE FUNCTION reject_referral_history_mutation();
CREATE TRIGGER tr_referral_treatment_actions_immutable BEFORE UPDATE OR DELETE ON referral_treatment_actions
FOR EACH ROW EXECUTE FUNCTION reject_referral_history_mutation();
CREATE TRIGGER tr_referral_medication_changes_immutable BEFORE UPDATE OR DELETE ON referral_medication_changes
FOR EACH ROW EXECUTE FUNCTION reject_referral_history_mutation();
ALTER TABLE sync_records ADD COLUMN referral_resource_id uuid NULL;
ALTER TABLE sync_records ADD CONSTRAINT fk_sync_records_referral_resource FOREIGN KEY (referral_resource_id, resource_type) REFERENCES referral_resources(id, resource_type);
ALTER TABLE sync_records DROP CONSTRAINT ck_sync_records_resource_type;
ALTER TABLE sync_records ADD CONSTRAINT ck_sync_records_resource_type CHECK (
  resource_type IN ('PATIENT','SCREENING_SESSION','SCREENING_ENCOUNTER','VITALS','LIFESTYLE','FOOD','OTC','REFERRAL','REFERRAL_STATUS','REFERRAL_FOLLOWUP')
);
ALTER TABLE sync_records DROP CONSTRAINT ck_sync_records_target_type;
ALTER TABLE sync_records ADD CONSTRAINT ck_sync_records_target_type CHECK (
  (status IN ('PROCESSING','REJECTED','RETRY') AND num_nonnulls(person_id, screening_session_id, screening_encounter_id, screening_vital_set_id, lifestyle_assessment_id, identity_review_case_id, reported_intake_assessment_id, referral_resource_id) = 0)
  OR (status = 'REVIEW_REQUIRED' AND resource_type = 'PATIENT' AND identity_review_case_id IS NOT NULL AND num_nonnulls(person_id, screening_session_id, screening_encounter_id, screening_vital_set_id, lifestyle_assessment_id, reported_intake_assessment_id, referral_resource_id) = 0)
  OR (status IN ('ACCEPTED','UNCHANGED') AND identity_review_case_id IS NULL
      AND num_nonnulls(person_id, screening_session_id, screening_encounter_id, screening_vital_set_id, lifestyle_assessment_id, reported_intake_assessment_id, referral_resource_id) = 1
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
        ELSE false END)
);
