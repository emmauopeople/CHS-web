import { useEffect, useState } from 'react';
import { ApiError, type OperationsApi } from './api';
import {
  accountPermissions,
  type AccountPage,
  type AccountResult,
  type AccountRole,
  type AccountChange,
} from './account-contract';

export function Accounts({
  api,
  onUnauthorized,
}: {
  api: OperationsApi;
  onUnauthorized: () => void;
}) {
  const [page, setPage] = useState<AccountPage | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<AccountResult | null>(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AccountRole>('STAFF');
  const [organizationId, setOrganizationId] = useState('');
  const [permissions, setPermissions] = useState<string[]>([
    'PATIENT_READ',
    'SYNC_MONITOR',
  ]);
  const [pending, setPending] = useState<{
    id: string;
    name: string;
    action: AccountChange['action'];
  } | null>(null);
  useEffect(() => {
    if (!secret) return;
    const timer = setTimeout(() => setSecret(null), 300_000);
    return () => clearTimeout(timer);
  }, [secret]);
  useEffect(() => {
    const clear = () => {
      if (document.hidden) setSecret(null);
    };
    document.addEventListener('visibilitychange', clear);
    return () => document.removeEventListener('visibilitychange', clear);
  }, []);
  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
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
          ? 'Your account does not have permission for this account action.'
          : e instanceof ApiError && e.code === 'ACCOUNT_USERNAME_UNAVAILABLE'
            ? 'That username is already in use.'
            : e instanceof ApiError && e.status === 503
              ? 'Account identity service is unavailable. Try again later.'
              : e instanceof ApiError &&
                  e.code === 'ACCOUNT_SELF_CHANGE_NOT_PERMITTED'
                ? 'Use another super admin to change your account.'
                : 'The account action could not be completed.',
      );
    } finally {
      setBusy(false);
    }
  }
  const load = async (n = 1) => {
    const next = await api.searchAccounts(n);
    setPage(next);
  };
  return (
    <section aria-label="Account administration">
      <p>
        Admins manage staff within their organizations. Super admins also create
        and manage admins. Every account action is audited.
      </p>
      <button
        className="button button-primary"
        disabled={busy}
        onClick={() => void run(() => load())}
      >
        Load accounts
      </button>
      {error ? (
        <div role="alert" className="alert alert-error">
          {error}
        </div>
      ) : null}
      {secret?.temporaryPassword ? (
        <section className="panel" aria-label="Temporary password">
          <h2>Save this temporary password</h2>
          <p>
            Username: <strong>{secret.username}</strong>
          </p>
          <p>
            Share it directly with the account owner. It requires a password
            change at first sign-in. This display clears after five minutes or
            when you leave.
          </p>
          <label>
            Temporary password
            <input
              readOnly
              value={secret.temporaryPassword}
              autoComplete="off"
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <button
            className="button button-quiet"
            onClick={() => setSecret(null)}
          >
            Dismiss password
          </button>
        </section>
      ) : null}
      {page ? (
        <>
          <form
            className="panel"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const result = await api.createAccount({
                  reasonCode: 'ACCOUNT_ADMINISTRATION',
                  username,
                  displayName,
                  ...(email ? { email } : {}),
                  role,
                  ...(role === 'SUPER_ADMIN' ? {} : { organizationId }),
                  permissions,
                });
                await load(page.page);
                setSecret(result);
                setUsername('');
                setDisplayName('');
                setEmail('');
              });
            }}
          >
            <h2>Create account</h2>
            <div className="search-form">
              <div className="field">
                <label htmlFor="account-username">Username</label>
                <input
                  id="account-username"
                  required
                  pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}"
                  maxLength={64}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="field">
                <label htmlFor="account-name">Display name</label>
                <input
                  id="account-name"
                  required
                  maxLength={120}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="account-email">Email (optional)</label>
                <input
                  id="account-email"
                  type="email"
                  maxLength={254}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="field">
                <label htmlFor="account-role">Role</label>
                <select
                  id="account-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as AccountRole)}
                >
                  <option value="STAFF">Staff</option>
                  {page.actorRole === 'SUPER_ADMIN' ? (
                    <>
                      <option value="ADMIN">Admin</option>
                      <option value="SUPER_ADMIN">Super admin</option>
                    </>
                  ) : null}
                </select>
              </div>
              {role !== 'SUPER_ADMIN' ? (
                <div className="field">
                  <label htmlFor="account-organization">Organization</label>
                  <select
                    required
                    id="account-organization"
                    value={organizationId}
                    onChange={(e) => setOrganizationId(e.target.value)}
                  >
                    <option value="">Choose organization</option>
                    {page.organizations.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <p>Super admins have global access across organizations.</p>
              )}
            </div>
            {role === 'STAFF' ? (
              <fieldset>
                <legend>Staff permissions</legend>
                {accountPermissions.map((p) => (
                  <label key={p} className="account-permission">
                    <input
                      type="checkbox"
                      checked={permissions.includes(p)}
                      onChange={(e) =>
                        setPermissions(
                          e.target.checked
                            ? [...permissions, p]
                            : permissions.filter((v) => v !== p),
                        )
                      }
                    />
                    {p.toLowerCase().replaceAll('_', ' ')}
                  </label>
                ))}
              </fieldset>
            ) : (
              <p>
                Admins receive patient access, Medical ID recovery, identity
                review and resolution, sync monitoring, desktop installation
                management and staff account administration.
              </p>
            )}
            <button
              className="button button-primary"
              disabled={busy || (role === 'STAFF' && !permissions.length)}
            >
              Create account
            </button>
          </form>
          <section className="panel">
            <h2>Accounts</h2>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((a) => (
                  <tr key={a.id}>
                    <td>{a.displayName}</td>
                    <td>{a.username ?? 'Existing account'}</td>
                    <td>{a.role.replaceAll('_', ' ')}</td>
                    <td>{a.status}</td>
                    <td>
                      {a.id !== page.actorId &&
                      (page.actorRole === 'SUPER_ADMIN' ||
                        a.role === 'STAFF') ? (
                        <>
                          <button
                            className="button button-quiet"
                            disabled={busy}
                            onClick={() =>
                              setPending({
                                id: a.id,
                                name: a.displayName,
                                action:
                                  a.status === 'ACTIVE'
                                    ? 'SUSPEND'
                                    : 'ACTIVATE',
                              })
                            }
                          >
                            {a.status === 'ACTIVE' ? 'Suspend' : 'Activate'}
                          </button>
                          <button
                            className="button button-quiet"
                            disabled={busy}
                            onClick={() =>
                              setPending({
                                id: a.id,
                                name: a.displayName,
                                action: 'RESET_PASSWORD',
                              })
                            }
                          >
                            Reset password
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
            </button>
            <span> Page {page.page} </span>
            <button
              className="button button-quiet"
              disabled={busy || !page.hasMore}
              onClick={() => void run(() => load(page.page + 1))}
            >
              Next
            </button>
          </section>
        </>
      ) : null}
      {pending ? (
        <section
          className="panel"
          role="alertdialog"
          aria-label="Confirm account action"
        >
          <h2>Confirm account action</h2>
          <p>
            {pending.action.replaceAll('_', ' ')}: {pending.name}
          </p>
          <p>
            Suspension blocks portal access. Password resets sign out existing
            sessions.
          </p>
          <button
            className="button button-primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await api.changeAccount({
                  reasonCode: 'ACCOUNT_ADMINISTRATION',
                  id: pending.id,
                  action: pending.action,
                  confirmed: true,
                });
                setPending(null);
                await load(page?.page);
                setSecret(result);
              })
            }
          >
            Confirm
          </button>
          <button
            className="button button-quiet"
            disabled={busy}
            onClick={() => setPending(null)}
          >
            Cancel
          </button>
        </section>
      ) : null}
    </section>
  );
}
