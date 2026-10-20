CREATE TABLE provider_requests (
 id uuid PRIMARY KEY,
 requester_issuer text NOT NULL,
 requester_subject text NOT NULL,
 organization_name text NOT NULL CHECK(length(btrim(organization_name)) BETWEEN 1 AND 120),
 registration_identifier text NOT NULL CHECK(length(btrim(registration_identifier)) BETWEEN 1 AND 120),
 contact_email text NOT NULL,
 purpose text NOT NULL CHECK(length(btrim(purpose)) BETWEEN 10 AND 1000),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED','SUSPENDED')),
 reviewed_by uuid NULL REFERENCES operations_users(id),
 review_reason text NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 reviewed_at timestamptz NULL
);
CREATE UNIQUE INDEX uq_provider_request_pending ON provider_requests(requester_issuer,requester_subject) WHERE status='PENDING';
CREATE TABLE provider_clients (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL UNIQUE REFERENCES provider_requests(id),
 oidc_issuer text NOT NULL,
 oidc_subject text NOT NULL,
 oidc_client_id text NOT NULL UNIQUE,
 identity_client_id uuid NOT NULL UNIQUE,
 status text NOT NULL CHECK(status IN ('ACTIVE','REVOKED')),
 scopes text[] NOT NULL CHECK(cardinality(scopes) BETWEEN 1 AND 2 AND scopes <@ ARRAY['history:read','fhir:read']::text[]),
 expires_at timestamptz NOT NULL,
 tokens_valid_after timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(oidc_issuer,oidc_subject)
);
CREATE TABLE provider_organization_grants (
 client_id uuid NOT NULL REFERENCES provider_clients(id),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 PRIMARY KEY(client_id,organization_id)
);
CREATE TABLE provider_patient_grants (
 client_id uuid NOT NULL REFERENCES provider_clients(id),
 person_id uuid NOT NULL REFERENCES persons(id),
 basis text NOT NULL CHECK(length(btrim(basis)) BETWEEN 10 AND 500),
 granted_by uuid NOT NULL REFERENCES operations_users(id),
 expires_at timestamptz NOT NULL,
 active boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(client_id,person_id)
);
CREATE INDEX ix_provider_patient_access ON provider_patient_grants(client_id,person_id,expires_at) WHERE active;
