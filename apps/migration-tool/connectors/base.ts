//-------------------------//
// connectors/base.ts
// Code implemented by Cirface.com / MMG
//
// Abstract interface that all source platform connectors must implement.
// The migration engine works exclusively with this interface — it never
// talks directly to Monday, Trello, or any other platform.
//
// Disclaimer: This code was created with the help of Claude.AI
//
// This code is part of Cirface Migration Tool
// Last updated by: 2026MAR11 - LMR
//-------------------------//

import type {
  NormalisedField,
  NormalisedProject,
  NormalisedUser,
  ProjectListItem,
  SourcePlatform,
} from '../src/types/index.js';

export interface SourceConnector {
  readonly platform: SourcePlatform;

  /** Verify the token is valid and the connection works. Throws on failure. */
  testConnection(): Promise<{ workspaceName: string }>;

  /** Return all users visible in the connected account. */
  getUsers(): Promise<NormalisedUser[]>;

  /** Return a lightweight list of workspace/team groupings, if the platform supports it. */
  getWorkspaces?(): Promise<Array<{ id: string; name: string }>>;

  /** Return a lightweight list of projects (id + name only), optionally filtered by workspace/team. */
  getProjects(workspaceId?: string): Promise<ProjectListItem[]>;

  /**
   * Fetch only the custom field definitions for a project — no tasks, no users.
   * Used by the field mapping step; much lighter than getProjectData().
   */
  getProjectFields(projectId: string): Promise<NormalisedField[]>;

  /**
   * Fetch full project data: tasks, subtasks, comments, attachments,
   * dependencies, custom fields, and users.
   */
  getProjectData(projectId: string): Promise<NormalisedProject>;
}
