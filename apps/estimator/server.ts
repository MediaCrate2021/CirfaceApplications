//-------------------------//
// server.ts
// Code implemented by Cirface.com / MMG
//
// Express server for the Cirface Migration Estimator.
// Connects to a source platform, runs analysis, and posts a copy of each
// report to Cirface's internal Asana tracking project via a service account.
//
// Disclaimer: This code was created with the help of Claude.AI
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

import logger from '@cirface/core/logger';
import { MondayConnector } from '@cirface/core/connectors/monday';
import { TrelloConnector } from '@cirface/core/connectors/trello';
import { SmartsheetConnector } from '@cirface/core/connectors/smartsheet';
import { AsanaConnector } from '@cirface/core/connectors/asana';
import { WrikeConnector } from '@cirface/core/connectors/wrike';
import { AsanaDestination } from '@cirface/core/destinations/asana';
import type { SourceConnector } from '@cirface/core/connectors/base';
import type {
  AnalysisReport,
  NormalisedProject,
  NormalisedTask,
  SourcePlatform,
} from '@cirface/core/types';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const APP_ENV = process.env.APP_ENV || process.env.NODE_ENV || 'development';
const PORT = Number(process.env.PORT) || 3001;

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

declare module 'express-session' {
  interface SessionData {
    oauthState?: string;
    oauthPlatform?: SourcePlatform;
    returnTo?: string;
    accessToken?: string;
    user?: { gid: string; name: string; email: string };
    accessApproved?: boolean;
    sourceConfig?: { platform: SourcePlatform; token: string };
    lastAnalysisReport?: AnalysisReport;
    analysisInProgress?: boolean;
  }
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();

// Must be set before session middleware so that req.secure is evaluated correctly
// when running behind Railway's HTTPS proxy. Without this, secure cookies are never
// set in production because Express doesn't trust the X-Forwarded-Proto header.
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: APP_ENV === 'production'
    ? process.env.ALLOWED_ORIGIN
    : `http://localhost:${PORT}`,
  credentials: true,
}));
app.use(session({
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

// Serve Vite build output in production; in dev Vite runs separately on 5174
const distDir = path.join(__dirname, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
}
app.use(express.static(path.join(__dirname, 'public')));

// Environment-specific logo — served from shared core assets.
// Path is derived from a server-controlled constant, not user input.
const LOGO_ENVS = new Set(['development', 'staging', 'production']);
const logoFile  = LOGO_ENVS.has(APP_ENV) ? APP_ENV : 'development';
const corePublic = path.join(__dirname, '..', '..', 'packages', 'core', 'public');
app.use(express.static(corePublic));
app.get('/logo', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(corePublic, 'images', `logo-${logoFile}.png`));
});

if (logger.isLevelEnabled('debug')) {
  app.use((req, _res, next) => {
    logger.debug({ method: req.method, path: req.path }, 'request');
    next();
  });
}

// ---------------------------------------------------------------------------
// Access list
// ---------------------------------------------------------------------------

// All three sections live inside CIRFACE_TRACKING_PROJECT_GID.
// Set the section GIDs in .env:
//   CIRFACE_RESULTS_SECTION_GID       — where analysis reports are posted
//   CIRFACE_ACCESS_LIST_SECTION_GID   — task names are approved emails / domains
//   CIRFACE_ACCESS_REQUESTS_SECTION_GID — where contact form submissions land

interface AccessListCache {
  entries: string[]; // lowercase approved emails and domains
  fetchedAt: number;
}

let accessListCache: AccessListCache | null = null;
const ACCESS_LIST_TTL_MS = 5 * 60 * 1_000; // re-fetch every 5 minutes

/**
 * Check whether an email is on the Cirface access list.
 * Each task name in the Access List section is an approved entry —
 * either an exact email (user@company.com) or a domain (company.com).
 * Returns true if CIRFACE_ACCESS_LIST_SECTION_GID is not set (open access for dev).
 */
async function isAccessApproved(email: string): Promise<boolean> {
  const pat        = process.env.CIRFACE_ASANA_PAT;
  const sectionGid = process.env.CIRFACE_ACCESS_LIST_SECTION_GID;
  if (!pat || !sectionGid) return true;

  const now = Date.now();
  if (!accessListCache || now - accessListCache.fetchedAt > ACCESS_LIST_TTL_MS) {
    try {
      const res = await fetch(
        `https://app.asana.com/api/1.0/sections/${encodeURIComponent(sectionGid)}/tasks?opt_fields=name&limit=100`,
        { headers: { Authorization: `Bearer ${pat}` } },
      );
      const json = await res.json() as { data?: Array<{ name: string }> };
      const entries = (json.data ?? [])
        .map((t) => {
          // Expected format: "Access for: user@company.com" or "Access for: company.com"
          const raw = t.name.trim().toLowerCase();
          return raw.startsWith('access for:') ? raw.replace('access for:', '').trim() : raw;
        })
        .filter(Boolean);
      accessListCache = { entries, fetchedAt: now };
      logger.info({ count: entries.length }, 'access list refreshed');
    } catch (err) {
      logger.error({ err }, 'failed to fetch access list from Asana');
      if (!accessListCache) return false;
      // use stale cache on transient error rather than blocking everyone
    }
  }

  const emailLower = email.toLowerCase();
  const domain     = emailLower.split('@')[1] ?? '';
  return accessListCache!.entries.some((e) => e === emailLower || e === domain);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!req.session.accessToken) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  next();
}

function requireSourceConnected(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!req.session.sourceConfig) {
    res.status(401).json({ error: 'Source not connected' });
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
  if (platform === 'monday')     return new MondayConnector(token);
  if (platform === 'trello')     return new TrelloConnector(token);
  if (platform === 'smartsheet') return new SmartsheetConnector(token);
  if (platform === 'asana')      return new AsanaConnector(token);
  if (platform === 'wrike')      return new WrikeConnector(token);
  throw new Error(`Unknown platform: ${platform}`);
}

function countProjectItems(project: NormalisedProject) {
  const countDescendants = (
    task: NormalisedTask,
  ): { subtasks: number; comments: number; attachments: number; dependencies: number } => {
    let subtasks = 0, comments = task.comments.length, attachments = task.attachments.length, dependencies = task.dependencyIds.length;
    for (const child of task.subtasks) {
      subtasks++;
      const c = countDescendants(child);
      subtasks += c.subtasks;
      comments += c.comments;
      attachments += c.attachments;
      dependencies += c.dependencies;
    }
    return { subtasks, comments, attachments, dependencies };
  };
  let subtasks = 0, comments = 0, attachments = 0, dependencies = 0;
  for (const task of project.tasks) {
    const c = countDescendants(task);
    subtasks += c.subtasks;
    comments += c.comments;
    attachments += c.attachments;
    dependencies += c.dependencies;
  }
  return { tasks: project.tasks.length, subtasks, comments, attachments, dependencies };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', env: APP_ENV });
});

// ---------------------------------------------------------------------------
// OAuth provider capabilities — tells the frontend which platforms have OAuth
// configured so it can show buttons vs token forms
// ---------------------------------------------------------------------------

app.get('/api/auth/providers', (_req, res) => {
  res.json({
    asana:       !!(process.env.ASANA_CLIENT_ID       && process.env.ASANA_CLIENT_SECRET),
    monday:      !!(process.env.MONDAY_CLIENT_ID      && process.env.MONDAY_CLIENT_SECRET),
    smartsheet:  !!(process.env.SMARTSHEET_CLIENT_ID  && process.env.SMARTSHEET_CLIENT_SECRET),
  });
});

// Auth status — public, used by the frontend to decide whether to show the login page
app.get('/api/auth/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const authenticated = !!req.session.accessToken;
  // Sessions created before access control was deployed won't have accessApproved set.
  // Treat as approved so existing sessions aren't invalidated on deploy.
  const accessApproved = authenticated ? (req.session.accessApproved ?? true) : false;
  res.json({
    authenticated,
    accessApproved,
    user:   req.session.user ?? null,
    appEnv: APP_ENV,
  });
});

app.post('/api/access/request', async (req, res) => {
  const { name, email, company, note } = req.body as {
    name?: string; email?: string; company?: string; note?: string;
  };

  logger.info({ name, email, company }, 'access request received');

  const pat        = process.env.CIRFACE_ASANA_PAT;
  const projectGid = process.env.CIRFACE_TRACKING_PROJECT_GID;
  const sectionGid = process.env.CIRFACE_ACCESS_REQUESTS_SECTION_GID;

  if (pat && projectGid) {
    try {
      const taskName = `Access Request: ${name ?? email ?? 'Unknown'}${company ? ` — ${company}` : ''}`;
      const notes = [
        `Name:    ${name    ?? '—'}`,
        `Email:   ${email   ?? '—'}`,
        `Company: ${company ?? '—'}`,
        note ? `\nNote:\n${note}` : '',
      ].filter(Boolean).join('\n');

      const taskBody: Record<string, unknown> = { projects: [projectGid], name: taskName, notes };
      if (sectionGid) {
        taskBody.memberships = [{ project: projectGid, section: sectionGid }];
      }

      await fetch('https://app.asana.com/api/1.0/tasks', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: taskBody }),
      });
      logger.info({ name, email }, 'access request posted to Asana');
    } catch (err) {
      logger.error({ err }, 'failed to post access request to Asana');
    }
  }

  res.json({ ok: true });
});

app.get('/api/auth/logout', (req, res) => {
  const user = req.session.user?.name;
  req.session.destroy(() => {
    logger.info({ user }, 'user logged out');
    res.redirect('/');
  });
});

// ---------------------------------------------------------------------------
// Source connection
// ---------------------------------------------------------------------------

app.post('/api/source/connect', requireAuth, async (req, res) => {
  const { platform, token: bodyToken } = req.body as { platform: SourcePlatform; token?: string };

  if (!platform) {
    return res.status(400).json({ error: 'platform is required' });
  }

  // Asana can reuse the OAuth token that authenticated the user — no PAT needed
  const token = (platform === 'asana' && !bodyToken)
    ? req.session.accessToken!
    : bodyToken;

  if (!token) {
    return res.status(400).json({ error: 'token is required' });
  }

  try {
    const connector = makeConnector(platform, token);
    await connector.testConnection();
    req.session.sourceConfig = { platform, token };
    req.session.lastAnalysisReport = undefined;
    req.session.analysisInProgress = false;
    logger.info({ platform, user: req.session.user?.name }, 'source connected');
    res.json({ ok: true, platform });
  } catch (err) {
    apiError(res, err, { route: 'POST /api/source/connect', platform });
  }
});

app.get('/api/source/status', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.session.sourceConfig) {
    res.json({ connected: true, platform: req.session.sourceConfig.platform });
  } else {
    res.json({ connected: false });
  }
});

app.post('/api/source/disconnect', requireAuth, (req, res) => {
  req.session.sourceConfig = undefined;
  req.session.lastAnalysisReport = undefined;
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// OAuth flows — Asana, Monday, Smartsheet
// Each login route stores a CSRF state token and redirects to the provider.
// Each callback exchanges the code for an access token and stores it as
// session.sourceConfig so the rest of the API works transparently.
// ---------------------------------------------------------------------------

// Helper: capture the origin of the referring React app so we can redirect
// back to it after OAuth (handles dev where Vite runs on a different port).
function captureReturnTo(req: express.Request): void {
  const referer = req.get('referer') ?? req.get('origin');
  if (referer) {
    try { req.session.returnTo = new URL(referer).origin; } catch { /* ignore */ }
  }
}

// --- Asana ---

app.get('/auth/asana/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState    = state;
  req.session.oauthPlatform = 'asana';
  captureReturnTo(req);

  const params = new URLSearchParams({
    client_id:     process.env.ASANA_CLIENT_ID!,
    redirect_uri:  process.env.ASANA_REDIRECT_URI!,
    response_type: 'code',
    state,
  });

  req.session.save((err) => {
    if (err) logger.error({ err }, 'session save error before Asana OAuth');
    res.redirect(`https://app.asana.com/-/oauth_authorize?${params}`);
  });
});

app.get('/auth/asana/callback', async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;
  const returnTo = req.session.returnTo ?? '/';

  if (error) {
    logger.warn({ error }, 'Asana OAuth access denied');
    return res.redirect(`${returnTo}?error=access_denied`);
  }
  if (state !== req.session.oauthState) {
    logger.warn('Asana OAuth state mismatch — possible CSRF attempt');
    return res.status(403).send('State mismatch');
  }
  delete req.session.oauthState;
  delete req.session.oauthPlatform;
  delete req.session.returnTo;

  try {
    const tokenRes = await fetch('https://app.asana.com/-/oauth_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     process.env.ASANA_CLIENT_ID!,
        client_secret: process.env.ASANA_CLIENT_SECRET!,
        redirect_uri:  process.env.ASANA_REDIRECT_URI!,
        code,
      }),
    });

    if (!tokenRes.ok) {
      logger.error({ status: tokenRes.status }, 'Asana token exchange failed');
      return res.redirect(`${returnTo}?error=token_exchange_failed`);
    }

    const data = await tokenRes.json() as {
      access_token: string;
      data?: { gid: string; name: string; email: string };
    };

    req.session.accessToken = data.access_token;
    req.session.user        = data.data;

    const email = data.data?.email ?? '';
    const approved = await isAccessApproved(email);
    req.session.accessApproved = approved;
    logger.info({ name: data.data?.name, email, approved }, 'user authenticated via Asana OAuth');

    req.session.save((saveErr) => {
      if (saveErr) logger.error({ err: saveErr }, 'session save error after Asana OAuth');
      res.redirect(returnTo);
    });
  } catch (err) {
    logger.error({ err }, 'Asana token exchange exception');
    res.redirect(`${returnTo}?error=token_exchange_failed`);
  }
});

// --- Monday.com ---

app.get('/auth/monday/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState    = state;
  req.session.oauthPlatform = 'monday';
  captureReturnTo(req);

  const params = new URLSearchParams({
    client_id: process.env.MONDAY_CLIENT_ID!,
    state,
  });

  req.session.save((err) => {
    if (err) logger.error({ err }, 'session save error before Monday OAuth');
    const authUrl = `https://auth.monday.com/oauth2/authorize?${params}`;
    logger.info({ authUrl }, 'Monday OAuth redirect');
    res.redirect(authUrl);
  });
});

app.get('/auth/monday/callback', async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;
  const returnTo = req.session.returnTo ?? '/';

  if (error) {
    logger.warn({ error }, 'Monday OAuth access denied');
    return res.redirect(`${returnTo}?error=access_denied`);
  }
  if (state !== req.session.oauthState) {
    logger.warn('Monday OAuth state mismatch — possible CSRF attempt');
    return res.status(403).send('State mismatch');
  }
  delete req.session.oauthState;
  delete req.session.oauthPlatform;
  delete req.session.returnTo;

  try {
    const tokenRes = await fetch('https://auth.monday.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     process.env.MONDAY_CLIENT_ID!,
        client_secret: process.env.MONDAY_CLIENT_SECRET!,
        code,
      }),
    });

    if (!tokenRes.ok) {
      logger.error({ status: tokenRes.status }, 'Monday token exchange failed');
      return res.redirect(`${returnTo}?error=token_exchange_failed`);
    }

    const data = await tokenRes.json() as { access_token: string };

    req.session.sourceConfig        = { platform: 'monday', token: data.access_token };
    req.session.lastAnalysisReport  = undefined;
    req.session.analysisInProgress  = false;
    logger.info('Monday source connected via OAuth');
    res.redirect(returnTo);
  } catch (err) {
    logger.error({ err }, 'Monday token exchange exception');
    res.redirect(`${returnTo}?error=token_exchange_failed`);
  }
});

// --- Smartsheet ---
// Note: Smartsheet OAuth requires app-review approval from their Developer Program.
// These routes are scaffolded but will only activate once SMARTSHEET_CLIENT_ID
// and SMARTSHEET_CLIENT_SECRET are set in the environment.
// Token exchange requires a SHA-256 hash of (client_secret + "|" + code).

app.get('/auth/smartsheet/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState    = state;
  req.session.oauthPlatform = 'smartsheet';
  captureReturnTo(req);

  const params = new URLSearchParams({
    client_id:     process.env.SMARTSHEET_CLIENT_ID!,
    redirect_uri:  process.env.SMARTSHEET_REDIRECT_URI!,
    response_type: 'code',
    scope:         'READ_ALL',
    state,
  });

  req.session.save((err) => {
    if (err) logger.error({ err }, 'session save error before Smartsheet OAuth');
    res.redirect(`https://app.smartsheet.com/b/authorize?${params}`);
  });
});

app.get('/auth/smartsheet/callback', async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;
  const returnTo = req.session.returnTo ?? '/';

  if (error) {
    logger.warn({ error }, 'Smartsheet OAuth access denied');
    return res.redirect(`${returnTo}?error=access_denied`);
  }
  if (state !== req.session.oauthState) {
    logger.warn('Smartsheet OAuth state mismatch — possible CSRF attempt');
    return res.status(403).send('State mismatch');
  }
  delete req.session.oauthState;
  delete req.session.oauthPlatform;
  delete req.session.returnTo;

  try {
    // Smartsheet requires a SHA-256 hash of (client_secret + "|" + code)
    const hash = crypto
      .createHash('sha256')
      .update(`${process.env.SMARTSHEET_CLIENT_SECRET}|${code}`)
      .digest('hex');

    const tokenRes = await fetch('https://api.smartsheet.com/2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     process.env.SMARTSHEET_CLIENT_ID!,
        redirect_uri:  process.env.SMARTSHEET_REDIRECT_URI!,
        code,
        hash,
      }),
    });

    if (!tokenRes.ok) {
      logger.error({ status: tokenRes.status }, 'Smartsheet token exchange failed');
      return res.redirect(`${returnTo}?error=token_exchange_failed`);
    }

    const data = await tokenRes.json() as { access_token: string };

    req.session.sourceConfig        = { platform: 'smartsheet', token: data.access_token };
    req.session.lastAnalysisReport  = undefined;
    req.session.analysisInProgress  = false;
    logger.info('Smartsheet source connected via OAuth');
    res.redirect(returnTo);
  } catch (err) {
    logger.error({ err }, 'Smartsheet token exchange exception');
    res.redirect(`${returnTo}?error=token_exchange_failed`);
  }
});

app.get('/api/source/workspaces', requireAuth, requireSourceConnected, async (req, res) => {
  try {
    const { platform, token } = req.session.sourceConfig!;
    const connector = makeConnector(platform, token);
    if (!connector.getWorkspaces) return res.json([]);
    const workspaces = await connector.getWorkspaces();
    res.json(workspaces);
  } catch (err) {
    apiError(res, err, { route: 'GET /api/source/workspaces' });
  }
});

app.get('/api/source/teams', requireAuth, requireSourceConnected, async (req, res) => {
  try {
    const { platform, token } = req.session.sourceConfig!;
    const connector = makeConnector(platform, token);
    if (!connector.getTeams) return res.json([]);
    const { workspaceId } = req.query as { workspaceId?: string };
    const teams = await connector.getTeams(workspaceId);
    res.json(teams);
  } catch (err) {
    apiError(res, err, { route: 'GET /api/source/teams' });
  }
});

app.get('/api/source/portfolios', requireAuth, requireSourceConnected, async (req, res) => {
  try {
    const { platform, token } = req.session.sourceConfig!;
    const connector = makeConnector(platform, token);
    if (!connector.getPortfolios) return res.json([]);
    const { workspaceId } = req.query as { workspaceId?: string };
    const portfolios = await connector.getPortfolios(workspaceId);
    res.json(portfolios);
  } catch (err) {
    apiError(res, err, { route: 'GET /api/source/portfolios' });
  }
});

app.get('/api/source/projects', requireAuth, requireSourceConnected, async (req, res) => {
  try {
    const { platform, token } = req.session.sourceConfig!;
    const { workspaceId, teamId, portfolioId } = req.query as { workspaceId?: string; teamId?: string; portfolioId?: string };
    const connector = makeConnector(platform, token);
    const projects = await connector.getProjects(workspaceId, teamId, portfolioId);
    res.json(projects);
  } catch (err) {
    apiError(res, err, { route: 'GET /api/source/projects' });
  }
});

// ---------------------------------------------------------------------------
// Analysis — streaming via SSE
// ---------------------------------------------------------------------------

app.get('/api/analyze', requireAuth, requireSourceConnected, async (req, res) => {
  const { projectIds: projectIdsRaw, projectMeta: projectMetaRaw } = req.query as { projectIds?: string; projectMeta?: string };

  let projectIds: string[];
  try {
    projectIds = JSON.parse(projectIdsRaw ?? '[]') as string[];
    if (!Array.isArray(projectIds) || projectIds.length === 0) throw new Error('empty');
  } catch {
    return res.status(400).json({ error: 'projectIds must be a non-empty JSON array' });
  }

  // Switch to SSE before any early-return paths so the client always gets a stream.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const keepalive = setInterval(() => { res.write(': keepalive\n\n'); }, 15_000);
  const send = (event: string, data: unknown) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* connection closed */ }
  };
  const finish = () => { clearInterval(keepalive); res.end(); };

  logger.info({
    analysisInProgress: req.session.analysisInProgress ?? false,
    hasReport: !!req.session.lastAnalysisReport,
    sessionID: req.sessionID,
    projectCount: projectIds.length,
  }, 'analyze SSE connect');

  // ── Reconnect case A: analysis already in progress (connection dropped mid-run) ──
  // Poll the session until it finishes, then forward the cached report.
  if (req.session.analysisInProgress) {
    send('info', { message: 'Reconnected — waiting for analysis to complete…' });
    const POLL_MS = 1_500;
    const MAX_WAIT_MS = 20 * 60 * 1_000; // 20 minutes
    const waitStart = Date.now();
    const poll = setInterval(() => {
      req.session.reload((err) => {
        if (err) { clearInterval(poll); finish(); return; }
        if (!req.session.analysisInProgress) {
          clearInterval(poll);
          if (req.session.lastAnalysisReport) {
            send('complete', req.session.lastAnalysisReport);
          } else {
            send('error-msg', { message: 'Analysis failed while reconnecting. Please try again.' });
          }
          finish();
        } else if (Date.now() - waitStart > MAX_WAIT_MS) {
          clearInterval(poll);
          send('error-msg', { message: 'Analysis timed out. Please go back and try again.' });
          finish();
        }
      });
    }, POLL_MS);
    req.on('close', () => clearInterval(poll));
    return;
  }

  // ── Reconnect case B: analysis already finished (client missed the complete event) ──
  // If the cached report covers the same project IDs, deliver it immediately.
  const cachedReport = req.session.lastAnalysisReport;
  if (cachedReport) {
    const cachedIds = cachedReport.projects.map((p: { projectId: string }) => p.projectId).sort().join(',');
    const requestedIds = [...projectIds].sort().join(',');
    if (cachedIds === requestedIds) {
      send('complete', cachedReport);
      finish();
      return;
    }
  }

  type ProjectMeta = { id: string; name: string; ownerName?: string; startDate?: string; endDate?: string };
  let projectMetaMap = new Map<string, ProjectMeta>();
  try {
    const meta = JSON.parse(projectMetaRaw ?? '[]') as ProjectMeta[];
    projectMetaMap = new Map(meta.map((m) => [m.id, m]));
  } catch { /* non-fatal — metadata is optional */ }

  // ── Normal path: start a new analysis ──
  req.session.lastAnalysisReport = undefined; // clear any stale report from a previous run
  req.session.analysisInProgress = true;
  // Persist immediately so reconnecting clients see analysisInProgress=true before the analysis finishes.
  // Without this, express-session only saves on res.end() (after the analysis), so a reconnect
  // that arrives mid-analysis reads a stale session and incorrectly starts a second analysis.
  await new Promise<void>((resolve) => req.session.save((err) => {
    if (err) logger.error({ err }, 'session save failed before analysis start');
    resolve();
  }));

  try {
    const { platform, token } = req.session.sourceConfig!;
    const connector = makeConnector(platform, token);
    const startedAt = new Date().toISOString();
    const projects: AnalysisReport['projects'] = [];

    for (let i = 0; i < projectIds.length; i++) {
      const projectId = projectIds[i];
      send('info', { message: `Fetching project ${i + 1} of ${projectIds.length}…`, done: i });

      // Shallow mode: subtasks are counted from their GID list without recursing
      // into each one, avoiding thousands of per-subtask API calls on large projects.
      const project = await connector.getProjectData(projectId, { shallow: true });
      const counts = countProjectItems(project);

      // Merge Monday subitem fields (Monday exposes them via a separate method)
      let fields = [...project.fields];
      if (platform === 'monday') {
        try {
          const mc = connector as MondayConnector;
          const subitemFields = await mc.getSubitemFields(projectId);
          const existingIds = new Set(fields.map((f) => f.id));
          for (const sf of subitemFields) {
            if (!existingIds.has(sf.id)) fields.push({ ...sf, isSubitemField: true });
          }
        } catch {
          // Non-fatal — proceed with parent fields only
        }
      }

      const meta = projectMetaMap.get(projectId);
      projects.push({
        projectId,
        projectName: project.name,
        ...counts,
        users: project.users.length,
        fields,
        ...(meta?.ownerName ? { ownerName: meta.ownerName } : {}),
        ...(meta?.startDate ? { startDate: meta.startDate } : {}),
        ...(meta?.endDate   ? { endDate:   meta.endDate   } : {}),
      });

      send('info', {
        message: `Analyzed "${project.name}" — ${counts.tasks} tasks, ${fields.length} fields`,
        done: i + 1,
      });
    }

    const report: AnalysisReport = {
      startedAt,
      completedAt: new Date().toISOString(),
      sourcePlatform: platform,
      projects,
      clientName:  req.session.user?.name,
      clientEmail: req.session.user?.email,
    };

    // Phase 5: silently post to Cirface's Asana tracking project
    const cirfacePat = process.env.CIRFACE_ASANA_PAT;
    const cirfaceProjectGid = process.env.CIRFACE_TRACKING_PROJECT_GID;
    if (cirfacePat && cirfaceProjectGid) {
      try {
        const dest = new AsanaDestination(cirfacePat);
        const taskGid = await dest.writeAnalysisReport(report, {
          trackingProjectGid: cirfaceProjectGid,
          resultsSectionGid: process.env.CIRFACE_RESULTS_SECTION_GID,
          writerName: req.session.user?.name,
        });
        if (taskGid) {
          report.trackingTaskGid = taskGid;
          logger.info({ taskGid, client: req.session.user?.email }, 'analysis report posted to Cirface tracking project');
        }
      } catch (err) {
        logger.error({ err }, 'failed to post analysis to Cirface tracking project');
        // Non-fatal — client still gets their report
      }
    }

    req.session.analysisInProgress = false;
    req.session.lastAnalysisReport = report;
    await new Promise<void>((resolve) => req.session.save((err) => {
      if (err) logger.error({ err }, 'session save failed after analysis complete');
      resolve();
    }));
    logger.info({ platform, projects: projects.length }, 'analysis complete');

    send('complete', report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'analysis failed');
    req.session.analysisInProgress = false;
    await new Promise<void>((resolve) => req.session.save((err2) => {
      if (err2) logger.error({ err: err2 }, 'session save failed after analysis error');
      resolve();
    }));
    send('error-msg', { message: msg });
  } finally {
    clearInterval(keepalive);
    res.end();
  }
});

// ---------------------------------------------------------------------------
// Report download
// ---------------------------------------------------------------------------

app.get('/api/report/download', requireAuth, requireSourceConnected, (req, res) => {
  const report = req.session.lastAnalysisReport;
  if (!report) {
    return res.status(404).json({ error: 'No report available. Run an analysis first.' });
  }

  const dest = new AsanaDestination('_unused_');
  const content = dest.formatAnalysisReportLog(report);
  const date = new Date().toISOString().slice(0, 10);
  const filename = `analysis-report-${date}.txt`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(content);
});

// ---------------------------------------------------------------------------
// Static fallback — serve React app for all non-API routes in production
// ---------------------------------------------------------------------------

const indexHtml = path.join(distDir, 'index.html');
app.get('*', (_req, res) => {
  if (fs.existsSync(indexHtml)) {
    res.sendFile(indexHtml);
  } else {
    res.status(404).send('Not found');
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  logger.info({ port: PORT, env: APP_ENV, log_level: logger.level }, 'estimator server started');
});
