import { useState, useEffect } from 'react';
import { login, register } from '../services/auth';
import '../styles/AuthPage.css';

export default function AuthPage({ onSuccess }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);

  const isLogin = mode === 'login';

  useEffect(() => {
    setMounted(true);
  }, []);

  const switchMode = (newMode) => {
    setError(null);
    setSuccessMsg(null);
    setUsername('');
    setEmail('');
    setPassword('');
    setMode(newMode);
  };

  /**
   * Client-side policy check.
   *
   * This exists purely for fast feedback. The server enforces the same rules (and
   * more) authoritatively — duplicating them here is a usability feature, never a
   * security control. Keeping that comment honest matters: the moment someone
   * treats this as the gate, the server-side check gets dropped.
   */
  const validatePassword = (value) => {
    if (value.length < 12) {
      return 'Password must be at least 12 characters long.';
    }
    if (value.length > 72) {
      // bcrypt only hashes the first 72 bytes; the server rejects longer input
      // rather than silently truncating.
      return 'Password must be at most 72 characters long.';
    }
    return null;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    setSuccessMsg(null);

    if (!isLogin) {
      const passwordError = validatePassword(password);
      if (passwordError) {
        setError(passwordError);
        return;
      }
    }

    setLoading(true);

    try {
      if (isLogin) {
        // No token is returned or stored: the server sets an httpOnly cookie and
        // we hand the user object straight up.
        const response = await login(username, password);
        onSuccess(response.user);
      } else {
        await register({ username, password, email, displayName });
        setSuccessMsg('Account created! Please log in.');
        switchMode('login');
      }
    } catch (err) {
      // Surface the server's field-level reasons when it sends them.
      if (err?.details?.length) {
        setError(err.details.map((d) => `${d.path}: ${d.message}`).join(' · '));
      } else {
        setError(err?.message || 'Something went wrong');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-root">

      {/* ── Left decorative panel ── */}
      <div className="auth-left">
        <div className="auth-left-grid" />

        <div className="auth-brand">
          <div className="auth-brand-icon">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M10 3L13 8H17L14 12L15.5 17L10 14L4.5 17L6 12L3 8H7L10 3Z" fill="white" />
            </svg>
          </div>
          <span className="auth-brand-name">Tracalorie</span>
        </div>

        <div className="auth-left-content">
          <p className="auth-left-eyebrow">Your fitness, simplified</p>
          <h1 className="auth-left-heading">
            Every calorie<br />
            <em>tells a story.</em>
          </h1>
          <p className="auth-left-sub">
            Track meals, log workouts, and stay in control of your daily energy balance — beautifully.
          </p>
          <div className="auth-stats">
            <div>
              <div className="auth-stat-value">2,400</div>
              <div className="auth-stat-label">Avg. daily goal</div>
            </div>
            <div>
              <div className="auth-stat-value">∞</div>
              <div className="auth-stat-label">Meals trackable</div>
            </div>
            <div>
              <div className="auth-stat-value">Free</div>
              <div className="auth-stat-label">Always</div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Right form panel ── */}
      <div className="auth-right">
        <div className={`auth-card ${mounted ? 'visible' : ''}`}>

          {/* Tab switcher */}
          <div className="auth-tab-row">
            <button
              className={`auth-tab ${isLogin ? 'active' : ''}`}
              onClick={() => switchMode('login')}
            >
              Sign In
            </button>
            <button
              className={`auth-tab ${!isLogin ? 'active' : ''}`}
              onClick={() => switchMode('register')}
            >
              Register
            </button>
          </div>

          <div className="auth-card-header">
            <h2 className="auth-card-title">
              {isLogin ? 'Welcome back' : 'Create account'}
            </h2>
            <p className="auth-card-subtitle">
              {isLogin
                ? 'Enter your credentials to continue.'
                : 'Start tracking your journey today.'}
            </p>
          </div>

          {successMsg && (
            <div className="auth-alert success">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="7" stroke="#34d399" strokeWidth="1.5" />
                <path d="M5 8l2 2 4-4" stroke="#34d399" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {successMsg}
            </div>
          )}

          {error && (
            <div className="auth-alert error">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="7" stroke="#ef4444" strokeWidth="1.5" />
                <path d="M8 5v3.5M8 10.5v.5" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="auth-field">
              <label className="auth-label" htmlFor="username">Username</label>
              <div className="auth-input-wrap">
                <input
                  id="username"
                  type="text"
                  className="auth-input"
                  placeholder="your_username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  minLength={isLogin ? 1 : 3}
                  maxLength={isLogin ? 254 : 32}
                  autoFocus
                  autoComplete="username"
                  // Credentials, not arbitrary text: stops a password manager
                  // from offering to save the username as if it were a login.
                  name="username"
                />
              </div>
            </div>

            {!isLogin && (
              <>
                <div className="auth-field">
                  <label className="auth-label" htmlFor="email">
                    Email <span className="auth-optional">(optional)</span>
                  </label>
                  <div className="auth-input-wrap">
                    <input
                      id="email"
                      type="email"
                      className="auth-input"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      maxLength={254}
                      autoComplete="email"
                      name="email"
                    />
                  </div>
                </div>

                <div className="auth-field">
                  <label className="auth-label" htmlFor="displayName">
                    Display name <span className="auth-optional">(optional)</span>
                  </label>
                  <div className="auth-input-wrap">
                    <input
                      id="displayName"
                      type="text"
                      className="auth-input"
                      placeholder="How should we greet you?"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      maxLength={64}
                      autoComplete="nickname"
                      name="nickname"
                    />
                  </div>
                </div>
              </>
            )}

            <div className="auth-field">
              <label className="auth-label" htmlFor="password">Password</label>
              <div className="auth-input-wrap">
                <input
                  id="password"
                  type="password"
                  className="auth-input"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={isLogin ? 1 : 12}
                  maxLength={isLogin ? 256 : 72}
                  title={
                    isLogin
                      ? undefined
                      : 'At least 12 characters. Avoid common or reused passwords.'
                  }
                  autoComplete={isLogin ? 'current-password' : 'new-password'}
                  name="password"
                />
              </div>
            </div>

            <button className="auth-btn" type="submit" disabled={loading}>
              {loading ? (
                <span className="auth-spinner" />
              ) : (
                <>
                  {isLogin ? 'Sign In' : 'Create Account'}
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M3 8h10M9 4l4 4-4 4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </>
              )}
            </button>
          </form>

          <div className="auth-divider">
            <div className="auth-divider-line" />
            <span className="auth-divider-text">
              {isLogin ? 'New here?' : 'Already registered?'}
              &nbsp;
              <span
                className="auth-switch-link"
                onClick={() => switchMode(isLogin ? 'register' : 'login')}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && switchMode(isLogin ? 'register' : 'login')}
              >
                {isLogin ? 'Register' : 'Sign In'}
              </span>
            </span>
            <div className="auth-divider-line" />
          </div>

        </div>
      </div>

    </div>
  );
}
