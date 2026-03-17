# Migration Tool — Dev Notes

Internal notes on known limitations, implementation decisions, and gotchas.
This page is only linked from the UI in development and staging environments.

---

## Monday.com Connector

### Subitem comments and attachments are not migrated

**File:** `connectors/monday.ts` — `getProjectData()`

Monday's GraphQL API enforces a query complexity limit. Including `updates` and `assets`
nested inside `subitems { ... }` inside `items_page { ... }` exceeded that limit and caused
the API to return an error before returning any data (manifesting as "failed to load custom fields"
in the UI because the whole board fetch was failing).

**Fix applied:** Removed `updates` and `assets` from the `subitems` block in both the initial
query and the pagination (`next_items_page`) query. The main items' updates and assets are
still fetched and migrate correctly.

**What migrates:**
- Subitem name ✓
- Subitem completion status ✓
- Subitem custom field values ✓
- Subitem assignee (from column_values people column) ✓

**What is skipped:**
- Comments attached directly to a subitem ✗
- File attachments attached directly to a subitem ✗

**Future fix if needed:** Fetch subitem updates/assets in a separate per-item pass after the
main query. This requires many extra API calls and rate-limit awareness, so it was deferred.

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

The PAT or Service Accounts belongs to a member of the workspace (e.g. "Cirface Migration Bot") that is a member of every workspace we migrate into. All tasks and comments created in Asana are attributed to that account, making it clear the content was created by the migration tool and not by the user.

The PAT owner's name is fetched from `GET /users/me` at connect time and stored in the session (`destConfig.patUserName`). It is included in the migration report task notes as
`Performed by: [name] (Cirface Migration Tool)`.

### Attachments are linked, not downloaded

Binary attachment files are not downloaded from the source and re-uploaded to Asana.
Instead, attachment URLs are posted as story comments on the task. This avoids needing
to handle auth for source file downloads and large binary transfers.

---

_Last updated: 2026-03-12_
