CREATE TABLE lifestyle_alcohol_baselines (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  local_baseline_version_id uuid NOT NULL,
  source_version integer NOT NULL,
  status text NOT NULL,
  ever_consumed text NOT NULL,
  consumed_past_12_months text NOT NULL,
  other_beverage_description text NULL,
  created_by_practitioner_id uuid NOT NULL,
  updated_by_practitioner_id uuid NOT NULL,
  source_content_hash text NOT NULL,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_lifestyle_alcohol_baselines_person FOREIGN KEY (person_id)
    REFERENCES persons (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_alcohol_baselines_installation FOREIGN KEY (installation_id)
    REFERENCES desktop_installations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_alcohol_baselines_created_by
    FOREIGN KEY (created_by_practitioner_id)
    REFERENCES practitioners (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_alcohol_baselines_updated_by
    FOREIGN KEY (updated_by_practitioner_id)
    REFERENCES practitioners (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_lifestyle_alcohol_baselines_version CHECK (source_version >= 1),
  CONSTRAINT ck_lifestyle_alcohol_baselines_status CHECK (
    status IN ('CURRENT', 'FORMER', 'NEVER', 'UNKNOWN', 'DECLINED')
  ),
  CONSTRAINT ck_lifestyle_alcohol_baselines_ever CHECK (
    ever_consumed IN ('YES', 'NO', 'UNKNOWN', 'DECLINED')
  ),
  CONSTRAINT ck_lifestyle_alcohol_baselines_recent CHECK (
    consumed_past_12_months IN ('YES', 'NO', 'UNKNOWN', 'DECLINED')
  ),
  CONSTRAINT ck_lifestyle_alcohol_baselines_other CHECK (
    other_beverage_description IS NULL OR btrim(other_beverage_description) <> ''
  ),
  CONSTRAINT ck_lifestyle_alcohol_baselines_hash CHECK (
    source_content_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ck_lifestyle_alcohol_baselines_source_time CHECK (
    source_updated_at >= source_created_at
  ),
  CONSTRAINT ck_lifestyle_alcohol_baselines_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_lifestyle_alcohol_baselines_source
    UNIQUE (installation_id, local_baseline_version_id),
  CONSTRAINT uq_lifestyle_alcohol_baselines_version
    UNIQUE (installation_id, person_id, source_version),
  CONSTRAINT uq_lifestyle_alcohol_baselines_context
    UNIQUE (id, installation_id, person_id)
);

CREATE TABLE lifestyle_alcohol_baseline_beverages (
  baseline_id uuid NOT NULL,
  beverage_type text NOT NULL,
  PRIMARY KEY (baseline_id, beverage_type),
  CONSTRAINT fk_lifestyle_alcohol_baseline_beverages_baseline
    FOREIGN KEY (baseline_id) REFERENCES lifestyle_alcohol_baselines (id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_lifestyle_alcohol_baseline_beverages_type CHECK (
    beverage_type IN ('BEER', 'WINE', 'SPIRITS', 'COCKTAILS', 'FORTIFIED_WINE', 'OTHER')
  )
);

CREATE TABLE lifestyle_tobacco_baselines (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  local_baseline_version_id uuid NOT NULL,
  source_version integer NOT NULL,
  status text NOT NULL,
  ever_regularly_used text NOT NULL,
  former_use_approximate_stop_date text NULL,
  current_use_frequency text NOT NULL,
  other_product_description text NULL,
  created_by_practitioner_id uuid NOT NULL,
  updated_by_practitioner_id uuid NOT NULL,
  source_content_hash text NOT NULL,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_lifestyle_tobacco_baselines_person FOREIGN KEY (person_id)
    REFERENCES persons (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_tobacco_baselines_installation FOREIGN KEY (installation_id)
    REFERENCES desktop_installations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_tobacco_baselines_created_by
    FOREIGN KEY (created_by_practitioner_id)
    REFERENCES practitioners (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_tobacco_baselines_updated_by
    FOREIGN KEY (updated_by_practitioner_id)
    REFERENCES practitioners (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_lifestyle_tobacco_baselines_version CHECK (source_version >= 1),
  CONSTRAINT ck_lifestyle_tobacco_baselines_status CHECK (
    status IN ('CURRENT_DAILY', 'CURRENT_SOME_DAYS', 'FORMER', 'NEVER', 'UNKNOWN', 'DECLINED')
  ),
  CONSTRAINT ck_lifestyle_tobacco_baselines_ever CHECK (
    ever_regularly_used IN ('YES', 'NO', 'UNKNOWN', 'DECLINED')
  ),
  CONSTRAINT ck_lifestyle_tobacco_baselines_frequency CHECK (
    current_use_frequency IN ('EVERY_DAY', 'SOME_DAYS', 'NOT_AT_ALL', 'UNKNOWN', 'DECLINED')
  ),
  CONSTRAINT ck_lifestyle_tobacco_baselines_stop_date CHECK (
    former_use_approximate_stop_date IS NULL
    OR former_use_approximate_stop_date ~ '^[0-9]{4}(-(0[1-9]|1[0-2]))?$'
  ),
  CONSTRAINT ck_lifestyle_tobacco_baselines_other CHECK (
    other_product_description IS NULL OR btrim(other_product_description) <> ''
  ),
  CONSTRAINT ck_lifestyle_tobacco_baselines_hash CHECK (
    source_content_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ck_lifestyle_tobacco_baselines_source_time CHECK (
    source_updated_at >= source_created_at
  ),
  CONSTRAINT ck_lifestyle_tobacco_baselines_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_lifestyle_tobacco_baselines_source
    UNIQUE (installation_id, local_baseline_version_id),
  CONSTRAINT uq_lifestyle_tobacco_baselines_version
    UNIQUE (installation_id, person_id, source_version),
  CONSTRAINT uq_lifestyle_tobacco_baselines_context
    UNIQUE (id, installation_id, person_id)
);

CREATE TABLE lifestyle_tobacco_baseline_products (
  baseline_id uuid NOT NULL,
  product_type text NOT NULL,
  PRIMARY KEY (baseline_id, product_type),
  CONSTRAINT fk_lifestyle_tobacco_baseline_products_baseline
    FOREIGN KEY (baseline_id) REFERENCES lifestyle_tobacco_baselines (id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_lifestyle_tobacco_baseline_products_type CHECK (
    product_type IN (
      'CIGARETTE', 'ROLLED_TOBACCO', 'CIGAR_PIPE', 'SMOKELESS',
      'SNUFF', 'HOOKAH', 'VAPE', 'OTHER'
    )
  )
);

CREATE TABLE lifestyle_work_baselines (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  local_baseline_version_id uuid NOT NULL,
  source_version integer NOT NULL,
  status text NOT NULL,
  occupation_job_title text NULL,
  usual_physical_demand text NULL,
  typical_workdays_per_week smallint NULL,
  typical_hours_per_workday numeric(4, 2) NULL,
  shift_pattern text NULL,
  description text NULL,
  created_by_practitioner_id uuid NOT NULL,
  updated_by_practitioner_id uuid NOT NULL,
  source_content_hash text NOT NULL,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_lifestyle_work_baselines_person FOREIGN KEY (person_id)
    REFERENCES persons (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_work_baselines_installation FOREIGN KEY (installation_id)
    REFERENCES desktop_installations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_work_baselines_created_by
    FOREIGN KEY (created_by_practitioner_id)
    REFERENCES practitioners (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_work_baselines_updated_by
    FOREIGN KEY (updated_by_practitioner_id)
    REFERENCES practitioners (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_lifestyle_work_baselines_version CHECK (source_version >= 1),
  CONSTRAINT ck_lifestyle_work_baselines_status CHECK (
    status IN (
      'EMPLOYED', 'SELF_EMPLOYED', 'FARMING', 'STUDENT',
      'HOMEMAKER_CAREGIVER', 'UNEMPLOYED', 'RETIRED', 'UNABLE_TO_WORK',
      'OTHER', 'DECLINED'
    )
  ),
  CONSTRAINT ck_lifestyle_work_baselines_demand CHECK (
    usual_physical_demand IS NULL
    OR usual_physical_demand IN (
      'SITTING', 'STANDING', 'WALKING', 'MODERATE_LABOR', 'HEAVY_LABOR', 'VARIES'
    )
  ),
  CONSTRAINT ck_lifestyle_work_baselines_days CHECK (
    typical_workdays_per_week IS NULL OR typical_workdays_per_week BETWEEN 0 AND 7
  ),
  CONSTRAINT ck_lifestyle_work_baselines_hours CHECK (
    typical_hours_per_workday IS NULL
    OR typical_hours_per_workday > 0 AND typical_hours_per_workday <= 24
  ),
  CONSTRAINT ck_lifestyle_work_baselines_shift CHECK (
    shift_pattern IS NULL
    OR shift_pattern IN (
      'DAY', 'EVENING', 'NIGHT', 'ROTATING', 'IRREGULAR',
      'NOT_APPLICABLE', 'UNKNOWN', 'DECLINED'
    )
  ),
  CONSTRAINT ck_lifestyle_work_baselines_text CHECK (
    (occupation_job_title IS NULL OR btrim(occupation_job_title) <> '')
    AND (description IS NULL OR btrim(description) <> '')
  ),
  CONSTRAINT ck_lifestyle_work_baselines_hash CHECK (
    source_content_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ck_lifestyle_work_baselines_source_time CHECK (
    source_updated_at >= source_created_at
  ),
  CONSTRAINT ck_lifestyle_work_baselines_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_lifestyle_work_baselines_source
    UNIQUE (installation_id, local_baseline_version_id),
  CONSTRAINT uq_lifestyle_work_baselines_version
    UNIQUE (installation_id, person_id, source_version),
  CONSTRAINT uq_lifestyle_work_baselines_context
    UNIQUE (id, installation_id, person_id)
);

CREATE TABLE lifestyle_assessments (
  id uuid PRIMARY KEY,
  encounter_id uuid NOT NULL,
  person_id uuid NOT NULL,
  screening_session_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  location_id uuid NOT NULL,
  protocol_id uuid NOT NULL,
  local_lifestyle_id uuid NOT NULL,
  source_location_id uuid NOT NULL,
  status text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  alcohol_baseline_id uuid NOT NULL,
  tobacco_baseline_id uuid NOT NULL,
  work_baseline_id uuid NOT NULL,
  created_by_practitioner_id uuid NOT NULL,
  updated_by_practitioner_id uuid NOT NULL,
  source_revision integer NOT NULL,
  source_content_hash text NOT NULL,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_lifestyle_assessments_encounter_context
    FOREIGN KEY (encounter_id, installation_id, person_id)
    REFERENCES screening_encounters (id, installation_id, person_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_assessments_session_context
    FOREIGN KEY (
      screening_session_id, installation_id, organization_id, location_id, protocol_id
    ) REFERENCES screening_sessions (
      id, installation_id, organization_id, location_id, protocol_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_assessments_source_location
    FOREIGN KEY (installation_id, source_location_id, location_id, organization_id)
    REFERENCES location_source_links (
      installation_id, source_location_id, location_id, organization_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_assessments_alcohol_baseline
    FOREIGN KEY (alcohol_baseline_id, installation_id, person_id)
    REFERENCES lifestyle_alcohol_baselines (id, installation_id, person_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_assessments_tobacco_baseline
    FOREIGN KEY (tobacco_baseline_id, installation_id, person_id)
    REFERENCES lifestyle_tobacco_baselines (id, installation_id, person_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_assessments_work_baseline
    FOREIGN KEY (work_baseline_id, installation_id, person_id)
    REFERENCES lifestyle_work_baselines (id, installation_id, person_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_assessments_created_by
    FOREIGN KEY (created_by_practitioner_id)
    REFERENCES practitioners (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_assessments_updated_by
    FOREIGN KEY (updated_by_practitioner_id)
    REFERENCES practitioners (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_lifestyle_assessments_status CHECK (status = 'COMPLETE'),
  CONSTRAINT ck_lifestyle_assessments_period CHECK (
    period_end = period_start + 6
  ),
  CONSTRAINT ck_lifestyle_assessments_revision CHECK (source_revision >= 1),
  CONSTRAINT ck_lifestyle_assessments_hash CHECK (
    source_content_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ck_lifestyle_assessments_source_time CHECK (
    source_updated_at >= source_created_at
  ),
  CONSTRAINT ck_lifestyle_assessments_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_lifestyle_assessments_encounter UNIQUE (encounter_id),
  CONSTRAINT uq_lifestyle_assessments_source UNIQUE (installation_id, local_lifestyle_id),
  CONSTRAINT uq_lifestyle_assessments_id_context
    UNIQUE (id, installation_id, person_id, encounter_id)
);

CREATE TABLE lifestyle_alcohol_weekly (
  lifestyle_assessment_id uuid PRIMARY KEY,
  local_weekly_record_id uuid NOT NULL,
  weekly_response text NOT NULL,
  drinking_days smallint NULL,
  total_standardized_drinks numeric(12, 4) NULL,
  largest_one_day_amount numeric(12, 4) NULL,
  days_at_largest_amount smallint NULL,
  other_beverage_description text NULL,
  created_by_practitioner_id uuid NOT NULL,
  updated_by_practitioner_id uuid NOT NULL,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_lifestyle_alcohol_weekly_assessment
    FOREIGN KEY (lifestyle_assessment_id) REFERENCES lifestyle_assessments (id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_lifestyle_alcohol_weekly_created_by
    FOREIGN KEY (created_by_practitioner_id) REFERENCES practitioners (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_alcohol_weekly_updated_by
    FOREIGN KEY (updated_by_practitioner_id) REFERENCES practitioners (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_lifestyle_alcohol_weekly_response CHECK (
    weekly_response IN ('YES', 'NO', 'UNKNOWN', 'DECLINED', 'NOT_APPLICABLE', 'PREFER_NOT_TO_ANSWER')
  ),
  CONSTRAINT ck_lifestyle_alcohol_weekly_quantities CHECK (
    (
      weekly_response = 'YES'
      AND drinking_days IS NOT NULL
      AND total_standardized_drinks IS NOT NULL
      AND largest_one_day_amount IS NOT NULL
      AND days_at_largest_amount IS NOT NULL
      AND drinking_days BETWEEN 1 AND 7
      AND total_standardized_drinks > 0
      AND largest_one_day_amount > 0
      AND days_at_largest_amount BETWEEN 1 AND 7
      AND largest_one_day_amount <= total_standardized_drinks
      AND days_at_largest_amount <= drinking_days
      AND largest_one_day_amount * days_at_largest_amount <= total_standardized_drinks
      AND (
        (drinking_days = days_at_largest_amount
          AND largest_one_day_amount * days_at_largest_amount = total_standardized_drinks)
        OR
        (drinking_days > days_at_largest_amount
          AND largest_one_day_amount * days_at_largest_amount < total_standardized_drinks)
      )
    )
    OR
    (
      weekly_response <> 'YES'
      AND drinking_days IS NULL
      AND total_standardized_drinks IS NULL
      AND largest_one_day_amount IS NULL
      AND days_at_largest_amount IS NULL
      AND other_beverage_description IS NULL
    )
  ),
  CONSTRAINT ck_lifestyle_alcohol_weekly_other CHECK (
    other_beverage_description IS NULL OR btrim(other_beverage_description) <> ''
  ),
  CONSTRAINT ck_lifestyle_alcohol_weekly_source_time CHECK (
    source_updated_at >= source_created_at
  ),
  CONSTRAINT ck_lifestyle_alcohol_weekly_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_lifestyle_alcohol_weekly_source
    UNIQUE (lifestyle_assessment_id, local_weekly_record_id)
);

CREATE TABLE lifestyle_alcohol_weekly_beverages (
  lifestyle_assessment_id uuid NOT NULL,
  beverage_type text NOT NULL,
  PRIMARY KEY (lifestyle_assessment_id, beverage_type),
  CONSTRAINT fk_lifestyle_alcohol_weekly_beverages_assessment
    FOREIGN KEY (lifestyle_assessment_id)
    REFERENCES lifestyle_alcohol_weekly (lifestyle_assessment_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_lifestyle_alcohol_weekly_beverages_type CHECK (
    beverage_type IN ('BEER', 'WINE', 'SPIRITS', 'COCKTAILS', 'FORTIFIED_WINE', 'OTHER')
  )
);

CREATE TABLE lifestyle_tobacco_weekly (
  lifestyle_assessment_id uuid PRIMARY KEY,
  local_weekly_record_id uuid NOT NULL,
  weekly_response text NOT NULL,
  created_by_practitioner_id uuid NOT NULL,
  updated_by_practitioner_id uuid NOT NULL,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_lifestyle_tobacco_weekly_assessment
    FOREIGN KEY (lifestyle_assessment_id) REFERENCES lifestyle_assessments (id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_lifestyle_tobacco_weekly_created_by
    FOREIGN KEY (created_by_practitioner_id) REFERENCES practitioners (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_tobacco_weekly_updated_by
    FOREIGN KEY (updated_by_practitioner_id) REFERENCES practitioners (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_lifestyle_tobacco_weekly_response CHECK (
    weekly_response IN ('YES', 'NO', 'UNKNOWN', 'DECLINED', 'NOT_APPLICABLE', 'PREFER_NOT_TO_ANSWER')
  ),
  CONSTRAINT ck_lifestyle_tobacco_weekly_source_time CHECK (
    source_updated_at >= source_created_at
  ),
  CONSTRAINT ck_lifestyle_tobacco_weekly_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_lifestyle_tobacco_weekly_source
    UNIQUE (lifestyle_assessment_id, local_weekly_record_id)
);

CREATE TABLE lifestyle_tobacco_products (
  id uuid PRIMARY KEY,
  lifestyle_assessment_id uuid NOT NULL,
  local_product_row_id uuid NOT NULL,
  sequence_number integer NOT NULL,
  product_type text NOT NULL,
  days_used smallint NOT NULL,
  average_quantity_per_use_day numeric(12, 4) NOT NULL,
  unit text NOT NULL,
  secondhand_smoke_exposure boolean NULL,
  other_product_description text NULL,
  other_unit_description text NULL,
  created_by_practitioner_id uuid NOT NULL,
  updated_by_practitioner_id uuid NOT NULL,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_lifestyle_tobacco_products_weekly
    FOREIGN KEY (lifestyle_assessment_id)
    REFERENCES lifestyle_tobacco_weekly (lifestyle_assessment_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_lifestyle_tobacco_products_created_by
    FOREIGN KEY (created_by_practitioner_id) REFERENCES practitioners (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_tobacco_products_updated_by
    FOREIGN KEY (updated_by_practitioner_id) REFERENCES practitioners (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_lifestyle_tobacco_products_sequence CHECK (sequence_number >= 1),
  CONSTRAINT ck_lifestyle_tobacco_products_type CHECK (
    product_type IN (
      'CIGARETTE', 'ROLLED_TOBACCO', 'CIGAR_PIPE', 'SMOKELESS',
      'SNUFF', 'HOOKAH', 'VAPE', 'OTHER'
    )
  ),
  CONSTRAINT ck_lifestyle_tobacco_products_days CHECK (days_used BETWEEN 1 AND 7),
  CONSTRAINT ck_lifestyle_tobacco_products_quantity CHECK (
    average_quantity_per_use_day > 0
  ),
  CONSTRAINT ck_lifestyle_tobacco_products_unit CHECK (
    unit IN ('STICKS_CIGARETTES', 'SESSIONS', 'PORTIONS', 'PINS', 'PODS_CARTRIDGES', 'OTHER')
  ),
  CONSTRAINT ck_lifestyle_tobacco_products_other CHECK (
    (product_type = 'OTHER') = (other_product_description IS NOT NULL)
    AND (unit = 'OTHER') = (other_unit_description IS NOT NULL)
    AND (other_product_description IS NULL OR btrim(other_product_description) <> '')
    AND (other_unit_description IS NULL OR btrim(other_unit_description) <> '')
  ),
  CONSTRAINT ck_lifestyle_tobacco_products_source_time CHECK (
    source_updated_at >= source_created_at
  ),
  CONSTRAINT ck_lifestyle_tobacco_products_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_lifestyle_tobacco_products_source
    UNIQUE (lifestyle_assessment_id, local_product_row_id),
  CONSTRAINT uq_lifestyle_tobacco_products_sequence
    UNIQUE (lifestyle_assessment_id, sequence_number),
  CONSTRAINT uq_lifestyle_tobacco_products_type
    UNIQUE (lifestyle_assessment_id, product_type)
);

CREATE TABLE lifestyle_physical_activity_weekly (
  lifestyle_assessment_id uuid PRIMARY KEY,
  local_weekly_record_id uuid NOT NULL,
  weekly_response text NOT NULL,
  sedentary_time_response text NOT NULL,
  sedentary_minutes_per_day smallint NULL,
  created_by_practitioner_id uuid NOT NULL,
  updated_by_practitioner_id uuid NOT NULL,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_lifestyle_physical_activity_weekly_assessment
    FOREIGN KEY (lifestyle_assessment_id) REFERENCES lifestyle_assessments (id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_lifestyle_physical_activity_weekly_created_by
    FOREIGN KEY (created_by_practitioner_id) REFERENCES practitioners (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_physical_activity_weekly_updated_by
    FOREIGN KEY (updated_by_practitioner_id) REFERENCES practitioners (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_lifestyle_physical_activity_weekly_response CHECK (
    weekly_response IN (
      'YES', 'NO', 'UNKNOWN', 'DECLINED', 'NOT_APPLICABLE',
      'UNABLE_TO_ANSWER', 'PREFER_NOT_TO_ANSWER'
    )
  ),
  CONSTRAINT ck_lifestyle_physical_activity_weekly_sedentary_response CHECK (
    sedentary_time_response IN (
      'RECORDED', 'UNKNOWN', 'UNABLE_TO_ANSWER', 'DECLINED', 'PREFER_NOT_TO_ANSWER'
    )
  ),
  CONSTRAINT ck_lifestyle_physical_activity_weekly_sedentary_value CHECK (
    (sedentary_time_response = 'RECORDED'
      AND sedentary_minutes_per_day IS NOT NULL
      AND sedentary_minutes_per_day BETWEEN 0 AND 1439)
    OR (sedentary_time_response <> 'RECORDED' AND sedentary_minutes_per_day IS NULL)
  ),
  CONSTRAINT ck_lifestyle_physical_activity_weekly_source_time CHECK (
    source_updated_at >= source_created_at
  ),
  CONSTRAINT ck_lifestyle_physical_activity_weekly_updated_at CHECK (
    updated_at >= created_at
  ),
  CONSTRAINT uq_lifestyle_physical_activity_weekly_source
    UNIQUE (lifestyle_assessment_id, local_weekly_record_id)
);

CREATE TABLE lifestyle_physical_activities (
  id uuid PRIMARY KEY,
  lifestyle_assessment_id uuid NOT NULL,
  local_activity_row_id uuid NOT NULL,
  sequence_number integer NOT NULL,
  activity_domain text NOT NULL,
  description text NULL,
  intensity text NOT NULL,
  days_in_past_seven_days smallint NOT NULL,
  average_minutes_per_active_day smallint NOT NULL,
  created_by_practitioner_id uuid NOT NULL,
  updated_by_practitioner_id uuid NOT NULL,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_lifestyle_physical_activities_weekly
    FOREIGN KEY (lifestyle_assessment_id)
    REFERENCES lifestyle_physical_activity_weekly (lifestyle_assessment_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_lifestyle_physical_activities_created_by
    FOREIGN KEY (created_by_practitioner_id) REFERENCES practitioners (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_physical_activities_updated_by
    FOREIGN KEY (updated_by_practitioner_id) REFERENCES practitioners (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_lifestyle_physical_activities_sequence CHECK (sequence_number >= 1),
  CONSTRAINT ck_lifestyle_physical_activities_domain CHECK (
    activity_domain IN ('WORK_OR_FARMING', 'TRANSPORT', 'HOUSEHOLD', 'EXERCISE')
  ),
  CONSTRAINT ck_lifestyle_physical_activities_description CHECK (
    description IS NULL OR btrim(description) <> ''
  ),
  CONSTRAINT ck_lifestyle_physical_activities_intensity CHECK (
    intensity IN ('LIGHT', 'MODERATE', 'VIGOROUS')
  ),
  CONSTRAINT ck_lifestyle_physical_activities_days CHECK (
    days_in_past_seven_days BETWEEN 1 AND 7
  ),
  CONSTRAINT ck_lifestyle_physical_activities_minutes CHECK (
    average_minutes_per_active_day BETWEEN 1 AND 1440
  ),
  CONSTRAINT ck_lifestyle_physical_activities_source_time CHECK (
    source_updated_at >= source_created_at
  ),
  CONSTRAINT ck_lifestyle_physical_activities_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_lifestyle_physical_activities_source
    UNIQUE (lifestyle_assessment_id, local_activity_row_id),
  CONSTRAINT uq_lifestyle_physical_activities_sequence
    UNIQUE (lifestyle_assessment_id, sequence_number)
);

CREATE TABLE lifestyle_work_weekly (
  lifestyle_assessment_id uuid PRIMARY KEY,
  local_weekly_record_id uuid NOT NULL,
  weekly_response text NOT NULL,
  created_by_practitioner_id uuid NOT NULL,
  updated_by_practitioner_id uuid NOT NULL,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_lifestyle_work_weekly_assessment
    FOREIGN KEY (lifestyle_assessment_id) REFERENCES lifestyle_assessments (id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_lifestyle_work_weekly_created_by
    FOREIGN KEY (created_by_practitioner_id) REFERENCES practitioners (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_work_weekly_updated_by
    FOREIGN KEY (updated_by_practitioner_id) REFERENCES practitioners (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_lifestyle_work_weekly_response CHECK (
    weekly_response IN (
      'USUAL', 'LESS_THAN_USUAL', 'MORE_THAN_USUAL', 'NO_WORK',
      'NOT_APPLICABLE', 'UNKNOWN', 'DECLINED', 'PREFER_NOT_TO_ANSWER'
    )
  ),
  CONSTRAINT ck_lifestyle_work_weekly_source_time CHECK (
    source_updated_at >= source_created_at
  ),
  CONSTRAINT ck_lifestyle_work_weekly_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_lifestyle_work_weekly_source
    UNIQUE (lifestyle_assessment_id, local_weekly_record_id)
);

CREATE TABLE lifestyle_other_activity_weekly (
  lifestyle_assessment_id uuid PRIMARY KEY,
  weekly_response text NOT NULL,
  CONSTRAINT fk_lifestyle_other_activity_weekly_assessment
    FOREIGN KEY (lifestyle_assessment_id) REFERENCES lifestyle_assessments (id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_lifestyle_other_activity_weekly_response CHECK (
    weekly_response IN ('YES', 'NO', 'UNKNOWN', 'DECLINED', 'PREFER_NOT_TO_ANSWER')
  )
);

CREATE TABLE lifestyle_other_activities (
  id uuid PRIMARY KEY,
  lifestyle_assessment_id uuid NOT NULL,
  local_activity_row_id uuid NOT NULL,
  sequence_number integer NOT NULL,
  category text NOT NULL,
  description text NULL,
  days_in_past_seven_days smallint NOT NULL,
  average_minutes_per_day smallint NOT NULL,
  intensity text NOT NULL,
  created_by_practitioner_id uuid NOT NULL,
  updated_by_practitioner_id uuid NOT NULL,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_lifestyle_other_activities_weekly
    FOREIGN KEY (lifestyle_assessment_id)
    REFERENCES lifestyle_other_activity_weekly (lifestyle_assessment_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_lifestyle_other_activities_created_by
    FOREIGN KEY (created_by_practitioner_id) REFERENCES practitioners (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lifestyle_other_activities_updated_by
    FOREIGN KEY (updated_by_practitioner_id) REFERENCES practitioners (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_lifestyle_other_activities_sequence CHECK (sequence_number >= 1),
  CONSTRAINT ck_lifestyle_other_activities_category CHECK (
    category IN (
      'FARMING_GARDENING', 'HOUSEHOLD', 'CAREGIVING', 'COMMUNITY',
      'COMMUTE', 'SPORT', 'OTHER'
    )
  ),
  CONSTRAINT ck_lifestyle_other_activities_description CHECK (
    description IS NULL OR btrim(description) <> ''
  ),
  CONSTRAINT ck_lifestyle_other_activities_days CHECK (
    days_in_past_seven_days BETWEEN 1 AND 7
  ),
  CONSTRAINT ck_lifestyle_other_activities_minutes CHECK (
    average_minutes_per_day BETWEEN 1 AND 1440
  ),
  CONSTRAINT ck_lifestyle_other_activities_intensity CHECK (
    intensity IN ('LIGHT', 'MODERATE', 'VIGOROUS')
  ),
  CONSTRAINT ck_lifestyle_other_activities_source_time CHECK (
    source_updated_at >= source_created_at
  ),
  CONSTRAINT ck_lifestyle_other_activities_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_lifestyle_other_activities_source
    UNIQUE (lifestyle_assessment_id, local_activity_row_id),
  CONSTRAINT uq_lifestyle_other_activities_sequence
    UNIQUE (lifestyle_assessment_id, sequence_number)
);

CREATE INDEX ix_lifestyle_assessments_person_period
  ON lifestyle_assessments (person_id, period_end DESC, id);

ALTER TABLE sync_records
  ADD COLUMN lifestyle_assessment_id uuid NULL;

ALTER TABLE sync_records
  ADD CONSTRAINT fk_sync_records_lifestyle_assessment
  FOREIGN KEY (lifestyle_assessment_id)
  REFERENCES lifestyle_assessments (id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE sync_records
  DROP CONSTRAINT ck_sync_records_resource_type;

ALTER TABLE sync_records
  ADD CONSTRAINT ck_sync_records_resource_type CHECK (
    resource_type IN (
      'PATIENT', 'SCREENING_SESSION', 'SCREENING_ENCOUNTER', 'VITALS', 'LIFESTYLE'
    )
  );

ALTER TABLE sync_records
  DROP CONSTRAINT ck_sync_records_target_type;

ALTER TABLE sync_records
  ADD CONSTRAINT ck_sync_records_target_type CHECK (
    (
      status IN ('PROCESSING', 'REJECTED', 'RETRY')
      AND person_id IS NULL
      AND screening_session_id IS NULL
      AND screening_encounter_id IS NULL
      AND screening_vital_set_id IS NULL
      AND lifestyle_assessment_id IS NULL
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
      AND lifestyle_assessment_id IS NULL
      AND identity_review_case_id IS NOT NULL
    )
    OR
    (
      status IN ('ACCEPTED', 'UNCHANGED')
      AND (
        (resource_type = 'PATIENT' AND person_id IS NOT NULL
          AND screening_session_id IS NULL AND screening_encounter_id IS NULL
          AND screening_vital_set_id IS NULL AND lifestyle_assessment_id IS NULL
          AND identity_review_case_id IS NULL)
        OR
        (resource_type = 'SCREENING_SESSION' AND person_id IS NULL
          AND screening_session_id IS NOT NULL AND screening_encounter_id IS NULL
          AND screening_vital_set_id IS NULL AND lifestyle_assessment_id IS NULL
          AND identity_review_case_id IS NULL)
        OR
        (resource_type = 'SCREENING_ENCOUNTER' AND person_id IS NULL
          AND screening_session_id IS NULL AND screening_encounter_id IS NOT NULL
          AND screening_vital_set_id IS NULL AND lifestyle_assessment_id IS NULL
          AND identity_review_case_id IS NULL)
        OR
        (resource_type = 'VITALS' AND person_id IS NULL
          AND screening_session_id IS NULL AND screening_encounter_id IS NULL
          AND screening_vital_set_id IS NOT NULL AND lifestyle_assessment_id IS NULL
          AND identity_review_case_id IS NULL)
        OR
        (resource_type = 'LIFESTYLE' AND person_id IS NULL
          AND screening_session_id IS NULL AND screening_encounter_id IS NULL
          AND screening_vital_set_id IS NULL AND lifestyle_assessment_id IS NOT NULL
          AND identity_review_case_id IS NULL)
      )
    )
  );
