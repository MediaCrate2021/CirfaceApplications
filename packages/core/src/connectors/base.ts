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
} from '../types/index.js';

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

  /**
   * Return a fresh download URL for a given asset ID.
   * Used when a cached pre-signed URL has expired (e.g. Monday S3 URLs expire after 1 hour).
   * Returns null if the platform does not support URL refresh or the asset cannot be found.
   */
  refreshAttachmentUrl?(assetId: string): Promise<string | null>;

  /**
   * Authenticate a download URL before fetching.
   * Used when the platform requires credentials appended to the URL (e.g. Trello API key/token).
   * Returns the URL unchanged if no authentication is needed.
   */
  authenticateAttachmentUrl?(url: string): string;
}
