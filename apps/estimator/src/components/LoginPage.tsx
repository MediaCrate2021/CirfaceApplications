//-------------------------//
// LoginPage.tsx
// Shown to unauthenticated users. Matches the migration tool login card style.
//-------------------------//

import type { AppState } from '../App.tsx';

const ENV_BADGE: Record<AppState['appEnv'], { label: string; style: React.CSSProperties } | null> = {
  development: {
    label: 'DEV',
    style: { background: '#16b4bf', color: '#fff', padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.05em' },
  },
  staging: {
    label: 'STAGING',
    style: { background: '#ffa100', color: '#1a1a1a', padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.05em' },
  },
  production: null,
};

interface Props {
  appEnv: AppState['appEnv'];
}

export default function LoginPage({ appEnv }: Props) {
  const badge = ENV_BADGE[appEnv];
  const error = new URLSearchParams(window.location.search).get('error');

  return (
    <div className="login-screen">
      <div className="login-card">
        <img src="/logo" alt="Cirface" style={{ height: 40, marginBottom: '0.25rem' }} />
        <h1>
          Migration Estimator
          {badge && <span style={{ ...badge.style, marginLeft: '0.5rem', verticalAlign: 'middle' }}>{badge.label}</span>}
        </h1>
        <p className="subtitle">
          Analyse your project data and get a migration estimate. Authorise with your Asana account to continue.
        </p>
        <a href="/auth/asana/login" className="btn btn-primary btn-lg">
          Connect with Asana
        </a>
        {error && (
          <p className="error-text">
            {error === 'access_denied'
              ? 'Access was denied. Please try again.'
              : 'Authentication failed. Please try again.'}
          </p>
        )}
        <p className="legal-links">
          By connecting, you agree to our{' '}
          <a href="/terms.html">Terms of Use</a> and{' '}
          <a href="/privacy.html">Privacy Policy</a>.
        </p>
      </div>
    </div>
  );
}
