//-------------------------//
// server.ts
// Code implemented by Cirface.com / MMG
//
// Express server for Migration Tool. Handles Asana OAuth authentication,
// session management, source/destination connector configuration,
// and migration execution with SSE progress streaming.
//
// Disclaimer: This code was created with the help of Claude.AI
//
// This code is part of Cirface Migration Tool
// Last updated by: 2026MAR11 - LMR
//-------------------------//

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Load .env relative to this file, regardless of cwd
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

import logger from './logger.js';
import { MondayConnector } from './connectors/monday.js';
import { TrelloConnector } from './connectors/trello.js';
import { AsanaDestination } from './destinations/asana.js';
import type { SourceConnector } from './connectors/base.js';
import type {
  FieldMappingEntry,
  MigrationReport,
  SourcePlatform,
  UserMappingEntry,
} from './src/types/index.js';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const APP_ENV = process.env.APP_ENV || process.env.NODE_ENV || 'development';
const PORT = Number(process.env.PORT) || 3000;

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

function makeSessionStore() {
  if (APP_ENV !== 'production') return undefined;
  const sessionsDir = path.join(__dirname, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const require = createRequire(import.meta.url);
  const FileStore = require('session-file-store')(session);
  return new FileStore({ path: sessionsDir, ttl: 28800, retries: 5, factor: 1, minTimeout: 100 });
}

const sessionStore = makeSessionStore();

// ---------------------------------------------------------------------------
// Extend session type
// ---------------------------------------------------------------------------

declare module 'express-session' {
  interface SessionData {
    oauthState?: string;
    returnTo?: string;
    accessToken?: string;  // OAuth token — used only as an auth gate, never for Asana API calls
    user?: { gid: string; name: string; email: string };
    sourceConfig?: { platform: SourcePlatform; token: string };
    destConfig?: { token: string; workspaceGid: string; workspaceName: string; patUserName: string };
    migrationInProgress?: boolean;
    trackingProject?: { gid: string; name: string };
    trackingPortfolio?: { gid: string; name: string };
    trackingOwner?: { gid: string; name: string };
    userMapping?: UserMappingEntry[];
    fieldMapping?: FieldMappingEntry[];
    lastReport?: MigrationReport;
  }
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: APP_ENV === 'production'
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
    secure: APP_ENV === 'production',
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
    sameSite: 'lax',
  },
}));
app.use(express.json());

// Serve Vite build output in production; in dev Vite runs separately on 5173
const distDir = path.join(__dirname, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
}
app.use(express.static(path.join(__dirname, 'public')));

// Debug request logging (staging only)
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

app.set('trust proxy', 1);

// Environment-specific logo — path is derived from a server-controlled constant,
// not user input, so the allowed set is fixed at startup time.
const LOGO_ENVS = new Set(['development', 'staging', 'production']);
const logoFile = LOGO_ENVS.has(APP_ENV) ? APP_ENV : 'development';
app.get('/logo', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'images', `logo-${logoFile}.png`));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!req.session.accessToken) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  next();
}

function apiError(res: express.Response, err: unknown, context: Record<string, unknown>): void {
  const e = err instanceof Error ? err : new Error(String(err));
  const status = Number((e as NodeJS.ErrnoException).code) || 500;
  if (status >= 500) {
    logger.error({ err: e, ...context }, 'internal API error');
  } else {
    logger.warn({ err: { message: e.message, status }, ...context }, 'API error');
  }
  res.status(status >= 100 && status < 600 ? status : 500).json({ error: e.message });
}

function makeConnector(platform: SourcePlatform, token: string): SourceConnector {
  if (platform === 'monday') return new MondayConnector(token);
  if (platform === 'trello') return new TrelloConnector(token);
  throw new Error(`Unknown platform: ${platform}`);
}

// ---------------------------------------------------------------------------
// Auth routes (Asana OAuth — same pattern as CFE)
// ---------------------------------------------------------------------------

app.get('/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  // Remember the origin so we can redirect back after OAuth (handles dev where
  // the React app runs on a different port from Express, e.g. Vite on 5173)
  const referer = req.get('referer') ?? req.get('origin');
  if (referer) {
    try {
      const url = new URL(referer);
      req.session.returnTo = url.origin; // e.g. "http://localhost:5173"
    } catch {
      // ignore malformed referer
    }
  }

  const params = new URLSearchParams({
    client_id: process.env.ASANA_CLIENT_ID!,
    redirect_uri: process.env.ASANA_REDIRECT_URI!,
    response_type: 'code',
    state,
  });

  req.session.save((err) => {
    if (err) logger.error({ err }, 'session save error on login');
    res.redirect(`https://app.asana.com/-/oauth_authorize?${params}`);
  });
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;

  const returnTo = req.session.returnTo ?? '/';

  if (error) {
    logger.warn({ error }, 'OAuth access denied');
    return res.redirect(`${returnTo}?error=access_denied`);
  }

  if (state !== req.session.oauthState) {
    logger.warn('OAuth state mismatch — possible CSRF attempt');
    return res.status(403).send('State mismatch');
  }
  delete req.session.oauthState;
  delete req.session.returnTo;

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.ASANA_CLIENT_ID!,
      client_secret: process.env.ASANA_CLIENT_SECRET!,
      redirect_uri: process.env.ASANA_REDIRECT_URI!,
      code,
    });

    const tokenRes = await fetch('https://app.asana.com/-/oauth_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!tokenRes.ok) {
      logger.error({ status: tokenRes.status }, 'token exchange failed');
      return res.redirect(`${returnTo}?error=token_exchange_failed`);
    }

    const tokenData = await tokenRes.json() as {
      access_token: string;
      data: { gid: string; name: string; email: string };
    };

    req.session.accessToken = tokenData.access_token;
    req.session.user = tokenData.data;

    logger.info({ user: tokenData.data?.name, email: tokenData.data?.email }, 'user logged in');
    res.redirect(returnTo);
  } catch (err) {
    logger.error({ err }, 'token exchange exception');
    res.redirect(`${returnTo}?error=token_exchange_failed`);
  }
});

app.get('/auth/status', (req, res) => {
  const appEnv = process.env.APP_ENV ?? 'development';
  if (req.session.accessToken) {
    return res.json({ authenticated: true, user: req.session.user, appEnv });
  }
  res.json({ authenticated: false, appEnv });
});

app.get('/auth/logout', (req, res) => {
  const user = req.session.user?.name;
  req.session.destroy(() => {
    logger.info({ user }, 'user logged out');
    res.redirect('/');
  });
});

// ---------------------------------------------------------------------------
// Session state route
// ---------------------------------------------------------------------------

app.get('/api/session/state', requireAuth, (req, res) => {
  res.json({
    authenticated: true,
    user: req.session.user,
    sourceConnected: !!req.session.sourceConfig,
    sourcePlatform: req.session.sourceConfig?.platform ?? null,
    destConnected: !!req.session.destConfig,
    destWorkspaceName: req.session.destConfig?.workspaceName ?? null,
    trackingProjectId: req.session.trackingProject?.gid ?? null,
    trackingProjectName: req.session.trackingProject?.name ?? null,
    userMappingDone: !!(req.session.userMapping?.length),
    lastReport: req.session.lastReport ?? null,
  });
});

// ---------------------------------------------------------------------------
// Source connector routes
// ---------------------------------------------------------------------------

app.post('/api/source/connect', requireAuth, async (req, res) => {
  const { platform, token } = req.body as { platform: SourcePlatform; token: string };

  if (!platform || !token) {
    return res.status(400).json({ error: 'platform and token are required' });
  }

  try {
    const connector = makeConnector(platform, token);
    const { workspaceName } = await connector.testConnection();
    req.session.sourceConfig = { platform, token };
    logger.info({ user: req.session.user?.name, platform, workspaceName }, 'source connected');
    res.json({ ok: true, workspaceName });
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'source/connect' });
  }
});

app.get('/api/source/users', requireAuth, async (req, res) => {
  if (!req.session.sourceConfig) return res.status(400).json({ error: 'Source not connected' });
  try {
    const { platform, token } = req.session.sourceConfig;
    const connector = makeConnector(platform, token);
    const users = await connector.getUsers();
    res.json(users);
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'source/users' });
  }
});

app.get('/api/source/projects', requireAuth, async (req, res) => {
  if (!req.session.sourceConfig) return res.status(400).json({ error: 'Source not connected' });
  try {
    const { platform, token } = req.session.sourceConfig;
    const connector = makeConnector(platform, token);
    const projects = await connector.getProjects();
    res.json(projects);
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'source/projects' });
  }
});

// Returns the normalised field list for a specific source project (used by FieldMapping step)
app.get('/api/source/project-fields', requireAuth, async (req, res) => {
  if (!req.session.sourceConfig) return res.status(400).json({ error: 'Source not connected' });
  const { projectId } = req.query as { projectId?: string };
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });
  try {
    const { platform, token } = req.session.sourceConfig;
    const connector = makeConnector(platform, token);
    const fields = await connector.getProjectFields(projectId);
    res.json(fields);
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'source/project-fields' });
  }
});

// ---------------------------------------------------------------------------
// Destination (Asana) routes
// ---------------------------------------------------------------------------

app.post('/api/destination/connect', requireAuth, async (req, res) => {
  const { token } = req.body as { token: string };
  if (!token) return res.status(400).json({ error: 'token is required' });

  try {
    const dest = new AsanaDestination(token);
    const [workspaces, me] = await Promise.all([dest.getWorkspaces(), dest.getMe()]);
    if (!workspaces.length) throw new Error('No workspaces found for this token');
    const workspace = workspaces[0];
    req.session.destConfig = {
      token,
      workspaceGid: workspace.gid,
      workspaceName: workspace.name,
      patUserName: me.name,
    };
    logger.info({ user: req.session.user?.name, workspace: workspace.name, patUser: me.name }, 'destination connected');
    res.json({ ok: true, workspaceGid: workspace.gid, workspaceName: workspace.name });
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'destination/connect' });
  }
});

app.get('/api/destination/users', requireAuth, async (req, res) => {
  if (!req.session.destConfig) return res.status(400).json({ error: 'Destination not connected' });
  try {
    const { token, workspaceGid } = req.session.destConfig;
    const dest = new AsanaDestination(token);
    const users = await dest.getUsers(workspaceGid);
    res.json(users);
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'destination/users' });
  }
});

app.get('/api/destination/teams', requireAuth, async (req, res) => {
  if (!req.session.destConfig) return res.status(400).json({ error: 'Destination not connected' });
  try {
    const { token, workspaceGid } = req.session.destConfig;
    const dest = new AsanaDestination(token);
    const teams = await dest.getTeams(workspaceGid);
    res.json(teams);
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'destination/teams' });
  }
});

app.get('/api/destination/projects', requireAuth, async (req, res) => {
  if (!req.session.destConfig) return res.status(400).json({ error: 'Destination not connected' });
  try {
    const { token, workspaceGid } = req.session.destConfig;
    const { teamGid } = req.query as { teamGid?: string };
    const dest = new AsanaDestination(token);
    const projects = await dest.getProjects(workspaceGid, teamGid);
    res.json(projects);
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'destination/projects' });
  }
});

app.get('/api/destination/fields', requireAuth, async (req, res) => {
  if (!req.session.destConfig) return res.status(400).json({ error: 'Destination not connected' });
  try {
    const { token, workspaceGid } = req.session.destConfig;
    const dest = new AsanaDestination(token);
    const fields = await dest.getOrgWideFields(workspaceGid);
    res.json(fields);
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'destination/fields' });
  }
});

// Validate and look up a single project by GID (used by tracking project step and anywhere a URL is pasted)
app.get('/api/destination/project', requireAuth, async (req, res) => {
  if (!req.session.destConfig) return res.status(400).json({ error: 'Destination not connected' });
  const { gid } = req.query as { gid?: string };
  if (!gid) return res.status(400).json({ error: 'gid is required' });
  try {
    const dest = new AsanaDestination(req.session.destConfig.token);
    const project = await dest.getProjectByGid(gid);
    res.json(project);
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'destination/project' });
  }
});

// Get custom fields attached to a specific destination project (for existing-project field mapping)
app.get('/api/destination/project-fields', requireAuth, async (req, res) => {
  if (!req.session.destConfig) return res.status(400).json({ error: 'Destination not connected' });
  const { projectGid } = req.query as { projectGid?: string };
  if (!projectGid) return res.status(400).json({ error: 'projectGid is required' });
  try {
    const dest = new AsanaDestination(req.session.destConfig.token);
    const fields = await dest.getProjectFields(projectGid);
    res.json(fields);
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'destination/project-fields' });
  }
});

// Validate and look up a single portfolio by GID
app.get('/api/destination/portfolio', requireAuth, async (req, res) => {
  if (!req.session.destConfig) return res.status(400).json({ error: 'Destination not connected' });
  const { gid } = req.query as { gid?: string };
  if (!gid) return res.status(400).json({ error: 'gid is required' });
  try {
    const dest = new AsanaDestination(req.session.destConfig.token);
    const portfolio = await dest.getPortfolioByGid(gid);
    res.json(portfolio);
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'destination/portfolio' });
  }
});

// ---------------------------------------------------------------------------
// Tracking project / portfolio
// ---------------------------------------------------------------------------

app.post('/api/session/tracking-project', requireAuth, (req, res) => {
  const { gid, name } = req.body as { gid: string; name: string };
  if (!gid || !name) return res.status(400).json({ error: 'gid and name are required' });
  req.session.trackingProject = { gid, name };
  res.json({ ok: true });
});

app.post('/api/session/tracking-portfolio', requireAuth, (req, res) => {
  const { gid, name } = req.body as { gid: string | null; name: string | null };
  req.session.trackingPortfolio = gid && name ? { gid, name } : undefined;
  res.json({ ok: true });
});

app.post('/api/session/tracking-owner', requireAuth, (req, res) => {
  const { gid, name } = req.body as { gid: string | null; name: string | null };
  req.session.trackingOwner = gid && name ? { gid, name } : undefined;
  res.json({ ok: true });
});

// Look up a single Asana user by GID, email, or display name
app.get('/api/destination/user', requireAuth, async (req, res) => {
  if (!req.session.destConfig) return res.status(400).json({ error: 'Destination not connected' });
  const { q } = req.query as { q?: string };
  if (!q?.trim()) return res.status(400).json({ error: 'q is required' });
  const query = q.trim();
  try {
    const { token, workspaceGid } = req.session.destConfig;
    const dest = new AsanaDestination(token);
    // Numeric GID — look up directly
    if (/^\d+$/.test(query)) {
      const user = await dest.getUserByGid(query);
      return res.json(user);
    }
    // Email or name — search workspace users
    const users = await dest.getUsers(workspaceGid);
    const lower = query.toLowerCase();
    const match =
      users.find((u) => u.email?.toLowerCase() === lower) ??
      users.find((u) => u.name.toLowerCase() === lower) ??
      users.find((u) => u.name.toLowerCase().includes(lower));
    if (!match) return res.status(404).json({ error: `No Asana user found matching "${query}".` });
    res.json({ gid: match.gid, name: match.name });
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'destination/user' });
  }
});

// ---------------------------------------------------------------------------
// Mapping persistence
// ---------------------------------------------------------------------------

app.post('/api/session/user-mapping', requireAuth, (req, res) => {
  const { mapping } = req.body as { mapping: UserMappingEntry[] };
  if (!Array.isArray(mapping)) return res.status(400).json({ error: 'mapping must be an array' });
  req.session.userMapping = mapping;
  res.json({ ok: true });
});

app.post('/api/session/field-mapping', requireAuth, (req, res) => {
  const { mapping } = req.body as { mapping: FieldMappingEntry[] };
  if (!Array.isArray(mapping)) return res.status(400).json({ error: 'mapping must be an array' });
  req.session.fieldMapping = mapping;
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Migration — streaming via SSE
// ---------------------------------------------------------------------------

app.post('/api/migrate', requireAuth, async (req, res) => {
  const { sourceProjectId, destProjectGid, destProjectName, destTeamGid, isNewProject } = req.body as {
    sourceProjectId: string;
    destProjectGid: string;
    destProjectName?: string;
    destTeamGid?: string;
    isNewProject: boolean;
  };

  if (!req.session.sourceConfig) return res.status(400).json({ error: 'Source not connected' });
  if (!req.session.destConfig) return res.status(400).json({ error: 'Destination not connected' });
  if (!req.session.userMapping) return res.status(400).json({ error: 'User mapping not set' });
  if (!req.session.fieldMapping) return res.status(400).json({ error: 'Field mapping not set' });
  if (req.session.migrationInProgress) return res.status(409).json({ error: 'A migration is already running' });

  req.session.migrationInProgress = true;

  // Switch to SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const { platform, token: sourceToken } = req.session.sourceConfig;
    const { token: destToken, workspaceGid } = req.session.destConfig;

    send('info', { message: `Fetching source project from ${platform}...` });
    const connector = makeConnector(platform, sourceToken);
    const project = await connector.getProjectData(sourceProjectId);

    send('info', { message: `Loaded ${project.tasks.length} tasks` });

    const dest = new AsanaDestination(destToken);
    const report = await dest.migrate(project, {
      destProjectGid: isNewProject ? '' : destProjectGid,
      destProjectName: isNewProject ? destProjectName : undefined,
      destTeamGid: isNewProject ? destTeamGid : undefined,
      destWorkspaceGid: workspaceGid,
      userMapping: req.session.userMapping,
      fieldMapping: req.session.fieldMapping,
      trackingProjectGid: req.session.trackingProject?.gid,
      trackingPortfolioGid: req.session.trackingPortfolio?.gid,
      projectOwnerGid: req.session.trackingOwner?.gid,
      sourcePlatform: platform,
      writerName: req.session.destConfig.patUserName,
      onProgress: (event) => send(event.type, event),
    });

    req.session.lastReport = report;
    req.session.migrationInProgress = false;
    logger.info({
      user: req.session.user?.name,
      source: project.name,
      dest: destProjectName ?? destProjectGid,
      tasks: report.migratedTasks,
      errors: report.errors,
    }, 'migration complete');

    send('complete', report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, user: req.session.user?.name }, 'migration failed');
    req.session.migrationInProgress = false;
    send('error', { message: msg });
  } finally {
    res.end();
  }
});

// ---------------------------------------------------------------------------
// Dev notes (development + staging only)
// ---------------------------------------------------------------------------

app.get('/dev-notes', async (_req, res) => {
  const appEnv = process.env.APP_ENV ?? 'development';
  if (appEnv === 'production') return res.status(404).send('Not found');

  const notesPath = path.join(__dirname, 'DEV_NOTES.md');
  let md: string;
  try {
    md = await fs.promises.readFile(notesPath, 'utf-8');
  } catch {
    return res.status(404).send('DEV_NOTES.md not found');
  }

  // Minimal HTML wrapper — no markdown parser dependency needed
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Dev Notes — Migration Tool</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 860px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #222; }
    h1 { color: #293556; }
    h2 { color: #293556; border-bottom: 2px solid #eee; padding-bottom: 6px; margin-top: 2em; }
    h3 { color: #555; }
    code { background: #f4f4f4; padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }
    pre { background: #f4f4f4; padding: 12px 16px; border-radius: 6px; overflow-x: auto; }
    hr { border: none; border-top: 1px solid #ddd; margin: 2em 0; }
    .back { display: inline-block; margin-bottom: 1.5em; color: #293556; text-decoration: none; font-weight: 600; }
    .back:hover { text-decoration: underline; }
    .env-badge { display: inline-block; background: #ffa100; color: #fff; padding: 2px 10px; border-radius: 12px; font-size: 0.8em; font-weight: 700; margin-left: 10px; vertical-align: middle; }
  </style>
</head>
<body>
  <a href="/" class="back">← Back to Migration Tool</a>
  <span class="env-badge">${appEnv}</span>
  <pre style="white-space:pre-wrap;font-family:inherit;background:none;padding:0">${md.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
</body>
</html>`;

  res.type('html').send(html);
});

// ---------------------------------------------------------------------------
// SPA fallback — must be last
// ---------------------------------------------------------------------------

app.get('*', (_req, res) => {
  const index = path.join(__dirname, 'dist', 'index.html');
  if (fs.existsSync(index)) {
    res.sendFile(index);
  } else {
    res.status(404).send('Not found — run npm run build first, or use npm run dev');
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Fail hard in production if required secrets/config are not set.
// Catches misconfigured deployments before any requests are served.
if (APP_ENV === 'production') {
  const required = [
    'SESSION_SECRET',
    'ALLOWED_ORIGIN',
    'ASANA_CLIENT_ID',
    'ASANA_CLIENT_SECRET',
    'ASANA_REDIRECT_URI',
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    logger.fatal({ missing }, 'Required environment variables are not set — refusing to start');
    process.exit(1);
  }
}

app.listen(PORT, '0.0.0.0', () => {
  logger.info({ port: PORT, env: APP_ENV, log_level: logger.level }, 'server started');
});
