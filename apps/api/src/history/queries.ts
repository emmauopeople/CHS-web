import type { PoolClient } from 'pg';
import type { HistoryResourceType } from '../../../../packages/contracts/src/patient-history.mjs';

// Only these fixed, reviewed column lists can enter the public history response.
// Source-local IDs, content hashes and synchronization payloads are never projected.
function projection(alias: string, columns: string): string {
  return `jsonb_build_object(${columns
    .split(' ')
    .map((column) => {
      const [name, renamed] = column.split(':');
      const key =
        renamed ??
        name!.replace(/_([a-z0-9])/g, (_, letter: string) =>
          letter.toUpperCase(),
        );
      return `'${key}', ${alias}.${name}`;
    })
    .join(', ')})`;
}
const actor = (id: string) =>
  `(SELECT jsonb_build_object('practitionerId', p.id, 'displayName', p.display_name) FROM practitioners p WHERE p.id = ${id})`;
const rows = (
  table: string,
  alias: string,
  predicate: string,
  columns: string,
  extra = '',
) =>
  `(SELECT COALESCE(jsonb_agg(${projection(alias, columns)} ${extra} ORDER BY ${alias}.sequence_number), '[]'::jsonb) FROM ${table} ${alias} WHERE ${predicate})`;
const values = (table: string, column: string, predicate: string) =>
  `(SELECT COALESCE(jsonb_agg(${column} ORDER BY ${column}), '[]'::jsonb) FROM ${table} WHERE ${predicate})`;

// $1 person, $2 global, $3 organization IDs, $4 inclusive UTC day, $5 exclusive UTC day.
export const historyIndexSql = `WITH scoped_encounters AS MATERIALIZED (
 SELECT * FROM screening_encounters WHERE person_id=$1 AND ($2::boolean OR organization_id=ANY($3::uuid[]))
), resources AS (
 SELECT 'SCREENING_ENCOUNTER'::text resource_type, e.id, e.id encounter_id, NULL::uuid parent_id,
   e.source_revision revision, e.started_at occurred_at, e.updated_at received_at, e.recorded_by_practitioner_id author_id, e.source_content_hash content_hash
 FROM scoped_encounters e
 UNION ALL
 SELECT 'VITALS', v.id, e.id, e.id, v.source_revision, v.source_updated_at, v.updated_at, v.recorded_by_practitioner_id, v.source_content_hash
 FROM screening_vital_sets v JOIN scoped_encounters e ON e.id=v.encounter_id
 UNION ALL
 SELECT 'LIFESTYLE', l.id, e.id, e.id, l.source_revision, l.source_updated_at, l.updated_at, l.updated_by_practitioner_id, l.source_content_hash
 FROM lifestyle_assessments l JOIN scoped_encounters e ON e.id=l.encounter_id WHERE l.status='COMPLETE'
 UNION ALL
 SELECT a.resource_type, a.id, e.id, e.id, a.source_revision, a.completed_at, a.received_at, a.recorded_by_practitioner_id, a.source_content_hash
 FROM reported_intake_assessments a JOIN scoped_encounters e ON e.id=a.encounter_id
 UNION ALL
 SELECT 'REFERRAL', r.id, e.id, e.id, resource.source_revision, r.created_at, resource.received_at, r.created_by_practitioner_id, resource.source_content_hash
 FROM referral_snapshots r JOIN scoped_encounters e ON e.id=r.encounter_id JOIN referral_resources resource ON resource.id=r.id
 UNION ALL
 SELECT 'REFERRAL_STATUS', s.id, e.id, r.id, resource.source_revision, s.changed_at, resource.received_at, s.changed_by_practitioner_id, resource.source_content_hash
 FROM referral_status_events s JOIN referral_snapshots r ON r.id=s.referral_id JOIN scoped_encounters e ON e.id=r.encounter_id JOIN referral_resources resource ON resource.id=s.id
 UNION ALL
 SELECT 'REFERRAL_FOLLOWUP', f.id, e.id, r.id, resource.source_revision, f.recorded_at, resource.received_at, f.recorded_by_practitioner_id, resource.source_content_hash
 FROM referral_followups f JOIN referral_snapshots r ON r.id=f.referral_id JOIN scoped_encounters e ON e.id=r.encounter_id JOIN referral_resources resource ON resource.id=f.id
 UNION ALL
 SELECT 'ENCOUNTER_ADDENDUM', a.id, e.id, e.id, resource.source_revision, a.created_at, resource.received_at, a.created_by_practitioner_id, resource.source_content_hash
 FROM encounter_addenda a JOIN scoped_encounters e ON e.id=a.encounter_id JOIN encounter_history_resources resource ON resource.id=a.id
 UNION ALL
 SELECT 'ENCOUNTER_REVIEW_FLAG', f.id, e.id, e.id, resource.source_revision, f.opened_at, resource.received_at, f.opened_by_practitioner_id,
   resource.source_content_hash || COALESCE((SELECT max(sequence_number)::text FROM encounter_review_status_events WHERE flag_id=f.id),'0')
 FROM encounter_review_flags f JOIN scoped_encounters e ON e.id=f.encounter_id JOIN encounter_history_resources resource ON resource.id=f.id
 UNION ALL
 SELECT 'ENCOUNTER_REVIEW_STATUS', s.id, e.id, f.id, resource.source_revision, s.changed_at, resource.received_at, s.changed_by_practitioner_id, resource.source_content_hash
 FROM encounter_review_status_events s JOIN encounter_review_flags f ON f.id=s.flag_id JOIN scoped_encounters e ON e.id=f.encounter_id JOIN encounter_history_resources resource ON resource.id=s.id
), history_index AS (
 SELECT r.*, e.status encounter_status, e.started_at encounter_started_at,
   e.amendment_of_encounter_id, e.amendment_reason, e.void_reason, e.source_revision encounter_revision,
   practitioner.display_name author_name, e.organization_id, organization.name organization_name,
   e.location_id, location.name location_name, e.installation_id, installation.deployment_name
 FROM resources r JOIN scoped_encounters e ON e.id=r.encounter_id
 JOIN practitioners practitioner ON practitioner.id=r.author_id
 JOIN organizations organization ON organization.id=e.organization_id
 JOIN locations location ON location.id=e.location_id
 JOIN desktop_installations installation ON installation.id=e.installation_id
 WHERE r.occurred_at >= $4::timestamptz AND r.occurred_at < $5::timestamptz
)`;

const lifestyle = `${projection('a', 'status period_start period_end')} || jsonb_build_object(
 'baselines', jsonb_build_object(
  'alcohol', (SELECT ${projection('b', 'id source_version:version status ever_consumed consumed_past_12_months other_beverage_description')} || jsonb_build_object('beverageTypes', ${values('lifestyle_alcohol_baseline_beverages', 'beverage_type', 'baseline_id=b.id')}) FROM lifestyle_alcohol_baselines b WHERE b.id=a.alcohol_baseline_id),
  'tobacco', (SELECT ${projection('b', 'id source_version:version status ever_regularly_used former_use_approximate_stop_date current_use_frequency other_product_description')} || jsonb_build_object('productTypes', ${values('lifestyle_tobacco_baseline_products', 'product_type', 'baseline_id=b.id')}) FROM lifestyle_tobacco_baselines b WHERE b.id=a.tobacco_baseline_id),
  'work', (SELECT ${projection('b', 'id source_version:version status occupation_job_title usual_physical_demand typical_workdays_per_week typical_hours_per_workday shift_pattern description')} FROM lifestyle_work_baselines b WHERE b.id=a.work_baseline_id)
 ),
 'alcohol', (SELECT ${projection('w', 'weekly_response drinking_days total_standardized_drinks largest_one_day_amount days_at_largest_amount other_beverage_description')} || jsonb_build_object('beverageTypes', ${values('lifestyle_alcohol_weekly_beverages', 'beverage_type', 'lifestyle_assessment_id=a.id')}) FROM lifestyle_alcohol_weekly w WHERE w.lifestyle_assessment_id=a.id),
 'tobacco', (SELECT ${projection('w', 'weekly_response')} || jsonb_build_object('products', ${rows('lifestyle_tobacco_products', 'p', 'p.lifestyle_assessment_id=a.id', 'id sequence_number product_type days_used average_quantity_per_use_day unit secondhand_smoke_exposure other_product_description other_unit_description')}) FROM lifestyle_tobacco_weekly w WHERE w.lifestyle_assessment_id=a.id),
 'physicalActivity', (SELECT ${projection('w', 'weekly_response sedentary_time_response sedentary_minutes_per_day')} || jsonb_build_object('activities', ${rows('lifestyle_physical_activities', 'p', 'p.lifestyle_assessment_id=a.id', 'id sequence_number activity_domain description intensity days_in_past_seven_days average_minutes_per_active_day')}) FROM lifestyle_physical_activity_weekly w WHERE w.lifestyle_assessment_id=a.id),
 'work', (SELECT ${projection('w', 'weekly_response')} FROM lifestyle_work_weekly w WHERE w.lifestyle_assessment_id=a.id),
 'otherActivity', (SELECT ${projection('w', 'weekly_response')} || jsonb_build_object('activities', ${rows('lifestyle_other_activities', 'p', 'p.lifestyle_assessment_id=a.id', 'id sequence_number category description days_in_past_seven_days average_minutes_per_day intensity')}) FROM lifestyle_other_activity_weekly w WHERE w.lifestyle_assessment_id=a.id)
)`;
const payloadQueries: Record<HistoryResourceType, string> = {
  SCREENING_ENCOUNTER: `SELECT ${projection('e', 'started_at completed_at amendment_of_encounter_id amendment_reason void_reason clinical_time')} || jsonb_build_object(
   'session', (SELECT ${projection('s', 'id:sessionId session_date status')} FROM screening_sessions s WHERE s.id=e.screening_session_id),
   'protocol', (SELECT ${projection('p', 'id:protocolId protocol_key:key version_label:version')} FROM screening_protocols p WHERE p.id=e.protocol_id)
 ) data FROM screening_encounters e WHERE e.id=$1`,
  VITALS: `SELECT ${projection('v', 'status weight_kg waist_cm notes')} || jsonb_build_object('readings', ${rows('vital_readings', 'r', 'r.vital_set_id=v.id', 'id sequence_number systolic_mmhg diastolic_mmhg pulse_bpm measurement_site patient_position measurement_local_date measurement_local_time measurement_timezone measured_at')}) data FROM screening_vital_sets v WHERE v.id=$1`,
  LIFESTYLE: `SELECT ${lifestyle} data FROM lifestyle_assessments a WHERE a.id=$1`,
  FOOD: `SELECT ${projection('a', 'response period_start period_end')} || jsonb_build_object('rows', ${rows('reported_food_rows', 'r', 'r.assessment_id=a.id', 'sequence_number food_code food_name frequency_code preparation_note source_type recorded_at', `|| jsonb_build_object('author', ${actor('r.recorded_by_practitioner_id')})`)}) data FROM reported_intake_assessments a WHERE a.id=$1`,
  OTC: `SELECT ${projection('a', 'response period_start period_end')} || jsonb_build_object('rows', ${rows('reported_otc_rows', 'r', 'r.assessment_id=a.id', 'sequence_number product_name reason_for_use dose_text frequency_text duration_text source_of_medication currently_taking source_type recorded_at', `|| jsonb_build_object('author', ${actor('r.recorded_by_practitioner_id')})`)}) data FROM reported_intake_assessments a WHERE a.id=$1`,
  REFERRAL: `SELECT ${projection('r', 'reason_codes reason_text urgency destination_name due_date status created_at updated_at closed_at closure_reason')} || jsonb_build_object('createdBy', ${actor('r.created_by_practitioner_id')}, 'updatedBy', ${actor('r.updated_by_practitioner_id')}, 'closedBy', ${actor('r.closed_by_practitioner_id')}) data FROM referral_snapshots r WHERE r.id=$1`,
  REFERRAL_STATUS: `SELECT ${projection('s', 'sequence_number from_status to_status change_reason')} data FROM referral_status_events s WHERE s.id=$1`,
  REFERRAL_FOLLOWUP: `SELECT ${projection('f', 'contact_date contact_method information_source provider_seen facility_name date_seen reported_outcome reported_medications_or_advice next_action next_followup_date source_type')} || jsonb_build_object(
   'treatmentActions', ${rows('referral_treatment_actions', 'a', 'a.followup_id=f.id', 'sequence_number action_code')},
   'medicationChanges', ${rows('referral_medication_changes', 'm', 'm.followup_id=f.id', 'sequence_number change_type medication_name dosage frequency')}
 ) data FROM referral_followups f WHERE f.id=$1`,
  ENCOUNTER_ADDENDUM: `SELECT ${projection('a', 'note_text')} data FROM encounter_addenda a WHERE a.id=$1`,
  ENCOUNTER_REVIEW_FLAG: `SELECT ${projection('f', 'category description')} || jsonb_build_object(
  'currentStatus', COALESCE(s.to_status,'OPEN'), 'latestSequenceNumber', COALESCE(s.sequence_number,0),
  'lastChangedAt', COALESCE(s.changed_at,f.opened_at), 'lastChangedBy', ${actor('COALESCE(s.changed_by_practitioner_id,f.opened_by_practitioner_id)')}, 'lastChangeReason', s.change_reason
 ) data FROM encounter_review_flags f LEFT JOIN LATERAL (SELECT * FROM encounter_review_status_events WHERE flag_id=f.id ORDER BY sequence_number DESC LIMIT 1) s ON true WHERE f.id=$1`,
  ENCOUNTER_REVIEW_STATUS: `SELECT ${projection('s', 'sequence_number from_status to_status change_reason')} || ${projection('f', 'category description')} data FROM encounter_review_status_events s JOIN encounter_review_flags f ON f.id=s.flag_id WHERE s.id=$1`,
};

export async function historyPayload(
  client: PoolClient,
  type: HistoryResourceType,
  id: string,
): Promise<Record<string, unknown>> {
  const result = await client.query<{ data: Record<string, unknown> }>(
    payloadQueries[type],
    [id],
  );
  if (!result.rows[0]) throw new Error('HISTORY_RESOURCE_UNAVAILABLE');
  return result.rows[0].data;
}
