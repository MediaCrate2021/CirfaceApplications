import { useEffect, useState } from 'react';
import type { AppState } from '../../App.tsx';

interface SourceProject {
  id: string;
  name: string;
}

interface Props {
  state: AppState;
  onSelect: (projects: Array<{ id: string; name: string }>) => void;
  onBack: () => void;
}

export default function AnalyzeSelectProjects({ onSelect, onBack }: Props) {
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState('');
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedTeam, setSelectedTeam] = useState('');
  const [teamsLoaded, setTeamsLoaded] = useState(false);
  const [projects, setProjects] = useState<SourceProject[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Load workspaces on mount — auto-select first
  useEffect(() => {
    fetch('/api/source/workspaces')
      .then((r) => r.json() as Promise<Array<{ id: string; name: string }>>)
      .then((ws) => {
        setWorkspaces(ws);
        if (ws.length > 0) setSelectedWorkspace(ws[0].id);
      })
      .catch(() => { /* workspaces are optional */ });
  }, []);

  // Reload teams when workspace changes
  useEffect(() => {
    const url = selectedWorkspace
      ? `/api/source/teams?workspaceId=${encodeURIComponent(selectedWorkspace)}`
      : '/api/source/teams';
    setTeamsLoaded(false);
    fetch(url)
      .then((r) => r.json() as Promise<Array<{ id: string; name: string }>>)
      .then((ts) => { setTeams(ts); setTeamsLoaded(true); })
      .catch(() => { setTeamsLoaded(true); /* teams are optional */ });
    setSelectedTeam('');
  }, [selectedWorkspace]);

  // Load projects — wait for workspace and team to be selected
  useEffect(() => {
    if (workspaces.length > 0 && !selectedWorkspace) return;
    if (!teamsLoaded) return;
    if (teams.length > 0 && !selectedTeam) return;
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    if (selectedWorkspace) params.set('workspaceId', selectedWorkspace);
    if (selectedTeam) params.set('teamId', selectedTeam);
    fetch(`/api/source/projects?${params}`)
      .then((r) => r.json() as Promise<SourceProject[]>)
      .then((list) => { setProjects(list); setLoading(false); })
      .catch(() => {
        setError('Failed to load projects. Check your source connection.');
        setLoading(false);
      });
  }, [workspaces.length, teamsLoaded, teams.length, selectedWorkspace, selectedTeam]);

  function toggleProject(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }

  function toggleAll() {
    if (allChecked) {
      setChecked((prev) => { const next = new Set(prev); filtered.forEach((p) => next.delete(p.id)); return next; });
    } else {
      setChecked((prev) => { const next = new Set(prev); filtered.forEach((p) => next.add(p.id)); return next; });
    }
  }

  function handleContinue() {
    const selected = projects.filter((p) => checked.has(p.id));
    onSelect(selected);
  }

  const filtered = [...projects]
    .filter((p) => !search.trim() || p.name.toLowerCase().includes(search.toLowerCase().trim()))
    .sort((a, b) => a.name.localeCompare(b.name));

  const allChecked = filtered.length > 0 && filtered.every((p) => checked.has(p.id));
  const someChecked = filtered.some((p) => checked.has(p.id)) && !allChecked;

  return (
    <div className="step-panel">
      <h2 className="step-title">Select Projects to Analyze</h2>
      <p className="step-desc">
        Choose one or more source projects. The analysis will fetch full project data and generate a detailed report for each.
      </p>

      {workspaces.length > 0 && (
        <div className="field-group" style={{ maxWidth: '360px', marginBottom: '20px' }}>
          <label htmlFor="workspace-filter">Filter by workspace</label>
          <select
            id="workspace-filter"
            value={selectedWorkspace}
            onChange={(e) => { setSelectedWorkspace(e.target.value); setSelectedTeam(''); setChecked(new Set()); }}
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
            <option value="">— Select a team —</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
      )}

      {loading && <p className="loading-text">Loading projects…</p>}
      {error && <p className="error-text">{error}</p>}

      {!loading && !error && teams.length > 0 && !selectedTeam && (
        <p className="step-desc">Select a team to load projects.</p>
      )}

      {!loading && !error && projects.length === 0 && (teams.length === 0 || selectedTeam) && (
        <p className="empty-text">No projects found.</p>
      )}

      {!loading && projects.length > 0 && (
        <>
          <div className="field-group" style={{ maxWidth: '360px', marginBottom: '16px' }}>
            <input
              type="search"
              placeholder="Search projects…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="project-checklist">
            <div className="project-checklist-header">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={allChecked}
                  ref={(el) => { if (el) el.indeterminate = someChecked; }}
                  onChange={toggleAll}
                />
                <span>{allChecked ? 'Deselect all' : 'Select all'} ({filtered.length} project{filtered.length === 1 ? '' : 's'})</span>
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
                      onChange={() => toggleProject(p.id)}
                    />
                    <span>{p.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={onBack}>Back</button>
        <button
          className="btn btn-primary"
          onClick={handleContinue}
          disabled={checked.size === 0}
        >
          Analyze {checked.size > 0 ? `${checked.size} project${checked.size === 1 ? '' : 's'}` : ''}
        </button>
      </div>
    </div>
  );
}
