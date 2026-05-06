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

export default function AnalyzeSelectProjects({ state, onSelect, onBack }: Props) {
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState('');
  const [projects, setProjects] = useState<SourceProject[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Load workspaces (optional — platforms like Monday support them)
  useEffect(() => {
    fetch('/api/source/workspaces')
      .then((r) => r.json() as Promise<Array<{ id: string; name: string }>>)
      .then((ws) => setWorkspaces(ws))
      .catch(() => { /* workspaces are optional */ });
  }, []);

  // Load projects when workspace filter changes
  useEffect(() => {
    setLoading(true);
    setError('');
    const url = selectedWorkspace
      ? `/api/source/projects?workspaceId=${encodeURIComponent(selectedWorkspace)}`
      : '/api/source/projects';
    fetch(url)
      .then((r) => r.json() as Promise<SourceProject[]>)
      .then((list) => {
        setProjects(list);
        setLoading(false);
      })
      .catch(() => {
        setError('Failed to load projects. Check your source connection.');
        setLoading(false);
      });
  }, [selectedWorkspace]);

  function toggleProject(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleAll() {
    if (checked.size === projects.length) {
      setChecked(new Set());
    } else {
      setChecked(new Set(projects.map((p) => p.id)));
    }
  }

  function handleContinue() {
    const selected = projects.filter((p) => checked.has(p.id));
    onSelect(selected);
  }

  const allChecked = projects.length > 0 && checked.size === projects.length;
  const someChecked = checked.size > 0 && !allChecked;

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
            onChange={(e) => {
              setSelectedWorkspace(e.target.value);
              setChecked(new Set());
            }}
          >
            <option value="">All workspaces</option>
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>{ws.name}</option>
            ))}
          </select>
        </div>
      )}

      {loading && <p className="loading-text">Loading projects…</p>}
      {error && <p className="error-text">{error}</p>}

      {!loading && !error && projects.length === 0 && (
        <p className="empty-text">No projects found.</p>
      )}

      {!loading && projects.length > 0 && (
        <div className="project-checklist">
          <div className="project-checklist-header">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={allChecked}
                ref={(el) => { if (el) el.indeterminate = someChecked; }}
                onChange={toggleAll}
              />
              <span>{allChecked ? 'Deselect all' : 'Select all'} ({projects.length} projects)</span>
            </label>
            {checked.size > 0 && (
              <span className="badge badge-info">{checked.size} selected</span>
            )}
          </div>

          <ul className="project-checklist-list">
            {projects.map((p) => (
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
