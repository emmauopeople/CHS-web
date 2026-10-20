ALTER TABLE operations_users DROP CONSTRAINT ck_operations_users_account_role;
ALTER TABLE operations_users ADD CONSTRAINT ck_operations_users_account_role
  CHECK (account_role IN ('STAFF','ADMIN','SUPER_ADMIN','FHIR_VIEWER'));
ALTER TABLE operations_access_grants DROP CONSTRAINT ck_operations_access_grants_permission;
ALTER TABLE operations_access_grants ADD CONSTRAINT ck_operations_access_grants_permission
  CHECK (permission_code IN ('PATIENT_READ','MEDICAL_ID_RECOVER','SYNC_MONITOR',
    'IDENTITY_REVIEW','IDENTITY_REVIEW_RESOLVE','AUDIT_READ',
    'DESKTOP_INSTALLATION_MANAGE','USER_MANAGE','FHIR_READ'));
-- Existing administrators receive the same scope and expiry as their management grant.
INSERT INTO operations_access_grants(id,operations_user_id,permission_code,scope_kind,organization_id,active,granted_at,expires_at,created_at,updated_at)
SELECT gen_random_uuid(),g.operations_user_id,'FHIR_READ',g.scope_kind,g.organization_id,g.active,g.granted_at,g.expires_at,now(),now()
FROM operations_access_grants g JOIN operations_users u ON u.id=g.operations_user_id
WHERE g.permission_code='USER_MANAGE' AND u.account_role IN ('ADMIN','SUPER_ADMIN');
