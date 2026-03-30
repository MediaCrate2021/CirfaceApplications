# Migration Tool — Dev Notes

Internal notes on known limitations, implementation decisions, and gotchas.
This page is only linked from the UI in development and staging environments.

---

## Monday.com Connector

### Subitem comments and attachments

Subitem comments and attachments **are** migrated. The connector uses a two-phase fetch:

- **Phase 1** — fetches board structure, groups, and all parent items with their column values and subitem IDs only. Updates and assets are excluded here because including them inside `subitems { ... }` inside `items_page { ... }` exceeds Monday's GraphQL complexity limit.
- **Phase 2** — batch-fetches full data (updates, assets, column values) for all IDs — both parent items and subitems — using `items(ids: $ids)` in batches of 100. This avoids the complexity limit and ensures comments and attachments are available for every item.

The subitem data from Phase 2 is then processed by `normaliseSubitem()`, and `migrateSubtask()` in the Asana destination posts comments as stories and downloads/re-uploads attachments.

### Dependencies — same-board only

**What migrates:** Dependencies between tasks on the same Monday board. The `dependency` column type stores `linkedPulseIds` in its JSON value; these IDs are extracted into `dependencyIds` and wired up in Asana after all tasks are created.

**What is skipped:** `board_relation` columns (cross-board dependencies). Those IDs reference tasks on other boards that are not part of this migration and will not exist in the destination Asana project. They are silently ignored. This is a fundamental Monday → Asana limitation: Asana has no concept of cross-project task dependencies at the API level.

---

## Trello Connector

### Dependencies not supported

Trello has no native task dependency concept. `dependencyIds` is always set to `[]` for all tasks.

### Custom Fields Power-Up silently skipped

If the Custom Fields Power-Up is not enabled on a board, the `/boards/{id}/customFields`
endpoint returns an error. The connector catches this and returns `[]` — no error is shown to the user.

---

## Asana Destination

### Destination uses a PAT, not the OAuth user's token

**Why:** The person authenticating with the app via Asana OAuth is the person *operating* the migrator — typically a consultant or project manager. They may not be a member of the destination Asana workspace at all. The destination write operations (creating tasks, custom fields, uploading report attachments, adding projects to portfolios) require a token with write access to that workspace, so a separate Personal Access Token is entered at Step 1 under "Destination Asana".

The PAT belongs to a member of the workspace (e.g. "Cirface Migration Bot") that is a member of every workspace we migrate into. All tasks and comments created in Asana are attributed to that account, making it clear the content was created by the migration tool and not by the user.

The PAT owner's name is fetched from `GET /users/me` at connect time and stored in the session (`destConfig.patUserName`). It is included in the migration report task notes as
`Performed by: [name] (Cirface Migration Tool)`.

### Attachments are downloaded and re-uploaded

Binary attachment files are downloaded from the source URL and re-uploaded to Asana via multipart form upload. If the download or upload fails, the attachment URL is posted as a fallback story comment on the task so the link is not lost.

---

_Last updated: 2026-03-30_
