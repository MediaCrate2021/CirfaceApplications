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
  AsanaFieldType,
  FieldMappingEntry,
  MigrationReport,
  MigrationReportItem,
  NormalisedAttachment,
  NormalisedProject,
  NormalisedTask,
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
  trackingProjectGid?: string;
  trackingPortfolioGid?: string;
  /** If set, ownership of the migrated project is transferred to this Asana user GID after migration. */
  projectOwnerGid?: string;
  sourcePlatform?: string;
  /** Name of the PAT account performing the migration — shown in the report. */
  writerName?: string;
  /** SSE writer — called with each progress event */
  onProgress?: (event: ProgressEvent) => void;
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
  ): Promise<T> {
    const res = await fetch(`${ASANA_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
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
    enum_options?: Array<{ gid: string; name: string }>;
  }>> {
    const settings = await this.request<Array<{
      custom_field: {
        gid: string; name: string; type: string;
        enum_options?: Array<{ gid: string; name: string }>;
      };
    }>>(
      'GET',
      `/projects/${encodeURIComponent(projectGid)}/custom_field_settings?opt_fields=custom_field.gid,custom_field.name,custom_field.type,custom_field.enum_options,custom_field.enum_options.name&limit=100`,
    );
    return settings.map((s) => s.custom_field);
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
      sourceProject: project.name,
      destProject: '',
      totalTasks: project.tasks.length,
      migratedTasks: 0,
      migratedSubtasks: 0,
      migratedComments: 0,
      migratedAttachments: 0,
      migratedDependencies: 0,
      warnings: 0,
      errors: 0,
      items: [],
      log: [],
    };

    const emit = options.onProgress ?? (() => {});

    /** Append a timestamped line to the report log and emit an SSE event. */
    const log = (message: string, type: ProgressEvent['type'] = 'info') => {
      report.log.push({ time: this.ts(), message });
      emit({ type, message });
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
      log(`Asana project '${options.destProjectName}' created successfully.`);
    } else {
      log(`Migrating to existing Asana project (GID: ${projectGid}).`);
    }
    report.destProject = projectGid;

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
    const { fieldGidMap, enumOptionMap, fieldTypeMap } = await this.ensureCustomFields(
      projectGid,
      options.fieldMapping,
      log,
    );

    // Step 4: create a project-level "Source ID" field to store the source platform's item ID.
    // This lets users trace any Asana task back to its original Monday/Trello item.
    let sourceIdFieldGid: string | undefined;
    try {
      const setting = await this.request<{
        custom_field: { gid: string };
      }>(
        'POST',
        `/projects/${encodeURIComponent(projectGid)}/addCustomFieldSetting?opt_fields=custom_field.gid`,
        { custom_field: { resource_subtype: 'text', name: 'Source ID' } },
      );
      sourceIdFieldGid = setting.custom_field.gid;
      log(`'Source ID' field created.`);
    } catch (err) {
      log(`Could not create Source ID field: ${(err as Error).message}`, 'warning');
      report.warnings++;
    }

    // Step 5: create Asana sections to mirror source groups/lists
    const sectionGidMap = new Map<string, string>(); // sourceSectionId → asanaSectionGid
    if (project.sections.length > 0) {
      log(`Creating ${project.sections.length} section(s).`);
      for (const section of project.sections) {
        try {
          const created = await this.request<{ gid: string }>('POST', `/projects/${encodeURIComponent(projectGid)}/sections`, {
            name: section.name,
          });
          sectionGidMap.set(section.id, created.gid);
        } catch (err) {
          log(`Failed to create section '${section.name}': ${(err as Error).message}`, 'warning');
          report.warnings++;
        }
      }
    }

    // Derive source field IDs that map to native Asana task fields.
    // These are applied directly to the task payload instead of creating custom fields.
    const nativeDueOnSourceId   = options.fieldMapping.find((f) => f.destNativeField === 'due_on')?.sourceFieldId;
    const nativeNotesSourceId   = options.fieldMapping.find((f) => f.destNativeField === 'notes')?.sourceFieldId;
    const nativeAssigneeSourceId  = options.fieldMapping.find((f) => f.destNativeField === 'assignee')?.sourceFieldId;
    const nativeFollowersSourceId = options.fieldMapping.find((f) => f.destNativeField === 'followers')?.sourceFieldId;

    // Step 5: migrate tasks
    const taskGidMap = new Map<string, string>();
    const total = project.tasks.length;
    log(`${total} tasks found in the source project.`);

    const PROGRESS_INTERVAL = 25;

    for (let i = 0; i < project.tasks.length; i++) {
      const task = project.tasks[i];
      emit({ type: 'task', message: `Migrating task: ${task.name}`, done: i + 1, total });

      const item = await this.migrateTask(task, projectGid, sectionGidMap, sourceIdFieldGid, nativeDueOnSourceId, nativeNotesSourceId, nativeAssigneeSourceId, nativeFollowersSourceId, userGidMap, fieldGidMap, enumOptionMap, fieldTypeMap, taskGidMap, report);
      report.items.push(item);

      const processed = i + 1;
      if (processed % PROGRESS_INTERVAL === 0 && processed < total) {
        log(`===> ${processed} tasks processed out of ${total}`);
      }
    }

    log(`${report.migratedTasks} tasks processed out of ${total}`);
    if (report.migratedSubtasks > 0) log(`${report.migratedSubtasks} subtasks migrated.`);
    if (report.migratedComments > 0) log(`${report.migratedComments} comments migrated.`);
    if (report.migratedAttachments > 0) log(`${report.migratedAttachments} attachments linked.`);

    // Step 6: wire up dependencies
    let depAttempts = 0;
    for (const task of project.tasks) {
      if (!task.dependencyIds.length) continue;
      const taskGid = taskGidMap.get(task.id);
      if (!taskGid) continue;
      for (const depId of task.dependencyIds) {
        const depGid = taskGidMap.get(depId);
        if (!depGid) continue;
        depAttempts++;
        try {
          await this.request('POST', `/tasks/${encodeURIComponent(taskGid)}/addDependencies`, { dependencies: [depGid] });
          report.migratedDependencies++;
        } catch (err) {
          logger.warn({ err, taskGid, depGid }, 'failed to add dependency');
          report.warnings++;
        }
      }
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
        const taskName = `Migration log: ${project.name} → ${options.destProjectName ?? projectGid} (${new Date().toLocaleDateString()})`;
        const reportTask = await this.request<{ gid: string }>('POST', '/tasks', {
          projects: [options.trackingProjectGid],
          name: taskName,
          notes: this.formatReportSummary(report, options.writerName),
        });
        report.trackingTaskGid = reportTask.gid;

        const filename = `migration-report-${new Date().toISOString().slice(0, 10)}.txt`;
        await this.uploadTextAttachment(reportTask.gid, filename, this.formatReportLog(report));

        emit({ type: 'info', message: 'Report saved to tracking project' });
      } catch (err) {
        logger.warn({ err }, 'failed to save report to tracking project');
        report.warnings++;
      }
    }

    // Step 7: add migrated project to tracking portfolio
    if (options.trackingPortfolioGid && projectGid) {
      try {
        await this.addProjectToPortfolio(options.trackingPortfolioGid, projectGid);
        log('Migrated project added to tracking portfolio.');
        emit({ type: 'info', message: 'Project added to tracking portfolio' });
      } catch (err) {
        logger.warn({ err }, 'failed to add project to tracking portfolio');
        report.warnings++;
      }
    }

    // Step 8: transfer project ownership to the specified user
    if (options.projectOwnerGid && projectGid) {
      try {
        await this.request('PUT', `/projects/${encodeURIComponent(projectGid)}`, {
          owner: options.projectOwnerGid,
        });
        log('Project ownership transferred to specified user.');
        emit({ type: 'info', message: 'Project ownership transferred' });
      } catch (err) {
        log(`Failed to transfer project ownership: ${(err as Error).message}`, 'warning');
        report.warnings++;
      }
    }

    emit({ type: 'info', message: 'Migration complete' });
    return report;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async migrateTask(
    task: NormalisedTask,
    projectGid: string,
    sectionGidMap: Map<string, string>,
    sourceIdFieldGid: string | undefined,
    nativeDueOnSourceId: string | undefined,
    nativeNotesSourceId: string | undefined,
    nativeAssigneeSourceId: string | undefined,
    nativeFollowersSourceId: string | undefined,
    userGidMap: Map<string, string>,
    fieldGidMap: Map<string, string>,
    enumOptionMap: Map<string, Map<string, string>>,
    fieldTypeMap: Map<string, AsanaFieldType>,
    taskGidMap: Map<string, string>,
    report: MigrationReport,
  ): Promise<MigrationReportItem> {
    try {
      const customFields: Record<string, unknown> = {};
      for (const [sourceFieldId, value] of Object.entries(task.customFields)) {
        const destGid = fieldGidMap.get(sourceFieldId);
        if (!destGid || value === null || value === '') continue;

        const optMap = enumOptionMap.get(sourceFieldId);
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
        } else if (fieldTypeMap.get(sourceFieldId) === 'date') {
          // Date custom fields require { date: "YYYY-MM-DD" }, not a plain string
          const dateStr = Array.isArray(value) ? value[0] : value;
          if (dateStr) customFields[destGid] = { date: String(dateStr).substring(0, 10) };
        } else {
          customFields[destGid] = value;
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
        const gid = firstId ? userGidMap.get(firstId) : undefined;
        if (gid) payload.assignee = gid;
      } else if (task.assigneeId) {
        const asanaGid = userGidMap.get(task.assigneeId);
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

      const created = await this.request<{ gid: string }>('POST', '/tasks', payload);
      taskGidMap.set(task.id, created.gid);
      report.migratedTasks++;

      // Subtasks
      for (const subtask of task.subtasks) {
        await this.migrateSubtask(subtask, created.gid, sourceIdFieldGid, userGidMap, taskGidMap, report);
      }

      // Comments
      for (const comment of task.comments) {
        try {
          await this.request('POST', `/tasks/${encodeURIComponent(created.gid)}/stories`, {
            text: `[${comment.authorName}]: ${this.htmlToText(comment.text)}`,
          });
          report.migratedComments++;
        } catch (err) {
          logger.warn({ err, commentId: comment.id, taskId: task.id }, 'failed to migrate comment');
          report.warnings++;
        }
      }

      // Attachments — download from source and re-upload to Asana.
      // Falls back to posting the URL as a comment if the download or upload fails.
      for (const attachment of task.attachments) {
        try {
          await this.downloadAndAttach(created.gid, attachment);
          report.migratedAttachments++;
        } catch (err) {
          logger.warn({ err, attachmentId: attachment.id }, 'attachment transfer failed, falling back to URL comment');
          try {
            await this.request('POST', `/tasks/${encodeURIComponent(created.gid)}/stories`, {
              text: `Attachment (transfer failed): [${attachment.name}](${attachment.url})`,
            });
          } catch { /* ignore story failure */ }
          report.warnings++;
        }
      }

      return { taskId: task.id, taskName: task.name, status: 'success' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, taskId: task.id }, 'failed to migrate task');
      report.errors++;
      return { taskId: task.id, taskName: task.name, status: 'error', message: msg };
    }
  }

  private async migrateSubtask(
    subtask: NormalisedTask,
    parentGid: string,
    sourceIdFieldGid: string | undefined,
    userGidMap: Map<string, string>,
    taskGidMap: Map<string, string>,
    report: MigrationReport,
  ): Promise<void> {
    try {
      const customFields: Record<string, unknown> = {};
      if (sourceIdFieldGid) customFields[sourceIdFieldGid] = subtask.id;

      const payload: Record<string, unknown> = {
        parent: parentGid,
        name: subtask.name,
        completed: subtask.completed,
        custom_fields: customFields,
      };

      if (subtask.assigneeId) {
        const asanaGid = userGidMap.get(subtask.assigneeId);
        if (asanaGid) payload.assignee = asanaGid;
      }

      if (subtask.dueDate) payload.due_on = subtask.dueDate.substring(0, 10);

      const created = await this.request<{ gid: string }>('POST', '/tasks', payload);
      taskGidMap.set(subtask.id, created.gid);
      report.migratedSubtasks++;

      for (const comment of subtask.comments) {
        try {
          await this.request('POST', `/tasks/${encodeURIComponent(created.gid)}/stories`, {
            text: `[${comment.authorName}]: ${this.htmlToText(comment.text)}`,
          });
          report.migratedComments++;
        } catch (err) {
          logger.warn({ err, commentId: comment.id, subtaskId: subtask.id }, 'failed to migrate subtask comment');
          report.warnings++;
        }
      }

      for (const attachment of subtask.attachments) {
        try {
          await this.downloadAndAttach(created.gid, attachment);
          report.migratedAttachments++;
        } catch (err) {
          logger.warn({ err, attachmentId: attachment.id }, 'subtask attachment transfer failed, falling back to URL comment');
          try {
            await this.request('POST', `/tasks/${encodeURIComponent(created.gid)}/stories`, {
              text: `Attachment (transfer failed): [${attachment.name}](${attachment.url})`,
            });
          } catch { /* ignore story failure */ }
          report.warnings++;
        }
      }
    } catch (err) {
      logger.warn({ err, subtaskId: subtask.id }, 'failed to migrate subtask');
      report.warnings++;
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
  }> {
    const fieldGidMap = new Map<string, string>();
    const enumOptionMap = new Map<string, Map<string, string>>();
    const fieldTypeMap = new Map<string, AsanaFieldType>();

    for (const entry of fieldMapping) {
      if (entry.omit) continue;
      if (entry.destNativeField) continue; // value goes to native Asana field, not a custom field

      if (!entry.destFieldId) {
        // Create a project-level field via inline addCustomFieldSetting.
        // This scopes the field to the project only — it won't appear in the workspace
        // field library and won't conflict across migrations.
        const asanaType = entry.destFieldType ?? this.mapToAsanaFieldType(entry.sourceFieldType);
        const fieldName = `m_${entry.sourceFieldName}`;
        log(`Creating project-level field '${fieldName}' (type: ${asanaType}).`);
        try {
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
            // Checkbox source values: "v" / "1" / "true" → "Yes", everything else → "No"
            if (entry.sourceFieldType === 'checkbox') {
              const yesGid = optMap.get('Yes');
              const noGid = optMap.get('No');
              if (yesGid) { optMap.set('v', yesGid); optMap.set('1', yesGid); optMap.set('true', yesGid); }
              if (noGid)  { optMap.set('0', noGid);  optMap.set('false', noGid); }
            }
            enumOptionMap.set(entry.sourceFieldId, optMap);
          }

          log(`Field '${fieldName}' created.`);
        } catch (err) {
          log(`Failed to create field 'm_${entry.sourceFieldName}': ${(err as Error).message}`, 'warning');
          logger.warn({ err, field: entry.sourceFieldName }, 'failed to create custom field');
        }
      } else {
        // Map to existing field — attach to project if not already attached
        log(`Field '${entry.sourceFieldName}' mapped to existing Asana field '${entry.destFieldName}'.`);
        const existingType = entry.destFieldType ?? this.mapToAsanaFieldType(entry.sourceFieldType);
        fieldTypeMap.set(entry.sourceFieldId, existingType);
        try {
          await this.request('POST', `/projects/${encodeURIComponent(projectGid)}/addCustomFieldSetting`, {
            custom_field: entry.destFieldId,
          });
          fieldGidMap.set(entry.sourceFieldId, entry.destFieldId);
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== '400') {
            log(`Failed to attach field '${entry.sourceFieldName}': ${(err as Error).message}`, 'warning');
            logger.warn({ err, fieldGid: entry.destFieldId }, 'failed to attach custom field');
          } else {
            // 400 = field already on project — that's fine
            fieldGidMap.set(entry.sourceFieldId, entry.destFieldId);
          }
        }

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

    return { fieldGidMap, enumOptionMap, fieldTypeMap };
  }

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
        let options: Array<{ name: string }>;
        if (entry.sourceFieldType === 'checkbox') {
          options = [{ name: 'Yes' }, { name: 'No' }];
        } else if (entry.sourceOptions?.length) {
          options = entry.sourceOptions.map((opt) => ({ name: String(opt.name) }));
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

  /** ISO timestamp formatted as "YYYY-MM-DD HH:MM:SS". */
  private ts(): string {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
  }

  /** Short summary written to the task notes field (visible without opening the attachment). */
  private formatReportSummary(report: MigrationReport, writerName?: string): string {
    return [
      `Migration Report — ${report.sourceProject}`,
      writerName ? `Performed by: ${writerName} (Cirface Migration Tool)` : 'Performed by: Cirface Migration Tool',
      `Started:   ${report.startedAt}`,
      `Completed: ${report.completedAt}`,
      ``,
      `Tasks migrated:       ${report.migratedTasks} / ${report.totalTasks}`,
      `Subtasks migrated:    ${report.migratedSubtasks}`,
      `Comments migrated:    ${report.migratedComments}`,
      `Attachments linked:   ${report.migratedAttachments}`,
      `Dependencies wired:   ${report.migratedDependencies}`,
      `Warnings:             ${report.warnings}`,
      `Errors:               ${report.errors}`,
      ``,
      `Full activity log is in the attached report file.`,
    ].join('\n');
  }

  /** Full timestamped activity log, written to the attached .txt file. */
  private formatReportLog(report: MigrationReport): string {
    const title = `${report.sourceProject} migration report`;
    const lines = [title];

    // Chronological activity log
    for (const entry of report.log) {
      lines.push(`${entry.message}\t${entry.time}`);
    }

    // Task-level detail section
    const errors = report.items.filter((i) => i.status === 'error');
    const warnings = report.items.filter((i) => i.status === 'warning');

    if (errors.length || warnings.length) {
      lines.push('');
      lines.push('--- Issues ---');
      for (const item of [...errors, ...warnings]) {
        const tag = item.status === 'error' ? 'ERROR' : 'WARN ';
        lines.push(`[${tag}] ${item.taskName}${item.message ? ': ' + item.message : ''}`);
      }
    }

    return lines.join('\n');
  }

  /** Download a file from the source URL and upload it as a native Asana attachment. */
  private async downloadAndAttach(taskGid: string, attachment: NormalisedAttachment): Promise<void> {
    const dlRes = await fetch(attachment.url, { signal: AbortSignal.timeout(60_000) });
    if (!dlRes.ok) throw new Error(`Download failed (${dlRes.status}): ${attachment.url}`);

    const arrayBuffer = await dlRes.arrayBuffer();
    const mimeType = attachment.mimeType ?? dlRes.headers.get('content-type') ?? 'application/octet-stream';
    const blob = new Blob([arrayBuffer], { type: mimeType });

    const formData = new FormData();
    formData.append('parent', taskGid);
    formData.append('file', blob, attachment.name);

    const upRes = await fetch(`${ASANA_BASE}/attachments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: formData,
      signal: AbortSignal.timeout(60_000),
    });

    if (!upRes.ok) {
      const json = await upRes.json().catch(() => ({})) as { errors?: Array<{ message: string }> };
      throw new Error(json.errors?.[0]?.message ?? `Upload failed (${upRes.status})`);
    }
  }

  /** Upload a plain-text string as a file attachment on a task. */
  private async uploadTextAttachment(taskGid: string, filename: string, content: string): Promise<void> {
    const formData = new FormData();
    formData.append('parent', taskGid);
    formData.append('file', new Blob([content], { type: 'text/plain' }), filename);

    const res = await fetch(`${ASANA_BASE}/attachments`, {
      method: 'POST',
      headers: {
        // Do NOT set Content-Type — fetch sets it automatically with the multipart boundary
        Authorization: `Bearer ${this.token}`,
      },
      body: formData,
    });

    if (!res.ok) {
      const json = await res.json().catch(() => ({})) as { errors?: Array<{ message: string }> };
      throw new Error(json.errors?.[0]?.message ?? `Attachment upload failed (${res.status})`);
    }
  }
}
