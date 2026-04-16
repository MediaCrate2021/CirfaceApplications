//-------------------------//
// connectors/smartsheet.ts
// Code implemented by Cirface.com / MMG
//
// Smartsheet source connector. Uses the Smartsheet REST API v2.
// All data is normalised into the shared NormalisedProject shape
// before being returned to the migration engine.
//
// Smartsheet API docs: https://smartsheet.redoc.ly/
//
// Auth: Personal Access Token (PAT) — passed as Bearer token.
// Generate in Smartsheet UI: Account > Apps & Integrations > API Access
//
// Smartsheet → Normalised mapping:
//   Workspace          → getWorkspaces()
//   Sheet              → Project
//   Column             → NormalisedField
//   Top-level row      → Task
//   Child row          → Subtask (full hierarchy preserved; arbitrary depth supported)
//   Discussion/comment → NormalisedComment (per row)
//   Row attachment     → NormalisedAttachment (pre-signed URLs expire ~30s — refreshAttachmentUrl re-fetches on demand)
//   CONTACT_LIST       → 'people' field type; first contact per row → assigneeId
//   PICKLIST           → 'dropdown' field type
//   PREDECESSOR column → dependencyIds (migrated as native Asana dependencies; not surfaced as a custom field)
//   DURATION / AUTO_NUMBER → nonMigratable
//
// Note: Smartsheet has no section/group concept. project.sections is always [].
//
// Disclaimer: This code was created with the help of Claude.AI
//
// This code is part of Cirface Migration Tool
// Last updated by: 2026APR09 - LMR
//-------------------------//

import type { SourceConnector } from './base.js';
import logger from '../logger.js';
import type {
  NormalisedAttachment,
  NormalisedComment,
  NormalisedField,
  NormalisedFieldType,
  NormalisedProject,
  NormalisedTask,
  NormalisedUser,
  ProjectListItem,
} from '../src/types/index.js';

const SS_API = 'https://api.smartsheet.com/2.0';

// ---------------------------------------------------------------------------
// Raw Smartsheet API types
// ---------------------------------------------------------------------------

interface SmUser {
  id: number;
  firstName?: string;
  lastName?: string;
  email: string;
}

interface SmColumn {
  id: number;
  title: string;
  type: string;       // TEXT_NUMBER, DATE, CHECKBOX, CONTACT_LIST, PICKLIST, PREDECESSOR, etc.
  primary?: boolean;  // true for the primary (task name) column
  options?: string[]; // for PICKLIST columns
  index: number;
}

interface SmContact {
  objectType: string; // 'CONTACT'
  name?: string;
  email?: string;
}

interface SmMultiContact {
  objectType: string; // 'MULTI_CONTACT'
  values?: SmContact[];
}

interface SmPredecessor {
  rowId: number;
  type: string; // 'FS', 'SS', 'FF', 'SF'
}

interface SmPredecessorList {
  objectType: 'PREDECESSOR_LIST';
  predecessors: SmPredecessor[];
}

interface SmCell {
  columnId: number;
  value?: string | number | boolean | null;
  displayValue?: string;
  objectValue?: SmContact | SmMultiContact | SmPredecessorList | unknown;
}

interface SmRow {
  id: number;
  rowNumber?: number;
  parentId?: number;
  cells: SmCell[];
  createdAt?: string;
  modifiedAt?: string;
}

interface SmSheet {
  id: number;
  name: string;
  columns: SmColumn[];
  rows: SmRow[];
}

interface SmAttachment {
  id: number;
  name: string;
  attachmentType: string; // 'FILE', 'BOX_COM', 'DROPBOX', 'GOOGLE_DRIVE', 'LINK', etc.
  // url is only present on the individual GET /attachments/{id} response, not the list
  url?: string;
  mimeType?: string;
  parentType: string; // 'ROW', 'SHEET', 'COMMENT'
  parentId: number;
}

interface SmComment {
  id: number;
  text: string;
  createdBy?: { name?: string; email?: string };
  createdAt: string;
}

interface SmDiscussion {
  id: number;
  parentType: string; // 'ROW', 'SHEET'
  parentId: number;
  comments?: SmComment[];
}

interface SmWorkspace {
  id: number;
  name: string;
}

interface SmPaginated<T> {
  data: T[];
  totalPages?: number;
  pageNumber?: number;
  totalCount?: number;
}

// Shared context passed to normaliseRow to avoid long parameter lists
interface RowContext {
  columnMap: Map<number, SmColumn>;
  attachmentsByRow: Map<number, SmAttachment[]>;
  discussionsByRow: Map<number, SmDiscussion[]>;
  childrenByParentId: Map<number, SmRow[]>;
  rowNumberToId: Map<number, number>; // rowNumber → internal row id
}

// ---------------------------------------------------------------------------
// Column type helpers
// ---------------------------------------------------------------------------

// Types shown as non-migratable in the field mapping UI (no useful Asana equivalent)
const NON_MIGRATABLE_TYPES = new Set(['DURATION', 'AUTO_NUMBER']);
// Types whose cell values are skipped when building task.customFields.
// PREDECESSOR is excluded here because its data is extracted into task.dependencyIds instead —
// it migrates natively as Asana dependencies and doesn't need a custom field mapping.
const SKIP_CELL_TYPES = new Set([...NON_MIGRATABLE_TYPES]);

function normaliseColumnType(type: string): NormalisedFieldType {
  switch (type) {
    case 'TEXT_NUMBER':           return 'text';
    case 'DATE':
    case 'DATETIME':
    case 'ABSTRACT_DATETIME':     return 'date';
    case 'CHECKBOX':              return 'checkbox';
    case 'CONTACT_LIST':
    case 'MULTI_CONTACT_LIST':    return 'people';
    case 'PICKLIST':              return 'dropdown';
    default:                      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// SmartsheetConnector
// ---------------------------------------------------------------------------

export class SmartsheetConnector implements SourceConnector {
  readonly platform = 'smartsheet' as const;
  private token: string;
  private activeSheetId: string | null = null;

  constructor(token: string) {
    this.token = token.trim();
  }

  async refreshAttachmentUrl(assetId: string): Promise<string | null> {
    if (!this.activeSheetId) return null;
    try {
      const detail = await this.get<SmAttachment>(`/sheets/${this.activeSheetId}/attachments/${assetId}`);
      return detail.url ?? null;
    } catch {
      return null;
    }
  }

  // ---- HTTP helpers ----

  private async get<T = unknown>(
    path: string,
    params: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const url = new URL(`${SS_API}${path}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: signal ?? AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Smartsheet API error (${res.status}): ${text.slice(0, 200)}`);
      (err as NodeJS.ErrnoException).code = String(res.status);
      throw err;
    }

    return res.json() as Promise<T>;
  }

  /** Fetch all pages of a paginated endpoint and return a flat array. */
  private async getAllPages<T>(
    path: string,
    params: Record<string, string> = {},
  ): Promise<T[]> {
    const results: T[] = [];
    let page = 1;

    while (true) {
      const res = await this.get<SmPaginated<T>>(path, {
        ...params,
        pageSize: '500',
        pageNumber: String(page),
      });

      results.push(...(res.data ?? []));
      if (!res.totalPages || page >= res.totalPages) break;
      page++;
    }

    return results;
  }

  // ---- SourceConnector implementation ----

  async testConnection(): Promise<{ workspaceName: string }> {
    const me = await this.get<SmUser>('/users/me');
    const name = [me.firstName, me.lastName].filter(Boolean).join(' ') || me.email;
    return { workspaceName: name };
  }

  async getUsers(): Promise<NormalisedUser[]> {
    // Smartsheet has no "list all org users" endpoint without enterprise admin access.
    // Return the authenticated user only. Additional users are collected from CONTACT_LIST
    // cells during getProjectData() and surfaced through project.users.
    const me = await this.get<SmUser>('/users/me');
    return [this.userFromSmUser(me)];
  }

  async getWorkspaces(): Promise<Array<{ id: string; name: string }>> {
    const workspaces = await this.getAllPages<SmWorkspace>('/workspaces');
    return workspaces.map((w) => ({ id: String(w.id), name: w.name }));
  }

  async getProjects(workspaceId?: string): Promise<ProjectListItem[]> {
    if (workspaceId) {
      const res = await this.get<{ sheets?: Array<{ id: number; name: string }> }>(
        `/workspaces/${workspaceId}`,
        { include: 'sheets' },
      );
      return (res.sheets ?? []).map((s) => ({ id: String(s.id), name: s.name }));
    }

    const sheets = await this.getAllPages<{ id: number; name: string }>('/sheets');
    return sheets.map((s) => ({ id: String(s.id), name: s.name }));
  }

  async getProjectFields(sheetId: string): Promise<NormalisedField[]> {
    // A lightweight fetch — only need columns, not rows
    const sheet = await this.get<Pick<SmSheet, 'columns'>>(`/sheets/${sheetId}`, {
      include: 'columns',
    });
    return this.normaliseColumns(sheet.columns ?? []);
  }

  async getProjectData(sheetId: string): Promise<NormalisedProject> {
    this.activeSheetId = sheetId;
    logger.info({ sheetId }, 'Smartsheet: fetching sheet');

    // Phase 1: full sheet — all rows, columns, and predecessor links
    const sheet = await this.get<SmSheet>(`/sheets/${sheetId}`, {
      include: 'objectValue',
    }, AbortSignal.timeout(60_000));

    logger.info({ sheetId, rows: sheet.rows.length }, 'Smartsheet: sheet loaded');

    // Phase 2: all file attachments on rows OR comments (both parentType values).
    // Comment attachments need Phase 3 (discussions) to map commentId → rowId,
    // so URL resolution happens here but the attachmentsByRow map is built after Phase 3.
    // The list endpoint returns metadata only — no download URL.
    // We must fetch each FILE attachment individually to get its url.
    const allAttachments = await this.getAllPages<SmAttachment>(`/sheets/${sheetId}/attachments`);
    const fileAttachments = allAttachments.filter(
      (a) => (a.parentType === 'ROW' || a.parentType === 'COMMENT') && a.attachmentType === 'FILE',
    );

    // Resolve download URLs in parallel (capped to avoid hammering the API)
    const CONCURRENCY = 5;
    const resolvedAttachments: SmAttachment[] = [];
    for (let i = 0; i < fileAttachments.length; i += CONCURRENCY) {
      const batch = fileAttachments.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (att) => {
          try {
            const detail = await this.get<SmAttachment>(`/sheets/${sheetId}/attachments/${att.id}`);
            return { ...att, url: detail.url, mimeType: detail.mimeType ?? att.mimeType };
          } catch (err) {
            logger.warn({ attachmentId: att.id, err }, 'Smartsheet: failed to resolve attachment URL, skipping');
            return null;
          }
        }),
      );
      for (const r of results) {
        if (r) resolvedAttachments.push(r);
      }
    }
    logger.info(
      { sheetId, total: allAttachments.length, resolved: resolvedAttachments.length },
      'Smartsheet: attachments loaded',
    );

    // Phase 3: all discussions with inline comments
    const allDiscussions = await this.getAllPages<SmDiscussion>(
      `/sheets/${sheetId}/discussions`,
      { include: 'comments' },
    );
    const discussionsByRow = new Map<number, SmDiscussion[]>();
    for (const disc of allDiscussions) {
      if (disc.parentType === 'ROW') {
        const existing = discussionsByRow.get(disc.parentId) ?? [];
        existing.push(disc);
        discussionsByRow.set(disc.parentId, existing);
      }
    }
    logger.info({ sheetId, discussions: allDiscussions.length }, 'Smartsheet: discussions loaded');

    // Build commentId → rowId map so COMMENT-parentType attachments resolve to the correct row.
    // Smartsheet comment attachments have parentType:'COMMENT' and parentId = the comment ID,
    // not the row ID — we need this map to route them correctly.
    const commentToRowId = new Map<number, number>();
    for (const disc of allDiscussions) {
      if (disc.parentType === 'ROW') {
        for (const comment of disc.comments ?? []) {
          commentToRowId.set(comment.id, disc.parentId);
        }
      }
    }

    // Build attachmentsByRow — now that we have the comment→row map we can correctly
    // route both ROW-level and COMMENT-level attachments to the right row.
    const attachmentsByRow = new Map<number, SmAttachment[]>();
    for (const att of resolvedAttachments) {
      if (!att.url) continue;
      let rowId: number;
      if (att.parentType === 'ROW') {
        rowId = att.parentId;
      } else {
        // COMMENT attachment — trace back to the row via the discussion map
        const rid = commentToRowId.get(att.parentId);
        if (rid == null) {
          logger.warn({ attachmentId: att.id, commentId: att.parentId }, 'Smartsheet: comment attachment has no matching row, skipping');
          continue;
        }
        rowId = rid;
      }
      const existing = attachmentsByRow.get(rowId) ?? [];
      existing.push(att);
      attachmentsByRow.set(rowId, existing);
    }

    // Build indexes
    const columnMap = new Map<number, SmColumn>(sheet.columns.map((c) => [c.id, c]));
    const rowMap = new Map<number, SmRow>(sheet.rows.map((r) => [r.id, r]));

    // Collect unique users from CONTACT_LIST cells
    const usersMap = new Map<string, NormalisedUser>();
    for (const row of sheet.rows) {
      for (const cell of row.cells) {
        const col = columnMap.get(cell.columnId);
        if (!col) continue;
        if (col.type === 'CONTACT_LIST') {
          const u = this.extractContact(cell);
          if (u) usersMap.set(u.id, u);
        } else if (col.type === 'MULTI_CONTACT_LIST') {
          for (const u of this.extractMultiContacts(cell)) usersMap.set(u.id, u);
        }
      }
    }

    // Partition rows into top-level tasks and a direct-parent → children map.
    // The full hierarchy is preserved so normaliseRow can recurse to arbitrary depth.
    const topLevelRows: SmRow[] = [];
    const childrenByParentId = new Map<number, SmRow[]>();

    for (const row of sheet.rows) {
      if (!row.parentId || !rowMap.has(row.parentId)) {
        topLevelRows.push(row);
      } else {
        const existing = childrenByParentId.get(row.parentId) ?? [];
        existing.push(row);
        childrenByParentId.set(row.parentId, existing);
      }
    }

    const rowNumberToId = new Map<number, number>(
      sheet.rows.filter((r) => r.rowNumber != null).map((r) => [r.rowNumber!, r.id]),
    );

    const ctx: RowContext = { columnMap, attachmentsByRow, discussionsByRow, childrenByParentId, rowNumberToId };

    const tasks: NormalisedTask[] = topLevelRows.map((row) => this.normaliseRow(row, ctx));

    return {
      id: String(sheet.id),
      name: sheet.name,
      tasks,
      fields: this.normaliseColumns(sheet.columns),
      users: Array.from(usersMap.values()),
      sections: [], // Smartsheet has no section/group concept
    };
  }

  // ---------------------------------------------------------------------------
  // Normalisation helpers
  // ---------------------------------------------------------------------------

  private userFromSmUser(u: SmUser): NormalisedUser {
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;
    return { id: u.email, name, email: u.email };
  }

  private normaliseColumns(columns: SmColumn[]): NormalisedField[] {
    return columns
      .filter((c) => !c.primary && c.type !== 'PREDECESSOR') // primary = task name; PREDECESSOR = handled natively as dependencies
      .map((c): NormalisedField => {
        const isNonMig = NON_MIGRATABLE_TYPES.has(c.type);
        const field: NormalisedField = {
          id: String(c.id),
          name: c.title,
          type: isNonMig ? 'unknown' : normaliseColumnType(c.type),
          nonMigratable: isNonMig || undefined,
        };
        if (c.type === 'PICKLIST' && c.options?.length) {
          field.options = c.options.map((opt) => ({ id: opt, name: opt }));
        }
        return field;
      });
  }

  private normaliseRow(row: SmRow, ctx: RowContext): NormalisedTask {
    const { columnMap, attachmentsByRow, discussionsByRow, childrenByParentId, rowNumberToId } = ctx;

    const customFields: Record<string, string | string[] | null> = {};
    const dependencyIds: string[] = [];
    let name = `Row ${row.id}`;
    let assigneeId: string | undefined;
    let dueDate: string | undefined;

    for (const cell of row.cells) {
      const col = columnMap.get(cell.columnId);
      if (!col) continue;

      if (col.primary) {
        name = String(cell.displayValue ?? cell.value ?? '').trim() || name;
        continue;
      }

      if (SKIP_CELL_TYPES.has(col.type)) continue;

      // PREDECESSOR cells carry dependency data — extract row IDs, don't put in customFields.
      // Prefer objectValue (contains internal rowId directly); fall back to parsing the cell
      // value as a row number and converting via rowNumberToId.
      if (col.type === 'PREDECESSOR') {
        const obj = cell.objectValue as SmPredecessorList | undefined;
        if (obj?.objectType === 'PREDECESSOR_LIST' && Array.isArray(obj.predecessors)) {
          for (const pred of obj.predecessors) {
            dependencyIds.push(String(pred.rowId));
          }
        } else if (cell.value != null) {
          // Cell value is a row number (or comma-separated row numbers e.g. "2" or "1,3")
          const raw = String(cell.value);
          for (const part of raw.split(',')) {
            const rowNum = parseInt(part.trim(), 10);
            const rowId = !isNaN(rowNum) ? rowNumberToId.get(rowNum) : undefined;
            if (rowId != null) dependencyIds.push(String(rowId));
          }
        }
        continue;
      }

      const fieldId = String(col.id);

      switch (col.type) {
        case 'CONTACT_LIST': {
          const contact = this.extractContact(cell);
          if (contact) {
            if (!assigneeId) assigneeId = contact.id; // first contact column drives assignee
            customFields[fieldId] = contact.email;
          } else {
            customFields[fieldId] = null;
          }
          break;
        }
        case 'MULTI_CONTACT_LIST': {
          const contacts = this.extractMultiContacts(cell);
          customFields[fieldId] = contacts.length ? contacts.map((c) => c.email) : null;
          break;
        }
        case 'DATE':
        case 'DATETIME':
        case 'ABSTRACT_DATETIME': {
          // Smartsheet date values are already YYYY-MM-DD strings
          const raw = cell.value != null ? String(cell.value) : null;
          customFields[fieldId] = raw;
          if (raw && !dueDate) dueDate = raw;
          break;
        }
        case 'CHECKBOX': {
          customFields[fieldId] = cell.value ? 'true' : 'false';
          break;
        }
        default: {
          const val = cell.displayValue ?? (cell.value != null ? String(cell.value) : null);
          customFields[fieldId] = val ?? null;
        }
      }
    }

    const attachments: NormalisedAttachment[] = (attachmentsByRow.get(row.id) ?? [])
      .filter((a) => !!a.url)
      .map((a) => ({ id: String(a.id), name: a.name, url: a.url!, mimeType: a.mimeType }));

    const comments: NormalisedComment[] = [];
    for (const disc of discussionsByRow.get(row.id) ?? []) {
      for (const c of disc.comments ?? []) {
        if (!c.text?.trim()) continue;
        comments.push({
          id: String(c.id),
          authorId: c.createdBy?.email ?? 'unknown',
          authorName: c.createdBy?.name ?? c.createdBy?.email ?? 'Unknown',
          text: c.text,
          createdAt: c.createdAt,
        });
      }
    }

    // Store the Smartsheet row number under a reserved key so the migration engine
    // can write it to the 'm_SmartSheetRow' field without needing an extra parameter.
    if (row.rowNumber != null) {
      customFields['__smartsheet_row__'] = String(row.rowNumber);
    }

    // Subtasks: direct children only — recursion into ctx preserves the full hierarchy.
    const subtasks = (childrenByParentId.get(row.id) ?? []).map((sub) => this.normaliseRow(sub, ctx));

    return {
      id: String(row.id),
      name,
      assigneeId,
      dueDate,
      completed: false, // Smartsheet has no built-in per-row completion state
      customFields,
      subtasks,
      comments,
      attachments,
      dependencyIds,
    };
  }

  private extractContact(cell: SmCell): NormalisedUser | null {
    const obj = cell.objectValue as SmContact | undefined;
    if (obj?.objectType === 'CONTACT' && obj.email) {
      return { id: obj.email, name: obj.name ?? obj.email, email: obj.email };
    }
    // Fallback: cell.value is the email string for CONTACT_LIST cells
    const email = typeof cell.value === 'string' ? cell.value.trim() : null;
    if (email) return { id: email, name: email, email };
    return null;
  }

  private extractMultiContacts(cell: SmCell): NormalisedUser[] {
    const obj = cell.objectValue as SmMultiContact | undefined;
    if (obj?.objectType === 'MULTI_CONTACT' && Array.isArray(obj.values)) {
      return obj.values
        .filter((c): c is SmContact & { email: string } => !!c.email)
        .map((c) => ({ id: c.email, name: c.name ?? c.email, email: c.email }));
    }
    return [];
  }


}
