//-------------------------//
// src/types/index.ts
// Code implemented by Cirface.com / MMG
//
// Normalised data model shared between connectors, destination writer,
// and the React frontend. All source platforms map their data into these
// types before the migration engine writes to Asana.
//
// Disclaimer: This code was created with the help of Claude.AI
//
// This code is part of Cirface Migration Tool
// Last updated by: 2026MAR11 - LMR
//-------------------------//

// ---------------------------------------------------------------------------
// Source platforms
// ---------------------------------------------------------------------------

export type SourcePlatform = 'monday' | 'trello';

// ---------------------------------------------------------------------------
// Normalised field types
// ---------------------------------------------------------------------------

export type NormalisedFieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'dropdown'
  | 'checkbox'
  | 'people'
  | 'link'
  | 'unknown';

export interface NormalisedFieldOption {
  id: string;
  name: string;
  color?: string;
}

export interface NormalisedField {
  id: string;
  name: string;
  type: NormalisedFieldType;
  options?: NormalisedFieldOption[]; // for dropdown fields
  description?: string;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface NormalisedUser {
  id: string;
  name: string;
  email: string;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface NormalisedComment {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  createdAt: string; // ISO 8601
}

export interface NormalisedAttachment {
  id: string;
  name: string;
  url: string;
  mimeType?: string;
}

export interface NormalisedTask {
  id: string;
  name: string;
  description?: string;
  assigneeId?: string;
  dueDate?: string;       // ISO 8601 date
  completed: boolean;
  customFields: Record<string, string | string[] | null>; // fieldId -> value
  subtasks: NormalisedTask[];
  comments: NormalisedComment[];
  attachments: NormalisedAttachment[];
  dependencyIds: string[]; // IDs of tasks this task depends on
  parentId?: string;
  sectionId?: string;     // source section/group ID
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export interface NormalisedSection {
  id: string;
  name: string;
}

export interface NormalisedProject {
  id: string;
  name: string;
  description?: string;
  tasks: NormalisedTask[];
  fields: NormalisedField[];
  users: NormalisedUser[];
  sections: NormalisedSection[]; // board groups / Trello lists / etc.
}

// ---------------------------------------------------------------------------
// Mapping configs (user + field)
// ---------------------------------------------------------------------------

export interface UserMappingEntry {
  sourceId: string;
  sourceName: string;
  sourceEmail: string;
  destId: string | null;   // null = unmapped (task will have no assignee)
  destName: string | null;
}

export type AsanaFieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'enum'
  | 'multi_enum'
  | 'people'
  | 'external_references';

export interface EnumMappingEntry {
  sourceOption: string;       // source option name
  destOptionGid: string | null; // null = create/ignore
}

export interface FieldMappingEntry {
  sourceFieldId: string;
  sourceFieldName: string;
  sourceFieldType: NormalisedFieldType;
  sourceOptions?: NormalisedFieldOption[]; // populated for dropdown source fields
  // null destFieldId means: create a new field at project level
  destFieldId: string | null;
  destFieldName: string | null;
  destFieldType: AsanaFieldType | null;
  isOrgWide: boolean;
  confidence: 'exact' | 'name' | 'type' | 'none';
  omit: boolean;
  // populated when both source and dest are enum/dropdown types
  enumMapping?: EnumMappingEntry[];
  /** When set, value is written to a native Asana task field instead of creating a custom field. */
  destNativeField?: 'due_on' | 'notes' | 'assignee' | 'followers';
}

// ---------------------------------------------------------------------------
// Migration report
// ---------------------------------------------------------------------------

export interface MigrationReportItem {
  taskId: string;
  taskName: string;
  status: 'success' | 'warning' | 'error';
  message?: string;
}

export interface MigrationReport {
  startedAt: string;
  completedAt: string;
  sourceProject: string;
  destProject: string;
  totalTasks: number;
  migratedTasks: number;
  migratedSubtasks: number;
  migratedComments: number;
  migratedAttachments: number;
  migratedDependencies: number;
  log: Array<{ time: string; message: string }>; // timestamped activity log
  warnings: number;
  errors: number;
  items: MigrationReportItem[];
  trackingTaskGid?: string; // GID of the report task created in Asana
}

// ---------------------------------------------------------------------------
// Session state shape (used by both server and frontend via API)
// ---------------------------------------------------------------------------

export interface SessionStateResponse {
  authenticated: boolean;
  user: { name: string; email: string } | null;
  sourceConnected: boolean;
  sourcePlatform: SourcePlatform | null;
  destConnected: boolean;
  trackingProjectId: string | null;
  trackingProjectName: string | null;
  userMappingDone: boolean;
  lastReport: MigrationReport | null;
}

// ---------------------------------------------------------------------------
// API response shapes
// ---------------------------------------------------------------------------

export interface ProjectListItem {
  id: string;
  name: string;
}

export interface AsanaProjectListItem {
  gid: string;
  name: string;
}
