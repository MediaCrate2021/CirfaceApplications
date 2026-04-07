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
        Authorization: this.token.startsWith('Bearer ') ? this.token : `Bearer ${this.token}`,
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
        ? `query($wsId: [ID!]) { boards(limit: 200, workspace_ids: $wsId) { id name } }`
        : `query { boards(limit: 200) { id name } }`,
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

  /** Returns the custom fields defined on this board's subitem board (may be empty if no subitems exist).
   *  Strategy: find the subitems column on the parent board, parse its settings_str to get the
   *  sub-board ID, then query that board directly. This is more reliable than subitems_board
   *  which is not available in all API versions.
   */
  async getSubitemFields(boardId: string): Promise<NormalisedField[]> {
    // Step 1: get raw parent columns (unfiltered) to find the subitems column
    const parentData = await this.gql<{
      boards: Array<{ columns: MondayColumn[] }>;
    }>(`
      query($boardId: [ID!]) {
        boards(ids: $boardId) {
          columns { id title type settings_str }
        }
      }
    `, { boardId: [boardId] });

    const parentCols = parentData.boards[0]?.columns ?? [];
    const subitemsCol = parentCols.find((c) => c.type === 'subitems' || c.type === 'subtasks');
    logger.info({ boardId, parentColTypes: parentCols.map((c) => c.type), foundSubitemsCol: !!subitemsCol, settings_str: subitemsCol?.settings_str }, 'getSubitemFields: parent columns');
    if (!subitemsCol) return [];

    // Step 2: parse the subitem board ID from settings_str
    let subBoardId: string | undefined;
    try {
      const settings = JSON.parse(subitemsCol.settings_str ?? '{}') as { boardIds?: number[] };
      subBoardId = settings.boardIds?.[0] != null ? String(settings.boardIds[0]) : undefined;
      logger.info({ boardId, settings, subBoardId }, 'getSubitemFields: parsed settings_str');
    } catch (err) {
      logger.warn({ err, settings_str: subitemsCol.settings_str }, 'getSubitemFields: failed to parse settings_str');
      return [];
    }
    if (!subBoardId) return [];

    // Step 3: query the subitem board for its columns
    const subData = await this.gql<{
      boards: Array<{ columns: MondayColumn[] }>;
    }>(`
      query($subBoardId: [ID!]) {
        boards(ids: $subBoardId) {
          columns { id title type settings_str }
        }
      }
    `, { subBoardId: [subBoardId!] });

    const cols = subData.boards[0]?.columns ?? [];
    return this.normaliseColumns(cols);
  }

  async getProjectData(boardId: string): Promise<NormalisedProject> {
    // Phase 1: Fetch board structure — columns, groups, and items with column values.
    // updates/assets are excluded here because combining them in a single items_page
    // query exceeds Monday's query complexity limit. Full data is fetched in Phase 2.
    // subitems { id } is also excluded — we fetch all subitems via the sub-board in
    // Phase 1b so that we are not limited by Monday's implicit inline subitem cap.
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
              column_values { id type text value ... on DependencyValue { linked_items { id } } ... on FileValue { files { ... on FileAssetValue { asset { id public_url name } } } } ... on LongTextValue { text } }
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

    // Collect all parent items across pages
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
              column_values { id type text value ... on DependencyValue { linked_items { id } } ... on FileValue { files { ... on FileAssetValue { asset { id public_url name } } } } ... on LongTextValue { text } }
            }
          }
        }
      `, { cursor });

      allItems = [...allItems, ...page.next_items_page.items];
      cursor = page.next_items_page.cursor;
    }

    // Phase 1b: fetch ALL subitems with full data directly from the sub-board.
    // We paginate the sub-board (not use the root items() query) because Monday's
    // root items(ids:[...]) endpoint does NOT return subitem-board items — only
    // top-level board items. Full column_values/updates/assets are fetched here
    // so subitems are never passed to fetchItemsByIds.
    const subitemMap = new Map<string, MondaySubitem>();
    const subBoardId = this.parseSubBoardId(board.columns);
    if (subBoardId) {
      const allSubitemData = await this.fetchAllSubitemData(subBoardId);
      const parentToSubitems = new Map<string, Array<{ id: string }>>();
      for (const sub of allSubitemData) {
        if (sub.parent_item?.id) {
          subitemMap.set(sub.id, sub);
          if (!parentToSubitems.has(sub.parent_item.id)) parentToSubitems.set(sub.parent_item.id, []);
          parentToSubitems.get(sub.parent_item.id)!.push({ id: sub.id });
        }
      }
      for (const item of allItems) {
        item.subitems = parentToSubitems.get(item.id) ?? [];
      }
      const nullParentCount = allSubitemData.length - subitemMap.size;
      logger.info({ boardId, subBoardId, subitemTotal: allSubitemData.length, subitemMapped: subitemMap.size, nullParentCount }, 'Phase 1b: fetched all subitem data from sub-board');
    }

    // Phase 2: fetch column values and item-level assets for PARENT items.
    // Subitem column values were already fetched in Phase 1b via the sub-board.
    const parentIds = allItems.map((i) => i.id);
    logger.info({ boardId, parentItemCount: parentIds.length }, 'Phase 2: fetching parent item column values/assets');
    if (parentIds.length > 0) {
      const fetched = await this.fetchItemsByIds(parentIds);
      const fullDataMap = new Map(fetched.map((i) => [i.id, i]));
      for (const item of allItems) {
        const full = fullDataMap.get(item.id);
        if (full) item.assets = full.assets;
      }
    }

    // Phase 3: fetch updates (comments) for ALL items — parents and subitems — separately.
    // Combining updates with column-value queries causes Monday to silently truncate results
    // due to query complexity limits. Fetching them in a dedicated pass with small batches
    // and per-item pagination guarantees every comment is captured.
    const allIds = [...parentIds, ...Array.from(subitemMap.keys())];
    logger.info({ boardId, totalItems: allIds.length }, 'Phase 3: fetching updates for all items');
    if (allIds.length > 0) {
      const updatesMap = await this.fetchUpdatesForItems(allIds);
      for (const item of allItems) {
        item.updates = updatesMap.get(item.id) ?? [];
      }
      for (const [id, sub] of subitemMap) {
        sub.updates = updatesMap.get(id) ?? [];
      }
      const totalUpdates = [...updatesMap.values()].reduce((n, u) => n + u.length, 0);
      logger.info({ boardId, totalUpdates }, 'Phase 3: updates complete');
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

  /** Batch-fetch column values and item-level assets by ID. Updates are fetched separately
   *  via fetchUpdatesForItems to avoid Monday's query complexity limits. */
  private async fetchItemsByIds(ids: string[]): Promise<MondaySubitem[]> {
    const BATCH = 100;
    const results: MondaySubitem[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const data = await this.gql<{ items: MondaySubitem[] }>(`
        query($ids: [ID!]!) {
          items(ids: $ids) {
            id name state
            column_values { id type text value ... on FileValue { files { ... on FileAssetValue { asset { id public_url name } } } } ... on LongTextValue { text } }
            assets { id name public_url file_extension }
          }
        }
      `, { ids: batch });
      results.push(...(data.items ?? []));
    }
    return results;
  }

  /**
   * Phase 3: fetch ALL updates (comments) for the given item IDs.
   * Updates are fetched separately from column values to avoid Monday's query complexity
   * limits — combining updates with items_page or large ID batches causes silent truncation.
   * Items are queried in small batches (BATCH_SIZE). Within each batch, we paginate until
   * every item returns fewer updates than PAGE_LIMIT, guaranteeing completeness.
   * Returns a map of itemId → MondayUpdate[].
   */
  private async fetchUpdatesForItems(ids: string[]): Promise<Map<string, MondayUpdate[]>> {
    const PAGE_LIMIT = 50;  // conservative — 10 items × 50 updates is well within budget
    const BATCH_SIZE = 10;
    const result = new Map<string, MondayUpdate[]>(ids.map((id) => [id, []]));

    const fetchPage = async (batch: string[], page: number): Promise<Map<string, MondayUpdate[]>> => {
      const data = await this.gql<{ items: Array<{ id: string; updates: MondayUpdate[] }> }>(`
        query($ids: [ID!]!, $limit: Int!, $page: Int!) {
          items(ids: $ids) {
            id
            updates(limit: $limit, page: $page) {
              id body created_at
              creator { id name email }
              assets { id name public_url file_extension }
            }
          }
        }
      `, { ids: batch, limit: PAGE_LIMIT, page });
      const pageMap = new Map<string, MondayUpdate[]>();
      for (const item of data.items ?? []) {
        pageMap.set(item.id, item.updates ?? []);
      }
      return pageMap;
    };

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      let page = 1;
      const page1 = await fetchPage(batch, page);
      for (const [id, updates] of page1) result.get(id)!.push(...updates);

      // Any item that returned a full page may have more — paginate until exhausted
      let needMore = batch.filter((id) => (page1.get(id)?.length ?? 0) >= PAGE_LIMIT);
      while (needMore.length > 0) {
        page++;
        const next = await fetchPage(needMore, page);
        const stillMore: string[] = [];
        for (const [id, updates] of next) {
          result.get(id)!.push(...updates);
          if (updates.length >= PAGE_LIMIT) stillMore.push(id);
        }
        needMore = stillMore;
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Extract the subitem board ID from a parent board's columns settings_str. */
  private parseSubBoardId(columns: MondayColumn[]): string | undefined {
    const col = columns.find((c) => c.type === 'subitems' || c.type === 'subtasks');
    if (!col?.settings_str) return undefined;
    try {
      const settings = JSON.parse(col.settings_str) as { boardIds?: number[] };
      return settings.boardIds?.[0] != null ? String(settings.boardIds[0]) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Paginate through ALL items on the subitem board, returning id + parent_item for each.
   * Full column_values, updates, and assets are fetched here so subitems never need
   * to go through the root items(ids:[...]) query, which does not return subitem-board items.
   * For any items where parent_item is still null after the board query, a root-level
   * items(ids:[...]) fallback is attempted to resolve the parent relationship.
   */
  private async fetchAllSubitemData(
    subBoardId: string,
  ): Promise<Array<MondaySubitem & { parent_item: { id: string } | null }>> {
    type SubData = MondaySubitem & { parent_item: { id: string } | null };
    const results: SubData[] = [];

    const initial = await this.gql<{
      boards: Array<{ items_page: { cursor: string | null; items: SubData[] } }>;
    }>(`
      query($subBoardId: [ID!]) {
        boards(ids: $subBoardId) {
          items_page(limit: 100) {
            cursor
            items {
              id name state
              parent_item { id }
              column_values { id type text value ... on FileValue { files { ... on FileAssetValue { asset { id public_url name } } } } ... on LongTextValue { text } }
              assets { id name public_url file_extension }
            }
          }
        }
      }
    `, { subBoardId: [subBoardId] });

    const page0 = initial.boards[0]?.items_page;
    if (!page0) return results;

    results.push(...page0.items);
    let cursor = page0.cursor;

    while (cursor) {
      const page = await this.gql<{
        next_items_page: { cursor: string | null; items: SubData[] };
      }>(`
        query($cursor: String!) {
          next_items_page(limit: 100, cursor: $cursor) {
            cursor
            items {
              id name state
              parent_item { id }
              column_values { id type text value ... on FileValue { files { ... on FileAssetValue { asset { id public_url name } } } } ... on LongTextValue { text } }
              assets { id name public_url file_extension }
            }
          }
        }
      `, { cursor });

      results.push(...page.next_items_page.items);
      cursor = page.next_items_page.cursor;
    }

    // Fallback: for items where parent_item came back null from the board-level query,
    // try the root-level items() query to resolve the parent relationship only.
    const orphanIds = results.filter((r) => !r.parent_item?.id).map((r) => r.id);
    if (orphanIds.length > 0) {
      logger.warn({ subBoardId, orphanCount: orphanIds.length }, 'fetchAllSubitemData: subitems missing parent_item, retrying via root items query');
      const BATCH = 100;
      const rootParentMap = new Map<string, string>();
      for (let i = 0; i < orphanIds.length; i += BATCH) {
        const batch = orphanIds.slice(i, i + BATCH);
        const rootData = await this.gql<{ items: Array<{ id: string; parent_item: { id: string } | null }> }>(`
          query($ids: [ID!]!) {
            items(ids: $ids) { id parent_item { id } }
          }
        `, { ids: batch });
        for (const item of rootData.items ?? []) {
          if (item.parent_item?.id) rootParentMap.set(item.id, item.parent_item.id);
        }
      }
      for (const result of results) {
        if (!result.parent_item?.id && rootParentMap.has(result.id)) {
          result.parent_item = { id: rootParentMap.get(result.id)! };
        }
      }
      logger.info({ resolved: rootParentMap.size, stillOrphaned: orphanIds.length - rootParentMap.size }, 'fetchAllSubitemData: fallback root query');
    }

    logger.info({ subBoardId, total: results.length, withParent: results.filter((r) => r.parent_item?.id).length }, 'fetchAllSubitemData: complete');
    return results;
  }

  private normaliseColumns(columns: MondayColumn[]): NormalisedField[] {
    return columns
      // Exclude purely structural columns that have no data value at all.
      .filter((c) => !['name', 'subitems', 'subtasks', 'board_relation', 'file'].includes(c.type))
      .map((c) => {
        const type = this.mapColumnType(c.type);
        const field: NormalisedField = { id: c.id, name: c.title, type };

        // Mark column types that cannot be meaningfully migrated to Asana.
        // These are shown in the UI for awareness but are always omitted from migration.
        const NON_MIGRATABLE_TYPES = new Set([
          'pulse_id',     // Monday's built-in Item ID — already captured as External ID
          'item_id',      // alias for pulse_id in some API versions
          'autonumber',   // auto-generated row number
          'creation_log', // system-managed creation timestamp/user
          'last_updated', // system-managed last-updated timestamp/user
          'button',       // action buttons — no data value
          'vote',         // voting widget — no direct Asana equivalent
          'rating',       // star/rating widget
          'world_clock',  // time zone display
          'color_picker', // colour swatch, no equivalent
        ]);
        if (NON_MIGRATABLE_TYPES.has(c.type)) {
          field.nonMigratable = true;
        }

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
      dependency: 'text',
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
      const dependencyIds: string[] = [];

      for (const cv of item.column_values) {
        // Use cv.type directly — more reliable than looking up the column definition,
        // which can miss built-in columns that don't appear in board.columns.
        const colType = cv.type || columns.find((c) => c.id === cv.id)?.type;

        if (colType === 'dependency') {
          // Store raw dependency data as a text field so it is visible in Asana for debugging.
          // Also populate dependencyIds for wiring — prefer linked_items from the typed inline
          // fragment, fall back to parsing the generic value JSON.
          if (cv.linked_items?.length) {
            for (const linked of cv.linked_items) {
              dependencyIds.push(linked.id);
            }
            customFields[cv.id] = cv.linked_items.map((l) => l.id).join(', ');
          } else {
            customFields[cv.id] = cv.value ?? cv.text ?? null;
            if (cv.value) {
              try {
                const parsed = JSON.parse(cv.value) as {
                  linkedPulseIds?: Array<{ linkedPulseId: number }>;
                };
                for (const link of parsed.linkedPulseIds ?? []) {
                  dependencyIds.push(String(link.linkedPulseId));
                }
              } catch {
                logger.warn({ itemId: item.id, colId: cv.id, value: cv.value }, 'failed to parse monday dependency value');
              }
            }
          }
          continue;
        }

        const col = columns.find((c) => c.id === cv.id);
        if (!col) continue;

        if (col.type === 'file') {
          // File columns are collected as attachments below — skip custom field storage.
          continue;
        } else if (col.type === 'people' || col.type === 'team') {
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
        } else if (col.type === 'long_text') {
          // LongTextValue inline fragment gives us the canonical text; fall back to cv.text.
          // Store as custom field so the user can map it to native Notes if desired.
          customFields[cv.id] = cv.text || null;
        } else {
          customFields[cv.id] = cv.text || null;
        }
      }

      // Collect file attachments from Files columns (via FileValue inline fragment).
      // These are in addition to any files directly attached to the item (item.assets).
      const fileColAttachments: NormalisedAttachment[] = [];
      for (const cv of item.column_values) {
        if (cv.type === 'file' && cv.files?.length) {
          for (const f of cv.files) {
            if (f.asset?.public_url) {
              fileColAttachments.push({ id: f.asset.id, name: f.asset.name, url: f.asset.public_url });
            }
          }
        }
      }

      // Attach subtasks from the pre-fetched subitem map
      const subtasks: NormalisedTask[] = [];
      for (const ref of item.subitems ?? []) {
        const full = subitemMap.get(ref.id);
        if (full) {
          subtasks.push(this.normaliseSubitem(full, item.id, usersMap));
        } else {
          logger.warn({ itemId: item.id, subitemId: ref.id }, 'normaliseBoardItems: subitem not found in subitemMap — skipping');
        }
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
        attachments: [...this.normaliseAssets(item.assets ?? []), ...fileColAttachments, ...this.normaliseUpdateAssets(item.updates ?? [])],
        dependencyIds,
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
      if (cv.type === 'name' || cv.type === 'subitems' || cv.type === 'subtasks') continue;

      if (cv.type === 'file') {
        // Collected as attachments below.
        continue;
      } else if (cv.type === 'people' || cv.type === 'team') {
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

    // Collect file attachments from Files columns.
    const fileColAttachments: NormalisedAttachment[] = [];
    for (const cv of sub.column_values) {
      if (cv.type === 'file' && cv.files?.length) {
        for (const f of cv.files) {
          if (f.asset?.public_url) {
            fileColAttachments.push({ id: f.asset.id, name: f.asset.name, url: f.asset.public_url });
          }
        }
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
      attachments: [...this.normaliseAssets(sub.assets ?? []), ...fileColAttachments, ...this.normaliseUpdateAssets(sub.updates ?? [])],
      dependencyIds: [],
      parentId,
    };
  }

  private normaliseUpdates(
    updates: MondayUpdate[],
    usersMap: Map<string, NormalisedUser>,
  ): NormalisedComment[] {
    return updates
      .filter((u) => u.body?.trim() || u.assets?.length)
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

  /** Collect all assets attached within updates (comments) as task-level attachments. */
  private normaliseUpdateAssets(updates: MondayUpdate[]): NormalisedAttachment[] {
    return updates.flatMap((u) =>
      (u.assets ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        url: a.public_url,
        mimeType: this.mimeFromExtension(a.file_extension),
      })),
    );
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
  linked_items?: Array<{ id: string }>; // populated for DependencyValue via inline fragment
  files?: Array<{ asset?: { id: string; public_url: string; name: string } }>; // FileAssetValue items from FileValue columns
}

interface MondayUpdate {
  id: string;
  body: string;
  created_at: string;
  creator?: { id: string; name: string; email: string };
  assets?: MondayAsset[]; // files attached within this update
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
  subitems?: Array<{ id: string }>; // populated in Phase 1b from sub-board fetch
  parent_item?: { id: string } | null;  // populated for sub-board items
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
