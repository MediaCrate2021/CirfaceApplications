//-------------------------//
// server.js
// Code implemented by Cirface.com / MMG
//
// Express server for Asana Custom Field Exporter - handles OAuth authentication
// and proxies API requests to Asana with token management
//
// Disclaimer: This code was created with the help of Claude.AI
//
// This code is part of Cirface Custom Field Explorer
// Last updated by: 2026FEB10 - LMR
//-------------------------//

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

// Only load file-based session store in production.
// In development, concurrent API requests cause EPERM rename conflicts on Windows.
const sessionStore = process.env.NODE_ENV === 'production'
  ? (() => {
      const FileStore = require('session-file-store')(session);
      return new FileStore({ path: path.join(__dirname, 'sessions'), ttl: 28800, retries: 5, factor: 1, minTimeout: 100 });
    })()
  : undefined; // express-session default: in-memory store

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? process.env.ALLOWED_ORIGIN
    : `http://localhost:${PORT}`,
  credentials: true,
}));

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
    sameSite: 'lax',
  },
}));

app.use(express.static(path.join(__dirname, 'public')));

// Serve environment-specific logo
app.get('/logo', (_req, res) => {
  const env = process.env.NODE_ENV || 'development';
  res.sendFile(path.join(__dirname, 'public', 'images', `logo-${env}.png`));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ASANA_BASE = 'https://app.asana.com/api/1.0';

async function asanaFetch(apiPath, accessToken, queryParams = {}) {
  const url = new URL(`${ASANA_BASE}${apiPath}`);
  for (const [k, v] of Object.entries(queryParams)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = body.errors?.[0]?.message || `Asana API error (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }

  return body;
}

async function ensureFreshToken(req) {
  if (!req.session.tokenExpiresAt) return;
  const now = Date.now();
  if (now < req.session.tokenExpiresAt - 60_000) return; // still valid

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ASANA_CLIENT_ID,
    client_secret: process.env.ASANA_CLIENT_SECRET,
    refresh_token: req.session.refreshToken,
  });

  const res = await fetch('https://app.asana.com/-/oauth_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const err = new Error('Token refresh failed');
    err.status = 401;
    throw err;
  }

  const data = await res.json();
  req.session.accessToken = data.access_token;
  req.session.refreshToken = data.refresh_token;
  req.session.tokenExpiresAt = Date.now() + data.expires_in * 1000;
}

function requireAuth(req, res, next) {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

app.get('/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: process.env.ASANA_CLIENT_ID,
    redirect_uri: process.env.ASANA_REDIRECT_URI,
    response_type: 'code',
    state,
   //scope:  'default',//'custom_fields:read projects:read workspaces:read users:read teams:read tasks:read',

  });

  res.redirect(`https://app.asana.com/-/oauth_authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.redirect('/?error=access_denied');

  if (state !== req.session.oauthState) {
    return res.status(403).send('State mismatch');
  }
  delete req.session.oauthState;

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.ASANA_CLIENT_ID,
      client_secret: process.env.ASANA_CLIENT_SECRET,
      redirect_uri: process.env.ASANA_REDIRECT_URI,
      code,
    });

    const tokenRes = await fetch('https://app.asana.com/-/oauth_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!tokenRes.ok) return res.redirect('/?error=token_exchange_failed');

    const tokenData = await tokenRes.json();

    req.session.accessToken = tokenData.access_token;
    req.session.refreshToken = tokenData.refresh_token;
    req.session.tokenExpiresAt = Date.now() + tokenData.expires_in * 1000;
    req.session.user = tokenData.data; // { id, name, email }

    res.redirect('/');
  } catch {
    res.redirect('/?error=token_exchange_failed');
  }
});

app.get('/auth/status', (req, res) => {
  if (req.session.accessToken) {
    return res.json({ authenticated: true, user: req.session.user });
  }
  res.json({ authenticated: false });
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ---------------------------------------------------------------------------
// API proxy routes
// ---------------------------------------------------------------------------

app.get('/api/workspaces', requireAuth, async (req, res) => {
  try {
    await ensureFreshToken(req);
    const data = await asanaFetch('/workspaces', req.session.accessToken, {
      opt_fields: 'name,is_organization',
      limit: '100',
    });
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/custom-fields', requireAuth, async (req, res) => {
  try {
    await ensureFreshToken(req);
    const { workspace_gid, offset } = req.query;
    if (!workspace_gid) return res.status(400).json({ error: 'workspace_gid required' });

    const params = {
      limit: '100',
      opt_fields: [
        'name', 'type', 'resource_subtype', 'description',
        'created_by', 'created_by.name', 'created_at',
        'is_global_to_workspace', 'enabled',
        'enum_options', 'enum_options.name', 'enum_options.color', 'enum_options.enabled',
        'has_notifications_enabled', 'precision', 'currency_code', 'format',
      ].join(','),
    };
    if (offset) params.offset = offset;

    const data = await asanaFetch(
      `/workspaces/${encodeURIComponent(workspace_gid)}/custom_fields`,
      req.session.accessToken,
      params,
    );
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/projects', requireAuth, async (req, res) => {
  try {
    await ensureFreshToken(req);
    const { workspace_gid, offset } = req.query;
    if (!workspace_gid) return res.status(400).json({ error: 'workspace_gid required' });

    const params = {
      limit: '100',
      opt_fields: 'name,privacy_setting',
      workspace: workspace_gid,
      archived: 'false',
    };
    if (offset) params.offset = offset;

    const data = await asanaFetch('/projects', req.session.accessToken, params);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Full field detail opt_fields — reused across all custom_field_settings endpoints
const FIELD_OPT_FIELDS = [
  'custom_field.gid',
  'custom_field.name',
  'custom_field.type',
  'custom_field.resource_subtype',
  'custom_field.description',
  'custom_field.created_by.name',
  'custom_field.created_at',
  'custom_field.is_global_to_workspace',
  'custom_field.enabled',
  'custom_field.enum_options.name',
  'custom_field.enum_options.color',
  'custom_field.enum_options.enabled',
  'custom_field.precision',
  'custom_field.currency_code',
  'custom_field.format',
  // Settings-object fields: when/who added this field to the resource
  'created_at',
  'created_by.name',
].join(',');

app.get('/api/project-custom-fields/:project_gid', requireAuth, async (req, res) => {
  try {
    await ensureFreshToken(req);
    const { project_gid } = req.params;

    const data = await asanaFetch(
      `/projects/${encodeURIComponent(project_gid)}/custom_field_settings`,
      req.session.accessToken,
      { opt_fields: FIELD_OPT_FIELDS, limit: '100' },
    );
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/portfolios', requireAuth, async (req, res) => {
  try {
    await ensureFreshToken(req);
    const { workspace_gid, offset } = req.query;
    if (!workspace_gid) return res.status(400).json({ error: 'workspace_gid required' });

    const params = { limit: '100', opt_fields: 'name', workspace: workspace_gid };
    if (offset) params.offset = offset;

    const data = await asanaFetch('/portfolios', req.session.accessToken, params);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/portfolio-custom-fields/:portfolio_gid', requireAuth, async (req, res) => {
  try {
    await ensureFreshToken(req);
    const { portfolio_gid } = req.params;

    const data = await asanaFetch(
      `/portfolios/${encodeURIComponent(portfolio_gid)}/custom_field_settings`,
      req.session.accessToken,
      { opt_fields: FIELD_OPT_FIELDS, limit: '100' },
    );
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/goals', requireAuth, async (req, res) => {
  try {
    await ensureFreshToken(req);
    const { workspace_gid, offset } = req.query;
    if (!workspace_gid) return res.status(400).json({ error: 'workspace_gid required' });

    const params = { limit: '100', opt_fields: 'name', workspace: workspace_gid };
    if (offset) params.offset = offset;

    const data = await asanaFetch('/goals', req.session.accessToken, params);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/goal-custom-fields/:goal_gid', requireAuth, async (req, res) => {
  try {
    await ensureFreshToken(req);
    const { goal_gid } = req.params;

    const data = await asanaFetch(
      `/goals/${encodeURIComponent(goal_gid)}/custom_field_settings`,
      req.session.accessToken,
      { opt_fields: FIELD_OPT_FIELDS, limit: '100' },
    );
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/search-tasks', requireAuth, async (req, res) => {
  try {
    await ensureFreshToken(req);
    const { workspace_gid, custom_field_gid, project_gid } = req.query;
    if (!workspace_gid || !custom_field_gid) {
      return res.status(400).json({ error: 'workspace_gid and custom_field_gid required' });
    }

    const params = {
      [`custom_fields.${custom_field_gid}.is_set`]: 'true',
      sort_by: 'modified_at',
      sort_ascending: 'false',
      limit: '1',
      opt_fields: 'modified_at',
    };
    if (project_gid) params['projects.any'] = project_gid;

    const data = await asanaFetch(
      `/workspaces/${encodeURIComponent(workspace_gid)}/tasks/search`,
      req.session.accessToken,
      params,
    );
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.set('trust proxy', 1);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Custom Field Exporter running on port ${PORT}`);
});
