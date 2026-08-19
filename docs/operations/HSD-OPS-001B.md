# HSD-OPS-001B: Authenticated and audited patient access

Status: Draft for implementation review

## Purpose

This increment exposes the canonical patient query service through a protected
HTTP boundary for the future temporary React operations viewer. It adds human
OIDC authentication, deny-by-default database authorization, mandatory
reason-for-access, and durable sensitive-read auditing.

It does not create a password database. Human credentials, multifactor
authentication, login sessions, account recovery, and token issuance remain the
responsibility of the configured OpenID Connect identity provider.

## Authentication

The API accepts an OIDC access token only in the `Authorization: Bearer` header.
It validates:

- an RS256 signature using a cached remote JWKS;
- the configured issuer and API audience;
- token expiry, optional not-before time, and optional issued-at time;
- a non-empty OIDC subject and signing-key identifier;
- bounded token and JWKS sizes.

Production JWKS URLs must use HTTPS. JWKS retrieval has a short timeout and a
bounded cache lifetime. Authentication fails closed when OIDC is not configured
or the key service is unavailable. Tokens and claims are never logged.

Required runtime configuration:

- `OPERATIONS_OIDC_ISSUER`
- `OPERATIONS_OIDC_AUDIENCE`
- `OPERATIONS_OIDC_JWKS_URL`
- `OPERATIONS_OIDC_CLOCK_TOLERANCE_SECONDS`

`TRUSTED_PROXY_CIDRS` must contain only the ingress or load-balancer proxy
ranges that are allowed to supply forwarded client addresses. It is empty by
default so an untrusted caller cannot spoof the source IP stored in audit data.

## Enrollment and authorization

Migration `0005_operations_access_and_audit.sql` adds:

- `operations_users`, which binds a pre-enrolled internal user to an exact OIDC
  issuer and subject;
- `operations_access_grants`, which assigns one permission at global or
  organization scope;
- operations-user and outcome fields on `audit_events`.

OIDC token validity does not create an application account. A valid but unknown,
suspended, expired, or ungranted principal is denied. This prevents identity
provider membership from automatically granting access to patient data.

The patient endpoints require an active `PATIENT_READ` grant. A global grant
creates a global query scope; otherwise the API composes the caller's active
organization grants. Global flags and organization identifiers are not accepted
from the browser.

Separate permission codes are reserved for Medical ID recovery, identity review,
and audit access. They do not implicitly grant patient viewing and are not
activated by this increment.

## HTTP endpoints

- `POST /api/v1/operations/patients/search`
- `POST /api/v1/operations/patients/detail`

Search terms, Medical IDs, dates of birth, and canonical person IDs are carried
in JSON request bodies rather than URL paths or query strings. Both bodies
require one controlled `reasonCode`:

- `CARE_DELIVERY`
- `CARE_COORDINATION`
- `PATIENT_REQUEST`
- `QUALITY_IMPROVEMENT`
- `OPERATIONS_SUPPORT`

Only canonical accepted data is returned. Organization filters are applied by
the server after authorization. The detail endpoint returns `404` both when a
person does not exist and when that person is outside the authorized scope.

## Sensitive-read audit

Every authorized list or detail attempt writes an audit record before any
patient response is returned. Verified identities that are unenrolled,
suspended, or missing `PATIENT_READ` are also durably audited as denied. An
invalid or unverifiable bearer token has no trusted application identity and is
reported only through redacted security logging.

Audit records include:

- application user, action, outcome, reason, time, and request ID;
- target person for detail reads;
- effective scope and organization context;
- source IP, bounded user agent, OIDC session ID, and authorized client;
- pagination and result-count context where applicable.

Audit metadata never includes names, search values, Medical IDs, DOB values,
phone numbers, returned clinical values, tokens, or raw request bodies. If the
audit insert fails, the patient response fails closed.

## Verification

- unit tests validate RS256 tokens, issuer/audience/time claims, JWKS caching,
  unavailable identity services, and configuration rules;
- migration tests validate the new enrollment/grant model and audit columns;
- PostgreSQL route tests verify mandatory reasons, bearer authentication,
  organization isolation, global grants, rejected client scope injection,
  scoped not-found behavior, and redacted success/denial audits;
- repository lint, type-check, unit, integration, build, migration, and CI gates
  remain required.

## Out of scope

This increment does not build the React viewer, provision users through a UI,
implement Medical ID recovery, expose identity-review queues, implement hospital
or provider OAuth2 access, map FHIR resources, publish to a FHIR server, or add
LLM analysis.
