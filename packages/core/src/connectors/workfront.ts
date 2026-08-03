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
  plannedStartDate?: string;
  indent?: number;
  priority?: string | null;
  percentComplete?: number | null;
  duration?: number | null;
  durationType?: string | null;
  actualStartDate?: string | null;
  actualCompletionDate?: string | null;
  commitDate?: string | null;
  predecessors?: Array<{ predecessorID?: string }>;
  entryDate?: string | null;
  enteredBy?: { name?: string; emailAddr?: string } | null;
  // Custom form field values — keyed as "DE:Field Name"
  parameterValues?: Record<string, string | null>;
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
  parentNoteID?: string | null;
  owner?: { name?: string };
}

interface WFDocument {
  ID: string;
  name?: string;
  downloadURL?: string;
  fileExtension?: string;
  objID?: string;
  entryDate?: string;
  owner?: { name?: string };
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
// CUR=Current, PLN=Planning, APP=Approved — confirm with client before re-enabling filter.
// const ACTIVE_PROJECT_STATUSES = 'CUR,PLN,APP';

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
    _includeArchived?: boolean,
  ): Promise<ProjectListItem[]> {
    // Status filter omitted until client's status codes are confirmed.
    // TODO: once known, filter to active statuses to exclude dead/cancelled projects.
    const raw = await this.getAll<WFProject>('/proj/search', {
      fields: 'ID,name,plannedStartDate,plannedCompletionDate,status',
    });
    logger.info({ count: raw.length, statuses: [...new Set(raw.map((p) => p.status).filter(Boolean))] }, 'workfront projects fetched');
    return raw.map((p) => ({
      id:        p.ID,
      name:      p.name,
      startDate: p.plannedStartDate?.slice(0, 10),
      endDate:   p.plannedCompletionDate?.slice(0, 10),
    }));
  }

  async getProjectFields(projectId: string): Promise<NormalisedField[]> {
    // Fetch parameterValues from all tasks to discover which custom form fields exist.
    // Workfront stores custom field values as "DE:Field Name" keys on each task.
    // Field type info requires a separate /parameter API call — all custom fields
    // default to 'text' here, which is safe for migration purposes.
    const tasks = await this.getAll<WFTask>('/task/search', {
      projectID: projectId,
      fields:    'parameterValues',
    });

    const customFieldNames = new Set<string>();
    for (const task of tasks) {
      for (const key of Object.keys(task.parameterValues ?? {})) {
        if (key.startsWith('DE:')) customFieldNames.add(key.slice(3));
      }
    }

    const standardFields: NormalisedField[] = [
      { id: 'description',          name: 'Description',            type: 'text' },
      { id: 'status',               name: 'Status',                 type: 'text' },
      { id: 'priority',             name: 'Priority',               type: 'text' },
      { id: 'percentComplete',      name: 'Percent Complete',       type: 'number' },
      { id: 'duration',             name: 'Duration',               type: 'number' },
      { id: 'plannedStartDate',     name: 'Planned Start Date',     type: 'date' },
      { id: 'actualStartDate',      name: 'Actual Start Date',      type: 'date' },
      { id: 'actualCompletionDate', name: 'Actual Completion Date', type: 'date' },
      { id: 'commitDate',           name: 'Commit Date',            type: 'date' },
    ];

    const customFields: NormalisedField[] = [...customFieldNames].sort().map((name) => ({
      id:   `de:${name}`,
      name,
      type: 'text' as const,
    }));

    logger.info({ projectId, customFieldCount: customFields.length }, 'workfront custom fields discovered');

    return [...standardFields, ...customFields];
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
        'priority', 'percentComplete', 'duration', 'durationType',
        'actualStartDate', 'actualCompletionDate', 'commitDate',
        'predecessors:predecessorID',
        'entryDate', 'enteredBy:name,enteredBy:emailAddr',
        'parameterValues',
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

    // ── Full mode: fetch notes and documents (task-level, note-level, and project-level) ──
    const [allNotes, allDocs, projNotes, projDocs, allNoteDocs] = await Promise.all([
      this.getAll<WFNote>('/note/search', {
        projectID:    projectId,
        noteObjCode: 'TASK',
        fields:       'ID,noteText,entryDate,objID,parentNoteID,owner',
      }).catch((err) => {
        logger.warn({ err }, 'workfront: could not fetch task notes');
        return [] as WFNote[];
      }),
      this.getAll<WFDocument>('/document/search', {
        projectID:   projectId,
        docObjCode: 'TASK',
        fields:      'ID,name,downloadURL,fileExtension,objID,entryDate,owner',
      }).catch((err) => {
        logger.warn({ err }, 'workfront: could not fetch task documents');
        return [] as WFDocument[];
      }),
      this.getAll<WFNote>('/note/search', {
        objID:       projectId,
        noteObjCode: 'PROJ',
        fields:       'ID,noteText,entryDate,objID,parentNoteID,owner',
      }).catch((err) => {
        logger.warn({ err }, 'workfront: could not fetch project-level notes');
        return [] as WFNote[];
      }),
      this.getAll<WFDocument>('/document/search', {
        objID:      projectId,
        docObjCode: 'PROJ',
        fields:      'ID,name,downloadURL,fileExtension,objID,entryDate,owner',
      }).catch((err) => {
        logger.warn({ err }, 'workfront: could not fetch project-level documents');
        return [] as WFDocument[];
      }),
      this.getAll<WFDocument>('/document/search', {
        projectID:   projectId,
        docObjCode: 'NOTE',
        fields:      'ID,name,downloadURL,fileExtension,objID,entryDate,owner',
      }).catch((err) => {
        logger.warn({ err }, 'workfront: could not fetch note-level documents');
        return [] as WFDocument[];
      }),
    ]);

    // Group task-level notes and documents by task ID
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

    // Route note-level documents to their parent task or project.
    // Workfront documents attached to a note/update have docObjCode='NOTE' and
    // objID = the note's ID. We resolve the note back to its parent task or project
    // and add the document to that task's attachment list so it migrates normally.
    const taskByNoteId = new Map<string, string>();
    for (const [taskId, notes] of notesByTask) {
      for (const note of notes) taskByNoteId.set(note.ID, taskId);
    }
    const projNoteIdSet = new Set(projNotes.map((n) => n.ID));
    for (const doc of allNoteDocs) {
      if (!doc.objID || !doc.downloadURL) continue;
      if (projNoteIdSet.has(doc.objID)) {
        // Attached to a project-level note → goes into the project content task
        projDocs.push(doc);
      } else {
        const taskId = taskByNoteId.get(doc.objID);
        if (taskId) {
          if (!docsByTask.has(taskId)) docsByTask.set(taskId, []);
          docsByTask.get(taskId)!.push(doc);
        }
      }
    }

    // Build a synthetic task for project-level notes and documents, if any exist.
    // Asana has no project-level comments/attachments concept, so we surface them
    // as a dedicated task placed first in the task list.

    /**
     * Convert a flat list of WFNote records into ordered NormalisedComments
     * that preserve thread structure. Top-level notes appear first, each
     * immediately followed by their direct replies (depth-first). Replies are
     * prefixed with "↳ In reply to [Author]:" — nested replies use "↳↳", etc.
     * Notes with no text are skipped. Notes whose parentNoteID points to a
     * note outside this set are promoted to top-level.
     */
    function buildThreadedComments(notes: WFNote[]): NormalisedComment[] {
      const noteIds = new Set(notes.map((n) => n.ID));
      const childrenMap = new Map<string, WFNote[]>();
      const topLevel: WFNote[] = [];

      for (const note of notes) {
        const parentId = note.parentNoteID && noteIds.has(note.parentNoteID)
          ? note.parentNoteID
          : null;
        if (parentId) {
          if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
          childrenMap.get(parentId)!.push(note);
        } else {
          topLevel.push(note);
        }
      }

      const result: NormalisedComment[] = [];

      function walk(note: WFNote, depth: number, parentAuthor: string): void {
        const text = note.noteText?.trim();
        if (!text) return;

        const prefix = depth > 0
          ? `${'↳'.repeat(depth)} In reply to ${parentAuthor}:\n`
          : '';

        result.push({
          id:         note.ID,
          authorId:   '',
          authorName: note.owner?.name ?? 'Unknown',
          text:       prefix + text,
          createdAt:  note.entryDate ?? new Date().toISOString(),
        });

        const children = childrenMap.get(note.ID) ?? [];
        for (const child of children) {
          walk(child, depth + 1, note.owner?.name ?? 'Unknown');
        }
      }

      for (const note of topLevel) {
        walk(note, 0, '');
      }

      return result;
    }

    const projComments: NormalisedComment[] = buildThreadedComments(
      projNotes.filter((n) => n.noteText?.trim()),
    );

    const projAttachments: NormalisedAttachment[] = projDocs
      .filter((d) => d.downloadURL)
      .map((d) => ({
        id:         d.ID,
        name:       d.name ?? d.ID,
        url:        d.downloadURL!,
        mimeType:   d.fileExtension,
        uploadedBy: d.owner?.name ?? undefined,
        uploadedAt: d.entryDate ?? undefined,
      }));

    const projectContentTask: NormalisedTask | null = (projComments.length || projAttachments.length)
      ? {
          id:           `${projectId}--project-content`,
          name:         '[Project] Notes & Documents',
          completed:    false,
          customFields: {},
          subtasks:     [],
          comments:     projComments,
          attachments:  projAttachments,
          dependencyIds: [],
        }
      : null;

    function buildTask(raw: WFTask): NormalisedTask {
      const comments: NormalisedComment[] = buildThreadedComments(
        notesByTask.get(raw.ID) ?? [],
      );

      const attachments: NormalisedAttachment[] = (docsByTask.get(raw.ID) ?? [])
        .filter((d) => d.downloadURL)
        .map((d) => ({
          id:         d.ID,
          name:       d.name ?? d.ID,
          url:        d.downloadURL!,
          mimeType:   d.fileExtension,
          uploadedBy: d.owner?.name ?? undefined,
          uploadedAt: d.entryDate ?? undefined,
        }));

      const children = rawTasks.filter((t) => t.parentID === raw.ID);

      return {
        id:           raw.ID,
        name:         raw.name,
        description:  raw.description,
        assigneeId:   raw.assignedToID ?? undefined,
        dueDate:      raw.plannedCompletionDate?.slice(0, 10),
        completed:    raw.status === TASK_COMPLETE_STATUS,
        customFields: {
          description:          raw.description ?? null,
          status:               raw.status ?? null,
          priority:             raw.priority ?? null,
          percentComplete:      raw.percentComplete != null ? String(raw.percentComplete) : null,
          duration:             raw.duration != null ? String(raw.duration) : null,
          plannedStartDate:     raw.plannedStartDate?.slice(0, 10) ?? null,
          actualStartDate:      raw.actualStartDate?.slice(0, 10) ?? null,
          actualCompletionDate: raw.actualCompletionDate?.slice(0, 10) ?? null,
          commitDate:           raw.commitDate?.slice(0, 10) ?? null,
          // Custom form fields — strip the "DE:" prefix, use "de:" as internal ID prefix
          ...Object.fromEntries(
            Object.entries(raw.parameterValues ?? {})
              .filter(([key]) => key.startsWith('DE:'))
              .map(([key, value]) => [`de:${key.slice(3)}`, value ?? null])
          ),
        },
        subtasks:     children.map(buildTask),
        comments,
        attachments,
        dependencyIds: extractDependencyIds(raw),
        createdAt:    raw.entryDate ?? undefined,
        createdBy:    formatCreatedBy(raw),
      };
    }

    const topLevel = rawTasks.filter((t) => !t.parentID);

    return {
      id:          proj.ID,
      name:        proj.name,
      description: proj.description,
      startDate:   proj.plannedStartDate?.slice(0, 10),
      endDate:     proj.plannedCompletionDate?.slice(0, 10),
      tasks:       [...(projectContentTask ? [projectContentTask] : []), ...topLevel.map(buildTask)],
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
    customFields: {
      description:          raw.description ?? null,
      status:               raw.status ?? null,
      priority:             raw.priority ?? null,
      percentComplete:      raw.percentComplete != null ? String(raw.percentComplete) : null,
      duration:             raw.duration != null ? String(raw.duration) : null,
      plannedStartDate:     raw.plannedStartDate?.slice(0, 10) ?? null,
      actualStartDate:      raw.actualStartDate?.slice(0, 10) ?? null,
      actualCompletionDate: raw.actualCompletionDate?.slice(0, 10) ?? null,
      commitDate:           raw.commitDate?.slice(0, 10) ?? null,
      ...Object.fromEntries(
        Object.entries(raw.parameterValues ?? {})
          .filter(([key]) => key.startsWith('DE:'))
          .map(([key, value]) => [`de:${key.slice(3)}`, value ?? null])
      ),
    },
    subtasks:     allTasks.filter((t) => t.parentID === raw.ID).map((t) => shallowTask(t, allTasks)),
    comments:     [],
    attachments:  [],
    dependencyIds: extractDependencyIds(raw),
    createdAt:    raw.entryDate ?? undefined,
    createdBy:    formatCreatedBy(raw),
  };
}

function formatCreatedBy(task: WFTask): string | undefined {
  const name = task.enteredBy?.name;
  const email = task.enteredBy?.emailAddr;
  if (!name && !email) return undefined;
  return email ? `${name ?? email} (${email})` : name!;
}

function extractDependencyIds(task: WFTask): string[] {
  if (!task.predecessors?.length) return [];
  return task.predecessors
    .map((p) => p.predecessorID ?? '')
    .filter(Boolean);
}
