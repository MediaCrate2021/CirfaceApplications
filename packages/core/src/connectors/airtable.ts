//-------------------------//
// connectors/airtable.ts
// Code implemented by Cirface.com / MMG
//
// Airtable source connector. Uses the Airtable REST API v0.
// All data is normalised into the shared NormalisedProject shape
// before being returned to the migration engine.
//
// Airtable API docs: https://airtable.com/developers/web/api/introduction
//
// Auth: Personal Access Token (PAT) — passed as Bearer token.
// Generate in Airtable UI: Account > Developer hub > Personal access tokens
// Required scopes: data.records:read, data.recordComments:read, schema.bases:read
//
// Airtable → Normalised mapping:
//   Base               → Project (getProjects)
//   Table              → Section (tables within a base become sections)
//   Record             → NormalisedTask
//   Field              → NormalisedField
//   Attachment field   → NormalisedAttachment (URLs expire in 2 hours)
//   Comment            → NormalisedComment
//   Collaborator       → NormalisedUser (built from cell values + base collaborators)
//
// Design decision — tables within a base:
//   Airtable bases commonly have multiple tables (Tasks, Projects, Team, etc.).
//   This connector treats the FIRST table in a base as the primary task table.
//   All tables are returned as sections; records from the primary table are tasks.
//   TODO: Let the user pick which table holds tasks (field mapping step or connect step).
//
// Note: Attachment URLs expire after 2 hours. refreshAttachmentUrl() re-fetches
//       the parent record to get a fresh URL. For large migrations, download
//       attachments immediately during the initial pass.
//
// Note: Rate limit is 5 requests/second per base. A 220ms delay is applied
//       between requests to stay safely within this limit.
//
// Disclaimer: This code was created with the help of Claude.AI
//
// This code is part of Cirface Migration Tool
// Last updated by: 2026SEP09 - LMR
//-------------------------//

import type { SourceConnector } from './base.js';
import logger from '../logger.js';
import type {
  MigrationReportItem,
  NormalisedAttachment,
  NormalisedComment,
  NormalisedField,
  NormalisedFieldType,
  NormalisedProject,
  NormalisedSection,
  NormalisedTask,
  NormalisedUser,
  ProjectListItem,
  SourcePlatform,
} from '../types/index.js';

const AT_API = 'https://api.airtable.com/v0';

// Delay between API requests to respect the 5 req/s per-base rate limit.
const RATE_DELAY_MS = 220;

// ---------------------------------------------------------------------------
// Raw Airtable API types
// ---------------------------------------------------------------------------

interface AirtableBase {
  id: string;
  name: string;
  permissionLevel: string;
}

interface AirtableFieldOption {
  id: string;
  name: string;
  color?: string;
}

interface AirtableField {
  id: string;
  name: string;
  type: string;
  options?: {
    choices?: AirtableFieldOption[];         // singleSelect, multipleSelects
    linkedTableId?: string;                  // multipleRecordLinks
    isReversed?: boolean;
    result?: { type: string; options?: unknown }; // formula/rollup result type
  };
}

interface AirtableTable {
  id: string;
  name: string;
  description?: string;
  primaryFieldId: string;
  fields: AirtableField[];
}

interface AirtableCollaborator {
  id: string;
  email: string;
  name: string;
}

interface AirtableAttachmentValue {
  id: string;
  url: string;
  filename: string;
  size?: number;
  type?: string;          // MIME type
  width?: number;
  height?: number;
}

interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
  commentCount?: number;  // populated when recordMetadata=["commentCount"] is requested
}

interface AirtableComment {
  id: string;
  text: string;
  createdTime: string;
  lastUpdatedTime?: string;
  author: {
    id: string;
    email: string;
    name: string;
  };
  parentCommentId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function airtableFieldType(field: AirtableField): NormalisedFieldType {
  switch (field.type) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'rating':
    case 'duration':
    case 'autoNumber':
    case 'count':
      return 'number';

    case 'date':
    case 'dateTime':
    case 'createdTime':
    case 'lastModifiedTime':
      return 'date';

    case 'checkbox':
      return 'checkbox';

    case 'singleSelect':
      return 'dropdown';

    case 'singleCollaborator':
    case 'multipleCollaborators':
    case 'createdBy':
    case 'lastModifiedBy':
      return 'people';

    // multipleSelects has no direct NormalisedField equivalent — flatten to text
    default:
      return 'text';
  }
}

/** Return true for field types that are not worth migrating as custom fields. */
function isNonMigratable(field: AirtableField): boolean {
  return ['button', 'aiText', 'barcode', 'externalSyncSource'].includes(field.type);
}

/** Coerce an Airtable cell value to a string for customFields. */
function cellToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value || null;
  // multipleSelects — array of strings
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return (value as string[]).join(', ') || null;
  }
  // singleCollaborator / collaborator objects
  if (typeof value === 'object' && value !== null && 'name' in value) {
    return (value as { name: string }).name || null;
  }
  // multipleCollaborators
  if (Array.isArray(value) && value.length > 0 && typeof (value[0] as { name?: unknown }).name === 'string') {
    return (value as Array<{ name: string }>).map((c) => c.name).join(', ') || null;
  }
  return String(value);
}

/** Extract a collaborator user from a cell value (singleCollaborator or first of multipleCollaborators). */
function collaboratorFromCell(value: unknown): AirtableCollaborator | null {
  if (!value || typeof value !== 'object') return null;
  const collab = value as { id?: string; email?: string; name?: string };
  if (collab.id && collab.email) {
    return { id: collab.id, email: collab.email, name: collab.name ?? collab.email };
  }
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0] as { id?: string; email?: string; name?: string };
    if (first.id && first.email) {
      return { id: first.id, email: first.email, name: first.name ?? first.email };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class AirtableConnector implements SourceConnector {
  readonly platform: SourcePlatform = 'airtable';

  constructor(private readonly token: string) {}

  // -------------------------------------------------------------------------
  // HTTP layer
  // -------------------------------------------------------------------------

  private async request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${AT_API}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Airtable API ${res.status}: ${body.slice(0, 300)}`);
      (err as NodeJS.ErrnoException).code = String(res.status);
      throw err;
    }

    return res.json() as Promise<T>;
  }

  /** Paginate a list endpoint using Airtable's offset-cursor pattern. */
  private async getAll<T>(
    path: string,
    params: Record<string, string> = {},
    itemsKey: string = 'records',
  ): Promise<T[]> {
    const results: T[] = [];
    let offset: string | undefined;

    do {
      const p: Record<string, string> = { ...params };
      if (offset) p.offset = offset;

      await sleep(RATE_DELAY_MS);
      const page = await this.request<Record<string, unknown>>(path, p);
      const items = page[itemsKey] as T[] | undefined;
      if (items) results.push(...items);
      offset = page.offset as string | undefined;
    } while (offset);

    return results;
  }

  // -------------------------------------------------------------------------
  // SourceConnector interface
  // -------------------------------------------------------------------------

  async testConnection(): Promise<{ workspaceName: string }> {
    const data = await this.request<{ bases: AirtableBase[] }>('/meta/bases', { pageSize: '1' });
    // Airtable has no single workspace name — use token owner name or a generic label.
    // The base count gives a useful signal.
    const count = data.bases.length;
    return { workspaceName: `Airtable (${count > 0 ? `${count}+ base${count !== 1 ? 's' : ''}` : 'no bases found'})` };
  }

  // Airtable has no public workspace-listing endpoint at the standard tier.
  // getWorkspaces() is intentionally omitted — getProjects() returns all accessible bases.

  // Airtable has no standalone users endpoint — collaborators are discovered from
  // cell values during getProjectData(). Return empty here; the migration engine
  // builds its user list from NormalisedProject.users after getProjectData().
  async getUsers(): Promise<NormalisedUser[]> {
    return [];
  }

  async getProjects(_workspaceId?: string): Promise<ProjectListItem[]> {
    const bases = await this.getAll<AirtableBase>('/meta/bases', {}, 'bases');
    return bases
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((b) => ({ id: b.id, name: b.name }));
  }

  async getProjectInfo(baseId: string): Promise<{ id: string; name: string }> {
    const data = await this.request<{ id: string; name: string }>(`/meta/bases/${baseId}`);
    return { id: data.id, name: data.name };
  }

  async getProjectFields(baseId: string): Promise<NormalisedField[]> {
    const data = await this.request<{ tables: AirtableTable[] }>(`/meta/bases/${baseId}/tables`);
    const primaryTable = data.tables[0];
    if (!primaryTable) return [];
    return this.normaliseFields(primaryTable.fields);
  }

  async getProjectData(baseId: string): Promise<NormalisedProject> {
    logger.debug({ baseId }, 'airtable: fetching project data');

    // Fetch table schema
    const schemaData = await this.request<{ tables: AirtableTable[] }>(`/meta/bases/${baseId}/tables`);
    const tables = schemaData.tables;

    if (tables.length === 0) {
      return { id: baseId, name: baseId, tasks: [], fields: [], users: [], sections: [] };
    }

    // TODO: Let the user select which table holds tasks. For now use the first table.
    const primaryTable = tables[0];
    const projectName = primaryTable.name;

    // Sections = all tables (the primary table is also a section for sectionId assignment)
    const sections: NormalisedSection[] = tables.map((t) => ({ id: t.id, name: t.name }));

    const fields = this.normaliseFields(primaryTable.fields);

    // Build field lookup for the primary table
    const fieldMap = new Map<string, AirtableField>();
    for (const f of primaryTable.fields) fieldMap.set(f.id, f);

    // Find the primary field (task name)
    const primaryFieldId = primaryTable.primaryFieldId;

    // Fetch all records from the primary table
    logger.debug({ baseId, tableId: primaryTable.id }, 'airtable: fetching records');
    const rawRecords = await this.getAll<AirtableRecord>(
      `/${baseId}/${primaryTable.id}`,
      {
        returnFieldsByFieldId: 'true',
        recordMetadata: '["commentCount"]',
        pageSize: '100',
      },
    );

    logger.debug({ baseId, records: rawRecords.length }, 'airtable: raw record count');

    const fetchWarnings: MigrationReportItem[] = [];
    const userMap = new Map<string, NormalisedUser>();

    // Collect users from collaborator-type fields across all records
    for (const record of rawRecords) {
      for (const [fieldId, value] of Object.entries(record.fields)) {
        const fieldDef = fieldMap.get(fieldId);
        if (!fieldDef) continue;
        if (
          fieldDef.type === 'singleCollaborator' ||
          fieldDef.type === 'multipleCollaborators' ||
          fieldDef.type === 'createdBy' ||
          fieldDef.type === 'lastModifiedBy'
        ) {
          const collaborators = Array.isArray(value) ? value : [value];
          for (const collab of collaborators) {
            const user = collaboratorFromCell(collab);
            if (user && !userMap.has(user.id)) {
              userMap.set(user.id, { id: user.id, name: user.name, email: user.email });
            }
          }
        }
      }
    }

    // Normalise records into tasks
    const tasks: NormalisedTask[] = [];

    for (const record of rawRecords) {
      const nameValue = record.fields[primaryFieldId];
      const name = typeof nameValue === 'string' ? nameValue : `Record ${record.id}`;

      // Assignee — look for the first singleCollaborator or multipleCollaborators field
      let assigneeId: string | undefined;
      for (const [fieldId, value] of Object.entries(record.fields)) {
        const fieldDef = fieldMap.get(fieldId);
        if (!fieldDef) continue;
        if (fieldDef.type === 'singleCollaborator' || fieldDef.type === 'multipleCollaborators') {
          const collab = collaboratorFromCell(value);
          if (collab) { assigneeId = collab.id; break; }
        }
      }

      // Due date — look for a field named "Due date", "Due", or the first date field
      let dueDate: string | undefined;
      for (const [fieldId, value] of Object.entries(record.fields)) {
        const fieldDef = fieldMap.get(fieldId);
        if (!fieldDef || fieldDef.type !== 'date' && fieldDef.type !== 'dateTime') continue;
        const lower = fieldDef.name.toLowerCase();
        if (lower.includes('due')) {
          dueDate = typeof value === 'string' ? value.slice(0, 10) : undefined;
          break;
        }
      }

      // Completed — look for a checkbox field named "Done", "Complete", "Completed", "Status"
      let completed = false;
      for (const [fieldId, value] of Object.entries(record.fields)) {
        const fieldDef = fieldMap.get(fieldId);
        if (!fieldDef || fieldDef.type !== 'checkbox') continue;
        const lower = fieldDef.name.toLowerCase();
        if (lower.includes('done') || lower.includes('complet') || lower.includes('finished')) {
          completed = value === true;
          break;
        }
      }

      // Custom fields — all fields except primary, attachments, and linked records
      const customFields: Record<string, string | null> = {};
      for (const [fieldId, value] of Object.entries(record.fields)) {
        const fieldDef = fieldMap.get(fieldId);
        if (!fieldDef) continue;
        if (fieldId === primaryFieldId) continue;
        if (fieldDef.type === 'multipleAttachments') continue;
        if (fieldDef.type === 'multipleRecordLinks') continue;
        if (isNonMigratable(fieldDef)) continue;
        customFields[fieldId] = cellToString(value);
      }

      // Attachments — from multipleAttachments fields
      const attachments: NormalisedAttachment[] = [];
      for (const [fieldId, value] of Object.entries(record.fields)) {
        const fieldDef = fieldMap.get(fieldId);
        if (!fieldDef || fieldDef.type !== 'multipleAttachments') continue;
        if (!Array.isArray(value)) continue;
        for (const att of value as AirtableAttachmentValue[]) {
          attachments.push({
            id: att.id,
            name: att.filename,
            url: att.url,
            mimeType: att.type,
            // Airtable does not return an uploadedAt on attachment objects
          });
        }
      }

      // Comments — only fetch if commentCount > 0 (saves API calls)
      let comments: NormalisedComment[] = [];
      if ((record.commentCount ?? 0) > 0) {
        try {
          await sleep(RATE_DELAY_MS);
          const rawComments = await this.getAll<AirtableComment>(
            `/${baseId}/${primaryTable.id}/${record.id}/comments`,
            { pageSize: '100' },
            'comments',
          );
          // Exclude threaded replies (parentCommentId set) — keep top-level only for now
          // TODO: Decide whether to include replies or flatten them
          comments = rawComments
            .filter((c) => !c.parentCommentId)
            .map((c) => ({
              id: c.id,
              authorId: c.author.id,
              authorName: c.author.name,
              text: c.text,
              createdAt: c.createdTime,
            }));
        } catch (err) {
          const msg = `Failed to fetch comments for record '${name}' (${record.id}): ${err instanceof Error ? err.message : String(err)}`;
          logger.warn({ recordId: record.id }, msg);
          fetchWarnings.push({ taskId: record.id, taskName: name, status: 'warning', message: msg });
        }
      }

      tasks.push({
        id: record.id,
        name,
        assigneeId,
        dueDate,
        completed,
        customFields,
        subtasks: [],          // Airtable has no native subtask concept
        dependencyIds: [],     // Airtable has no native dependency concept
        comments,
        attachments,
        sectionId: primaryTable.id,  // all records belong to the primary table section
        createdAt: record.createdTime,
      });
    }

    logger.debug({ baseId, tasks: tasks.length }, 'airtable: normalised');

    return {
      id: baseId,
      name: projectName,
      tasks,
      fields,
      users: [...userMap.values()],
      sections,
      fetchWarnings: fetchWarnings.length > 0 ? fetchWarnings : undefined,
    };
  }

  async refreshAttachmentUrl(attachmentId: string): Promise<string | null> {
    // Airtable has no dedicated attachment URL refresh endpoint.
    // The attachmentId is stored as "{recordId}:{attachmentId}" so we can re-fetch the record.
    // TODO: Store composite ID "tableId:recordId:attachmentId" at normalisation time
    //       so we can re-fetch the parent record here.
    logger.warn({ attachmentId }, 'airtable: refreshAttachmentUrl not yet implemented — download attachments immediately during migration');
    return null;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private normaliseFields(fields: AirtableField[]): NormalisedField[] {
    return fields
      .filter((f) => !isNonMigratable(f))
      .map((f) => {
        const options = f.options?.choices
          ?.map((c) => ({ id: c.id, name: c.name }));

        return {
          id: f.id,
          name: f.name,
          type: airtableFieldType(f),
          options: options?.length ? options : undefined,
          nonMigratable: isNonMigratable(f) ? true : undefined,
        };
      });
  }
}
