import { useEffect, useState } from 'react';
import { ApiError, type OperationsApi } from './api';
import type {
  ProviderPage,
  ProviderRequest,
  ProviderSecret,
  FhirStatus,
} from './provider-contract';
const future = (days: number) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
export function ProviderAccess({
  api,
  onUnauthorized,
}: {
  api: OperationsApi;
  onUnauthorized: () => void;
}) {
  const [page, setPage] = useState<ProviderPage | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [secret, setSecret] = useState<ProviderSecret | null>(null);
  const [name, setName] = useState(''),
    [registration, setRegistration] = useState(''),
    [email, setEmail] = useState(''),
    [purpose, setPurpose] = useState('');
  const [selected, setSelected] = useState<ProviderRequest | null>(null),
    [organizations, setOrganizations] = useState<string[]>([]),
    [reviewReason, setReviewReason] = useState(''),
    [expiry, setExpiry] = useState(future(90));
  const [clientId, setClientId] = useState(''),
    [medicalId, setMedicalId] = useState(''),
    [personId, setPersonId] = useState(''),
    [basis, setBasis] = useState(''),
    [sharingExpiry, setSharingExpiry] = useState(future(7));
  const [confirmation, setConfirmation] = useState<{
      clientId: string;
      action: 'ROTATE' | 'REVOKE';
    } | null>(null),
    [publication, setPublication] = useState<FhirStatus | null>(null);
  useEffect(() => {
    if (!secret) return;
    const timeout = setTimeout(() => setSecret(null), 300000);
    const clear = () => {
      if (document.hidden) setSecret(null);
    };
    document.addEventListener('visibilitychange', clear);
    return () => {
      clearTimeout(timeout);
      document.removeEventListener('visibilitychange', clear);
    };
  }, [secret]);
  const load = async (n = 1) => setPage(await api.searchProviders(n));
  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    setSecret(null);
    try {
      await operation();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        onUnauthorized();
        return;
      }
      setError(
        e instanceof ApiError && e.status === 403
          ? 'Only a super admin can administer provider access.'
          : e instanceof ApiError
            ? `${e.code.replaceAll('_', ' ').toLowerCase()}.`
            : 'The provider action could not be completed.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="administration-workspace"
      aria-label="Hospital and provider access"
    >
      <p>
        Hospital access is approved separately from desktop synchronization.
        Organization scope and an explicit, expiring patient-sharing grant are
        both required.
      </p>
      {error ? (
        <div role="alert" className="alert alert-error">
          {error}
        </div>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {secret?.clientSecret ? (
        <section className="panel" aria-label="Provider credential">
          <h2>Save the provider credential</h2>
          <p>
            Share this credential directly with the approved hospital’s
            integration administrator. It clears on dismissal, navigation, page
            hiding or after five minutes.
          </p>
          <label>
            OAuth client ID
            <input readOnly value={secret.oauthClientId} />
          </label>
          <label>
            Client secret
            <input
              readOnly
              autoComplete="off"
              value={secret.clientSecret}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <label>
            Token endpoint
            <input readOnly value={secret.tokenEndpoint} />
          </label>
          <button
            className="button button-quiet"
            onClick={() => setSecret(null)}
          >
            Dismiss credential
          </button>
        </section>
      ) : null}
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.requestProvider({
              reasonCode: 'PROVIDER_ADMINISTRATION',
              organizationName: name,
              registrationIdentifier: registration,
              contactEmail: email,
              purpose,
            });
            setNotice('Provider request submitted for super admin review.');
            setName('');
            setRegistration('');
            setEmail('');
            setPurpose('');
          });
        }}
      >
        <h2>Request hospital access</h2>
        <div className="search-form">
          <div className="field">
            <label htmlFor="provider-name">Hospital or provider name</label>
            <input
              required
              id="provider-name"
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="provider-registration">
              Registration identifier
            </label>
            <input
              required
              id="provider-registration"
              maxLength={120}
              value={registration}
              onChange={(e) => setRegistration(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="provider-email">Integration contact email</label>
            <input
              required
              id="provider-email"
              type="email"
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="provider-purpose">Purpose of access</label>
            <textarea
              required
              id="provider-purpose"
              minLength={10}
              maxLength={1000}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
            />
          </div>
        </div>
        <button className="button button-primary" disabled={busy}>
          Submit request
        </button>
      </form>
      <button
        className="button button-primary"
        disabled={busy}
        onClick={() => void run(() => load())}
      >
        Load provider requests
      </button>
      {page ? (
        <section className="panel">
          <h2>Provider requests</h2>
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Purpose</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.organizationName}
                    <br />
                    {r.registrationIdentifier}
                    <br />
                    {r.contactEmail}
                  </td>
                  <td>{r.purpose}</td>
                  <td>
                    {r.status}
                    <br />
                    {r.expiresAt
                      ? new Date(r.expiresAt).toLocaleDateString()
                      : ''}
                  </td>
                  <td>
                    {r.status === 'PENDING' ? (
                      <button
                        className="button button-quiet"
                        disabled={busy}
                        onClick={() => {
                          setSelected(r);
                          setReviewReason('');
                          setOrganizations([]);
                        }}
                      >
                        Review request
                      </button>
                    ) : null}
                    {r.clientId && r.clientStatus === 'ACTIVE' ? (
                      <>
                        <button
                          className="button button-quiet"
                          disabled={busy}
                          onClick={() =>
                            setConfirmation({
                              clientId: r.clientId!,
                              action: 'ROTATE',
                            })
                          }
                        >
                          Rotate credential
                        </button>
                        <button
                          className="button button-quiet"
                          disabled={busy}
                          onClick={() =>
                            setConfirmation({
                              clientId: r.clientId!,
                              action: 'REVOKE',
                            })
                          }
                        >
                          Revoke access
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            className="button button-quiet"
            disabled={busy || page.page === 1}
            onClick={() => void run(() => load(page.page - 1))}
          >
            Previous
          </button>{' '}
          Page {page.page}{' '}
          <button
            className="button button-quiet"
            disabled={busy || !page.hasMore}
            onClick={() => void run(() => load(page.page + 1))}
          >
            Next
          </button>
        </section>
      ) : null}
      {selected && page ? (
        <form
          className="panel"
          aria-label="Review provider request"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const result = await api.reviewProvider({
                reasonCode: 'PROVIDER_ADMINISTRATION',
                id: selected.id,
                decision: 'APPROVE',
                reviewReason,
                organizationIds: organizations,
                scopes: ['history:read', 'fhir:read'],
                expiresAt: new Date(`${expiry}T23:59:59Z`).toISOString(),
                confirmed: true,
              });
              setSelected(null);
              await load(page.page);
              setSecret(result);
            });
          }}
        >
          <h2>Review {selected.organizationName}</h2>
          <p>
            Approval allows requests for explicitly shared patients only. It
            does not grant access to every patient in an organization.
          </p>
          <fieldset>
            <legend>Permitted source organizations</legend>
            {page.organizations.map((o) => (
              <label key={o.id}>
                <input
                  type="checkbox"
                  checked={organizations.includes(o.id)}
                  onChange={(e) =>
                    setOrganizations(
                      e.target.checked
                        ? [...organizations, o.id]
                        : organizations.filter((v) => v !== o.id),
                    )
                  }
                />
                {o.name}
              </label>
            ))}
          </fieldset>
          <label>
            Approval expires
            <input
              type="date"
              required
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </label>
          <label>
            Review reason
            <textarea
              required
              minLength={10}
              maxLength={500}
              value={reviewReason}
              onChange={(e) => setReviewReason(e.target.value)}
            />
          </label>
          <button
            className="button button-primary"
            disabled={busy || organizations.length === 0}
          >
            Approve and issue credential
          </button>
          <button
            type="button"
            className="button button-quiet"
            disabled={busy || reviewReason.trim().length < 10}
            onClick={() =>
              void run(async () => {
                await api.reviewProvider({
                  reasonCode: 'PROVIDER_ADMINISTRATION',
                  id: selected.id,
                  decision: 'REJECT',
                  reviewReason,
                  confirmed: true,
                });
                setSelected(null);
                await load(page.page);
              })
            }
          >
            Reject request
          </button>
          <button
            type="button"
            className="button button-quiet"
            onClick={() => setSelected(null)}
          >
            Cancel review
          </button>
        </form>
      ) : null}
      {confirmation ? (
        <section
          className="panel"
          role="alertdialog"
          aria-label="Confirm provider credential action"
        >
          <p>
            {confirmation.action === 'REVOKE'
              ? 'Revoke this provider’s access immediately?'
              : 'Rotate this provider credential? Previously issued tokens will no longer be accepted.'}
          </p>
          <button
            className="button button-primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await api.providerCredentials({
                  reasonCode: 'PROVIDER_ADMINISTRATION',
                  ...confirmation,
                  confirmed: true,
                });
                setConfirmation(null);
                await load(page?.page);
                setSecret(result);
              })
            }
          >
            Confirm credential action
          </button>
          <button
            className="button button-quiet"
            disabled={busy}
            onClick={() => setConfirmation(null)}
          >
            Cancel
          </button>
        </section>
      ) : null}
      {page ? (
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.providerPatientAccess({
                reasonCode: 'PROVIDER_ADMINISTRATION',
                clientId,
                personId,
                action: 'GRANT',
                basis,
                expiresAt: new Date(`${sharingExpiry}T23:59:59Z`).toISOString(),
                confirmed: true,
              });
              setNotice('Patient-sharing grant saved.');
              setPersonId('');
              setBasis('');
            });
          }}
        >
          <h2>Authorize patient sharing</h2>
          <p>
            Use the canonical patient UUID and document the verified
            authorization basis. A Medical ID alone is not authorization.
          </p>
          <label htmlFor="sharing-provider">Approved provider</label>
          <select
            id="sharing-provider"
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          >
            <option value="">Choose provider</option>
            {page.items
              .filter((r) => r.clientId && r.clientStatus === 'ACTIVE')
              .map((r) => (
                <option key={r.id} value={r.clientId!}>
                  {r.organizationName}
                </option>
              ))}
          </select>
          <label>
            Medical ID for patient lookup
            <input
              maxLength={32}
              value={medicalId}
              onChange={(e) => setMedicalId(e.target.value)}
            />
          </label>
          <button
            className="button button-quiet"
            type="button"
            disabled={busy || !medicalId.trim()}
            onClick={() =>
              void run(async () => {
                const match = medicalId.trim().toUpperCase();
                const result = await api.searchPatients({
                  reasonCode: 'CARE_COORDINATION',
                  search: match,
                  status: 'ALL',
                  pageSize: 50,
                });
                const exact = result.items.filter(
                  (p) => p.chsMedicalId === match,
                );
                if (exact.length !== 1) {
                  setPersonId('');
                  setNotice(
                    'No unique patient with that Medical ID was found in your authorized scope.',
                  );
                  return;
                }
                setPersonId(exact[0]!.personId);
                setNotice(
                  `Selected ${exact[0]!.displayName} (${match}). Document the verified authorization before granting access.`,
                );
              })
            }
          >
            Find patient reference
          </button>
          <label>
            Canonical patient UUID
            <input
              required
              pattern="[a-fA-F0-9-]{36}"
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
            />
          </label>
          <label>
            Authorization basis
            <textarea
              required
              minLength={10}
              maxLength={500}
              value={basis}
              onChange={(e) => setBasis(e.target.value)}
            />
          </label>
          <label>
            Sharing expires
            <input
              type="date"
              required
              value={sharingExpiry}
              onChange={(e) => setSharingExpiry(e.target.value)}
            />
          </label>
          <button className="button button-primary" disabled={busy}>
            Grant patient access
          </button>
          <button
            className="button button-quiet"
            type="button"
            disabled={
              busy || !clientId || !personId || basis.trim().length < 10
            }
            onClick={() =>
              void run(async () => {
                await api.providerPatientAccess({
                  reasonCode: 'PROVIDER_ADMINISTRATION',
                  clientId,
                  personId,
                  action: 'REVOKE',
                  basis,
                  confirmed: true,
                });
                setNotice('Patient-sharing access revoked.');
              })
            }
          >
            Revoke patient access
          </button>
        </form>
      ) : null}
      <section className="panel">
        <h2>FHIR publication</h2>
        <button
          className="button button-quiet"
          disabled={busy}
          onClick={() =>
            void run(async () => setPublication(await api.fhirStatus()))
          }
        >
          Refresh FHIR status
        </button>
        {publication ? (
          <>
            <p>
              {publication.configured
                ? 'Private FHIR server configured'
                : 'FHIR service is not configured'}
            </p>
            <ul>
              {publication.counts.map((c) => (
                <li key={c.status}>
                  {c.status}: {c.count}
                </li>
              ))}
            </ul>
            {publication.failures.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Patient UUID</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Code</th>
                  </tr>
                </thead>
                <tbody>
                  {publication.failures.map((f) => (
                    <tr key={f.personId}>
                      <td>{f.personId}</td>
                      <td>{f.status}</td>
                      <td>{f.attempts}</td>
                      <td>{f.errorCode}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p>No publication failures.</p>
            )}
          </>
        ) : null}
      </section>
    </section>
  );
}
