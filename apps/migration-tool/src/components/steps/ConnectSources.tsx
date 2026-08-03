import { useState } from 'react';
import type { AppMode, AppState } from '../../App.tsx';
import type { SourcePlatform } from '@cirface/core/types';

interface Props {
  state: AppState;
  onModeChange: (mode: AppMode) => void;
  onSourceConnected: (platform: SourcePlatform, workspaceName: string) => void;
  onDestConnected: (workspaceGid: string, workspaceName: string) => void;
  onNext: () => void;
}

export default function ConnectSources({ state, onModeChange, onSourceConnected, onDestConnected, onNext }: Props) {
  const [sourcePlatform, setSourcePlatform] = useState<SourcePlatform>(state.sourcePlatform ?? 'monday');
  const [sourceToken, setSourceToken] = useState('');
  // WorkFront uses two separate fields combined as "apiKey:domain"
  const [wfApiKey, setWfApiKey] = useState('');
  const [wfDomain, setWfDomain] = useState('');
  const [destToken, setDestToken] = useState('');
  const [sourceLoading, setSourceLoading] = useState(false);
  const [destLoading, setDestLoading] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [destError, setDestError] = useState('');

  async function connectSource() {
    const combinedToken = sourcePlatform === 'workfront'
      ? `${wfApiKey.trim()}:${wfDomain.trim()}`
      : sourceToken.trim();
    if (!combinedToken || combinedToken === ':') return;
    setSourceLoading(true);
    setSourceError('');
    try {
      const res = await fetch('/api/source/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: sourcePlatform, token: combinedToken }),
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
  const isAnalyze = state.mode === 'analyze';

  return (
    <div className="step-panel">
      <h2 className="step-title">Connect Source &amp; Destination</h2>
      <p className="step-desc">Enter API tokens for your source platform and the target Asana workspace. These are saved for the duration of your session.</p>

      {/* Mode toggle */}
      <div className="mode-toggle field-group">
        <label>Mode</label>
        <div className="radio-group">
          <label className="radio-label">
            <input
              type="radio"
              name="app-mode"
              value="migrate"
              checked={state.mode === 'migrate'}
              onChange={() => onModeChange('migrate')}
            />
            <span>Migrate — move data from source to Asana</span>
          </label>
          <label className="radio-label">
            <input
              type="radio"
              name="app-mode"
              value="analyze"
              checked={state.mode === 'analyze'}
              onChange={() => onModeChange('analyze')}
            />
            <span>Analyze only — inspect source projects and generate a report</span>
          </label>
        </div>
      </div>

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
                  onChange={(e) => { setSourcePlatform(e.target.value as SourcePlatform); setSourceToken(''); setWfApiKey(''); setWfDomain(''); setSourceError(''); }}
                >
                  <option value="asana">Asana</option>
                  <option value="monday">Monday.com</option>
                  <option value="smartsheet">Smartsheet</option>
                  <option value="trello">Trello</option>
                  <option value="wrike">Wrike</option>
                  <option value="workfront">WorkFront</option>
                </select>
              </div>
              {sourcePlatform === 'workfront' ? (
                <>
                  <div className="field-group">
                    <label htmlFor="wf-domain">
                      WorkFront domain
                      <a
                        className="info-icon"
                        href="https://experienceleague.adobe.com/docs/workfront/using/adobe-workfront-api/api-general-information/api-basics.html"
                        target="_blank"
                        rel="noopener noreferrer"
                        data-tooltip="How to get your WorkFront API key"
                      >i</a>
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <input
                        id="wf-domain"
                        type="text"
                        placeholder="mycompany"
                        value={wfDomain}
                        onChange={(e) => { setWfDomain(e.target.value); setSourceError(''); }}
                        autoComplete="off"
                        style={{ flex: 1 }}
                      />
                      <span className="field-hint" style={{ whiteSpace: 'nowrap', margin: 0 }}>.my.workfront.com</span>
                    </div>
                    <p className="field-hint">The subdomain of your WorkFront instance.</p>
                  </div>
                  <div className="field-group">
                    <label htmlFor="wf-apikey">API key</label>
                    <input
                      id="wf-apikey"
                      type="password"
                      placeholder="WorkFront API key"
                      value={wfApiKey}
                      onChange={(e) => { setWfApiKey(e.target.value); setSourceError(''); }}
                      autoComplete="off"
                    />
                    <p className="field-hint">Find your API key in WorkFront: Setup → System → Customer Info.</p>
                  </div>
                </>
              ) : (
                <div className="field-group">
                  <label htmlFor="source-token">
                    {sourcePlatform === 'trello' ? 'API Key & Token' : 'API Token'}
                    {sourcePlatform === 'monday' && (
                      <a
                        className="info-icon"
                        href="https://developer.monday.com/apps/docs/mondaycode"
                        target="_blank"
                        rel="noopener noreferrer"
                        data-tooltip="How to get your Monday.com API token"
                      >i</a>
                    )}
                    {sourcePlatform === 'smartsheet' && (
                      <a
                        className="info-icon"
                        href="https://help.smartsheet.com/articles/2482389-generate-api-key"
                        target="_blank"
                        rel="noopener noreferrer"
                        data-tooltip="How to generate a Smartsheet API key"
                      >i</a>
                    )}
                    {sourcePlatform === 'trello' && (
                      <a
                        className="info-icon"
                        href="https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/"
                        target="_blank"
                        rel="noopener noreferrer"
                        data-tooltip="How to get your Trello API key & token"
                      >i</a>
                    )}
                    {sourcePlatform === 'wrike' && (
                      <a
                        className="info-icon"
                        href="https://help.wrike.com/hc/en-us/articles/210146065-Wrike-API"
                        target="_blank"
                        rel="noopener noreferrer"
                        data-tooltip="How to create a Wrike permanent access token"
                      >i</a>
                    )}
                  </label>
                  <input
                    id="source-token"
                    type="password"
                    placeholder={
                      sourcePlatform === 'monday'      ? 'Monday.com API token'
                      : sourcePlatform === 'smartsheet' ? 'Smartsheet Personal Access Token'
                      : sourcePlatform === 'wrike'      ? 'Wrike permanent access token'
                      : 'apiKey:token'
                    }
                    value={sourceToken}
                    onChange={(e) => setSourceToken(e.target.value)}
                    autoComplete="off"
                  />
                  {sourcePlatform === 'trello' && (
                    <p className="field-hint">Paste your API key and token separated by a colon: <code>apiKey:token</code></p>
                  )}
                  {sourcePlatform === 'wrike' && (
                    <p className="field-hint">Generate a permanent token in Wrike: Profile menu &gt; Apps &amp; Integrations &gt; API &gt; Create permanent token</p>
                  )}
                </div>
              )}
              {sourceError && <p className="error-text">{sourceError}</p>}
              <button
                className="btn btn-primary"
                onClick={connectSource}
                disabled={sourcePlatform === 'workfront' ? (!wfApiKey.trim() || !wfDomain.trim() || sourceLoading) : (!sourceToken.trim() || sourceLoading)}
              >
                {sourceLoading ? 'Connecting…' : 'Connect Source'}
              </button>
            </>
          )}
        </div>

        {/* Destination */}
        <div className={`connect-card ${state.destConnected ? 'connected' : ''}`}>
          <div className="connect-card-header">
            <h3>{isAnalyze ? 'Asana (for report)' : 'Destination Asana'}</h3>
            {state.destConnected && (
              <span className="badge badge-success">Connected — {state.destWorkspaceName}</span>
            )}
          </div>

          {isAnalyze && !state.destConnected && (
            <p className="field-hint" style={{ marginBottom: '12px' }}>
              Your analysis report will be saved as a task in a tracking project. Enter your Asana PAT to enable this.
            </p>
          )}

          {!state.destConnected && (
            <>
              <div className="field-group">
                <label htmlFor="dest-token">
                  Asana Personal Access Token
                  <a
                    className="info-icon"
                    href="https://developers.asana.com/docs/personal-access-token"
                    target="_blank"
                    rel="noopener noreferrer"
                    data-tooltip="How to create an Asana Personal Access Token"
                  >i</a>
                </label>
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
                {destLoading ? 'Connecting…' : 'Connect Asana'}
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
