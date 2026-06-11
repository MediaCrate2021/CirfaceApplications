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

export type SourcePlatform = 'monday' | 'trello' | 'smartsheet' | 'asana' | 'wrike';

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
  /** True when this field exists only on the subitem sub-board (not on the parent board). Monday only. */
  isSubitemField?: boolean;
  /** True when this field comes from the organisation-level library. Asana only. */
  isLibraryField?: boolean;
  /** True when this field type cannot be meaningfully migrated (e.g. pulse_id, button, autonumber). */
  nonMigratable?: boolean;
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
  /** Warnings collected during the fetch/normalisation phase, before migration begins. */
  fetchWarnings?: MigrationReportItem[];
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
  /**
   * When true, duplicate enum option names are automatically deduplicated before creating the
   * Asana field (keeping the first occurrence). When false/unset, duplicates are sent as-is and
   * Asana will reject the field creation — the user should fix them in the source system first.
   */
  deduplicateOptions?: boolean;
  /** True when this field originates from the subitem sub-board only (not the parent board). */
  isSubitemField?: boolean;
  /** True when this field type cannot be meaningfully migrated. It is shown for awareness but always omitted. */
  nonMigratable?: boolean;
  /**
   * When set, this subitem field shares the same destination as the parent field with this ID.
   * In new-project mode: no separate Asana field is created — the parent field's GID is reused.
   * In existing-project mode: the same destination field is pre-selected.
   */
  linkedToParentSourceFieldId?: string;
}

export interface SectionMappingEntry {
  sourceId: string;
  sourceName: string;
  /** GID of an existing Asana section (existing-project mode). Null = create new. */
  destId: string | null;
  /** Name to use when creating a new section, or the matched existing section name. */
  destName: string | null;
  omit: boolean;
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

export interface SkippedSubitemField {
  fieldId: string;
  fieldName: string;
  count: number; // number of subitem field values that were skipped
}

export interface FailedAttachment {
  taskId: string;
  taskName: string;
  attachmentId: string;
  attachmentName: string;
  url: string;
  boardId: string;   // source board ID — used to construct a Monday item link
  reason: string;    // error message from the failed transfer
}

export interface MigrationReport {
  startedAt: string;
  completedAt: string;
  sourcePlatform: string;
  sourceProject: string;
  destProject: string;       // GID
  destProjectName: string;   // display name
  totalTasks: number;
  migratedTasks: number;
  migratedSubtasks: number;
  migratedComments: number;
  failedComments: number;
  migratedAttachments: number;
  migratedDependencies: number;
  log: Array<{ time: string; message: string }>; // timestamped activity log
  warnings: number;
  errors: number;
  items: MigrationReportItem[];
  skippedSubitemFields: SkippedSubitemField[];
  failedAttachments: FailedAttachment[];
  sourceCount?: { tasks: number; subtasks: number; comments: number; attachments: number; dependencies: number };
  cancelled?: boolean;      // true if the migration was stopped by the user mid-run
  attachmentsSkipped?: boolean; // true if the user opted to skip attachment migration
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
// Analysis report (analyze-only mode)
// ---------------------------------------------------------------------------

export interface ProjectAnalysis {
  projectId: string;
  projectName: string;
  tasks: number;
  subtasks: number;
  comments: number;
  attachments: number;
  dependencies: number;
  users: number;
  fields: NormalisedField[];
  /** Display name of the project owner, if available from the source platform. */
  ownerName?: string;
  /** Project start date (YYYY-MM-DD), if available. */
  startDate?: string;
  /** Project end / due date (YYYY-MM-DD), if available. */
  endDate?: string;
}

export interface AnalysisReport {
  startedAt: string;
  completedAt: string;
  sourcePlatform: string;
  projects: ProjectAnalysis[];
  trackingTaskGid?: string;
  clientName?: string;
  clientEmail?: string;
}

// ---------------------------------------------------------------------------
// API response shapes
// ---------------------------------------------------------------------------

export interface ProjectListItem {
  id: string;
  name: string;
  /** Display name of the project owner, if available from the source platform. */
  ownerName?: string;
  /** Project start date (YYYY-MM-DD), if available. */
  startDate?: string;
  /** Project end / due date (YYYY-MM-DD), if available. */
  endDate?: string;
}

export interface AsanaProjectListItem {
  gid: string;
  name: string;
}
