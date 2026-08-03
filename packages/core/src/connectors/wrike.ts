//-------------------------//
// connectors/wrike.ts
// Code implemented by Cirface.com / MMG
//
// Wrike source connector. Uses the Wrike REST API v4.
// All data is normalised into the shared NormalisedProject shape
// before being returned to the migration engine.
//
// Wrike API docs: https://developers.wrike.com/api/v4/
//
// Auth: Personal Access Token (PAT) — passed as Bearer token.
// Generate in Wrike UI: Profile menu > Apps & Integrations > API > Create permanent token
//
// Wrike → Normalised mapping:
//   Space              → getWorkspaces()
//   Folder (project)   → Project (folders where project property is set)
//   Subfolder          → NormalisedSection
//   Task               → NormalisedTask
//   Subtask            → NormalisedTask.subtasks (via superTaskIds / subTaskIds)
//   Comment            → NormalisedComment (bulk fetched via /folders/{id}/comments)
//   Attachment         → NormalisedAttachment (URLs resolved via refreshAttachmentUrl)
//   Custom field       → NormalisedField (account-level definitions)
//   Contacts           → NormalisedUser
//
// Note: Wrike attachment download URLs are pre-signed and time-limited.
//       The url stored on NormalisedAttachment is a sentinel "wrike-attachment:{id}".
//       refreshAttachmentUrl() calls /attachments/{id}/url to get a fresh URL on demand.
//
// Note: Dependencies (Finish-to-Start etc.) are Wrike-specific objects and do not
//       map cleanly to Asana dependencies. dependencyIds is returned as [] for now.
//
// Disclaimer: This code was created with the help of Claude.AI
//
// This code is part of Cirface Migration Tool
// Last updated by: 2026MAY12 - LMR
//-------------------------//

import type { SourceConnector } from './base.js';
import logger from '../logger.js';
import type {
  MigrationReportItem,
  NormalisedAttachment,
  NormalisedComment,
  NormalisedField,
  NormalisedFieldOption,
  NormalisedFieldType,
  NormalisedProject,
  NormalisedSection,
  NormalisedTask,
  NormalisedUser,
  ProjectListItem,
  SourcePlatform,
} from '../types/index.js';

const WRIKE_API = 'https://www.wrike.com/api/v4';

// Task fields to request beyond Wrike defaults
const TASK_FIELDS = JSON.stringify([
  'description',
  'customFields',
  'responsibleIds',
  'superTaskIds',
  'subTaskIds',
  'dates',
  'hasAttachments',
  'attachmentCount',
]);

// ---------------------------------------------------------------------------
// Raw Wrike API types
// ---------------------------------------------------------------------------

interface WrikeAccount {
  id: string;
  name: string;
}

interface WrikeSpace {
  id: string;
  title: string;
  accessType: string;
}

interface WrikeFolder {
  id: string;
  title: string;
  project?: {
    authorId: string;
    ownerIds: string[];
    status: string;
    startDate?: string;
    endDate?: string;
  };
}

interface WrikeCustomField {
  id: string;
  title: string;
  type: string;
  settings?: {
    values?: Array<{ id: string; value: string; hidden?: boolean }>;
  };
}

interface WrikeTask {
  id: string;
  title: string;
  description?: string;
  status: string;
  parentIds: string[];
  responsibleIds?: string[];
  superTaskIds?: string[];
  subTaskIds?: string[];
  dependencyIds?: string[];
  dates?: {
    type?: string;
    duration?: number;
    start?: string;
    due?: string;
  };
  customFields?: Array<{ id: string; value: string }>;
  hasAttachments?: boolean;
  attachmentCount?: number;
}

interface WrikeContact {
  id: string;
  firstName: string;
  lastName: string;
  deleted?: boolean;
  profiles?: Array<{ email: string; accountId: string }>;
}

interface WrikeComment {
  id: string;
  authorId: string;
  text: string;
  createdDate: string;
  taskId?: string;
}

interface WrikeAttachment {
  id: string;
  taskId?: string;
  name: string;
  createdDate: string;
  size?: number;
  mimeType?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .trim();
}

function wrikeFieldType(type: string): NormalisedFieldType {
  switch (type) {
    case 'Numeric':
    case 'Duration':
    case 'Currency':
    case 'Percentage': return 'number';
    case 'Date':       return 'date';
    case 'Dropdown':   return 'dropdown';
    case 'CheckBox':   return 'checkbox';
    case 'Contacts':   return 'people';
    default:           return 'text';
  }
}

function isoDate(d?: string): string | undefined {
  if (!d) return undefined;
  // Wrike dates: "2024-01-15T00:00:00" — take the date part only
  return d.substring(0, 10);
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class WrikeConnector implements SourceConnector {
  readonly platform: SourcePlatform = 'wrike';

  constructor(private readonly token: string) {}

  // -------------------------------------------------------------------------
  // HTTP layer
  // -------------------------------------------------------------------------

  private async request<T>(
    path: string,
    params: Record<string, string> = {},
  ): Promise<{ data: T[]; nextPageToken?: string }> {
    const url = new URL(`${WRIKE_API}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Wrike API ${res.status}: ${body}`);
      (err as NodeJS.ErrnoException).code = String(res.status);
      throw err;
    }

    return res.json() as Promise<{ data: T[]; nextPageToken?: string }>;
  }

  private async getAll<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const results: T[] = [];
    let nextPageToken: string | undefined;

    do {
      const p: Record<string, string> = { pageSize: '1000', ...params };
      if (nextPageToken) p.nextPageToken = nextPageToken;
      const resp = await this.request<T>(path, p);
      results.push(...resp.data);
      nextPageToken = resp.nextPageToken;
    } while (nextPageToken);

    return results;
  }

  // -------------------------------------------------------------------------
  // SourceConnector interface
  // -------------------------------------------------------------------------

  async testConnection(): Promise<{ workspaceName: string }> {
    const data = await this.getAll<WrikeAccount>('/account');
    return { workspaceName: data[0]?.name ?? 'Wrike' };
  }

  async getUsers(): Promise<NormalisedUser[]> {
    const contacts = await this.getAll<WrikeContact>('/contacts');
    return contacts
      .filter((c) => !c.deleted)
      .map((c) => ({
        id: c.id,
        name: `${c.firstName} ${c.lastName}`.trim() || c.id,
        email: c.profiles?.[0]?.email ?? '',
      }));
  }

  async getWorkspaces(): Promise<Array<{ id: string; name: string }>> {
    const spaces = await this.getAll<WrikeSpace>('/spaces');
    return spaces.map((s) => ({ id: s.id, name: s.title }));
  }

  async getProjects(spaceId?: string): Promise<ProjectListItem[]> {
    const path = spaceId ? `/spaces/${spaceId}/folders` : '/folders';
    const folders = await this.getAll<WrikeFolder>(path, { fields: '["project"]' });
    return folders
      .filter((f) => !!f.project)
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((f) => ({ id: f.id, name: f.title }));
  }

  async getProjectFields(projectId: string): Promise<NormalisedField[]> {
    // Custom fields in Wrike are account-level definitions — return all of them.
    // The field mapping step lets the user decide which to include.
    const fields = await this.getAll<WrikeCustomField>('/customfields');
    return fields.map((f) => this.normaliseField(f));
  }

  async getProjectData(projectId: string): Promise<NormalisedProject> {
    logger.debug({ projectId }, 'wrike: fetching project data');

    // Parallel: folder info + users + field defs + subfolders (sections) + attachments + comments
    const [folderResp, contacts, customFieldDefs, subfolders, allAttachments, allComments] =
      await Promise.all([
        this.request<WrikeFolder>(`/folders/${projectId}`),
        this.getAll<WrikeContact>('/contacts'),
        this.getAll<WrikeCustomField>('/customfields'),
        this.getAll<WrikeFolder>(`/folders/${projectId}/folders`),
        this.getAll<WrikeAttachment>(`/folders/${projectId}/attachments`, {
          descendants: 'true',
          versions: 'false',
        }),
        this.getAll<WrikeComment>(`/folders/${projectId}/comments`, {
          descendants: 'true',
        }),
      ]);

    const projectName = folderResp.data[0]?.title ?? projectId;

    // All tasks in the project tree (top-level + subtasks)
    const wrikeTasks = await this.getAll<WrikeTask>(`/folders/${projectId}/tasks`, {
      descendants: 'true',
      subTasks:    'true',
      fields:      TASK_FIELDS,
    });

    logger.debug(
      { projectId, tasks: wrikeTasks.length, attachments: allAttachments.length, comments: allComments.length },
      'wrike: raw counts',
    );

    // ---- Build lookup maps ----

    const userMap = new Map<string, NormalisedUser>();
    for (const c of contacts.filter((c) => !c.deleted)) {
      userMap.set(c.id, {
        id: c.id,
        name: `${c.firstName} ${c.lastName}`.trim() || c.id,
        email: c.profiles?.[0]?.email ?? '',
      });
    }

    const fieldDefMap = new Map<string, WrikeCustomField>();
    for (const f of customFieldDefs) fieldDefMap.set(f.id, f);

    // Dropdown option lookup: fieldId → optionId → display label
    const dropdownLookup = new Map<string, Map<string, string>>();
    for (const f of customFieldDefs) {
      if (f.type === 'Dropdown' && f.settings?.values) {
        const opts = new Map<string, string>();
        for (const v of f.settings.values) opts.set(v.id, v.value);
        dropdownLookup.set(f.id, opts);
      }
    }

    // Sections from immediate subfolders of the project folder
    const sections: NormalisedSection[] = subfolders.map((f) => ({
      id: f.id,
      name: f.title,
    }));
    const sectionIdSet = new Set(sections.map((s) => s.id));

    const fetchWarnings: MigrationReportItem[] = [];

    // Comments grouped by task ID
    const commentsByTask = new Map<string, WrikeComment[]>();
    for (const c of allComments) {
      if (!c.taskId) {
        const msg = `Comment (id: ${c.id}) has no associated task ID and was skipped.`;
        logger.warn({ commentId: c.id }, msg);
        fetchWarnings.push({ taskId: 'fetch-phase', taskName: 'Orphaned comment', status: 'warning', message: msg });
        continue;
      }
      if (!commentsByTask.has(c.taskId)) commentsByTask.set(c.taskId, []);
      commentsByTask.get(c.taskId)!.push(c);
    }

    // Attachments grouped by task ID
    const attachmentsByTask = new Map<string, WrikeAttachment[]>();
    for (const a of allAttachments) {
      if (!a.taskId) {
        const msg = `Attachment '${a.name}' (id: ${a.id}) has no associated task ID and was skipped.`;
        logger.warn({ attachmentId: a.id, attachmentName: a.name }, msg);
        fetchWarnings.push({ taskId: 'fetch-phase', taskName: 'Orphaned attachment', status: 'warning', message: msg });
        continue;
      }
      if (!attachmentsByTask.has(a.taskId)) attachmentsByTask.set(a.taskId, []);
      attachmentsByTask.get(a.taskId)!.push(a);
    }

    // ---- Normalise tasks ----

    const taskMap = new Map<string, NormalisedTask>();

    for (const wt of wrikeTasks) {
      // Section: use the first parentId that is a known subfolder
      const sectionId = wt.parentIds.find((id) => sectionIdSet.has(id));

      // Custom fields — resolve dropdown IDs to labels
      const customFields: Record<string, string | null> = {};
      for (const cf of wt.customFields ?? []) {
        const def = fieldDefMap.get(cf.id);
        if (!def) continue;
        if (def.type === 'Dropdown') {
          const opts = dropdownLookup.get(cf.id);
          customFields[cf.id] = opts?.get(cf.value) ?? cf.value ?? null;
        } else {
          customFields[cf.id] = cf.value ?? null;
        }
      }

      const comments: NormalisedComment[] = (commentsByTask.get(wt.id) ?? []).map((c) => ({
        id: c.id,
        authorId: c.authorId,
        authorName: userMap.get(c.authorId)?.name ?? c.authorId,
        text: c.text,
        createdAt: c.createdDate,
      }));

      const attachments: NormalisedAttachment[] = (attachmentsByTask.get(wt.id) ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        // Sentinel URL — resolved to a real pre-signed URL via refreshAttachmentUrl() at migration time
        url: `wrike-attachment:${a.id}`,
        mimeType: a.mimeType,
        uploadedAt: a.createdDate,
      }));

      taskMap.set(wt.id, {
        id: wt.id,
        name: wt.title,
        description: wt.description ? stripHtml(wt.description) : undefined,
        assigneeId: wt.responsibleIds?.[0],
        dueDate: isoDate(wt.dates?.due),
        completed: wt.status === 'Completed',
        customFields,
        subtasks: [],
        comments,
        attachments,
        dependencyIds: [], // Wrike dependencies are typed objects — not mapped in v1
        sectionId,
      });
    }

    // ---- Build task tree ----
    // Tasks with superTaskIds are subtasks; attach them to their parent.
    // Preserve original document order within each parent.

    const topLevelTasks: NormalisedTask[] = [];

    for (const wt of wrikeTasks) {
      const task = taskMap.get(wt.id);
      if (!task) {
        const msg = `Task '${wt.title}' (id: ${wt.id}) was present in the source list but missing from the task map during tree assembly — it was skipped.`;
        logger.warn({ taskId: wt.id, taskTitle: wt.title }, msg);
        fetchWarnings.push({ taskId: wt.id, taskName: wt.title, status: 'warning', message: msg });
        continue;
      }
      const parentTaskId = wt.superTaskIds?.[0];
      if (parentTaskId) {
        const parent = taskMap.get(parentTaskId);
        if (parent) {
          parent.subtasks.push(task);
          continue;
        }
      }
      topLevelTasks.push(task);
    }

    return {
      id: projectId,
      name: projectName,
      tasks: topLevelTasks,
      fields: customFieldDefs.map((f) => this.normaliseField(f)),
      users: [...userMap.values()],
      sections,
      fetchWarnings: fetchWarnings.length > 0 ? fetchWarnings : undefined,
    };
  }

  async refreshAttachmentUrl(assetId: string): Promise<string | null> {
    try {
      const resp = await this.request<{ url: string }>(`/attachments/${assetId}/url`);
      return resp.data[0]?.url ?? null;
    } catch (err) {
      logger.warn({ err, assetId }, 'wrike: failed to refresh attachment URL');
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private normaliseField(f: WrikeCustomField): NormalisedField {
    const options: NormalisedFieldOption[] =
      f.settings?.values
        ?.filter((v) => !v.hidden)
        .map((v) => ({ id: v.id, name: v.value })) ?? [];

    return {
      id: f.id,
      name: f.title,
      type: wrikeFieldType(f.type),
      options: options.length ? options : undefined,
    };
  }
}
