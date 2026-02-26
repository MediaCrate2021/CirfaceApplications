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
// Last updated by: 2026FEB26 - LMR
//-------------------------//

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const logger = require('./logger');

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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Debug-level request logging (staging only)
if (logger.isLevelEnabled('debug')) {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.debug({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
        user: req.session?.user?.name,
      }, 'request');
    });
    next();
  });
}

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

  logger.debug({ user: req.session.user?.name }, 'refreshing access token');

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

// Centralised error responder — logs and sends JSON response
function apiError(res, err, context) {
  const status = err.status || 500;
  if (status >= 500) {
    logger.error({ err, ...context }, 'internal API error');
  } else {
    logger.warn({ err: { message: err.message, status }, ...context }, 'API error');
  }
  res.status(status).json({ error: err.message });
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
    //scope: 'custom_fields:read projects:read workspaces:read users:read teams:read tasks:read',
  });

  res.redirect(`https://app.asana.com/-/oauth_authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    logger.warn({ error }, 'OAuth access denied');
    return res.redirect('/?error=access_denied');
  }

  if (state !== req.session.oauthState) {
    logger.warn('OAuth state mismatch — possible CSRF attempt');
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

    if (!tokenRes.ok) {
      logger.error({ status: tokenRes.status }, 'token exchange failed');
      return res.redirect('/?error=token_exchange_failed');
    }

    const tokenData = await tokenRes.json();

    req.session.accessToken = tokenData.access_token;
    req.session.refreshToken = tokenData.refresh_token;
    req.session.tokenExpiresAt = Date.now() + tokenData.expires_in * 1000;
    req.session.user = tokenData.data; // { id, name, email }

    logger.info({ user: tokenData.data?.name, email: tokenData.data?.email }, 'user logged in');

    res.redirect('/');
  } catch (err) {
    logger.error({ err }, 'token exchange exception');
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
  const user = req.session.user?.name;
  req.session.destroy(() => {
    logger.info({ user }, 'user logged out');
    res.redirect('/');
  });
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
    apiError(res, err, { user: req.session.user?.name, route: 'workspaces' });
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
        'has_notifications_enabled', 'precision', 'currency_code', 'format', 'asana_created_field',
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
    apiError(res, err, { user: req.session.user?.name, route: 'custom-fields' });
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
    apiError(res, err, { user: req.session.user?.name, route: 'projects' });
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
  'asana_created_field',
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
    apiError(res, err, { user: req.session.user?.name, route: 'project-custom-fields' });
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
    apiError(res, err, { user: req.session.user?.name, route: 'portfolios' });
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
    apiError(res, err, { user: req.session.user?.name, route: 'portfolio-custom-fields' });
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
    apiError(res, err, { user: req.session.user?.name, route: 'goals' });
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
    apiError(res, err, { user: req.session.user?.name, route: 'goal-custom-fields' });
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
    apiError(res, err, { user: req.session.user?.name, route: 'search-tasks' });
  }
});

// ---------------------------------------------------------------------------
// Client-side event logging
// ---------------------------------------------------------------------------

app.post('/api/log/export', requireAuth, (req, res) => {
  const { workspace_name, field_count } = req.body;
  logger.info({
    event: 'csv_export',
    user: req.session.user?.name,
    workspace: workspace_name,
    field_count,
  }, 'CSV exported');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.set('trust proxy', 1);

app.listen(PORT, '0.0.0.0', () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV || 'development', log_level: logger.level }, 'server started');
});
