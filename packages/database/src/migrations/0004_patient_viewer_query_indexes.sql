CREATE INDEX ix_persons_viewer_status_name_prefix
  ON persons (status, name_normalized text_pattern_ops, id);

CREATE INDEX ix_screening_encounters_viewer_history
  ON screening_encounters (person_id, started_at DESC, id)
  WHERE status <> 'VOID';
