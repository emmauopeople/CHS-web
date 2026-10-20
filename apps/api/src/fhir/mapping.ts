import { createHash } from 'node:crypto';
export type Row = Record<string, unknown>;
export type FhirResource = {
  resourceType: string;
  id: string;
  [key: string]: unknown;
};
export type MappedResource = {
  resource: FhirResource;
  sourceId: string;
  personId: string | null;
  organizationId: string | null;
};
export type FhirSnapshot = {
  person: Row;
  identifiers: Row[];
  encounters: Row[];
  organizations: Row[];
  locations: Row[];
  readings: Row[];
  vitalSets: Row[];
  referrals: Row[];
  followups: Row[];
  questionnaires: Row[];
  addenda: Row[];
  flags: Row[];
};
const str = (v: unknown) => String(v ?? '');
const escapeXml = (v: unknown) =>
  str(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
function narrative(type: string, body: Row) {
  const concept = body.code as
    | { text?: string; coding?: { display?: string; code?: string }[] }
    | undefined;
  const names = Array.isArray(body.name)
    ? (body.name as { text?: string }[])
    : null;
  const value = body.valueQuantity as
    { value?: number; unit?: string } | undefined;
  const components = body.component as
    | {
        code: { coding?: { display?: string }[] };
        valueQuantity?: { value: number; unit: string };
      }[]
    | undefined;
  const summary = [
    type,
    names?.[0]?.text ?? (typeof body.name === 'string' ? body.name : null),
    concept?.text ?? concept?.coding?.[0]?.display,
    body.description,
    body.status ? `Status: ${str(body.status)}` : null,
    value ? `${value.value} ${value.unit}` : null,
    ...(components ?? []).map(
      (c) =>
        `${c.code.coding?.[0]?.display ?? 'Component'}: ${c.valueQuantity ? `${c.valueQuantity.value} ${c.valueQuantity.unit}` : 'not recorded'}`,
    ),
  ]
    .filter(Boolean)
    .map(escapeXml)
    .join('. ');
  return {
    status: 'generated',
    div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${summary}.</p><p>Recorded CHS source details are retained in the structured elements.</p></div>`,
  };
}
export const fhirId = (id: unknown, suffix = '') =>
  suffix
    ? `chs-${createHash('sha256')
        .update(String(id) + suffix)
        .digest('hex')
        .slice(0, 40)}`
    : `chs-${str(id)}`;
const ref = (type: string, id: unknown, suffix = '') => ({
  reference: `${type}/${fhirId(id, suffix)}`,
});
const instant = (v: unknown) => (v instanceof Date ? v.toISOString() : str(v));
const code = (system: string, value: string, display?: string) => ({
  coding: [{ system, code: value, ...(display ? { display } : {}) }],
});
const quantity = (value: unknown, unit: string, ucum: string) => ({
  value: Number(value),
  unit,
  system: 'http://unitsofmeasure.org',
  code: ucum,
});
function answers(value: unknown, path = ''): Row[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value))
    return value.flatMap((v, i) => answers(v, `${path}.${i + 1}`));
  if (typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) =>
      answers(v, path ? `${path}.${k}` : k),
    );
  const answer =
    typeof value === 'boolean'
      ? { valueBoolean: value }
      : typeof value === 'number'
        ? { valueDecimal: value }
        : { valueString: String(value) };
  return [
    {
      linkId:
        path.length <= 255
          ? path
          : createHash('sha256').update(path).digest('hex'),
      text: path,
      answer: [answer],
    },
  ];
}
export function mapFhirSnapshot(s: FhirSnapshot): MappedResource[] {
  const result: MappedResource[] = [];
  const personId = str(s.person.id);
  const add = (
    type: string,
    sourceId: unknown,
    body: Row,
    organizationId: string | null = null,
    owner: string | null = personId,
    suffix = '',
  ) => {
    result.push({
      resource: {
        resourceType: type,
        id: fhirId(sourceId, suffix),
        text: narrative(type, body),
        ...body,
      },
      sourceId: str(sourceId),
      personId: owner,
      organizationId,
    });
  };
  add('Patient', personId, {
    identifier: s.identifiers.map((i) => ({
      system: i.identifier_system,
      value: i.identifier_value,
    })),
    active: s.person.status === 'ACTIVE',
    ...(s.person.approximate_age_years != null
      ? {
          extension: [
            {
              url: 'https://servicecam.org/chs/StructureDefinition/recorded-age',
              extension: [
                {
                  url: 'age',
                  valueQuantity: quantity(
                    s.person.approximate_age_years,
                    'years',
                    'a',
                  ),
                },
                { url: 'asOf', valueDate: str(s.person.age_date) },
              ],
            },
          ],
        }
      : {}),
    name: [
      {
        text: s.person.display_name,
        ...(s.person.family_name ? { family: s.person.family_name } : {}),
        ...(s.person.given_name ? { given: [s.person.given_name] } : {}),
      },
    ],
    gender:
      (
        {
          FEMALE: 'female',
          MALE: 'male',
          OTHER: 'other',
          UNKNOWN: 'unknown',
        } as Record<string, string>
      )[str(s.person.sex)] ?? 'unknown',
    ...(s.person.birth_date ? { birthDate: str(s.person.birth_date) } : {}),
    deceasedBoolean: s.person.status === 'DECEASED',
    ...(s.person.phone
      ? { telecom: [{ system: 'phone', value: s.person.phone }] }
      : {}),
    ...(s.person.village || s.person.quarter
      ? {
          address: [
            {
              text: [s.person.quarter, s.person.village]
                .filter(Boolean)
                .join(', '),
            },
          ],
        }
      : {}),
  });
  for (const o of s.organizations)
    add(
      'Organization',
      o.id,
      {
        active: o.active,
        name: o.name,
        identifier: [
          { system: o.identifier_system, value: o.identifier_value },
        ],
      },
      str(o.id),
      null,
    );
  for (const l of s.locations)
    add(
      'Location',
      l.id,
      {
        status: l.active ? 'active' : 'inactive',
        name: l.name,
        managingOrganization: ref('Organization', l.organization_id),
      },
      str(l.organization_id),
      null,
    );
  const encounterById = new Map(s.encounters.map((e) => [str(e.id), e]));
  for (const e of s.encounters) {
    const org = str(e.organization_id),
      voided = e.status === 'VOID';
    add(
      'Encounter',
      e.id,
      {
        status: voided
          ? 'entered-in-error'
          : ['COMPLETED', 'AMENDED'].includes(str(e.status))
            ? 'finished'
            : 'in-progress',
        class: {
          system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
          code: 'AMB',
        },
        subject: ref('Patient', personId),
        extension: [
          {
            url: 'https://servicecam.org/chs/StructureDefinition/source-encounter-status',
            valueCode: str(e.status),
          },
          ...(e.amendment_of_encounter_id
            ? [
                {
                  url: 'https://servicecam.org/chs/StructureDefinition/amendment-of',
                  valueReference: ref('Encounter', e.amendment_of_encounter_id),
                },
              ]
            : []),
          ...(e.amendment_reason
            ? [
                {
                  url: 'https://servicecam.org/chs/StructureDefinition/amendment-reason',
                  valueString: e.amendment_reason,
                },
              ]
            : []),
          ...(e.void_reason
            ? [
                {
                  url: 'https://servicecam.org/chs/StructureDefinition/void-reason',
                  valueString: e.void_reason,
                },
              ]
            : []),
        ],
        serviceProvider: ref('Organization', org),
        location: [{ location: ref('Location', e.location_id) }],
        period: {
          start: instant(e.started_at),
          ...(e.completed_at ? { end: instant(e.completed_at) } : {}),
        },
        ...(e.author_name
          ? { participant: [{ individual: { display: e.author_name } }] }
          : {}),
      },
      org,
    );
    add(
      'Provenance',
      e.id,
      {
        target: [ref('Encounter', e.id)],
        recorded: instant(e.source_updated_at ?? e.updated_at),
        agent: [
          {
            who: {
              display: str(e.author_name) || 'Source screening practitioner',
            },
          },
        ],
        activity: code(
          'https://servicecam.org/chs/CodeSystem/provenance-activity',
          voided ? 'void' : 'screening-record',
        ),
        entity: [
          {
            role: 'source',
            what: {
              identifier: {
                system: 'urn:chs:installation',
                value: str(e.installation_id),
              },
            },
          },
        ],
      },
      org,
    );
  }
  const observation = (
    source: Row,
    e: Row,
    suffix: string,
    loinc: string | null,
    display: string,
    value: Row,
  ) =>
    add(
      'Observation',
      source.id,
      {
        status: e.status === 'VOID' ? 'entered-in-error' : 'final',
        category: [
          code(
            'http://terminology.hl7.org/CodeSystem/observation-category',
            'vital-signs',
          ),
        ],
        code: loinc
          ? code('http://loinc.org', loinc, display)
          : code(
              'https://servicecam.org/chs/CodeSystem/observation',
              'waist-circumference',
              display,
            ),
        subject: ref('Patient', personId),
        encounter: ref('Encounter', e.id),
        effectiveDateTime: source.measured_at
          ? instant(source.measured_at)
          : source.measurement_date
            ? str(source.measurement_date)
            : instant(e.started_at),
        ...value,
      },
      str(e.organization_id),
      personId,
      suffix,
    );
  for (const r of s.readings) {
    const e = encounterById.get(str(r.encounter_id));
    if (!e || r.vital_status !== 'VITALS_COMPLETE') continue;
    if (r.systolic_mmhg != null && r.diastolic_mmhg != null)
      observation(r, e, 'bp', '85354-9', 'Blood pressure panel', {
        component: [
          {
            code: code('http://loinc.org', '8480-6', 'Systolic blood pressure'),
            valueQuantity: quantity(r.systolic_mmhg, 'mmHg', 'mm[Hg]'),
          },
          {
            code: code(
              'http://loinc.org',
              '8462-4',
              'Diastolic blood pressure',
            ),
            valueQuantity: quantity(r.diastolic_mmhg, 'mmHg', 'mm[Hg]'),
          },
        ],
      });
    if (r.pulse_bpm != null)
      observation(r, e, 'pulse', '8867-4', 'Heart rate', {
        valueQuantity: quantity(r.pulse_bpm, 'beats/minute', '/min'),
      });
  }
  for (const v of s.vitalSets) {
    const e = encounterById.get(str(v.encounter_id));
    if (!e || v.status !== 'VITALS_COMPLETE') continue;
    if (v.weight_kg != null)
      observation(v, e, 'weight', '29463-7', 'Body weight', {
        valueQuantity: quantity(v.weight_kg, 'kg', 'kg'),
      });
    if (v.waist_cm != null)
      observation(v, e, 'waist', null, 'Waist circumference', {
        valueQuantity: quantity(v.waist_cm, 'cm', 'cm'),
      });
  }
  for (const r of s.referrals) {
    const e = encounterById.get(str(r.encounter_id));
    if (!e) continue;
    const org = str(e.organization_id),
      voided = e.status === 'VOID';
    add(
      'ServiceRequest',
      r.id,
      {
        status: voided
          ? 'entered-in-error'
          : r.status === 'CLOSED'
            ? 'completed'
            : 'active',
        intent: 'order',
        priority: r.urgency === 'URGENT' ? 'urgent' : 'routine',
        code: { text: 'Community screening referral' },
        subject: ref('Patient', personId),
        encounter: ref('Encounter', e.id),
        authoredOn: instant(r.created_at),
        reasonCode: [
          {
            text: [...((r.reason_codes as string[]) ?? []), r.reason_text]
              .filter(Boolean)
              .join('; '),
          },
        ],
        ...(r.destination_name
          ? { performer: [{ display: r.destination_name }] }
          : {}),
      },
      org,
    );
    add(
      'Task',
      r.id,
      {
        status: voided
          ? 'entered-in-error'
          : r.status === 'CLOSED'
            ? 'completed'
            : r.status === 'SEEN'
              ? 'in-progress'
              : 'requested',
        intent: 'order',
        focus: ref('ServiceRequest', r.id),
        for: ref('Patient', personId),
        encounter: ref('Encounter', e.id),
        authoredOn: instant(r.created_at),
        lastModified: instant(r.updated_at),
        description: 'Community referral follow-up',
        businessStatus: { text: r.status },
      },
      org,
    );
  }
  for (const q of s.questionnaires) {
    const e = encounterById.get(str(q.encounter_id));
    if (!e) continue;
    add(
      'QuestionnaireResponse',
      q.id,
      {
        status: e.status === 'VOID' ? 'entered-in-error' : 'completed',
        meta: {
          tag: [
            {
              system:
                'https://servicecam.org/chs/CodeSystem/questionnaire-kind',
              code: str(q.kind).toLowerCase(),
            },
          ],
        },
        subject: ref('Patient', personId),
        encounter: ref('Encounter', e.id),
        authored: instant(q.completed_at),
        item: answers(q.payload),
      },
      str(e.organization_id),
    );
  }
  for (const f of s.followups) {
    const e = encounterById.get(str(f.encounter_id));
    if (!e) continue;
    add(
      'Communication',
      f.id,
      {
        status: e.status === 'VOID' ? 'entered-in-error' : 'completed',
        subject: ref('Patient', personId),
        encounter: ref('Encounter', e.id),
        basedOn: [ref('ServiceRequest', f.referral_id)],
        sent: instant(f.recorded_at),
        category: [{ text: 'Source-recorded referral follow-up' }],
        payload: [{ contentString: JSON.stringify(f.payload) }],
      },
      str(e.organization_id),
    );
  }
  for (const a of s.addenda) {
    const e = encounterById.get(str(a.encounter_id));
    if (!e) continue;
    add(
      'Communication',
      a.id,
      {
        status: e.status === 'VOID' ? 'entered-in-error' : 'completed',
        subject: ref('Patient', personId),
        encounter: ref('Encounter', e.id),
        sent: instant(a.created_at),
        category: [{ text: 'Screening encounter addendum' }],
        payload: [{ contentString: str(a.note_text) }],
      },
      str(e.organization_id),
    );
  }
  for (const f of s.flags) {
    const e = encounterById.get(str(f.encounter_id));
    if (!e) continue;
    add(
      'Flag',
      f.id,
      {
        status:
          e.status === 'VOID'
            ? 'entered-in-error'
            : f.current_status === 'OPEN'
              ? 'active'
              : 'inactive',
        code: { text: `${str(f.category)}: ${str(f.description)}` },
        subject: ref('Patient', personId),
        encounter: ref('Encounter', e.id),
        period: {
          start: instant(f.opened_at),
          ...(f.current_status !== 'OPEN' && f.changed_at
            ? { end: instant(f.changed_at) }
            : {}),
        },
      },
      str(e.organization_id),
    );
  }
  if (
    result.length > 5000 ||
    Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024
  )
    throw new Error('FHIR_PATIENT_LIMIT');
  return result;
}
