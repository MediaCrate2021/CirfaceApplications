//-------------------------//
// SelectProjects.tsx
// Multi-select project/board picker with optional workspace filter.
//-------------------------//

import { useEffect, useState } from 'react';
import type { SourcePlatform } from '@cirface/core/types';

interface SourceProject {
  id: string;
  name: string;
  ownerName?: string;
  startDate?: string;
  endDate?: string;
  archived?: boolean;
}

interface Props {
  platform: SourcePlatform;
  onSelect: (projects: Array<{ id: string; name: string }>) => void;
  onBack: () => void;
}

const PLATFORM_LABELS: Record<SourcePlatform, string> = {
  asana: 'Asana',
  monday: 'Monday.com',
  smartsheet: 'Smartsheet',
  trello: 'Trello',
  wrike: 'Wrike',
  workfront: 'Workfront',
};

const PROJECT_NOUN: Record<SourcePlatform, string> = {
  asana: 'project',
  monday: 'board',
  smartsheet: 'sheet',
  trello: 'board',
  wrike: 'project',
  workfront: 'project',
};

export default function SelectProjects({ platform, onSelect, onBack }: Props) {
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState('');
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedTeam, setSelectedTeam] = useState('');
  const [teamsLoaded, setTeamsLoaded] = useState(false);
  const [portfolios, setPortfolios] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedPortfolio, setSelectedPortfolio] = useState('');
  const [portfoliosLoaded, setPortfoliosLoaded] = useState(false);
  const [projects, setProjects] = useState<SourceProject[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [includeArchived, setIncludeArchived] = useState(false);

  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/source/workspaces')
      .then((r) => r.json() as Promise<Array<{ id: string; name: string }>>)
      .then((ws) => {
        setWorkspaces(ws);
        if (ws.length > 0) setSelectedWorkspace(ws[0].id);
      })
      .catch(() => { /* workspaces are optional */ });
  }, []);

  useEffect(() => {
    const url = selectedWorkspace
      ? `/api/source/teams?workspaceId=${selectedWorkspace}`
      : '/api/source/teams';
    setTeamsLoaded(false);
    fetch(url)
      .then((r) => r.json() as Promise<Array<{ id: string; name: string }>>)
      .then((ts) => { setTeams(ts); setTeamsLoaded(true); })
      .catch(() => { setTeamsLoaded(true); });
    setSelectedTeam('');
  }, [selectedWorkspace]);

  // Portfolios are Asana-only — fetch alongside teams when workspace changes
  useEffect(() => {
    if (platform !== 'asana') { setPortfoliosLoaded(true); return; }
    setPortfoliosLoaded(false);
    const url = selectedWorkspace
      ? `/api/source/portfolios?workspaceId=${selectedWorkspace}`
      : '/api/source/portfolios';
    fetch(url)
      .then((r) => r.json() as Promise<Array<{ id: string; name: string }>>)
      .then((ps) => { setPortfolios(ps); setPortfoliosLoaded(true); })
      .catch(() => { setPortfoliosLoaded(true); });
    setSelectedPortfolio('');
  }, [platform, selectedWorkspace]);

  useEffect(() => {
    if (workspaces.length > 0 && !selectedWorkspace) return;
    if (!teamsLoaded) return;
    if (!portfoliosLoaded) return;
    // For Asana, require at least one filter; for other platforms keep existing team-required behaviour
    if (platform === 'asana') {
      if (!selectedTeam && !selectedPortfolio) { setProjects([]); return; }
    } else {
      if (teams.length > 0 && !selectedTeam) return;
    }
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    if (selectedWorkspace)  params.set('workspaceId', selectedWorkspace);
    if (selectedTeam)       params.set('teamId', selectedTeam);
    if (selectedPortfolio)  params.set('portfolioId', selectedPortfolio);
    if (includeArchived)    params.set('includeArchived', 'true');
    fetch(`/api/source/projects?${params}`)
      .then((r) => r.json() as Promise<SourceProject[]>)
      .then((list) => { setProjects(list); setLoading(false); })
      .catch(() => {
        setError(`Failed to load ${PROJECT_NOUN[platform]}s. Check your source connection.`);
        setLoading(false);
      });
  }, [workspaces.length, teamsLoaded, portfoliosLoaded, teams.length, selectedWorkspace, selectedTeam, selectedPortfolio, includeArchived, platform]);

  const filtered = [...projects]
    .filter((p) => !search.trim() || p.name.toLowerCase().includes(search.toLowerCase().trim()))
    .sort((a, b) => a.name.localeCompare(b.name));

  const allChecked = filtered.length > 0 && filtered.every((p) => checked.has(p.id));
  const someChecked = filtered.some((p) => checked.has(p.id)) && !allChecked;

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allChecked) {
      setChecked((prev) => {
        const next = new Set(prev);
        filtered.forEach((p) => next.delete(p.id));
        return next;
      });
    } else {
      setChecked((prev) => {
        const next = new Set(prev);
        filtered.forEach((p) => next.add(p.id));
        return next;
      });
    }
  }

  function handleContinue() {
    const selected = projects.filter((p) => checked.has(p.id));
    onSelect(selected);
  }

  const noun = PROJECT_NOUN[platform];

  function formatDate(iso: string) {
    const [y, m, d] = iso.split('-');
    return `${parseInt(m)}/${parseInt(d)}/${y}`;
  }
  const label = PLATFORM_LABELS[platform];

  return (
    <div className="step-panel">
      <h2 className="step-title">Select {label} {noun.charAt(0).toUpperCase() + noun.slice(1)}s</h2>
      <p className="step-desc">
        Choose one or more {noun}s to analyze. The estimator will fetch the full content and
        generate a detailed report showing tasks, fields, comments, and attachments.
      </p>

      <div className="notice-box">
        <span>&#9432;</span>
        Your report will automatically be shared with Cirface as soon as it is complete, and will also be available for download.
        Archived {noun}s are hidden by default.
      </div>

      {workspaces.length > 0 && (
        <div className="field-group" style={{ maxWidth: '360px', marginBottom: '20px' }}>
          <label htmlFor="workspace-filter">Filter by workspace</label>
          <select
            id="workspace-filter"
            value={selectedWorkspace}
            onChange={(e) => { setSelectedWorkspace(e.target.value); setSelectedTeam(''); setSelectedPortfolio(''); setChecked(new Set()); }}
          >
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>{ws.name}</option>
            ))}
          </select>
        </div>
      )}

      {teams.length > 0 && (
        <div className="field-group" style={{ maxWidth: '360px', marginBottom: '20px' }}>
          <label htmlFor="team-filter">Filter by team</label>
          <select
            id="team-filter"
            value={selectedTeam}
            onChange={(e) => { setSelectedTeam(e.target.value); setChecked(new Set()); }}
          >
            <option value="">— select a team —</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
      )}

      {platform === 'asana' && portfolios.length > 0 && (
        <div className="field-group" style={{ maxWidth: '360px', marginBottom: '20px' }}>
          <label htmlFor="portfolio-filter">Filter by portfolio</label>
          <select
            id="portfolio-filter"
            value={selectedPortfolio}
            onChange={(e) => { setSelectedPortfolio(e.target.value); setChecked(new Set()); }}
          >
            <option value="">— select a portfolio —</option>
            {portfolios.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      )}

      {platform === 'asana' && (
        <div style={{ marginBottom: '16px' }}>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => { setIncludeArchived(e.target.checked); setChecked(new Set()); }}
            />
            <span>Include archived {noun}s</span>
          </label>
        </div>
      )}

      {!loading && projects.length > 0 && (
        <div className="field-group" style={{ maxWidth: '360px', marginBottom: '16px' }}>
          <input
            type="search"
            placeholder={`Search ${noun}s…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}

      {loading && <p className="loading-text">Loading {noun}s…</p>}
      {error && <p className="error-text">{error}</p>}
      {!loading && !error && filtered.length === 0 && (selectedTeam || selectedPortfolio || platform !== 'asana') && (
        <p className="empty-text">No {noun}s found.</p>
      )}

      {!loading && filtered.length > 0 && (
        <div className="project-checklist">
          <div className="project-checklist-header">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={allChecked}
                ref={(el) => { if (el) el.indeterminate = someChecked; }}
                onChange={toggleAll}
              />
              <span>
                {allChecked ? 'Deselect all' : 'Select all'}
                {' '}({filtered.length} {noun}{filtered.length === 1 ? '' : 's'})
              </span>
            </label>
            {checked.size > 0 && (
              <span className="badge badge-info">{checked.size} selected</span>
            )}
          </div>

          <ul className="project-checklist-list">
            {filtered.map((p) => (
              <li key={p.id} className={`project-checklist-item ${checked.has(p.id) ? 'selected' : ''}`}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={checked.has(p.id)}
                    onChange={() => toggle(p.id)}
                  />
                  <span>{p.name}</span>
                  {p.archived && <span className="badge badge-warning" style={{ marginLeft: '6px' }}>Archived</span>}
                  {p.ownerName && <span className="project-checklist-item-meta">{p.ownerName}</span>}
                  {p.startDate && <span className="project-checklist-item-meta">{formatDate(p.startDate)}{p.endDate ? ` – ${formatDate(p.endDate)}` : ''}</span>}
                  {!p.startDate && p.endDate && <span className="project-checklist-item-meta">Due {formatDate(p.endDate)}</span>}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={onBack}>Back</button>
        <button
          className="btn btn-primary"
          onClick={handleContinue}
          disabled={checked.size === 0}
        >
          Analyze {checked.size > 0
            ? `${checked.size} ${noun}${checked.size === 1 ? '' : 's'}`
            : ''}
        </button>
      </div>
    </div>
  );
}
