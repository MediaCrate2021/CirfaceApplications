import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../../App.tsx';

interface SourceProject { id: string; name: string; }
interface AsanaTeam    { gid: string; name: string; }
interface AsanaProject { gid: string; name: string; }

interface Props {
  state: AppState;
  onSelect: (sourceId: string, sourceName: string, destGid: string, destName: string, teamGid: string | null, isNew: boolean) => void;
  onBack: () => void;
}

export default function SelectProjects({ state, onSelect, onBack }: Props) {
  const [sourceProjects, setSourceProjects]   = useState<SourceProject[]>([]);
  const [teams, setTeams]                     = useState<AsanaTeam[]>([]);
  const [destProjects, setDestProjects]       = useState<AsanaProject[]>([]);
  const [selectedSource, setSelectedSource]   = useState(state.selectedSourceProjectId ?? '');
  const [destMode, setDestMode]               = useState<'existing' | 'new'>(state.isNewDestProject ? 'new' : 'existing');
  const [selectedTeamGid, setSelectedTeamGid] = useState(state.selectedDestTeamGid ?? '');
  const [newProjectName, setNewProjectName]   = useState(state.isNewDestProject ? (state.selectedDestProjectName ?? '') : '');

  // Typeahead state for existing project
  const [projectQuery, setProjectQuery]       = useState(!state.isNewDestProject ? (state.selectedDestProjectName ?? '') : '');
  const [selectedDest, setSelectedDest]       = useState(!state.isNewDestProject ? (state.selectedDestProjectGid ?? '') : '');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const typeaheadRef = useRef<HTMLDivElement>(null);

  const [loadingSource, setLoadingSource]   = useState(true);
  const [loadingTeams, setLoadingTeams]     = useState(true);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [error, setError] = useState('');

  // Load source projects and teams on mount
  useEffect(() => {
    fetch('/api/source/projects')
      .then((r) => r.json() as Promise<SourceProject[]>)
      .then((src) => { setSourceProjects([...src].sort((a, b) => a.name.localeCompare(b.name))); setLoadingSource(false); })
      .catch(() => { setError('Failed to load source projects'); setLoadingSource(false); });

    fetch('/api/destination/teams')
      .then((r) => r.json() as Promise<AsanaTeam[]>)
      .then((t) => { setTeams(t); setLoadingTeams(false); })
      .catch(() => {
        // Teams endpoint may fail for non-org workspaces — fall back to all projects
        setLoadingTeams(false);
      });
  }, []);

  // When source project changes or mode switches to 'new', default the new project name to the source name
  useEffect(() => {
    if (destMode !== 'new') return;
    const src = sourceProjects.find((p) => p.id === selectedSource);
    if (src) setNewProjectName(src.name);
  }, [selectedSource, destMode, sourceProjects]);

  // Reload destination projects when team changes
  useEffect(() => {
    setLoadingProjects(true);
    setDestProjects([]);
    setSelectedDest('');
    setProjectQuery('');

    const url = selectedTeamGid
      ? `/api/destination/projects?teamGid=${encodeURIComponent(selectedTeamGid)}`
      : '/api/destination/projects';

    fetch(url)
      .then((r) => r.json() as Promise<AsanaProject[]>)
      .then((projects) => { setDestProjects([...projects].sort((a, b) => a.name.localeCompare(b.name))); setLoadingProjects(false); })
      .catch(() => { setError('Failed to load destination projects'); setLoadingProjects(false); });
  }, [selectedTeamGid]);

  // Close suggestions when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (typeaheadRef.current && !typeaheadRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  /** Extract a GID from a raw value or either Asana URL format. */
  function extractGid(value: string): string {
    const newFormat = value.match(/\/project\/(\d+)/);
    if (newFormat) return newFormat[1];
    const legacyFormat = value.match(/\/0\/(\d+)/);
    if (legacyFormat) return legacyFormat[1];
    return value.trim();
  }

  // Typeahead filtering — accepts name search, raw GID, or Asana project URL
  const resolvedQuery = extractGid(projectQuery);
  const filteredProjects = projectQuery.trim()
    ? destProjects.filter((p) =>
        p.name.toLowerCase().includes(projectQuery.toLowerCase()) ||
        p.gid === resolvedQuery,
      )
    : destProjects;

  function handleProjectQueryChange(value: string) {
    setProjectQuery(value);
    setSelectedDest('');
    setShowSuggestions(true);

    // If the pasted value resolves to a known GID, auto-select it
    const gid = extractGid(value);
    const exactGid = destProjects.find((p) => p.gid === gid);
    if (exactGid) {
      setSelectedDest(exactGid.gid);
      setProjectQuery(exactGid.name);
      setShowSuggestions(false);
    }
  }

  function selectProject(project: AsanaProject) {
    setSelectedDest(project.gid);
    setProjectQuery(project.name);
    setShowSuggestions(false);
  }

  function handleContinue() {
    const srcProject = sourceProjects.find((p) => p.id === selectedSource);
    if (!srcProject) return;

    const teamGid = selectedTeamGid || null;

    if (destMode === 'new') {
      onSelect(srcProject.id, srcProject.name, '', newProjectName.trim(), teamGid, true);
    } else {
      const destProject = destProjects.find((p) => p.gid === selectedDest);
      if (!destProject) return;
      onSelect(srcProject.id, srcProject.name, destProject.gid, destProject.name, teamGid, false);
    }
  }

  const loading = loadingSource || loadingTeams;
  const canProceed = !!selectedSource && (
    destMode === 'new' ? !!newProjectName.trim() : !!selectedDest
  );

  return (
    <div className="step-panel">
      <h2 className="step-title">Select Projects</h2>
      <p className="step-desc">Choose which source project to migrate and where it will land in Asana.</p>

      {loading && <p className="loading-text">Loading…</p>}
      {error && <p className="error-text">{error}</p>}

      {!loading && !error && (
        <>
          {/* Source project */}
          <div className="field-group">
            <label htmlFor="source-project">
              Source Project ({state.sourcePlatform === 'monday' ? 'Monday.com board' : 'Trello board'})
            </label>
            <select
              id="source-project"
              value={selectedSource}
              onChange={(e) => setSelectedSource(e.target.value)}
            >
              <option value="">— Select a project —</option>
              {sourceProjects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Asana team filter */}
          {teams.length > 0 && (
            <div className="field-group">
              <label htmlFor="dest-team">Asana Team <span className="field-hint-inline">(filters project list)</span></label>
              <select
                id="dest-team"
                value={selectedTeamGid}
                onChange={(e) => setSelectedTeamGid(e.target.value)}
              >
                <option value="">— All teams —</option>
                {teams.map((t) => (
                  <option key={t.gid} value={t.gid}>{t.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Destination mode */}
          <div className="field-group">
            <label>Destination</label>
            <div className="radio-group">
              <label className="radio-label">
                <input type="radio" name="dest-mode" value="new"
                  checked={destMode === 'new'} onChange={() => setDestMode('new')} />
                Create new Asana project
              </label>
              <label className="radio-label">
                <input type="radio" name="dest-mode" value="existing"
                  checked={destMode === 'existing'} onChange={() => setDestMode('existing')} />
                Migrate to existing project
              </label>
            </div>
          </div>

          {destMode === 'new' && (
            <div className="field-group">
              <label htmlFor="new-project-name">New Project Name</label>
              <input
                id="new-project-name"
                type="text"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="Enter project name"
              />
            </div>
          )}

          {destMode === 'existing' && (
            <div className="field-group">
              <label htmlFor="dest-project-search">
                Destination Asana Project
                <span className="label-warning"> — tasks will be added to this project</span>
              </label>
              <div className="typeahead-wrapper" ref={typeaheadRef}>
                <input
                  id="dest-project-search"
                  type="text"
                  value={projectQuery}
                  onChange={(e) => handleProjectQueryChange(e.target.value)}
                  onFocus={() => setShowSuggestions(true)}
                  placeholder={loadingProjects ? 'Loading projects…' : 'Search by name or paste project GID…'}
                  disabled={loadingProjects}
                  autoComplete="off"
                />
                {showSuggestions && filteredProjects.length > 0 && (
                  <ul className="typeahead-list">
                    {filteredProjects.slice(0, 20).map((p) => (
                      <li
                        key={p.gid}
                        className={`typeahead-item ${p.gid === selectedDest ? 'selected' : ''}`}
                        onMouseDown={() => selectProject(p)}
                      >
                        <span className="typeahead-name">{p.name}</span>
                        <span className="typeahead-gid">{p.gid}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {showSuggestions && projectQuery && filteredProjects.length === 0 && !loadingProjects && (
                  <div className="typeahead-empty">No projects match</div>
                )}
              </div>
              {selectedDest && (
                <p className="warning-banner">Tasks will be added to an existing project. This cannot be undone.</p>
              )}
            </div>
          )}
        </>
      )}

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={onBack}>Back</button>
        <button className="btn btn-primary" onClick={handleContinue} disabled={!canProceed}>
          Continue
        </button>
      </div>
    </div>
  );
}
