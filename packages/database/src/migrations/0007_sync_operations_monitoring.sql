ALTER TABLE operations_access_grants
  DROP CONSTRAINT ck_operations_access_grants_permission;

ALTER TABLE operations_access_grants
  ADD CONSTRAINT ck_operations_access_grants_permission CHECK (
    permission_code IN (
      'PATIENT_READ',
      'MEDICAL_ID_RECOVER',
      'SYNC_MONITOR',
      'IDENTITY_REVIEW',
      'AUDIT_READ'
    )
  );

CREATE INDEX ix_sync_batches_operations_status_received
  ON sync_batches (organization_id, status, received_at DESC, id);

CREATE INDEX ix_sync_batches_operations_installation_received
  ON sync_batches (organization_id, installation_id, received_at DESC, id);

CREATE INDEX ix_sync_records_operations_outcomes
  ON sync_records (batch_internal_id, resource_type, status);
