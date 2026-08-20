import { useRef, useState } from 'react';

import { ApiError, type OperationsApi } from './api';
import { formatDuration, formatInstant, humanize } from './format';
import type {
  SyncBatchMonitoringDetail,
  SyncBatchMonitoringItem,
  SyncBatchMonitoringPage,
  SyncBatchStatus,
} from './types';

type Props = Readonly<{
  api: OperationsApi;
  onUnauthorized: () => void;
}>;

type FilterForm = Readonly<{
  status: SyncBatchStatus | 'ALL';
  installationId: string;
  receivedFrom: string;
  receivedTo: string;
}>;

const initialFilters: FilterForm = {
  status: 'ALL',
  installationId: '',
  receivedFrom: '',
  receivedTo: '',
};

function monitoringError(error: unknown, detail = false): string {
  if (!(error instanceof ApiError)) {
    return 'Synchronization monitoring could not be loaded. Try again.';
  }
  if (error.status === 401) return 'Your session has expired. Sign in again.';
  if (error.status === 403) return 'Your account does not have sync monitoring permission.';
  if (error.status === 404 && detail) {
    return 'This synchronization batch is unavailable within your authorized scope.';
  }
  if (error.status === 503) return 'Synchronization monitoring is temporarily unavailable.';
  const reference = error.requestId ? ` Reference: ${error.requestId}.` : '';
  return `Synchronization monitoring could not be loaded.${reference}`;
}

function toInstant(value: string): string | undefined {
  if (!value) return undefined;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString();
}

function BatchStatus({ batch }: Readonly<{ batch: SyncBatchMonitoringItem }>) {
  return (
    <div className="sync-status-stack">
      <span className={`status sync-health sync-health-${batch.attentionState.toLowerCase()}`}>
        {humanize(batch.attentionState)}
      </span>
      <span className="sync-batch-state">{humanize(batch.status)}</span>
    </div>
  );
}

function OutcomeSummary({ batch }: Readonly<{ batch: SyncBatchMonitoringItem }>) {
  const items = [
    ['Accepted', batch.counts.accepted],
    ['Unchanged', batch.counts.unchanged],
    ['Review', batch.counts.reviewRequired],
    ['Rejected', batch.counts.rejected],
    ['Retry', batch.counts.retry],
  ] as const;
  return (
    <div className="sync-counts" aria-label="Batch outcome counts">
      {items.map(([label, count]) => (
        <span key={label} className={count > 0 ? 'has-count' : ''}>
          <strong>{count}</strong> {label}
        </span>
      ))}
    </div>
  );
}

function SyncTable({
  result,
  selectedReference,
  onSelect,
}: Readonly<{
  result: SyncBatchMonitoringPage;
  selectedReference: string | null;
  onSelect: (batch: SyncBatchMonitoringItem) => void;
}>) {
  if (result.items.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon" aria-hidden="true">↻</span>
        <h2>No synchronization batches found</h2>
        <p>Adjust the filters or confirm your authorized organization scope.</p>
      </div>
    );
  }
  return (
    <div className="table-shell">
      <table className="sync-table">
        <caption className="visually-hidden">Scoped synchronization batch results</caption>
        <thead>
          <tr>
            <th>Health</th>
            <th>Batch</th>
            <th>Deployment</th>
            <th>Received</th>
            <th>Outcomes</th>
            <th><span className="visually-hidden">Open batch</span></th>
          </tr>
        </thead>
        <tbody>
          {result.items.map((batch) => (
            <tr
              key={batch.batchReference}
              className={selectedReference === batch.batchReference ? 'selected-row' : ''}
            >
              <td><BatchStatus batch={batch} /></td>
              <td>
                <strong className="batch-id">{batch.sourceBatchId}</strong>
                <small>Contract {batch.contractVersion}</small>
              </td>
              <td>
                <strong>{batch.deploymentName}</strong>
                <small>{batch.organizationName} · {batch.locationName}</small>
              </td>
              <td>
                <strong>{formatInstant(batch.receivedAt)}</strong>
                <small>{batch.completedAt ? `${formatDuration(batch.durationMs)} duration` : 'Not completed'}</small>
              </td>
              <td><OutcomeSummary batch={batch} /></td>
              <td>
                <button className="text-button" type="button" onClick={() => onSelect(batch)}>
                  Inspect <span aria-hidden="true">→</span>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SyncDetailPanel({
  detail,
  busy,
  error,
  onClose,
}: Readonly<{
  detail: SyncBatchMonitoringDetail | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
}>) {
  if (!detail && !busy && !error) return null;
  return (
    <aside className="patient-panel sync-detail-panel" aria-label="Synchronization batch details">
      <div className="panel-toolbar">
        <button className="text-button" type="button" onClick={onClose}>← Back to batches</button>
      </div>
      {busy ? <div className="panel-loading" role="status">Loading redacted batch details…</div> : null}
      {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
      {detail ? (
        <>
          <section className="sync-detail-heading">
            <div>
              <p className="eyebrow">Redacted operational metadata</p>
              <h2>{detail.deploymentName}</h2>
              <span className="batch-id">{detail.sourceBatchId}</span>
            </div>
            <BatchStatus batch={detail} />
          </section>
          <section className="detail-section">
            <h3>Batch context</h3>
            <dl className="detail-grid sync-context-grid">
              <div><dt>Organization</dt><dd>{detail.organizationName}</dd></div>
              <div><dt>Location</dt><dd>{detail.locationName}</dd></div>
              <div><dt>Installation</dt><dd className="technical-value">{detail.installationId}</dd></div>
              <div><dt>Received</dt><dd>{formatInstant(detail.receivedAt)}</dd></div>
              <div><dt>Completed</dt><dd>{formatInstant(detail.completedAt)}</dd></div>
              <div><dt>Duration</dt><dd>{formatDuration(detail.durationMs)}</dd></div>
              <div><dt>Desktop version</dt><dd>{detail.desktopApplicationVersion}</dd></div>
              <div><dt>Desktop schema</dt><dd>v{detail.desktopSchemaVersion}</dd></div>
              <div><dt>Sync contract</dt><dd>{detail.contractVersion}</dd></div>
            </dl>
          </section>
          <section className="detail-section sync-detail-section">
            <div className="section-heading">
              <div><p className="eyebrow">Grouped counts only</p><h3>Resource outcomes</h3></div>
              <span>{detail.outcomeCounts.length} group{detail.outcomeCounts.length === 1 ? '' : 's'}</span>
            </div>
            {detail.outcomeCounts.length > 0 ? (
              <div className="compact-table-shell">
                <table>
                  <thead><tr><th>Resource</th><th>Outcome</th><th>Count</th></tr></thead>
                  <tbody>
                    {detail.outcomeCounts.map((item) => (
                      <tr key={`${item.resourceType}-${item.status}`}>
                        <td>{humanize(item.resourceType)}</td>
                        <td>{humanize(item.status)}</td>
                        <td><strong>{item.count}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="empty-inline">No record outcomes are stored for this batch.</div>}
          </section>
          <section className="detail-section sync-detail-section">
            <div className="section-heading">
              <div><p className="eyebrow">Stable codes only</p><h3>Error summary</h3></div>
              <span>{detail.errorCodeCounts.length} code{detail.errorCodeCounts.length === 1 ? '' : 's'}</span>
            </div>
            {detail.errorCodeCounts.length > 0 ? (
              <div className="compact-table-shell">
                <table>
                  <thead><tr><th>Error code</th><th>Retryable</th><th>Count</th></tr></thead>
                  <tbody>
                    {detail.errorCodeCounts.map((item) => (
                      <tr key={`${item.code}-${item.retryable}`}>
                        <td><span className="error-code">{item.code}</span></td>
                        <td>{item.retryable ? 'Yes' : 'No'}</td>
                        <td><strong>{item.count}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="empty-inline">No stable error codes are stored for this batch.</div>}
          </section>
          <div className="sync-redaction-note">
            Patient identifiers, clinical values, raw payloads, hashes, error paths, and error messages are excluded.
          </div>
        </>
      ) : null}
    </aside>
  );
}

export function SyncMonitoring({ api, onUnauthorized }: Props) {
  const [filters, setFilters] = useState<FilterForm>(initialFilters);
  const [submittedFilters, setSubmittedFilters] = useState<FilterForm | null>(null);
  const [result, setResult] = useState<SyncBatchMonitoringPage | null>(null);
  const [selectedReference, setSelectedReference] = useState<string | null>(null);
  const [detail, setDetail] = useState<SyncBatchMonitoringDetail | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  async function search(page: number, criteria = filters): Promise<void> {
    const receivedFrom = toInstant(criteria.receivedFrom);
    const receivedTo = toInstant(criteria.receivedTo);
    if (receivedFrom && receivedTo && receivedFrom > receivedTo) {
      setListError('Received from must be earlier than received to.');
      return;
    }
    const sequence = ++requestSequence.current;
    setListBusy(true);
    setListError(null);
    setSelectedReference(null);
    setDetail(null);
    setDetailError(null);
    try {
      const pageResult = await api.searchSyncBatches({
        reasonCode: 'OPERATIONS_SUPPORT',
        status: criteria.status,
        ...(criteria.installationId.trim()
          ? { installationId: criteria.installationId.trim() }
          : {}),
        ...(receivedFrom ? { receivedFrom } : {}),
        ...(receivedTo ? { receivedTo } : {}),
        page,
        pageSize: 25,
      });
      if (sequence === requestSequence.current) {
        setSubmittedFilters(criteria);
        setResult(pageResult);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      if (sequence === requestSequence.current) setListError(monitoringError(error));
    } finally {
      if (sequence === requestSequence.current) setListBusy(false);
    }
  }

  async function openDetail(batch: SyncBatchMonitoringItem): Promise<void> {
    const sequence = ++requestSequence.current;
    setSelectedReference(batch.batchReference);
    setDetail(null);
    setDetailBusy(true);
    setDetailError(null);
    try {
      const batchDetail = await api.getSyncBatchDetail({
        reasonCode: 'OPERATIONS_SUPPORT',
        batchReference: batch.batchReference,
      });
      if (sequence === requestSequence.current) setDetail(batchDetail);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      if (sequence === requestSequence.current) setDetailError(monitoringError(error, true));
    } finally {
      if (sequence === requestSequence.current) setDetailBusy(false);
    }
  }

  function clear(): void {
    requestSequence.current += 1;
    setFilters(initialFilters);
    setSubmittedFilters(null);
    setResult(null);
    setSelectedReference(null);
    setDetail(null);
    setListError(null);
    setDetailError(null);
    setListBusy(false);
    setDetailBusy(false);
  }

  const attentionOnPage = result?.items.filter((item) => item.attentionState === 'ATTENTION').length ?? 0;
  const stalledOnPage = result?.items.filter((item) => item.attentionState === 'STALLED').length ?? 0;

  return (
    <section className="sync-monitoring" aria-labelledby="sync-monitoring-heading">
      <form
        className="card sync-filter-card"
        onSubmit={(event) => {
          event.preventDefault();
          void search(1);
        }}
      >
        <div className="field">
          <label htmlFor="sync-status">Batch status</label>
          <select
            id="sync-status"
            value={filters.status}
            onChange={(event) => setFilters({ ...filters, status: event.target.value as FilterForm['status'] })}
          >
            <option value="ALL">All statuses</option>
            <option value="PROCESSING">Processing</option>
            <option value="ACCEPTED">Accepted</option>
            <option value="PARTIAL">Partial</option>
            <option value="REJECTED">Rejected</option>
            <option value="FAILED">Failed</option>
          </select>
        </div>
        <div className="field field-installation">
          <label htmlFor="sync-installation">Installation ID</label>
          <input
            id="sync-installation"
            autoComplete="off"
            maxLength={36}
            pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
            placeholder="Optional UUID"
            value={filters.installationId}
            onChange={(event) => setFilters({ ...filters, installationId: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="sync-received-from">Received from</label>
          <input
            id="sync-received-from"
            type="datetime-local"
            value={filters.receivedFrom}
            onChange={(event) => setFilters({ ...filters, receivedFrom: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="sync-received-to">Received to</label>
          <input
            id="sync-received-to"
            type="datetime-local"
            value={filters.receivedTo}
            onChange={(event) => setFilters({ ...filters, receivedTo: event.target.value })}
          />
        </div>
        <div className="search-actions">
          <button className="button button-primary" disabled={listBusy} type="submit">
            {listBusy ? 'Loading…' : 'Load batches'}
          </button>
          <button className="button button-quiet" disabled={listBusy} type="button" onClick={clear}>
            Clear
          </button>
        </div>
      </form>

      <div className="privacy-strip sync-privacy-strip">
        <span aria-hidden="true">✓</span>
        Operational metadata only. Filters remain in POST bodies and monitoring access is audited.
      </div>

      {listError ? <div className="alert alert-error" role="alert">{listError}</div> : null}

      {result ? (
        <div className="sync-summary" aria-label="Current monitoring page summary">
          <article className="card">
            <span>Matching batches</span><strong>{result.totalItems}</strong><small>all pages</small>
          </article>
          <article className="card">
            <span>Needs attention</span><strong>{attentionOnPage}</strong><small>current page</small>
          </article>
          <article className="card sync-summary-stalled">
            <span>Stalled</span><strong>{stalledOnPage}</strong><small>current page</small>
          </article>
        </div>
      ) : null}

      <div className="results-heading sync-results-heading">
        <div>
          <h2 id="sync-monitoring-heading">Synchronization batches</h2>
          <p aria-live="polite">
            {result
              ? `${result.totalItems} matching batch${result.totalItems === 1 ? '' : 'es'}`
              : 'Load scoped synchronization activity.'}
          </p>
        </div>
        <div className="sync-results-actions">
          {listBusy ? <span className="loading-label" role="status">Refreshing…</span> : null}
          {result && submittedFilters ? (
            <button
              className="button button-quiet"
              disabled={listBusy}
              type="button"
              onClick={() => void search(result.page, submittedFilters)}
            >
              Refresh
            </button>
          ) : null}
        </div>
      </div>

      {result ? (
        <section className="card results-card">
          <SyncTable result={result} selectedReference={selectedReference} onSelect={(batch) => void openDetail(batch)} />
          {result.totalPages > 1 ? (
            <nav className="pagination" aria-label="Synchronization batch pages">
              <button
                className="button button-quiet"
                disabled={listBusy || result.page <= 1}
                onClick={() => submittedFilters && void search(result.page - 1, submittedFilters)}
              >
                Previous
              </button>
              <span>Page {result.page} of {result.totalPages}</span>
              <button
                className="button button-quiet"
                disabled={listBusy || result.page >= result.totalPages}
                onClick={() => submittedFilters && void search(result.page + 1, submittedFilters)}
              >
                Next
              </button>
            </nav>
          ) : null}
        </section>
      ) : (
        <section className="card empty-state initial-empty">
          <span className="empty-icon" aria-hidden="true">↻</span>
          <h2>No monitoring query has been run</h2>
          <p>Choose optional filters and load synchronization batches.</p>
        </section>
      )}

      <SyncDetailPanel
        detail={detail}
        busy={detailBusy}
        error={detailError}
        onClose={() => {
          requestSequence.current += 1;
          setSelectedReference(null);
          setDetail(null);
          setDetailBusy(false);
          setDetailError(null);
        }}
      />
    </section>
  );
}
