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
    sourceConfig?: { platform: SourcePlatform; token: string };
    lastAnalysisReport?: AnalysisReport;
    analysisInProgress?: boolean;
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

app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Source connection
// ---------------------------------------------------------------------------

app.post('/api/source/connect', async (req, res) => {
  const { platform, token } = req.body as { platform: SourcePlatform; token: string };

  if (!platform || !token) {
    return res.status(400).json({ error: 'platform and token are required' });
  }

  try {
    const connector = makeConnector(platform, token);
    await connector.testConnection();
    req.session.sourceConfig = { platform, token };
    req.session.lastAnalysisReport = undefined;
    req.session.analysisInProgress = false;
    logger.info({ platform }, 'source connected');
    res.json({ ok: true, platform });
  } catch (err) {
    apiError(res, err, { route: 'POST /api/source/connect', platform });
  }
});

app.get('/api/source/status', (req, res) => {
  if (req.session.sourceConfig) {
    res.json({ connected: true, platform: req.session.sourceConfig.platform });
  } else {
    res.json({ connected: false });
  }
});

app.post('/api/source/disconnect', (req, res) => {
  req.session.sourceConfig = undefined;
  req.session.lastAnalysisReport = undefined;
  res.json({ ok: true });
});

app.get('/api/source/workspaces', requireSourceConnected, async (req, res) => {
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

app.get('/api/source/projects', requireSourceConnected, async (req, res) => {
  try {
    const { platform, token } = req.session.sourceConfig!;
    const { workspaceId } = req.query as { workspaceId?: string };
    const connector = makeConnector(platform, token);
    const projects = await connector.getProjects(workspaceId);
    res.json(projects);
  } catch (err) {
    apiError(res, err, { route: 'GET /api/source/projects' });
  }
});

// ---------------------------------------------------------------------------
// Analysis — streaming via SSE
// ---------------------------------------------------------------------------

app.get('/api/analyze', requireSourceConnected, async (req, res) => {
  if (req.session.analysisInProgress) {
    return res.status(409).json({ error: 'An analysis is already running' });
  }

  const { projectIds: projectIdsRaw } = req.query as { projectIds?: string };

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
    const { platform, token } = req.session.sourceConfig!;
    const connector = makeConnector(platform, token);
    const startedAt = new Date().toISOString();
    const projects: AnalysisReport['projects'] = [];

    for (let i = 0; i < projectIds.length; i++) {
      const projectId = projectIds[i];
      send('info', { message: `Fetching project ${i + 1} of ${projectIds.length}…`, done: i });

      const project = await connector.getProjectData(projectId);
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

      projects.push({
        projectId,
        projectName: project.name,
        ...counts,
        users: project.users.length,
        fields,
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
    };

    // Phase 5: silently post to Cirface's Asana tracking project
    const cirfacePat = process.env.CIRFACE_ASANA_PAT;
    const cirfaceProjectGid = process.env.CIRFACE_TRACKING_PROJECT_GID;
    if (cirfacePat && cirfaceProjectGid) {
      try {
        const dest = new AsanaDestination(cirfacePat);
        const taskGid = await dest.writeAnalysisReport(report, {
          trackingProjectGid: cirfaceProjectGid,
        });
        if (taskGid) {
          report.trackingTaskGid = taskGid;
        }
      } catch (err) {
        logger.error({ err }, 'failed to post analysis to Cirface tracking project');
        // Non-fatal — client still gets their report
      }
    }

    req.session.analysisInProgress = false;
    req.session.lastAnalysisReport = report;
    logger.info({ platform, projects: projects.length }, 'analysis complete');

    send('complete', report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'analysis failed');
    req.session.analysisInProgress = false;
    send('error-msg', { message: msg });
  } finally {
    clearInterval(keepalive);
    res.end();
  }
});

// ---------------------------------------------------------------------------
// Report download
// ---------------------------------------------------------------------------

app.get('/api/report/download', requireSourceConnected, (req, res) => {
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
