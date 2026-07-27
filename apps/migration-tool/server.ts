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
import { MondayConnector } from '@cirface/core/connectors/monday';
import { TrelloConnector } from '@cirface/core/connectors/trello';
import { SmartsheetConnector } from '@cirface/core/connectors/smartsheet';
import { AsanaConnector } from '@cirface/core/connectors/asana';
import { WrikeConnector } from '@cirface/core/connectors/wrike';
import { WorkfrontConnector } from '@cirface/core/connectors/workfront';
import { AsanaDestination } from '@cirface/core/destinations/asana';
import type { SourceConnector } from '@cirface/core/connectors/base';
import type {
  AnalysisReport,
  FieldMappingEntry,
  MigrationReport,
  NormalisedProject,
  NormalisedTask,
  SectionMappingEntry,
  SourcePlatform,
  UserMappingEntry,
} from '@cirface/core/types';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const APP_ENV = process.env.APP_ENV || process.env.NODE_ENV || 'development';
const PORT = Number(process.env.PORT) || 3000;

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

function makeSessionStore() {
  // In-memory store for all environments — sufficient for this internal tool.
  // Sessions are lost on redeploy (users re-authenticate), which is acceptable.
  return undefined;
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
    trackingProject?: { gid: string; name: string; tokenSource: 'pat' | 'oauth' };
    trackingPortfolio?: { gid: string; name: string };
    trackingOwner?: { gid: string; name: string };
    projectOwner?: { gid: string; name: string }; // owner assigned after creating a new project
    userMapping?: UserMappingEntry[];
    fieldMapping?: FieldMappingEntry[];
    sectionMapping?: SectionMappingEntry[];
    externalIdDestFieldGid?: string | null;
    cachedProject?: { id: string; data: NormalisedProject };
    lastReport?: MigrationReport;
    lastMigrationError?: string;
    analysisInProgress?: boolean;
    lastAnalysisReport?: AnalysisReport;
  }
}

// ---------------------------------------------------------------------------
// In-memory cancel controllers — one per active migration session
// ---------------------------------------------------------------------------

const migrationControllers = new Map<string, AbortController>();

// ---------------------------------------------------------------------------
// Completed-report cache — survives session loss within the same process.
// Keyed by session ID. Entries expire after 2 hours.
// This handles the case where Railway recycles the session store (or the cookie
// expires) after a long migration, but before the UI polls for the result.
// ---------------------------------------------------------------------------

interface CachedReport {
  report: MigrationReport;
  expiresAt: number;
}
const completedReports = new Map<string, CachedReport>();
const REPORT_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function cacheReport(sessionId: string, report: MigrationReport) {
  completedReports.set(sessionId, { report, expiresAt: Date.now() + REPORT_CACHE_TTL_MS });
  // Opportunistically evict expired entries so the map doesn't grow unbounded.
  for (const [id, entry] of completedReports) {
    if (entry.expiresAt < Date.now()) completedReports.delete(id);
  }
}

function getCachedReport(sessionId: string): MigrationReport | null {
  const entry = completedReports.get(sessionId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) { completedReports.delete(sessionId); return null; }
  return entry.report;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countProjectItems(project: NormalisedProject) {
  let topLevelAttachments = 0;
  let subtaskAttachments = 0;
  const countDescendants = (task: NormalisedTask, depth: number): { subtasks: number; comments: number; attachments: number; dependencies: number } => {
    if (depth === 0) topLevelAttachments += task.attachments.length;
    else subtaskAttachments += task.attachments.length;
    let subtasks = 0, comments = task.comments.length, attachments = task.attachments.length, dependencies = task.dependencyIds.length;
    for (const child of task.subtasks) {
      subtasks++;
      const c = countDescendants(child, depth + 1);
      subtasks += c.subtasks;
      comments += c.comments;
      attachments += c.attachments;
      dependencies += c.dependencies;
    }
    return { subtasks, comments, attachments, dependencies };
  };
  let subtasks = 0, comments = 0, attachments = 0, dependencies = 0;
  for (const task of project.tasks) {
    const c = countDescendants(task, 0);
    subtasks += c.subtasks;
    comments += c.comments;
    attachments += c.attachments;
    dependencies += c.dependencies;
  }
  logger.debug(
    { projectId: project.id, total: attachments, topLevel: topLevelAttachments, subtask: subtaskAttachments },
    'countProjectItems: attachment breakdown',
  );
  return { tasks: project.tasks.length, subtasks, comments, attachments, dependencies, statusUpdates: project.statusUpdates?.length ?? 0 };
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
  res.sendFile(path.join(__dirname, '..', '..', 'packages', 'core', 'public', 'images', `logo-${logoFile}.png`));
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
  if (platform === 'smartsheet') return new SmartsheetConnector(token);
  if (platform === 'asana') return new AsanaConnector(token);
  if (platform === 'wrike')     return new WrikeConnector(token);
  if (platform === 'workfront') return new WorkfrontConnector(token);
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
  res.set('Cache-Control', 'no-store');
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

app.get('/api/source/workspaces', requireAuth, async (req, res) => {
  if (!req.session.sourceConfig) return res.status(400).json({ error: 'Source not connected' });
  try {
    const { platform, token } = req.session.sourceConfig;
    const connector = makeConnector(platform, token);
    if (!connector.getWorkspaces) return res.json([]);
    const workspaces = await connector.getWorkspaces();
    res.json(workspaces);
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'source/workspaces' });
  }
});

app.get('/api/source/teams', requireAuth, async (req, res) => {
  if (!req.session.sourceConfig) return res.status(400).json({ error: 'Source not connected' });
  try {
    const { platform, token } = req.session.sourceConfig;
    const { workspaceId } = req.query as { workspaceId?: string };
    const connector = makeConnector(platform, token);
    if (!connector.getTeams) return res.json([]);
    const teams = await connector.getTeams(workspaceId);
    res.json(teams);
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'source/teams' });
  }
});

app.get('/api/source/projects', requireAuth, async (req, res) => {
  if (!req.session.sourceConfig) return res.status(400).json({ error: 'Source not connected' });
  try {
    const { platform, token } = req.session.sourceConfig;
    const { workspaceId, teamId } = req.query as { workspaceId?: string; teamId?: string };
    const connector = makeConnector(platform, token);
    const projects = await connector.getProjects(workspaceId, teamId);
    res.json(projects);
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'source/projects' });
  }
});

// Look up a single source project by ID — used when the user pastes a sheet ID or link
// directly rather than selecting from the workspace list (Smartsheet only for now).
app.get('/api/source/project-info', requireAuth, async (req, res) => {
  if (!req.session.sourceConfig) return res.status(400).json({ error: 'Source not connected' });
  const { projectId } = req.query as { projectId?: string };
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });
  try {
    const { platform, token } = req.session.sourceConfig;
    const connector = makeConnector(platform, token);
    if (platform === 'smartsheet') {
      const { SmartsheetConnector } = await import('./connectors/smartsheet.js');
      const ss = new SmartsheetConnector(token);
      const info = await ss.getProjectInfo(projectId);
      res.json(info);
    } else {
      // Fallback for other platforms — scan the project list
      const projects = await connector.getProjects();
      const found = projects.find((p) => p.id === projectId);
      if (!found) return res.status(404).json({ error: 'Project not found' });
      res.json(found);
    }
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'source/project-info' });
  }
});

// Returns the normalised field list for a specific source project (used by FieldMapping step).
// For Monday, also fetches subitem fields and merges in any that don't already exist by name.
app.get('/api/source/project-fields', requireAuth, async (req, res) => {
  if (!req.session.sourceConfig) return res.status(400).json({ error: 'Source not connected' });
  const { projectId } = req.query as { projectId?: string };
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });
  try {
    const { platform, token } = req.session.sourceConfig;
    const connector = makeConnector(platform, token);
    const fields = await connector.getProjectFields(projectId);

    if (platform === 'monday') {
      try {
        const { MondayConnector } = await import('./connectors/monday.js');
        const mondayConnector = new MondayConnector(token);
        const subitemFields = await mondayConnector.getSubitemFields(projectId);
        logger.info({ projectId, subitemFieldCount: subitemFields.length, subitemFields }, 'subitem fields fetched');
        // Deduplicate by ID only — if the sub-board reuses the exact same column ID as the
        // parent board, skip it (same field, already present). If the sub-board has a field
        // with the same NAME but a different ID (Monday creates a parallel column), include it
        // as a separate entry marked isSubitemField so the user can map it explicitly.
        const existingIds = new Set(fields.map((f) => f.id));
        for (const sf of subitemFields) {
          if (!existingIds.has(sf.id)) {
            fields.push({ ...sf, isSubitemField: true });
          }
        }
      } catch (err) {
        logger.warn({ err, projectId }, 'failed to fetch subitem fields');
      }
    }

    res.json(fields);
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'source/project-fields' });
  }
});

// Returns the section list for a specific source project (used by ProjectMapping step)
app.get('/api/source/project-sections', requireAuth, async (req, res) => {
  if (!req.session.sourceConfig) return res.status(400).json({ error: 'Source not connected' });
  const { projectId } = req.query as { projectId?: string };
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });
  try {
    let project: NormalisedProject;
    if (req.session.cachedProject?.id === projectId) {
      project = req.session.cachedProject.data;
    } else {
      const { platform, token } = req.session.sourceConfig;
      const connector = makeConnector(platform, token);
      project = await connector.getProjectData(projectId);
      req.session.cachedProject = { id: projectId, data: project };
    }
    res.json(project.sections);
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'source/project-sections' });
  }
});

// Returns task/subtask/comment/attachment counts for the review page
app.get('/api/source/project-summary', requireAuth, async (req, res) => {
  if (!req.session.sourceConfig) return res.status(400).json({ error: 'Source not connected' });
  const { projectId } = req.query as { projectId?: string };
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });
  try {
    let project: NormalisedProject;
    if (req.session.cachedProject?.id === projectId) {
      project = req.session.cachedProject.data;
    } else {
      const { platform, token } = req.session.sourceConfig;
      const connector = makeConnector(platform, token);
      project = await connector.getProjectData(projectId);
      req.session.cachedProject = { id: projectId, data: project };
    }
    res.json(countProjectItems(project));
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'source/project-summary' });
  }
});

// Returns subitem fields that have no matching entry in the current field mapping.
// Only meaningful for Monday source (other connectors return []).
app.get('/api/source/subitem-field-warnings', requireAuth, async (req, res) => {
  if (!req.session.sourceConfig) return res.status(400).json({ error: 'Source not connected' });
  const { projectId } = req.query as { projectId?: string };
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });
  try {
    const { platform, token } = req.session.sourceConfig;
    if (platform !== 'monday') return res.json([]);

    const { MondayConnector } = await import('./connectors/monday.js');
    const connector = new MondayConnector(token);
    const subitemFields = await connector.getSubitemFields(projectId);

    const mappedSourceIds = new Set((req.session.fieldMapping ?? []).map((f) => f.sourceFieldId));
    // Also consider name-matched fields as covered: at migration time, subitemFieldIdRemap
    // remaps sub-board column IDs → parent column IDs by matching on name, so a subitem
    // field named "Status" that shares a name with a mapped parent field is NOT a gap.
    const mappedSourceNames = new Set((req.session.fieldMapping ?? []).map((f) => f.sourceFieldName.toLowerCase()));
    const warnings = subitemFields
      .filter((f) => !mappedSourceIds.has(f.id) && !mappedSourceNames.has(f.name.toLowerCase()))
      .map((f) => ({ fieldId: f.id, fieldName: f.name, fieldType: f.type }));

    res.json(warnings);
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'source/subitem-field-warnings' });
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

app.get('/api/destination/workspaces', requireAuth, async (req, res) => {
  if (!req.session.destConfig) return res.status(400).json({ error: 'Destination not connected' });
  try {
    const { token } = req.session.destConfig;
    const dest = new AsanaDestination(token);
    const workspaces = await dest.getWorkspaces();
    res.json(workspaces.map((w) => ({ id: w.gid, name: w.name })));
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'destination/workspaces' });
  }
});

app.post('/api/session/dest-workspace', requireAuth, (req, res) => {
  if (!req.session.destConfig) return res.status(400).json({ error: 'Destination not connected' });
  const { workspaceGid, workspaceName } = req.body as { workspaceGid: string; workspaceName: string };
  if (!workspaceGid || !workspaceName) return res.status(400).json({ error: 'workspaceGid and workspaceName are required' });
  req.session.destConfig.workspaceGid = workspaceGid;
  req.session.destConfig.workspaceName = workspaceName;
  logger.info({ user: req.session.user?.name, workspaceGid, workspaceName }, 'destination workspace switched');
  res.json({ ok: true });
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
// Tries PAT first; if that fails and an OAuth token is available, falls back to OAuth.
app.get('/api/destination/project', requireAuth, async (req, res) => {
  if (!req.session.destConfig) return res.status(400).json({ error: 'Destination not connected' });
  const { gid } = req.query as { gid?: string };
  if (!gid) return res.status(400).json({ error: 'gid is required' });
  try {
    const dest = new AsanaDestination(req.session.destConfig.token);
    try {
      const project = await dest.getProjectByGid(gid);
      return res.json({ ...project, tokenSource: 'pat' });
    } catch (patErr) {
      // PAT failed — try OAuth token if available
      if (!req.session.accessToken) throw patErr;
      const oauthDest = new AsanaDestination(req.session.accessToken);
      const project = await oauthDest.getProjectByGid(gid);
      return res.json({ ...project, tokenSource: 'oauth' });
    }
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

// Returns sections for a specific destination Asana project
app.get('/api/destination/sections', requireAuth, async (req, res) => {
  if (!req.session.destConfig) return res.status(400).json({ error: 'Destination not connected' });
  const { projectGid } = req.query as { projectGid?: string };
  if (!projectGid) return res.status(400).json({ error: 'projectGid is required' });
  try {
    const dest = new AsanaDestination(req.session.destConfig.token);
    const sections = await dest.getSections(projectGid);
    res.json(sections);
  } catch (err) {
    apiError(res, err, { user: req.session.user?.name, route: 'destination/sections' });
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
  const { gid, name, tokenSource } = req.body as { gid: string; name: string; tokenSource: 'pat' | 'oauth' };
  if (!gid || !name) return res.status(400).json({ error: 'gid and name are required' });
  req.session.trackingProject = { gid, name, tokenSource: tokenSource ?? 'pat' };
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

app.post('/api/session/project-owner', requireAuth, (req, res) => {
  const { gid, name } = req.body as { gid: string | null; name: string | null };
  req.session.projectOwner = gid && name ? { gid, name } : undefined;
  res.json({ ok: true });
});

app.post('/api/session/reset-project', requireAuth, (req, res) => {
  req.session.cachedProject = undefined;
  req.session.fieldMapping = undefined;
  req.session.sectionMapping = undefined;
  req.session.projectOwner = undefined;
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
  const { mapping, sectionMapping, externalIdDestFieldGid } = req.body as {
    mapping: FieldMappingEntry[];
    sectionMapping?: SectionMappingEntry[];
    externalIdDestFieldGid?: string | null;
  };
  if (!Array.isArray(mapping)) return res.status(400).json({ error: 'mapping must be an array' });
  req.session.fieldMapping = mapping;
  if (Array.isArray(sectionMapping)) req.session.sectionMapping = sectionMapping;
  req.session.externalIdDestFieldGid = externalIdDestFieldGid ?? null;
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Migration — streaming via SSE
// ---------------------------------------------------------------------------

app.post('/api/migrate', requireAuth, async (req, res) => {
  const { sourceProjectId, destProjectGid, destProjectName, destTeamGid, isNewProject, skipAttachments, shellOnly } = req.body as {
    sourceProjectId: string;
    destProjectGid: string;
    destProjectName?: string;
    destTeamGid?: string;
    isNewProject: boolean;
    skipAttachments?: boolean;
    shellOnly?: boolean;
  };

  if (!req.session.sourceConfig) return res.status(400).json({ error: 'Source not connected' });
  if (!req.session.destConfig) return res.status(400).json({ error: 'Destination not connected' });
  if (!req.session.userMapping) return res.status(400).json({ error: 'User mapping not set' });
  if (!req.session.fieldMapping) return res.status(400).json({ error: 'Field mapping not set' });
  if (req.session.migrationInProgress) return res.status(409).json({ error: 'A migration is already running' });

  req.session.migrationInProgress = true;
  const cancelController = new AbortController();
  migrationControllers.set(req.sessionID, cancelController);

  // Switch to SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Keepalive — send a comment every 20s to prevent Railway's proxy from
  // closing idle SSE connections during long fetch phases or rate-limit retries.
  const keepalive = setInterval(() => { res.write(': keepalive\n\n'); }, 20_000);

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const { platform, token: sourceToken } = req.session.sourceConfig;
    const { token: destToken, workspaceGid } = req.session.destConfig;

    const connector = makeConnector(platform, sourceToken);
    // Smartsheet pre-signed URLs expire quickly. refreshAttachmentUrl needs the
    // sheet ID to re-fetch a fresh URL, but it's only set inside getProjectData.
    // When we use a cached project we skip getProjectData, so set it explicitly.
    if (platform === 'smartsheet') {
      (connector as SmartsheetConnector).setActiveSheetId(sourceProjectId);
    }
    let project: NormalisedProject;
    if (req.session.cachedProject?.id === sourceProjectId) {
      project = req.session.cachedProject.data;
      send('info', { message: `Loaded ${project.tasks.length} tasks from cache` });
    } else {
      send('info', { message: `Fetching source project from ${platform}...` });
      project = await connector.getProjectData(sourceProjectId);
      send('info', { message: `Loaded ${project.tasks.length} tasks` });
      req.session.cachedProject = { id: sourceProjectId, data: project };
    }

    // For Monday boards, build a subitem column ID → parent column ID remap by matching on name.
    // Subitems live on their own sub-board and may have different column IDs for the same field.
    let subitemFieldIdRemap: Record<string, string> = {};
    if (platform === 'monday') {
      try {
        const { MondayConnector } = await import('./connectors/monday.js');
        const mondayConnector = new MondayConnector(sourceToken);
        const [parentFields, subitemFields] = await Promise.all([
          mondayConnector.getProjectFields(sourceProjectId),
          mondayConnector.getSubitemFields(sourceProjectId),
        ]);
        const parentByName = new Map(parentFields.map((f) => [f.name.toLowerCase(), f.id]));
        for (const sf of subitemFields) {
          const parentId = parentByName.get(sf.name.toLowerCase());
          if (parentId && parentId !== sf.id) {
            subitemFieldIdRemap[sf.id] = parentId;
          }
        }
      } catch {
        // Non-fatal — migration proceeds without the remap
      }
    }

    const sourceCount = countProjectItems(project);
    logger.info({ user: req.session.user?.name, tasks: project.tasks.length }, 'migration write phase started');
    const dest = new AsanaDestination(destToken);
    const report = await dest.migrate(project, {
      destProjectGid: isNewProject ? '' : destProjectGid,
      destProjectName: isNewProject ? destProjectName : undefined,
      destTeamGid: isNewProject ? destTeamGid : undefined,
      destWorkspaceGid: workspaceGid,
      userMapping: req.session.userMapping,
      fieldMapping: req.session.fieldMapping,
      sectionMapping: req.session.sectionMapping,
      externalIdDestFieldGid: req.session.externalIdDestFieldGid,
      trackingProjectGid: req.session.trackingProject?.gid,
      trackingToken: req.session.trackingProject?.tokenSource === 'oauth' ? req.session.accessToken : undefined,
      trackingPortfolioGid: req.session.trackingPortfolio?.gid,
      projectOwnerGid: isNewProject ? req.session.projectOwner?.gid : undefined,
      sourcePlatform: platform,
      writerName: req.session.destConfig.patUserName,
      onProgress: (event) => send(event.type, event),
      cancelSignal: cancelController.signal,
      subitemFieldIdRemap,
      refreshAttachmentUrl: connector.refreshAttachmentUrl?.bind(connector),
      authenticateAttachmentUrl: connector.authenticateAttachmentUrl?.bind(connector),
      sourceCount,
      skipAttachments: skipAttachments === true,
      shellOnly: shellOnly === true,
    });

    logger.info({ user: req.session.user?.name, tasks: report.migratedTasks, subtasks: report.migratedSubtasks, attachments: report.migratedAttachments, warnings: report.warnings, errors: report.errors }, 'migration write phase complete');
    req.session.lastReport = report;
    req.session.migrationInProgress = false;
    cacheReport(req.sessionID, report);
    migrationControllers.delete(req.sessionID);
    logger.info({
      user: req.session.user?.name,
      source: project.name,
      dest: destProjectName ?? destProjectGid,
      tasks: report.migratedTasks,
      cancelled: report.cancelled ?? false,
      errors: report.errors,
    }, 'migration complete');

    send('complete', report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, user: req.session.user?.name }, 'migration failed');
    req.session.migrationInProgress = false;
    req.session.lastMigrationError = msg;
    migrationControllers.delete(req.sessionID);
    send('error', { message: msg });
  } finally {
    clearInterval(keepalive);
    res.end();
  }
});

app.get('/api/migrate/status', requireAuth, (req, res) => {
  const report = req.session.lastReport ?? getCachedReport(req.sessionID) ?? null;
  res.json({
    inProgress: req.session.migrationInProgress ?? false,
    report,
    error: req.session.lastMigrationError ?? null,
  });
});

app.post('/api/migrate/cancel', requireAuth, (req, res) => {
  const controller = migrationControllers.get(req.sessionID);
  if (!controller) return res.status(404).json({ error: 'No active migration for this session' });
  controller.abort();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Analysis — streaming via SSE (analyze-only mode)
// ---------------------------------------------------------------------------

app.get('/api/analyze', requireAuth, async (req, res) => {
  if (!req.session.sourceConfig) return res.status(400).json({ error: 'Source not connected' });
  if (req.session.analysisInProgress) return res.status(409).json({ error: 'An analysis is already running' });

  const { projectIds: projectIdsRaw, trackingProjectGid, trackingPortfolioGid } = req.query as {
    projectIds?: string;
    trackingProjectGid?: string;
    trackingPortfolioGid?: string;
  };

  let projectIds: string[];
  try {
    projectIds = JSON.parse(projectIdsRaw ?? '[]') as string[];
    if (!Array.isArray(projectIds) || projectIds.length === 0) throw new Error('empty');
  } catch {
    return res.status(400).json({ error: 'projectIds must be a non-empty JSON array' });
  }

  // Switch to SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const keepalive = setInterval(() => { res.write(': keepalive\n\n'); }, 20_000);

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  req.session.analysisInProgress = true;

  try {
    const { platform, token } = req.session.sourceConfig;
    const connector = makeConnector(platform, token);
    const startedAt = new Date().toISOString();

    const projects: AnalysisReport['projects'] = [];

    for (let i = 0; i < projectIds.length; i++) {
      const projectId = projectIds[i];
      send('info', { message: `Fetching project ${i + 1} of ${projectIds.length}…`, done: i });

      const project = await connector.getProjectData(projectId);
      const counts = countProjectItems(project);

      // Merge in subitem fields for Monday (same logic as /api/source/project-fields)
      let fields = [...project.fields];
      if (platform === 'monday') {
        try {
          const { MondayConnector } = await import('./connectors/monday.js');
          const mc = new MondayConnector(token);
          const subitemFields = await mc.getSubitemFields(projectId);
          const existingIds = new Set(fields.map((f) => f.id));
          for (const sf of subitemFields) {
            if (!existingIds.has(sf.id)) fields.push({ ...sf, isSubitemField: true });
          }
        } catch {
          // Non-fatal — proceed with parent fields only
        }
      }

      projects.push({
        projectId,
        projectName: project.name,
        ...counts,
        users: project.users.length,
        fields,
      });

      send('info', { message: `Analyzed "${project.name}" — ${counts.tasks} tasks, ${fields.length} fields`, done: i + 1 });
    }

    const report: AnalysisReport = {
      startedAt,
      completedAt: new Date().toISOString(),
      sourcePlatform: platform,
      projects,
    };

    // Save report to tracking project if configured
    if (trackingProjectGid?.trim()) {
      if (!req.session.destConfig) {
        send('warning', { message: 'Asana not connected — skipping report save' });
      } else {
        send('info', { message: 'Saving report to Asana tracking project…' });
        try {
          const dest = new AsanaDestination(req.session.destConfig.token);
          const trackingToken = req.session.trackingProject?.tokenSource === 'oauth'
            ? req.session.accessToken
            : undefined;
          const taskGid = await dest.writeAnalysisReport(report, {
            trackingProjectGid: trackingProjectGid.trim(),
            trackingToken,
            writerName: req.session.destConfig.patUserName,
          });
          if (taskGid) {
            report.trackingTaskGid = taskGid;
            send('info', { message: 'Report saved to tracking project' });
          }
        } catch (err) {
          send('warning', { message: `Could not save report to Asana: ${(err as Error).message}` });
          logger.error({ err }, 'failed to write analysis tracking task');
        }

        // Add to tracking portfolio if configured
        if (trackingPortfolioGid?.trim() && report.trackingTaskGid) {
          // portfolios hold projects, not tasks — skip silently for analysis mode
        }
      }
    }

    req.session.analysisInProgress = false;
    req.session.lastAnalysisReport = report;
    logger.info({ user: req.session.user?.name, projects: projects.length, platform }, 'analysis complete');

    send('complete', report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, user: req.session.user?.name }, 'analysis failed');
    req.session.analysisInProgress = false;
    send('error-msg', { message: msg });
  } finally {
    clearInterval(keepalive);
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

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException — process will exit');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'unhandledRejection — process will exit');
  process.exit(1);
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info({ port: PORT, env: APP_ENV, log_level: logger.level }, 'server started');
});
