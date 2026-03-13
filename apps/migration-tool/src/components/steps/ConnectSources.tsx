import { useState } from 'react';
import type { AppState } from '../../App.tsx';
import type { SourcePlatform } from '../../types/index.ts';

interface Props {
  state: AppState;
  onSourceConnected: (platform: SourcePlatform, workspaceName: string) => void;
  onDestConnected: (workspaceGid: string, workspaceName: string) => void;
  onNext: () => void;
}

export default function ConnectSources({ state, onSourceConnected, onDestConnected, onNext }: Props) {
  const [sourcePlatform, setSourcePlatform] = useState<SourcePlatform>(state.sourcePlatform ?? 'monday');
  const [sourceToken, setSourceToken] = useState('');
  const [destToken, setDestToken] = useState('');
  const [sourceLoading, setSourceLoading] = useState(false);
  const [destLoading, setDestLoading] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [destError, setDestError] = useState('');

  async function connectSource() {
    if (!sourceToken.trim()) return;
    setSourceLoading(true);
    setSourceError('');
    try {
      const res = await fetch('/api/source/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: sourcePlatform, token: sourceToken.trim() }),
      });
      const data = await res.json() as { ok?: boolean; workspaceName?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Connection failed');
      onSourceConnected(sourcePlatform, data.workspaceName ?? sourcePlatform);
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setSourceLoading(false);
    }
  }

  async function connectDest() {
    if (!destToken.trim()) return;
    setDestLoading(true);
    setDestError('');
    try {
      const res = await fetch('/api/destination/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: destToken.trim() }),
      });
      const data = await res.json() as { ok?: boolean; workspaceGid?: string; workspaceName?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Connection failed');
      onDestConnected(data.workspaceGid!, data.workspaceName!);
    } catch (err) {
      setDestError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setDestLoading(false);
    }
  }

  const canProceed = state.sourceConnected && state.destConnected;

  return (
    <div className="step-panel">
      <h2 className="step-title">Connect Source &amp; Destination</h2>
      <p className="step-desc">Enter API tokens for your source platform and the target Asana workspace. These are saved for the duration of your session.</p>

      <div className="connect-grid">
        {/* Source */}
        <div className={`connect-card ${state.sourceConnected ? 'connected' : ''}`}>
          <div className="connect-card-header">
            <h3>Source Platform</h3>
            {state.sourceConnected && (
              <span className="badge badge-success">Connected — {state.sourceWorkspaceName}</span>
            )}
          </div>

          {!state.sourceConnected && (
            <>
              <div className="field-group">
                <label htmlFor="source-platform">Platform</label>
                <select
                  id="source-platform"
                  value={sourcePlatform}
                  onChange={(e) => setSourcePlatform(e.target.value as SourcePlatform)}
                >
                  <option value="monday">Monday.com</option>
                  <option value="trello">Trello (coming soon)</option>
                </select>
              </div>
              <div className="field-group">
                <label htmlFor="source-token">
                  {sourcePlatform === 'trello' ? 'API Key & Token' : 'API Token'}
                </label>
                <input
                  id="source-token"
                  type="password"
                  placeholder={
                    sourcePlatform === 'monday'
                      ? 'Monday.com API token'
                      : 'apiKey:token  (get both from trello.com/app-key)'
                  }
                  value={sourceToken}
                  onChange={(e) => setSourceToken(e.target.value)}
                  autoComplete="off"
                />
                {sourcePlatform === 'trello' && (
                  <p className="field-hint">
                    Paste your API key and token separated by a colon, e.g. <code>abc123:xyz789</code>
                  </p>
                )}
              </div>
              {sourceError && <p className="error-text">{sourceError}</p>}
              <button
                className="btn btn-primary"
                onClick={connectSource}
                disabled={!sourceToken.trim() || sourceLoading}
              >
                {sourceLoading ? 'Connecting…' : 'Connect Source'}
              </button>
            </>
          )}
        </div>

        {/* Destination */}
        <div className={`connect-card ${state.destConnected ? 'connected' : ''}`}>
          <div className="connect-card-header">
            <h3>Destination Asana</h3>
            {state.destConnected && (
              <span className="badge badge-success">Connected — {state.destWorkspaceName}</span>
            )}
          </div>

          {!state.destConnected && (
            <>
              <div className="field-group">
                <label htmlFor="dest-token">Asana Personal Access Token</label>
                <input
                  id="dest-token"
                  type="password"
                  placeholder="Asana PAT"
                  value={destToken}
                  onChange={(e) => setDestToken(e.target.value)}
                  autoComplete="off"
                />
              </div>
              {destError && <p className="error-text">{destError}</p>}
              <button
                className="btn btn-primary"
                onClick={connectDest}
                disabled={!destToken.trim() || destLoading}
              >
                {destLoading ? 'Connecting…' : 'Connect Destination'}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="step-actions">
        <button className="btn btn-primary" onClick={onNext} disabled={!canProceed}>
          Continue
        </button>
      </div>
    </div>
  );
}
