//-------------------------//
// connectors/monday.ts
// Code implemented by Cirface.com / MMG
//
// Monday.com source connector. Uses the Monday GraphQL API v2.
// All data is normalised into the shared NormalisedProject shape
// before being returned to the migration engine.
//
// Monday API docs: https://developer.monday.com/api-reference/reference/about-the-api
//
// Disclaimer: This code was created with the help of Claude.AI
//
// This code is part of Cirface Migration Tool
// Last updated by: 2026MAR11 - LMR
//-------------------------//

import type { SourceConnector } from './base.js';
import logger from '../logger.js';
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

const MONDAY_API = 'https://api.monday.com/v2';

export class MondayConnector implements SourceConnector {
  readonly platform = 'monday' as const;
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async gql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await fetch(MONDAY_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.token,
        'API-Version': '2024-01',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const err = new Error(`Monday API HTTP error (${res.status})`);
      (err as NodeJS.ErrnoException).code = String(res.status);
      throw err;
    }

    const json = await res.json() as { data?: T; errors?: Array<{ message: string }> };

    if (json.errors?.length) {
      throw new Error(`Monday API error: ${json.errors[0].message}`);
    }

    return json.data as T;
  }

  async testConnection(): Promise<{ workspaceName: string }> {
    const data = await this.gql<{ me: { name: string }; workspaces: Array<{ name: string }> }>(`
      query {
        me { name }
        workspaces(limit: 1) { name }
      }
    `);
    return { workspaceName: data.workspaces[0]?.name ?? 'Monday.com' };
  }

  async getUsers(): Promise<NormalisedUser[]> {
    const data = await this.gql<{
      users: Array<{ id: string; name: string; email: string }>;
    }>(`
      query {
        users(limit: 500) {
          id
          name
          email
        }
      }
    `);

    return data.users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
    }));
  }

  async getWorkspaces(): Promise<Array<{ id: string; name: string }>> {
    const data = await this.gql<{
      workspaces: Array<{ id: string; name: string }>;
    }>(`
      query {
        workspaces(limit: 100) {
          id
          name
        }
      }
    `);
    return data.workspaces;
  }

  async getProjects(workspaceId?: string): Promise<ProjectListItem[]> {
    // Monday "boards" are the equivalent of projects
    const data = await this.gql<{
      boards: Array<{ id: string; name: string }>;
    }>(
      workspaceId
        ? `query($wsId: [ID!]) { boards(limit: 200, board_kind: public, workspace_ids: $wsId) { id name } }`
        : `query { boards(limit: 200, board_kind: public) { id name } }`,
      workspaceId ? { wsId: [workspaceId] } : undefined,
    );

    return data.boards.map((b) => ({ id: b.id, name: b.name }));
  }

  async getProjectFields(boardId: string): Promise<NormalisedField[]> {
    const data = await this.gql<{ boards: Array<{ columns: MondayColumn[] }> }>(`
      query($boardId: [ID!]) {
        boards(ids: $boardId) {
          columns { id title type settings_str }
        }
      }
    `, { boardId: [boardId] });
    return this.normaliseColumns(data.boards[0]?.columns ?? []);
  }

  async getProjectData(boardId: string): Promise<NormalisedProject> {
    // Phase 1: Fetch board structure — columns, groups, and items with column values
    // and subitem IDs only. updates/assets are intentionally excluded here because
    // combining subitems { id } + updates + assets in a single items_page query
    // exceeds Monday's query complexity limit. Full data is fetched in Phase 2.
    const data = await this.gql<{
      boards: Array<MondayBoard>;
    }>(`
      query($boardId: [ID!]) {
        boards(ids: $boardId) {
          id
          name
          description
          columns {
            id
            title
            type
            settings_str
          }
          groups {
            id
            title
          }
          items_page(limit: 100) {
            cursor
            items {
              id
              name
              state
              group { id }
              column_values { id type text value }
              subitems { id }
            }
          }
        }
      }
    `, { boardId: [boardId] });

    const board = data.boards[0];
    if (!board) throw new Error(`Board ${boardId} not found`);

    const fields = this.normaliseColumns(board.columns);
    const sections: NormalisedSection[] = (board.groups ?? []).map((g) => ({ id: g.id, name: g.title }));
    const usersMap = new Map<string, NormalisedUser>();

    // Collect all items across pages
    let allItems: MondayItem[] = [...board.items_page.items];
    let cursor = board.items_page.cursor;
    while (cursor) {
      const page = await this.gql<{
        next_items_page: {
          cursor: string | null;
          items: MondayItem[];
        };
      }>(`
        query($cursor: String!) {
          next_items_page(limit: 100, cursor: $cursor) {
            cursor
            items {
              id name state
              group { id }
              column_values { id type text value }
              subitems { id }
            }
          }
        }
      `, { cursor });

      allItems = [...allItems, ...page.next_items_page.items];
      cursor = page.next_items_page.cursor;
    }

    // Phase 2: batch-fetch full data (updates, assets) for ALL items — both parent
    // items and subitems — using items(ids: $ids). This avoids the complexity limit
    // while ensuring comments and attachments are migrated for every item.
    const subitemIdToParentId = new Map<string, string>();
    for (const item of allItems) {
      for (const sub of item.subitems ?? []) {
        subitemIdToParentId.set(sub.id, item.id);
      }
    }

    const allIds = [
      ...allItems.map((i) => i.id),
      ...Array.from(subitemIdToParentId.keys()),
    ];
    const fullDataMap = new Map<string, MondaySubitem>();
    if (allIds.length > 0) {
      const fetched = await this.fetchItemsByIds(allIds);
      for (const item of fetched) {
        fullDataMap.set(item.id, item);
      }
    }

    // Merge updates and assets back into parent items from the full data map
    for (const item of allItems) {
      const full = fullDataMap.get(item.id);
      if (full) {
        item.updates = full.updates;
        item.assets = full.assets;
      }
    }

    // Build subitem map from the same full data fetch
    const subitemMap = new Map<string, MondaySubitem>();
    for (const subId of subitemIdToParentId.keys()) {
      const full = fullDataMap.get(subId);
      if (full) subitemMap.set(subId, full);
    }

    const tasks = this.normaliseBoardItems(allItems, board.columns, usersMap, subitemMap);

    return {
      id: board.id,
      name: board.name,
      description: board.description ?? undefined,
      tasks,
      fields,
      sections,
      users: Array.from(usersMap.values()),
    };
  }

  /** Batch-fetch full item data by ID (used for subitems). Handles Monday's 100-item limit. */
  private async fetchItemsByIds(ids: string[]): Promise<MondaySubitem[]> {
    const BATCH = 100;
    const results: MondaySubitem[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const data = await this.gql<{ items: MondaySubitem[] }>(`
        query($ids: [ID!]!) {
          items(ids: $ids) {
            id name state
            column_values { id type text value }
            updates(limit: 25) { id body created_at creator { id name email } }
            assets { id name public_url file_extension }
          }
        }
      `, { ids: batch });
      results.push(...(data.items ?? []));
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private normaliseColumns(columns: MondayColumn[]): NormalisedField[] {
    return columns
      .filter((c) => !['name', 'subitems'].includes(c.type))
      .map((c) => {
        const type = this.mapColumnType(c.type);
        const field: NormalisedField = { id: c.id, name: c.title, type };

        // Parse dropdown options from settings_str.
        // Monday dropdown columns: labels is an array of {id, name} objects.
        // Monday status columns: labels is a Record<string, string> (index → label).
        if (type === 'dropdown' && c.settings_str) {
          try {
            const settings = JSON.parse(c.settings_str) as {
              labels?: Array<{ id: number; name: string }> | Record<string, string>;
            };
            if (Array.isArray(settings.labels)) {
              field.options = settings.labels.map((opt) => ({
                id: String(opt.id),
                name: opt.name,
              }));
            } else if (settings.labels && typeof settings.labels === 'object') {
              field.options = Object.entries(settings.labels).map(([id, name]) => ({
                id,
                name,
              }));
            }
          } catch (err) {
            logger.warn({ err, columnId: c.id, columnTitle: c.title }, 'failed to parse Monday column settings_str — field will have no options');
          }
        }

        return field;
      });
  }

  private mapColumnType(mondayType: string): NormalisedFieldType {
    const map: Record<string, NormalisedFieldType> = {
      text: 'text',
      long_text: 'text',
      numbers: 'number',
      date: 'date',
      dropdown: 'dropdown',
      status: 'dropdown',
      color: 'dropdown',
      checkbox: 'checkbox',
      people: 'people',
      team: 'people',
      link: 'link',
      email: 'text',
      phone: 'text',
    };
    return map[mondayType] ?? 'unknown';
  }

  private normaliseBoardItems(
    items: MondayItem[],
    columns: MondayColumn[],
    usersMap: Map<string, NormalisedUser>,
    subitemMap: Map<string, MondaySubitem>,
  ): NormalisedTask[] {
    return items.map((item) => {
      const customFields: Record<string, string | string[] | null> = {};
      let assigneeId: string | undefined;

      for (const cv of item.column_values) {
        const col = columns.find((c) => c.id === cv.id);
        if (!col) continue;

        if (col.type === 'people' || col.type === 'team') {
          // Extract all persons: first becomes the default assignee, all IDs are stored
          // in customFields so the user can map this column to native assignee or followers.
          if (cv.value) {
            try {
              const parsed = JSON.parse(cv.value) as {
                personsAndTeams?: Array<{ id: string; kind: string }>;
              };
              const persons = parsed.personsAndTeams?.filter((p) => p.kind === 'person') ?? [];
              if (persons.length > 0) {
                if (!assigneeId) assigneeId = persons[0].id;
                customFields[cv.id] = persons.map((p) => p.id);
              }
            } catch {
              // ignore
            }
          }
        } else {
          customFields[cv.id] = cv.text || null;
        }
      }

      // Attach subtasks from the pre-fetched subitem map
      const subtasks: NormalisedTask[] = [];
      for (const ref of item.subitems ?? []) {
        const full = subitemMap.get(ref.id);
        if (full) subtasks.push(this.normaliseSubitem(full, item.id, usersMap));
      }

      return {
        id: item.id,
        name: item.name,
        completed: item.state === 'done',
        assigneeId,
        sectionId: item.group?.id,
        customFields,
        subtasks,
        comments: this.normaliseUpdates(item.updates ?? [], usersMap),
        attachments: this.normaliseAssets(item.assets ?? []),
        dependencyIds: [],
      };
    });
  }

  /** Normalise a fully-fetched subitem into a NormalisedTask.
   *  Uses cv.type directly (sub-board column IDs differ from the parent board). */
  private normaliseSubitem(
    sub: MondaySubitem,
    parentId: string,
    usersMap: Map<string, NormalisedUser>,
  ): NormalisedTask {
    const customFields: Record<string, string | string[] | null> = {};
    let assigneeId: string | undefined;
    let dueDate: string | undefined;

    for (const cv of sub.column_values) {
      if (cv.type === 'name' || cv.type === 'subitems') continue;

      if (cv.type === 'people' || cv.type === 'team') {
        if (cv.value) {
          try {
            const parsed = JSON.parse(cv.value) as {
              personsAndTeams?: Array<{ id: string; kind: string }>;
            };
            const persons = parsed.personsAndTeams?.filter((p) => p.kind === 'person') ?? [];
            if (persons.length > 0) {
              if (!assigneeId) assigneeId = persons[0].id;
              customFields[cv.id] = persons.map((p) => p.id);
            }
          } catch {
            // ignore
          }
        }
      } else if (cv.type === 'date' && cv.text && !dueDate) {
        dueDate = cv.text; // "YYYY-MM-DD"
      } else {
        customFields[cv.id] = cv.text || null;
      }
    }

    return {
      id: sub.id,
      name: sub.name,
      completed: sub.state === 'done',
      assigneeId,
      dueDate,
      customFields,
      subtasks: [],
      comments: this.normaliseUpdates(sub.updates ?? [], usersMap),
      attachments: this.normaliseAssets(sub.assets ?? []),
      dependencyIds: [],
      parentId,
    };
  }

  private normaliseUpdates(
    updates: MondayUpdate[],
    usersMap: Map<string, NormalisedUser>,
  ): NormalisedComment[] {
    return updates
      .filter((u) => u.body?.trim())
      .map((u) => {
        if (u.creator && !usersMap.has(u.creator.id)) {
          usersMap.set(u.creator.id, {
            id: u.creator.id,
            name: u.creator.name,
            email: u.creator.email,
          });
        }
        return {
          id: u.id,
          authorId: u.creator?.id ?? 'unknown',
          authorName: u.creator?.name ?? 'Unknown',
          text: u.body,
          createdAt: u.created_at,
        };
      });
  }

  private normaliseAssets(assets: MondayAsset[]): NormalisedAttachment[] {
    return assets.map((a) => ({
      id: a.id,
      name: a.name,
      url: a.public_url,
      mimeType: this.mimeFromExtension(a.file_extension),
    }));
  }

  private mimeFromExtension(ext: string): string | undefined {
    const map: Record<string, string> = {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      csv: 'text/csv',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      txt: 'text/plain',
    };
    return map[ext?.toLowerCase()] ?? undefined;
  }
}

// ---------------------------------------------------------------------------
// Monday API shapes (internal — not exported)
// ---------------------------------------------------------------------------

interface MondayColumn {
  id: string;
  title: string;
  type: string;
  settings_str?: string;
}

interface MondayColumnValue {
  id: string;
  type: string;
  text: string;
  value: string | null;
}

interface MondayUpdate {
  id: string;
  body: string;
  created_at: string;
  creator?: { id: string; name: string; email: string };
}

interface MondayAsset {
  id: string;
  name: string;
  public_url: string;
  file_extension: string;
}

interface MondayItem {
  id: string;
  name: string;
  state: string;
  group?: { id: string };
  column_values: MondayColumnValue[];
  subitems?: Array<{ id: string }>; // only IDs are fetched inline
  updates?: MondayUpdate[];
  assets?: MondayAsset[];
}

interface MondaySubitem extends Omit<MondayItem, 'subitems'> {}

interface MondayBoard {
  id: string;
  name: string;
  description?: string;
  columns: MondayColumn[];
  groups: Array<{ id: string; title: string }>;
  items_page: {
    cursor: string | null;
    items: MondayItem[];
  };
}
