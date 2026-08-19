CREATE TABLE desktop_installation_credentials (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL,
  token_prefix text NOT NULL,
  token_hash text NOT NULL,
  label text NOT NULL,
  status text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NULL,
  revoked_at timestamptz NULL,
  last_used_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fk_desktop_installation_credentials_installation
    FOREIGN KEY (installation_id)
    REFERENCES desktop_installations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_desktop_installation_credentials_prefix CHECK (
    token_prefix ~ '^chs_inst_v1_[A-Za-z0-9_-]{8}$'
  ),
  CONSTRAINT ck_desktop_installation_credentials_hash CHECK (
    token_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ck_desktop_installation_credentials_label_not_blank
    CHECK (btrim(label) <> ''),
  CONSTRAINT ck_desktop_installation_credentials_status
    CHECK (status IN ('ACTIVE', 'REVOKED')),
  CONSTRAINT ck_desktop_installation_credentials_revocation CHECK (
    (status = 'ACTIVE' AND revoked_at IS NULL)
    OR
    (status = 'REVOKED' AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT ck_desktop_installation_credentials_expiry CHECK (
    expires_at IS NULL OR expires_at > issued_at
  ),
  CONSTRAINT ck_desktop_installation_credentials_last_used CHECK (
    last_used_at IS NULL OR last_used_at >= issued_at
  ),
  CONSTRAINT ck_desktop_installation_credentials_updated_at
    CHECK (updated_at >= created_at),
  CONSTRAINT uq_desktop_installation_credentials_hash UNIQUE (token_hash),
  CONSTRAINT uq_desktop_installation_credentials_prefix
    UNIQUE (installation_id, token_prefix)
);

CREATE INDEX ix_desktop_installation_credentials_installation_status
  ON desktop_installation_credentials (installation_id, status, expires_at);
