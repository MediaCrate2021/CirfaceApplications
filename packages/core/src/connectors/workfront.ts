//-------------------------//
// connectors/workfront.ts
// Code implemented by Cirface.com / MMG
//
// Workfront source connector (API v18.0 — tasks only).
// Authentication: API Key passed as `apiKey` query param.
// Credential format: "apiKey:domain"
// Base URL: https://{domain}.my.workfront.com/attask/api/v18.0
//
// Open questions (fill in before production):
//   1. Do document downloadURLs require apiKey appended for auth?
//      If yes: authenticateAttachmentUrl() appends ?apiKey={key}
//   2. Confirm task completion status value is 'CPL' — check with client.
//   3. Confirm which project statuses to include vs. consider "archived".
//   4. Custom form/parameter field API path — getProjectFields() is stubbed.
//
// Disclaimer: This code was created with the help of Claude.AI
// This code is part of Cirface Migration Tool
//-------------------------//

import type { SourceConnector } from './base.js';
import type {
  NormalisedField,
  NormalisedProject,
  NormalisedTask,
  NormalisedComment,
  NormalisedAttachment,
  NormalisedUser,
  ProjectListItem,
} from '../types/index.js';
import logger from '../logger.js';

// ---------------------------------------------------------------------------
// Raw Workfront API types
// ---------------------------------------------------------------------------

interface WFProject {
  ID: string;
  name: string;
  description?: string;
  status?: string;
  plannedStartDate?: string;
  plannedCompletionDate?: string;
}

interface WFTask {
  ID: string;
  name: string;
  description?: string;
  status?: string;
  plannedCompletionDate?: string;
  assignedToID?: string | null;
  assignedTo?: { name?: string; emailAddr?: string } | null;
  parentID?: string | null;
  indent?: number;
  predecessors?: Array<{ predecessorID?: string }>;
}

interface WFUser {
  ID: string;
  name: string;
  emailAddr: string;
}

interface WFNote {
  ID: string;
  noteText?: string;
  entryDate?: string;
  objID?: string;
  owner?: { name?: string };
}

interface WFDocument {
  ID: string;
  name?: string;
  downloadURL?: string;
  contentType?: string;
  objID?: string;
}

interface WFSearchResponse<T> {
  data: T[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Task status value for "complete" in Workfront. Confirm with client.
const TASK_COMPLETE_STATUS = 'CPL';

// Project statuses considered "active" (not archived).
// CUR=Current, PLN=Planning, APP=Approved
// Omitted: CPL=Complete, DED=Dead/Cancelled
const ACTIVE_PROJECT_STATUSES = 'CUR,PLN,APP';

const PAGE_SIZE = 2000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Encode a URL param value, preserving `$` so Workfront pagination params
 * like `$$FIRST` and `$$LIMIT` survive URL encoding.
 */
function encodeParam(s: string): string {
  return encodeURIComponent(s).replace(/%24/g, '$');
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class WorkfrontConnector implements SourceConnector {
  readonly platform = 'workfront' as const;
  private readonly apiKey: string;
  private readonly domain: string;
  private readonly baseUrl: string;

  constructor(credential: string) {
    const colon = credential.indexOf(':');
    if (colon === -1) {
      throw new Error('Workfront credential must be formatted as "apiKey:domain"');
    }
    this.apiKey  = credential.slice(0, colon);
    this.domain  = credential.slice(colon + 1);
    this.baseUrl = `https://${this.domain}.my.workfront.com/attask/api/v18.0`;
  }

  private buildUrl(path: string, params: Record<string, string> = {}): string {
    const allParams = { apiKey: this.apiKey, ...params };
    const qs = Object.entries(allParams)
      .map(([k, v]) => `${encodeParam(k)}=${encodeParam(v)}`)
      .join('&');
    return `${this.baseUrl}${path}?${qs}`;
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = this.buildUrl(path, params);
    const res  = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err  = new Error(`Workfront ${path} → ${res.status}: ${text.slice(0, 200)}`);
      (err as NodeJS.ErrnoException).code = String(res.status);
      throw err;
    }
    return res.json() as Promise<T>;
  }

  private async getAll<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const results: T[] = [];
    let offset = 0;
    while (true) {
      const resp = await this.get<WFSearchResponse<T>>(path, {
        ...params,
        '$$FIRST': String(offset),
        '$$LIMIT': String(PAGE_SIZE),
      });
      const page = resp.data ?? [];
      results.push(...page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    return results;
  }

  // --------------------------------------------------------------------------
  // SourceConnector implementation
  // --------------------------------------------------------------------------

  async testConnection(): Promise<{ workspaceName: string }> {
    // Fetch a single project to confirm the apiKey and domain are valid.
    // /proj/search with $$LIMIT=1 is the safest general test.
    await this.get<WFSearchResponse<WFProject>>('/proj/search', {
      fields: 'ID,name',
      '$$LIMIT': '1',
    });
    logger.info({ domain: this.domain }, 'workfront connection ok');
    return { workspaceName: this.domain };
  }

  async getUsers(): Promise<NormalisedUser[]> {
    const raw = await this.getAll<WFUser>('/user/search', {
      fields: 'ID,name,emailAddr',
    });
    return raw
      .filter((u) => u.emailAddr)
      .map((u) => ({ id: u.ID, name: u.name ?? u.emailAddr, email: u.emailAddr }));
  }

  async getProjects(
    _workspaceId?: string,
    _teamId?: string,
    _portfolioId?: string,
    includeArchived?: boolean,
  ): Promise<ProjectListItem[]> {
    const params: Record<string, string> = {
      fields: 'ID,name,plannedStartDate,plannedCompletionDate,status',
    };
    if (!includeArchived) {
      // Filter to active project statuses only
      params['status_Mod'] = 'in';
      params['status']     = ACTIVE_PROJECT_STATUSES;
    }
    const raw = await this.getAll<WFProject>('/proj/search', params);
    return raw.map((p) => ({
      id:        p.ID,
      name:      p.name,
      startDate: p.plannedStartDate?.slice(0, 10),
      endDate:   p.plannedCompletionDate?.slice(0, 10),
    }));
  }

  async getProjectFields(_projectId: string): Promise<NormalisedField[]> {
    // TODO: enumerate custom form fields via Workfront parameter API.
    // This requires knowing which custom forms are attached to the project's tasks,
    // then fetching /parameter objects for each form.
    // Returning empty for now — custom fields will not appear in the field mapping step.
    return [];
  }

  async getProjectData(
    projectId: string,
    options?: { shallow?: boolean },
  ): Promise<NormalisedProject> {
    // ── Project metadata ────────────────────────────────────────────────────
    const projResp = await this.get<{ data: WFProject }>(`/proj/${projectId}`, {
      fields: 'ID,name,description,plannedStartDate,plannedCompletionDate',
    });
    const proj = projResp.data;

    // ── All tasks (flat list — hierarchy reconstructed via parentID) ─────────
    const rawTasks = await this.getAll<WFTask>('/task/search', {
      projectID: projectId,
      fields:    [
        'ID', 'name', 'description', 'status',
        'plannedCompletionDate', 'plannedStartDate',
        'assignedToID', 'assignedTo', 'parentID', 'indent',
        'predecessors',
      ].join(','),
    });

    // Build user map from task assignments
    const userMap = new Map<string, NormalisedUser>();
    for (const t of rawTasks) {
      if (t.assignedToID && !userMap.has(t.assignedToID)) {
        userMap.set(t.assignedToID, {
          id:    t.assignedToID,
          name:  t.assignedTo?.name  ?? t.assignedToID,
          email: t.assignedTo?.emailAddr ?? '',
        });
      }
    }

    // ── Shallow mode: skip notes/docs, return task skeleton ─────────────────
    if (options?.shallow) {
      const topLevel = rawTasks.filter((t) => !t.parentID);
      return {
        id:          proj.ID,
        name:        proj.name,
        description: proj.description,
        startDate:   proj.plannedStartDate?.slice(0, 10),
        endDate:     proj.plannedCompletionDate?.slice(0, 10),
        tasks:       topLevel.map((t) => shallowTask(t, rawTasks)),
        fields:      [],
        users:       [...userMap.values()],
        sections:    [],
      };
    }

    // ── Full mode: fetch notes and documents for all tasks ──────────────────
    const [allNotes, allDocs] = await Promise.all([
      this.getAll<WFNote>('/note/search', {
        projectID:    projectId,
        noteObjCode: 'TASK',
        fields:       'ID,noteText,entryDate,objID,owner',
      }).catch((err) => {
        logger.warn({ err }, 'workfront: could not fetch notes');
        return [] as WFNote[];
      }),
      this.getAll<WFDocument>('/document/search', {
        projectID:   projectId,
        docObjCode: 'TASK',
        fields:      'ID,name,downloadURL,contentType,objID',
      }).catch((err) => {
        logger.warn({ err }, 'workfront: could not fetch documents');
        return [] as WFDocument[];
      }),
    ]);

    // Group by task ID
    const notesByTask = new Map<string, WFNote[]>();
    for (const n of allNotes) {
      if (!n.objID) continue;
      if (!notesByTask.has(n.objID)) notesByTask.set(n.objID, []);
      notesByTask.get(n.objID)!.push(n);
    }
    const docsByTask = new Map<string, WFDocument[]>();
    for (const d of allDocs) {
      if (!d.objID) continue;
      if (!docsByTask.has(d.objID)) docsByTask.set(d.objID, []);
      docsByTask.get(d.objID)!.push(d);
    }

    function buildTask(raw: WFTask): NormalisedTask {
      const comments: NormalisedComment[] = (notesByTask.get(raw.ID) ?? [])
        .filter((n) => n.noteText?.trim())
        .map((n) => ({
          id:         n.ID,
          authorId:   '',
          authorName: n.owner?.name ?? 'Unknown',
          text:       n.noteText!,
          createdAt:  n.entryDate ?? new Date().toISOString(),
        }));

      const attachments: NormalisedAttachment[] = (docsByTask.get(raw.ID) ?? [])
        .filter((d) => d.downloadURL)
        .map((d) => ({
          id:       d.ID,
          name:     d.name ?? d.ID,
          url:      d.downloadURL!,
          mimeType: d.contentType,
        }));

      const children = rawTasks.filter((t) => t.parentID === raw.ID);

      return {
        id:           raw.ID,
        name:         raw.name,
        description:  raw.description,
        assigneeId:   raw.assignedToID ?? undefined,
        dueDate:      raw.plannedCompletionDate?.slice(0, 10),
        completed:    raw.status === TASK_COMPLETE_STATUS,
        customFields: {},
        subtasks:     children.map(buildTask),
        comments,
        attachments,
        dependencyIds: extractDependencyIds(raw),
      };
    }

    const topLevel = rawTasks.filter((t) => !t.parentID);

    return {
      id:          proj.ID,
      name:        proj.name,
      description: proj.description,
      startDate:   proj.plannedStartDate?.slice(0, 10),
      endDate:     proj.plannedCompletionDate?.slice(0, 10),
      tasks:       topLevel.map(buildTask),
      fields:      [],
      users:       [...userMap.values()],
      sections:    [],
    };
  }

  /**
   * If Workfront download URLs require authentication, uncomment and implement this.
   * The URL would need `?apiKey={key}` appended — confirm with client.
   */
  // authenticateAttachmentUrl(url: string): string {
  //   const sep = url.includes('?') ? '&' : '?';
  //   return `${url}${sep}apiKey=${encodeURIComponent(this.apiKey)}`;
  // }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function shallowTask(raw: WFTask, allTasks: WFTask[]): NormalisedTask {
  return {
    id:           raw.ID,
    name:         raw.name,
    description:  raw.description,
    assigneeId:   raw.assignedToID ?? undefined,
    dueDate:      raw.plannedCompletionDate?.slice(0, 10),
    completed:    raw.status === TASK_COMPLETE_STATUS,
    customFields: {},
    subtasks:     allTasks.filter((t) => t.parentID === raw.ID).map((t) => shallowTask(t, allTasks)),
    comments:     [],
    attachments:  [],
    dependencyIds: extractDependencyIds(raw),
  };
}

function extractDependencyIds(task: WFTask): string[] {
  if (!task.predecessors?.length) return [];
  return task.predecessors
    .map((p) => p.predecessorID ?? '')
    .filter(Boolean);
}
