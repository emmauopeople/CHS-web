-- Opt-in clinical timing for new encounters; legacy rows are not rewritten.
ALTER TABLE screening_encounters ADD COLUMN clinical_time jsonb;
ALTER TABLE screening_encounters ADD CONSTRAINT screening_encounter_clinical_time_object
  CHECK (clinical_time IS NULL OR (jsonb_typeof(clinical_time) = 'object'
    AND clinical_time ?& ARRAY['localDate', 'localTime', 'timezone']));
COMMENT ON COLUMN screening_encounters.clinical_time IS
  'Entered clinical date/time and IANA zone. started_at is its UTC instant; source_created_at remains documentation start.';
