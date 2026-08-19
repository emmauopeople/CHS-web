CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  identifier_system text NOT NULL,
  identifier_value text NOT NULL,
  name text NOT NULL,
  organization_type_code text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT ck_organizations_identifier_system_not_blank
    CHECK (btrim(identifier_system) <> ''),
  CONSTRAINT ck_organizations_identifier_value_not_blank
    CHECK (btrim(identifier_value) <> ''),
  CONSTRAINT ck_organizations_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT ck_organizations_type_not_blank
    CHECK (btrim(organization_type_code) <> ''),
  CONSTRAINT ck_organizations_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_organizations_identifier UNIQUE (identifier_system, identifier_value)
);

CREATE TABLE locations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  parent_location_id uuid NULL,
  identifier_system text NOT NULL,
  identifier_value text NOT NULL,
  name text NOT NULL,
  location_type_code text NOT NULL,
  physical_type_code text NULL,
  village text NULL,
  subdivision text NULL,
  region text NULL,
  directions text NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_locations_organization FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_locations_parent FOREIGN KEY (parent_location_id)
    REFERENCES locations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_locations_not_own_parent CHECK (parent_location_id IS DISTINCT FROM id),
  CONSTRAINT ck_locations_identifier_system_not_blank
    CHECK (btrim(identifier_system) <> ''),
  CONSTRAINT ck_locations_identifier_value_not_blank
    CHECK (btrim(identifier_value) <> ''),
  CONSTRAINT ck_locations_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT ck_locations_type_not_blank CHECK (btrim(location_type_code) <> ''),
  CONSTRAINT ck_locations_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_locations_identifier
    UNIQUE (organization_id, identifier_system, identifier_value),
  CONSTRAINT uq_locations_id_organization UNIQUE (id, organization_id)
);

CREATE TABLE desktop_installations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  configured_location_id uuid NOT NULL,
  deployment_name text NOT NULL,
  timezone text NOT NULL,
  status text NOT NULL,
  enrolled_at timestamptz NOT NULL,
  last_seen_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_installations_organization FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_installations_location_ownership
    FOREIGN KEY (configured_location_id, organization_id)
    REFERENCES locations (id, organization_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_installations_deployment_name_not_blank
    CHECK (btrim(deployment_name) <> ''),
  CONSTRAINT ck_installations_timezone_not_blank CHECK (btrim(timezone) <> ''),
  CONSTRAINT ck_installations_status
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'RETIRED')),
  CONSTRAINT ck_installations_last_seen CHECK (
    last_seen_at IS NULL OR last_seen_at >= enrolled_at
  ),
  CONSTRAINT ck_installations_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_installations_id_organization UNIQUE (id, organization_id)
);

CREATE TABLE location_source_links (
  id uuid PRIMARY KEY,
  location_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  source_location_id uuid NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  CONSTRAINT fk_location_source_links_location
    FOREIGN KEY (location_id, organization_id)
    REFERENCES locations (id, organization_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_location_source_links_installation
    FOREIGN KEY (installation_id, organization_id)
    REFERENCES desktop_installations (id, organization_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_location_source_links_observed_period CHECK (
    last_observed_at >= first_observed_at
  ),
  CONSTRAINT uq_location_source_links_source
    UNIQUE (installation_id, source_location_id),
  CONSTRAINT uq_location_source_links_source_target
    UNIQUE (installation_id, source_location_id, location_id, organization_id),
  CONSTRAINT uq_location_source_links_id_location
    UNIQUE (id, location_id)
);

CREATE TABLE practitioners (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT ck_practitioners_display_name_not_blank CHECK (btrim(display_name) <> ''),
  CONSTRAINT ck_practitioners_updated_at CHECK (updated_at >= created_at)
);

CREATE TABLE practitioner_source_links (
  id uuid PRIMARY KEY,
  practitioner_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  source_actor_local_id uuid NOT NULL,
  source_display_name text NOT NULL,
  source_role_code text NOT NULL,
  source_active boolean NOT NULL,
  source_updated_at timestamptz NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  CONSTRAINT fk_practitioner_source_links_practitioner FOREIGN KEY (practitioner_id)
    REFERENCES practitioners (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_practitioner_source_links_installation FOREIGN KEY (installation_id)
    REFERENCES desktop_installations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_practitioner_source_links_display_name_not_blank
    CHECK (btrim(source_display_name) <> ''),
  CONSTRAINT ck_practitioner_source_links_role CHECK (
    source_role_code IN ('LOCAL_ADMIN', 'NURSE', 'TRAINED_SCREENER')
  ),
  CONSTRAINT ck_practitioner_source_links_observed_period CHECK (
    last_observed_at >= first_observed_at
  ),
  CONSTRAINT uq_practitioner_source_links_source
    UNIQUE (installation_id, source_actor_local_id),
  CONSTRAINT uq_practitioner_source_links_id_practitioner
    UNIQUE (id, practitioner_id)
);

CREATE TABLE practitioner_roles (
  id uuid PRIMARY KEY,
  practitioner_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  location_id uuid NULL,
  code_system text NOT NULL,
  code text NOT NULL,
  display text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  period_start timestamptz NOT NULL,
  period_end timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_practitioner_roles_practitioner FOREIGN KEY (practitioner_id)
    REFERENCES practitioners (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_practitioner_roles_organization FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_practitioner_roles_location_ownership
    FOREIGN KEY (location_id, organization_id)
    REFERENCES locations (id, organization_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_practitioner_roles_code_system_not_blank
    CHECK (btrim(code_system) <> ''),
  CONSTRAINT ck_practitioner_roles_code_not_blank CHECK (btrim(code) <> ''),
  CONSTRAINT ck_practitioner_roles_display_not_blank CHECK (btrim(display) <> ''),
  CONSTRAINT ck_practitioner_roles_period CHECK (
    period_end IS NULL OR period_end >= period_start
  ),
  CONSTRAINT ck_practitioner_roles_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_practitioner_roles_id_context
    UNIQUE (id, practitioner_id, organization_id)
);

CREATE UNIQUE INDEX ux_practitioner_roles_active_context
  ON practitioner_roles (
    practitioner_id,
    organization_id,
    COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid),
    code_system,
    code
  )
  WHERE active = true AND period_end IS NULL;

CREATE TABLE screening_protocols (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  protocol_key text NOT NULL,
  version_label text NOT NULL,
  checksum text NOT NULL,
  status text NOT NULL,
  effective_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_screening_protocols_organization FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_screening_protocols_key_not_blank CHECK (btrim(protocol_key) <> ''),
  CONSTRAINT ck_screening_protocols_version_not_blank CHECK (btrim(version_label) <> ''),
  CONSTRAINT ck_screening_protocols_checksum_not_blank CHECK (btrim(checksum) <> ''),
  CONSTRAINT ck_screening_protocols_status
    CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE')),
  CONSTRAINT ck_screening_protocols_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_screening_protocols_version
    UNIQUE (organization_id, protocol_key, version_label, checksum),
  CONSTRAINT uq_screening_protocols_id_organization UNIQUE (id, organization_id)
);

CREATE TABLE protocol_source_links (
  id uuid PRIMARY KEY,
  protocol_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  local_protocol_version_id uuid NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  CONSTRAINT fk_protocol_source_links_protocol
    FOREIGN KEY (protocol_id, organization_id)
    REFERENCES screening_protocols (id, organization_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_protocol_source_links_installation
    FOREIGN KEY (installation_id, organization_id)
    REFERENCES desktop_installations (id, organization_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_protocol_source_links_observed_period CHECK (
    last_observed_at >= first_observed_at
  ),
  CONSTRAINT uq_protocol_source_links_source
    UNIQUE (installation_id, local_protocol_version_id),
  CONSTRAINT uq_protocol_source_links_source_target
    UNIQUE (
      installation_id,
      local_protocol_version_id,
      protocol_id,
      organization_id
    )
);

CREATE TABLE persons (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  given_name text NULL,
  family_name text NULL,
  other_names text NULL,
  name_normalized text NOT NULL,
  sex text NOT NULL,
  acknowledgment_status text NOT NULL,
  date_of_birth date NULL,
  approximate_age_years integer NULL,
  age_as_of_date date NULL,
  phone text NULL,
  phone_normalized text NULL,
  alternate_contact_name text NULL,
  alternate_contact_phone text NULL,
  village text NULL,
  quarter text NULL,
  residence_notes text NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT ck_persons_display_name_not_blank CHECK (btrim(display_name) <> ''),
  CONSTRAINT ck_persons_name_normalized_not_blank CHECK (btrim(name_normalized) <> ''),
  CONSTRAINT ck_persons_sex CHECK (sex IN ('FEMALE', 'MALE', 'OTHER', 'UNKNOWN')),
  CONSTRAINT ck_persons_acknowledgment_status CHECK (
    acknowledgment_status IN ('ACKNOWLEDGED', 'DECLINED', 'NOT_REQUESTED')
  ),
  CONSTRAINT ck_persons_age_range CHECK (
    approximate_age_years IS NULL OR approximate_age_years BETWEEN 0 AND 120
  ),
  CONSTRAINT ck_persons_birth_or_approximate_age CHECK (
    (
      date_of_birth IS NOT NULL
      AND approximate_age_years IS NULL
      AND age_as_of_date IS NULL
    )
    OR
    (
      date_of_birth IS NULL
      AND approximate_age_years IS NOT NULL
      AND age_as_of_date IS NOT NULL
    )
  ),
  CONSTRAINT ck_persons_status CHECK (status IN ('ACTIVE', 'INACTIVE', 'DECEASED')),
  CONSTRAINT ck_persons_updated_at CHECK (updated_at >= created_at)
);

CREATE TABLE person_identifiers (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL,
  identifier_system text NOT NULL,
  identifier_value text NOT NULL,
  identifier_type_code text NOT NULL,
  issuer_organization_id uuid NULL,
  status text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT fk_person_identifiers_person FOREIGN KEY (person_id)
    REFERENCES persons (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_person_identifiers_issuer FOREIGN KEY (issuer_organization_id)
    REFERENCES organizations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_person_identifiers_system_not_blank
    CHECK (btrim(identifier_system) <> ''),
  CONSTRAINT ck_person_identifiers_value_not_blank CHECK (btrim(identifier_value) <> ''),
  CONSTRAINT ck_person_identifiers_type_not_blank
    CHECK (btrim(identifier_type_code) <> ''),
  CONSTRAINT ck_person_identifiers_status CHECK (status IN ('ACTIVE', 'RETIRED')),
  CONSTRAINT ck_person_identifiers_period CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT uq_person_identifiers_value UNIQUE (identifier_system, identifier_value)
);

CREATE UNIQUE INDEX ux_person_identifiers_active_primary
  ON person_identifiers (person_id, identifier_type_code)
  WHERE status = 'ACTIVE' AND is_primary = true;

CREATE TABLE patient_source_links (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  local_patient_id uuid NOT NULL,
  local_patient_code text NOT NULL,
  last_source_revision integer NOT NULL,
  last_content_hash text NOT NULL,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  CONSTRAINT fk_patient_source_links_person FOREIGN KEY (person_id)
    REFERENCES persons (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_patient_source_links_installation FOREIGN KEY (installation_id)
    REFERENCES desktop_installations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_patient_source_links_code CHECK (local_patient_code ~ '^PT-[0-9]{6}$'),
  CONSTRAINT ck_patient_source_links_revision CHECK (last_source_revision >= 1),
  CONSTRAINT ck_patient_source_links_hash
    CHECK (last_content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_patient_source_links_source_time CHECK (
    source_updated_at >= source_created_at
  ),
  CONSTRAINT ck_patient_source_links_observed_period CHECK (
    last_observed_at >= first_observed_at
  ),
  CONSTRAINT uq_patient_source_links_local_id UNIQUE (installation_id, local_patient_id),
  CONSTRAINT uq_patient_source_links_local_code UNIQUE (installation_id, local_patient_code),
  CONSTRAINT uq_patient_source_links_source_person
    UNIQUE (installation_id, local_patient_id, person_id)
);

CREATE TABLE identity_review_cases (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL,
  local_patient_id uuid NOT NULL,
  status text NOT NULL,
  opened_at timestamptz NOT NULL,
  resolved_at timestamptz NULL,
  resolved_person_id uuid NULL,
  resolution_note text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_identity_review_cases_installation FOREIGN KEY (installation_id)
    REFERENCES desktop_installations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_identity_review_cases_resolved_person FOREIGN KEY (resolved_person_id)
    REFERENCES persons (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_identity_review_cases_status CHECK (
    status IN ('OPEN', 'RESOLVED_NEW', 'RESOLVED_EXISTING', 'DISMISSED')
  ),
  CONSTRAINT ck_identity_review_cases_resolution CHECK (
    (status = 'OPEN' AND resolved_at IS NULL AND resolved_person_id IS NULL)
    OR
    (status = 'DISMISSED' AND resolved_at IS NOT NULL AND resolved_person_id IS NULL)
    OR
    (status IN ('RESOLVED_NEW', 'RESOLVED_EXISTING')
      AND resolved_at IS NOT NULL AND resolved_person_id IS NOT NULL)
  ),
  CONSTRAINT ck_identity_review_cases_updated_at CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX ux_identity_review_cases_open_source
  ON identity_review_cases (installation_id, local_patient_id)
  WHERE status = 'OPEN';

CREATE TABLE identity_review_candidates (
  review_case_id uuid NOT NULL,
  person_id uuid NOT NULL,
  score smallint NOT NULL,
  matched_on text[] NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (review_case_id, person_id),
  CONSTRAINT fk_identity_review_candidates_case FOREIGN KEY (review_case_id)
    REFERENCES identity_review_cases (id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_identity_review_candidates_person FOREIGN KEY (person_id)
    REFERENCES persons (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_identity_review_candidates_score CHECK (score BETWEEN 1 AND 100),
  CONSTRAINT ck_identity_review_candidates_matched_on CHECK (
    cardinality(matched_on) BETWEEN 1 AND 12
  )
);

CREATE TABLE screening_sessions (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  location_id uuid NOT NULL,
  protocol_id uuid NOT NULL,
  local_session_id uuid NOT NULL,
  source_location_id uuid NOT NULL,
  source_protocol_version_id uuid NOT NULL,
  session_date date NOT NULL,
  status text NOT NULL,
  notes text NULL,
  opened_by_practitioner_id uuid NOT NULL,
  closed_by_practitioner_id uuid NULL,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz NULL,
  source_revision integer NOT NULL,
  source_content_hash text NOT NULL,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_screening_sessions_installation FOREIGN KEY (installation_id)
    REFERENCES desktop_installations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_screening_sessions_organization FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_screening_sessions_location_ownership
    FOREIGN KEY (location_id, organization_id)
    REFERENCES locations (id, organization_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_screening_sessions_source_location
    FOREIGN KEY (installation_id, source_location_id, location_id, organization_id)
    REFERENCES location_source_links (
      installation_id,
      source_location_id,
      location_id,
      organization_id
    )
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_screening_sessions_source_protocol
    FOREIGN KEY (
      installation_id,
      source_protocol_version_id,
      protocol_id,
      organization_id
    )
    REFERENCES protocol_source_links (
      installation_id,
      local_protocol_version_id,
      protocol_id,
      organization_id
    )
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_screening_sessions_protocol_ownership
    FOREIGN KEY (protocol_id, organization_id)
    REFERENCES screening_protocols (id, organization_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_screening_sessions_opened_by FOREIGN KEY (opened_by_practitioner_id)
    REFERENCES practitioners (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_screening_sessions_closed_by FOREIGN KEY (closed_by_practitioner_id)
    REFERENCES practitioners (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_screening_sessions_status CHECK (status IN ('OPEN', 'CLOSED')),
  CONSTRAINT ck_screening_sessions_closed_state CHECK (
    (status = 'OPEN' AND closed_at IS NULL AND closed_by_practitioner_id IS NULL)
    OR
    (status = 'CLOSED' AND closed_at IS NOT NULL AND closed_by_practitioner_id IS NOT NULL)
  ),
  CONSTRAINT ck_screening_sessions_period CHECK (closed_at IS NULL OR closed_at >= opened_at),
  CONSTRAINT ck_screening_sessions_revision CHECK (source_revision >= 1),
  CONSTRAINT ck_screening_sessions_hash CHECK (source_content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_screening_sessions_source_time CHECK (
    source_updated_at >= source_created_at
  ),
  CONSTRAINT ck_screening_sessions_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_screening_sessions_source UNIQUE (installation_id, local_session_id),
  CONSTRAINT uq_screening_sessions_id_context
    UNIQUE (id, installation_id, organization_id, location_id, protocol_id)
);

CREATE TABLE screening_encounters (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL,
  screening_session_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  location_id uuid NOT NULL,
  protocol_id uuid NOT NULL,
  local_encounter_id uuid NOT NULL,
  source_location_id uuid NOT NULL,
  source_protocol_version_id uuid NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NULL,
  recorded_by_practitioner_id uuid NOT NULL,
  practitioner_role_id uuid NULL,
  source_type text NOT NULL,
  amendment_of_encounter_id uuid NULL,
  amendment_reason text NULL,
  void_reason text NULL,
  source_revision integer NOT NULL,
  source_content_hash text NOT NULL,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_screening_encounters_person FOREIGN KEY (person_id)
    REFERENCES persons (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_screening_encounters_session_context
    FOREIGN KEY (
      screening_session_id,
      installation_id,
      organization_id,
      location_id,
      protocol_id
    )
    REFERENCES screening_sessions (
      id,
      installation_id,
      organization_id,
      location_id,
      protocol_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_screening_encounters_recorded_by FOREIGN KEY (recorded_by_practitioner_id)
    REFERENCES practitioners (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_screening_encounters_source_location
    FOREIGN KEY (installation_id, source_location_id, location_id, organization_id)
    REFERENCES location_source_links (
      installation_id,
      source_location_id,
      location_id,
      organization_id
    )
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_screening_encounters_source_protocol
    FOREIGN KEY (
      installation_id,
      source_protocol_version_id,
      protocol_id,
      organization_id
    )
    REFERENCES protocol_source_links (
      installation_id,
      local_protocol_version_id,
      protocol_id,
      organization_id
    )
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_screening_encounters_practitioner_role
    FOREIGN KEY (practitioner_role_id, recorded_by_practitioner_id, organization_id)
    REFERENCES practitioner_roles (id, practitioner_id, organization_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_screening_encounters_amendment
    FOREIGN KEY (amendment_of_encounter_id, person_id)
    REFERENCES screening_encounters (id, person_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_screening_encounters_status
    CHECK (status IN ('DRAFT', 'COMPLETED', 'AMENDED', 'VOID')),
  CONSTRAINT ck_screening_encounters_source_type CHECK (source_type = 'LOCAL'),
  CONSTRAINT ck_screening_encounters_completion CHECK (
    (status = 'DRAFT' AND completed_at IS NULL)
    OR
    (status IN ('COMPLETED', 'AMENDED') AND completed_at IS NOT NULL)
    OR
    (status = 'VOID')
  ),
  CONSTRAINT ck_screening_encounters_period CHECK (
    completed_at IS NULL OR completed_at >= started_at
  ),
  CONSTRAINT ck_screening_encounters_amendment_state CHECK (
    (status = 'AMENDED' AND amendment_of_encounter_id IS NOT NULL
      AND amendment_reason IS NOT NULL AND btrim(amendment_reason) <> '')
    OR
    (status <> 'AMENDED' AND amendment_of_encounter_id IS NULL
      AND amendment_reason IS NULL)
  ),
  CONSTRAINT ck_screening_encounters_void_state CHECK (
    (status = 'VOID' AND void_reason IS NOT NULL AND btrim(void_reason) <> '')
    OR
    (status <> 'VOID' AND void_reason IS NULL)
  ),
  CONSTRAINT ck_screening_encounters_not_own_amendment
    CHECK (amendment_of_encounter_id IS DISTINCT FROM id),
  CONSTRAINT ck_screening_encounters_revision CHECK (source_revision >= 1),
  CONSTRAINT ck_screening_encounters_hash CHECK (source_content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_screening_encounters_source_time CHECK (
    source_updated_at >= source_created_at
  ),
  CONSTRAINT ck_screening_encounters_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_screening_encounters_source UNIQUE (installation_id, local_encounter_id),
  CONSTRAINT uq_screening_encounters_id_person UNIQUE (id, person_id),
  CONSTRAINT uq_screening_encounters_id_context
    UNIQUE (id, installation_id, person_id)
);

CREATE TABLE screening_vital_sets (
  id uuid PRIMARY KEY,
  encounter_id uuid NOT NULL,
  person_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  local_vitals_id uuid NOT NULL,
  status text NOT NULL,
  weight_kg numeric(6, 2) NULL,
  waist_cm numeric(6, 2) NULL,
  notes text NULL,
  recorded_by_practitioner_id uuid NOT NULL,
  source_revision integer NOT NULL,
  source_content_hash text NOT NULL,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_screening_vital_sets_encounter_context
    FOREIGN KEY (encounter_id, installation_id, person_id)
    REFERENCES screening_encounters (id, installation_id, person_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_screening_vital_sets_recorded_by FOREIGN KEY (recorded_by_practitioner_id)
    REFERENCES practitioners (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_screening_vital_sets_status
    CHECK (status IN ('DRAFT', 'VITALS_COMPLETE')),
  CONSTRAINT ck_screening_vital_sets_weight
    CHECK (weight_kg IS NULL OR weight_kg > 0 AND weight_kg <= 500),
  CONSTRAINT ck_screening_vital_sets_waist
    CHECK (waist_cm IS NULL OR waist_cm > 0 AND waist_cm <= 400),
  CONSTRAINT ck_screening_vital_sets_revision CHECK (source_revision >= 1),
  CONSTRAINT ck_screening_vital_sets_hash CHECK (source_content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_screening_vital_sets_source_time CHECK (
    source_updated_at >= source_created_at
  ),
  CONSTRAINT ck_screening_vital_sets_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_screening_vital_sets_encounter UNIQUE (encounter_id),
  CONSTRAINT uq_screening_vital_sets_source UNIQUE (installation_id, local_vitals_id),
  CONSTRAINT uq_screening_vital_sets_id_context
    UNIQUE (id, installation_id, person_id, encounter_id)
);

CREATE TABLE vital_readings (
  id uuid PRIMARY KEY,
  vital_set_id uuid NOT NULL,
  local_reading_id uuid NOT NULL,
  sequence_number smallint NOT NULL,
  systolic_mmhg smallint NULL,
  diastolic_mmhg smallint NULL,
  pulse_bpm smallint NULL,
  measurement_site text NULL,
  patient_position text NULL,
  measurement_local_date date NOT NULL,
  measurement_local_time time without time zone NULL,
  measurement_timezone text NOT NULL,
  measured_at timestamptz NULL,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_vital_readings_set FOREIGN KEY (vital_set_id)
    REFERENCES screening_vital_sets (id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_vital_readings_sequence CHECK (sequence_number BETWEEN 1 AND 12),
  CONSTRAINT ck_vital_readings_systolic CHECK (
    systolic_mmhg IS NULL OR systolic_mmhg BETWEEN 1 AND 300
  ),
  CONSTRAINT ck_vital_readings_diastolic CHECK (
    diastolic_mmhg IS NULL OR diastolic_mmhg BETWEEN 1 AND 120
  ),
  CONSTRAINT ck_vital_readings_pulse CHECK (
    pulse_bpm IS NULL OR pulse_bpm BETWEEN 1 AND 300
  ),
  CONSTRAINT ck_vital_readings_site CHECK (
    measurement_site IS NULL OR
    measurement_site IN ('RIGHT_ARM', 'LEFT_ARM', 'LEFT_LEG', 'RIGHT_LEG')
  ),
  CONSTRAINT ck_vital_readings_position CHECK (
    patient_position IS NULL OR patient_position IN ('LYING', 'STANDING', 'SITTING')
  ),
  CONSTRAINT ck_vital_readings_timezone_not_blank CHECK (btrim(measurement_timezone) <> ''),
  CONSTRAINT ck_vital_readings_source_time CHECK (
    source_updated_at >= source_created_at
  ),
  CONSTRAINT ck_vital_readings_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_vital_readings_source UNIQUE (vital_set_id, local_reading_id),
  CONSTRAINT uq_vital_readings_sequence UNIQUE (vital_set_id, sequence_number)
);

CREATE TABLE sync_batches (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  location_id uuid NOT NULL,
  source_location_id uuid NOT NULL,
  contract_version text NOT NULL,
  desktop_application_version text NOT NULL,
  desktop_schema_version integer NOT NULL,
  source_created_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  completed_at timestamptz NULL,
  payload_hash text NOT NULL,
  status text NOT NULL,
  accepted_count integer NOT NULL DEFAULT 0,
  unchanged_count integer NOT NULL DEFAULT 0,
  review_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  retry_count integer NOT NULL DEFAULT 0,
  response_body jsonb NULL,
  CONSTRAINT fk_sync_batches_installation FOREIGN KEY (installation_id)
    REFERENCES desktop_installations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_sync_batches_location FOREIGN KEY (location_id)
    REFERENCES locations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_sync_batches_source_location
    FOREIGN KEY (installation_id, source_location_id, location_id, organization_id)
    REFERENCES location_source_links (
      installation_id,
      source_location_id,
      location_id,
      organization_id
    )
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_sync_batches_contract_version_not_blank
    CHECK (btrim(contract_version) <> ''),
  CONSTRAINT ck_sync_batches_application_version_not_blank
    CHECK (btrim(desktop_application_version) <> ''),
  CONSTRAINT ck_sync_batches_schema_version CHECK (desktop_schema_version >= 1),
  CONSTRAINT ck_sync_batches_hash CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_sync_batches_status
    CHECK (status IN ('PROCESSING', 'ACCEPTED', 'PARTIAL', 'REJECTED', 'FAILED')),
  CONSTRAINT ck_sync_batches_completion CHECK (
    (status = 'PROCESSING' AND completed_at IS NULL AND response_body IS NULL)
    OR
    (status <> 'PROCESSING' AND completed_at IS NOT NULL)
  ),
  CONSTRAINT ck_sync_batches_period CHECK (
    completed_at IS NULL OR completed_at >= received_at
  ),
  CONSTRAINT ck_sync_batches_counts CHECK (
    accepted_count >= 0 AND unchanged_count >= 0 AND review_count >= 0
    AND rejected_count >= 0 AND retry_count >= 0
  ),
  CONSTRAINT uq_sync_batches_delivery UNIQUE (installation_id, batch_id),
  CONSTRAINT uq_sync_batches_id_installation UNIQUE (id, installation_id)
);

CREATE TABLE sync_batch_actors (
  id uuid PRIMARY KEY,
  batch_internal_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  source_actor_local_id uuid NOT NULL,
  practitioner_source_link_id uuid NOT NULL,
  practitioner_id uuid NOT NULL,
  source_display_name text NOT NULL,
  source_role_code text NOT NULL,
  source_active boolean NOT NULL,
  source_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT fk_sync_batch_actors_batch_context
    FOREIGN KEY (batch_internal_id, installation_id)
    REFERENCES sync_batches (id, installation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_sync_batch_actors_practitioner_context
    FOREIGN KEY (practitioner_source_link_id, practitioner_id)
    REFERENCES practitioner_source_links (id, practitioner_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_sync_batch_actors_display_name_not_blank
    CHECK (btrim(source_display_name) <> ''),
  CONSTRAINT ck_sync_batch_actors_role CHECK (
    source_role_code IN ('LOCAL_ADMIN', 'NURSE', 'TRAINED_SCREENER')
  ),
  CONSTRAINT uq_sync_batch_actors_source
    UNIQUE (batch_internal_id, source_actor_local_id),
  CONSTRAINT uq_sync_batch_actors_id_batch
    UNIQUE (id, batch_internal_id)
);

CREATE TABLE sync_records (
  id uuid PRIMARY KEY,
  batch_internal_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  record_id uuid NOT NULL,
  resource_type text NOT NULL,
  local_resource_id uuid NOT NULL,
  source_revision integer NOT NULL,
  schema_version text NOT NULL,
  operation text NOT NULL,
  captured_at timestamptz NOT NULL,
  sync_batch_actor_id uuid NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL,
  person_id uuid NULL,
  screening_session_id uuid NULL,
  screening_encounter_id uuid NULL,
  screening_vital_set_id uuid NULL,
  identity_review_case_id uuid NULL,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  processed_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT fk_sync_records_batch_context
    FOREIGN KEY (batch_internal_id, installation_id)
    REFERENCES sync_batches (id, installation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_sync_records_actor_context
    FOREIGN KEY (sync_batch_actor_id, batch_internal_id)
    REFERENCES sync_batch_actors (id, batch_internal_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_sync_records_person FOREIGN KEY (person_id)
    REFERENCES persons (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_sync_records_session FOREIGN KEY (screening_session_id)
    REFERENCES screening_sessions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_sync_records_encounter FOREIGN KEY (screening_encounter_id)
    REFERENCES screening_encounters (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_sync_records_vital_set FOREIGN KEY (screening_vital_set_id)
    REFERENCES screening_vital_sets (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_sync_records_identity_review_case FOREIGN KEY (identity_review_case_id)
    REFERENCES identity_review_cases (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_sync_records_resource_type CHECK (
    resource_type IN ('PATIENT', 'SCREENING_SESSION', 'SCREENING_ENCOUNTER', 'VITALS')
  ),
  CONSTRAINT ck_sync_records_revision CHECK (source_revision >= 1),
  CONSTRAINT ck_sync_records_schema_version_not_blank CHECK (btrim(schema_version) <> ''),
  CONSTRAINT ck_sync_records_operation CHECK (operation = 'UPSERT'),
  CONSTRAINT ck_sync_records_hash CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_sync_records_status CHECK (
    status IN ('PROCESSING', 'ACCEPTED', 'UNCHANGED', 'REVIEW_REQUIRED', 'REJECTED', 'RETRY')
  ),
  CONSTRAINT ck_sync_records_errors_array CHECK (jsonb_typeof(errors) = 'array'),
  CONSTRAINT ck_sync_records_processed CHECK (
    (status = 'PROCESSING' AND processed_at IS NULL)
    OR
    (status <> 'PROCESSING' AND processed_at IS NOT NULL)
  ),
  CONSTRAINT ck_sync_records_target_type CHECK (
    (
      status IN ('PROCESSING', 'REJECTED', 'RETRY')
      AND person_id IS NULL
      AND screening_session_id IS NULL
      AND screening_encounter_id IS NULL
      AND screening_vital_set_id IS NULL
      AND identity_review_case_id IS NULL
    )
    OR
    (
      status = 'REVIEW_REQUIRED'
      AND resource_type = 'PATIENT'
      AND person_id IS NULL
      AND screening_session_id IS NULL
      AND screening_encounter_id IS NULL
      AND screening_vital_set_id IS NULL
      AND identity_review_case_id IS NOT NULL
    )
    OR
    (
      status IN ('ACCEPTED', 'UNCHANGED')
      AND (
        (resource_type = 'PATIENT' AND person_id IS NOT NULL
          AND screening_session_id IS NULL AND screening_encounter_id IS NULL
          AND screening_vital_set_id IS NULL AND identity_review_case_id IS NULL)
        OR
        (resource_type = 'SCREENING_SESSION' AND person_id IS NULL
          AND screening_session_id IS NOT NULL AND screening_encounter_id IS NULL
          AND screening_vital_set_id IS NULL AND identity_review_case_id IS NULL)
        OR
        (resource_type = 'SCREENING_ENCOUNTER' AND person_id IS NULL
          AND screening_session_id IS NULL AND screening_encounter_id IS NOT NULL
          AND screening_vital_set_id IS NULL AND identity_review_case_id IS NULL)
        OR
        (resource_type = 'VITALS' AND person_id IS NULL
          AND screening_session_id IS NULL AND screening_encounter_id IS NULL
          AND screening_vital_set_id IS NOT NULL AND identity_review_case_id IS NULL)
      )
    )
  ),
  CONSTRAINT uq_sync_records_delivery UNIQUE (installation_id, record_id),
  CONSTRAINT uq_sync_records_snapshot
    UNIQUE (installation_id, resource_type, local_resource_id, source_revision)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  organization_id uuid NULL,
  practitioner_id uuid NULL,
  action_code text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NULL,
  reason_code text NULL,
  request_id text NULL,
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT fk_audit_events_organization FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_audit_events_practitioner FOREIGN KEY (practitioner_id)
    REFERENCES practitioners (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_audit_events_action_not_blank CHECK (btrim(action_code) <> ''),
  CONSTRAINT ck_audit_events_entity_type_not_blank CHECK (btrim(entity_type) <> ''),
  CONSTRAINT ck_audit_events_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX ix_locations_organization_active
  ON locations (organization_id, active, name);
CREATE INDEX ix_installations_organization_status
  ON desktop_installations (organization_id, status);
CREATE INDEX ix_location_source_links_location
  ON location_source_links (location_id, last_observed_at DESC);
CREATE INDEX ix_practitioner_source_links_practitioner
  ON practitioner_source_links (practitioner_id, source_active);
CREATE INDEX ix_practitioner_roles_context
  ON practitioner_roles (organization_id, location_id, active);
CREATE INDEX ix_persons_birth_identity
  ON persons (date_of_birth, sex, name_normalized)
  WHERE date_of_birth IS NOT NULL;
CREATE INDEX ix_persons_approximate_age_identity
  ON persons (approximate_age_years, age_as_of_date, sex, name_normalized)
  WHERE approximate_age_years IS NOT NULL;
CREATE INDEX ix_persons_residence_identity
  ON persons (village, quarter, name_normalized);
CREATE INDEX ix_patient_source_links_person
  ON patient_source_links (person_id, last_observed_at DESC);
CREATE INDEX ix_identity_review_cases_status
  ON identity_review_cases (status, opened_at);
CREATE INDEX ix_screening_sessions_location_date
  ON screening_sessions (location_id, session_date DESC, status);
CREATE INDEX ix_screening_encounters_person_time
  ON screening_encounters (person_id, started_at DESC);
CREATE INDEX ix_screening_encounters_location_time
  ON screening_encounters (location_id, started_at DESC);
CREATE INDEX ix_screening_vital_sets_person
  ON screening_vital_sets (person_id, source_updated_at DESC);
CREATE INDEX ix_vital_readings_set_sequence
  ON vital_readings (vital_set_id, sequence_number);
CREATE INDEX ix_sync_batches_installation_time
  ON sync_batches (installation_id, received_at DESC);
CREATE INDEX ix_sync_batches_processing
  ON sync_batches (received_at)
  WHERE status = 'PROCESSING';
CREATE INDEX ix_sync_batch_actors_practitioner
  ON sync_batch_actors (practitioner_id, created_at DESC);
CREATE INDEX ix_sync_records_batch_status
  ON sync_records (batch_internal_id, status);
CREATE INDEX ix_sync_records_retry
  ON sync_records (created_at)
  WHERE status = 'RETRY';
CREATE INDEX ix_audit_events_entity_time
  ON audit_events (entity_type, entity_id, occurred_at DESC);
CREATE INDEX ix_audit_events_practitioner_time
  ON audit_events (practitioner_id, occurred_at DESC)
  WHERE practitioner_id IS NOT NULL;
