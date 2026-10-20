ALTER TABLE operations_access_grants
  DROP CONSTRAINT ck_operations_access_grants_permission;

ALTER TABLE operations_access_grants
  ADD CONSTRAINT ck_operations_access_grants_permission CHECK (
    permission_code IN (
      'PATIENT_READ', 'MEDICAL_ID_RECOVER', 'SYNC_MONITOR',
      'IDENTITY_REVIEW', 'IDENTITY_REVIEW_RESOLVE', 'AUDIT_READ',
      'DESKTOP_INSTALLATION_MANAGE'
    )
  );
