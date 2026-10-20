import { describe, it, expect } from 'vitest';
import { mapFhirSnapshot, type FhirSnapshot } from '../src/fhir/mapping.js';
import { collectionUrl, collectionResource } from '../src/fhir/collection.js';
describe('FHIR R4 core mapping', () => {
  it('exports deterministic collection references without internal server addresses', () => {
    const id = 'chs-11111111-1111-4111-8111-111111111111';
    const resource = collectionResource({
      resourceType: 'Observation',
      subject: { reference: `Patient/${id}` },
    });
    expect(resource.subject).toEqual({
      reference: collectionUrl('Patient', id),
    });
    expect(collectionUrl('Patient', id)).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
  it('escapes source text in generated XHTML narratives', () => {
    const s = snapshot();
    s.person.display_name = '<script>synthetic</script>';
    const text = mapFhirSnapshot(s)[0]!.resource.text as { div: string };
    expect(text.div).toContain('&lt;script&gt;');
    expect(text.div).not.toContain('<script>');
  });
  const snapshot = (): FhirSnapshot => ({
    person: {
      id: '11111111-1111-4111-8111-111111111111',
      display_name: 'Synthetic Person',
      sex: 'UNKNOWN',
      status: 'ACTIVE',
      birth_date: null,
    },
    identifiers: [],
    encounters: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        organization_id: '33333333-3333-4333-8333-333333333333',
        location_id: '44444444-4444-4444-8444-444444444444',
        status: 'COMPLETED',
        started_at: new Date('2026-10-01T09:00:00Z'),
        completed_at: new Date('2026-10-01T09:30:00Z'),
        source_updated_at: new Date('2026-10-01T09:30:00Z'),
      },
    ],
    organizations: [],
    locations: [],
    readings: [
      {
        id: '55555555-5555-4555-8555-555555555555',
        encounter_id: '22222222-2222-4222-8222-222222222222',
        vital_status: 'VITALS_COMPLETE',
        systolic_mmhg: 130,
        diastolic_mmhg: 80,
        pulse_bpm: 70,
        measured_at: null,
        measurement_date: '2026-10-01',
      },
    ],
    vitalSets: [],
    referrals: [],
    followups: [],
    questionnaires: [],
    addenda: [],
    flags: [],
  });
  it('preserves deterministic IDs, LOINC components, UCUM units and unknown time precision', () => {
    const s = snapshot(),
      first = mapFhirSnapshot(s);
    expect(mapFhirSnapshot(s)).toEqual(first);
    const observations = first
      .filter((r) => r.resource.resourceType === 'Observation')
      .map((r) => r.resource);
    expect(observations).toHaveLength(2);
    expect(new Set(observations.map((r) => r.id)).size).toBe(2);
    expect(observations[0]!.effectiveDateTime).toBe('2026-10-01');
    expect(observations[0]!.component).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          valueQuantity: expect.objectContaining({
            value: 130,
            code: 'mm[Hg]',
          }),
        }),
      ]),
    );
    expect(first[0]!.resource.birthDate).toBeUndefined();
  });
  it('propagates voids and never turns patient-reported questionnaire responses into prescriptions', () => {
    const s = snapshot();
    s.encounters[0]!.status = 'VOID';
    s.questionnaires = [
      {
        id: '66666666-6666-4666-8666-666666666666',
        encounter_id: s.encounters[0]!.id,
        kind: 'OTC',
        completed_at: '2026-10-01T09:30:00Z',
        payload: { response: 'REPORTED', quantity: 2, patientReported: true },
      },
    ];
    const resources = mapFhirSnapshot(s).map((r) => r.resource);
    expect(resources.find((r) => r.resourceType === 'Encounter')!.status).toBe(
      'entered-in-error',
    );
    expect(
      resources
        .filter((r) => r.resourceType === 'Observation')
        .every((r) => r.status === 'entered-in-error'),
    ).toBe(true);
    const q = resources.find(
      (r) => r.resourceType === 'QuestionnaireResponse',
    )!;
    expect(q.status).toBe('entered-in-error');
    expect(q.item).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          linkId: 'patientReported',
          answer: [{ valueBoolean: true }],
        }),
      ]),
    );
    expect(resources.some((r) => r.resourceType === 'MedicationRequest')).toBe(
      false,
    );
  });
});
