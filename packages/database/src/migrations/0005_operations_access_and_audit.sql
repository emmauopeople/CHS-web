CREATE TABLE operations_users (
  id uuid PRIMARY KEY,
  oidc_issuer text NOT NULL,
  oidc_subject text NOT NULL,
  display_name text NOT NULL,
  email text NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT ck_operations_users_issuer_not_blank CHECK (btrim(oidc_issuer) <> ''),
  CONSTRAINT ck_operations_users_subject_not_blank CHECK (btrim(oidc_subject) <> ''),
  CONSTRAINT ck_operations_users_display_name_not_blank CHECK (btrim(display_name) <> ''),
  CONSTRAINT ck_operations_users_status CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  CONSTRAINT ck_operations_users_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_operations_users_oidc_principal UNIQUE (oidc_issuer, oidc_subject)
);

CREATE TABLE operations_access_grants (
  id uuid PRIMARY KEY,
  operations_user_id uuid NOT NULL,
  permission_code text NOT NULL,
  scope_kind text NOT NULL,
  organization_id uuid NULL,
  active boolean NOT NULL DEFAULT true,
  granted_at timestamptz NOT NULL,
  expires_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_operations_access_grants_user FOREIGN KEY (operations_user_id)
    REFERENCES operations_users (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_operations_access_grants_organization FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_operations_access_grants_permission CHECK (
    permission_code IN (
      'PATIENT_READ',
      'MEDICAL_ID_RECOVER',
      'IDENTITY_REVIEW',
      'AUDIT_READ'
    )
  ),
  CONSTRAINT ck_operations_access_grants_scope CHECK (
    (scope_kind = 'GLOBAL' AND organization_id IS NULL)
    OR
    (scope_kind = 'ORGANIZATION' AND organization_id IS NOT NULL)
  ),
  CONSTRAINT ck_operations_access_grants_period CHECK (
    expires_at IS NULL OR expires_at > granted_at
  ),
  CONSTRAINT ck_operations_access_grants_updated_at CHECK (updated_at >= created_at),
  CONSTRAINT uq_operations_access_grants UNIQUE NULLS NOT DISTINCT (
    operations_user_id,
    permission_code,
    scope_kind,
    organization_id
  )
);

ALTER TABLE audit_events
  ADD COLUMN operations_user_id uuid NULL,
  ADD COLUMN outcome_code text NOT NULL DEFAULT 'UNKNOWN',
  ADD CONSTRAINT fk_audit_events_operations_user FOREIGN KEY (operations_user_id)
    REFERENCES operations_users (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT ck_audit_events_outcome CHECK (
    outcome_code IN ('SUCCESS', 'DENIED', 'NOT_FOUND', 'ERROR', 'UNKNOWN')
  );

ALTER TABLE audit_events ALTER COLUMN outcome_code DROP DEFAULT;

CREATE INDEX ix_operations_access_grants_authorization
  ON operations_access_grants (
    operations_user_id,
    permission_code,
    active,
    scope_kind,
    organization_id
  );

CREATE INDEX ix_audit_events_operations_user_time
  ON audit_events (operations_user_id, occurred_at DESC)
  WHERE operations_user_id IS NOT NULL;
