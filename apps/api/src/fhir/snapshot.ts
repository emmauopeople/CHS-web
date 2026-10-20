import type { PoolClient } from 'pg';
import { historyPayload } from '../history/queries.js';
import type { HistoryResourceType } from '../../../../packages/contracts/src/patient-history.mjs';
import { mapFhirSnapshot, type Row } from './mapping.js';
export async function loadFhirSnapshot(db: PoolClient, personId: string) {
  const rows = async (sql: string) => {
    const result = (
      await db.query<Row>(/\bLIMIT\b/i.test(sql) ? sql : `${sql} LIMIT 5001`, [
        personId,
      ])
    ).rows;
    if (result.length > 5000) throw new Error('FHIR_PATIENT_LIMIT');
    return result;
  };
  const [person] = await rows(
    'SELECT *,date_of_birth::text AS birth_date,age_as_of_date::text AS age_date FROM persons WHERE id=$1',
  );
  if (!person) throw new Error('FHIR_PERSON_NOT_FOUND');
  const identifiers = await rows(
    "SELECT * FROM person_identifiers WHERE person_id=$1 AND status='ACTIVE' ORDER BY id",
  );
  const encounters = await rows(
    `SELECT e.*,p.display_name AS author_name FROM screening_encounters e JOIN practitioners p ON p.id=e.recorded_by_practitioner_id WHERE e.person_id=$1 ORDER BY e.id LIMIT 501`,
  );
  if (encounters.length > 500) throw new Error('FHIR_PATIENT_LIMIT');
  const organizations = await rows(
    'SELECT DISTINCT o.* FROM organizations o JOIN screening_encounters e ON e.organization_id=o.id WHERE e.person_id=$1 ORDER BY o.id',
  );
  const locations = await rows(
    'SELECT DISTINCT l.* FROM locations l JOIN screening_encounters e ON e.location_id=l.id WHERE e.person_id=$1 ORDER BY l.id',
  );
  const vitalSets = await rows(
    'SELECT * FROM screening_vital_sets WHERE person_id=$1 ORDER BY id',
  );
  const readings = await rows(
    `SELECT r.*,r.measurement_local_date::text AS measurement_date,v.encounter_id,v.status vital_status FROM vital_readings r JOIN screening_vital_sets v ON v.id=r.vital_set_id WHERE v.person_id=$1 ORDER BY r.id`,
  );
  const referrals = await rows(
    'SELECT * FROM referral_snapshots WHERE person_id=$1 ORDER BY id',
  );
  const followups = await rows(
    'SELECT f.*,r.encounter_id FROM referral_followups f JOIN referral_snapshots r ON r.id=f.referral_id WHERE r.person_id=$1 ORDER BY f.id',
  );
  for (const f of followups)
    f.payload = await historyPayload(db, 'REFERRAL_FOLLOWUP', String(f.id));
  const addenda = await rows(
    'SELECT * FROM encounter_addenda WHERE person_id=$1 ORDER BY id',
  );
  const flags =
    await rows(`SELECT f.*,COALESCE(s.to_status,'OPEN') current_status,s.changed_at FROM encounter_review_flags f
  LEFT JOIN LATERAL(SELECT to_status,changed_at FROM encounter_review_status_events WHERE flag_id=f.id ORDER BY sequence_number DESC LIMIT 1)s ON true WHERE f.person_id=$1 ORDER BY f.id`);
  const assessments =
    await rows(`SELECT id,encounter_id,'LIFESTYLE' AS kind,source_updated_at AS completed_at FROM lifestyle_assessments WHERE person_id=$1 AND status='COMPLETE'
  UNION ALL SELECT id,encounter_id,resource_type AS kind,completed_at FROM reported_intake_assessments WHERE person_id=$1 ORDER BY id`);
  const questionnaires = [];
  for (const a of assessments)
    questionnaires.push({
      ...a,
      payload: await historyPayload(
        db,
        String(a.kind) as HistoryResourceType,
        String(a.id),
      ),
    });
  return mapFhirSnapshot({
    person,
    identifiers,
    encounters,
    organizations,
    locations,
    readings,
    vitalSets,
    referrals,
    followups,
    questionnaires,
    addenda,
    flags,
  });
}
