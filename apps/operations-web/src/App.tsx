import { PatientHistory } from './PatientHistory';
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
import { LifestyleAssessment } from './LifestyleAssessment';
import { MedicalIdRecovery } from './MedicalIdRecovery';
import { PatientAssurance } from './PatientAssurance';
import { SyncMonitoring } from './SyncMonitoring';
import type {
  PatientAccessReason,
  PatientDetail,
  PatientListItem,
  PatientListPage,
  PatientReferralDetail,
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
  if (error.code === 'PATIENT_REFERRAL_NOT_FOUND') {
    return 'The referral was not found within your authorized locations.';
  }
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
  ariaLabel = 'Patient results pages',
}: Readonly<{
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
  busy: boolean;
  ariaLabel?: string;
}>) {
  if (totalPages <= 1) return null;
  return (
    <nav className="pagination" aria-label={ariaLabel}>
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
            <div><dt>Screening time</dt><dd>{screening.clinicalTime ? `${screening.clinicalTime.localDate} ${screening.clinicalTime.localTime} (${screening.clinicalTime.timezone})` : formatInstant(screening.startedAt)}</dd></div>
            {screening.documentationStartedAt ? <div><dt>Documentation started</dt><dd>{formatInstant(screening.documentationStartedAt)}</dd></div> : null}
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
          <LifestyleAssessment assessment={screening.lifestyle} />
        </article>
      ))}
    </div>
  );
}

function ReferralDetailHistory({
  detail,
  busy,
  error,
  onStatusPage,
  onFollowupPage,
}: Readonly<{
  detail: PatientReferralDetail | null;
  busy: boolean;
  error: string | null;
  onStatusPage: (page: number) => void;
  onFollowupPage: (page: number) => void;
}>) {
  if (busy) {
    return <div className="referral-loading" role="status">Loading referral history…</div>;
  }
  if (error) return <div className="alert alert-error" role="alert">{error}</div>;
  if (!detail) return null;

  return (
    <div className="referral-detail">
      <section aria-labelledby={`status-history-${detail.referral.referralId}`}>
        <div className="referral-subheading">
          <h5 id={`status-history-${detail.referral.referralId}`}>Status history</h5>
          <span>{detail.statusHistory.totalItems} event{detail.statusHistory.totalItems === 1 ? '' : 's'}</span>
        </div>
        {detail.statusHistory.items.length === 0 ? (
          <div className="empty-inline">No status events are available.</div>
        ) : (
          <ol className="referral-status-list">
            {detail.statusHistory.items.map((event) => (
              <li key={event.statusEventId}>
                <div>
                  <strong>{humanize(event.toStatus)}</strong>
                  <span>{event.fromStatus ? `From ${humanize(event.fromStatus)}` : 'Referral opened'}</span>
                </div>
                <p>{displayValue(event.changeReason)}</p>
                <small>{formatInstant(event.changedAt)} · {event.changedByPractitionerName}</small>
              </li>
            ))}
          </ol>
        )}
        <Pagination
          page={detail.statusHistory.page}
          totalPages={detail.statusHistory.totalPages}
          onPage={onStatusPage}
          busy={busy}
          ariaLabel="Referral status history pages"
        />
      </section>

      <section aria-labelledby={`followup-history-${detail.referral.referralId}`}>
        <div className="referral-subheading">
          <h5 id={`followup-history-${detail.referral.referralId}`}>Follow-up history</h5>
          <span>{detail.followupHistory.totalItems} follow-up{detail.followupHistory.totalItems === 1 ? '' : 's'}</span>
        </div>
        {detail.followupHistory.items.length === 0 ? (
          <div className="empty-inline">No follow-ups are available.</div>
        ) : (
          <div className="referral-followups">
            {detail.followupHistory.items.map((followup) => (
              <article key={followup.followupId}>
                <header>
                  <div>
                    <strong>{formatDate(followup.contactDate)}</strong>
                    <span>{humanize(followup.contactMethod)} · {humanize(followup.informationSource)}</span>
                  </div>
                  <small>{humanize(followup.sourceType)}</small>
                </header>
                <dl className="referral-detail-grid">
                  <div><dt>Provider seen</dt><dd>{followup.providerSeen === null ? '—' : followup.providerSeen ? 'Yes' : 'No'}</dd></div>
                  <div><dt>Facility</dt><dd>{displayValue(followup.facilityName)}</dd></div>
                  <div><dt>Date seen</dt><dd>{formatDate(followup.dateSeen)}</dd></div>
                  <div><dt>Outcome</dt><dd>{displayValue(followup.reportedOutcome)}</dd></div>
                  <div><dt>Reported advice</dt><dd>{displayValue(followup.reportedMedicationsOrAdvice)}</dd></div>
                  <div><dt>Next action</dt><dd>{displayValue(followup.nextAction)}</dd></div>
                  <div><dt>Next follow-up</dt><dd>{formatDate(followup.nextFollowupDate)}</dd></div>
                  <div><dt>Recorded by</dt><dd>{followup.recordedByPractitionerName}</dd></div>
                  <div><dt>Recorded at</dt><dd>{formatInstant(followup.recordedAt)}</dd></div>
                </dl>
                {followup.treatmentActions.length > 0 ? (
                  <div className="referral-reported-items">
                    <strong>Treatment actions</strong>
                    <ul>{followup.treatmentActions.map((action) => <li key={action.sequenceNumber}>{humanize(action.actionCode)}</li>)}</ul>
                  </div>
                ) : null}
                {followup.medicationChanges.length > 0 ? (
                  <div className="referral-reported-items">
                    <strong>Medication changes</strong>
                    <ul>
                      {followup.medicationChanges.map((medication) => (
                        <li key={medication.sequenceNumber}>
                          {humanize(medication.changeType)}: {medication.medicationName}
                          {medication.dosage ? ` · ${medication.dosage}` : ''}
                          {medication.frequency ? ` · ${medication.frequency}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
        <Pagination
          page={detail.followupHistory.page}
          totalPages={detail.followupHistory.totalPages}
          onPage={onFollowupPage}
          busy={busy}
          ariaLabel="Referral follow-up history pages"
        />
      </section>
    </div>
  );
}

export function ReferralHistory({
  patient,
  selectedReferralId,
  referralDetail,
  referralBusy,
  referralError,
  onOpen,
  onStatusPage,
  onFollowupPage,
}: Readonly<{
  patient: PatientDetail;
  selectedReferralId: string | null;
  referralDetail: PatientReferralDetail | null;
  referralBusy: boolean;
  referralError: string | null;
  onOpen: (referralId: string) => void;
  onStatusPage: (page: number) => void;
  onFollowupPage: (page: number) => void;
}>) {
  if (patient.referralHistory.items.length === 0) {
    return <div className="empty-inline">No canonical referrals are available.</div>;
  }

  return (
    <div className="referral-list">
      {patient.referralHistory.items.map((referral) => {
        const selected = selectedReferralId === referral.referralId;
        return (
          <article className="referral-card" key={referral.referralId}>
            <header>
              <div>
                <p className="eyebrow">Created {formatInstant(referral.createdAt)}</p>
                <h4>{referral.reasonCodes.map(humanize).join(', ')}</h4>
                <p>{referral.locationName} · {referral.organizationName}</p>
              </div>
              <div className="referral-badges">
                {referral.urgency === 'URGENT' ? <span className="status status-urgent">Urgent</span> : null}
                <span className={`status status-${referral.status.toLowerCase()}`}>{humanize(referral.status)}</span>
              </div>
            </header>
            <dl className="referral-summary-grid">
              <div><dt>Destination</dt><dd>{displayValue(referral.destinationName)}</dd></div>
              <div><dt>Due date</dt><dd>{formatDate(referral.dueDate)}</dd></div>
              <div><dt>Encounter</dt><dd>{humanize(referral.encounterStatus)}</dd></div>
              <div><dt>Created by</dt><dd>{referral.createdByPractitionerName}</dd></div>
              <div><dt>Last updated</dt><dd>{formatInstant(referral.updatedAt)}</dd></div>
              <div><dt>Follow-ups</dt><dd>{referral.followupCount}</dd></div>
            </dl>
            {referral.reasonText ? <p className="referral-note">{referral.reasonText}</p> : null}
            {referral.encounterStatus === 'VOID' ? (
              <p className="referral-warning">The originating encounter is void. The referral history remains available for continuity and audit.</p>
            ) : null}
            {referral.status === 'CLOSED' ? (
              <p className="referral-closure"><strong>Closed:</strong> {displayValue(referral.closureReason)} · {formatInstant(referral.closedAt)}</p>
            ) : null}
            <div className="referral-actions">
              <button
                className="button button-quiet"
                type="button"
                disabled={selected && referralBusy}
                onClick={() => onOpen(referral.referralId)}
              >
                {selected && referralDetail ? 'Refresh history' : 'View history'}
              </button>
              <span>{referral.statusEventCount} status event{referral.statusEventCount === 1 ? '' : 's'}</span>
            </div>
            {selected ? (
              <ReferralDetailHistory
                detail={referralDetail?.referral.referralId === referral.referralId ? referralDetail : null}
                busy={referralBusy}
                error={referralError}
                onStatusPage={onStatusPage}
                onFollowupPage={onFollowupPage}
              />
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function PatientPanel({
  historyApi, historyReason, onHistoryUnauthorized,
  detail,
  busy,
  error,
  selectedReferralId,
  referralDetail,
  referralBusy,
  referralError,
  onClose,
  onHistoryPage,
  onReferralPage,
  onReferralOpen,
  onReferralStatusPage,
  onReferralFollowupPage,
}: Readonly<{
  historyApi: ReturnType<typeof createOperationsApi> | null;
  historyReason: PatientAccessReason | '';
  onHistoryUnauthorized: (error: unknown) => void;
  detail: PatientDetail | null;
  busy: boolean;
  error: string | null;
  selectedReferralId: string | null;
  referralDetail: PatientReferralDetail | null;
  referralBusy: boolean;
  referralError: string | null;
  onClose: () => void;
  onHistoryPage: (page: number) => void;
  onReferralPage: (page: number) => void;
  onReferralOpen: (referralId: string) => void;
  onReferralStatusPage: (page: number) => void;
  onReferralFollowupPage: (page: number) => void;
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
          <PatientAssurance
            identityAssurance={detail.identityAssurance}
            sourceProvenance={detail.sourceProvenance}
          />
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
          {historyApi && historyReason ? <PatientHistory key={`${detail.personId}:${historyReason}`} api={historyApi} personId={detail.personId} reason={historyReason} onUnauthorized={onHistoryUnauthorized}/> : null}
          <section className="detail-section referral-history">
            <div className="section-heading">
              <div><p className="eyebrow">Accepted canonical data only</p><h3>Referral history</h3></div>
              <span>{detail.referralHistory.totalItems} referral{detail.referralHistory.totalItems === 1 ? '' : 's'}</span>
            </div>
            <ReferralHistory
              patient={detail}
              selectedReferralId={selectedReferralId}
              referralDetail={referralDetail}
              referralBusy={referralBusy}
              referralError={referralError}
              onOpen={onReferralOpen}
              onStatusPage={onReferralStatusPage}
              onFollowupPage={onReferralFollowupPage}
            />
            <Pagination
              page={detail.referralHistory.page}
              totalPages={detail.referralHistory.totalPages}
              onPage={onReferralPage}
              busy={busy}
              ariaLabel="Patient referral history pages"
            />
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
  const [selectedReferralId, setSelectedReferralId] = useState<string | null>(null);
  const [referralDetail, setReferralDetail] = useState<PatientReferralDetail | null>(null);
  const [referralBusy, setReferralBusy] = useState(false);
  const [referralError, setReferralError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const referralRequestSequence = useRef(0);
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
    referralRequestSequence.current += 1;
    setSelectedReferralId(null);
    setReferralDetail(null);
    setReferralError(null);
    setReferralBusy(false);
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

  async function openPatient(
    patient: PatientListItem,
    page = 1,
    referralPage = 1,
  ): Promise<void> {
    if (!api || !reason) return;
    const sequence = ++requestSequence.current;
    referralRequestSequence.current += 1;
    setSelectedId(patient.personId);
    setDetailBusy(true);
    setDetailError(null);
    setSelectedReferralId(null);
    setReferralDetail(null);
    setReferralError(null);
    setReferralBusy(false);
    if (page === 1 && referralPage === 1) setDetail(null);
    try {
      const patientDetail = await api.getPatientDetail({
        reasonCode: reason,
        personId: patient.personId,
        page,
        pageSize: 10,
        referralPage,
        referralPageSize: 5,
      });
      if (sequence === requestSequence.current) setDetail(patientDetail);
    } catch (error) {
      handleUnauthorized(error);
      if (sequence === requestSequence.current) setDetailError(friendlyError(error));
    } finally {
      if (sequence === requestSequence.current) setDetailBusy(false);
    }
  }

  async function openReferral(
    referralId: string,
    statusPage = 1,
    followupPage = 1,
  ): Promise<void> {
    if (!api || !reason || !selectedId) return;
    const sequence = ++referralRequestSequence.current;
    setSelectedReferralId(referralId);
    setReferralBusy(true);
    setReferralError(null);
    if (statusPage === 1 && followupPage === 1) setReferralDetail(null);
    try {
      const result = await api.getPatientReferralDetail({
        reasonCode: reason,
        personId: selectedId,
        referralId,
        statusPage,
        statusPageSize: 10,
        followupPage,
        followupPageSize: 5,
      });
      if (sequence === referralRequestSequence.current) setReferralDetail(result);
    } catch (error) {
      handleUnauthorized(error);
      if (sequence === referralRequestSequence.current) {
        setReferralError(friendlyError(error));
      }
    } finally {
      if (sequence === referralRequestSequence.current) setReferralBusy(false);
    }
  }

  function clearPatientData(): void {
    requestSequence.current += 1;
    referralRequestSequence.current += 1;
    setResults(null);
    setSubmittedForm(null);
    setSelectedId(null);
    setDetail(null);
    setSearchError(null);
    setDetailError(null);
    setSelectedReferralId(null);
    setReferralDetail(null);
    setReferralError(null);
    setReferralBusy(false);
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
          historyApi={api} historyReason={reason} onHistoryUnauthorized={handleUnauthorized}
          detail={detail}
          busy={detailBusy}
          error={detailError}
          selectedReferralId={selectedReferralId}
          referralDetail={referralDetail}
          referralBusy={referralBusy}
          referralError={referralError}
          onClose={() => {
            requestSequence.current += 1;
            referralRequestSequence.current += 1;
            setSelectedId(null);
            setDetail(null);
            setDetailError(null);
            setDetailBusy(false);
            setSelectedReferralId(null);
            setReferralDetail(null);
            setReferralError(null);
            setReferralBusy(false);
          }}
          onHistoryPage={(page) => {
            const patient = results?.items.find((item) => item.personId === selectedId);
            if (patient) void openPatient(patient, page, detail?.referralHistory.page ?? 1);
          }}
          onReferralPage={(page) => {
            const patient = results?.items.find((item) => item.personId === selectedId);
            if (patient) void openPatient(patient, detail?.screeningHistory.page ?? 1, page);
          }}
          onReferralOpen={(referralId) => void openReferral(referralId)}
          onReferralStatusPage={(page) => {
            if (selectedReferralId) {
              void openReferral(
                selectedReferralId,
                page,
                referralDetail?.followupHistory.page ?? 1,
              );
            }
          }}
          onReferralFollowupPage={(page) => {
            if (selectedReferralId) {
              void openReferral(
                selectedReferralId,
                referralDetail?.statusHistory.page ?? 1,
                page,
              );
            }
          }}
        />
      ) : null}
    </div>
  );
}
