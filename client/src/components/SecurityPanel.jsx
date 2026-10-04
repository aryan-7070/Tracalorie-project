import { useCallback, useEffect, useState } from 'react';
import * as api from '../services/auth';
import { ApiError } from '../services/api';
import '../styles/SecurityPanel.css';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'sessions', label: 'Active sessions' },
  { id: 'audit', label: 'Security log' },
  { id: 'data', label: 'Your data' },
];

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Human label and severity colour for an audit action. */
const ACTION_LABELS = {
  'account.registered': 'Account created',
  'auth.login.success': 'Signed in',
  'auth.login.failure': 'Failed sign-in',
  'auth.login.blocked': 'Sign-in blocked (too many failures)',
  'auth.logout': 'Signed out',
  'auth.token.refresh': 'Session refreshed',
  'auth.token.reuse_detected': 'Stolen token detected — sessions revoked',
  'account.password.changed': 'Password changed',
  'account.profile.updated': 'Profile updated',
  'session.revoked': 'Session revoked',
  'session.revoked_all': 'All other sessions revoked',
  'security.csrf.rejected': 'Blocked cross-site request',
  'security.rate_limit.tripped': 'Rate limit triggered',
  'privacy.data.exported': 'Data exported',
  'privacy.account.deleted': 'Account deletion requested',
  'security.anomalous_access': 'Unusual access detected',
};

const SEVERITY = {
  'auth.token.reuse_detected': 'critical',
  'security.csrf.rejected': 'high',
  'security.rate_limit.tripped': 'medium',
  'auth.login.blocked': 'medium',
  'privacy.account.deleted': 'high',
};

export default function SecurityPanel({ onPasswordChanged, onAccountDeleted }) {
  const [tab, setTab] = useState('overview');
  const [overview, setOverview] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [audit, setAudit] = useState({ entries: [], summary: [] });
  const [verification, setVerification] = useState(null);
  const [findings, setFindings] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');

  const flash = useCallback((text, tone = 'success') => {
    setMessage({ text, tone });
    setError(null);
    setTimeout(() => setMessage(null), 6000);
  }, []);

  const fail = useCallback((err) => {
    setError(err instanceof ApiError ? err.message : 'Something went wrong');
    setMessage(null);
  }, []);

  const run = useCallback(
    async (fn, successMessage) => {
      setBusy(true);
      try {
        const result = await fn();
        if (successMessage) flash(successMessage);
        return result;
      } catch (err) {
        fail(err);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [flash, fail]
  );

  const loadOverview = useCallback(
    () =>
      run(async () => {
        const [ov, sess, auditData, found] = await Promise.all([
          api.getSecurityOverview(),
          api.getSessions(),
          api.getAuditLog({ days: 30, limit: 50 }),
          api.getFindings(),
        ]);
        setOverview(ov.security);
        setSessions(sess.sessions || []);
        setAudit(auditData);
        setFindings(found.open || []);
      }),
    [run]
  );

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  const verifyChain = () =>
    run(async () => {
      const result = await api.verifyAuditChain();
      setVerification(result.verification);
      return result;
    });

  const handleChangePassword = async (event) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }

    const result = await run(() =>
      api.changePassword(currentPassword, newPassword)
    );

    if (result) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      flash('Password updated. Other devices have been signed out.');
      if (onPasswordChanged) onPasswordChanged();
      loadOverview();
    }
  };

  const handleRevoke = (sessionUuid) =>
    run(async () => {
      await api.revokeSession(sessionUuid);
      const refreshed = await api.getSessions();
      setSessions(refreshed.sessions || []);
    }, 'Session revoked.').then(loadOverview);

  const handleLogoutEverywhere = () =>
    run(async () => {
      const result = await api.logoutEverywhere();
      return result;
    }, 'All other devices signed out.').then(loadOverview);

  const handleArchive = () =>
    run(async () => {
      const result = await api.archiveToCloud();
      flash(`Encrypted archive stored (${result.byteSize} bytes). Expires in 7 days.`);
      return result;
    });

  const handleDeleteAccount = async (event) => {
    event.preventDefault();
    if (deleteConfirm !== 'DELETE') {
      setError('Type DELETE to confirm');
      return;
    }
    if (!window.confirm(
      'This signs you out everywhere and schedules your data for deletion. Continue?'
    )) {
      return;
    }

    const result = await run(() => api.deleteAccount(deletePassword, deleteConfirm));
    if (result) {
      setDeletePassword('');
      setDeleteConfirm('');
      if (onAccountDeleted) onAccountDeleted(result.message);
    }
  };

  const handleResolveFinding = (id) =>
    run(async () => {
      await api.resolveFinding(id);
      const found = await api.getFindings();
      setFindings(found.open || []);
    }, 'Marked as reviewed.');

  return (
    <section className="sec-panel" aria-labelledby="sec-heading">
      <div className="sec-header">
        <h2 id="sec-heading" className="sec-title">Security &amp; privacy</h2>
        <p className="sec-subtitle">
          Every security event on your account is recorded below in a tamper-evident log.
        </p>
      </div>

      <div className="sec-tabs" role="tablist" aria-label="Security settings sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`sec-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {message && (
        <div className={`sec-alert ${message.tone}`} role="status">
          {message.text}
        </div>
      )}
      {error && (
        <div className="sec-alert danger" role="alert">
          {error}
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {tab === 'overview' && (
        <div className="sec-body">
          <div className="sec-grid">
            <div className="sec-stat">
              <span className="sec-stat-value">{sessions.length}</span>
              <span className="sec-stat-label">Active sessions</span>
            </div>
            <div className="sec-stat">
              <span className="sec-stat-value">{findings.length}</span>
              <span className="sec-stat-label">Open alerts</span>
            </div>
            <div className="sec-stat">
              <span className="sec-stat-value">
                {overview?.last30Days?.failures ?? 0}
              </span>
              <span className="sec-stat-label">Failed sign-ins (30d)</span>
            </div>
            <div className="sec-stat">
              <span className="sec-stat-value">
                {overview?.accountAgeDays ?? 0}d
              </span>
              <span className="sec-stat-label">Account age</span>
            </div>
          </div>

          {findings.length > 0 && (
            <div className="sec-block">
              <h3 className="sec-block-title">Needs your attention</h3>
              {findings.map((f) => (
                <div key={f.id} className={`sec-finding ${f.severity}`}>
                  <div className="sec-finding-main">
                    <strong>{f.message}</strong>
                    <span className="sec-finding-time">{formatDate(f.created_at)}</span>
                  </div>
                  <button
                    className="sec-btn small"
                    disabled={busy}
                    onClick={() => handleResolveFinding(f.id)}
                  >
                    Reviewed
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="sec-block">
            <h3 className="sec-block-title">Change password</h3>
            <p className="sec-hint">
              Changing your password signs out every other device immediately.
            </p>
            <form className="sec-form" onSubmit={handleChangePassword}>
              <label className="sec-field">
                <span>Current password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                />
              </label>
              <label className="sec-field">
                <span>New password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  minLength={12}
                  required
                />
              </label>
              <label className="sec-field">
                <span>Confirm new password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  minLength={12}
                  required
                />
              </label>
              <p className="sec-hint">
                At least 12 characters, and not one of the most common breached passwords.
              </p>
              <button className="sec-btn" type="submit" disabled={busy}>
                Update password
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {tab === 'sessions' && (
        <div className="sec-body">
          <p className="sec-hint">
            A session is one signed-in device. If you do not recognise one, revoke it and
            change your password.
          </p>

          <table className="sec-table">
            <thead>
              <tr>
                <th>Device</th>
                <th>Location</th>
                <th>Last active</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.session_uuid} className={s.is_current ? 'current' : ''}>
                  <td>
                    {s.device_label || 'Unknown device'}
                    {s.is_current && <span className="sec-badge">This device</span>}
                  </td>
                  <td className="mono">{s.ip_address || '—'}</td>
                  <td>{formatDate(s.last_used_at)}</td>
                  <td className="sec-actions">
                    {s.is_current ? (
                      <span className="sec-hint inline">Use Sign out</span>
                    ) : (
                      <button
                        className="sec-btn small danger"
                        disabled={busy}
                        onClick={() => handleRevoke(s.session_uuid)}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {sessions.length === 0 && (
                <tr>
                  <td colSpan={4} className="sec-empty">No active sessions.</td>
                </tr>
              )}
            </tbody>
          </table>

          <button className="sec-btn danger" disabled={busy} onClick={handleLogoutEverywhere}>
            Sign out of all other devices
          </button>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {tab === 'audit' && (
        <div className="sec-body">
          <div className="sec-block">
            <h3 className="sec-block-title">Log integrity</h3>
            <p className="sec-hint">
              Each entry stores a SHA-256 hash of its own contents and a hash of the entry
              before it. If any entry were edited or removed, verification would fail.
            </p>
            <button className="sec-btn" disabled={busy} onClick={verifyChain}>
              Verify log integrity
            </button>

            {verification && (
              <div className={`sec-verdict ${verification.valid ? 'ok' : 'bad'}`}>
                {verification.valid ? (
                  <>
                    <strong>Verified.</strong> {verification.checked} entries checked — the
                    chain is intact.
                  </>
                ) : (
                  <>
                    <strong>Integrity check FAILED.</strong> Break detected at entry{' '}
                    {verification.firstBreak?.id}: {verification.firstBreak?.detail}
                  </>
                )}
                {verification.headHash && (
                  <div className="sec-hash">
                    <span>Chain head</span>
                    <code>{verification.headHash}</code>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="sec-block">
            <h3 className="sec-block-title">Recent events (30 days)</h3>
            <table className="sec-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>When</th>
                  <th>Location</th>
                </tr>
              </thead>
              <tbody>
                {audit.entries.map((e) => (
                  <tr key={e.id} className={SEVERITY[e.action] || ''}>
                    <td>
                      {ACTION_LABELS[e.action] || e.action}
                      {e.outcome === 'failure' && <span className="sec-badge warn">failed</span>}
                    </td>
                    <td>{formatDate(e.occurred_at)}</td>
                    <td className="mono">{e.ip_address || '—'}</td>
                  </tr>
                ))}
                {audit.entries.length === 0 && (
                  <tr>
                    <td colSpan={3} className="sec-empty">No events recorded yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {tab === 'data' && (
        <div className="sec-body">
          <div className="sec-block">
            <h3 className="sec-block-title">Download your data</h3>
            <p className="sec-hint">
              Everything we hold about you: profile, meals, workouts, sessions, sign-in
              history and security events. Generated on request, never cached.
            </p>
            <div className="sec-btn-row">
              <button
                className="sec-btn"
                disabled={busy}
                onClick={() => api.downloadDataExport('json')}
              >
                Download JSON
              </button>
              <button
                className="sec-btn"
                disabled={busy}
                onClick={() => api.downloadDataExport('csv')}
              >
                Download CSV
              </button>
              <button className="sec-btn" disabled={busy} onClick={handleArchive}>
                Encrypted cloud archive
              </button>
            </div>
          </div>

          <div className="sec-block danger-zone">
            <h3 className="sec-block-title">Delete account</h3>
            <p className="sec-hint">
              Signs you out everywhere and schedules your personal data for deletion within
              30 days. Security events are retained in anonymised form so the audit chain
              stays intact.
            </p>
            <form className="sec-form" onSubmit={handleDeleteAccount}>
              <label className="sec-field">
                <span>Confirm with your password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  required
                />
              </label>
              <label className="sec-field">
                <span>Type DELETE to confirm</span>
                <input
                  type="text"
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  required
                />
              </label>
              <button className="sec-btn danger" type="submit" disabled={busy}>
                Permanently delete my account
              </button>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
