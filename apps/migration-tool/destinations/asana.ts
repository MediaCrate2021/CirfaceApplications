//-------------------------//
// destinations/asana.ts
// Code implemented by Cirface.com / MMG
//
// Asana destination writer. Takes normalised project data plus mapping
// configs and creates tasks, subtasks, comments, attachments, dependencies,
// and custom fields in the target Asana project.
//
// All operations are non-destructive — source data is never modified.
//
// Disclaimer: This code was created with the help of Claude.AI
//
// This code is part of Cirface Migration Tool
// Last updated by: 2026MAR11 - LMR
//-------------------------//

import type {
  AnalysisReport,
  AsanaFieldType,
  FieldMappingEntry,
  MigrationReport,
  MigrationReportItem,
  NormalisedAttachment,
  NormalisedProject,
  NormalisedTask,
  ProjectAnalysis,
  SectionMappingEntry,
  UserMappingEntry,
} from '../src/types/index.js';
import logger from '../logger.js';

const ASANA_BASE = 'https://app.asana.com/api/1.0';

export interface WriteOptions {
  destProjectGid: string;        // existing project GID, or '' if we create it
  destProjectName?: string;      // required when destProjectGid is ''
  destTeamGid?: string;          // required when creating a new project
  destWorkspaceGid: string;
  userMapping: UserMappingEntry[];
  fieldMapping: FieldMappingEntry[];
  /** Section mapping from source groups to Asana sections. */
  sectionMapping?: SectionMappingEntry[];
  trackingProjectGid?: string;
  trackingPortfolioGid?: string;
  /** OAuth token to use for tracking project writes when the PAT cannot access it. */
  trackingToken?: string;
  /** If set, ownership of the migrated project is transferred to this Asana user GID after migration. */
  projectOwnerGid?: string;
  /**
   * GID of an existing Asana custom field to use as the External ID (source platform item ID).
   * If null or omitted, a new project-level text field named 'm_External ID' is created.
   */
  externalIdDestFieldGid?: string | null;
  sourcePlatform?: string;
  /** Name of the PAT account performing the migration — shown in the report. */
  writerName?: string;
  /** SSE writer — called with each progress event */
  onProgress?: (event: ProgressEvent) => void;
  /** When aborted, the task loop stops after the current task and reporting still runs. */
  cancelSignal?: AbortSignal;
  /**
   * Called when a download fails with a 403 to get a fresh URL for the asset.
   * Only provided when the source connector supports URL refresh (e.g. Monday S3 URLs expire after 1 hour).
   */
  refreshAttachmentUrl?: (assetId: string) => Promise<string | null>;
  /**
   * Authenticate a download URL before fetching (e.g. append Trello key/token query params).
   * Called on every attachment download when provided.
   */
  authenticateAttachmentUrl?: (url: string) => string;
  /**
   * Maps subitem-board column IDs → parent-board column IDs for fields that share the same name.
   * Used by migrateSubtask to resolve custom fields when the subitem column ID differs from the
   * parent board column ID (common in Monday — subitems live on their own sub-board).
   */
  subitemFieldIdRemap?: Record<string, string>;
  /** Pre-migration item counts from the source project, included in the report for comparison. */
  sourceCount?: MigrationReport['sourceCount'];
}

export interface ProgressEvent {
  type: 'task' | 'info' | 'warning' | 'error';
  message: string;
  done?: number;
  total?: number;
}

export class AsanaDestination {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    tokenOverride?: string,
  ): Promise<T> {
    const res = await fetch(`${ASANA_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${tokenOverride ?? this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify({ data: body }) : undefined,
      signal: AbortSignal.timeout(30_000),
    });

    const json = await res.json().catch(() => ({})) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };

    if (!res.ok) {
      const msg = json.errors?.[0]?.message ?? `Asana API error (${res.status})`;
      const err = new Error(msg);
      (err as NodeJS.ErrnoException).code = String(res.status);
      throw err;
    }

    return json.data as T;
  }

  async testConnection(): Promise<{ workspaceName: string }> {
    const workspaces = await this.request<Array<{ gid: string; name: string }>>(
      'GET', '/workspaces?opt_fields=name&limit=1'
    );
    return { workspaceName: workspaces[0]?.name ?? 'Asana' };
  }

  async getWorkspaces(): Promise<Array<{ gid: string; name: string }>> {
    return this.request('GET', '/workspaces?opt_fields=name&limit=100');
  }

  async getTeams(workspaceGid: string): Promise<Array<{ gid: string; name: string }>> {
    return this.request(
      'GET',
      `/organizations/${encodeURIComponent(workspaceGid)}/teams?opt_fields=name&limit=100`,
    );
  }

  async getProjects(workspaceGid: string, teamGid?: string): Promise<Array<{ gid: string; name: string }>> {
    if (teamGid) {
      return this.request(
        'GET',
        `/teams/${encodeURIComponent(teamGid)}/projects?opt_fields=name&limit=100&archived=false`,
      );
    }
    return this.request(
      'GET',
      `/projects?workspace=${encodeURIComponent(workspaceGid)}&opt_fields=name&limit=100&archived=false`,
    );
  }

  async getUsers(workspaceGid: string): Promise<Array<{ gid: string; name: string; email: string }>> {
    return this.request(
      'GET',
      `/workspaces/${encodeURIComponent(workspaceGid)}/users?opt_fields=name,email&limit=100`,
    );
  }

  async getUserByGid(userGid: string): Promise<{ gid: string; name: string }> {
    return this.request('GET', `/users/${encodeURIComponent(userGid)}?opt_fields=name`);
  }

  async getOrgWideFields(workspaceGid: string): Promise<Array<{
    gid: string;
    name: string;
    resource_type: string;
    type: string;
    enum_options?: Array<{ gid: string; name: string }>;
  }>> {
    return this.request(
      'GET',
      `/workspaces/${encodeURIComponent(workspaceGid)}/custom_fields?opt_fields=name,type,resource_subtype,enum_options,enum_options.name&limit=100&is_global_to_workspace=true`,
    );
  }

  async getMe(): Promise<{ gid: string; name: string }> {
    return this.request('GET', '/users/me?opt_fields=name');
  }

  async getProjectByGid(gid: string): Promise<{ gid: string; name: string }> {
    return this.request('GET', `/projects/${encodeURIComponent(gid)}?opt_fields=name`);
  }

  async getPortfolioByGid(gid: string): Promise<{ gid: string; name: string }> {
    return this.request('GET', `/portfolios/${encodeURIComponent(gid)}?opt_fields=name`);
  }

  async addProjectToPortfolio(portfolioGid: string, projectGid: string): Promise<void> {
    await this.request('POST', `/portfolios/${encodeURIComponent(portfolioGid)}/addItem`, { item: projectGid });
  }

  async getProjectFields(projectGid: string): Promise<Array<{
    gid: string;
    name: string;
    type: string;
    isGlobal: boolean;
    enum_options?: Array<{ gid: string; name: string }>;
  }>> {
    const settings = await this.request<Array<{
      custom_field: {
        gid: string; name: string; type: string;
        is_global_to_workspace: boolean;
        enum_options?: Array<{ gid: string; name: string }>;
      };
    }>>(
      'GET',
      `/projects/${encodeURIComponent(projectGid)}/custom_field_settings?opt_fields=custom_field.gid,custom_field.name,custom_field.type,custom_field.is_global_to_workspace,custom_field.enum_options,custom_field.enum_options.name&limit=100`,
    );
    return settings.map((s) => ({
      ...s.custom_field,
      isGlobal: s.custom_field.is_global_to_workspace ?? false,
    }));
  }

  async getSections(projectGid: string): Promise<Array<{ gid: string; name: string }>> {
    return this.request(
      'GET',
      `/projects/${encodeURIComponent(projectGid)}/sections?opt_fields=name&limit=100`,
    );
  }

  // ---------------------------------------------------------------------------
  // Main migration entry point
  // ---------------------------------------------------------------------------

  async migrate(
    project: NormalisedProject,
    options: WriteOptions,
  ): Promise<MigrationReport> {
    const startedAt = new Date().toISOString();
    const report: MigrationReport = {
      startedAt,
      completedAt: '',
      sourcePlatform: options.sourcePlatform ?? 'source',
      sourceProject: project.name,
      destProject: '',
      destProjectName: '',
      totalTasks: project.tasks.length,
      migratedTasks: 0,
      migratedSubtasks: 0,
      migratedComments: 0,
      migratedAttachments: 0,
      migratedDependencies: 0,
      warnings: 0,
      errors: 0,
      items: [],
      skippedSubitemFields: [],
      failedAttachments: [],
      log: [],
      sourceCount: options.sourceCount,
    };

    const emit = options.onProgress ?? (() => {});

    /** Append a timestamped line to the report log and emit an SSE event. */
    const log = (message: string, type: ProgressEvent['type'] = 'info') => {
      report.log.push({ time: this.ts(), message });
      emit({ type, message });
    };

    /** Record a warning in the counter, the items list, and the logger so it appears in the UI report. */
    const warn = (taskId: string, taskName: string, message: string) => {
      report.warnings++;
      report.items.push({ taskId, taskName, status: 'warning', message });
      logger.warn({ taskId, taskName }, message);
    };

    const sourcePlatform = options.sourcePlatform ?? 'source';

    log('Migration job started.');
    log(`Starting Migration for '${project.name}' from ${sourcePlatform} to Asana.`);

    // Step 1: resolve or create destination project
    log('Provisioning Asana Project.');
    let projectGid = options.destProjectGid;
    if (!projectGid) {
      log(`Creating Asana project with the name '${options.destProjectName}'.`);
      const newProjectPayload: Record<string, string> = {
        name: options.destProjectName!,
        workspace: options.destWorkspaceGid,
      };
      if (options.destTeamGid) newProjectPayload.team = options.destTeamGid;
      const created = await this.request<{ gid: string; name: string }>('POST', '/projects', newProjectPayload);
      projectGid = created.gid;
      log(`Asana project '${options.destProjectName}' : '${projectGid}' created successfully.`);
      logger.info({ projectGid, projectName: options.destProjectName }, 'Asana project created');

      // Transfer ownership immediately after creation so the project is visible to the
      // user throughout the migration. Doing this last (the previous approach) meant the
      // project was invisible to the user if the UI lost its report before ownership was set.
      if (options.projectOwnerGid) {
        try {
          await this.request('PUT', `/projects/${encodeURIComponent(projectGid)}`, {
            owner: options.projectOwnerGid,
          });
          log('Project ownership transferred to specified user.');
          emit({ type: 'info', message: 'Project ownership transferred' });
        } catch (err) {
          warn('setup', 'Project ownership', `Failed to transfer project ownership: ${(err as Error).message}`);
          log(`Failed to transfer project ownership: ${(err as Error).message}`, 'warning');
        }
      }
    } else {
      log(`Migrating to existing Asana project (GID: ${projectGid}).`);
    }
    report.destProject = projectGid;
    report.destProjectName = options.destProjectName ?? options.destProjectGid;


    // Step 2: user mapping stats
    const mappedUsers = options.userMapping.filter((u) => u.destId).length;
    const unmappedUsers = options.userMapping.length - mappedUsers;
    log(`${options.userMapping.length} source users found. ${mappedUsers} mapped to Asana users, ${unmappedUsers} unmapped (tasks will have no assignee).`);
    const userGidMap = new Map<string, string>();
    for (const entry of options.userMapping) {
      if (entry.destId) userGidMap.set(entry.sourceId, entry.destId);
    }

    // Step 3: ensure custom fields exist in destination
    const activeFields = options.fieldMapping.filter((f) => !f.omit);
    const omittedFields = options.fieldMapping.length - activeFields.length;
    log(`${options.fieldMapping.length} custom fields found in source. ${omittedFields > 0 ? omittedFields + ' omitted. ' : ''}Processing ${activeFields.length} fields.`);
    const { fieldGidMap, enumOptionMap, fieldTypeMap, fieldFailures } = await this.ensureCustomFields(
      projectGid,
      options.fieldMapping,
      log,
    );
    report.warnings += fieldFailures.length;
    report.items.push(...fieldFailures);

    // Step 4: resolve the External ID field — used to store each task's source platform item ID
    // so tasks can be traced back to their origin. If the user mapped this to an existing Asana
    // field, attach that field to the project and use it. Otherwise create 'm_External ID'.
    let sourceIdFieldGid: string | undefined;
    if (options.externalIdDestFieldGid) {
      try {
        await this.request(
          'POST',
          `/projects/${encodeURIComponent(projectGid)}/addCustomFieldSetting`,
          { custom_field: options.externalIdDestFieldGid },
        );
      } catch (err) {
        const msg = (err as Error).message ?? '';
        // "already exists" means the field is already on the project — that's fine
        if (!msg.toLowerCase().includes('already exists')) {
          warn('setup', 'External ID field', `Could not attach External ID field: ${msg}`);
          log(`Could not attach External ID field: ${msg}`, 'warning');
        }
      }
      sourceIdFieldGid = options.externalIdDestFieldGid;
      log(`External ID mapped to existing field (GID: ${options.externalIdDestFieldGid}).`);
    } else {
      try {
        const setting = await this.request<{ custom_field: { gid: string } }>(
          'POST',
          `/projects/${encodeURIComponent(projectGid)}/addCustomFieldSetting?opt_fields=custom_field.gid`,
          { custom_field: { resource_subtype: 'text', name: 'm_External ID' } },
        );
        sourceIdFieldGid = setting.custom_field.gid;
        log(`'m_External ID' field created.`);
      } catch (err) {
        warn('setup', 'External ID field', `Could not create External ID field: ${(err as Error).message}`);
        log(`Could not create External ID field: ${(err as Error).message}`, 'warning');
      }
    }

    // Step 4b: create 'm_SmartSheetRow' field for Smartsheet migrations.
    // Stores the source row number so tasks can be traced back to their original Smartsheet row.
    // The Smartsheet connector injects the value into customFields under '__smartsheet_row__';
    // registering that key in fieldGidMap lets the existing customFields loop handle it automatically.
    if (options.sourcePlatform === 'smartsheet') {
      try {
        const setting = await this.request<{ custom_field: { gid: string } }>(
          'POST',
          `/projects/${encodeURIComponent(projectGid)}/addCustomFieldSetting?opt_fields=custom_field.gid`,
          { custom_field: { resource_subtype: 'text', name: 'm_SmartSheetRow' } },
        );
        fieldGidMap.set('__smartsheet_row__', setting.custom_field.gid);
        log(`'m_SmartSheetRow' field created.`);
      } catch (err) {
        warn('setup', 'm_SmartSheetRow field', `Could not create m_SmartSheetRow field: ${(err as Error).message}`);
        log(`Could not create m_SmartSheetRow field: ${(err as Error).message}`, 'warning');
      }
    }

    // Step 5: create or map Asana sections to mirror source groups/lists
    const sectionGidMap = new Map<string, string>(); // sourceSectionId → asanaSectionGid
    const secMap = new Map<string, SectionMappingEntry>();
    for (const entry of (options.sectionMapping ?? [])) {
      secMap.set(entry.sourceId, entry);
    }

    for (const section of project.sections) {
      const entry = secMap.get(section.id);
      if (entry?.omit) continue; // explicitly omitted — tasks in this section get no section
      if (entry?.destId) {
        // Map to existing Asana section
        sectionGidMap.set(section.id, entry.destId);
      } else {
        // Create new section (use mapped name if provided, otherwise source name)
        const sectionName = entry?.destName ?? section.name;
        try {
          const created = await this.request<{ gid: string }>('POST', `/projects/${encodeURIComponent(projectGid)}/sections`, {
            name: sectionName,
          });
          sectionGidMap.set(section.id, created.gid);
        } catch (err) {
          warn('setup', `Section: ${sectionName}`, `Failed to create section '${sectionName}': ${(err as Error).message}`);
          log(`Failed to create section '${sectionName}': ${(err as Error).message}`, 'warning');
        }
      }
    }

    // Derive source field IDs that map to native Asana task fields.
    // These are applied directly to the task payload instead of creating custom fields.
    const nativeDueOnSourceId     = options.fieldMapping.find((f) => f.destNativeField === 'due_on'    && !f.omit)?.sourceFieldId;
    const nativeNotesSourceId     = options.fieldMapping.find((f) => f.destNativeField === 'notes'     && !f.omit)?.sourceFieldId;
    const nativeFollowersSourceId = options.fieldMapping.find((f) => f.destNativeField === 'followers' && !f.omit)?.sourceFieldId;
    // Assignee: the synthetic '__assignee__' entry controls the task.assigneeId fallback.
    // A real people column mapped to 'assignee' (not the synthetic row) provides the source field ID.
    const assigneeEntry       = options.fieldMapping.find((f) => f.destNativeField === 'assignee');
    const nativeAssigneeSourceId = assigneeEntry && !assigneeEntry.omit && assigneeEntry.sourceFieldId !== '__assignee__'
      ? assigneeEntry.sourceFieldId
      : undefined;
    const assigneeOmitted     = assigneeEntry?.omit === true;

    // Step 5: migrate tasks
    const taskGidMap = new Map<string, string>();
    const total = project.tasks.length;
    log(`${total} tasks found in the source project.`);

    // Map sourceFieldId → human-readable display name so deeply-nested subtask comments
    // are labelled with field names rather than raw column IDs.
    const fieldDisplayMap = new Map<string, string>(
      options.fieldMapping.map((f) => [f.sourceFieldId, f.destFieldName ?? f.sourceFieldName]),
    );

    const PROGRESS_INTERVAL = 25;

    for (let i = 0; i < project.tasks.length; i++) {
      if (options.cancelSignal?.aborted) {
        report.cancelled = true;
        log(`Migration cancelled by user after ${i} of ${total} tasks.`, 'warning');
        break;
      }

      const task = project.tasks[i];
      emit({ type: 'task', message: `Migrating task: ${task.name}`, done: i + 1, total });

      const item = await this.migrateTask(task, projectGid, project.id, sectionGidMap, sourceIdFieldGid, nativeDueOnSourceId, nativeNotesSourceId, nativeAssigneeSourceId, assigneeOmitted, nativeFollowersSourceId, userGidMap, fieldGidMap, enumOptionMap, fieldTypeMap, options.subitemFieldIdRemap ?? {}, taskGidMap, report, warn, options.refreshAttachmentUrl, undefined, fieldDisplayMap);
      report.items.push(item);

      const processed = i + 1;
      if (processed % PROGRESS_INTERVAL === 0 && processed < total) {
        log(`===> ${processed} tasks processed out of ${total}`);
      }
    }

    log(`${report.migratedTasks} tasks processed out of ${total}`);
    if (report.migratedSubtasks > 0) log(`${report.migratedSubtasks} subtasks migrated.`);
    if (report.migratedComments > 0) log(`${report.migratedComments} comments migrated.`);
    if (report.migratedAttachments > 0) log(`${report.migratedAttachments} attachments transferred.`);

    // Step 6: wire up dependencies (tasks and subtasks)
    let depAttempts = 0;
    const wireDependencies = async (task: NormalisedTask): Promise<void> => {
      if (task.dependencyIds.length) {
        const taskGid = taskGidMap.get(task.id);
        if (taskGid) {
          for (const depId of task.dependencyIds) {
            const depGid = taskGidMap.get(depId);
            if (!depGid) {
              warn(task.id, task.name, `Dependency target (source ID: ${depId}) was not migrated — skipped`);
              if (taskGid) {
                try {
                  await this.request('POST', `/tasks/${encodeURIComponent(taskGid)}/stories`, {
                    text: `[m_Dependency] Predecessor task (source ID: ${depId}) could not be linked — it was not found in the migrated project.`,
                  });
                } catch { /* ignore */ }
              }
              continue;
            }
            depAttempts++;
            try {
              await this.request('POST', `/tasks/${encodeURIComponent(taskGid)}/addDependencies`, { dependencies: [depGid] });
              report.migratedDependencies++;
            } catch (err) {
              warn(task.id, task.name, `Failed to add dependency: ${(err as Error).message}`);
            }
          }
        }
      }
      for (const subtask of task.subtasks) {
        await wireDependencies(subtask);
      }
    };
    for (const task of project.tasks) {
      await wireDependencies(task);
    }
    if (depAttempts > 0) log(`${report.migratedDependencies} of ${depAttempts} dependencies wired.`);

    if (report.warnings > 0) log(`${report.warnings} warning(s) during migration.`, 'warning');
    if (report.errors > 0) log(`${report.errors} error(s) during migration.`, 'error');

    log(`Migration of '${project.name}' from ${sourcePlatform} to Asana completed.`);
    log('Flushing statistics.');
    report.completedAt = new Date().toISOString();
    log('Migration job ended.');

    // Step 6: save report to tracking project
    if (options.trackingProjectGid) {
      try {
        const tt = options.trackingToken; // undefined = use PAT
        const taskName = `Migration log: ${project.name} → ${options.destProjectName ?? projectGid} (${new Date().toLocaleDateString()})`;
        const reportTask = await this.request<{ gid: string }>('POST', '/tasks', {
          projects: [options.trackingProjectGid],
          name: taskName,
          notes: this.formatReportSummary(report, options.writerName),
        }, tt);
        report.trackingTaskGid = reportTask.gid;

        const filename = `migration-report-${new Date().toISOString().slice(0, 10)}.txt`;
        await this.uploadTextAttachment(reportTask.gid, filename, this.formatReportLog(report), tt);

        emit({ type: 'info', message: 'Report saved to tracking project' });
      } catch (err) {
        logger.error({ err }, 'failed to write tracking task — report not saved to Asana');
        warn('setup', 'Tracking project report', `Failed to save report to tracking project: ${(err as Error).message}`);
      }
    }

    // Step 7: add migrated project to tracking portfolio
    if (options.trackingPortfolioGid && projectGid) {
      try {
        await this.addProjectToPortfolio(options.trackingPortfolioGid, projectGid);
        log('Migrated project added to tracking portfolio.');
        emit({ type: 'info', message: 'Project added to tracking portfolio' });
      } catch (err) {
        warn('setup', 'Tracking portfolio', `Failed to add project to tracking portfolio: ${(err as Error).message}`);
      }
    }

    emit({ type: 'info', message: 'Migration complete' });
    return report;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Recursively collect all attachments from a task and its subtask descendants. */
  private collectAttachments(task: NormalisedTask): NormalisedAttachment[] {
    const result: NormalisedAttachment[] = [...task.attachments];
    for (const child of task.subtasks) {
      result.push(...this.collectAttachments(child));
    }
    return result;
  }

  /** Build the Asana story text for a failed attachment transfer.
   *  For oversized files the pre-signed source URL is omitted — it will have
   *  expired by the time anyone reads the comment. */
  private attachmentFailureComment(attachment: NormalisedAttachment, reason: string): string {
    if (reason.startsWith('Attachment too large')) {
      return `Attachment not transferred: ${attachment.name}\nReason: ${reason}\nRetrieve this file directly from the original source.`;
    }
    return `Attachment transfer failed: ${attachment.name}\nReason: ${reason}\nSource URL: ${attachment.url}`;
  }

  private async migrateTask(
    task: NormalisedTask,
    projectGid: string,
    sourceBoardId: string,
    sectionGidMap: Map<string, string>,
    sourceIdFieldGid: string | undefined,
    nativeDueOnSourceId: string | undefined,
    nativeNotesSourceId: string | undefined,
    nativeAssigneeSourceId: string | undefined,
    assigneeOmitted: boolean,
    nativeFollowersSourceId: string | undefined,
    userGidMap: Map<string, string>,
    fieldGidMap: Map<string, string>,
    enumOptionMap: Map<string, Map<string, string>>,
    fieldTypeMap: Map<string, AsanaFieldType>,
    subitemFieldIdRemap: Record<string, string>,
    taskGidMap: Map<string, string>,
    report: MigrationReport,
    warn: (taskId: string, taskName: string, message: string) => void,
    refreshAttachmentUrl?: (assetId: string) => Promise<string | null>,
    authenticateAttachmentUrl?: (url: string) => string,
    fieldDisplayMap?: Map<string, string>,
  ): Promise<MigrationReportItem> {
    try {
      const customFields: Record<string, unknown> = {};
      for (const [sourceFieldId, value] of Object.entries(task.customFields)) {
        const destGid = fieldGidMap.get(sourceFieldId);
        if (!destGid || value === null || value === '') continue;

        const optMap = enumOptionMap.get(sourceFieldId);
        const fieldType = fieldTypeMap.get(sourceFieldId);
        if (optMap) {
          // Enum/multi_enum: value must be an enum_option GID, not a label string
          if (Array.isArray(value)) {
            const gids = value.map((v) => optMap.get(v)).filter((g): g is string => g != null);
            if (gids.length) customFields[destGid] = gids;
          } else {
            const gid = optMap.get(value);
            if (gid) customFields[destGid] = gid;
            // else: source option has no mapping — skip silently
          }
        } else if (fieldType === 'enum' || fieldType === 'multi_enum') {
          // Enum field but no option map available — sending a raw string would cause
          // Asana to reject with "Not a recognized ID". Skip silently.
          continue;
        } else if (fieldTypeMap.get(sourceFieldId) === 'date') {
          // Date custom fields require { date: "YYYY-MM-DD" }, not a plain string
          const dateStr = Array.isArray(value) ? value[0] : value;
          if (dateStr) customFields[destGid] = { date: String(dateStr).substring(0, 10) };
        } else if (fieldTypeMap.get(sourceFieldId) === 'people') {
          // People custom fields require Asana GIDs — map source user IDs through userGidMap
          const ids = Array.isArray(value) ? value : [value];
          const gids = ids.map((id) => userGidMap.get(String(id))).filter((g): g is string => g != null);
          if (gids.length) customFields[destGid] = gids;
        } else if (fieldTypeMap.get(sourceFieldId) === 'number') {
          const num = parseFloat(String(value));
          if (!isNaN(num)) customFields[destGid] = num;
        } else {
          // text / unknown — Asana strictly requires a string for text_value
          if (value !== null) customFields[destGid] = Array.isArray(value) ? value.join(', ') : String(value);
        }
      }

      if (sourceIdFieldGid) customFields[sourceIdFieldGid] = task.id;

      // Apply native field mappings — values come from source customFields but are
      // written to native Asana task fields (due_on / notes) instead of custom fields.
      let nativeDueOn: string | undefined = task.dueDate;
      let nativeNotes: string | undefined = task.description;
      if (nativeDueOnSourceId) {
        const v = task.customFields[nativeDueOnSourceId];
        if (typeof v === 'string' && v) nativeDueOn = v;
      }
      if (nativeNotesSourceId) {
        const v = task.customFields[nativeNotesSourceId];
        if (typeof v === 'string' && v) nativeNotes = v;
      }

      const payload: Record<string, unknown> = {
        projects: [projectGid],
        name: task.name,
        notes: nativeNotes ?? '',
        completed: task.completed,
        custom_fields: customFields,
      };

      // Section membership — places the task in the correct board group/section.
      // projects is always required; memberships is added on top to assign the section.
      const sectionGid = task.sectionId ? sectionGidMap.get(task.sectionId) : undefined;
      if (sectionGid) {
        payload.memberships = [{ project: projectGid, section: sectionGid }];
      }

      // Assignee — prefer the explicitly-mapped people column, fall back to task.assigneeId
      if (nativeAssigneeSourceId) {
        const ids = task.customFields[nativeAssigneeSourceId];
        const firstId = Array.isArray(ids) ? ids[0] : (ids ?? undefined);
        const gid = firstId != null ? userGidMap.get(String(firstId)) : undefined;
        if (gid) payload.assignee = gid;
      } else if (!assigneeOmitted && task.assigneeId) {
        const asanaGid = userGidMap.get(String(task.assigneeId));
        if (asanaGid) payload.assignee = asanaGid;
      }

      // Followers — all mapped people column members, resolved to Asana GIDs
      if (nativeFollowersSourceId) {
        const ids = task.customFields[nativeFollowersSourceId];
        const idList = Array.isArray(ids) ? ids : (ids ? [ids] : []);
        const gids = idList.map((id) => userGidMap.get(id)).filter((g): g is string => g != null);
        if (gids.length) payload.followers = gids;
      }

      if (nativeDueOn) payload.due_on = nativeDueOn.substring(0, 10);

      // Create task — if Asana rejects the request (e.g. a custom field value fails
      // validation), strip custom_fields and retry so the task itself is not lost.
      let created: { gid: string };
      try {
        created = await this.request<{ gid: string }>('POST', '/tasks', payload);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (Object.keys(customFields).length > 0) {
          logger.warn({ err, taskId: task.id }, 'task creation failed — retrying without custom fields');
          const { custom_fields: _dropped, ...payloadWithoutFields } = payload as Record<string, unknown>;
          created = await this.request<{ gid: string }>('POST', '/tasks', payloadWithoutFields as Record<string, unknown>);
          // Post dropped field values as a comment so data is not silently lost
          const droppedLines: string[] = [];
          for (const [sourceFieldId, value] of Object.entries(task.customFields)) {
            if (value === null || value === '') continue;
            const displayName = sourceFieldId === '__smartsheet_row__'
              ? 'Smartsheet Row'
              : (fieldDisplayMap?.get(sourceFieldId) ?? sourceFieldId);
            const displayValue = Array.isArray(value) ? value.join(', ') : value;
            droppedLines.push(`• ${displayName}: ${displayValue}`);
          }
          if (droppedLines.length) {
            try {
              await this.request('POST', `/tasks/${encodeURIComponent(created.gid)}/stories`, {
                text: `[m_FieldData] Custom fields could not be applied — field validation error:\n${droppedLines.join('\n')}\nError: ${msg}`,
              });
            } catch { /* ignore story failure */ }
          }
          warn(task.id, task.name, `Custom fields dropped due to creation error: ${msg}`);
        } else {
          throw err;
        }
      }
      taskGidMap.set(task.id, created.gid);
      report.migratedTasks++;

      // Subtasks
      for (const subtask of task.subtasks) {
        await this.migrateSubtask(subtask, created.gid, sourceBoardId, sourceIdFieldGid, nativeDueOnSourceId, nativeNotesSourceId, nativeAssigneeSourceId, assigneeOmitted, userGidMap, fieldGidMap, enumOptionMap, fieldTypeMap, subitemFieldIdRemap, taskGidMap, report, warn, refreshAttachmentUrl, undefined, fieldDisplayMap);
      }

      // Comments
      for (const comment of task.comments) {
        const body = this.htmlToText(comment.text) || '(image — see task attachments)';
        try {
          await this.request('POST', `/tasks/${encodeURIComponent(created.gid)}/stories`, {
            text: `[${comment.authorName} – ${new Date(comment.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}]: ${body}`,
          });
          report.migratedComments++;
        } catch (err) {
          warn(task.id, task.name, `Failed to migrate comment (id: ${comment.id}): ${(err as Error).message}`);
        }
      }

      // Attachments — download from source and re-upload to Asana.
      // Falls back to posting the URL as a comment if the download or upload fails.
      for (const attachment of task.attachments) {
        try {
          await this.downloadAndAttach(created.gid, attachment, refreshAttachmentUrl, authenticateAttachmentUrl);
          report.migratedAttachments++;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logger.warn({ err, attachmentId: attachment.id, reason }, 'attachment transfer failed, falling back to URL comment');
          report.failedAttachments.push({ taskId: task.id, taskName: task.name, attachmentId: attachment.id, attachmentName: attachment.name, url: attachment.url, boardId: sourceBoardId, reason });
          warn(task.id, task.name, `Attachment '${attachment.name}' could not be transferred: ${reason}`);
          try {
            await this.request('POST', `/tasks/${encodeURIComponent(created.gid)}/stories`, {
              text: this.attachmentFailureComment(attachment, reason),
            });
          } catch { /* ignore story failure */ }
        }
      }

      return { taskId: task.id, taskName: task.name, status: 'success' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, taskId: task.id }, 'failed to migrate task');
      report.errors++;
      for (const attachment of this.collectAttachments(task)) {
        report.failedAttachments.push({ taskId: task.id, taskName: task.name, attachmentId: attachment.id, attachmentName: attachment.name, url: attachment.url, boardId: sourceBoardId, reason: `Task failed to migrate: ${msg}` });
      }
      return { taskId: task.id, taskName: task.name, status: 'error', message: msg };
    }
  }

  private async migrateSubtask(
    subtask: NormalisedTask,
    parentGid: string,
    sourceBoardId: string,
    sourceIdFieldGid: string | undefined,
    nativeDueOnSourceId: string | undefined,
    nativeNotesSourceId: string | undefined,
    nativeAssigneeSourceId: string | undefined,
    assigneeOmitted: boolean,
    userGidMap: Map<string, string>,
    fieldGidMap: Map<string, string>,
    enumOptionMap: Map<string, Map<string, string>>,
    fieldTypeMap: Map<string, AsanaFieldType>,
    subitemFieldIdRemap: Record<string, string>,
    taskGidMap: Map<string, string>,
    report: MigrationReport,
    warn: (taskId: string, taskName: string, message: string) => void,
    refreshAttachmentUrl?: (assetId: string) => Promise<string | null>,
    authenticateAttachmentUrl?: (url: string) => string,
    fieldDisplayMap?: Map<string, string>,
  ): Promise<void> {
    try {
      const customFields: Record<string, unknown> = {};

      for (const [sourceFieldId, value] of Object.entries(subtask.customFields)) {
        // Remap subitem-board column ID → parent-board column ID if they differ
        const resolvedFieldId = subitemFieldIdRemap[sourceFieldId] ?? sourceFieldId;
        const destGid = fieldGidMap.get(resolvedFieldId);
        if (!destGid) {
          // Field exists on the subitem board but has no entry in the field mapping — track it
          if (value !== null && value !== '') {
            const existing = report.skippedSubitemFields.find((s) => s.fieldId === sourceFieldId);
            if (existing) {
              existing.count++;
            } else {
              report.skippedSubitemFields.push({ fieldId: sourceFieldId, fieldName: sourceFieldId, count: 1 });
            }
          }
          continue;
        }
        if (value === null || value === '') continue;

        const optMap = enumOptionMap.get(resolvedFieldId);
        const fieldType = fieldTypeMap.get(resolvedFieldId);
        if (optMap) {
          if (Array.isArray(value)) {
            const gids = value.map((v) => optMap.get(v)).filter((g): g is string => g != null);
            if (gids.length) customFields[destGid] = gids;
          } else {
            const gid = optMap.get(value);
            if (gid) customFields[destGid] = gid;
          }
        } else if (fieldType === 'enum' || fieldType === 'multi_enum') {
          // Enum field but no option map available — sending a raw string would cause
          // Asana to reject with "Not a recognized ID". Skip silently.
          continue;
        } else if (fieldTypeMap.get(resolvedFieldId) === 'date') {
          const dateStr = Array.isArray(value) ? value[0] : value;
          if (dateStr) customFields[destGid] = { date: String(dateStr).substring(0, 10) };
        } else if (fieldTypeMap.get(resolvedFieldId) === 'people') {
          const ids = Array.isArray(value) ? value : [value];
          const gids = ids.map((id) => userGidMap.get(String(id))).filter((g): g is string => g != null);
          if (gids.length) customFields[destGid] = gids;
        } else if (fieldTypeMap.get(resolvedFieldId) === 'number') {
          const num = parseFloat(String(value));
          if (!isNaN(num)) customFields[destGid] = num;
        } else {
          // text / unknown — Asana strictly requires a string for text_value
          if (value !== null) customFields[destGid] = Array.isArray(value) ? value.join(', ') : String(value);
        }
      }

      if (sourceIdFieldGid) customFields[sourceIdFieldGid] = subtask.id;

      // Apply native field mappings — same logic as migrateTask.
      // Prefer the mapped source column; fall back to the normalised task field.
      let nativeDueOn: string | undefined = subtask.dueDate;
      let nativeNotes: string | undefined = subtask.description;
      if (nativeDueOnSourceId) {
        const v = subtask.customFields[nativeDueOnSourceId];
        if (typeof v === 'string' && v) nativeDueOn = v;
      }
      if (nativeNotesSourceId) {
        const v = subtask.customFields[nativeNotesSourceId];
        if (typeof v === 'string' && v) nativeNotes = v;
      }

      const payload: Record<string, unknown> = {
        parent: parentGid,
        name: subtask.name,
        notes: nativeNotes ?? '',
        completed: subtask.completed,
        custom_fields: customFields,
      };

      // Assignee — prefer the explicitly-mapped people column, fall back to task.assigneeId
      if (nativeAssigneeSourceId) {
        const ids = subtask.customFields[nativeAssigneeSourceId];
        const firstId = Array.isArray(ids) ? ids[0] : (ids ?? undefined);
        const gid = firstId != null ? userGidMap.get(String(firstId)) : undefined;
        if (gid) payload.assignee = gid;
      } else if (!assigneeOmitted && subtask.assigneeId) {
        const asanaGid = userGidMap.get(subtask.assigneeId);
        if (asanaGid) payload.assignee = asanaGid;
      }

      if (nativeDueOn) payload.due_on = nativeDueOn.substring(0, 10);

      // Create subtask — if Asana rejects the request (e.g. a custom field value fails
      // validation, or the subtask is too deeply nested for custom fields), strip
      // custom_fields and retry so the subtask itself is not lost.
      let created: { gid: string };
      try {
        created = await this.request<{ gid: string }>('POST', '/tasks', payload);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (Object.keys(customFields).length > 0) {
          logger.warn({ err, subtaskId: subtask.id }, 'subtask creation failed — retrying without custom fields');
          const { custom_fields: _dropped, ...payloadWithoutFields } = payload as Record<string, unknown>;
          created = await this.request<{ gid: string }>('POST', '/tasks', payloadWithoutFields);
          // Write dropped field values as a comment so data is not silently lost
          const droppedLines: string[] = [];
          for (const [sourceFieldId, value] of Object.entries(subtask.customFields)) {
            if (value === null || value === '') continue;
            const displayName = sourceFieldId === '__smartsheet_row__'
              ? 'Smartsheet Row'
              : (fieldDisplayMap?.get(sourceFieldId) ?? sourceFieldId);
            const displayValue = Array.isArray(value) ? value.join(', ') : value;
            droppedLines.push(`• ${displayName}: ${displayValue}`);
          }
          if (droppedLines.length) {
            try {
              await this.request('POST', `/tasks/${encodeURIComponent(created.gid)}/stories`, {
                text: `[m_FieldData] Custom fields could not be applied — field validation error:\n${droppedLines.join('\n')}\nError: ${msg}`,
              });
            } catch { /* ignore */ }
          }
          warn(subtask.id, subtask.name, `Custom fields dropped due to creation error: ${msg}`);
        } else {
          throw err;
        }
      }
      taskGidMap.set(subtask.id, created.gid);
      report.migratedSubtasks++;

      for (const comment of subtask.comments) {
        const body = this.htmlToText(comment.text) || '(image — see task attachments)';
        try {
          await this.request('POST', `/tasks/${encodeURIComponent(created.gid)}/stories`, {
            text: `[${comment.authorName} – ${new Date(comment.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}]: ${body}`,
          });
          report.migratedComments++;
        } catch (err) {
          warn(subtask.id, subtask.name, `Failed to migrate comment (id: ${comment.id}): ${(err as Error).message}`);
        }
      }

      for (const attachment of subtask.attachments) {
        try {
          await this.downloadAndAttach(created.gid, attachment, refreshAttachmentUrl, authenticateAttachmentUrl);
          report.migratedAttachments++;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logger.warn({ err, attachmentId: attachment.id, reason }, 'subtask attachment transfer failed, falling back to URL comment');
          report.failedAttachments.push({ taskId: subtask.id, taskName: subtask.name, attachmentId: attachment.id, attachmentName: attachment.name, url: attachment.url, boardId: sourceBoardId, reason });
          warn(subtask.id, subtask.name, `Attachment '${attachment.name}' could not be transferred: ${reason}`);
          try {
            await this.request('POST', `/tasks/${encodeURIComponent(created.gid)}/stories`, {
              text: this.attachmentFailureComment(attachment, reason),
            });
          } catch { /* ignore story failure */ }
        }
      }

      // Recurse into children — Asana supports nested subtasks at arbitrary depth.
      for (const child of subtask.subtasks) {
        await this.migrateSubtask(child, created.gid, sourceBoardId, sourceIdFieldGid, nativeDueOnSourceId, nativeNotesSourceId, nativeAssigneeSourceId, assigneeOmitted, userGidMap, fieldGidMap, enumOptionMap, fieldTypeMap, subitemFieldIdRemap, taskGidMap, report, warn, refreshAttachmentUrl, authenticateAttachmentUrl, fieldDisplayMap);
      }
    } catch (err) {
      const msg = (err as Error).message;
      warn(subtask.id, subtask.name, `Failed to migrate subtask: ${msg}`);
      for (const attachment of this.collectAttachments(subtask)) {
        report.failedAttachments.push({ taskId: subtask.id, taskName: subtask.name, attachmentId: attachment.id, attachmentName: attachment.name, url: attachment.url, boardId: sourceBoardId, reason: `Subtask failed to migrate: ${msg}` });
      }
    }
  }

  private async ensureCustomFields(
    projectGid: string,
    fieldMapping: FieldMappingEntry[],
    log: (msg: string, type?: ProgressEvent['type']) => void,
  ): Promise<{
    fieldGidMap: Map<string, string>;
    /** sourceFieldId → (sourceOptionName → destEnumOptionGid) */
    enumOptionMap: Map<string, Map<string, string>>;
    /** sourceFieldId → resolved Asana field type (for value formatting) */
    fieldTypeMap: Map<string, AsanaFieldType>;
    fieldFailures: MigrationReportItem[];
  }> {
    const fieldGidMap = new Map<string, string>();
    const enumOptionMap = new Map<string, Map<string, string>>();
    const fieldTypeMap = new Map<string, AsanaFieldType>();
    const fieldFailures: MigrationReportItem[] = [];

    for (const entry of fieldMapping) {
      if (entry.omit) continue;
      if (entry.destNativeField) continue; // value goes to native Asana field, not a custom field

      // Subitem field linked to a parent field — reuse the parent's destination GID.
      // The parent entry must have been processed earlier in the loop.
      if (entry.linkedToParentSourceFieldId) {
        const parentGid = fieldGidMap.get(entry.linkedToParentSourceFieldId);
        const parentType = fieldTypeMap.get(entry.linkedToParentSourceFieldId);
        const parentOptMap = enumOptionMap.get(entry.linkedToParentSourceFieldId);
        if (parentGid) {
          fieldGidMap.set(entry.sourceFieldId, parentGid);
          if (parentType) fieldTypeMap.set(entry.sourceFieldId, parentType);
          if (parentOptMap) enumOptionMap.set(entry.sourceFieldId, parentOptMap);
        }
        continue;
      }

      if (!entry.destFieldId) {
        // Create a project-level field via inline addCustomFieldSetting.
        // This scopes the field to the project only — it won't appear in the workspace
        // field library and won't conflict across migrations.
        const asanaType = entry.destFieldType ?? this.mapToAsanaFieldType(entry.sourceFieldType);
        const prefix = entry.isSubitemField ? 'ms_' : 'm_';
        const fieldName = `${prefix}${entry.sourceFieldName}`;
        // Enum fields with no options cannot be created in Asana — skip and warn.
        if ((asanaType === 'enum' || asanaType === 'multi_enum') && entry.sourceFieldType !== 'checkbox') {
          const validOptions = (entry.sourceOptions ?? []).filter((o) => String(o.name ?? '').trim());
          if (!validOptions.length) {
            log(`Skipping field '${fieldName}' — no valid options to create an enum field.`, 'warning');
            fieldFailures.push({ taskId: '', taskName: fieldName, status: 'warning', message: 'No valid enum options — all options were blank or missing.' });
            continue;
          }
        }
        log(`Creating project-level field '${fieldName}' (type: ${asanaType}).`);
        // Failure here is fatal — if a field can't be created, all task data for that
        // field would be silently lost across every migrated task. Stop the migration
        // so the user can investigate rather than silently produce incomplete data.
        const fieldDef = this.buildFieldDef(asanaType, fieldName, entry);
        const setting = await this.request<{
          custom_field: { gid: string; enum_options?: Array<{ gid: string; name: string }> };
        }>(
          'POST',
          `/projects/${encodeURIComponent(projectGid)}/addCustomFieldSetting?opt_fields=custom_field.gid,custom_field.enum_options,custom_field.enum_options.gid,custom_field.enum_options.name`,
          { custom_field: fieldDef },
        );
        fieldGidMap.set(entry.sourceFieldId, setting.custom_field.gid);
        fieldTypeMap.set(entry.sourceFieldId, asanaType);

        // Build source-option-name → Asana-enum-option-GID map
        if (setting.custom_field.enum_options?.length) {
          const optMap = new Map<string, string>();
          for (const opt of setting.custom_field.enum_options) {
            optMap.set(opt.name, opt.gid);
          }
          // Checkbox source values: "v" / "1" / "true" → "True", everything else → "False"
          if (entry.sourceFieldType === 'checkbox') {
            const trueGid  = optMap.get('True');
            const falseGid = optMap.get('False');
            if (trueGid)  { optMap.set('v', trueGid);  optMap.set('1', trueGid);  optMap.set('true', trueGid); }
            if (falseGid) { optMap.set('0', falseGid); optMap.set('false', falseGid); }
          }
          enumOptionMap.set(entry.sourceFieldId, optMap);
        }

        log(`Field '${fieldName}' created.`);
      } else {
        // Field is mapped to an existing Asana field. Attach it to the project in case
        // it isn't already — no-op if already present.
        log(`Field '${entry.sourceFieldName}' mapped to existing Asana field '${entry.destFieldName}'.`);
        try {
          await this.request('POST', `/projects/${encodeURIComponent(projectGid)}/addCustomFieldSetting`,
            { custom_field: entry.destFieldId });
        } catch (err) {
          const msg = (err as Error).message ?? '';
          if (!msg.toLowerCase().includes('already exists')) {
            log(`Could not attach field '${entry.destFieldName}': ${msg}`, 'warning');
          }
        }
        const existingType = entry.destFieldType ?? this.mapToAsanaFieldType(entry.sourceFieldType);
        fieldTypeMap.set(entry.sourceFieldId, existingType);
        fieldGidMap.set(entry.sourceFieldId, entry.destFieldId!);

        // Build enum option map from the pre-built enumMapping (field mapping step)
        if (entry.enumMapping?.length) {
          const optMap = new Map<string, string>();
          for (const em of entry.enumMapping) {
            if (em.destOptionGid) optMap.set(em.sourceOption, em.destOptionGid);
          }
          if (optMap.size > 0) enumOptionMap.set(entry.sourceFieldId, optMap);
        }
      }
    }

    return { fieldGidMap, enumOptionMap, fieldTypeMap, fieldFailures };
  }

  /**
   * Asana's supported enum option color tokens, in a visually pleasing cycle order.
   * 'none' and 'cool-gray' are omitted so every option gets a distinct colour.
   */
  private static readonly ENUM_COLORS = [
    'aqua', 'blue', 'green', 'yellow-green', 'yellow', 'yellow-orange',
    'orange', 'red', 'pink', 'hot-pink', 'magenta', 'purple', 'indigo', 'blue-green',
  ] as const;

  /** Build the inline custom_field definition for addCustomFieldSetting. */
  private buildFieldDef(
    asanaType: AsanaFieldType,
    fieldName: string,
    entry: FieldMappingEntry,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = { resource_subtype: asanaType, name: fieldName };

    switch (asanaType) {
      case 'number':
        base.precision = 0;
        break;
      case 'enum':
      case 'multi_enum': {
        let options: Array<{ name: string; color: string }>;
        if (entry.sourceFieldType === 'checkbox') {
          options = [{ name: 'True', color: 'green' }, { name: 'False', color: 'red' }];
        } else if (entry.sourceOptions?.length) {
          // Always filter blank names; only deduplicate when the user has explicitly opted in.
          // If duplicates remain and deduplicateOptions is false, Asana will reject the field
          // and the failure will surface in the report — the user should fix the source data.
          const seen = new Set<string>();
          let colorIndex = 0;
          options = entry.sourceOptions
            .map((opt) => ({ name: String(opt.name ?? '').trim() }))
            .filter((opt) => {
              if (!opt.name) return false;
              if (entry.deduplicateOptions) {
                if (seen.has(opt.name.toLowerCase())) return false;
                seen.add(opt.name.toLowerCase());
              }
              return true;
            })
            .map((opt) => ({
              name: opt.name,
              color: AsanaDestination.ENUM_COLORS[colorIndex++ % AsanaDestination.ENUM_COLORS.length],
            }));
        } else {
          options = [];
        }
        if (options.length) base.enum_options = options;
        break;
      }
      default:
        break;
    }

    return base;
  }

  private mapToAsanaFieldType(type: string): AsanaFieldType {
    const map: Record<string, AsanaFieldType> = {
      text: 'text',
      number: 'number',
      date: 'date',
      dropdown: 'enum',
      checkbox: 'enum',
      people: 'people',
      link: 'text',
      unknown: 'text',
    };
    return map[type] ?? 'text';
  }

  /** Convert HTML from Monday/Trello update bodies to plain text suitable for Asana stories. */
  private htmlToText(html: string): string {
    let text = html;
    // Anchor tags → "link text (href)"
    text = text.replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
      const innerText = inner.replace(/<[^>]+>/g, '').trim();
      return innerText ? `${innerText} (${href})` : href;
    });
    // Block/line elements → newline
    text = text.replace(/<\/?(p|div|li|tr|blockquote|h[1-6])[^>]*>/gi, '\n');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    // Strip remaining tags
    text = text.replace(/<[^>]+>/g, '');
    // Decode HTML entities
    text = text
      .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&nbsp;/gi, ' ')
      .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
    // Normalise whitespace
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
  }

  // ---------------------------------------------------------------------------
  // Analysis report (analyze-only mode)
  // ---------------------------------------------------------------------------

  /**
   * Creates a tracking task in Asana containing the analysis report summary and
   * a full .txt log file as an attachment. Returns the tracking task GID, or null
   * if writing fails (non-fatal — the analysis result is still returned to the UI).
   */
  async writeAnalysisReport(
    report: AnalysisReport,
    options: {
      trackingProjectGid: string;
      trackingToken?: string;
      writerName?: string;
    },
  ): Promise<string | null> {
    const tt = options.trackingToken;
    const date = new Date().toLocaleDateString();
    const projectNames = report.projects.map((p) => p.projectName).join(', ');
    const taskName = `Analysis Report: ${projectNames} (${date})`;

    try {
      const task = await this.request<{ gid: string }>('POST', '/tasks', {
        projects: [options.trackingProjectGid],
        name: taskName,
        notes: this.formatAnalysisReportSummary(report, options.writerName),
      }, tt);

      const filename = `analysis-report-${new Date().toISOString().slice(0, 10)}.txt`;
      await this.uploadTextAttachment(task.gid, filename, this.formatAnalysisReportLog(report, options.writerName), tt);

      return task.gid;
    } catch (err) {
      logger.error({ err }, 'failed to write analysis tracking task');
      return null;
    }
  }

  /** Short summary for the Asana task notes field. */
  private formatAnalysisReportSummary(report: AnalysisReport, writerName?: string): string {
    const lines: string[] = [
      `Analysis Report — ${report.sourcePlatform}`,
      writerName ? `Performed by: ${writerName} (Cirface Migration Tool)` : 'Performed by: Cirface Migration Tool',
      `Started:   ${report.startedAt}`,
      `Completed: ${report.completedAt}`,
      '',
      `Projects analyzed: ${report.projects.length}`,
      '',
    ];

    for (const p of report.projects) {
      lines.push(`  ${p.projectName}`);
      lines.push(`    Tasks: ${p.tasks}  Subtasks: ${p.subtasks}  Comments: ${p.comments}  Attachments: ${p.attachments}  Dependencies: ${p.dependencies}`);
      lines.push(`    Users: ${p.users}  Fields: ${p.fields.length}`);
      lines.push('');
    }

    lines.push('Full field listing is in the attached report file.');
    return lines.join('\n');
  }

  /** Full analysis log with per-project field tables, written to the attached .txt file. */
  private formatAnalysisReportLog(report: AnalysisReport, writerName?: string): string {
    const sep = (label: string) => `\n${'='.repeat(60)}\n${label}\n${'='.repeat(60)}`;
    const lines: string[] = [];

    lines.push(`ANALYSIS REPORT — ${report.sourcePlatform.toUpperCase()}`);
    lines.push(writerName ? `Performed by: ${writerName} (Cirface Migration Tool)` : 'Performed by: Cirface Migration Tool');
    lines.push(`Started:   ${report.startedAt}`);
    lines.push(`Completed: ${report.completedAt}`);
    lines.push('');
    lines.push(`Projects analyzed: ${report.projects.length}`);

    for (const p of report.projects) {
      lines.push(sep(p.projectName));
      lines.push('');
      lines.push(`Tasks:        ${p.tasks}`);
      lines.push(`Subtasks:     ${p.subtasks}`);
      lines.push(`Comments:     ${p.comments}`);
      lines.push(`Attachments:  ${p.attachments}`);
      lines.push(`Dependencies: ${p.dependencies}`);
      lines.push(`Users:        ${p.users}`);
      lines.push(`Fields:       ${p.fields.length}`);
      lines.push('');

      if (p.fields.length > 0) {
        const cw = { name: 30, type: 16, source: 10, options: 8, notes: 16 };
        const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);

        lines.push('CUSTOM FIELDS');
        lines.push('-'.repeat(cw.name + cw.type + cw.source + cw.options + cw.notes));
        lines.push(
          pad('Field Name', cw.name) +
          pad('Type', cw.type) +
          pad('Source', cw.source) +
          pad('Options', cw.options) +
          'Notes',
        );
        lines.push('-'.repeat(cw.name + cw.type + cw.source + cw.options + cw.notes));

        for (const f of p.fields) {
          lines.push(
            pad(f.name, cw.name) +
            pad(f.type, cw.type) +
            pad(f.isSubitemField ? 'Subitem' : 'Parent', cw.source) +
            pad(f.options?.length ? String(f.options.length) : '—', cw.options) +
            (f.nonMigratable ? 'non-migratable' : ''),
          );
        }
        lines.push('');

        // Dropdown options detail
        const dropdowns = p.fields.filter((f) => f.options?.length);
        if (dropdowns.length > 0) {
          lines.push('DROPDOWN OPTIONS');
          lines.push('-'.repeat(40));
          for (const f of dropdowns) {
            lines.push(`  ${f.name}:`);
            for (const opt of f.options!) {
              lines.push(`    - ${opt.name}`);
            }
          }
          lines.push('');
        }
      }
    }

    return lines.join('\n');
  }

  /** ISO timestamp formatted as "YYYY-MM-DD HH:MM:SS". */
  private ts(): string {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
  }

  /** Short summary written to the task notes field (visible without opening the attachment). */
  private formatReportSummary(report: MigrationReport, writerName?: string): string {
    const lines = [
      `Migration Report — ${report.sourceProject}`,
      writerName ? `Performed by: ${writerName} (Cirface Migration Tool)` : 'Performed by: Cirface Migration Tool',
      `Started:   ${report.startedAt}`,
      `Completed: ${report.completedAt}`,
      report.cancelled ? `STATUS: CANCELLED — migration was stopped before completion.` : '',
      ``,
      `Asana Project: https://app.asana.com/0/${report.destProject}/list`,
      `Asana Project ID: ${report.destProject}`,
      ``,
      `Tasks migrated:       ${report.migratedTasks} / ${report.totalTasks}`,
      `Subtasks migrated:    ${report.migratedSubtasks}`,
      `Comments migrated:    ${report.migratedComments}`,
      `Attachments transferred:   ${report.migratedAttachments}`,
      `Dependencies wired:   ${report.migratedDependencies}`,
      `Warnings:             ${report.warnings}`,
      `Errors:               ${report.errors}`,
      `Failed attachments:   ${report.failedAttachments?.length ?? 0}`,
      ...(report.sourceCount ? [
        ``,
        `Source vs Migrated:`,
        `  Tasks:        ${report.sourceCount.tasks} source → ${report.migratedTasks} migrated`,
        `  Subtasks:     ${report.sourceCount.subtasks} source → ${report.migratedSubtasks} migrated`,
        `  Comments:     ${report.sourceCount.comments} source → ${report.migratedComments} migrated`,
        `  Attachments:  ${report.sourceCount.attachments} source → ${report.migratedAttachments} migrated`,
        `  Dependencies: ${report.sourceCount.dependencies} source → ${report.migratedDependencies} migrated`,
      ] : []),
      ``,
      `Full activity log with details is in the attached report file.`,
    ].filter((l) => l !== '');
    return lines.join('\n');
  }

  /** Full timestamped activity log, written to the attached .txt file. */
  private formatReportLog(report: MigrationReport): string {
    const sep = (label: string) => `\n${'='.repeat(60)}\n${label}\n${'='.repeat(60)}`;
    const lines: string[] = [];

    lines.push(`MIGRATION REPORT — ${report.sourceProject}`);
    lines.push(`Started:   ${report.startedAt}`);
    lines.push(`Completed: ${report.completedAt}`);
    if (report.cancelled) lines.push(`STATUS: CANCELLED — migration was stopped before completion.`);
    lines.push('');
    lines.push(`Asana Project: https://app.asana.com/0/${report.destProject}/list`);
    lines.push(`Asana Project ID: ${report.destProject}`);
    lines.push('');
    lines.push(`Tasks migrated:     ${report.migratedTasks} / ${report.totalTasks}`);
    lines.push(`Subtasks migrated:  ${report.migratedSubtasks}`);
    lines.push(`Comments migrated:  ${report.migratedComments}`);
    lines.push(`Attachments transferred: ${report.migratedAttachments}`);
    lines.push(`Dependencies wired: ${report.migratedDependencies}`);
    lines.push(`Warnings:           ${report.warnings}`);
    lines.push(`Errors:             ${report.errors}`);
    lines.push(`Failed attachments: ${report.failedAttachments?.length ?? 0}`);

    if (report.sourceCount) {
      lines.push('');
      lines.push('Source vs Migrated:');
      lines.push(`  Tasks:        ${report.sourceCount.tasks} source → ${report.migratedTasks} migrated`);
      lines.push(`  Subtasks:     ${report.sourceCount.subtasks} source → ${report.migratedSubtasks} migrated`);
      lines.push(`  Comments:     ${report.sourceCount.comments} source → ${report.migratedComments} migrated`);
      lines.push(`  Attachments:  ${report.sourceCount.attachments} source → ${report.migratedAttachments} migrated`);
      lines.push(`  Dependencies: ${report.sourceCount.dependencies} source → ${report.migratedDependencies} migrated`);
    }

    // Errors
    const errors = report.items.filter((i) => i.status === 'error');
    if (errors.length) {
      lines.push(sep(`ERRORS (${errors.length})`));
      for (const item of errors) {
        lines.push(`  Task: ${item.taskName}`);
        if (item.message) lines.push(`  Detail: ${item.message}`);
        lines.push('');
      }
    }

    // Warnings
    const warnings = report.items.filter((i) => i.status === 'warning');
    if (warnings.length) {
      lines.push(sep(`WARNINGS (${warnings.length})`));
      for (const item of warnings) {
        lines.push(`  Task: ${item.taskName}`);
        if (item.message) lines.push(`  Detail: ${item.message}`);
        lines.push('');
      }
    }

    // Failed attachments
    if (report.failedAttachments?.length) {
      lines.push(sep(`FAILED ATTACHMENTS (${report.failedAttachments.length})`));
      lines.push(`These attachments could not be transferred after multiple retries.`);
      lines.push(`Download each file manually and re-attach it to the task in Asana.`);
      lines.push('');
      for (const fa of report.failedAttachments) {
        lines.push(`  Task:       ${fa.taskName} (ID: ${fa.taskId})`);
        lines.push(`  Attachment: ${fa.attachmentName} (ID: ${fa.attachmentId})`);
        lines.push(`  Reason:     ${fa.reason}`);
        lines.push(`  URL:        ${fa.url}`);
        lines.push('');
      }
    }

    // Chronological activity log
    lines.push(sep('ACTIVITY LOG'));
    for (const entry of report.log) {
      lines.push(`[${entry.time}] ${entry.message}`);
    }

    return lines.join('\n');
  }

  /** Download a file from the source URL and upload it as a native Asana attachment.
   *  Retries up to 3 times with exponential backoff on transient network errors (ECONNRESET, etc.).
   *  On a 403, attempts a one-time URL refresh via refreshAttachmentUrl before giving up. */
  private async downloadAndAttach(
    taskGid: string,
    attachment: NormalisedAttachment,
    refreshAttachmentUrl?: (assetId: string) => Promise<string | null>,
    authenticateAttachmentUrl?: (url: string) => string,
  ): Promise<void> {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;
    let currentUrl = authenticateAttachmentUrl
      ? authenticateAttachmentUrl(attachment.url)
      : attachment.url;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const dlRes = await fetch(currentUrl, { signal: AbortSignal.timeout(30_000) });
        if (dlRes.status === 403 && refreshAttachmentUrl && attempt === 1) {
          // Pre-signed URL likely expired — fetch a fresh one and retry immediately
          const freshUrl = await refreshAttachmentUrl(attachment.id);
          if (freshUrl) {
            currentUrl = freshUrl;
            logger.info({ attachmentId: attachment.id }, 'refreshed expired attachment URL, retrying');
            continue;
          }
        }
        if (!dlRes.ok) throw new Error(`Download failed (${dlRes.status}): ${currentUrl}`);

        // Asana's max attachment size is 100 MB. We also need to guard against large files
        // that would buffer entirely into memory via arrayBuffer() below and OOM-kill the
        // server process before the upload even starts — which crashes the container and
        // loses the in-memory session, making the whole migration unrecoverable.
        const MAX_BYTES = 100 * 1024 * 1024; // 100 MB
        const contentLength = Number(dlRes.headers.get('content-length') ?? '0');
        if (contentLength > MAX_BYTES) {
          throw new Error(`Attachment too large to transfer (${(contentLength / 1024 / 1024).toFixed(1)} MB > 100 MB limit): ${attachment.name}`);
        }

        const mimeType = attachment.mimeType ?? dlRes.headers.get('content-type') ?? 'application/octet-stream';
        const blob = new Blob([await dlRes.arrayBuffer()], { type: mimeType });

        const formData = new FormData();
        formData.append('parent', taskGid);
        formData.append('file', blob, attachment.name);

        const upRes = await fetch(`${ASANA_BASE}/attachments`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}` },
          body: formData,
          signal: AbortSignal.timeout(30_000),
        });

        if (!upRes.ok) {
          const json = await upRes.json().catch(() => ({})) as { errors?: Array<{ message: string }> };
          throw new Error(json.errors?.[0]?.message ?? `Upload failed (${upRes.status})`);
        }
        return; // success
      } catch (err) {
        lastErr = err;
        const isTransient = err instanceof Error && (
          err.message.includes('ECONNRESET') ||
          err.message.includes('ETIMEDOUT') ||
          err.message.includes('fetch failed') ||
          err.message.includes('network')
        );
        if (!isTransient || attempt === MAX_ATTEMPTS) throw err;
        // Exponential backoff: 2s, 4s before retries 2 and 3
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        logger.info({ attachmentId: attachment.id, attempt }, 'retrying attachment download after transient error');
      }
    }
    throw lastErr;
  }

  /** Upload a plain-text string as a file attachment on a task. */
  async uploadTextAttachment(taskGid: string, filename: string, content: string, tokenOverride?: string): Promise<void> {
    const formData = new FormData();
    formData.append('parent', taskGid);
    formData.append('file', new Blob([content], { type: 'text/plain' }), filename);

    const res = await fetch(`${ASANA_BASE}/attachments`, {
      method: 'POST',
      headers: {
        // Do NOT set Content-Type — fetch sets it automatically with the multipart boundary
        Authorization: `Bearer ${tokenOverride ?? this.token}`,
      },
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const json = await res.json().catch(() => ({})) as { errors?: Array<{ message: string }> };
      throw new Error(json.errors?.[0]?.message ?? `Attachment upload failed (${res.status})`);
    }
  }
}
