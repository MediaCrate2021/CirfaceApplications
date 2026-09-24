import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../../App.tsx';

interface SourceProject { id: string; name: string; }
interface AsanaTeam    { gid: string; name: string; }
interface AsanaProject { gid: string; name: string; }

interface Props {
  state: AppState;
  onSelect: (sourceId: string, sourceName: string, destGid: string, destName: string, teamGid: string | null, teamName: string | null, isNew: boolean, ownerGid: string | null, ownerName: string | null, destWorkspaceGid: string, destWorkspaceName: string) => void;
  onBack: () => void;
}

// ---------------------------------------------------------------------------
// Page cache — avoids re-fetching project/team lists when navigating back
// ---------------------------------------------------------------------------

interface SpCache {
  sourcePlatform: string;
  sourceWorkspaceName: string;
  sourceWorkspaces: Array<{ id: string; name: string }>;
  selectedSourceWorkspace: string;
  sourceTeams: Array<{ id: string; name: string }>;
  selectedSourceTeam: string;
  sourceProjects: Array<{ id: string; name: string }>;
  includeArchived: boolean;
  destWorkspaces: Array<{ id: string; name: string }>;
  selectedDestWorkspaceGid: string;
  destTeams: Array<{ gid: string; name: string }>;
  selectedTeamGid: string;
  destProjects: Array<{ gid: string; name: string }>;
}

const SP_CACHE_KEY = 'sp_cache';

function readSpCache(): SpCache | null {
  try {
    const raw = sessionStorage.getItem(SP_CACHE_KEY);
    return raw ? JSON.parse(raw) as SpCache : null;
  } catch { return null; }
}

function writeSpCache(data: SpCache): void {
  try { sessionStorage.setItem(SP_CACHE_KEY, JSON.stringify(data)); } catch {}
}

function clearSpCache(): void {
  try { sessionStorage.removeItem(SP_CACHE_KEY); } catch {}
}

// ---------------------------------------------------------------------------

export default function SelectProjects({ state, onSelect, onBack }: Props) {
  // Read and validate cache once at init — discard if the source connection changed
  const [cache] = useState<SpCache | null>(() => {
    const raw = readSpCache();
    if (!raw) return null;
    if (raw.sourcePlatform !== (state.sourcePlatform ?? '') ||
        raw.sourceWorkspaceName !== (state.sourceWorkspaceName ?? '')) return null;
    return raw;
  });

  // Mutable ref tracks full cache payload so incremental updates are cheap
  const cacheRef = useRef<SpCache>(cache ?? {
    sourcePlatform:          state.sourcePlatform ?? '',
    sourceWorkspaceName:     state.sourceWorkspaceName ?? '',
    sourceWorkspaces:        [],
    selectedSourceWorkspace: '',
    sourceTeams:             [],
    selectedSourceTeam:      '',
    sourceProjects:          [],
    includeArchived:         false,
    destWorkspaces:          [],
    selectedDestWorkspaceGid: state.destWorkspaceGid ?? '',
    destTeams:               [],
    selectedTeamGid:         state.selectedDestTeamGid ?? '',
    destProjects:            [],
  });

  function updateCache(partial: Partial<SpCache>): void {
    cacheRef.current = { ...cacheRef.current, ...partial };
    writeSpCache(cacheRef.current);
  }

  // One-time skip flags — prevent re-fetching on mount when cache is available.
  // Each flag is cleared after its first skip so filter changes still trigger fetches.
  const skips = useRef({
    workspaces:     !!cache,
    sourceTeams:    !!cache,
    sourceProjects: !!cache,
    destTeams:      !!cache,
    destProjects:   !!cache,
  });

  const [sourceWorkspaces, setSourceWorkspaces] = useState<Array<{ id: string; name: string }>>(cache?.sourceWorkspaces ?? []);
  const [selectedSourceWorkspace, setSelectedSourceWorkspace] = useState(cache?.selectedSourceWorkspace ?? '');
  const [sourceTeams, setSourceTeams] = useState<Array<{ id: string; name: string }>>(cache?.sourceTeams ?? []);
  const [selectedSourceTeam, setSelectedSourceTeam] = useState(cache?.selectedSourceTeam ?? '');
  const [sourceProjects, setSourceProjects]   = useState<SourceProject[]>(cache?.sourceProjects ?? []);
  const [destWorkspaces, setDestWorkspaces]   = useState<Array<{ id: string; name: string }>>(cache?.destWorkspaces ?? []);
  const [selectedDestWorkspaceGid, setSelectedDestWorkspaceGid] = useState(cache?.selectedDestWorkspaceGid ?? state.destWorkspaceGid ?? '');
  const [destWorkspaceVersion, setDestWorkspaceVersion] = useState(0);
  const [teams, setTeams]                     = useState<AsanaTeam[]>(cache?.destTeams ?? []);
  const [destProjects, setDestProjects]       = useState<AsanaProject[]>(cache?.destProjects ?? []);
  const [selectedSource, setSelectedSource]   = useState(state.selectedSourceProjectId ?? '');
  const [destMode, setDestMode]               = useState<'existing' | 'new'>(state.isNewDestProject ? 'new' : 'existing');
  const [selectedTeamGid, setSelectedTeamGid] = useState(cache?.selectedTeamGid ?? state.selectedDestTeamGid ?? '');
  const [newProjectName, setNewProjectName]   = useState(state.isNewDestProject ? (state.selectedDestProjectName ?? '') : '');

  // Project owner (new projects only)
  const [ownerInput, setOwnerInput]           = useState('');
  const [validatedOwner, setValidatedOwner]   = useState<{ gid: string; name: string } | null>(
    state.projectOwnerGid && state.projectOwnerName ? { gid: state.projectOwnerGid, name: state.projectOwnerName } : null,
  );
  const [ownerChecking, setOwnerChecking]     = useState(false);
  const [ownerError, setOwnerError]           = useState('');

  // Typeahead state for existing project
  const [projectQuery, setProjectQuery]       = useState(!state.isNewDestProject ? (state.selectedDestProjectName ?? '') : '');
  const [selectedDest, setSelectedDest]       = useState(!state.isNewDestProject ? (state.selectedDestProjectGid ?? '') : '');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const typeaheadRef = useRef<HTMLDivElement>(null);

  const [loadingSource, setLoadingSource]   = useState(false);
  const [loadingTeams, setLoadingTeams]     = useState(!cache); // false when restored from cache
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [error, setError] = useState('');
  const [reloadCount, setReloadCount] = useState(0);

  const [sourceSearch, setSourceSearch]     = useState('');
  const [includeArchived, setIncludeArchived] = useState(cache?.includeArchived ?? false);

  // Smartsheet manual ID / link entry
  const [sheetIdInput, setSheetIdInput]     = useState('');
  const [sheetIdLookup, setSheetIdLookup]   = useState(false);
  const [sheetIdError, setSheetIdError]     = useState('');

  /** Extract a project ID from a pasted URL or raw ID. */
  function extractSheetId(value: string): string {
    // Smartsheet: /sheets/{id}
    const ssUrl = value.match(/\/sheets\/([^/?&#]+)/);
    if (ssUrl) return ssUrl[1];
    // Workfront: ?ID={id} (capital — must check before lowercase Wrike pattern)
    const wfUrl = value.match(/[?&]ID=([^&]+)/);
    if (wfUrl) return wfUrl[1];
    // Wrike: ?id={id}
    const wrikeUrl = value.match(/[?&]id=([^&]+)/);
    if (wrikeUrl) return wrikeUrl[1];
    return value.trim();
  }

  async function handleSheetIdLookup() {
    const id = extractSheetId(sheetIdInput);
    if (!id) return;
    setSheetIdError('');
    setSheetIdLookup(true);
    try {
      const res = await fetch(`/api/source/project-info?projectId=${encodeURIComponent(id)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setSheetIdError(body.error ?? `Sheet not found (${res.status})`);
        return;
      }
      const info = await res.json() as { id: string; name: string };
      // Inject into the source list so the existing continue flow works unchanged
      setSourceProjects((prev) => {
        if (prev.some((p) => p.id === info.id)) return prev;
        return [...prev, info];
      });
      setSelectedSource(info.id);
      setSheetIdInput('');
    } catch {
      setSheetIdError('Failed to reach the server. Please try again.');
    } finally {
      setSheetIdLookup(false);
    }
  }

  async function handleDestWorkspaceChange(gid: string) {
    const ws = destWorkspaces.find((w) => w.id === gid);
    if (!ws) return;
    setSelectedDestWorkspaceGid(gid);
    setSelectedTeamGid('');
    setSelectedDest('');
    setProjectQuery('');
    updateCache({ selectedDestWorkspaceGid: gid, selectedTeamGid: '', destProjects: [] });
    await fetch('/api/session/dest-workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceGid: ws.id, workspaceName: ws.name }),
    }).catch(() => {});
    setDestWorkspaceVersion((v) => v + 1);
  }

  function handleReload() {
    clearSpCache();
    fetch('/api/session/reset-project', { method: 'POST' }).catch(() => {});
    setSelectedSource('');
    setSelectedSourceWorkspace('');
    setSelectedSourceTeam('');
    setSelectedTeamGid('');
    setSelectedDest('');
    setProjectQuery('');
    setNewProjectName('');
    setError('');
    setReloadCount((c) => c + 1);
  }

  // Load source workspaces, destination workspaces on mount (and on reload)
  useEffect(() => {
    if (skips.current.workspaces) { skips.current.workspaces = false; return; }

    fetch('/api/source/workspaces')
      .then((r) => r.json() as Promise<Array<{ id: string; name: string }>>)
      .then((ws) => {
        setSourceWorkspaces(ws);
        updateCache({ sourceWorkspaces: ws });
        if (ws.length > 0 && !selectedSourceWorkspace) {
          setSelectedSourceWorkspace(ws[0].id);
          updateCache({ selectedSourceWorkspace: ws[0].id });
        }
      })
      .catch(() => { /* workspaces are optional — fail silently */ });

    fetch('/api/destination/workspaces')
      .then((r) => r.json() as Promise<Array<{ id: string; name: string }>>)
      .then((ws) => { setDestWorkspaces(ws); updateCache({ destWorkspaces: ws }); })
      .catch(() => { /* fail silently — workspace picker is optional */ });
  }, [reloadCount]);

  // Reload source teams when source workspace changes
  useEffect(() => {
    if (skips.current.sourceTeams) { skips.current.sourceTeams = false; return; }

    const url = selectedSourceWorkspace
      ? `/api/source/teams?workspaceId=${selectedSourceWorkspace}`
      : '/api/source/teams';
    fetch(url)
      .then((r) => r.json() as Promise<Array<{ id: string; name: string }>>)
      .then((ts) => { setSourceTeams(ts); updateCache({ sourceTeams: ts }); })
      .catch(() => { /* teams are optional */ });
    setSelectedSourceTeam('');
    updateCache({ selectedSourceTeam: '' });
  }, [selectedSourceWorkspace, reloadCount]);

  // Reload destination teams when workspace changes (or on reload)
  useEffect(() => {
    if (skips.current.destTeams) { skips.current.destTeams = false; return; }

    setLoadingTeams(true);
    fetch('/api/destination/teams')
      .then((r) => r.json() as Promise<AsanaTeam[]>)
      .then((t) => { setTeams(t); setLoadingTeams(false); updateCache({ destTeams: t }); })
      .catch(() => {
        // Teams endpoint may fail for non-org workspaces — fall back to all projects
        setLoadingTeams(false);
      });
  }, [reloadCount, destWorkspaceVersion]);

  // Reload source projects when workspace/team filter changes (or on reload)
  useEffect(() => {
    if (sourceWorkspaces.length > 0 && !selectedSourceWorkspace) return;
    if (sourceTeams.length > 0 && !selectedSourceTeam) return;
    if (skips.current.sourceProjects) { skips.current.sourceProjects = false; return; }

    setLoadingSource(true);
    setSelectedSource('');
    const params = new URLSearchParams();
    if (selectedSourceWorkspace) params.set('workspaceId', selectedSourceWorkspace);
    if (selectedSourceTeam) params.set('teamId', selectedSourceTeam);
    if (includeArchived) params.set('includeArchived', 'true');
    const url = params.size > 0 ? `/api/source/projects?${params}` : '/api/source/projects';
    fetch(url)
      .then((r) => r.json() as Promise<SourceProject[]>)
      .then((src) => {
        const sorted = [...src].sort((a, b) => a.name.localeCompare(b.name));
        setSourceProjects(sorted);
        setLoadingSource(false);
        updateCache({ sourceProjects: sorted, selectedSourceWorkspace, selectedSourceTeam, includeArchived });
      })
      .catch(() => { setError('Failed to load source projects'); setLoadingSource(false); });
  }, [sourceWorkspaces.length, sourceTeams.length, selectedSourceWorkspace, selectedSourceTeam, includeArchived, reloadCount]);

  // When source project changes or mode switches to 'new', default the new project name to the source name
  useEffect(() => {
    if (destMode !== 'new') return;
    const src = sourceProjects.find((p) => p.id === selectedSource);
    if (src) setNewProjectName(src.name);
  }, [selectedSource, destMode, sourceProjects]);

  // Reload destination projects when team changes
  useEffect(() => {
    if (skips.current.destProjects) { skips.current.destProjects = false; return; }

    setLoadingProjects(true);
    setDestProjects([]);
    setSelectedDest('');
    setProjectQuery('');

    const url = selectedTeamGid
      ? `/api/destination/projects?teamGid=${encodeURIComponent(selectedTeamGid)}`
      : '/api/destination/projects';

    fetch(url)
      .then((r) => r.json() as Promise<AsanaProject[]>)
      .then((projects) => {
        const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));
        setDestProjects(sorted);
        setLoadingProjects(false);
        updateCache({ destProjects: sorted, selectedTeamGid });
      })
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

  async function handleCheckOwner() {
    setOwnerError('');
    const query = ownerInput.trim();
    if (!query) return;
    setOwnerChecking(true);
    try {
      const res = await fetch(`/api/destination/user?q=${encodeURIComponent(query)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setOwnerError(body.error ?? `User not found (${res.status}).`);
        setValidatedOwner(null);
      } else {
        const user = await res.json() as { gid: string; name: string };
        setValidatedOwner(user);
        setOwnerInput('');
      }
    } catch {
      setOwnerError('Failed to reach the server. Please try again.');
    } finally {
      setOwnerChecking(false);
    }
  }

  async function handleContinue() {
    const srcProject = sourceProjects.find((p) => p.id === selectedSource);
    if (!srcProject) return;

    const teamGid = selectedTeamGid || null;
    const teamName = teams.find((t) => t.gid === selectedTeamGid)?.name ?? null;

    const destWsGid  = selectedDestWorkspaceGid;
    const destWsName = destWorkspaces.find((w) => w.id === destWsGid)?.name ?? state.destWorkspaceName ?? '';

    if (destMode === 'new') {
      await fetch('/api/session/project-owner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validatedOwner ?? { gid: null, name: null }),
      });
      onSelect(srcProject.id, srcProject.name, '', newProjectName.trim(), teamGid, teamName, true, validatedOwner?.gid ?? null, validatedOwner?.name ?? null, destWsGid, destWsName);
    } else {
      const destProject = destProjects.find((p) => p.gid === selectedDest);
      if (!destProject) return;
      await fetch('/api/session/project-owner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gid: null, name: null }),
      });
      onSelect(srcProject.id, srcProject.name, destProject.gid, destProject.name, teamGid, teamName, false, null, null, destWsGid, destWsName);
    }
  }

  const loading = loadingSource || loadingTeams;
  const canProceed = !!selectedSource && (
    destMode === 'new' ? !!newProjectName.trim() && !!validatedOwner : !!selectedDest
  );

  return (
    <div className="step-panel">
      <h2 className="step-title">Select Projects</h2>
      <p className="step-desc">Choose which source project to migrate and where it will land in Asana.</p>

      {loading && <p className="loading-text">Loading…</p>}
      {error && <p className="error-text">{error}</p>}

      {!loading && !error && (
        <div className="connect-grid">
          {/* Source card */}
          <div className={`connect-card ${selectedSource ? 'connected' : ''}`}>
            <div className="connect-card-header">
              <h3>Source Project</h3>
              {selectedSource && (
                <span className="badge badge-success">
                  {sourceProjects.find((p) => p.id === selectedSource)?.name}
                </span>
              )}
            </div>

            {sourceWorkspaces.length > 0 && (
              <div className="field-group">
                <label htmlFor="source-workspace">Workspace</label>
                <select
                  id="source-workspace"
                  value={selectedSourceWorkspace}
                  onChange={(e) => { setSelectedSourceWorkspace(e.target.value); setSelectedSourceTeam(''); }}
                >
                  {sourceWorkspaces.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </div>
            )}

            {sourceTeams.length > 0 && (
              <div className="field-group">
                <label htmlFor="source-team">Team</label>
                <select
                  id="source-team"
                  value={selectedSourceTeam}
                  onChange={(e) => setSelectedSourceTeam(e.target.value)}
                >
                  <option value="">— Select a team —</option>
                  {sourceTeams.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="field-group">
              <label htmlFor="source-project">
                {state.sourcePlatform === 'monday' ? 'Monday.com board'
                  : state.sourcePlatform === 'smartsheet' ? 'Smartsheet sheet'
                  : state.sourcePlatform === 'trello' ? 'Trello board'
                  : 'Project'}
              </label>
              {sourceProjects.length > 10 && (
                <input
                  type="search"
                  placeholder={sourceProjects.length > 200 ? 'Type to search projects…' : 'Search projects…'}
                  value={sourceSearch}
                  onChange={(e) => { setSourceSearch(e.target.value); setSelectedSource(''); }}
                  style={{ marginBottom: '6px' }}
                  autoComplete="off"
                />
              )}
              {sourceProjects.length > 200 && !sourceSearch.trim() ? (
                <p className="field-hint" style={{ marginTop: 0 }}>
                  {sourceProjects.length.toLocaleString()} projects loaded — type above to filter, or paste an ID / link below.
                </p>
              ) : (
                <select
                  id="source-project"
                  value={selectedSource}
                  onChange={(e) => { setSelectedSource(e.target.value); setSheetIdInput(''); setSheetIdError(''); }}
                >
                  <option value="">— Select a project —</option>
                  {sourceProjects
                    .filter((p) => !sourceSearch.trim() || p.name.toLowerCase().includes(sourceSearch.toLowerCase().trim()))
                    .map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                </select>
              )}
              {state.sourcePlatform === 'workfront' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', fontSize: '0.875rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={includeArchived}
                    onChange={(e) => { setIncludeArchived(e.target.checked); setSelectedSource(''); }}
                  />
                  Include completed and dead projects
                </label>
              )}
            </div>

            <div className="field-group">
              <label htmlFor="sheet-id-input">Or paste an ID / link</label>
              <p className="field-hint">
                {state.sourcePlatform === 'smartsheet' ? 'Paste a sheet URL or numeric Sheet ID to select it directly.'
                  : state.sourcePlatform === 'wrike' ? 'Paste a Wrike folder/project ID to select it directly.'
                  : state.sourcePlatform === 'monday' ? 'Paste a Monday.com board ID to select it directly.'
                  : state.sourcePlatform === 'trello' ? 'Paste a Trello board ID to select it directly.'
                  : state.sourcePlatform === 'workfront' ? 'Paste a Workfront project ID to select it directly.'
                  : 'Paste the project ID to select it directly.'}
              </p>
              <div className="input-with-button">
                <input
                  id="sheet-id-input"
                  type="text"
                  value={sheetIdInput}
                  onChange={(e) => { setSheetIdInput(e.target.value); setSheetIdError(''); }}
                  onKeyDown={(e) => e.key === 'Enter' && !sheetIdLookup && sheetIdInput.trim() && handleSheetIdLookup()}
                  placeholder={
                    state.sourcePlatform === 'smartsheet' ? 'https://app.smartsheet.com/sheets/…  or  1234567890'
                    : 'Paste ID or URL…'
                  }
                  disabled={sheetIdLookup}
                  autoComplete="off"
                />
                <button
                  className="btn btn-primary"
                  onClick={handleSheetIdLookup}
                  disabled={!sheetIdInput.trim() || sheetIdLookup}
                >
                  {sheetIdLookup ? 'Looking up…' : 'Use this'}
                </button>
              </div>
              {sheetIdError && <p className="error-text">{sheetIdError}</p>}
            </div>
          </div>

          {/* Destination card */}
          <div className={`connect-card ${
            destMode === 'new'
              ? newProjectName.trim() && validatedOwner ? 'connected' : newProjectName.trim() ? 'pending' : ''
              : selectedDest ? 'connected' : ''
          }`}>
            <div className="connect-card-header">
              <h3>Destination Asana</h3>
              {destMode === 'new' && newProjectName.trim() && (
                <span className={`badge ${validatedOwner ? 'badge-success' : 'badge-warning'}`}>New: {newProjectName.trim()}</span>
              )}
              {destMode === 'existing' && selectedDest && (
                <span className="badge badge-success">{projectQuery}</span>
              )}
            </div>

            {destWorkspaces.length > 1 && (
              <div className="field-group">
                <label htmlFor="dest-workspace">
                  Asana Workspace
                </label>
                <select
                  id="dest-workspace"
                  value={selectedDestWorkspaceGid}
                  onChange={(e) => handleDestWorkspaceChange(e.target.value)}
                >
                  {destWorkspaces.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </div>
            )}

            {teams.length > 0 && (
              <div className="field-group">
                <label htmlFor="dest-team">
                  Asana Team <span className="field-hint-inline">(filters project list)</span>
                </label>
                <select
                  id="dest-team"
                  value={selectedTeamGid}
                  onChange={(e) => { setSelectedTeamGid(e.target.value); updateCache({ selectedTeamGid: e.target.value }); }}
                >
                  <option value="">— All teams —</option>
                  {teams.map((t) => (
                    <option key={t.gid} value={t.gid}>{t.name}</option>
                  ))}
                </select>
              </div>
            )}

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
              <>
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
                <div className="field-group">
                  <label>Project Owner <span className="required-star">*</span></label>
                  <p className="field-hint">The Asana user who will own this project after migration. Search by name or email address.</p>
                  {validatedOwner ? (
                    <div className="validated-project">
                      <span className="validated-icon">✓</span>
                      <span className="validated-name">{validatedOwner.name}</span>
                      <button className="btn btn-ghost btn-sm" onClick={() => setValidatedOwner(null)}>Change</button>
                    </div>
                  ) : (
                    <>
                      <div className="input-with-button">
                        <input
                          type="text"
                          value={ownerInput}
                          onChange={(e) => { setOwnerInput(e.target.value); setOwnerError(''); }}
                          onKeyDown={(e) => e.key === 'Enter' && !ownerChecking && ownerInput.trim() && handleCheckOwner()}
                          placeholder="jane@example.com  or  Jane Smith  or  1234567890"
                          disabled={ownerChecking}
                          autoComplete="off"
                        />
                        <button
                          className="btn btn-primary"
                          onClick={handleCheckOwner}
                          disabled={!ownerInput.trim() || ownerChecking}
                        >
                          {ownerChecking ? 'Looking up…' : 'Find'}
                        </button>
                      </div>
                      {ownerError && <p className="error-text">{ownerError}</p>}
                    </>
                  )}
                </div>
              </>
            )}

            {destMode === 'existing' && (
              <div className="field-group">
                <label htmlFor="dest-project-search">
                  Asana Project
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
          </div>
        </div>
      )}

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={onBack}>Back</button>
        <button className="btn btn-ghost" onClick={handleReload} disabled={loading}>
          ↺ Reload project lists
        </button>
        <button className="btn btn-primary" onClick={handleContinue} disabled={!canProceed}>
          Continue
        </button>
      </div>
    </div>
  );
}
