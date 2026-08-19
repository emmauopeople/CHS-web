import { useEffect, useState } from 'react';

import { ApiError, type OperationsApi } from './api';
import { humanize } from './format';
import type {
  MedicalIdRecoverySearchResult,
  PatientAccessReason,
} from './types';

type Props = Readonly<{
  api: OperationsApi;
  reason: PatientAccessReason | '';
  onUnauthorized: () => void;
}>;

function recoveryError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Medical ID recovery could not be completed.';
  if (error.status === 401) return 'Your session has expired. Sign in again.';
  if (error.status === 403) return 'Your account does not have Medical ID recovery permission.';
  if (error.status === 404) return 'This recovery confirmation is unavailable or has expired.';
  if (error.status === 503) return 'Medical ID recovery is temporarily unavailable.';
  const reference = error.requestId ? ` Reference: ${error.requestId}.` : '';
  return `Medical ID recovery could not be completed.${reference}`;
}

export function MedicalIdRecovery({ api, reason, onUnauthorized }: Props) {
  const [fullName, setFullName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [result, setResult] = useState<MedicalIdRecoverySearchResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setResult(null);
    setConfirmed(false);
    setRevealedId(null);
    setError(null);
  }, [reason]);

  async function search(): Promise<void> {
    if (!reason) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setConfirmed(false);
    setRevealedId(null);
    try {
      setResult(await api.searchMedicalIdRecovery({
        reasonCode: reason,
        fullName: fullName.trim(),
        dateOfBirth,
      }));
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 401) onUnauthorized();
      setError(recoveryError(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function reveal(): Promise<void> {
    if (!reason || result?.status !== 'CANDIDATE_FOUND' || !confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.revealMedicalId({
        reasonCode: reason,
        recoveryToken: result.recoveryToken,
        candidateReference: result.candidates[0].candidateReference,
        confirmed: true,
      });
      setRevealedId(response.chsMedicalId);
      setConfirmed(false);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 401) onUnauthorized();
      setError(recoveryError(requestError));
    } finally {
      setBusy(false);
    }
  }

  const candidateResult = result?.status === 'CANDIDATE_FOUND' ? result : null;

  return (
    <section className="recovery-workflow" aria-labelledby="recovery-heading">
      <div className="card recovery-intro">
        <div>
          <p className="eyebrow">Existing identifier only</p>
          <h2 id="recovery-heading">Recover a patient’s CHS Medical ID</h2>
          <p>
            Enter the patient’s full name and exact date of birth. Candidate details stay masked
            until one authorized, audited confirmation reveals the existing ID.
          </p>
        </div>
        <span className="recovery-lock" aria-hidden="true">ID</span>
      </div>

      <form
        className="card recovery-form"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <div className="field field-grow">
          <label htmlFor="recovery-full-name">Full name</label>
          <input
            id="recovery-full-name"
            autoComplete="off"
            minLength={2}
            maxLength={160}
            required
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="recovery-date-of-birth">Date of birth</label>
          <input
            id="recovery-date-of-birth"
            type="date"
            required
            value={dateOfBirth}
            onChange={(event) => setDateOfBirth(event.target.value)}
          />
        </div>
        <button className="button button-primary" disabled={!reason || busy} type="submit">
          {busy ? 'Checking…' : 'Find Medical ID'}
        </button>
        {!reason ? <p className="form-hint">Select a reason for access first.</p> : null}
      </form>

      {error ? <div className="alert alert-error" role="alert">{error}</div> : null}

      {result?.status === 'NOT_RESOLVED' ? (
        <div className="card recovery-message" role="status">
          <h3>Medical ID not resolved</h3>
          <p>No eligible patient could be safely confirmed with the supplied information.</p>
        </div>
      ) : null}

      {result?.status === 'REVIEW_REQUIRED' ? (
        <div className="card recovery-message recovery-review" role="status">
          <p className="eyebrow">Manual identity review required</p>
          <h3>More than one possible patient was found</h3>
          <p>No Medical ID can be revealed or merged from this screen. Refer case <strong>{result.caseReference}</strong> to the authorized identity-review process.</p>
          <div className="masked-candidates">
            {result.candidates.map((item) => (
              <div key={item.candidateReference}>
                <strong>{item.maskedName}</strong>
                <span>{item.maskedDateOfBirth} · {humanize(item.sex)} · {item.maskedResidence || 'Residence unavailable'}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {candidateResult && !revealedId ? (
        <div className="card recovery-confirmation">
          <p className="eyebrow">Masked candidate</p>
          <h3>{candidateResult.candidates[0].maskedName}</h3>
          <dl className="recovery-candidate-grid">
            <div><dt>Date of birth</dt><dd>{candidateResult.candidates[0].maskedDateOfBirth}</dd></div>
            <div><dt>Sex</dt><dd>{humanize(candidateResult.candidates[0].sex)}</dd></div>
            <div><dt>Residence</dt><dd>{candidateResult.candidates[0].maskedResidence || 'Unavailable'}</dd></div>
          </dl>
          <label className="confirmation-check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I confirm this masked record matches the patient requesting their existing Medical ID.
          </label>
          <button className="button button-primary" disabled={!confirmed || busy} onClick={() => void reveal()}>
            {busy ? 'Revealing…' : 'Reveal existing Medical ID once'}
          </button>
          <small className="recovery-expiry">Confirmation expires at {new Date(candidateResult.expiresAt).toLocaleTimeString()}.</small>
        </div>
      ) : null}

      {revealedId ? (
        <div className="card recovery-revealed" role="status">
          <p className="eyebrow">Existing CHS Medical ID</p>
          <strong>{revealedId}</strong>
          <p>This one-time reveal was audited. Record the ID securely; this page does not create a replacement identifier.</p>
        </div>
      ) : null}
    </section>
  );
}
