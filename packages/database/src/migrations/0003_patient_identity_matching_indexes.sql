CREATE INDEX ix_persons_identity_name_birth
  ON persons (name_normalized, date_of_birth)
  WHERE date_of_birth IS NOT NULL AND status <> 'DECEASED';

CREATE INDEX ix_persons_identity_name_phone
  ON persons (name_normalized, phone_normalized)
  WHERE phone_normalized IS NOT NULL AND status <> 'DECEASED';

CREATE INDEX ix_persons_identity_name_approximate_age
  ON persons (name_normalized, approximate_age_years)
  WHERE approximate_age_years IS NOT NULL AND status <> 'DECEASED';

CREATE INDEX ix_person_identifiers_active_lookup
  ON person_identifiers (identifier_system, identifier_value, person_id)
  WHERE status = 'ACTIVE';
