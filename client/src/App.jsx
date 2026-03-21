import { useEffect, useState } from 'react';
import AuthPage from './components/AuthPage';
import TrackerPage from './components/TrackerPage';
import { getMe, getToken, setToken, clearToken } from './services/auth';

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }

    getMe()
      .then((user) => {
        setUser(user);
      })
      .catch(() => {
        clearToken();
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const handleLogin = (token, user) => {
    setToken(token);
    setUser(user);
  };

  const handleLogout = () => {
    clearToken();
    setUser(null);
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
        <TrackerPage user={user} onLogout={handleLogout} />
      ) : (
        <AuthPage onSuccess={handleLogin} />
      )}
      {error && (
        <div className="position-fixed bottom-0 end-0 m-3">
          <div className="alert alert-danger shadow-sm">{error}</div>
        </div>
      )}
    </div>
  );
}
