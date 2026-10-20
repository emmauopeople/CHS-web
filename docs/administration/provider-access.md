# Hospital and provider access

Provider access is a separate OAuth2 client-credentials boundary. Desktop tokens cannot call provider routes; provider tokens cannot submit desktop batches or administer portal users. Browser staff/admin accounts remain separate from hospital machine identities.

## Onboard a hospital

1. In **Provider Access**, submit the hospital's name, registration identifier, integration contact and purpose. An operator can submit on behalf of the hospital. No email is sent automatically.
2. A super admin loads requests and verifies the hospital identity, agreement and intended use outside the application. Approve only the source organizations that may share data. The initial approval supports `history:read` and `fhir:read`, expires within 366 days, and records the reviewer and reason. Reject unapproved requests with a reason.
3. Approval creates an isolated Keycloak confidential client with service accounts, no browser/password grants, no administrative roles and a five-minute access-token lifetime. Its client ID, token endpoint and secret appear once. Deliver the secret using the hospital's approved confidential channel; do not paste it in GitHub, logs or email automation. PostgreSQL stores identity references and grants, not client secrets.
4. Approval alone permits no patient retrieval. Under **Authorize patient sharing**, select the approved hospital and use **Find patient reference** with the CHS Medical ID (or enter a known canonical patient UUID). The lookup uses the existing audited, scoped patient-search API. Record the verified authorization basis and set an expiry of at most 90 days. The patient must have a source link within the hospital's permitted organizations. A Medical ID or screening acknowledgment alone never creates this authorization.
5. Confirm retrieval with a synthetic patient before operational use. Revoke sharing when its purpose ends. Provider/client expiry, source-organization deactivation and patient-grant expiry are checked on every read and page.

Administrators with the organization Admin role cannot approve provider access or grant patient sharing. These operations require an active global Super Admin and a current `USER_MANAGE` grant. An authenticated identity can submit one pending request at a time.

## Integration contract

Obtain a token with `grant_type=client_credentials`, the displayed client ID and secret at the displayed token endpoint. The audience is `chs-operations-api`; effective API capabilities are read from the approved client's current PostgreSQL scopes and grants, rather than trusted from stale role claims.

Send `Authorization: Bearer ACCESS_TOKEN`, JSON request bodies and `Cache-Control: no-store`. Patient identifiers are in POST bodies, not URLs. Care reasons are `CARE_DELIVERY`, `CARE_COORDINATION`, or `PATIENT_REQUEST`.

`POST /api/v1/providers/patients/history` accepts the existing operations history contract: `contractVersion: "1.0"`, `personId`, `reasonCode`, `fromDate`, `toDate`, optional `resourceTypes`, `limit` and opaque `cursor`. Date windows are bounded to less than 366 days, pages to 50 records and cursors to fifteen minutes. Scope is server-derived. Current permissions are rechecked for every page; downloaded records preserve author, source and occurrence time. This endpoint includes all eleven synchronized clinical/history domains.

`POST /api/v1/providers/fhir/patient` accepts `personId`, `reasonCode`, optional `page` (1–200) and `generation`. It returns `{bundle, generation, nextPage}`. The bundle is a FHIR R4 collection of at most 25 resources. Continue with the same generation and `nextPage`. A changed publication generation returns `409 FHIR_PAGE_STALE`; restart at page one. Pending, failed or newer unpublished source data returns `503 FHIR_PUBLICATION_NOT_READY`. Authorization is rechecked after remote resource reads and before the audited response is committed. The API never forwards arbitrary FHIR searches or `$everything` calls.

The first provider interface is a bounded patient-collection API, not a SMART-on-FHIR launch server or an unrestricted FHIR REST endpoint. Each entry has a deterministic UUID URN full URL; references are rewritten to the same URN namespace so integrations can assemble all pages of a generation without contacting internal server URLs. Published resource IDs remain unchanged. Organization/location metadata and clinical resources are restricted to permitted source organizations.

## Rotate and revoke

Credential rotation returns a new secret once and invalidates access tokens issued before the database rotation timestamp. Obtain a fresh token after rotation; tokens use second precision, so a token issued during the rotation second can require a retry in the following second. Old refresh tokens are not used by this flow.

Whole-client revocation commits the database denial before attempting to disable the identity client, so existing JWTs cannot continue accessing CHS even if Keycloak is unavailable. A failed identity disable can be retried safely. Individual patient access can be revoked without disabling the hospital's other grants. Successful actions and denials are audited without credentials or clinical payloads.

Identity and PostgreSQL are separate systems. If the remote identity change succeeds but its response or database commit fails, retry or inspect the client's identity state; do not invent a replacement secret. Approval cleans up a newly created identity if provisioning fails. Unknown orphan identities have no approved CHS client/grants and cannot read patient data.

## Deployment

Run the ordinary deployment setup to generate `.deployment/secrets/provider_identity_client_secret`, build tools, apply migrations, then run:

```powershell
docker compose --env-file .deployment/deploy.env -f compose.deploy.yaml --profile tools run --rm provider-bootstrap
```

Only this operator tool receives the Keycloak master administrator secret. It creates `chs-provider-admin` with CHS-realm `manage-clients` and `view-clients` roles. The API receives only its dedicated service secret. The separate portal-account service keeps its original user-management permissions.

The adapter uses the [Keycloak Admin REST API](https://www.keycloak.org/docs-api/26.7.3/rest-api/index.html). See [FHIR publication](../fhir/publication.md) and [combined acceptance](../sync/HSW-019F-pilot-acceptance.md).
