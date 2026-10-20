CREATE TABLE fhir_publish_queue (
 person_id uuid PRIMARY KEY REFERENCES persons(id),
 generation bigint NOT NULL DEFAULT 1,
 published_generation bigint NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PUBLISHING','PUBLISHED','RETRY','BLOCKED')),
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_id uuid NULL,
 lease_until timestamptz NULL,
 error_code text NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_fhir_publish_ready ON fhir_publish_queue(next_attempt_at) WHERE status IN ('PENDING','RETRY','PUBLISHING');
CREATE TABLE fhir_resource_registry (
 resource_type text NOT NULL,
 resource_id text NOT NULL,
 source_id uuid NOT NULL,
 person_id uuid NULL REFERENCES persons(id),
 organization_id uuid NULL REFERENCES organizations(id),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 published_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(resource_type,resource_id)
);
CREATE TABLE fhir_publication_events (
 id uuid PRIMARY KEY,
 person_id uuid NOT NULL REFERENCES persons(id),
 generation bigint NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('PUBLISHED','RETRY','BLOCKED')),
 resource_count integer NOT NULL,
 error_code text NULL,
 occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION enqueue_fhir_person() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE patient uuid;
BEGIN
 IF TG_TABLE_NAME='persons' THEN patient:=NEW.id;
 ELSIF TG_TABLE_NAME IN ('person_identifiers','screening_encounters','screening_vital_sets','lifestyle_assessments','reported_intake_assessments','referral_snapshots','encounter_addenda','encounter_review_flags') THEN patient:=NEW.person_id;
 ELSIF TG_TABLE_NAME='vital_readings' THEN SELECT person_id INTO patient FROM screening_vital_sets WHERE id=NEW.vital_set_id;
 ELSIF TG_TABLE_NAME IN ('referral_followups','referral_status_events') THEN SELECT person_id INTO patient FROM referral_snapshots WHERE id=NEW.referral_id;
 ELSIF TG_TABLE_NAME='encounter_review_status_events' THEN SELECT person_id INTO patient FROM encounter_review_flags WHERE id=NEW.flag_id;
 END IF;
 IF patient IS NOT NULL THEN
  INSERT INTO fhir_publish_queue(person_id) VALUES(patient) ON CONFLICT(person_id) DO UPDATE
   SET generation=fhir_publish_queue.generation+1,status=CASE WHEN fhir_publish_queue.status='PUBLISHING' THEN 'PUBLISHING' ELSE 'PENDING' END,
    next_attempt_at=now(),updated_at=now();
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER tr_fhir_person AFTER INSERT OR UPDATE ON persons FOR EACH ROW EXECUTE FUNCTION enqueue_fhir_person();
CREATE TRIGGER tr_fhir_identifier AFTER INSERT OR UPDATE ON person_identifiers FOR EACH ROW EXECUTE FUNCTION enqueue_fhir_person();
CREATE TRIGGER tr_fhir_encounter AFTER INSERT OR UPDATE ON screening_encounters FOR EACH ROW EXECUTE FUNCTION enqueue_fhir_person();
CREATE TRIGGER tr_fhir_vitals AFTER INSERT OR UPDATE ON screening_vital_sets FOR EACH ROW EXECUTE FUNCTION enqueue_fhir_person();
CREATE TRIGGER tr_fhir_reading AFTER INSERT OR UPDATE ON vital_readings FOR EACH ROW EXECUTE FUNCTION enqueue_fhir_person();
CREATE TRIGGER tr_fhir_lifestyle AFTER INSERT OR UPDATE ON lifestyle_assessments FOR EACH ROW EXECUTE FUNCTION enqueue_fhir_person();
CREATE TRIGGER tr_fhir_intake AFTER INSERT ON reported_intake_assessments FOR EACH ROW EXECUTE FUNCTION enqueue_fhir_person();
CREATE TRIGGER tr_fhir_referral AFTER INSERT OR UPDATE ON referral_snapshots FOR EACH ROW EXECUTE FUNCTION enqueue_fhir_person();
CREATE TRIGGER tr_fhir_followup AFTER INSERT ON referral_followups FOR EACH ROW EXECUTE FUNCTION enqueue_fhir_person();
CREATE TRIGGER tr_fhir_referral_status AFTER INSERT ON referral_status_events FOR EACH ROW EXECUTE FUNCTION enqueue_fhir_person();
CREATE TRIGGER tr_fhir_addendum AFTER INSERT ON encounter_addenda FOR EACH ROW EXECUTE FUNCTION enqueue_fhir_person();
CREATE TRIGGER tr_fhir_review AFTER INSERT ON encounter_review_flags FOR EACH ROW EXECUTE FUNCTION enqueue_fhir_person();
CREATE TRIGGER tr_fhir_review_status AFTER INSERT ON encounter_review_status_events FOR EACH ROW EXECUTE FUNCTION enqueue_fhir_person();
CREATE FUNCTION enqueue_fhir_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO fhir_publish_queue(person_id)
 SELECT DISTINCT person_id FROM screening_encounters
 WHERE (TG_TABLE_NAME='organizations' AND organization_id=NEW.id)
    OR (TG_TABLE_NAME='locations' AND location_id=NEW.id)
 ON CONFLICT(person_id) DO UPDATE SET generation=fhir_publish_queue.generation+1,
   status=CASE WHEN fhir_publish_queue.status='PUBLISHING' THEN 'PUBLISHING' ELSE 'PENDING' END,next_attempt_at=now(),updated_at=now();
 RETURN NEW;
END;
$$;
CREATE TRIGGER tr_fhir_organization AFTER UPDATE OF name,active,identifier_system,identifier_value ON organizations FOR EACH ROW EXECUTE FUNCTION enqueue_fhir_context();
CREATE TRIGGER tr_fhir_location AFTER UPDATE OF name,active ON locations FOR EACH ROW EXECUTE FUNCTION enqueue_fhir_context();
INSERT INTO fhir_publish_queue(person_id) SELECT id FROM persons;
