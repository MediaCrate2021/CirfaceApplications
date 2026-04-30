//-------------------------//
// connectors/asana.ts
// Code implemented by Cirface.com / MMG
//
// Asana source connector. Reads a project from one Asana workspace and
// normalises it into the shared NormalisedProject shape so it can be
// written to a different Asana workspace by the destination writer.
//
// Auth: Personal Access Token (PAT).
//
// Asana → Normalised mapping:
//   Project      → Project
//   Section      → Section
//   Task         → Task
//   Subtask      → Subtask (recursive, arbitrary depth)
//   Story        → Comment (resource_subtype === 'comment' only)
//   Attachment   → Attachment (Asana-hosted files only; Google Drive etc. skipped)
//   Custom field → Custom field
//   Dependency   → Dependency
//
// Disclaimer: This code was created with the help of Claude.AI
//
// This code is part of Cirface Migration Tool
//-------------------------//

import type { SourceConnector } from './base.js';
import type {
  NormalisedAttachment,
  NormalisedComment,
  NormalisedField,
  NormalisedFieldType,
  NormalisedProject,
  NormalisedSection,
  NormalisedTask,
  NormalisedUser,
  ProjectListItem,
} from '../src/types/index.js';
import logger from '../logger.js';

const ASANA_BASE = 'https://app.asana.com/api/1.0';

// ---------------------------------------------------------------------------
// Internal Asana API types
// ---------------------------------------------------------------------------

interface AsanaTask {
  gid: string;
  name: string;
  notes: string;
  completed: boolean;
  due_on: string | null;
  assignee: { gid: string; name: string } | null;
  custom_fields: AsanaCustomFieldValue[];
  memberships: Array<{ section: { gid: string } | null }>;
  subtasks: Array<{ gid: string }>;
  dependencies: Array<{ gid: string }>;
}

interface AsanaCustomFieldValue {
  gid: string;
  resource_subtype: string;
  display_value: string | null;
  text_value?: string | null;
  number_value?: number | null;
  date_value?: string | null;
  enum_value?: { gid: string; name: string } | null;
  multi_enum_values?: Array<{ gid: string; name: string }> | null;
  people_value?: Array<{ gid: string; name: string }> | null;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class AsanaConnector implements SourceConnector {
  readonly platform = 'asana' as const;
  private token: string;
  private cachedWorkspaceGid: string | null = null;

  constructor(token: string) {
    this.token = token;
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  private async request<T>(path: string): Promise<T> {
    const url = path.startsWith('http') ? path : `${ASANA_BASE}${path}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({})) as { errors?: Array<{ message: string }> };
      throw new Error(json.errors?.[0]?.message ?? `Asana API error (${res.status}): ${path}`);
    }
    const json = await res.json() as { data: T };
    return json.data;
  }

  /** Fetch all pages from a paginated Asana endpoint. */
  private async getPaginated<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    let url = path.includes('?') ? `${path}&limit=100` : `${path}?limit=100`;
    while (url) {
      const fullUrl = url.startsWith('http') ? url : `${ASANA_BASE}${url}`;
      const res = await fetch(fullUrl, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { errors?: Array<{ message: string }> };
        throw new Error(json.errors?.[0]?.message ?? `Asana API error (${res.status})`);
      }
      const json = await res.json() as { data: T[]; next_page: { uri: string } | null };
      results.push(...json.data);
      url = json.next_page?.uri ?? '';
    }
    return results;
  }

  /** Process items in serial batches to avoid hitting Asana's rate limit. */
  private async batchProcess<T, R>(items: T[], batchSize: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(fn));
      results.push(...batchResults);
    }
    return results;
  }

  /** Return the workspace GID, fetching from the API if not yet cached. */
  private async getWorkspaceGid(): Promise<string> {
    if (this.cachedWorkspaceGid) return this.cachedWorkspaceGid;
    const me = await this.request<{ workspaces: Array<{ gid: string }> }>(
      '/users/me?opt_fields=workspaces,workspaces.gid',
    );
    this.cachedWorkspaceGid = me.workspaces[0]?.gid ?? '';
    return this.cachedWorkspaceGid;
  }

  // ---------------------------------------------------------------------------
  // SourceConnector interface
  // ---------------------------------------------------------------------------

  async testConnection(): Promise<{ workspaceName: string }> {
    const me = await this.request<{
      name: string;
      workspaces: Array<{ gid: string; name: string }>;
    }>('/users/me?opt_fields=name,workspaces,workspaces.gid,workspaces.name');

    if (!me.workspaces.length) throw new Error('No workspaces found for this PAT.');
    this.cachedWorkspaceGid = me.workspaces[0].gid;
    return { workspaceName: me.workspaces[0].name };
  }

  async getWorkspaces(): Promise<Array<{ id: string; name: string }>> {
    const me = await this.request<{ workspaces: Array<{ gid: string; name: string }> }>(
      '/users/me?opt_fields=workspaces,workspaces.gid,workspaces.name',
    );
    return me.workspaces.map((w) => ({ id: w.gid, name: w.name }));
  }

  async getUsers(): Promise<NormalisedUser[]> {
    const workspaceGid = await this.getWorkspaceGid();
    const users = await this.getPaginated<{ gid: string; name: string; email: string }>(
      `/workspaces/${workspaceGid}/users?opt_fields=gid,name,email`,
    );
    return users.map((u) => ({ id: u.gid, name: u.name, email: u.email ?? '' }));
  }

  async getProjects(workspaceId?: string): Promise<ProjectListItem[]> {
    const gid = workspaceId ?? await this.getWorkspaceGid();
    const projects = await this.getPaginated<{ gid: string; name: string }>(
      `/workspaces/${gid}/projects?opt_fields=gid,name&archived=false`,
    );
    return projects.map((p) => ({ id: p.gid, name: p.name }));
  }

  async getProjectFields(projectId: string): Promise<NormalisedField[]> {
    const settings = await this.getPaginated<{
      custom_field: {
        gid: string;
        name: string;
        resource_subtype: string;
        enum_options?: Array<{ gid: string; name: string; color?: string }>;
      };
    }>(
      `/projects/${projectId}/custom_field_settings` +
      `?opt_fields=custom_field.gid,custom_field.name,custom_field.resource_subtype` +
      `,custom_field.enum_options,custom_field.enum_options.gid,custom_field.enum_options.name`,
    );
    return settings.map((s) => this.normaliseField(s.custom_field));
  }

  async getProjectData(projectId: string): Promise<NormalisedProject> {
    logger.info({ projectId }, 'asana source: fetching project data');

    // Fetch project metadata, sections, fields, and users in parallel.
    const [projectMeta, sectionData, fields, allUsers] = await Promise.all([
      this.request<{ gid: string; name: string; notes: string }>(
        `/projects/${projectId}?opt_fields=gid,name,notes`,
      ),
      this.getPaginated<{ gid: string; name: string }>(
        `/projects/${projectId}/sections?opt_fields=gid,name`,
      ),
      this.getProjectFields(projectId),
      this.getUsers(),
    ]);

    const sections: NormalisedSection[] = sectionData.map((s) => ({ id: s.gid, name: s.name }));
    const userMap = new Map<string, NormalisedUser>(allUsers.map((u) => [u.id, u]));

    // Fetch all tasks with full field data in one paginated request.
    const TASK_FIELDS =
      'gid,name,notes,completed,due_on' +
      ',assignee.gid,assignee.name' +
      ',custom_fields.gid,custom_fields.resource_subtype,custom_fields.display_value' +
      ',custom_fields.enum_value.gid,custom_fields.enum_value.name' +
      ',custom_fields.multi_enum_values.gid,custom_fields.multi_enum_values.name' +
      ',custom_fields.number_value,custom_fields.text_value,custom_fields.date_value' +
      ',custom_fields.people_value.gid,custom_fields.people_value.name' +
      ',memberships.section.gid' +
      ',subtasks.gid' +
      ',dependencies.gid';

    const rawTasks = await this.getPaginated<AsanaTask>(
      `/projects/${projectId}/tasks?opt_fields=${TASK_FIELDS}`,
    );

    logger.info({ projectId, taskCount: rawTasks.length }, 'asana source: normalising tasks');

    // Process tasks in batches of 5 to stay within Asana's rate limit.
    const tasks = await this.batchProcess(rawTasks, 5, (t) => this.normaliseTask(t, userMap));

    return {
      id: projectId,
      name: projectMeta.name,
      description: projectMeta.notes || undefined,
      tasks,
      fields,
      users: Array.from(userMap.values()),
      sections,
    };
  }

  async refreshAttachmentUrl(assetId: string): Promise<string | null> {
    try {
      const attachment = await this.request<{ download_url: string | null; permanent_url: string | null }>(
        `/attachments/${assetId}?opt_fields=download_url,permanent_url`,
      );
      return attachment.download_url ?? attachment.permanent_url ?? null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private normalisation helpers
  // ---------------------------------------------------------------------------

  private async normaliseTask(raw: AsanaTask, userMap: Map<string, NormalisedUser>): Promise<NormalisedTask> {
    const [stories, { downloadable, externalLinks }, subtasks] = await Promise.all([
      this.fetchStories(raw.gid),
      this.fetchAttachments(raw.gid),
      this.batchProcess(raw.subtasks ?? [], 5, (s) => this.fetchAndNormaliseSubtask(s.gid, raw.gid, userMap)),
    ]);

    this.cacheAssignee(raw.assignee, userMap);

    return {
      id: raw.gid,
      name: raw.name,
      description: raw.notes || undefined,
      completed: raw.completed ?? false,
      dueDate: raw.due_on ?? undefined,
      assigneeId: raw.assignee?.gid,
      sectionId: raw.memberships?.[0]?.section?.gid ?? undefined,
      customFields: this.extractCustomFields(raw.custom_fields ?? []),
      subtasks,
      comments: [...stories, ...externalLinks],
      attachments: downloadable,
      dependencyIds: (raw.dependencies ?? []).map((d) => d.gid),
    };
  }

  private async fetchAndNormaliseSubtask(
    gid: string,
    parentGid: string,
    userMap: Map<string, NormalisedUser>,
  ): Promise<NormalisedTask> {
    const SUBTASK_FIELDS =
      'gid,name,notes,completed,due_on' +
      ',assignee.gid,assignee.name' +
      ',custom_fields.gid,custom_fields.resource_subtype,custom_fields.display_value' +
      ',custom_fields.enum_value.gid,custom_fields.enum_value.name' +
      ',custom_fields.multi_enum_values.gid,custom_fields.multi_enum_values.name' +
      ',custom_fields.number_value,custom_fields.text_value,custom_fields.date_value' +
      ',custom_fields.people_value.gid,custom_fields.people_value.name' +
      ',subtasks.gid,dependencies.gid';

    const raw = await this.request<AsanaTask>(`/tasks/${gid}?opt_fields=${SUBTASK_FIELDS}`);

    const [stories, { downloadable, externalLinks }, nested] = await Promise.all([
      this.fetchStories(raw.gid),
      this.fetchAttachments(raw.gid),
      this.batchProcess(raw.subtasks ?? [], 5, (s) => this.fetchAndNormaliseSubtask(s.gid, raw.gid, userMap)),
    ]);

    this.cacheAssignee(raw.assignee, userMap);

    return {
      id: raw.gid,
      name: raw.name,
      description: raw.notes || undefined,
      completed: raw.completed ?? false,
      dueDate: raw.due_on ?? undefined,
      assigneeId: raw.assignee?.gid,
      customFields: this.extractCustomFields(raw.custom_fields ?? []),
      subtasks: nested,
      comments: [...stories, ...externalLinks],
      attachments: downloadable,
      dependencyIds: (raw.dependencies ?? []).map((d) => d.gid),
      parentId: parentGid,
    };
  }

  private async fetchStories(taskGid: string): Promise<NormalisedComment[]> {
    const stories = await this.getPaginated<{
      gid: string;
      resource_subtype: string;
      text: string;
      created_at: string;
      created_by: { gid: string; name: string } | null;
    }>(`/tasks/${taskGid}/stories?opt_fields=gid,resource_subtype,text,created_at,created_by.gid,created_by.name`);

    return stories
      .filter((s) => s.resource_subtype === 'comment')
      .map((s) => ({
        id: s.gid,
        authorId: s.created_by?.gid ?? 'unknown',
        authorName: s.created_by?.name ?? 'Unknown',
        text: s.text,
        createdAt: s.created_at,
      }));
  }

  private async fetchAttachments(
    taskGid: string,
  ): Promise<{ downloadable: NormalisedAttachment[]; externalLinks: NormalisedComment[] }> {
    const attachments = await this.getPaginated<{
      gid: string;
      name: string;
      download_url: string | null;
      permanent_url: string | null;
      resource_subtype: string;
      created_at?: string;
      created_by?: { gid: string; name: string } | null;
    }>(`/tasks/${taskGid}/attachments?opt_fields=gid,name,download_url,permanent_url,resource_subtype,created_at,created_by.gid,created_by.name`);

    const downloadable: NormalisedAttachment[] = [];
    const externalLinks: NormalisedComment[] = [];

    for (const a of attachments) {
      if (a.resource_subtype === 'asana' && (a.download_url ?? a.permanent_url)) {
        // Asana-hosted file — download and re-upload to destination.
        downloadable.push({ id: a.gid, name: a.name, url: (a.download_url ?? a.permanent_url)! });
      } else if (a.permanent_url) {
        // External link (Google Drive, Dropbox, etc.) — can't download, so preserve
        // the link as a comment on the migrated task so it isn't silently lost.
        externalLinks.push({
          id: a.gid,
          authorId: a.created_by?.gid ?? 'unknown',
          authorName: a.created_by?.name ?? 'Unknown',
          text: `[External attachment] ${a.name}\n${a.permanent_url}`,
          createdAt: a.created_at ?? new Date().toISOString(),
        });
      }
    }

    return { downloadable, externalLinks };
  }

  private extractCustomFields(
    fields: AsanaCustomFieldValue[],
  ): Record<string, string | string[] | null> {
    const result: Record<string, string | string[] | null> = {};
    for (const f of fields) {
      switch (f.resource_subtype) {
        case 'text':
          result[f.gid] = f.text_value ?? null;
          break;
        case 'number':
          result[f.gid] = f.number_value != null ? String(f.number_value) : null;
          break;
        case 'date':
          result[f.gid] = f.date_value ?? null;
          break;
        case 'enum':
          result[f.gid] = f.enum_value?.name ?? null;
          break;
        case 'multi_enum':
          result[f.gid] = f.multi_enum_values?.map((v) => v.name) ?? null;
          break;
        case 'people':
          result[f.gid] = f.people_value?.map((p) => p.gid) ?? null;
          break;
        default:
          result[f.gid] = f.display_value ?? null;
      }
    }
    return result;
  }

  private normaliseField(cf: {
    gid: string;
    name: string;
    resource_subtype: string;
    enum_options?: Array<{ gid: string; name: string; color?: string }>;
  }): NormalisedField {
    const typeMap: Record<string, NormalisedFieldType> = {
      text: 'text',
      number: 'number',
      date: 'date',
      enum: 'dropdown',
      multi_enum: 'dropdown',
      people: 'people',
      external_references: 'link',
    };

    return {
      id: cf.gid,
      name: cf.name,
      type: typeMap[cf.resource_subtype] ?? 'unknown',
      options: cf.enum_options?.map((o) => ({ id: o.gid, name: o.name, color: o.color })),
    };
  }

  /** Add an assignee to the user map if not already present (picks up users not in the workspace list). */
  private cacheAssignee(
    assignee: { gid: string; name: string } | null | undefined,
    userMap: Map<string, NormalisedUser>,
  ) {
    if (assignee && !userMap.has(assignee.gid)) {
      userMap.set(assignee.gid, { id: assignee.gid, name: assignee.name, email: '' });
    }
  }
}
