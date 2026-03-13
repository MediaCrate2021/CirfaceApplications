//-------------------------//
// connectors/trello.ts
// Code implemented by Cirface.com / MMG
//
// Trello source connector. Uses the Trello REST API v1.
// All data is normalised into the shared NormalisedProject shape
// before being returned to the migration engine.
//
// Trello auth requires both an API key and a user token.
// Pass them combined as "apiKey:token" in the token field.
// API key: https://trello.com/app-key
// Token:   generate from https://trello.com/app-key (click "Token" link)
//
// Trello → Normalised mapping:
//   Board         → Project
//   Card          → Task
//   Checklist items → Subtasks
//   Card actions (commentCard) → Comments
//   Attachments   → Attachments
//   Labels        → Custom field (dropdown)
//   Custom Fields Power-Up → Custom fields (if enabled on the board)
//   Dependencies  → Not natively supported in Trello; skipped
//
// Disclaimer: This code was created with the help of Claude.AI
//
// This code is part of Cirface Migration Tool
// Last updated by: 2026MAR11 - LMR
//-------------------------//

import type { SourceConnector } from './base.js';
import type {
  NormalisedAttachment,
  NormalisedComment,
  NormalisedField,
  NormalisedProject,
  NormalisedTask,
  NormalisedUser,
  ProjectListItem,
} from '../src/types/index.js';

const TRELLO_BASE = 'https://api.trello.com/1';

export class TrelloConnector implements SourceConnector {
  readonly platform = 'trello' as const;
  private key: string;
  private token: string;

  /**
   * @param credential - Combined "apiKey:token" string.
   */
  constructor(credential: string) {
    const [key, ...rest] = credential.split(':');
    if (!key || !rest.length) {
      throw new Error('Trello credential must be in "apiKey:token" format');
    }
    this.key = key.trim();
    this.token = rest.join(':').trim(); // re-join in case token itself contains colons
  }

  private auth(): Record<string, string> {
    return { key: this.key, token: this.token };
  }

  private async get<T = unknown>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${TRELLO_BASE}${path}`);
    const allParams = { ...this.auth(), ...params };
    for (const [k, v] of Object.entries(allParams)) {
      url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30_000) });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Trello API error (${res.status}): ${text}`);
      (err as NodeJS.ErrnoException).code = String(res.status);
      throw err;
    }

    return res.json() as Promise<T>;
  }

  // ---------------------------------------------------------------------------
  // Interface implementation
  // ---------------------------------------------------------------------------

  async testConnection(): Promise<{ workspaceName: string }> {
    const me = await this.get<TrelloMember>('/members/me', {
      fields: 'fullName,username,idOrganizations',
    });

    // Get the first organization name if available
    let workspaceName = me.username;
    if (me.idOrganizations?.length) {
      try {
        const org = await this.get<{ displayName: string }>(
          `/organizations/${me.idOrganizations[0]}`,
          { fields: 'displayName' },
        );
        workspaceName = org.displayName;
      } catch {
        // fall back to username if org fetch fails
      }
    }

    return { workspaceName };
  }

  async getUsers(): Promise<NormalisedUser[]> {
    const me = await this.get<TrelloMember>('/members/me', {
      fields: 'fullName,username,email,idOrganizations',
    });

    const usersMap = new Map<string, NormalisedUser>();

    // Include the authenticated user
    usersMap.set(me.id, {
      id: me.id,
      name: me.fullName ?? me.username,
      email: me.email ?? `${me.username}@trello`,
    });

    // Get organization members if available
    if (me.idOrganizations?.length) {
      try {
        const orgMembers = await this.get<TrelloMember[]>(
          `/organizations/${me.idOrganizations[0]}/members`,
          { fields: 'fullName,username,email' },
        );
        for (const m of orgMembers) {
          usersMap.set(m.id, {
            id: m.id,
            name: m.fullName ?? m.username,
            email: m.email ?? `${m.username}@trello`,
          });
        }
      } catch {
        // org membership may not be accessible; continue with just the authed user
      }
    }

    return Array.from(usersMap.values());
  }

  async getProjects(): Promise<ProjectListItem[]> {
    const boards = await this.get<TrelloBoard[]>('/members/me/boards', {
      fields: 'id,name',
      filter: 'open',
    });
    return boards.map((b) => ({ id: b.id, name: b.name }));
  }

  async getProjectFields(boardId: string): Promise<NormalisedField[]> {
    const [labels, customFieldDefs] = await Promise.all([
      this.get<TrelloLabel[]>(`/boards/${boardId}/labels`, { fields: 'id,name,color' }),
      this.getBoardCustomFields(boardId),
    ]);
    const fields: NormalisedField[] = [];
    if (labels.length) {
      fields.push({
        id: '_trello_labels',
        name: 'Labels',
        type: 'dropdown',
        options: labels.filter((l) => l.name).map((l) => ({ id: l.id, name: l.name, color: l.color })),
      });
    }
    for (const cf of customFieldDefs) {
      fields.push(this.normaliseCustomFieldDef(cf));
    }
    return fields;
  }

  async getProjectData(boardId: string): Promise<NormalisedProject> {
    // Fetch board, members, labels, custom fields, and all cards in parallel
    const [board, members, labels, customFieldDefs, cards] = await Promise.all([
      this.get<TrelloBoard>(`/boards/${boardId}`, { fields: 'id,name,desc' }),
      this.get<TrelloMember[]>(`/boards/${boardId}/members`, { fields: 'fullName,username,email' }),
      this.get<TrelloLabel[]>(`/boards/${boardId}/labels`, { fields: 'id,name,color' }),
      this.getBoardCustomFields(boardId),
      this.get<TrelloCard[]>(`/boards/${boardId}/cards`, {
        fields: 'id,name,desc,due,dueComplete,idMembers,idChecklists,idLabels,pos',
        attachments: 'true',
        attachment_fields: 'id,name,url,mimeType',
        actions: 'commentCard',
        action_fields: 'id,data,date,memberCreator',
        checklists: 'all',
        checklist_fields: 'id,name,checkItems',
        customFieldItems: 'true',
      }),
    ]);

    const usersMap = new Map<string, NormalisedUser>(
      members.map((m) => [
        m.id,
        {
          id: m.id,
          name: m.fullName ?? m.username,
          email: m.email ?? `${m.username}@trello`,
        },
      ]),
    );

    // Build normalised fields list
    const fields: NormalisedField[] = [];

    // Labels become a single dropdown field
    if (labels.length) {
      fields.push({
        id: '_trello_labels',
        name: 'Labels',
        type: 'dropdown',
        options: labels
          .filter((l) => l.name)
          .map((l) => ({ id: l.id, name: l.name, color: l.color })),
      });
    }

    // Custom Fields Power-Up fields
    for (const cf of customFieldDefs) {
      fields.push(this.normaliseCustomFieldDef(cf));
    }

    const tasks = cards.map((card) =>
      this.normaliseCard(card, labels, customFieldDefs, usersMap),
    );

    return {
      id: board.id,
      name: board.name,
      description: board.desc ?? undefined,
      tasks,
      fields,
      sections: [], // Trello list → section migration not yet implemented
      users: Array.from(usersMap.values()),
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async getBoardCustomFields(boardId: string): Promise<TrelloCustomFieldDef[]> {
    try {
      return await this.get<TrelloCustomFieldDef[]>(`/boards/${boardId}/customFields`);
    } catch {
      // Custom Fields Power-Up may not be enabled — return empty
      return [];
    }
  }

  private normaliseCard(
    card: TrelloCard,
    labels: TrelloLabel[],
    customFieldDefs: TrelloCustomFieldDef[],
    usersMap: Map<string, NormalisedUser>,
  ): NormalisedTask {
    const customFields: Record<string, string | string[] | null> = {};

    // Map labels to the _trello_labels field
    if (card.idLabels?.length) {
      const labelNames = card.idLabels
        .map((id) => labels.find((l) => l.id === id)?.name)
        .filter((n): n is string => !!n);
      customFields['_trello_labels'] = labelNames;
    }

    // Map Custom Fields Power-Up values
    for (const item of card.customFieldItems ?? []) {
      const def = customFieldDefs.find((d) => d.id === item.idCustomField);
      if (!def) continue;
      customFields[def.id] = this.extractCustomFieldValue(item, def);
    }

    const comments = this.normaliseActions(card.actions ?? [], usersMap);
    const attachments = this.normaliseAttachments(card.attachments ?? []);
    const subtasks = this.normaliseChecklists(card.checklists ?? []);

    return {
      id: card.id,
      name: card.name,
      description: card.desc || undefined,
      assigneeId: card.idMembers?.[0] ?? undefined,
      dueDate: card.due ?? undefined,
      completed: card.dueComplete ?? false,
      customFields,
      subtasks,
      comments,
      attachments,
      dependencyIds: [], // Trello has no native dependencies
    };
  }

  private normaliseChecklists(checklists: TrelloChecklist[]): NormalisedTask[] {
    const subtasks: NormalisedTask[] = [];
    for (const checklist of checklists) {
      for (const item of checklist.checkItems ?? []) {
        subtasks.push({
          id: item.id,
          name: `[${checklist.name}] ${item.name}`,
          completed: item.state === 'complete',
          customFields: {},
          subtasks: [],
          comments: [],
          attachments: [],
          dependencyIds: [],
        });
      }
    }
    return subtasks;
  }

  private normaliseActions(
    actions: TrelloAction[],
    usersMap: Map<string, NormalisedUser>,
  ): NormalisedComment[] {
    return actions
      .filter((a) => a.type === 'commentCard' && a.data?.text?.trim())
      .map((a) => {
        const author = a.memberCreator;
        if (author && !usersMap.has(author.id)) {
          usersMap.set(author.id, {
            id: author.id,
            name: author.fullName ?? author.username,
            email: `${author.username}@trello`,
          });
        }
        return {
          id: a.id,
          authorId: author?.id ?? 'unknown',
          authorName: author?.fullName ?? author?.username ?? 'Unknown',
          text: a.data!.text!,
          createdAt: a.date,
        };
      });
  }

  private normaliseAttachments(attachments: TrelloAttachment[]): NormalisedAttachment[] {
    return attachments.map((a) => ({
      id: a.id,
      name: a.name,
      url: a.url,
      mimeType: a.mimeType ?? undefined,
    }));
  }

  private normaliseCustomFieldDef(def: TrelloCustomFieldDef): NormalisedField {
    if (def.type === 'list') {
      return {
        id: def.id,
        name: def.name,
        type: 'dropdown',
        options: (def.options ?? []).map((o) => ({
          id: o.id,
          name: o.value?.text ?? o.id,
        })),
      };
    }
    const typeMap: Record<string, NormalisedField['type']> = {
      text:     'text',
      number:   'number',
      date:     'date',
      checkbox: 'checkbox',
    };
    return {
      id: def.id,
      name: def.name,
      type: typeMap[def.type] ?? 'unknown',
    };
  }

  private extractCustomFieldValue(
    item: TrelloCustomFieldItem,
    def: TrelloCustomFieldDef,
  ): string | null {
    if (def.type === 'list') {
      const option = def.options?.find((o) => o.id === item.idValue);
      return option?.value?.text ?? null;
    }
    const v = item.value;
    if (!v) return null;
    if (v.text   !== undefined) return v.text;
    if (v.number !== undefined) return String(v.number);
    if (v.date   !== undefined) return v.date;
    if (v.checked !== undefined) return v.checked;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Trello API shapes (internal — not exported)
// ---------------------------------------------------------------------------

interface TrelloMember {
  id: string;
  fullName?: string;
  username: string;
  email?: string;
  idOrganizations?: string[];
}

interface TrelloBoard {
  id: string;
  name: string;
  desc?: string;
}

interface TrelloLabel {
  id: string;
  name: string;
  color: string;
}

interface TrelloChecklist {
  id: string;
  name: string;
  checkItems?: Array<{ id: string; name: string; state: 'complete' | 'incomplete' }>;
}

interface TrelloAttachment {
  id: string;
  name: string;
  url: string;
  mimeType?: string | null;
}

interface TrelloAction {
  id: string;
  type: string;
  date: string;
  data?: { text?: string };
  memberCreator?: { id: string; fullName?: string; username: string };
}

interface TrelloCard {
  id: string;
  name: string;
  desc?: string;
  due?: string | null;
  dueComplete?: boolean;
  idMembers?: string[];
  idLabels?: string[];
  idChecklists?: string[];
  attachments?: TrelloAttachment[];
  actions?: TrelloAction[];
  checklists?: TrelloChecklist[];
  customFieldItems?: TrelloCustomFieldItem[];
}

interface TrelloCustomFieldDef {
  id: string;
  name: string;
  type: 'text' | 'number' | 'date' | 'checkbox' | 'list';
  options?: Array<{ id: string; value?: { text?: string } }>;
}

interface TrelloCustomFieldItem {
  idCustomField: string;
  idValue?: string; // for list type
  value?: {
    text?: string;
    number?: string;
    date?: string;
    checked?: string;
  };
}
