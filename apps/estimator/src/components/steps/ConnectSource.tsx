//-------------------------//
// ConnectSource.tsx
// Platform picker with OAuth buttons for configured providers
// and token form fallback for Trello, Wrike, and unconfigured platforms.
//-------------------------//

import { useEffect, useState } from 'react';
import type { SourcePlatform } from '@cirface/core/types';
import type { AppUser } from '../../App.tsx';

interface Props {
  user: AppUser;
  onConnected: (platform: SourcePlatform) => void;
}

interface OAuthProviders {
  asana: boolean;
  monday: boolean;
  smartsheet: boolean;
}

interface TokenConfig {
  placeholder: string;
  helpText: string;
}

const PLATFORM_LABELS: Record<SourcePlatform, string> = {
  asana:       'Asana',
  monday:      'Monday.com',
  smartsheet:  'Smartsheet',
  trello:      'Trello',
  wrike:       'Wrike',
  workfront:   'Workfront',
};

const TOKEN_CONFIG: Record<SourcePlatform, TokenConfig> = {
  asana: {
    placeholder: 'Personal Access Token',
    helpText:    'Generate at: Asana → My Profile Settings → Apps → Manage Developer Apps',
  },
  monday: {
    placeholder: 'API Token',
    helpText:    'Generate at: Monday.com → Profile → Admin → API',
  },
  smartsheet: {
    placeholder: 'Personal Access Token',
    helpText:    'Generate at: Smartsheet → Account → Apps & Integrations → API Access',
  },
  trello: {
    placeholder: 'apiKey:token',
    helpText:    'Get your API key at trello.com/app-key, then click "Token" to generate a token. Combine as "apiKey:token".',
  },
  wrike: {
    placeholder: 'Personal Access Token',
    helpText:    'Generate at: Wrike → Profile → Apps & Integrations → API → Create permanent token',
  },
  workfront: {
    placeholder: 'apiKey:domain',
    helpText:    'Combine your Workfront API key and domain as "apiKey:domain" (e.g. abc123:mycompany).',
  },
};

// Trello, Wrike, and Workfront use token auth only — no OAuth flow
const TOKEN_ONLY = new Set<SourcePlatform>(['trello', 'wrike', 'workfront']);

const ALL_PLATFORMS: SourcePlatform[] = ['asana', 'monday', 'smartsheet', 'trello', 'wrike', 'workfront'];

export default function ConnectSource({ user, onConnected }: Props) {
  const [providers, setProviders] = useState<OAuthProviders | null>(null);
  const [platform, setPlatform] = useState<SourcePlatform>('asana');
  const [token, setToken] = useState('');
  // Workfront uses two separate fields combined as "apiKey:domain"
  const [wfApiKey, setWfApiKey] = useState('');
  const [wfDomain, setWfDomain] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // Fetch which platforms have OAuth configured
    fetch('/api/auth/providers')
      .then((r) => r.json())
      .then((data: OAuthProviders) => setProviders(data))
      .catch(() => setProviders({ asana: false, monday: false, smartsheet: false }));

    // Show any error passed back from an OAuth redirect
    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get('error');
    if (oauthError) {
      setError(
        oauthError === 'access_denied'
          ? 'Access was denied. Please try again.'
          : 'Connection failed. Please try again.',
      );
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // True when the selected platform has OAuth configured
  const hasOAuth =
    providers !== null &&
    !TOKEN_ONLY.has(platform) &&
    providers[platform as keyof OAuthProviders] === true;

  async function handleAsanaConnect() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/source/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'asana' }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) {
        setError(data.error ?? 'Connection failed.');
        return;
      }
      onConnected('asana');
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleTokenConnect(e: { preventDefault(): void }) {
    e.preventDefault();
    const combinedToken = platform === 'workfront'
      ? `${wfApiKey.trim()}:${wfDomain.trim()}`
      : token.trim();
    if (!combinedToken || combinedToken === ':') return;

    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/source/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, token: combinedToken }),
      });

      const data = await res.json() as { ok?: boolean; error?: string };

      if (!res.ok) {
        setError(data.error ?? 'Connection failed. Check your credentials and try again.');
        return;
      }

      onConnected(platform);
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  const config = TOKEN_CONFIG[platform];

  return (
    <div className="step-panel">
      <h2 className="step-title">Connect Your Source</h2>
      <p className="step-desc">
        Connect to the platform you want to migrate from. Your credentials are used only to read
        project data for the estimate and are never stored beyond your session.
      </p>

      <div className="field-group">
        <label htmlFor="platform">Source platform</label>
        <select
          id="platform"
          value={platform}
          onChange={(e) => {
            setPlatform(e.target.value as SourcePlatform);
            setToken('');
            setWfApiKey('');
            setWfDomain('');
            setError('');
          }}
        >
          {ALL_PLATFORMS.map((p) => (
            <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>
          ))}
        </select>
      </div>

      {error && <p className="error-text">{error}</p>}

      {platform === 'asana' ? (
        <div className="step-actions">
          <button className="btn btn-primary" onClick={handleAsanaConnect} disabled={loading}>
            {loading ? 'Connecting…' : `Use ${user.name}'s Asana account`}
          </button>
          <p className="field-hint" style={{ marginTop: '0.75rem' }}>
            Your already-authenticated Asana account will be used — no additional credentials needed.
          </p>
        </div>
      ) : hasOAuth ? (
        <div className="step-actions">
          <a href={`/auth/${platform}/login`} className="btn btn-primary">
            Connect with {PLATFORM_LABELS[platform]}
          </a>
          <p className="field-hint" style={{ marginTop: '0.75rem' }}>
            You'll be redirected to {PLATFORM_LABELS[platform]} to authorise access, then brought back here automatically.
          </p>
        </div>
      ) : (
        <form onSubmit={handleTokenConnect}>
          {platform === 'workfront' ? (
            <>
              <div className="field-group">
                <label htmlFor="wf-domain">Workfront domain</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <input
                    id="wf-domain"
                    type="text"
                    autoComplete="off"
                    placeholder="mycompany"
                    value={wfDomain}
                    onChange={(e) => { setWfDomain(e.target.value); setError(''); }}
                    style={{ flex: 1 }}
                  />
                  <span className="field-hint" style={{ whiteSpace: 'nowrap', margin: 0 }}>.my.workfront.com</span>
                </div>
                <span className="field-hint">The subdomain of your Workfront instance.</span>
              </div>
              <div className="field-group">
                <label htmlFor="wf-apikey">API key</label>
                <input
                  id="wf-apikey"
                  type="password"
                  autoComplete="off"
                  placeholder="Workfront API key"
                  value={wfApiKey}
                  onChange={(e) => { setWfApiKey(e.target.value); setError(''); }}
                />
                <span className="field-hint">Find your API key in Workfront: Setup → System → Customer Info.</span>
              </div>
            </>
          ) : (
            <div className="field-group">
              <label htmlFor="token">Access token</label>
              <input
                id="token"
                type="password"
                autoComplete="off"
                placeholder={config.placeholder}
                value={token}
                onChange={(e) => { setToken(e.target.value); setError(''); }}
              />
              <span className="field-hint">{config.helpText}</span>
            </div>
          )}

          <div className="step-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading || (platform === 'workfront' ? !wfApiKey.trim() || !wfDomain.trim() : !token.trim())}
            >
              {loading ? 'Connecting…' : `Connect to ${PLATFORM_LABELS[platform]}`}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
