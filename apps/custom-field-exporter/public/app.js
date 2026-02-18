//-------------------------//
// app.js
// Code implemented by Cirface.com / MMG
//
// Frontend JavaScript for Custom Field Exporter - manages state, data fetching,
// filtering, sorting, and CSV export for Asana custom fields governance
//
// Disclaimer: This code was created with the help of Claude.AI
//
// This code is part of Cirface Custom Field Explorer
// Last updated by: 2026FEB10 - LMR
//-------------------------//

// ============================================================================
// State
// ============================================================================

const state = {
  user: null,
  workspaces: [],
  selectedWorkspaceGid: null,
  customFields: [],      // full dataset
  filtered: [],          // after search + filters applied
  sortCol: 'name',
  sortDir: 'asc',
  searchQuery: '',
  filterType: 'all',
  filterScope: 'all',
};

// ============================================================================
// DOM refs
// ============================================================================

const $ = (sel) => document.querySelector(sel);
const loginScreen   = $('#login-screen');
const appScreen     = $('#app-screen');
const loginBtn      = $('#login-btn');
const loginError    = $('#login-error');
const userName      = $('#user-name');
const logoutBtn     = $('#logout-btn');
const workspaceSelect = $('#workspace-select');
const loadBtn       = $('#load-btn');
const loadingSection = $('#loading-section');
const progressBar   = $('#progress-bar');
const progressText  = $('#progress-text');
const statsBar      = $('#stats-bar');
const toolbar       = $('#toolbar');
const searchInput   = $('#search-input');
const filterType    = $('#filter-type');
const filterScope   = $('#filter-scope');
const exportBtn     = $('#export-btn');
const tableContainer = $('#table-container');
const tableBody     = $('#table-body');
const noResults     = $('#no-results');
const errorBanner   = $('#error-banner');
const errorMessage  = $('#error-message');
const errorDismiss  = $('#error-dismiss');

// ============================================================================
// Init
// ============================================================================

document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Check URL for OAuth errors
  const params = new URLSearchParams(window.location.search);
  if (params.get('error')) {
    showLoginError('Connection was denied or failed. Please try again.');
    window.history.replaceState({}, '', '/');
  }

  // Check auth status
  try {
    const res = await fetch('/auth/status');
    const data = await res.json();
    if (data.authenticated) {
      state.user = data.user;
      showApp();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }

  // Event listeners
  loginBtn.addEventListener('click', () => { window.location = '/auth/login'; });
  logoutBtn.addEventListener('click', () => { window.location = '/auth/logout'; });
  loadBtn.addEventListener('click', handleLoad);
  searchInput.addEventListener('input', debounce(applyFiltersAndRender, 250));
  filterType.addEventListener('change', applyFiltersAndRender);
  filterScope.addEventListener('change', applyFiltersAndRender);
  exportBtn.addEventListener('click', exportCSV);
  errorDismiss.addEventListener('click', () => { errorBanner.hidden = true; });

  // Sort headers
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (state.sortCol === col) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortCol = col;
        state.sortDir = 'asc';
      }
      applyFiltersAndRender();
    });
  });
}

// ============================================================================
// Screen management
// ============================================================================

function showLogin() {
  loginScreen.hidden = false;
  appScreen.hidden = true;
}

function showApp() {
  loginScreen.hidden = true;
  appScreen.hidden = false;
  userName.textContent = state.user?.name || '';
  loadWorkspaces();
}

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.hidden = false;
}

function showError(msg) {
  errorMessage.textContent = msg;
  errorBanner.hidden = false;
}

// ============================================================================
// Workspace loading
// ============================================================================

async function loadWorkspaces() {
  try {
    const res = await fetch('/api/workspaces');
    if (!res.ok) throw new Error('Failed to load workspaces');
    const data = await res.json();
    state.workspaces = data.data || [];

    workspaceSelect.innerHTML = '';
    state.workspaces.forEach((ws) => {
      const opt = document.createElement('option');
      opt.value = ws.gid;
      opt.textContent = ws.name;
      workspaceSelect.appendChild(opt);
    });

    if (state.workspaces.length > 0) {
      state.selectedWorkspaceGid = state.workspaces[0].gid;
    }
  } catch (err) {
    showError(err.message);
  }
}

// ============================================================================
// Data loading
// ============================================================================

function setProgress(pct, text) {
  progressBar.style.width = `${Math.min(pct, 100)}%`;
  progressText.textContent = text;
}

async function handleLoad() {
  const wsGid = workspaceSelect.value;
  if (!wsGid) return;
  state.selectedWorkspaceGid = wsGid;

  // Reset UI
  loadBtn.disabled = true;
  loadingSection.hidden = false;
  statsBar.hidden = true;
  toolbar.hidden = true;
  tableContainer.hidden = true;
  setProgress(0, 'Loading custom fields...');

  try {
    // Step 1: Fetch all custom fields
    const fields = await fetchAllCustomFields(wsGid);
    setProgress(40, `Loaded ${fields.length} custom fields. Loading projects...`);

    // Step 2: Fetch all projects and map field → projects (with privacy)
    // Also collects full data for project-only fields not in the workspace library
    const knownGids = new Set(fields.map((f) => f.gid));
    const { map: projectMap, extraFields } = await buildProjectMap(wsGid, knownGids);
    setProgress(75, `Checking last usage for ${fields.length} fields...`);

    // Step 3: Attach project info to each field
    for (const field of fields) {
      field.projects = projectMap[field.gid] || [];
    }

    // Step 3b: Add fields found only in project settings (not in workspace library)
    for (const [gid, fieldData] of Object.entries(extraFields)) {
      fields.push({ ...fieldData, projects: projectMap[gid] || [] });
    }

    // Step 4: Fetch "last used" date for each field
    await fetchLastUsedDates(wsGid, fields);

    state.customFields = fields;
    setProgress(100, 'Done!');

    // Show dashboard
    populateTypeFilter(fields);
    updateStats(fields);
    applyFiltersAndRender();

    statsBar.hidden = false;
    $('#info-note').hidden = false;
    toolbar.hidden = false;
    tableContainer.hidden = false;
  } catch (err) {
    showError(err.message);
  } finally {
    loadBtn.disabled = false;
    setTimeout(() => { loadingSection.hidden = true; }, 600);
  }
}

async function fetchAllCustomFields(wsGid) {
  // Step A: workspace custom fields (the primary source)
  let all = [];
  let offset = null;
  let page = 1;

  do {
    setProgress(Math.min(page * 5, 20), `Loading workspace custom fields (page ${page})...`);
    const url = `/api/custom-fields?workspace_gid=${wsGid}` + (offset ? `&offset=${offset}` : '');
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to load custom fields');
    }
    const data = await res.json();
    all = all.concat(data.data || []);
    offset = data.next_page?.offset || null;
    page++;
  } while (offset);

  const knownGids = new Set(all.map((f) => f.gid));

  // Step B: portfolios — may contain fields not in the workspace library
  setProgress(25, 'Scanning portfolio custom fields...');
  const portfolioFields = await fetchResourceTypeCustomFields(wsGid, 'portfolios', 'portfolio-custom-fields', knownGids);
  for (const f of portfolioFields) { all.push(f); knownGids.add(f.gid); }

  // Step C: goals — may contain fields not in the workspace library
  setProgress(32, 'Scanning goal custom fields...');
  const goalFields = await fetchResourceTypeCustomFields(wsGid, 'goals', 'goal-custom-fields', knownGids);
  for (const f of goalFields) { all.push(f); knownGids.add(f.gid); }

  return all;
}

// Fetches all resources of a given type, then collects any custom fields on them
// that are not already in knownGids. Returns only the new unique field objects.
async function fetchResourceTypeCustomFields(wsGid, resourceEndpoint, fieldEndpoint, knownGids) {
  // Paginate through all resources of this type
  let resources = [];
  let offset = null;

  do {
    const url = `/api/${resourceEndpoint}?workspace_gid=${wsGid}` + (offset ? `&offset=${offset}` : '');
    const res = await fetch(url);
    if (!res.ok) return []; // non-fatal — skip this resource type if unavailable
    const data = await res.json();
    resources = resources.concat(data.data || []);
    offset = data.next_page?.offset || null;
  } while (offset);

  // Collect unique new fields from each resource's custom_field_settings
  const newFields = {};
  const CONCURRENCY = 5;

  for (let i = 0; i < resources.length; i += CONCURRENCY) {
    const batch = resources.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (resource) => {
        try {
          const res = await fetch(`/api/${fieldEndpoint}/${resource.gid}`);
          if (!res.ok) return;
          const data = await res.json();
          for (const setting of (data.data || [])) {
            const field = setting.custom_field;
            if (!field?.gid) continue;
            if (!knownGids.has(field.gid) && !newFields[field.gid]) {
              newFields[field.gid] = field;
            }
          }
        } catch { /* non-fatal */ }
      }),
    );
    if (i + CONCURRENCY < resources.length) await sleep(200);
  }

  return Object.values(newFields);
}

async function buildProjectMap(wsGid, knownGids) {
  // fieldGid → [{ gid, name, privacy }]
  const map = {};
  // fieldGid → full field object, for fields not in the workspace library
  const extraFields = {};

  // Fetch all projects
  let projects = [];
  let offset = null;
  let page = 1;

  do {
    setProgress(40 + Math.min(page * 5, 20), `Loading projects (page ${page})...`);
    const url = `/api/projects?workspace_gid=${wsGid}` + (offset ? `&offset=${offset}` : '');
    const res = await fetch(url);
    if (!res.ok) break; // non-fatal — we just won't have project data
    const data = await res.json();
    projects = projects.concat(data.data || []);
    offset = data.next_page?.offset || null;
    page++;
  } while (offset);

  // For each project, fetch its custom field settings
  const total = projects.length;
  const CONCURRENCY = 5;
  const DELAY = 200;

  for (let i = 0; i < total; i += CONCURRENCY) {
    const batch = projects.slice(i, i + CONCURRENCY);
    const pct = 60 + Math.round(((i + CONCURRENCY) / total) * 30);
    setProgress(Math.min(pct, 90), `Mapping project fields (${Math.min(i + CONCURRENCY, total)} of ${total} projects)...`);

    const results = await Promise.all(
      batch.map(async (proj) => {
        try {
          const res = await fetch(`/api/project-custom-fields/${proj.gid}`);
          if (!res.ok) return [];
          const data = await res.json();
          return (data.data || []).map((setting) => ({
            fieldGid: setting.custom_field?.gid,
            fieldData: setting.custom_field,
            project: { gid: proj.gid, name: proj.name, privacy: proj.privacy_setting || 'unknown' },
          }));
        } catch {
          return [];
        }
      }),
    );

    for (const entries of results) {
      for (const entry of entries) {
        if (!entry.fieldGid) continue;
        if (!map[entry.fieldGid]) map[entry.fieldGid] = [];
        map[entry.fieldGid].push(entry.project);
        // Collect full field data for fields not already in the workspace library
        if (!knownGids.has(entry.fieldGid) && entry.fieldData && !extraFields[entry.fieldGid]) {
          extraFields[entry.fieldGid] = entry.fieldData;
        }
      }
    }

    if (i + CONCURRENCY < total) {
      await sleep(DELAY);
    }
  }

  return { map, extraFields };
}

async function fetchLastUsedDates(wsGid, fields) {
  const total = fields.length;
  const CONCURRENCY = 3;
  const DELAY = 250;

  for (let i = 0; i < total; i += CONCURRENCY) {
    const batch = fields.slice(i, i + CONCURRENCY);
    const pct = 75 + Math.round(((i + CONCURRENCY) / total) * 20);
    setProgress(Math.min(pct, 94), `Checking last usage (${Math.min(i + CONCURRENCY, total)} of ${total} fields)...`);

    await Promise.all(
      batch.map(async (field) => {
        try {
          const res = await fetch(`/api/search-tasks?workspace_gid=${wsGid}&custom_field_gid=${field.gid}`);
          if (!res.ok) { field.last_used = null; return; }
          const data = await res.json();
          const task = data.data?.[0];
          field.last_used = task?.modified_at || null;
        } catch {
          field.last_used = null;
        }
      }),
    );

    if (i + CONCURRENCY < total) {
      await sleep(DELAY);
    }
  }
}

// ============================================================================
// Filtering, sorting, rendering
// ============================================================================

function populateTypeFilter(fields) {
  const types = [...new Set(fields.map((f) => f.resource_subtype || f.type))].sort();
  filterType.innerHTML = '<option value="all">All Types</option>';
  types.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = formatType(t);
    filterType.appendChild(opt);
  });
}

function updateStats(fields) {
  const globalCount = fields.filter((f) => f.is_global_to_workspace).length;
  const types = new Set(fields.map((f) => f.resource_subtype || f.type));
  $('#stat-total').textContent = fields.length;
  $('#stat-global').textContent = globalCount;
  $('#stat-local').textContent = fields.length - globalCount;
  $('#stat-types').textContent = types.size;
}

function applyFiltersAndRender() {
  state.searchQuery = searchInput.value.toLowerCase().trim();
  state.filterType = filterType.value;
  state.filterScope = filterScope.value;

  let list = state.customFields;

  // Search
  if (state.searchQuery) {
    list = list.filter((f) => {
      const text = [
        f.name,
        f.gid,
        f.description,
        f.created_by?.name,
        ...(f.enum_options || []).map((o) => o.name),
        ...(f.projects || []).map((p) => p.name),
      ].filter(Boolean).join(' ').toLowerCase();
      return text.includes(state.searchQuery);
    });
  }

  // Type filter
  if (state.filterType !== 'all') {
    list = list.filter((f) => (f.resource_subtype || f.type) === state.filterType);
  }

  // Scope filter
  if (state.filterScope === 'global') {
    list = list.filter((f) => f.is_global_to_workspace);
  } else if (state.filterScope === 'local') {
    list = list.filter((f) => !f.is_global_to_workspace);
  }

  // Sort
  list = [...list].sort((a, b) => {
    let va = getSortValue(a, state.sortCol);
    let vb = getSortValue(b, state.sortCol);
    if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
    if (va < vb) return state.sortDir === 'asc' ? -1 : 1;
    if (va > vb) return state.sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  state.filtered = list;
  renderTable(list);
  updateSortIcons();
}

function getSortValue(field, col) {
  switch (col) {
    case 'name': return field.name || '';
    case 'gid': return field.gid || '';
    case 'type': return field.resource_subtype || field.type || '';
    case 'created_by': return field.created_by?.name || '';
    case 'is_global': return field.is_global_to_workspace ? 'Global' : 'Local';
    case 'last_used': return field.last_used || '';
    default: return '';
  }
}

function renderTable(fields) {
  if (fields.length === 0) {
    tableBody.innerHTML = '';
    noResults.hidden = false;
    return;
  }
  noResults.hidden = true;

  tableBody.innerHTML = fields.map((f) => `
    <tr>
      <td><strong>${esc(f.name)}</strong></td>
      <td><code style="font-size:0.8rem;color:#64748b;user-select:all">${esc(f.gid)}</code></td>
      <td><span class="type-badge ${esc(f.resource_subtype || f.type)}">${esc(formatType(f.resource_subtype || f.type))}</span></td>
      <td class="truncate" title="${esc(f.description || '')}">${esc(f.description || '—')}</td>
      <td>${esc(f.created_by?.name || '—')}</td>
      <td><span class="scope-badge ${f.is_global_to_workspace ? 'global' : 'local'}">${f.is_global_to_workspace ? 'Global' : 'Local'}</span></td>
      <td>${formatLastUsed(f.last_used)}</td>
      <td>${renderProjects(f.projects)}</td>
      <td>${renderEnumOptions(f.enum_options)}</td>
    </tr>
  `).join('');
}

function renderProjects(projects) {
  if (!projects || projects.length === 0) return '<span style="color:#94a3b8">—</span>';
  return `<ul class="cell-list">${projects.map((p) => {
    const icon = p.privacy === 'private' ? '🔒' : '🌐';
    const url = `https://app.asana.com/0/${esc(p.gid)}`;
    return `<li class="tag" title="${esc(formatPrivacy(p.privacy))}"><a href="${url}" target="_blank" rel="noopener" class="project-link">${icon} ${esc(p.name)}</a></li>`;
  }).join('')}</ul>`;
}

function formatPrivacy(privacy) {
  if (privacy === 'private') return 'Private project';
  if (privacy === 'public_to_workspace') return 'Public to workspace';
  return 'Unknown visibility';
}

function formatLastUsed(dateStr) {
  if (!dateStr) return '<span style="color:#94a3b8">Never / Unknown</span>';
  const d = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24));
  const formatted = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  let color = '#166534'; // green — recent
  if (diffDays > 180) color = '#dc2626'; // red — stale
  else if (diffDays > 90) color = '#d97706'; // amber — aging

  return `<span style="color:${color}" title="${diffDays} days ago">${formatted}</span>`;
}

function renderEnumOptions(options) {
  if (!options || options.length === 0) return '<span style="color:#94a3b8">—</span>';
  return `<ul class="cell-list">${options.map((o) =>
    `<li class="tag ${o.enabled === false ? 'disabled' : ''}" ${o.color ? `style="border-left:3px solid ${mapColor(o.color)}"` : ''}>${esc(o.name)}</li>`
  ).join('')}</ul>`;
}

function updateSortIcons() {
  document.querySelectorAll('.sort-icon').forEach((icon) => {
    icon.className = 'sort-icon';
  });
  const activeTh = document.querySelector(`th[data-col="${state.sortCol}"] .sort-icon`);
  if (activeTh) {
    activeTh.classList.add(state.sortDir);
  }
}

// ============================================================================
// CSV Export
// ============================================================================

function exportCSV() {
  const rows = state.filtered;
  if (rows.length === 0) return;

  const headers = ['Name', 'Field GID', 'Type', 'Description', 'Created By', 'Scope', 'Last Used', 'Projects', 'Project Visibility', 'Options / Variations'];
  const csvRows = [headers.join(',')];

  for (const f of rows) {
    const projects = (f.projects || []).map((p) => p.name).join('; ');
    const projectVisibility = (f.projects || []).map((p) => {
      const vis = p.privacy === 'private' ? 'Private' : p.privacy === 'public_to_workspace' ? 'Public' : 'Unknown';
      return `${p.name} (${vis})`;
    }).join('; ');
    const options = (f.enum_options || []).map((o) => {
      let s = o.name;
      if (o.enabled === false) s += ' (disabled)';
      return s;
    }).join('; ');
    const lastUsed = f.last_used ? new Date(f.last_used).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Never / Unknown';

    csvRows.push([
      csvCell(f.name),
      csvCell(f.gid),
      csvCell(formatType(f.resource_subtype || f.type)),
      csvCell(f.description || ''),
      csvCell(f.created_by?.name || ''),
      csvCell(f.is_global_to_workspace ? 'Global' : 'Local'),
      csvCell(lastUsed),
      csvCell(projects),
      csvCell(projectVisibility),
      csvCell(options),
    ].join(','));
  }

  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `custom-fields-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  if (value == null) return '""';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ============================================================================
// Utilities
// ============================================================================

function esc(str) {
  if (!str) return '';
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

function formatType(type) {
  const names = {
    text: 'Text',
    number: 'Number',
    enum: 'Dropdown',
    multi_enum: 'Multi-select',
    date: 'Date',
    people: 'People',
  };
  return names[type] || type;
}

function mapColor(asanaColor) {
  const colors = {
    'dark-pink': '#e8384f', 'dark-green': '#4a7b3f',
    'dark-blue': '#4186e0', 'dark-red': '#cc3300',
    'dark-teal': '#2e7d8c', 'dark-brown': '#8b6c3e',
    'dark-orange': '#e68a00', 'dark-warm-gray': '#8c8272',
    'light-pink': '#f9aaef', 'light-green': '#b5e877',
    'light-blue': '#9ee7e3', 'light-red': '#f1a5a0',
    'light-teal': '#7ecfc0', 'light-yellow': '#f8df72',
    'light-orange': '#f9b576', 'light-warm-gray': '#c7c4bc',
    'light-purple': '#c7a1e0',
    none: '#94a3b8',
  };
  return colors[asanaColor] || '#94a3b8';
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
