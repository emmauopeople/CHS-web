import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, type OperationsApi } from './api';
import type {
  DesktopInstallation,
  InstallationPage,
} from './installation-contract';
import { formatInstant } from './format';

const reasonCode = 'INSTALLATION_ADMINISTRATION' as const;
function defaultExpiry() {
  return new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 16);
}
const initialForm = () => ({
  installationId: '',
  sourceLocationId: '',
  deploymentName: '',
  timezone: 'Africa/Douala',
  locationId: '',
  credentialLabel: 'Desktop sync',
  expiry: defaultExpiry(),
});

export function DesktopInstallations({
  api,
  onUnauthorized,
}: {
  api: OperationsApi;
  onUnauthorized: () => void;
}) {
  const [page, setPage] = useState<InstallationPage | null>(null);
  const [form, setForm] = useState(initialForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [token, setToken] = useState('');
  const [issuedFor, setIssuedFor] = useState('');
  const [action, setAction] = useState<{
    kind: 'rotate' | 'revoke';
    device: DesktopInstallation;
  } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [expiry, setExpiry] = useState(defaultExpiry);
  const generation = useRef(0);
  const busyRef = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    if (!token) return;
    const clear = () => setToken('');
    const timeout = window.setTimeout(clear, 5 * 60_000);
    window.addEventListener('pagehide', clear);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('pagehide', clear);
    };
  }, [token]);

  async function run(task: () => Promise<void>, mutation = false) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const current = generation.current;
    try {
      await task();
    } catch (e) {
      if (current !== generation.current) return;
      if (e instanceof ApiError && e.status === 401) {
        onUnauthorized();
        return;
      }
      setError(
        e instanceof ApiError && e.status === 403
          ? 'Your account does not have desktop installation management permission.'
          : mutation
            ? 'The result could not be confirmed. Reload installations before trying again. If a token was issued but not received, rotate its credential to obtain a replacement.'
            : 'Installations could not be loaded. Try again.',
      );
    } finally {
      if (current === generation.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  async function load(number = 1) {
    const current = generation.current;
    const result = await api.searchDesktopInstallations(number);
    if (current === generation.current) setPage(result);
  }
  async function enroll(event: FormEvent) {
    event.preventDefault();
    const location = page?.locations.find(
      (item) => item.id === form.locationId,
    );
    if (!location) return;
    await run(async () => {
      const current = generation.current;
      const result = await api.enrollDesktop({
        reasonCode,
        installationId: form.installationId.trim(),
        sourceLocationId: form.sourceLocationId.trim(),
        organizationId: location.organizationId,
        configuredLocationId: location.id,
        deploymentName: form.deploymentName.trim(),
        timezone: form.timezone.trim(),
        credentialLabel: form.credentialLabel.trim(),
        credentialExpiresAt: new Date(`${form.expiry}Z`).toISOString(),
      });
      if (current !== generation.current) return;
      setToken(result.installationToken);
      setIssuedFor(form.deploymentName);
      setForm(initialForm());
      setNotice(
        'Desktop enrolled. Save the token in that PC’s Sync Center. It cannot be retrieved again.',
      );
      try {
        await load();
      } catch {
        setError(
          'Enrollment succeeded, but the list could not refresh. Save the displayed token before reloading.',
        );
      }
    }, true);
  }
  async function applyAction() {
    if (!action || !confirmed || !action.device.credentialId) return;
    await run(async () => {
      const current = generation.current;
      const device = action.device;
      if (action.kind === 'rotate') {
        const result = await api.rotateDesktopCredential({
          reasonCode,
          installationId: device.id,
          expectedCredentialId: device.credentialId!,
          credentialLabel: 'Portal rotation',
          credentialExpiresAt: new Date(`${expiry}Z`).toISOString(),
          confirmation: 'ROTATE_INSTALLATION_CREDENTIAL',
        });
        if (current !== generation.current) return;
        setToken(result.installationToken);
        setIssuedFor(device.deploymentName);
        setNotice(
          'Credential replaced. The old token stopped working. Configure the new token on this desktop.',
        );
      } else {
        await api.revokeDesktopCredential({
          reasonCode,
          installationId: device.id,
          credentialId: device.credentialId!,
          confirmation: 'REVOKE_INSTALLATION_CREDENTIAL',
        });
        if (current !== generation.current) return;
        setNotice(
          'Credential revoked. This desktop can no longer synchronize.',
        );
      }
      setAction(null);
      setConfirmed(false);
      try {
        await load(page?.page);
      } catch {
        setError(
          'The credential change succeeded, but the list could not refresh.',
        );
      }
    }, true);
  }
  return (
    <div className="installation-workspace">
      <div className="privacy-strip">
        Each PC has its own installation identity and sync token. Access is
        limited to your authorized organizations.
      </div>
      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {token ? (
        <section
          className="card installation-secret"
          aria-label="One-time installation token"
        >
          <h2>Save this token for {issuedFor}</h2>
          <p>
            Shown once and cleared after five minutes or when you leave this
            workspace. Paste it into the matching desktop’s Installation
            enrollment token field.
          </p>
          <label>
            Installation enrollment token
            <textarea
              aria-label="Installation enrollment token"
              readOnly
              rows={3}
              value={token}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <div className="installation-actions">
            <button
              className="button"
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(token)
                  .then(() =>
                    setNotice(
                      'Token copied. Paste it into the desktop Sync Center.',
                    ),
                  )
                  .catch(() =>
                    setError(
                      'Copy was unavailable. Select and copy the displayed token.',
                    ),
                  );
              }}
            >
              Copy token
            </button>
            <button
              className="button button-quiet"
              type="button"
              onClick={() => {
                setToken('');
                setIssuedFor('');
              }}
            >
              I saved the token — dismiss
            </button>
          </div>
        </section>
      ) : null}
      <section className="card installation-panel">
        <div className="results-heading">
          <div>
            <h2>Registered desktops</h2>
            <p>
              Credential prefixes identify tokens; complete tokens are never
              listed.
            </p>
          </div>
          <button
            className="button"
            disabled={busy || !!token}
            onClick={() => void run(() => load(page?.page))}
          >
            Load installations
          </button>
        </div>
        {page ? (
          <>
            <div className="installation-table">
              <table>
                <thead>
                  <tr>
                    <th>Desktop</th>
                    <th>Organization / location</th>
                    <th>Credential</th>
                    <th>Last contact</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((device) => (
                    <tr key={device.id}>
                      <td>
                        <strong>{device.deploymentName}</strong>
                        <small>{device.id}</small>
                        <small>
                          {device.status} · {device.timezone}
                        </small>
                      </td>
                      <td>
                        {device.organizationName}
                        <small>{device.locationName}</small>
                      </td>
                      <td>
                        {device.credentialStatus}
                        <small>
                          {device.tokenPrefix || 'No active credential'}
                        </small>
                        <small>
                          {device.credentialExpiresAt
                            ? `Expires ${formatInstant(device.credentialExpiresAt)}`
                            : ''}
                        </small>
                      </td>
                      <td>
                        {device.lastSeenAt
                          ? formatInstant(device.lastSeenAt)
                          : 'Not yet connected'}
                      </td>
                      <td>
                        <div className="installation-actions">
                          {(['rotate', 'revoke'] as const).map((kind) => (
                            <button
                              className="button button-quiet"
                              key={kind}
                              disabled={busy || !!token || !device.credentialId}
                              onClick={() => {
                                setAction({ kind, device });
                                setConfirmed(false);
                                setExpiry(defaultExpiry());
                                setError('');
                              }}
                            >
                              {kind === 'rotate'
                                ? 'Replace token'
                                : 'Revoke token'}
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!page.items.length ? (
                    <tr>
                      <td colSpan={5}>
                        No desktops are enrolled in your authorized
                        organizations.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <div className="installation-actions">
              <button
                className="button button-quiet"
                disabled={busy || !!token || page.page === 1}
                onClick={() => void run(() => load(page.page - 1))}
              >
                Previous
              </button>
              <span>Page {page.page}</span>
              <button
                className="button button-quiet"
                disabled={busy || !!token || !page.hasMore}
                onClick={() => void run(() => load(page.page + 1))}
              >
                Next
              </button>
            </div>
          </>
        ) : (
          <p>
            Load installations to view registered PCs and available screening
            locations.
          </p>
        )}
      </section>
      {action ? (
        <section
          className="card installation-panel"
          role="region"
          aria-label="Confirm credential change"
        >
          <h2>
            {action.kind === 'rotate' ? 'Replace' : 'Revoke'} token for{' '}
            {action.device.deploymentName}
          </h2>
          <p>Installation: {action.device.id}</p>
          <p>
            {action.kind === 'rotate'
              ? 'Any existing token will stop working immediately. You must configure the new token on this PC.'
              : 'This stops synchronization immediately. To restore access later, use Replace token to issue a new credential.'}
          </p>
          {action.kind === 'rotate' ? (
            <label>
              New token expiry (UTC)
              <input
                type="datetime-local"
                required
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              />
            </label>
          ) : null}
          <label className="installation-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I confirm this change for this desktop.
          </label>
          <div className="installation-actions">
            <button
              className="button"
              disabled={
                busy ||
                !confirmed ||
                (action.kind === 'rotate' &&
                  (!expiry || Date.parse(`${expiry}Z`) <= Date.now()))
              }
              onClick={() => void applyAction()}
            >
              Confirm {action.kind === 'rotate' ? 'replacement' : 'revocation'}
            </button>
            <button
              className="button button-quiet"
              disabled={busy}
              onClick={() => setAction(null)}
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}
      <section className="card installation-panel">
        <h2>Enroll another desktop</h2>
        <p>
          On the new PC, complete initial setup and obtain its installation UUID
          and local location UUID. Select the corresponding central screening
          location below. Never reuse another PC’s installation ID.
        </p>
        <form
          onSubmit={(event) => void enroll(event)}
          className="installation-form"
        >
          <label>
            Central organization / location
            <select
              required
              value={form.locationId}
              disabled={!page || busy || !!token}
              onChange={(e) => setForm({ ...form, locationId: e.target.value })}
            >
              <option value="">Select a screening location</option>
              {page?.locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.organizationName} / {location.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Desktop deployment name
            <input
              required
              maxLength={120}
              value={form.deploymentName}
              onChange={(e) =>
                setForm({ ...form, deploymentName: e.target.value })
              }
            />
          </label>
          <label>
            Desktop installation UUID
            <input
              required
              pattern="[0-9a-fA-F-]{36}"
              value={form.installationId}
              onChange={(e) =>
                setForm({ ...form, installationId: e.target.value })
              }
            />
          </label>
          <label>
            Desktop local location UUID
            <input
              required
              pattern="[0-9a-fA-F-]{36}"
              value={form.sourceLocationId}
              onChange={(e) =>
                setForm({ ...form, sourceLocationId: e.target.value })
              }
            />
          </label>
          <label>
            Desktop time zone
            <input
              required
              maxLength={100}
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
            />
          </label>
          <label>
            Credential label
            <input
              required
              maxLength={120}
              value={form.credentialLabel}
              onChange={(e) =>
                setForm({ ...form, credentialLabel: e.target.value })
              }
            />
          </label>
          <label>
            Token expiry (UTC)
            <input
              type="datetime-local"
              required
              value={form.expiry}
              onChange={(e) => setForm({ ...form, expiry: e.target.value })}
            />
          </label>
          <div className="installation-actions">
            <button
              className="button"
              disabled={busy || !!token || !!action || !page?.locations.length}
            >
              Enroll desktop and generate token
            </button>
          </div>
        </form>
        {page?.locationsTruncated ? (
          <p role="status">
            Only the first 500 locations are shown. Contact an operator if your
            location is missing.
          </p>
        ) : null}
      </section>
    </div>
  );
}
