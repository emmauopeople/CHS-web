import { useRef, useState } from 'react';

import { ApiError, type OperationsApi } from './api';
import { displayValue, formatDate, formatInstant, humanize } from './format';
import type {
  IdentityReviewCandidate,
  IdentityReviewCaseDetail,
  IdentityReviewEvidenceState,
  IdentityReviewQueueItem,
  IdentityReviewQueuePage,
  IdentityReviewResolutionResult,
  MaskedBirthEvidence,
} from './types';

type Props = Readonly<{
  api: OperationsApi;
  onUnauthorized: () => void;
}>;

type FilterForm = Readonly<{
  evidenceState: IdentityReviewEvidenceState | 'ALL';
  installationId: string;
  openedFrom: string;
  openedTo: string;
}>;

type ResolutionKind = '' | 'LINK_EXISTING' | 'CREATE_NEW';

const initialFilters: FilterForm = {
  evidenceState: 'ALL',
  installationId: '',
  openedFrom: '',
  openedTo: '',
};

function reviewError(error: unknown, detail = false): string {
  if (!(error instanceof ApiError)) {
    return 'Identity review could not be completed. Try again.';
  }
  if (error.status === 401) return 'Your session has expired. Sign in again.';
  if (error.status === 403) return 'Your account does not have identity review permission.';
  if (error.status === 404 && detail) {
    return 'This review case is no longer available within your authorized scope.';
  }
  if (error.status === 409) {
    switch (error.code) {
      case 'IDENTITY_REVIEW_STALE':
        return 'This case changed after it was opened. Refresh the case before making a decision.';
      case 'IDENTITY_REVIEW_ALREADY_RESOLVED':
        return 'This case has already been resolved. Refresh the review queue.';
      case 'IDENTITY_REVIEW_CANDIDATE_NOT_AVAILABLE':
        return 'The selected candidate is no longer available. Refresh the case and compare again.';
      case 'IDENTITY_REVIEW_EVIDENCE_INCOMPLETE':
        return 'A new identity cannot be created until complete evidence arrives in a later sync.';
      case 'IDENTITY_REVIEW_RESOLUTION_REQUEST_REUSE':
        return 'This resolution request ID was already used for a different decision. Review and submit again.';
      default:
        break;
    }
  }
  if (error.status === 503) return 'Identity review is temporarily unavailable.';
  const reference = error.requestId ? ` Reference: ${error.requestId}.` : '';
  return `Identity review could not be completed.${reference}`;
}

function toInstant(value: string): string | undefined {
  if (!value) return undefined;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString();
}

function birthEvidence(value: MaskedBirthEvidence | null): string {
  if (!value) return '—';
  return value.kind === 'DATE_OF_BIRTH'
    ? value.maskedDate
    : `Approx. age ${value.ageYears} in ${value.asOfYear}`;
}

function QueueTable({
  result,
  selectedReference,
  onSelect,
}: Readonly<{
  result: IdentityReviewQueuePage;
  selectedReference: string | null;
  onSelect: (item: IdentityReviewQueueItem) => void;
}>) {
  if (result.items.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon" aria-hidden="true">✓</span>
        <h2>No open identity review cases found</h2>
        <p>Adjust the filters or confirm your authorized organization scope.</p>
      </div>
    );
  }

  return (
    <div className="table-shell">
      <table className="identity-table">
        <caption className="visually-hidden">Open patient identity review cases</caption>
        <thead>
          <tr>
            <th>Submitted identity</th>
            <th>Source</th>
            <th>Evidence</th>
            <th>Candidates</th>
            <th>Opened</th>
            <th><span className="visually-hidden">Open review</span></th>
          </tr>
        </thead>
        <tbody>
          {result.items.map((item) => (
            <tr
              key={item.caseReference}
              className={selectedReference === item.caseReference ? 'selected-row' : ''}
            >
              <td>
                <strong>{displayValue(item.maskedSubmittedName)}</strong>
                <small>{birthEvidence(item.submittedBirthEvidence)} · {displayValue(item.localPatientCode)}</small>
              </td>
              <td>
                <strong>{item.deploymentName}</strong>
                <small>{item.organizationName} · {item.locationName}</small>
              </td>
              <td>
                <span className={`status identity-state-${item.evidenceState === 'AVAILABLE' ? 'available' : 'pending'}`}>
                  {humanize(item.evidenceState)}
                </span>
                <small>{item.latestSourceRevision ? `Revision ${item.latestSourceRevision}` : 'Awaiting source record'}</small>
              </td>
              <td><strong>{item.candidateCount}</strong></td>
              <td>{formatInstant(item.openedAt)}</td>
              <td>
                <button className="text-button" type="button" onClick={() => onSelect(item)}>
                  Review <span aria-hidden="true">→</span>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EvidenceCard({ detail }: Readonly<{ detail: IdentityReviewCaseDetail }>) {
  if (!detail.evidence) {
    return (
      <div className="evidence-pending">
        <strong>Evidence pending</strong>
        <p>The review case exists, but the minimum source identity evidence has not arrived.</p>
      </div>
    );
  }
  const evidence = detail.evidence;
  return (
    <article className="identity-evidence-card submitted-evidence">
      <p className="eyebrow">Exact submitted evidence</p>
      <h3>{evidence.displayName}</h3>
      <dl className="detail-grid identity-evidence-grid">
        <div><dt>Local patient code</dt><dd>{evidence.localPatientCode}</dd></div>
        <div><dt>Claimed Medical ID</dt><dd>{displayValue(evidence.maskedClaimedChsMedicalId)}</dd></div>
        <div><dt>Date of birth</dt><dd>{formatDate(evidence.dateOfBirth)}</dd></div>
        <div><dt>Approximate age</dt><dd>{displayValue(evidence.approximateAgeYears)}</dd></div>
        <div><dt>Age as of</dt><dd>{formatDate(evidence.ageAsOfDate)}</dd></div>
        <div><dt>Sex</dt><dd>{humanize(evidence.sex)}</dd></div>
        <div><dt>Phone</dt><dd>{displayValue(evidence.phone)}</dd></div>
        <div><dt>Residence</dt><dd>{[evidence.quarter, evidence.village].filter(Boolean).join(', ') || '—'}</dd></div>
        <div><dt>Acknowledgment</dt><dd>{humanize(evidence.acknowledgmentStatus)}</dd></div>
        <div><dt>Patient status</dt><dd>{humanize(evidence.patientStatus)}</dd></div>
        <div><dt>Source revision</dt><dd>{evidence.sourceRevision}</dd></div>
        <div><dt>Captured</dt><dd>{formatInstant(evidence.capturedAt)}</dd></div>
      </dl>
    </article>
  );
}

function CandidateCard({
  candidate,
  selected,
  onSelect,
}: Readonly<{
  candidate: IdentityReviewCandidate;
  selected: boolean;
  onSelect: () => void;
}>) {
  return (
    <label className={`identity-candidate ${selected ? 'selected-candidate' : ''}`}>
      <span className="candidate-choice">
        <input
          type="radio"
          name="identity-candidate"
          value={candidate.personReference}
          checked={selected}
          onChange={onSelect}
        />
        <strong>{candidate.maskedName}</strong>
        <span className="candidate-score">Score {candidate.score}</span>
      </span>
      <span className="candidate-facts">
        <span><b>Medical ID</b>{displayValue(candidate.maskedChsMedicalId)}</span>
        <span><b>Birth evidence</b>{birthEvidence(candidate.birthEvidence)}</span>
        <span><b>Sex</b>{humanize(candidate.sex)}</span>
        <span><b>Phone</b>{displayValue(candidate.maskedPhone)}</span>
        <span><b>Residence</b>{displayValue(candidate.maskedResidence)}</span>
        <span><b>Matched on</b>{candidate.matchedOn.map(humanize).join(', ') || '—'}</span>
      </span>
    </label>
  );
}

function ResolutionSuccess({ result }: Readonly<{ result: IdentityReviewResolutionResult }>) {
  return (
    <section className="resolution-success" role="status">
      <p className="eyebrow">Identity resolved</p>
      <h3>{result.resolutionStatus === 'RESOLVED_NEW' ? 'New canonical identity created' : 'Existing identity linked'}</h3>
      <p>The desktop installation will receive this Medical ID on its next patient synchronization.</p>
      <div className="resolved-medical-id">{result.chsMedicalId}</div>
      <dl className="detail-grid">
        <div><dt>Local patient code</dt><dd>{result.localPatientCode}</dd></div>
        <div><dt>Source revision</dt><dd>{result.sourceRevision}</dd></div>
        <div><dt>Resolved</dt><dd>{formatInstant(result.resolvedAt)}</dd></div>
        <div><dt>Replay-safe response</dt><dd>{result.replayed ? 'Yes' : 'No'}</dd></div>
      </dl>
    </section>
  );
}

function ReviewPanel({
  api,
  detail,
  busy,
  error,
  success,
  onUnauthorized,
  onClose,
  onRefresh,
  onResolved,
}: Readonly<{
  api: OperationsApi;
  detail: IdentityReviewCaseDetail | null;
  busy: boolean;
  error: string | null;
  success: IdentityReviewResolutionResult | null;
  onUnauthorized: () => void;
  onClose: () => void;
  onRefresh: () => void;
  onResolved: (result: IdentityReviewResolutionResult) => void;
}>) {
  const [kind, setKind] = useState<ResolutionKind>('');
  const [candidateReference, setCandidateReference] = useState('');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [resolutionBusy, setResolutionBusy] = useState(false);
  const [resolutionError, setResolutionError] = useState<string | null>(null);
  const requestIdentity = useRef<{ fingerprint: string; id: string } | null>(null);

  if (!detail && !busy && !error && !success) return null;

  async function submitResolution(): Promise<void> {
    if (!detail || !confirmed || note.trim().length < 10 || !kind) return;
    if (kind === 'LINK_EXISTING' && !candidateReference) return;
    const resolution = kind === 'LINK_EXISTING'
      ? { kind, candidatePersonReference: candidateReference } as const
      : { kind: 'CREATE_NEW' } as const;
    const fingerprint = JSON.stringify({
      caseReference: detail.caseReference,
      expectedUpdatedAt: detail.updatedAt,
      resolutionNote: note.trim(),
      resolution,
    });
    if (requestIdentity.current?.fingerprint !== fingerprint) {
      requestIdentity.current = { fingerprint, id: crypto.randomUUID() };
    }

    setResolutionBusy(true);
    setResolutionError(null);
    try {
      const result = await api.resolveIdentityReview({
        reasonCode: 'IDENTITY_RECONCILIATION',
        resolutionRequestId: requestIdentity.current.id,
        caseReference: detail.caseReference,
        expectedUpdatedAt: detail.updatedAt,
        resolutionNote: note.trim(),
        resolution,
      });
      onResolved(result);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 401) onUnauthorized();
      if (
        requestError instanceof ApiError &&
        requestError.code === 'IDENTITY_REVIEW_RESOLUTION_REQUEST_REUSE'
      ) {
        requestIdentity.current = null;
      }
      setResolutionError(reviewError(requestError, true));
    } finally {
      setResolutionBusy(false);
    }
  }

  return (
    <aside className="patient-panel identity-review-panel" aria-label="Identity review details">
      <div className="panel-toolbar">
        <button className="text-button" type="button" onClick={onClose}>← Back to review queue</button>
        {detail ? <button className="text-button" type="button" disabled={busy || resolutionBusy} onClick={onRefresh}>Refresh case</button> : null}
      </div>
      {busy ? <div className="panel-loading" role="status">Loading protected identity evidence…</div> : null}
      {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
      {success ? <ResolutionSuccess result={success} /> : null}
      {detail && !success ? (
        <>
          <section className="identity-review-heading">
            <div>
              <p className="eyebrow">Open identity review</p>
              <h2>{detail.installation.deploymentName}</h2>
              <p>{detail.organization.name} · {detail.location.name}</p>
            </div>
            <span className={`status identity-state-${detail.evidenceState === 'AVAILABLE' ? 'available' : 'pending'}`}>
              {humanize(detail.evidenceState)}
            </span>
          </section>

          <section className="detail-section">
            <h3>Case context</h3>
            <dl className="detail-grid">
              <div><dt>Opened</dt><dd>{formatInstant(detail.openedAt)}</dd></div>
              <div><dt>Last changed</dt><dd>{formatInstant(detail.updatedAt)}</dd></div>
              <div><dt>Installation ID</dt><dd className="technical-value">{detail.installation.id}</dd></div>
              <div><dt>Candidate count</dt><dd>{detail.candidates.length}</dd></div>
            </dl>
          </section>

          <section className="detail-section">
            <div className="section-heading">
              <div><p className="eyebrow">Compare before deciding</p><h3>Submitted evidence</h3></div>
            </div>
            <EvidenceCard detail={detail} />
          </section>

          <section className="detail-section">
            <div className="section-heading">
              <div><p className="eyebrow">Masked canonical data</p><h3>Possible matches</h3></div>
              <span>{detail.candidates.length} candidate{detail.candidates.length === 1 ? '' : 's'}</span>
            </div>
            {detail.candidates.length ? (
              <div className="identity-candidate-list">
                {detail.candidates.map((candidate) => (
                  <CandidateCard
                    key={candidate.personReference}
                    candidate={candidate}
                    selected={kind === 'LINK_EXISTING' && candidateReference === candidate.personReference}
                    onSelect={() => {
                      setKind('LINK_EXISTING');
                      setCandidateReference(candidate.personReference);
                      setConfirmed(false);
                      setResolutionError(null);
                    }}
                  />
                ))}
              </div>
            ) : <div className="empty-inline">No canonical candidates are attached to this case.</div>}
          </section>

          <section className="detail-section resolution-section">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submitResolution();
              }}
            >
              <fieldset>
                <legend>Resolution decision</legend>
                <label className={`decision-option ${kind === 'CREATE_NEW' ? 'selected-decision' : ''}`}>
                  <input
                    type="radio"
                    name="resolution-kind"
                    checked={kind === 'CREATE_NEW'}
                    disabled={!detail.evidence}
                    onChange={() => {
                      setKind('CREATE_NEW');
                      setCandidateReference('');
                      setConfirmed(false);
                      setResolutionError(null);
                    }}
                  />
                  <span><strong>Create a new canonical identity</strong><small>Use only when none of the masked candidates represent this person.</small></span>
                </label>
                {!detail.evidence ? <p className="form-hint">New identity creation is disabled until complete source evidence arrives.</p> : null}
              </fieldset>

              <div className="field">
                <label htmlFor="resolution-note">Reviewer note <span aria-hidden="true">*</span></label>
                <textarea
                  id="resolution-note"
                  rows={4}
                  minLength={10}
                  maxLength={1000}
                  value={note}
                  placeholder="Explain the evidence supporting this decision (10–1000 characters)."
                  onChange={(event) => {
                    setNote(event.target.value);
                    setConfirmed(false);
                    setResolutionError(null);
                  }}
                />
                <small>{note.trim().length}/1000 characters</small>
              </div>

              <label className="resolution-confirmation">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>I compared the submitted evidence with the masked candidates and confirm this irreversible decision.</span>
              </label>

              {resolutionError ? <div className="alert alert-error" role="alert">{resolutionError}</div> : null}
              <div className="resolution-actions">
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={
                    resolutionBusy || !confirmed || note.trim().length < 10 || !kind ||
                    (kind === 'LINK_EXISTING' && !candidateReference)
                  }
                >
                  {resolutionBusy ? 'Resolving identity…' : kind === 'CREATE_NEW' ? 'Create and assign Medical ID' : 'Link selected identity'}
                </button>
              </div>
            </form>
          </section>
        </>
      ) : null}
    </aside>
  );
}

export function IdentityReview({ api, onUnauthorized }: Props) {
  const [filters, setFilters] = useState<FilterForm>(initialFilters);
  const [submittedFilters, setSubmittedFilters] = useState<FilterForm | null>(null);
  const [result, setResult] = useState<IdentityReviewQueuePage | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [selectedReference, setSelectedReference] = useState<string | null>(null);
  const [detail, setDetail] = useState<IdentityReviewCaseDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [success, setSuccess] = useState<IdentityReviewResolutionResult | null>(null);
  const requestSequence = useRef(0);

  async function loadQueue(page: number, criteria = filters): Promise<void> {
    const openedFrom = toInstant(criteria.openedFrom);
    const openedTo = toInstant(criteria.openedTo);
    if (openedFrom && openedTo && openedFrom > openedTo) {
      setQueueError('Opened from must be earlier than opened to.');
      return;
    }
    const sequence = ++requestSequence.current;
    setQueueBusy(true);
    setQueueError(null);
    setSelectedReference(null);
    setDetail(null);
    setDetailError(null);
    setSuccess(null);
    try {
      const pageResult = await api.searchIdentityReviews({
        reasonCode: 'IDENTITY_RECONCILIATION',
        evidenceState: criteria.evidenceState,
        ...(criteria.installationId.trim() ? { installationId: criteria.installationId.trim() } : {}),
        ...(openedFrom ? { openedFrom } : {}),
        ...(openedTo ? { openedTo } : {}),
        page,
        pageSize: 25,
      });
      if (sequence === requestSequence.current) {
        setSubmittedFilters(criteria);
        setResult(pageResult);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      if (sequence === requestSequence.current) setQueueError(reviewError(error));
    } finally {
      if (sequence === requestSequence.current) setQueueBusy(false);
    }
  }

  async function openCase(caseReference: string): Promise<void> {
    const sequence = ++requestSequence.current;
    setSelectedReference(caseReference);
    setDetailBusy(true);
    setDetailError(null);
    setDetail(null);
    setSuccess(null);
    try {
      const caseDetail = await api.getIdentityReviewDetail({
        reasonCode: 'IDENTITY_RECONCILIATION',
        caseReference,
      });
      if (sequence === requestSequence.current) setDetail(caseDetail);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      if (sequence === requestSequence.current) setDetailError(reviewError(error, true));
    } finally {
      if (sequence === requestSequence.current) setDetailBusy(false);
    }
  }

  function closeCase(): void {
    requestSequence.current += 1;
    setSelectedReference(null);
    setDetail(null);
    setDetailBusy(false);
    setDetailError(null);
    setSuccess(null);
  }

  return (
    <div className="identity-review">
      <section className="card identity-filter-card">
        <form
          className="sync-filter-form"
          onSubmit={(event) => {
            event.preventDefault();
            void loadQueue(1);
          }}
        >
          <div className="field">
            <label htmlFor="identity-evidence-state">Evidence state</label>
            <select
              id="identity-evidence-state"
              value={filters.evidenceState}
              onChange={(event) => setFilters({ ...filters, evidenceState: event.target.value as FilterForm['evidenceState'] })}
            >
              <option value="ALL">All states</option>
              <option value="AVAILABLE">Available</option>
              <option value="EVIDENCE_PENDING">Evidence pending</option>
            </select>
          </div>
          <div className="field field-grow">
            <label htmlFor="identity-installation">Installation ID</label>
            <input
              id="identity-installation"
              type="text"
              autoComplete="off"
              maxLength={36}
              pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
              placeholder="Optional UUID"
              value={filters.installationId}
              onChange={(event) => setFilters({ ...filters, installationId: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="identity-opened-from">Opened from</label>
            <input id="identity-opened-from" type="datetime-local" value={filters.openedFrom} onChange={(event) => setFilters({ ...filters, openedFrom: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="identity-opened-to">Opened to</label>
            <input id="identity-opened-to" type="datetime-local" value={filters.openedTo} onChange={(event) => setFilters({ ...filters, openedTo: event.target.value })} />
          </div>
          <div className="search-actions">
            <button className="button button-primary" type="submit" disabled={queueBusy}>
              {queueBusy ? 'Loading cases…' : 'Load review cases'}
            </button>
            <button
              className="button button-quiet"
              type="button"
              disabled={queueBusy}
              onClick={() => {
                requestSequence.current += 1;
                setFilters(initialFilters);
                setSubmittedFilters(null);
                setResult(null);
                setQueueError(null);
                closeCase();
              }}
            >
              Clear
            </button>
          </div>
        </form>
      </section>

      <div className="privacy-strip identity-privacy-strip">
        <span aria-hidden="true">!</span>
        Queue results are masked. Exact submitted evidence is disclosed only after opening an authorized review case.
      </div>

      {queueError ? <div className="alert alert-error" role="alert">{queueError}</div> : null}
      <div className="results-heading">
        <div>
          <h2>Open review cases</h2>
          <p aria-live="polite">
            {result ? `${result.totalItems} open case${result.totalItems === 1 ? '' : 's'} found` : 'Load the scoped queue when you are ready to review.'}
          </p>
        </div>
        {queueBusy ? <span className="loading-label" role="status">Loading…</span> : null}
      </div>

      {result ? (
        <section className="card results-card">
          <QueueTable result={result} selectedReference={selectedReference} onSelect={(item) => void openCase(item.caseReference)} />
          {result.totalPages > 1 ? (
            <nav className="pagination" aria-label="Identity review queue pages">
              <button className="button button-quiet" disabled={queueBusy || result.page <= 1} onClick={() => submittedFilters && void loadQueue(result.page - 1, submittedFilters)}>Previous</button>
              <span>Page {result.page} of {result.totalPages}</span>
              <button className="button button-quiet" disabled={queueBusy || result.page >= result.totalPages} onClick={() => submittedFilters && void loadQueue(result.page + 1, submittedFilters)}>Next</button>
            </nav>
          ) : null}
        </section>
      ) : (
        <section className="card empty-state initial-empty">
          <span className="empty-icon" aria-hidden="true">≡</span>
          <h2>No identity review query has been run</h2>
          <p>Choose optional filters and load the queue. The operation is permission-controlled and audited.</p>
        </section>
      )}

      <ReviewPanel
        key={`${selectedReference ?? 'closed'}-${detail?.updatedAt ?? success?.resolvedAt ?? 'loading'}`}
        api={api}
        detail={detail}
        busy={detailBusy}
        error={detailError}
        success={success}
        onUnauthorized={onUnauthorized}
        onClose={closeCase}
        onRefresh={() => selectedReference && void openCase(selectedReference)}
        onResolved={(resolution) => {
          setSuccess(resolution);
          setResult((current) => current
            ? { ...current, totalItems: Math.max(0, current.totalItems - 1), items: current.items.filter((item) => item.caseReference !== resolution.caseReference) }
            : current);
        }}
      />
    </div>
  );
}
