//-------------------------//
// ConnectSource.tsx
// Platform picker and token entry.
// Phase 3 will replace token inputs with OAuth flows per platform.
//-------------------------//

import { useState } from 'react';
import type { SourcePlatform } from '@cirface/core/types';

interface Props {
  onConnected: (platform: SourcePlatform) => void;
}

interface PlatformConfig {
  label: string;
  placeholder: string;
  helpText: string;
}

const PLATFORMS: Record<SourcePlatform, PlatformConfig> = {
  asana: {
    label: 'Asana',
    placeholder: 'Personal Access Token',
    helpText: 'Generate at: Asana → My Profile Settings → Apps → Manage Developer Apps',
  },
  monday: {
    label: 'Monday.com',
    placeholder: 'API Token',
    helpText: 'Generate at: Monday.com → Profile → Admin → API',
  },
  smartsheet: {
    label: 'Smartsheet',
    placeholder: 'Personal Access Token',
    helpText: 'Generate at: Smartsheet → Account → Apps & Integrations → API Access',
  },
  trello: {
    label: 'Trello',
    placeholder: 'apiKey:token',
    helpText: 'Get your API key at trello.com/app-key, then click "Token" to generate a token. Combine as "apiKey:token".',
  },
  wrike: {
    label: 'Wrike',
    placeholder: 'Personal Access Token',
    helpText: 'Generate at: Wrike → Profile → Apps & Integrations → API → Create permanent token',
  },
};

export default function ConnectSource({ onConnected }: Props) {
  const [platform, setPlatform] = useState<SourcePlatform>('asana');
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;

    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/source/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, token: token.trim() }),
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

  const config = PLATFORMS[platform];

  return (
    <div className="step-panel">
      <h2 className="step-title">Connect Your Source</h2>
      <p className="step-desc">
        Connect to the platform you want to migrate from. Your credentials are used only to read
        project data for the estimate and are never stored beyond your session.
      </p>

      <form onSubmit={handleConnect}>
        <div className="field-group">
          <label htmlFor="platform">Source platform</label>
          <select
            id="platform"
            value={platform}
            onChange={(e) => {
              setPlatform(e.target.value as SourcePlatform);
              setToken('');
              setError('');
            }}
          >
            {(Object.keys(PLATFORMS) as SourcePlatform[]).map((p) => (
              <option key={p} value={p}>{PLATFORMS[p].label}</option>
            ))}
          </select>
        </div>

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

        {error && <p className="error-text">{error}</p>}

        <div className="step-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={loading || !token.trim()}
          >
            {loading ? 'Connecting…' : `Connect to ${config.label}`}
          </button>
        </div>
      </form>
    </div>
  );
}
