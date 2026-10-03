import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/context/auth';
import {
  type DashboardUser,
  addDashboardUser,
  friendlyTeamError,
  listDashboardUsers,
  removeDashboardUser,
  sendSetupEmail,
  setDashboardUserAdmin,
  setDashboardUserDisabled,
} from '@/lib/dashboard-users';
import { NoticeModal } from '@/pages/bread-types';

/**
 * Who can open the dashboard — the page that takes the client's staff list out
 * of the Firebase console and puts it in the hands of the person who actually
 * knows who works there.
 *
 * Visible only to accounts carrying `admin: true`; the shell doesn't render the
 * nav entry for anyone else, and every function behind these buttons re-checks
 * the flag on the server, so hiding it is convenience rather than the guard.
 *
 * Nothing here edits a password. An admin adds a person and Firebase emails
 * them a link to set their own, so no password is ever typed by one person and
 * read by another — which is the habit that produced the shared login this page
 * exists to end.
 */

/** Firebase Auth hands back RFC-1123-ish date strings; blank when it has none. */
function formatWhen(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function TeamPage() {
  const { user, isAdmin } = useAuth();

  const [users, setUsers] = useState<DashboardUser[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** The uid of whichever row is mid-action, so only that row's buttons disable. */
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      setUsers(await listDashboardUsers());
    } catch (error) {
      // The list is the whole page, so a failure gets a visible retry rather
      // than an empty table — "nobody is on the team" and "the list didn't
      // load" must never look the same.
      setLoadError(friendlyTeamError(error));
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void reload();
  }, [isAdmin, reload]);

  if (!isAdmin) {
    return (
      <div className="dashboard-page-fade">
        <div className="page-header">
          <h1>Team</h1>
        </div>
        <p className="hint">Only a dashboard administrator can manage the team.</p>
      </div>
    );
  }

  /**
   * Runs one row action, then reloads. Every action changes something the list
   * displays (disabled state, admin flag, whether the row exists at all), and
   * re-reading is both simpler and more honest than patching the row in place
   * from what we assumed the server did.
   */
  async function runFor(uid: string, action: () => Promise<void>, success: string) {
    setBusyUid(uid);
    try {
      await action();
      await reload();
      setNotice(success);
    } catch (error) {
      setNotice(friendlyTeamError(error));
    } finally {
      setBusyUid(null);
    }
  }

  return (
    <div className="dashboard-page-fade">
      <div className="page-header">
        <h1>Team</h1>
        <div className="page-header-actions">
          <button type="button" className="btn-primary" onClick={() => setAdding(true)} disabled={users === null}>
            Add person
          </button>
        </div>
      </div>

      <p className="hint catalog-hint">
        Everyone here can open this dashboard. Adding someone emails them a link to set their own password —
        you never see or type it. Each account can only be signed in on one browser at a time: signing in
        somewhere new signs the old one out.
      </p>

      {notice && <NoticeModal message={notice} onClose={() => setNotice(null)} />}

      {loadError ? (
        <p className="error">
          {loadError}{' '}
          <button type="button" className="link-button" onClick={() => void reload()}>
            Try again
          </button>
        </p>
      ) : users === null ? (
        <p className="hint">Loading…</p>
      ) : (
        <div className="table-scroll">
          <table className="bread-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last signed in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((row) => {
                const isSelf = row.uid === user?.uid;
                const busy = busyUid === row.uid;
                return (
                  <tr key={row.uid}>
                    <td>
                      {row.displayName || '—'}
                      {isSelf && <span className="review-badge">You</span>}
                    </td>
                    <td>{row.email}</td>
                    <td>{row.admin ? 'Administrator' : 'Staff'}</td>
                    <td>{row.disabled ? <span className="team-off">Disabled</span> : 'Active'}</td>
                    <td>{formatWhen(row.lastSignInAt)}</td>
                    <td>
                      <div className="bread-table-actions">
                        <button
                          type="button"
                          disabled={busy}
                          title="Email them a link to set a new password"
                          onClick={() =>
                            void runFor(
                              row.uid,
                              () => sendSetupEmail(row.email),
                              `Password link sent to ${row.email}.`,
                            )
                          }>
                          Send password link
                        </button>

                        {/*
                          Self-targeted actions are hidden, not just refused.
                          The server rejects them (an admin disabling or
                          demoting themselves is how the Team page becomes
                          unreachable), and offering a button whose only
                          outcome is an error is a worse way to say so.
                        */}
                        {!isSelf && (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                setConfirm({
                                  title: row.admin ? 'Remove administrator access?' : 'Make administrator?',
                                  body: row.admin
                                    ? `${row.displayName || row.email} will keep their dashboard access but will no longer be able to manage the team.`
                                    : `${row.displayName || row.email} will be able to add, disable and remove team members — including you.`,
                                  confirmLabel: row.admin ? 'Remove access' : 'Make administrator',
                                  danger: row.admin,
                                  run: () =>
                                    runFor(
                                      row.uid,
                                      () => setDashboardUserAdmin(row.uid, !row.admin),
                                      row.admin ? 'Administrator access removed.' : 'They are now an administrator.',
                                    ),
                                })
                              }>
                              {row.admin ? 'Remove admin' : 'Make admin'}
                            </button>

                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                setConfirm({
                                  title: row.disabled ? 'Turn this account back on?' : 'Disable this account?',
                                  body: row.disabled
                                    ? `${row.displayName || row.email} will be able to sign in again with their existing password.`
                                    : `${row.displayName || row.email} will be signed out everywhere and won't be able to sign in. Their account is kept, so you can switch it back on later.`,
                                  confirmLabel: row.disabled ? 'Turn back on' : 'Disable',
                                  danger: !row.disabled,
                                  run: () =>
                                    runFor(
                                      row.uid,
                                      () => setDashboardUserDisabled(row.uid, !row.disabled),
                                      row.disabled ? 'Account turned back on.' : 'Account disabled.',
                                    ),
                                })
                              }>
                              {row.disabled ? 'Enable' : 'Disable'}
                            </button>

                            <button
                              type="button"
                              className="danger"
                              disabled={busy}
                              onClick={() =>
                                setConfirm({
                                  title: 'Remove from the team?',
                                  body: `${row.displayName || row.email} will be deleted and won't be able to sign in. This can't be undone — you'd have to add them again. To keep the account for later, use Disable instead.`,
                                  confirmLabel: 'Remove',
                                  danger: true,
                                  run: () =>
                                    runFor(row.uid, () => removeDashboardUser(row.uid), 'Removed from the team.'),
                                })
                              }>
                              Remove
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <AddPersonModal
          onClose={() => setAdding(false)}
          onAdded={(message) => {
            setAdding(false);
            void reload();
            setNotice(message);
          }}
        />
      )}

      {confirm && (
        <ConfirmModal
          request={confirm}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            const request = confirm;
            setConfirm(null);
            void request.run();
          }}
        />
      )}
    </div>
  );
}

type ConfirmRequest = {
  title: string;
  body: string;
  confirmLabel: string;
  danger: boolean;
  run: () => Promise<void>;
};

function ConfirmModal({
  request,
  onClose,
  onConfirm,
}: {
  request: ConfirmRequest;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <h2>{request.title}</h2>
        <p className={request.danger ? 'modal-warning' : 'hint'} style={{ textAlign: 'left' }}>
          {request.body}
        </p>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={request.danger ? 'btn-danger' : 'btn-primary'}
            onClick={onConfirm}>
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddPersonModal({ onClose, onAdded }: { onClose: () => void; onAdded: (message: string) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [admin, setAdmin] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = email.trim().length > 0 && name.trim().length > 0 && !submitting;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const { emailSent } = await addDashboardUser({ email, displayName: name, admin });
      onAdded(
        emailSent
          ? `${name.trim()} was added. They've been emailed a link to set their password — it's worth telling them to check their spam folder.`
          : // The account exists; only the email failed. Saying "couldn't add
            // them" here would send an admin back to add somebody who is
            // already on the list.
            `${name.trim()} was added, but the password email couldn't be sent. Use "Send password link" on their row to try again.`,
      );
    } catch (err) {
      setError(friendlyTeamError(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal-card" onClick={(event) => event.stopPropagation()} onSubmit={handleSubmit}>
        <h2>Add someone to the team</h2>

        <label className="field">
          <span>Full name</span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Maria Santos"
            disabled={submitting}
            autoFocus
          />
        </label>

        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="maria@example.com"
            autoComplete="off"
            disabled={submitting}
          />
        </label>

        <label className="team-checkbox">
          <input
            type="checkbox"
            checked={admin}
            onChange={(event) => setAdmin(event.target.checked)}
            disabled={submitting}
          />
          <span>
            Make them an administrator
            <small>They'll be able to add, disable and remove team members too.</small>
          </span>
        </label>

        <p className="hint" style={{ textAlign: 'left' }}>
          They'll get an email with a link to set their own password. You won't see it, and you don't need to.
        </p>

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!canSubmit}>
            {submitting ? 'Adding…' : 'Add person'}
          </button>
        </div>
      </form>
    </div>
  );
}
