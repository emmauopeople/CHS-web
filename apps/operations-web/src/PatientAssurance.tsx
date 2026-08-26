import { formatInstant, humanize } from './format';
import type { PatientDetail } from './types';

type PatientAssuranceProps = Readonly<{
  identityAssurance: PatientDetail['identityAssurance'];
  sourceProvenance: PatientDetail['sourceProvenance'];
}>;

export function PatientAssurance({
  identityAssurance,
  sourceProvenance,
}: PatientAssuranceProps) {
  const reviewCount = identityAssurance.openReviewCaseCount;

  return (
    <section className="patient-assurance" aria-labelledby="patient-assurance-heading">
      <header className="patient-assurance-heading">
        <div>
          <p className="eyebrow">Identity and source context</p>
          <h3 id="patient-assurance-heading">Record assurance</h3>
        </div>
        <span
          className={`acknowledgment acknowledgment-${identityAssurance.acknowledgmentStatus.toLowerCase()}`}
        >
          Acknowledgment: {humanize(identityAssurance.acknowledgmentStatus)}
        </span>
      </header>

      {identityAssurance.reviewState === 'REVIEW_REQUIRED' ? (
        <div className="identity-assurance-warning" role="status">
          <span className="assurance-symbol" aria-hidden="true">!</span>
          <div>
            <strong>Identity review required</strong>
            <p>
              {reviewCount} open identity review {reviewCount === 1 ? 'case' : 'cases'} in
              your current access scope {reviewCount === 1 ? 'lists' : 'list'} this person
              as a possible match. Unresolved submissions are not shown as clinical truth.
            </p>
          </div>
        </div>
      ) : (
        <p className="identity-assurance-clear">
          <span aria-hidden="true">✓</span>
          No open identity-review warnings in your current access scope.
        </p>
      )}

      <details className="source-provenance">
        <summary>
          <span className="source-provenance-summary">
            <span>Source provenance</span>
            <small>
              {sourceProvenance.sourceCount} {sourceProvenance.sourceCount === 1 ? 'source' : 'sources'}
              {' · '}Last patient update received {formatInstant(sourceProvenance.lastSynchronizedAt)}
            </small>
          </span>
        </summary>
        <div className="source-provenance-content">
          {sourceProvenance.sources.length > 0 ? (
            <div className="source-provenance-list">
              {sourceProvenance.sources.map((source, index) => (
                <article
                  className="source-provenance-item"
                  key={`${source.deploymentName}-${source.organizationName}-${source.locationName}-${index}`}
                >
                  <header>
                    <strong>{source.deploymentName}</strong>
                    <span>Revision {source.lastSourceRevision}</span>
                  </header>
                  <p>{source.organizationName} · {source.locationName}</p>
                  <dl>
                    <div>
                      <dt>Source updated</dt>
                      <dd>{formatInstant(source.sourceUpdatedAt)}</dd>
                    </div>
                    <div>
                      <dt>First received</dt>
                      <dd>{formatInstant(source.firstObservedAt)}</dd>
                    </div>
                    <div>
                      <dt>Last received</dt>
                      <dd>{formatInstant(source.lastObservedAt)}</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          ) : (
            <p className="source-provenance-empty">
              No source context is available in your current access scope.
            </p>
          )}
          <p className="source-provenance-note">
            Source updated is supplied by the desktop record. Received times are central
            observations and do not represent every record on that installation.
          </p>
        </div>
      </details>
    </section>
  );
}
