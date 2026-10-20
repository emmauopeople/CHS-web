export const fhirTypes = [
  'Patient',
  'Encounter',
  'Observation',
  'Organization',
  'Location',
  'Provenance',
  'QuestionnaireResponse',
  'ServiceRequest',
  'Task',
  'Communication',
  'Flag',
] as const;
export type FhirResource = {
  resourceType: string;
  id: string;
  [key: string]: unknown;
};
export type FhirPatientPage = {
  items: { personId: string; generation: string; resource: FhirResource }[];
  page: number;
  hasMore: boolean;
};
export type FhirResourcePage = {
  bundle: {
    resourceType: 'Bundle';
    type: 'collection';
    entry: { resource: FhirResource }[];
  };
  generation: string;
  page: number;
  hasMore: boolean;
};
const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const resource = (v: unknown): v is FhirResource =>
  obj(v) &&
  typeof v.resourceType === 'string' &&
  fhirTypes.includes(v.resourceType as (typeof fhirTypes)[number]) &&
  typeof v.id === 'string';
export const fhirAccess = (v: unknown): v is { fhirOnly: boolean } =>
  obj(v) && typeof v.fhirOnly === 'boolean';
export const fhirPatients = (v: unknown): v is FhirPatientPage =>
  obj(v) &&
  Number.isInteger(v.page) &&
  typeof v.hasMore === 'boolean' &&
  Array.isArray(v.items) &&
  v.items.length <= 10 &&
  v.items.every(
    (i) =>
      obj(i) &&
      typeof i.personId === 'string' &&
      typeof i.generation === 'string' &&
      resource(i.resource) &&
      i.resource.resourceType === 'Patient',
  );
export const fhirResources = (v: unknown): v is FhirResourcePage =>
  obj(v) &&
  typeof v.generation === 'string' &&
  Number.isInteger(v.page) &&
  typeof v.hasMore === 'boolean' &&
  obj(v.bundle) &&
  v.bundle.resourceType === 'Bundle' &&
  v.bundle.type === 'collection' &&
  Array.isArray(v.bundle.entry) &&
  v.bundle.entry.length <= 25 &&
  v.bundle.entry.every((e) => obj(e) && resource(e.resource));
export function patientName(r: FhirResource): string {
  if (Array.isArray(r.name)) {
    const n = r.name.find(obj);
    if (n) {
      if (typeof n.text === 'string') return n.text;
      return (
        [
          ...(Array.isArray(n.given)
            ? n.given.filter((v) => typeof v === 'string')
            : []),
          ...(typeof n.family === 'string' ? [n.family] : []),
        ].join(' ') || 'Unnamed patient'
      );
    }
  }
  return 'Unnamed patient';
}
