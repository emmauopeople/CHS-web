import { useEffect, useRef, useState } from 'react';
import type {
  HistoryActor,
  HistoryItem,
  HistoryPage,
  HistoryResourceType,
} from '../../../packages/contracts/src/patient-history.mjs';
import { ApiError, type createOperationsApi } from './api';
import { formatDate, formatInstant, humanize } from './format';
import type { PatientAccessReason } from './types';

type Api = ReturnType<typeof createOperationsApi>;
const extraTypes: readonly HistoryResourceType[] = [
  'ENCOUNTER_ADDENDUM',
  'ENCOUNTER_REVIEW_FLAG',
  'ENCOUNTER_REVIEW_STATUS',
  'FOOD',
  'OTC',
];
const labels: Record<string, string> = {
  ENCOUNTER_ADDENDUM: 'Addendum',
  ENCOUNTER_REVIEW_FLAG: 'Review flag',
  ENCOUNTER_REVIEW_STATUS: 'Review status change',
  FOOD: 'Food',
  OTC: 'OTC medication',
};
const value = (entry: unknown) =>
  entry == null || entry === ''
    ? 'Not recorded'
    : typeof entry === 'boolean'
      ? entry
        ? 'Yes'
        : 'No'
      : String(entry);
const name = (entry: unknown) =>
  entry == null ? 'Not recorded' : humanize(String(entry));
const asRows = (entry: unknown) => entry as readonly Record<string, unknown>[];

export function HistoryCard({ item }: Readonly<{ item: HistoryItem }>) {
  const d = item.data;
  const isFlag = item.resourceType === 'ENCOUNTER_REVIEW_FLAG';
  const isEvent = item.resourceType === 'ENCOUNTER_REVIEW_STATUS';
  return (
    <article className="history-card">
      <header>
        <div>
          <h4>{labels[item.resourceType]}</h4>
          <p>
            {formatInstant(item.occurredAt)} · {item.author.displayName}
          </p>
        </div>
        {isFlag ? (
          <span
            className={`status status-${String(d.currentStatus).toLowerCase()}`}
          >
            {name(d.currentStatus)}
          </span>
        ) : null}
      </header>
      <p className="history-origin">
        {item.source.locationName} · {item.source.organizationName} ·{' '}
        {item.source.deploymentName}
      </p>
      <p className="history-origin">
        Encounter: {formatInstant(item.encounter.startedAt)} ·{' '}
        {humanize(item.encounter.status)}
      </p>
      {item.encounter.status === 'VOID' ? (
        <p className="referral-warning">
          <strong>Voided encounter.</strong> {value(item.encounter.voidReason)}.
          This history is retained for review.
        </p>
      ) : null}
      {item.encounter.status === 'AMENDED' ||
      item.encounter.amendmentOfEncounterId ? (
        <p className="referral-note">
          <strong>Amended encounter.</strong>{' '}
          {value(item.encounter.amendmentReason)}
        </p>
      ) : null}
      {item.resourceType === 'ENCOUNTER_ADDENDUM' ? (
        <p className="history-note">{value(d.noteText)}</p>
      ) : null}
      {isFlag || isEvent ? (
        <div className="history-content">
          <strong>{name(d.category)}</strong>
          <p className="history-note">{value(d.description)}</p>
          {isFlag ? (
            <p>
              Latest action: {name(d.currentStatus)} ·{' '}
              {formatInstant(String(d.lastChangedAt))} ·{' '}
              {(d.lastChangedBy as HistoryActor).displayName}
            </p>
          ) : (
            <p>
              {d.fromStatus
                ? `From ${name(d.fromStatus)} to ${name(d.toStatus)}`
                : `Flag ${name(d.toStatus).toLowerCase()}`}{' '}
              · Event {String(d.sequenceNumber)}
            </p>
          )}
          {(isFlag ? d.lastChangeReason : d.changeReason) ? (
            <p className="history-note">
              {value(isFlag ? d.lastChangeReason : d.changeReason)}
            </p>
          ) : null}
        </div>
      ) : null}
      {item.resourceType === 'FOOD' || item.resourceType === 'OTC' ? (
        <div className="history-content">
          <p>
            Response: <strong>{name(d.response)}</strong>
            {d.periodStart
              ? ` · ${formatDate(String(d.periodStart))} – ${formatDate(String(d.periodEnd))}`
              : ''}
          </p>
          {asRows(d.rows).length === 0 ? (
            <p>No items recorded.</p>
          ) : (
            <ul className="history-intake-list">
              {asRows(d.rows).map((row) => (
                <li key={String(row.sequenceNumber)}>
                  <strong>
                    {value(
                      item.resourceType === 'FOOD'
                        ? row.foodName
                        : row.productName,
                    )}
                  </strong>
                  <dl className="history-fields">
                    {item.resourceType === 'FOOD' ? (
                      <>
                        <div>
                          <dt>Frequency</dt>
                          <dd>{name(row.frequencyCode)}</dd>
                        </div>
                        <div>
                          <dt>Preparation</dt>
                          <dd>{value(row.preparationNote)}</dd>
                        </div>
                      </>
                    ) : (
                      <>
                        <div>
                          <dt>Reason for use</dt>
                          <dd>{value(row.reasonForUse)}</dd>
                        </div>
                        <div>
                          <dt>Dose</dt>
                          <dd>{value(row.doseText)}</dd>
                        </div>
                        <div>
                          <dt>Frequency</dt>
                          <dd>{value(row.frequencyText)}</dd>
                        </div>
                        <div>
                          <dt>Duration</dt>
                          <dd>{value(row.durationText)}</dd>
                        </div>
                        <div>
                          <dt>Source of medication</dt>
                          <dd>{value(row.sourceOfMedication)}</dd>
                        </div>
                        <div>
                          <dt>Currently taking</dt>
                          <dd>{value(row.currentlyTaking)}</dd>
                        </div>
                      </>
                    )}
                  </dl>
                  <small>
                    Patient reported ·{' '}
                    {(row.author as HistoryActor).displayName} ·{' '}
                    {formatInstant(String(row.recordedAt))}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </article>
  );
}

export function PatientHistory({
  api,
  personId,
  reason,
  onUnauthorized,
}: Readonly<{
  api: Api;
  personId: string;
  reason: PatientAccessReason;
  onUnauthorized: (error: unknown) => void;
}>) {
  const today = new Date().toISOString().slice(0, 10);
  const initialFrom = new Date(Date.now() - 364 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const [fromDate, setFromDate] = useState(initialFrom);
  const [toDate, setToDate] = useState(today);
  const [kind, setKind] = useState('ALL');
  const [result, setResult] = useState<HistoryPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const historyHeading = useRef<HTMLHeadingElement>(null);
  const cursors = useRef<(string | undefined)[]>([undefined]);
  const sequence = useRef(0);
  // A component key binds this state to one patient/reason; cleanup also rejects
  // late responses after closing a patient or signing out.
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  function changeQuery(update: () => void) {
    sequence.current++;
    setBusy(false);
    setResult(null);
    setError(null);
    setPage(0);
    cursors.current = [undefined];
    update();
  }
  function backToTop() {
    historyHeading.current?.focus({ preventScroll: true });
    historyHeading.current?.scrollIntoView({
      block: 'start',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
  }
  function closeHistory() {
    // Invalidate pending pages so a late response cannot reopen closed history.
    changeQuery(() => {});
    backToTop();
  }
  async function load(index = 0) {
    const request = ++sequence.current;
    if (index === 0) {
      cursors.current = [undefined];
      setResult(null);
    }
    setBusy(true);
    setError(null);
    try {
      const cursor = cursors.current[index];
      const response = await api.getPatientHistory({
        contractVersion: '1.0',
        personId,
        reasonCode: reason,
        fromDate,
        toDate,
        resourceTypes:
          kind === 'ALL' ? extraTypes : [kind as HistoryResourceType],
        limit: 10,
        ...(cursor ? { cursor } : {}),
      });
      if (request !== sequence.current) return;
      if (
        response.personId !== personId ||
        response.fromDate !== fromDate ||
        response.toDate !== toDate ||
        response.items.length > 10 ||
        response.items.some((item) =>
          kind === 'ALL'
            ? !extraTypes.includes(item.resourceType)
            : item.resourceType !== kind,
        )
      )
        throw new ApiError(502, 'INVALID_API_RESPONSE', null);
      setResult(response);
      setPage(index);
      cursors.current[index + 1] = response.nextCursor ?? undefined;
    } catch (failure) {
      if (request !== sequence.current) return;
      onUnauthorized(failure);
      setResult(null);
      setPage(0);
      cursors.current = [undefined];
      setError(
        failure instanceof ApiError && failure.code === 'HISTORY_CURSOR_STALE'
          ? 'History changed or this page expired. Refresh history to see the latest records.'
          : failure instanceof ApiError && failure.status === 400
            ? 'Choose a valid date range of up to 366 days.'
            : 'History could not be loaded. Check your access and try again.',
      );
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  }
  return (
    <section
      className="detail-section additional-history"
      aria-label="Addenda, review, Food and OTC history"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">Accepted canonical data only</p>
          <h3 ref={historyHeading} tabIndex={-1} className="history-heading">
            Addenda, review, Food and OTC
          </h3>
        </div>
      </div>
      <form
        className="history-filters"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <label>
          From date (UTC)
          <input
            type="date"
            value={fromDate}
            required
            onChange={(event) =>
              changeQuery(() => setFromDate(event.target.value))
            }
          />
        </label>
        <label>
          To date (UTC)
          <input
            type="date"
            value={toDate}
            required
            onChange={(event) =>
              changeQuery(() => setToDate(event.target.value))
            }
          />
        </label>
        <label>
          History type
          <select
            value={kind}
            onChange={(event) => changeQuery(() => setKind(event.target.value))}
          >
            <option value="ALL">All additional history</option>
            {extraTypes.map((type) => (
              <option key={type} value={type}>
                {labels[type]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="button button-primary" disabled={busy}>
          {result || error ? 'Refresh history' : 'Load history'}
        </button>
      </form>
      {busy ? <p role="status">Loading history…</p> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}
      {result ? (
        <>
          <p className="history-refreshed">
            Retrieved {formatInstant(result.retrievedAt)} · Read-only central
            history
          </p>
          {result.items.length === 0 ? (
            <p className="history-empty">
              No matching history in this date range.
            </p>
          ) : (
            <div className="history-list">
              {result.items.map((item) => (
                <HistoryCard
                  key={`${item.resourceType}:${item.resourceId}`}
                  item={item}
                />
              ))}
            </div>
          )}
          <nav className="history-pages" aria-label="Additional history pages">
            <button
              type="button"
              className="button button-quiet"
              disabled={busy || page === 0}
              onClick={() => void load(page - 1)}
            >
              Previous
            </button>
            <span>Page {page + 1}</span>
            <button
              type="button"
              className="button button-quiet"
              disabled={busy || !result.nextCursor}
              onClick={() => void load(page + 1)}
            >
              Next
            </button>
          </nav>
          <div className="history-actions">
            <button
              type="button"
              className="button button-quiet"
              onClick={backToTop}
            >
              <span aria-hidden="true">↑</span> Back to top
            </button>
            <button
              type="button"
              className="button button-quiet"
              onClick={closeHistory}
            >
              Close history
            </button>
          </div>
        </>
      ) : !busy && !error ? (
        <p className="history-empty">
          Choose dates and load the patient’s additional history.
        </p>
      ) : null}
    </section>
  );
}
