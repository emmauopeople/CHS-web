import { useEffect, useRef, useState } from 'react';
import { ApiError, type OperationsApi } from './api';
import {
  fhirTypes,
  patientName,
  type FhirPatientPage,
  type FhirResourcePage,
  type FhirResource,
} from './fhir-contract';

function references(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(references);
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([key, v]) =>
      key === 'reference' && typeof v === 'string' ? [v] : references(v),
    );
  return [];
}
export function FhirViewer({
  api,
  onUnauthorized,
}: {
  api: OperationsApi;
  onUnauthorized: () => void;
}) {
  const [name, setName] = useState(''),
    [dob, setDob] = useState(''),
    [type, setType] = useState('');
  const [patients, setPatients] = useState<FhirPatientPage | null>(null);
  const [patient, setPatient] = useState<
    FhirPatientPage['items'][number] | null
  >(null);
  const [resources, setResources] = useState<FhirResourcePage | null>(null);
  const [selected, setSelected] = useState<FhirResource | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [request, setRequest] = useState<{ path: string; body: object } | null>(
    null,
  );
  const sequence = useRef(0);
  const criteria = useRef({ name: '', dateOfBirth: '' });
  useEffect(() => {
    const clear = () => {
      if (document.hidden) {
        sequence.current++;
        setPatients(null);
        setPatient(null);
        setResources(null);
        setSelected(null);
        setRequest(null);
        setBusy(false);
      }
    };
    document.addEventListener('visibilitychange', clear);
    return () => {
      sequence.current++;
      document.removeEventListener('visibilitychange', clear);
    };
  }, []);
  async function run(work: (current: () => boolean) => Promise<void>) {
    const n = ++sequence.current;
    setBusy(true);
    setError('');
    try {
      await work(() => sequence.current === n);
    } catch (e) {
      if (sequence.current !== n) return;
      if (e instanceof ApiError && e.status === 401) {
        onUnauthorized();
        return;
      }
      setError(
        e instanceof ApiError && e.status === 403
          ? 'Your account does not have FHIR read permission.'
          : e instanceof ApiError && e.status === 409
            ? 'Published resources changed. Select the patient again to restart.'
            : e instanceof ApiError && e.status === 503
              ? 'FHIR publication is not ready or the private server is unavailable. Try again shortly.'
              : 'The FHIR request could not be completed.',
      );
    } finally {
      if (sequence.current === n) setBusy(false);
    }
  }
  function search(page = 1) {
    if (page === 1) criteria.current = { name: name.trim(), dateOfBirth: dob };
    setPatient(null);
    setResources(null);
    setSelected(null);
    setPatients(null);
    const body = {
      reasonCode: 'FHIR_DEMONSTRATION' as const,
      ...(criteria.current.name ? { name: criteria.current.name } : {}),
      ...(criteria.current.dateOfBirth
        ? { dateOfBirth: criteria.current.dateOfBirth }
        : {}),
      page,
    };
    setRequest({ path: '/api/v1/operations/fhir/patients/search', body });
    void run(async (current) => {
      const data = await api.searchFhirPatients(body);
      if (current()) setPatients(data);
    });
  }
  function read(
    p: FhirPatientPage['items'][number],
    resourceType = type,
    page = 1,
  ) {
    setPatient(p);
    setResources(null);
    setSelected(null);
    const body = {
      reasonCode: 'FHIR_DEMONSTRATION' as const,
      personId: p.personId,
      ...(resourceType ? { resourceType } : {}),
      page,
      ...(page > 1 && resources ? { generation: resources.generation } : {}),
    };
    setRequest({ path: '/api/v1/operations/fhir/resources/read', body });
    void run(async (current) => {
      const data = await api.readFhirResources(body);
      if (current()) {
        setResources(data);
        setSelected(data.bundle.entry[0]?.resource ?? null);
      }
    });
  }
  return (
    <section
      className="administration-workspace fhir-viewer"
      aria-label="FHIR resource viewer"
    >
      <p>
        Read published FHIR R4 resources using audited POST requests. Search by
        name, date of birth, or both, then open a patient and choose a resource
        type. Access is limited to your authorized organizations.
      </p>
      <form
        className="panel search-form"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <div className="field">
          <label htmlFor="fhir-name">Patient name</label>
          <input
            id="fhir-name"
            minLength={2}
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor="fhir-dob">Date of birth</label>
          <input
            id="fhir-dob"
            type="date"
            value={dob}
            onChange={(e) => setDob(e.target.value)}
          />
        </div>
        <button
          className="button button-primary"
          disabled={busy || (!name.trim() && !dob)}
        >
          Search FHIR patients
        </button>
      </form>
      {error ? (
        <div role="alert" className="alert alert-error">
          {error}
        </div>
      ) : null}
      {busy ? <p role="status">Loading published resources…</p> : null}
      {patients ? (
        <section className="panel">
          <h2>Published patients</h2>
          {!patients.items.length ? (
            <p>
              No published patients match within your scope. Patients with
              approximate ages have no recorded date of birth.
            </p>
          ) : (
            patients.items.map((p) => (
              <button
                className="button button-quiet fhir-patient"
                key={p.personId}
                disabled={busy}
                onClick={() => read(p)}
              >
                <strong>{patientName(p.resource)}</strong> · DOB:{' '}
                {typeof p.resource.birthDate === 'string'
                  ? p.resource.birthDate
                  : 'Not recorded'}{' '}
                · Patient/{p.resource.id}
              </button>
            ))
          )}
          <div className="pagination">
            <button
              className="button button-quiet"
              disabled={busy || patients.page === 1}
              onClick={() => search(patients.page - 1)}
            >
              Previous patients
            </button>
            <span>Page {patients.page}</span>
            <button
              className="button button-quiet"
              disabled={busy || !patients.hasMore}
              onClick={() => search(patients.page + 1)}
            >
              Next patients
            </button>
          </div>
        </section>
      ) : null}
      {patient ? (
        <section className="panel">
          <h2>{patientName(patient.resource)}</h2>
          <p>
            DOB:{' '}
            {typeof patient.resource.birthDate === 'string'
              ? patient.resource.birthDate
              : 'Not recorded'}{' '}
            · Published FHIR R4
          </p>
          <div className="field">
            <label htmlFor="fhir-type">Resource type</label>
            <select
              id="fhir-type"
              value={type}
              disabled={busy}
              onChange={(e) => {
                setType(e.target.value);
                read(patient, e.target.value);
              }}
            >
              <option value="">All mapped resource types</option>
              {fhirTypes.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          {resources ? (
            <>
              <div className="fhir-resource-layout">
                <nav aria-label="Mapped FHIR resources">
                  {resources.bundle.entry.map(({ resource: r }) => (
                    <button
                      className={
                        'button button-quiet fhir-resource ' +
                        (selected?.id === r.id ? 'active' : '')
                      }
                      key={r.resourceType + '/' + r.id}
                      onClick={() => setSelected(r)}
                    >
                      <strong>{r.resourceType}</strong>
                      <small>{r.id}</small>
                    </button>
                  ))}
                </nav>
                <section aria-label="FHIR JSON">
                  {selected ? (
                    <>
                      <h3>
                        {selected.resourceType}/{selected.id}
                      </h3>
                      <p>Actual JSON read from the private FHIR server.</p>
                      {[...new Set(references(selected))].map((ref) => (
                        <div key={ref}>
                          <span>Reference: </span>
                          <button
                            className="button button-quiet"
                            disabled={
                              !resources.bundle.entry.some(
                                (e) =>
                                  e.resource.resourceType +
                                    '/' +
                                    e.resource.id ===
                                  ref,
                              )
                            }
                            onClick={() =>
                              setSelected(
                                resources.bundle.entry.find(
                                  (e) =>
                                    e.resource.resourceType +
                                      '/' +
                                      e.resource.id ===
                                    ref,
                                )!.resource,
                              )
                            }
                          >
                            {ref}
                          </button>
                        </div>
                      ))}
                      <pre className="fhir-json" tabIndex={0}>
                        {JSON.stringify(selected, null, 2)}
                      </pre>
                    </>
                  ) : (
                    <p>
                      No resources of this type are published for this patient.
                    </p>
                  )}
                </section>
              </div>
              <div className="pagination">
                <button
                  className="button button-quiet"
                  disabled={busy || resources.page === 1}
                  onClick={() => read(patient, type, resources.page - 1)}
                >
                  Previous resources
                </button>
                <span>
                  Page {resources.page} · generation {resources.generation}
                </span>
                <button
                  className="button button-quiet"
                  disabled={busy || !resources.hasMore}
                  onClick={() => read(patient, type, resources.page + 1)}
                >
                  Next resources
                </button>
              </div>
            </>
          ) : null}
        </section>
      ) : null}
      {request ? (
        <details className="panel">
          <summary>POST request demonstration</summary>
          <p>
            <strong>POST</strong> {request.path}
          </p>
          <p>
            The signed-in session supplies authorization. Tokens are never
            displayed here.
          </p>
          <pre className="fhir-json">
            {JSON.stringify(request.body, null, 2)}
          </pre>
        </details>
      ) : null}
    </section>
  );
}
