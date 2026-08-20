import { useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, createOperationsApi } from './api';
import {
  clearAuthSession,
  completeSignIn,
  finishAuthorizationNavigation,
  getAuthSession,
  hasAuthorizationResponse,
  signOut,
  startSignIn,
  type AuthSession,
} from './auth';
import type { OperationsWebConfig } from './config';
import { displayValue, formatDate, formatInstant, humanize } from './format';
import { IdentityReview } from './IdentityReview';
import { MedicalIdRecovery } from './MedicalIdRecovery';
import { SyncMonitoring } from './SyncMonitoring';
import type {
  PatientAccessReason,
  PatientDetail,
  PatientListItem,
  PatientListPage,
  PersonStatus,
} from './types';

const reasons: ReadonlyArray<Readonly<{ value: PatientAccessReason; label: string }>> = [
  { value: 'CARE_DELIVERY', label: 'Care delivery' },
  { value: 'CARE_COORDINATION', label: 'Care coordination' },
  { value: 'PATIENT_REQUEST', label: 'Patient request' },
  { value: 'QUALITY_IMPROVEMENT', label: 'Quality improvement' },
  { value: 'OPERATIONS_SUPPORT', label: 'Operations support' },
];

type AppProps = Readonly<{ config: OperationsWebConfig }>;

type SearchForm = Readonly<{
  search: string;
  dateOfBirth: string;
  status: PersonStatus | 'ALL';
}>;

const initialSearch: SearchForm = {
  search: '',
  dateOfBirth: '',
  status: 'ACTIVE',
};

function friendlyError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'The request could not be completed. Try again.';
  }
  if (error.status === 401) return 'Your session has expired. Sign in again.';
  if (error.status === 403) return 'Your account does not have access to this patient data.';
  if (error.status === 404) return 'The patient was not found within your authorized locations.';
  if (error.status === 503) return 'The patient service is temporarily unavailable.';
  const reference = error.requestId ? ` Reference: ${error.requestId}.` : '';
  return `The request could not be completed.${reference}`;
}

function Brand() {
  return (
    <div className="brand" aria-label="Community Health Screening">
      <span className="brand-mark" aria-hidden="true">CHS</span>
      <span>
        <strong>Community Health Screening</strong>
        <small>Clinical operations</small>
      </span>
    </div>
  );
}

function SignInView({
  onSignIn,
  busy,
  error,
}: Readonly<{
  onSignIn: () => void;
  busy: boolean;
  error: string | null;
}>) {
  return (
    <main className="sign-in-page">
      <section className="sign-in-card">
        <Brand />
        <div className="sign-in-copy">
          <p className="eyebrow">Authorized personnel only</p>
          <h1>Clinical Operations</h1>
          <p>
            Review clean patient records, recover existing Medical IDs, and
            monitor desktop synchronization.
          </p>
        </div>
        {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
        <button className="button button-primary button-wide" disabled={busy} onClick={onSignIn}>
          {busy ? 'Completing sign-in…' : 'Sign in securely'}
        </button>
        <p className="security-note">
          Access is permission-controlled and patient searches are audited.
        </p>
      </section>
    </main>
  );
}

function PatientSearchForm({
  value,
  reason,
  busy,
  onChange,
  onSubmit,
  onClear,
}: Readonly<{
  value: SearchForm;
  reason: PatientAccessReason | '';
  busy: boolean;
  onChange: (value: SearchForm) => void;
  onSubmit: () => void;
  onClear: () => void;
}>) {
  return (
    <form
      className="search-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="field field-grow">
        <label htmlFor="patient-search">Name or CHS Medical ID</label>
        <input
          id="patient-search"
          type="search"
          autoComplete="off"
          maxLength={120}
          placeholder="Search patient"
          value={value.search}
          onChange={(event) => onChange({ ...value, search: event.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor="date-of-birth">Date of birth</label>
        <input
          id="date-of-birth"
          type="date"
          value={value.dateOfBirth}
          onChange={(event) => onChange({ ...value, dateOfBirth: event.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor="patient-status">Status</label>
        <select
          id="patient-status"
          value={value.status}
          onChange={(event) =>
            onChange({ ...value, status: event.target.value as SearchForm['status'] })
          }
        >
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
          <option value="DECEASED">Deceased</option>
          <option value="ALL">All statuses</option>
        </select>
      </div>
      <div className="search-actions">
        <button className="button button-primary" type="submit" disabled={!reason || busy}>
          {busy ? 'Searching…' : 'Search'}
        </button>
        <button className="button button-quiet" type="button" disabled={busy} onClick={onClear}>
          Clear
        </button>
      </div>
      {!reason ? <p className="form-hint">Select a reason for access before searching.</p> : null}
    </form>
  );
}

function PatientTable({
  result,
  selectedId,
  onSelect,
}: Readonly<{
  result: PatientListPage;
  selectedId: string | null;
  onSelect: (patient: PatientListItem) => void;
}>) {
  if (result.items.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon" aria-hidden="true">⌕</span>
        <h2>No patients found</h2>
        <p>Check the search criteria or your authorized location scope.</p>
      </div>
    );
  }
  return (
    <div className="table-shell">
      <table>
        <caption className="visually-hidden">Canonical patient search results</caption>
        <thead>
          <tr>
            <th>Patient</th>
            <th>CHS Medical ID</th>
            <th>Date of birth</th>
            <th>Residence</th>
            <th>Last screening</th>
            <th><span className="visually-hidden">Open patient</span></th>
          </tr>
        </thead>
        <tbody>
          {result.items.map((patient) => (
            <tr key={patient.personId} className={selectedId === patient.personId ? 'selected-row' : ''}>
              <td>
                <strong>{patient.displayName}</strong>
                <small>{humanize(patient.sex)} · {humanize(patient.status)}</small>
              </td>
              <td><span className="medical-id">{patient.chsMedicalId}</span></td>
              <td>{formatDate(patient.dateOfBirth)}</td>
              <td>{[patient.quarter, patient.village].filter(Boolean).join(', ') || '—'}</td>
              <td>
                {formatInstant(patient.lastScreeningAt)}
                <small>{displayValue(patient.lastLocationName)}</small>
              </td>
              <td>
                <button className="text-button" type="button" onClick={() => onSelect(patient)}>
                  View <span aria-hidden="true">→</span>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  onPage,
  busy,
}: Readonly<{
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
  busy: boolean;
}>) {
  if (totalPages <= 1) return null;
  return (
    <nav className="pagination" aria-label="Patient results pages">
      <button className="button button-quiet" disabled={busy || page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span>Page {page} of {totalPages}</span>
      <button className="button button-quiet" disabled={busy || page >= totalPages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </nav>
  );
}

function Vitals({ detail }: Readonly<{ detail: PatientDetail }>) {
  if (detail.screeningHistory.items.length === 0) {
    return <div className="empty-inline">No canonical screening history is available.</div>;
  }
  return (
    <div className="timeline">
      {detail.screeningHistory.items.map((screening) => (
        <article className="screening-card" key={screening.encounterId}>
          <header>
            <div>
              <p className="eyebrow">{formatDate(screening.sessionDate)}</p>
              <h3>{screening.locationName}</h3>
              <p>{screening.organizationName}</p>
            </div>
            <span className={`status status-${screening.status.toLowerCase()}`}>
              {humanize(screening.status)}
            </span>
          </header>
          <dl className="screening-meta">
            <div><dt>Recorded by</dt><dd>{screening.recordedByPractitionerName}</dd></div>
            <div><dt>Protocol</dt><dd>{screening.protocolVersionLabel}</dd></div>
            <div><dt>Started</dt><dd>{formatInstant(screening.startedAt)}</dd></div>
          </dl>
          {screening.amendmentReason ? (
            <div className="amendment-note"><strong>Amendment:</strong> {screening.amendmentReason}</div>
          ) : null}
          {screening.vitals ? (
            <>
              <div className="measurements">
                <div><span>Weight</span><strong>{displayValue(screening.vitals.weightKg)}{screening.vitals.weightKg !== null ? ' kg' : ''}</strong></div>
                <div><span>Waist</span><strong>{displayValue(screening.vitals.waistCm)}{screening.vitals.waistCm !== null ? ' cm' : ''}</strong></div>
                <div><span>Vitals status</span><strong>{humanize(screening.vitals.status)}</strong></div>
              </div>
              {screening.vitals.readings.length > 0 ? (
                <div className="reading-list">
                  <div className="reading-row reading-heading">
                    <span>Reading</span><span>Blood pressure</span><span>Pulse</span><span>Position</span><span>Time</span>
                  </div>
                  {screening.vitals.readings.map((reading) => (
                    <div className="reading-row" key={reading.readingId}>
                      <span>#{reading.sequenceNumber}</span>
                      <strong>{displayValue(reading.systolicMmhg)}/{displayValue(reading.diastolicMmhg)} <small>mmHg</small></strong>
                      <span>{displayValue(reading.pulseBpm)}{reading.pulseBpm !== null ? ' bpm' : ''}</span>
                      <span>{humanize(reading.patientPosition)}</span>
                      <span>{reading.measurementLocalTime || '—'}</span>
                    </div>
                  ))}
                </div>
              ) : <div className="empty-inline">No blood-pressure readings recorded.</div>}
            </>
          ) : <div className="empty-inline">No canonical vitals recorded for this encounter.</div>}
        </article>
      ))}
    </div>
  );
}

function PatientPanel({
  detail,
  busy,
  error,
  onClose,
  onHistoryPage,
}: Readonly<{
  detail: PatientDetail | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onHistoryPage: (page: number) => void;
}>) {
  if (!detail && !busy && !error) return null;
  return (
    <aside className="patient-panel" aria-label="Patient details">
      <div className="panel-toolbar">
        <button className="text-button" type="button" onClick={onClose}>← Back to results</button>
      </div>
      {busy ? <div className="panel-loading" role="status">Loading canonical patient record…</div> : null}
      {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
      {detail ? (
        <>
          <section className="patient-identity">
            <div className="patient-avatar" aria-hidden="true">{detail.displayName.charAt(0).toUpperCase()}</div>
            <div>
              <p className="eyebrow">Canonical patient record</p>
              <h2>{detail.displayName}</h2>
              <span className="medical-id">{detail.chsMedicalId}</span>
            </div>
            <span className={`status status-${detail.status.toLowerCase()}`}>{humanize(detail.status)}</span>
          </section>
          <section className="detail-section">
            <h3>Patient information</h3>
            <dl className="detail-grid">
              <div><dt>Date of birth</dt><dd>{formatDate(detail.dateOfBirth)}</dd></div>
              <div><dt>Sex</dt><dd>{humanize(detail.sex)}</dd></div>
              <div><dt>Phone</dt><dd>{displayValue(detail.phone)}</dd></div>
              <div><dt>Residence</dt><dd>{[detail.quarter, detail.village].filter(Boolean).join(', ') || '—'}</dd></div>
              <div><dt>Alternate contact</dt><dd>{displayValue(detail.alternateContactName)}</dd></div>
              <div><dt>Alternate phone</dt><dd>{displayValue(detail.alternateContactPhone)}</dd></div>
            </dl>
          </section>
          <section className="detail-section clinical-history">
            <div className="section-heading">
              <div><p className="eyebrow">Accepted canonical data only</p><h3>Screening history</h3></div>
              <span>{detail.screeningHistory.totalItems} encounter{detail.screeningHistory.totalItems === 1 ? '' : 's'}</span>
            </div>
            <Vitals detail={detail} />
            <Pagination
              page={detail.screeningHistory.page}
              totalPages={detail.screeningHistory.totalPages}
              onPage={onHistoryPage}
              busy={busy}
            />
          </section>
        </>
      ) : null}
    </aside>
  );
}

export default function App({ config }: AppProps) {
  const [session, setSession] = useState<AuthSession | null>(() => getAuthSession());
  const [authBusy, setAuthBusy] = useState(() => hasAuthorizationResponse());
  const [authError, setAuthError] = useState<string | null>(null);
  const [reason, setReason] = useState<PatientAccessReason | ''>('');
  const [workspaceView, setWorkspaceView] = useState<'PATIENTS' | 'RECOVERY' | 'SYNC' | 'IDENTITY'>('PATIENTS');
  const [form, setForm] = useState<SearchForm>(initialSearch);
  const [submittedForm, setSubmittedForm] = useState<SearchForm | null>(null);
  const [results, setResults] = useState<PatientListPage | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PatientDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const signInCompletion = useRef<Promise<AuthSession> | null>(null);

  const api = useMemo(
    () => session ? createOperationsApi(config.apiBaseUrl, session.accessToken) : null,
    [config.apiBaseUrl, session],
  );

  useEffect(() => {
    if (!hasAuthorizationResponse()) return;
    let active = true;
    signInCompletion.current ??= completeSignIn(config.oidc);
    void signInCompletion.current
      .then((newSession) => {
        if (active) setSession(newSession);
      })
      .catch(() => {
        clearAuthSession();
        if (active) setAuthError('Sign-in could not be completed. Please try again.');
      })
      .finally(() => {
        finishAuthorizationNavigation();
        if (active) setAuthBusy(false);
      });
    return () => { active = false; };
  }, [config.oidc]);

  function handleUnauthorized(error: unknown): void {
    if (error instanceof ApiError && error.status === 401) {
      clearAuthSession();
      setSession(null);
    }
  }

  async function runSearch(page: number, criteria = form): Promise<void> {
    if (!api || !reason) return;
    const sequence = ++requestSequence.current;
    setSearchBusy(true);
    setSearchError(null);
    setDetail(null);
    setSelectedId(null);
    try {
      const result = await api.searchPatients({
        reasonCode: reason,
        ...(criteria.search.trim() ? { search: criteria.search.trim() } : {}),
        ...(criteria.dateOfBirth ? { dateOfBirth: criteria.dateOfBirth } : {}),
        status: criteria.status,
        page,
        pageSize: 25,
      });
      if (sequence === requestSequence.current) {
        setSubmittedForm(criteria);
        setResults(result);
      }
    } catch (error) {
      handleUnauthorized(error);
      if (sequence === requestSequence.current) setSearchError(friendlyError(error));
    } finally {
      if (sequence === requestSequence.current) setSearchBusy(false);
    }
  }

  async function openPatient(patient: PatientListItem, page = 1): Promise<void> {
    if (!api || !reason) return;
    const sequence = ++requestSequence.current;
    setSelectedId(patient.personId);
    setDetailBusy(true);
    setDetailError(null);
    if (page === 1) setDetail(null);
    try {
      const patientDetail = await api.getPatientDetail({
        reasonCode: reason,
        personId: patient.personId,
        page,
        pageSize: 10,
      });
      if (sequence === requestSequence.current) setDetail(patientDetail);
    } catch (error) {
      handleUnauthorized(error);
      if (sequence === requestSequence.current) setDetailError(friendlyError(error));
    } finally {
      if (sequence === requestSequence.current) setDetailBusy(false);
    }
  }

  function clearPatientData(): void {
    requestSequence.current += 1;
    setResults(null);
    setSubmittedForm(null);
    setSelectedId(null);
    setDetail(null);
    setSearchError(null);
    setDetailError(null);
  }

  if (!session) {
    return (
      <SignInView
        busy={authBusy}
        error={authError}
        onSignIn={() => {
          setAuthError(null);
          setAuthBusy(true);
          void startSignIn(config.oidc).catch(() => {
            setAuthBusy(false);
            setAuthError('Secure sign-in could not be started.');
          });
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <Brand />
        <nav className="workspace-nav" aria-label="Operations workspaces">
          <button
            className={workspaceView === 'PATIENTS' ? 'active' : ''}
            type="button"
            onClick={() => setWorkspaceView('PATIENTS')}
          >
            Patient Viewer
          </button>
          <button
            className={workspaceView === 'RECOVERY' ? 'active' : ''}
            type="button"
            onClick={() => {
              clearPatientData();
              setWorkspaceView('RECOVERY');
            }}
          >
            Recover Medical ID
          </button>
          <button
            className={workspaceView === 'SYNC' ? 'active' : ''}
            type="button"
            onClick={() => {
              clearPatientData();
              setWorkspaceView('SYNC');
            }}
          >
            Sync Monitoring
          </button>
          <button
            className={workspaceView === 'IDENTITY' ? 'active' : ''}
            type="button"
            onClick={() => {
              clearPatientData();
              setWorkspaceView('IDENTITY');
            }}
          >
            Identity Review
          </button>
        </nav>
        <div className="topbar-actions">
          <span className="secure-indicator"><i aria-hidden="true" /> Secure session</span>
          <button className="button button-quiet" onClick={() => signOut(config.oidc)}>Sign out</button>
        </div>
      </header>
      <main className="workspace">
        <section className="page-heading">
          <div>
            <p className="eyebrow">
              {workspaceView === 'SYNC'
                ? 'Central PostgreSQL · synchronization operations'
                : workspaceView === 'IDENTITY'
                  ? 'Central PostgreSQL · identity reconciliation'
                  : 'Central PostgreSQL · canonical records'}
            </p>
            <h1>
              {workspaceView === 'PATIENTS'
                ? 'Patient Viewer'
                : workspaceView === 'RECOVERY'
                  ? 'Medical ID Recovery'
                  : workspaceView === 'SYNC'
                    ? 'Sync Monitoring'
                    : 'Identity Review'}
            </h1>
            <p>
              {workspaceView === 'PATIENTS'
                ? 'Search deduplicated patient records and review accepted screening history.'
                : workspaceView === 'RECOVERY'
                  ? 'Safely recover an existing CHS Medical ID without creating a replacement.'
                  : workspaceView === 'SYNC'
                    ? 'Inspect scoped batch health and redacted synchronization outcomes.'
                    : 'Compare submitted identity evidence with masked candidates and resolve duplicate-risk cases.'}
            </p>
          </div>
          {workspaceView === 'SYNC' || workspaceView === 'IDENTITY' ? (
            <div className="reason-field">
              <span className="reason-label">Reason for access</span>
              <div className="fixed-reason">
                {workspaceView === 'SYNC' ? 'Operations support' : 'Identity reconciliation'}
              </div>
              <small>Fixed by the workspace contract and recorded in the audit.</small>
            </div>
          ) : (
            <div className="reason-field">
              <label htmlFor="reason-code">Reason for access <span aria-hidden="true">*</span></label>
              <select
                id="reason-code"
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value as PatientAccessReason | '');
                  clearPatientData();
                }}
              >
                <option value="">Select reason</option>
                {reasons.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
              <small>Required and recorded in the access audit.</small>
            </div>
          )}
        </section>
        {workspaceView === 'PATIENTS' ? (
          <>
            <section className="card search-card">
              <PatientSearchForm
                value={form}
                reason={reason}
                busy={searchBusy}
                onChange={setForm}
                onSubmit={() => void runSearch(1)}
                onClear={() => {
                  setForm(initialSearch);
                  clearPatientData();
                }}
              />
            </section>

            <div className="privacy-strip">
              <span aria-hidden="true">✓</span>
              Only clean, accepted canonical records are shown. Raw sync payloads and unresolved identity candidates are excluded.
            </div>

            {searchError ? <div className="alert alert-error" role="alert">{searchError}</div> : null}
            <div className="results-heading">
              <div>
                <h2>Patient results</h2>
                <p aria-live="polite">
                  {results ? `${results.totalItems} patient${results.totalItems === 1 ? '' : 's'} found` : 'Run a search to view patients.'}
                </p>
              </div>
              {searchBusy ? <span className="loading-label" role="status">Searching…</span> : null}
            </div>
            {results ? (
              <section className="card results-card">
                <PatientTable result={results} selectedId={selectedId} onSelect={(patient) => void openPatient(patient)} />
                <Pagination
                  page={results.page}
                  totalPages={results.totalPages}
                  busy={searchBusy}
                  onPage={(page) => submittedForm && void runSearch(page, submittedForm)}
                />
              </section>
            ) : (
              <section className="card empty-state initial-empty">
                <span className="empty-icon" aria-hidden="true">⌕</span>
                <h2>No patient search has been run</h2>
                <p>Select a reason for access, enter search criteria, and choose Search.</p>
              </section>
            )}
          </>
        ) : workspaceView === 'RECOVERY' && api ? (
          <MedicalIdRecovery
            api={api}
            reason={reason}
            onUnauthorized={() => {
              clearAuthSession();
              setSession(null);
            }}
          />
        ) : workspaceView === 'SYNC' && api ? (
          <SyncMonitoring
            api={api}
            onUnauthorized={() => {
              clearAuthSession();
              setSession(null);
            }}
          />
        ) : workspaceView === 'IDENTITY' && api ? (
          <IdentityReview
            api={api}
            onUnauthorized={() => {
              clearAuthSession();
              setSession(null);
            }}
          />
        ) : null}
      </main>
      {workspaceView === 'PATIENTS' ? (
        <PatientPanel
          detail={detail}
          busy={detailBusy}
          error={detailError}
          onClose={() => {
            requestSequence.current += 1;
            setSelectedId(null);
            setDetail(null);
            setDetailError(null);
            setDetailBusy(false);
          }}
          onHistoryPage={(page) => {
            const patient = results?.items.find((item) => item.personId === selectedId);
            if (patient) void openPatient(patient, page);
          }}
        />
      ) : null}
    </div>
  );
}
