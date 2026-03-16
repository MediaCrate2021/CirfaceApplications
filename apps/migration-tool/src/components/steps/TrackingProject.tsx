import { useState } from 'react';

interface Props {
  destWorkspaceGid: string;
  currentGid: string | null;
  currentName: string | null;
  currentPortfolioGid: string | null;
  currentPortfolioName: string | null;
  onSet: (projectGid: string, projectName: string, portfolioGid: string | null, portfolioName: string | null) => void;
  onBack: () => void;
}

/** Extract a numeric GID from an Asana URL, or return the raw value if it's already a GID. */
function parseGid(input: string): string | null {
  const trimmed = input.trim();
  // New Asana URL format: https://app.asana.com/1/{workspace}/project/{GID}/...
  const projectNew = trimmed.match(/\/project\/(\d+)/);
  if (projectNew) return projectNew[1];
  // Legacy project URL: https://app.asana.com/0/{GID}/...
  const projectLegacy = trimmed.match(/\/0\/(\d+)/);
  if (projectLegacy) return projectLegacy[1];
  // Portfolio URLs: /portfolios/{GID} (both old and new Asana URL formats)
  const portfolio = trimmed.match(/\/portfolios?\/(\d+)/);
  if (portfolio) return portfolio[1];
  // Raw GID — digits only
  if (/^\d+$/.test(trimmed)) return trimmed;
  return null;
}

export default function TrackingProject({
  currentGid, currentName, currentPortfolioGid, currentPortfolioName, onSet, onBack,
}: Props) {
  const [projectInput, setProjectInput] = useState('');
  const [validatedProject, setValidatedProject] = useState<{ gid: string; name: string } | null>(
    currentGid && currentName ? { gid: currentGid, name: currentName } : null,
  );
  const [projectChecking, setProjectChecking] = useState(false);
  const [projectError, setProjectError] = useState('');

  const [portfolioInput, setPortfolioInput] = useState('');
  const [validatedPortfolio, setValidatedPortfolio] = useState<{ gid: string; name: string } | null>(
    currentPortfolioGid && currentPortfolioName ? { gid: currentPortfolioGid, name: currentPortfolioName } : null,
  );
  const [portfolioChecking, setPortfolioChecking] = useState(false);
  const [portfolioError, setPortfolioError] = useState('');

  const [saving, setSaving] = useState(false);

  async function handleCheckProject() {
    setProjectError('');
    const gid = parseGid(projectInput);
    if (!gid) {
      setProjectError('Could not find a project GID in that URL. Paste the full Asana project link or just the numeric GID.');
      return;
    }
    setProjectChecking(true);
    try {
      const res = await fetch(`/api/destination/project?gid=${encodeURIComponent(gid)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setProjectError(body.error ?? `Project not found or not accessible (${res.status}).`);
        setValidatedProject(null);
      } else {
        const project = await res.json() as { gid: string; name: string };
        setValidatedProject(project);
        setProjectInput('');
      }
    } catch {
      setProjectError('Failed to reach the server. Please try again.');
    } finally {
      setProjectChecking(false);
    }
  }

  async function handleCheckPortfolio() {
    setPortfolioError('');
    const gid = parseGid(portfolioInput);
    if (!gid) {
      setPortfolioError('Could not find a portfolio GID in that URL. Paste the full Asana portfolio link or just the numeric GID.');
      return;
    }
    setPortfolioChecking(true);
    try {
      const res = await fetch(`/api/destination/portfolio?gid=${encodeURIComponent(gid)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setPortfolioError(body.error ?? `Portfolio not found or not accessible (${res.status}).`);
        setValidatedPortfolio(null);
      } else {
        const portfolio = await res.json() as { gid: string; name: string };
        setValidatedPortfolio(portfolio);
        setPortfolioInput('');
      }
    } catch {
      setPortfolioError('Failed to reach the server. Please try again.');
    } finally {
      setPortfolioChecking(false);
    }
  }

  async function handleContinue() {
    if (!validatedProject) return;
    setSaving(true);
    try {
      await fetch('/api/session/tracking-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gid: validatedProject.gid, name: validatedProject.name }),
      });
      await fetch('/api/session/tracking-portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          validatedPortfolio
            ? { gid: validatedPortfolio.gid, name: validatedPortfolio.name }
            : { gid: null, name: null },
        ),
      });
      onSet(
        validatedProject.gid,
        validatedProject.name,
        validatedPortfolio?.gid ?? null,
        validatedPortfolio?.name ?? null,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="step-panel">
      <h2 className="step-title">Migration Tracking</h2>
      <p className="step-desc">
        Set up where migration reports are saved. The tracking project is required; the portfolio is optional
        and will have each migrated project added to it automatically.
      </p>

      {/* Tracking project */}
      <div className="field-group">
        <label>Tracking Project <span className="required-star">*</span></label>
        <p className="field-hint">Reports are saved as tasks in this Asana project.</p>

        {validatedProject ? (
          <div className="validated-project">
            <span className="validated-icon">✓</span>
            <span className="validated-name">{validatedProject.name}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => setValidatedProject(null)}>Change</button>
          </div>
        ) : (
          <>
            <div className="input-with-button">
              <input
                type="text"
                value={projectInput}
                onChange={(e) => { setProjectInput(e.target.value); setProjectError(''); }}
                onKeyDown={(e) => e.key === 'Enter' && !projectChecking && projectInput.trim() && handleCheckProject()}
                placeholder="https://app.asana.com/0/1234567890/list  or  1234567890"
                disabled={projectChecking}
                autoComplete="off"
              />
              <button
                className="btn btn-primary"
                onClick={handleCheckProject}
                disabled={!projectInput.trim() || projectChecking}
              >
                {projectChecking ? 'Checking…' : 'Check'}
              </button>
            </div>
            {projectError && <p className="error-text">{projectError}</p>}
          </>
        )}
      </div>

      {/* Tracking portfolio (optional) */}
      <div className="field-group">
        <label>Tracking Portfolio <span className="muted-text">(optional)</span></label>
        <p className="field-hint">Each migrated project will be added to this portfolio.</p>

        {validatedPortfolio ? (
          <div className="validated-project">
            <span className="validated-icon">✓</span>
            <span className="validated-name">{validatedPortfolio.name}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => setValidatedPortfolio(null)}>Change</button>
          </div>
        ) : (
          <>
            <div className="input-with-button">
              <input
                type="text"
                value={portfolioInput}
                onChange={(e) => { setPortfolioInput(e.target.value); setPortfolioError(''); }}
                onKeyDown={(e) => e.key === 'Enter' && !portfolioChecking && portfolioInput.trim() && handleCheckPortfolio()}
                placeholder="https://app.asana.com/0/{workspace}/portfolios/1234567890  or  1234567890"
                disabled={portfolioChecking}
                autoComplete="off"
              />
              <button
                className="btn btn-primary"
                onClick={handleCheckPortfolio}
                disabled={!portfolioInput.trim() || portfolioChecking}
              >
                {portfolioChecking ? 'Checking…' : 'Check'}
              </button>
            </div>
            {portfolioError && <p className="error-text">{portfolioError}</p>}
          </>
        )}
      </div>

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={onBack}>Back</button>
        <button className="btn btn-primary" onClick={handleContinue} disabled={!validatedProject || saving}>
          {saving ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
