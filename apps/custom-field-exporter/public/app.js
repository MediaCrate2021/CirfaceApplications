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
  excludedCreators: new Set(),
  lastUsedLoaded: false,
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
const loadBtn          = $('#load-btn');
const includeLastUsed  = $('#include-last-used');
const loadingSection = $('#loading-section');
const progressBar   = $('#progress-bar');
const progressText  = $('#progress-text');
const statsBar      = $('#stats-bar');
const toolbar       = $('#toolbar');
const searchInput   = $('#search-input');
const filterType    = $('#filter-type');
const filterScope   = $('#filter-scope');
// creator filter is a custom multi-select; no single DOM ref needed
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
  includeLastUsed.addEventListener('change', updateLastUsedVisibility);
  updateLastUsedVisibility();
  searchInput.addEventListener('input', debounce(applyFiltersAndRender, 250));
  filterType.addEventListener('change', applyFiltersAndRender);
  filterScope.addEventListener('change', applyFiltersAndRender);
  exportBtn.addEventListener('click', exportCSV);

  // Multi-select creator filter
  $('#filter-creator-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = $('#filter-creator-panel');
    panel.hidden = !panel.hidden;
  });
  $('#creator-select-all').addEventListener('click', () => {
    document.querySelectorAll('.creator-checkbox').forEach((cb) => { cb.checked = true; });
    state.excludedCreators = new Set();
    updateCreatorTrigger();
    applyFiltersAndRender();
  });
  $('#creator-clear-all').addEventListener('click', () => {
    document.querySelectorAll('.creator-checkbox').forEach((cb) => { cb.checked = false; });
    state.excludedCreators = new Set([...document.querySelectorAll('.creator-checkbox')].map((cb) => cb.value));
    updateCreatorTrigger();
    applyFiltersAndRender();
  });
  document.addEventListener('click', (e) => {
    if (!$('#creator-multi-select').contains(e.target)) {
      $('#filter-creator-panel').hidden = true;
    }
  });
  errorDismiss.addEventListener('click', () => { errorBanner.hidden = true; });

  // Field detail modal
  $('#modal-close').addEventListener('click', closeModal);
  $('#field-modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#field-modal').hidden) closeModal(); });
  tableBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.field-name-btn');
    if (!btn) return;
    const field = state.customFields.find((f) => f.gid === btn.dataset.gid);
    if (field) openFieldModal(field);
  });

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

function updateLastUsedVisibility() {
  tableContainer.classList.toggle('no-last-used', !state.lastUsedLoaded);
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
  state.lastUsedLoaded = false;
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

    // Step 2: Scan projects, portfolios, and goals.
    // Builds association maps (fieldGid → resources) and discovers fields
    // that exist only in those resources (not in the workspace library).
    const knownGids = new Set(fields.map((f) => f.gid));

    setProgress(25, 'Scanning projects...');
    const { map: projectMap, extraFields: projectFields } = await buildResourceMap(wsGid, 'projects', 'project-custom-fields', knownGids);
    for (const [gid, f] of Object.entries(projectFields)) { fields.push(f); knownGids.add(gid); }

    setProgress(45, 'Scanning portfolios...');
    const { map: portfolioMap, extraFields: portfolioFields } = await buildResourceMap(wsGid, 'portfolios', 'portfolio-custom-fields', knownGids);
    for (const [gid, f] of Object.entries(portfolioFields)) { fields.push(f); knownGids.add(gid); }

    setProgress(60, 'Scanning goals...');
    const { map: goalMap, extraFields: goalFields } = await buildResourceMap(wsGid, 'goals', 'goal-custom-fields', knownGids);
    for (const [gid, f] of Object.entries(goalFields)) { fields.push(f); knownGids.add(gid); }

    // Step 3: Attach resource associations to all fields and fix Asana creator entries
    for (const field of fields) {
      field.projects   = projectMap[field.gid]   || [];
      field.portfolios = portfolioMap[field.gid] || [];
      field.goals      = goalMap[field.gid]      || [];
      // Fields with no creator are built-in Asana fields
      if (!field.created_by?.name) field.created_by = { name: 'Asana' };
    }

    // Step 4: Fetch "last used" date for each field (optional)
    if (includeLastUsed.checked) {
      setProgress(75, `Checking last usage for ${fields.length} fields...`);
      await fetchLastUsedDates(wsGid, fields);
      state.lastUsedLoaded = true;
    }

    state.customFields = fields;
    setProgress(100, 'Done!');
    updateLastUsedVisibility();

    // Show dashboard
    populateTypeFilter(fields);
    populateCreatorFilter(fields);
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
  // Workspace custom fields only — project/portfolio/goal fields discovered in Step 2
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

  return all;
}

// Builds a fieldGid → [{ gid, name, privacy? }] association map for any resource type
// (projects, portfolios, goals). Also collects full field data for fields with
// is_global_to_workspace = false that are not already in knownGids.
async function buildResourceMap(wsGid, listEndpoint, settingsEndpoint, knownGids) {
  let resources = [];
  let offset = null;

  do {
    const url = `/api/${listEndpoint}?workspace_gid=${wsGid}` + (offset ? `&offset=${offset}` : '');
    const res = await fetch(url);
    if (!res.ok) return { map: {}, extraFields: {} };
    const data = await res.json();
    resources = resources.concat(data.data || []);
    offset = data.next_page?.offset || null;
  } while (offset);

  const map = {};
  const extraFields = {};
  const CONCURRENCY = 5;

  for (let i = 0; i < resources.length; i += CONCURRENCY) {
    const batch = resources.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (resource) => {
      try {
        const res = await fetch(`/api/${settingsEndpoint}/${resource.gid}`);
        if (!res.ok) return;
        const data = await res.json();
        for (const setting of (data.data || [])) {
          const field = setting.custom_field;
          if (!field?.gid) continue;

          // Build association entry (include privacy_setting for resources that have it)
          if (!map[field.gid]) map[field.gid] = [];
          const entry = { gid: resource.gid, name: resource.name };
          if (resource.privacy_setting) entry.privacy = resource.privacy_setting;
          if (setting.created_at) entry.added_at = setting.created_at;
          if (setting.created_by?.name) entry.added_by = setting.created_by.name;
          map[field.gid].push(entry);

          // Collect fields that are not in the workspace library
          if (!field.is_global_to_workspace && !knownGids.has(field.gid) && !extraFields[field.gid]) {
            extraFields[field.gid] = field;
          }
        }
      } catch { /* non-fatal */ }
    }));
    if (i + CONCURRENCY < resources.length) await sleep(200);
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
          field.last_used_task_gid = task?.gid || null;
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

function populateCreatorFilter(fields) {
  const creators = [...new Set(fields.map((f) => f.created_by?.name || 'Asana'))].sort();
  state.excludedCreators = new Set(); // reset on data reload

  const container = document.getElementById('creator-checkboxes');
  container.innerHTML = creators.map((name) => `
    <label class="multi-select-item">
      <input type="checkbox" class="creator-checkbox" value="${esc(name)}" checked>
      <span>${esc(name)}</span>
    </label>
  `).join('');

  container.querySelectorAll('.creator-checkbox').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) {
        state.excludedCreators.delete(cb.value);
      } else {
        state.excludedCreators.add(cb.value);
      }
      updateCreatorTrigger();
      applyFiltersAndRender();
    });
  });

  updateCreatorTrigger();
}

function updateCreatorTrigger() {
  const btn = document.getElementById('filter-creator-btn');
  const n = state.excludedCreators.size;
  btn.innerHTML = n === 0
    ? 'All Creators <span class="multi-select-arrow">▾</span>'
    : `${n} hidden <span class="multi-select-arrow">▾</span>`;
}

function updateStats(fields) {
  const globalCount  = fields.filter((f) => f.is_global_to_workspace).length;
  const inProjects   = fields.filter((f) => f.projects?.length   > 0).length;
  const inPortfolios = fields.filter((f) => f.portfolios?.length > 0).length;
  const inGoals      = fields.filter((f) => f.goals?.length      > 0).length;
  const types = new Set(fields.map((f) => f.resource_subtype || f.type));
  $('#stat-total').textContent      = fields.length;
  $('#stat-global').textContent     = globalCount;
  $('#stat-projects').textContent   = inProjects;
  $('#stat-portfolios').textContent = inPortfolios;
  $('#stat-goals').textContent      = inGoals;
  $('#stat-types').textContent      = types.size;
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
        ...(f.enum_options  || []).map((o) => o.name),
        ...(f.projects      || []).map((p) => p.name),
        ...(f.portfolios    || []).map((p) => p.name),
        ...(f.goals         || []).map((g) => g.name),
      ].filter(Boolean).join(' ').toLowerCase();
      return text.includes(state.searchQuery);
    });
  }

  // Type filter
  if (state.filterType !== 'all') {
    list = list.filter((f) => (f.resource_subtype || f.type) === state.filterType);
  }

  // Creator filter
  if (state.excludedCreators.size > 0) {
    list = list.filter((f) => !state.excludedCreators.has(f.created_by?.name || 'Asana'));
  }

  // Scope filter
  if (state.filterScope === 'library') {
    list = list.filter((f) => f.is_global_to_workspace);
  } else if (state.filterScope === 'project') {
    list = list.filter((f) => f.projects?.length > 0);
  } else if (state.filterScope === 'portfolio') {
    list = list.filter((f) => f.portfolios?.length > 0);
  } else if (state.filterScope === 'goal') {
    list = list.filter((f) => f.goals?.length > 0);
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
    case 'created_at': return field.created_at || '';
    case 'is_global': return field.is_global_to_workspace ? 'Library' : 'Local';
    case 'last_used': return field.last_used || '';
    case 'locations': return (field.projects?.length || 0) + (field.portfolios?.length || 0) + (field.goals?.length || 0);
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
      <td><button class="field-name-btn" data-gid="${esc(f.gid)}">${esc(f.name)}</button></td>
      <td><code style="font-size:0.8rem;color:#64748b;user-select:all">${esc(f.gid)}</code></td>
      <td><span class="type-badge ${esc(f.resource_subtype || f.type)}">${esc(formatType(f.resource_subtype || f.type))}</span></td>
      <td class="truncate" title="${esc(f.description || '')}">${esc(f.description || '—')}</td>
      <td>${esc(f.created_by?.name || '—')}</td>
      <td>${formatDate(f.created_at)}</td>
      <td><span class="scope-badge ${f.is_global_to_workspace ? 'global' : 'local'}">${f.is_global_to_workspace ? 'Library' : 'Local'}</span></td>
      <td>${formatLastUsed(f.last_used, f.last_used_task_gid)}</td>
      <td>${renderLocations(f)}</td>
      <td>${renderEnumOptions(f.enum_options)}</td>
    </tr>
  `).join('');
}

function renderLocations(f) {
  const items = [];

  for (const p of (f.projects || [])) {
    const icon = p.privacy === 'private' ? '🔒' : '🌐';
    const url = `https://app.asana.com/0/${esc(p.gid)}`;
    items.push(`<li class="tag location-project" title="Project · ${esc(formatPrivacy(p.privacy))}"><a href="${url}" target="_blank" rel="noopener" class="project-link">${icon} ${esc(p.name)}</a></li>`);
  }

  for (const p of (f.portfolios || [])) {
    const url = `https://app.asana.com/0/portfolio/${esc(p.gid)}/list`;
    items.push(`<li class="tag location-portfolio" title="Portfolio"><a href="${url}" target="_blank" rel="noopener" class="project-link">📁 ${esc(p.name)}</a></li>`);
  }

  for (const g of (f.goals || [])) {
    const url = `https://app.asana.com/0/goals/${esc(g.gid)}`;
    items.push(`<li class="tag location-goal" title="Goal"><a href="${url}" target="_blank" rel="noopener" class="project-link">🎯 ${esc(g.name)}</a></li>`);
  }

  if (items.length === 0) return '<span style="color:#94a3b8">—</span>';
  return `<ul class="cell-list">${items.join('')}</ul>`;
}

function formatPrivacy(privacy) {
  if (privacy === 'private') return 'Private project';
  if (privacy === 'public_to_workspace') return 'Public to workspace';
  return 'Unknown visibility';
}

function toShortDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDate(dateStr) {
  if (!dateStr) return '<span style="color:#94a3b8">—</span>';
  return toShortDate(dateStr);
}

function formatLastUsed(dateStr, taskGid) {
  if (!dateStr) return '<span style="color:#94a3b8">Never / Unknown</span>';
  const d = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24));
  const formatted = toShortDate(dateStr);

  let color = '#166534'; // green — recent
  if (diffDays > 180) color = '#dc2626'; // red — stale
  else if (diffDays > 90) color = '#d97706'; // amber — aging

  const label = `<span style="color:${color}" title="${diffDays} days ago">${formatted}</span>`;
  if (!taskGid) return label;
  const url = `https://app.asana.com/0/0/${esc(taskGid)}/f`;
  return `<a href="${url}" target="_blank" rel="noopener" style="text-decoration:none">${label}</a>`;
}

function renderEnumOptions(options) {
  if (!options || options.length === 0) return '<span style="color:#94a3b8">—</span>';
  return `<ul class="cell-list">${options.map((o) =>
    `<li class="tag ${o.enabled === false ? 'disabled' : ''}" ${o.color ? `style="border-left:3px solid ${mapColor(o.color)}"` : ''}>${esc(o.name)}</li>`
  ).join('')}</ul>`;
}

// ============================================================================
// Field Detail Modal
// ============================================================================

function openFieldModal(field) {
  // Header
  $('#modal-field-name').textContent = field.name;
  const subtype = field.resource_subtype || field.type;
  const typeBadge = $('#modal-field-type');
  typeBadge.textContent = formatType(subtype);
  typeBadge.className = `type-badge ${subtype}`;

  // Meta — show last used immediately if available, otherwise show loading
  const lastUsedKnown = state.lastUsedLoaded || field._lastUsedFetched;
  const lastUsedHtml = lastUsedKnown
    ? formatLastUsed(field.last_used, field.last_used_task_gid)
    : '<span style="color:#94a3b8">Loading…</span>';

  $('#modal-meta').innerHTML = `
    <div class="modal-meta-item full-width">
      <label>Description</label>
      <p>${esc(field.description || '—')}</p>
    </div>
    <div class="modal-meta-item">
      <label>Created By</label>
      <p>${esc(field.created_by?.name || '—')}</p>
    </div>
    <div class="modal-meta-item">
      <label>Created</label>
      <p>${field.created_at ? toShortDate(field.created_at) : '—'}</p>
    </div>
    <div class="modal-meta-item">
      <label>Scope</label>
      <p>${field.is_global_to_workspace ? 'Library' : 'Local'}</p>
    </div>
    <div class="modal-meta-item">
      <label>Last Used</label>
      <p id="modal-last-used">${lastUsedHtml}</p>
    </div>
  `;

  // Locations table — Name and Type from initial load; Last Used lazy-fetched per project
  const allLocs = [
    ...(field.projects   || []).map((p) => ({ ref: p, locType: 'Project',   tagClass: 'location-project',   url: `https://app.asana.com/0/${p.gid}` })),
    ...(field.portfolios || []).map((p) => ({ ref: p, locType: 'Portfolio', tagClass: 'location-portfolio', url: `https://app.asana.com/0/portfolio/${p.gid}/list` })),
    ...(field.goals      || []).map((g) => ({ ref: g, locType: 'Goal',      tagClass: 'location-goal',      url: `https://app.asana.com/0/goals/${g.gid}` })),
  ];

  const locEl = $('#modal-locations');
  if (allLocs.length === 0) {
    locEl.innerHTML = '<p class="modal-section-title">Locations</p><p style="color:#94a3b8;font-size:0.875rem">Not applied to any project, portfolio, or goal.</p>';
  } else {
    const rows = allLocs.map((item, idx) => {
      const lastUsedCell = item.locType === 'Project'
        ? (item.ref._lastUsedFetched
            ? formatLastUsed(item.ref.last_used, item.ref.last_used_task_gid)
            : '<span style="color:#94a3b8">Loading…</span>')
        : '<span style="color:#94a3b8">—</span>';
      return `
        <tr>
          <td><a href="${esc(item.url)}" target="_blank" rel="noopener" class="project-link">${esc(item.ref.name)}</a></td>
          <td><span class="tag ${item.tagClass}">${esc(item.locType)}</span></td>
          <td id="loc-last-used-${idx}">${lastUsedCell}</td>
        </tr>
      `;
    }).join('');
    locEl.innerHTML = `
      <p class="modal-section-title">Locations (${allLocs.length})</p>
      <table class="modal-table">
        <thead><tr><th>Name</th><th>Type</th><th>Last Used</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  $('#field-modal').hidden = false;
  document.body.style.overflow = 'hidden';

  // Lazy-fetch overall last used if not already loaded
  if (!lastUsedKnown) {
    fetchFieldLastUsed(field).then(() => {
      const el = document.getElementById('modal-last-used');
      if (el && !$('#field-modal').hidden) {
        el.innerHTML = formatLastUsed(field.last_used, field.last_used_task_gid);
      }
    });
  }

  // Lazy-fetch per-project last used (portfolios/goals don't support task search filtering)
  const wsGid = state.selectedWorkspaceGid;
  allLocs.forEach((item, idx) => {
    if (item.locType !== 'Project' || item.ref._lastUsedFetched) return;
    fetchLocationLastUsed(item.ref, field.gid, wsGid).then(() => {
      const el = document.getElementById(`loc-last-used-${idx}`);
      if (el && !$('#field-modal').hidden) {
        el.innerHTML = formatLastUsed(item.ref.last_used, item.ref.last_used_task_gid);
      }
    });
  });
}

async function fetchFieldLastUsed(field) {
  if (field._lastUsedFetched) return;
  const wsGid = state.selectedWorkspaceGid;
  if (!wsGid) return;
  try {
    const res = await fetch(`/api/search-tasks?workspace_gid=${wsGid}&custom_field_gid=${field.gid}`);
    if (!res.ok) { field.last_used = null; field.last_used_task_gid = null; return; }
    const data = await res.json();
    const task = data.data?.[0];
    field.last_used = task?.modified_at || null;
    field.last_used_task_gid = task?.gid || null;
  } catch {
    field.last_used = null;
    field.last_used_task_gid = null;
  } finally {
    field._lastUsedFetched = true;
  }
}

async function fetchLocationLastUsed(loc, fieldGid, wsGid) {
  if (loc._lastUsedFetched) return;
  try {
    const res = await fetch(`/api/search-tasks?workspace_gid=${wsGid}&custom_field_gid=${fieldGid}&project_gid=${loc.gid}`);
    if (!res.ok) { loc.last_used = null; loc.last_used_task_gid = null; return; }
    const data = await res.json();
    const task = data.data?.[0];
    loc.last_used = task?.modified_at || null;
    loc.last_used_task_gid = task?.gid || null;
  } catch {
    loc.last_used = null;
    loc.last_used_task_gid = null;
  } finally {
    loc._lastUsedFetched = true;
  }
}

function closeModal() {
  $('#field-modal').hidden = true;
  document.body.style.overflow = '';
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

  const headers = ['Name', 'Field GID', 'Type', 'Description', 'Created By', 'Created', 'Scope', 'Last Used', 'Projects', 'Project Visibility', 'Portfolios', 'Goals', 'Options / Variations'];
  const csvRows = [headers.join(',')];

  for (const f of rows) {
    const projects = (f.projects || []).map((p) => p.name).join('; ');
    const projectVisibility = (f.projects || []).map((p) => {
      const vis = p.privacy === 'private' ? 'Private' : p.privacy === 'public_to_workspace' ? 'Public' : 'Unknown';
      return `${p.name} (${vis})`;
    }).join('; ');
    const portfolios = (f.portfolios || []).map((p) => p.name).join('; ');
    const goals      = (f.goals      || []).map((g) => g.name).join('; ');
    const options = (f.enum_options || []).map((o) => {
      let s = o.name;
      if (o.enabled === false) s += ' (disabled)';
      return s;
    }).join('; ');
    const lastUsedKnown = state.lastUsedLoaded || f._lastUsedFetched;
    const lastUsed = f.last_used ? toShortDate(f.last_used) : (lastUsedKnown ? 'Never used' : 'Not loaded');

    csvRows.push([
      csvCell(f.name),
      csvCell(f.gid),
      csvCell(formatType(f.resource_subtype || f.type)),
      csvCell(f.description || ''),
      csvCell(f.created_by?.name),
      csvCell(f.created_at ? toShortDate(f.created_at) : ''),
      csvCell(f.is_global_to_workspace ? 'Library' : 'Local'),
      csvCell(lastUsed),
      csvCell(projects),
      csvCell(projectVisibility),
      csvCell(portfolios),
      csvCell(goals),
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

  // Log the export server-side (fire-and-forget)
  const wsName = workspaceSelect.options[workspaceSelect.selectedIndex]?.text || state.selectedWorkspaceGid;
  fetch('/api/log/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_name: wsName, field_count: rows.length }),
  }).catch(() => {}); // non-blocking, ignore network failures
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
