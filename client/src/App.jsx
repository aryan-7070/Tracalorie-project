import { useCallback, useEffect, useState } from 'react';
import AuthPage from './components/AuthPage';
import TrackerPage from './components/TrackerPage';
import SecurityPanel from './components/SecurityPanel';
import { getMe, logout } from './services/auth';
import { onAuthFailure, clearCsrfToken } from './services/api';

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showSecurity, setShowSecurity] = useState(false);
  const [notice, setNotice] = useState(null);

  // On boot, ask the server who we are. There is no token to read from storage:
  // the httpOnly cookie is attached by the browser, so a page reload restores
  // the session with no client-side state at all.
  useEffect(() => {
    let cancelled = false;

    getMe()
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch(() => {
        // Not signed in, or the session expired and could not be refreshed.
        // Either way the correct state is "signed out".
        clearCsrfToken();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // The API layer tells us when a session becomes unrecoverable — revoked
  // elsewhere, reuse detected, or the account deleted. React to it here rather
  // than leaving the UI showing stale data that will 401 on the next click.
  useEffect(() => {
    return onAuthFailure((reason) => {
      setUser(null);
      setShowSecurity(false);
      setNotice(
        reason === 'refresh_token_reuse'
          ? 'We signed you out because this session token was reused, which can mean it was copied. If this was you, please sign in again and change your password.'
          : 'Your session ended. Please sign in again.'
      );
    });
  }, []);

  const handleLogin = (nextUser) => {
    clearCsrfToken();
    setUser(nextUser);
    setNotice(null);
  };

  const handleLogout = useCallback(async () => {
    await logout();
    setUser(null);
    setShowSecurity(false);
  }, []);

  const handleAccountDeleted = (message) => {
    clearCsrfToken();
    setUser(null);
    setShowSecurity(false);
    setNotice(message);
  };

  if (loading) {
    return (
      <div className="d-flex vh-100 justify-content-center align-items-center">
        <div className="spinner-border" role="status">
          <span className="visually-hidden">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-vh-100 bg-light">
      {user ? (
        <>
          {showSecurity && (
            <SecurityPanel
              onPasswordChanged={() => setNotice('Password updated.')}
              onAccountDeleted={handleAccountDeleted}
            />
          )}

          <TrackerPage
            user={user}
            onLogout={handleLogout}
            onShowSecurity={() => setShowSecurity((v) => !v)}
            showSecurity={showSecurity}
          />
        </>
      ) : (
        <AuthPage onSuccess={handleLogin} />
      )}

      {notice && (
        <div
          className="position-fixed bottom-0 end-0 m-3"
          style={{ maxWidth: 420, zIndex: 1080 }}
        >
          <div className="alert alert-warning shadow-sm" role="status">
            {notice}
            <button
              type="button"
              className="btn-close ms-2"
              aria-label="Dismiss"
              onClick={() => setNotice(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
