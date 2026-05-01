# Obsidian Filen Sync roadmap toward Obsidian Sync parity

This document captures improvements that would make Obsidian Filen Sync feel closer to official Obsidian Sync while staying compatible with Obsidian community-plugin constraints and Filen as the remote backend.

## Goals

- Make sync safe enough for everyday vault use on desktop and mobile.
- Minimize surprising file loss through better baselines, history, conflicts, and recovery tools.
- Provide clear sync state, progress, errors, and repair actions.
- Keep startup lightweight and avoid hidden network activity.
- Preserve privacy: no telemetry, no third-party services beyond Filen.

## Current baseline

Implemented today:

- Manual bidirectional sync.
- Manual push-local and pull-remote modes.
- Saved Filen auth after first login.
- Session-only password and 2FA.
- Optional sync on save, interval sync, and startup sync.
- Status bar indicator and activity view.
- Local IndexedDB sync-state database.
- File version list, restore, and delete for Filen versions.
- Basic conflict copies.
- Ignore rules for cache/workspace/plugin data.

Known gaps:

- No realtime remote change listener.
- No rename/move detection.
- No side-by-side conflict resolution UI.
- No full sync health dashboard.
- No settings/plugin sync controls.
- No selective sync UI beyond ignore patterns.
- ~~Limited mobile-specific diagnostics.~~ → Startup self-checks and debug reports added in Phase 1.

## Feature parity roadmap

### 1. Mobile reliability first

Official Sync feels dependable because it loads everywhere and clearly reports issues.

Planned work:

- Add a mobile compatibility audit for all bundled dependencies.
- Remove or shim remaining Node/Electron-only assumptions.
- Prefer browser APIs: `window.crypto`, `fetch`, `ReadableStream`, IndexedDB.
- Add startup self-checks:
  - Web Crypto availability.
  - IndexedDB/localforage availability.
  - Filen SDK runtime availability.
  - Network reachability.
- Show a friendly plugin-load or setup diagnostic notice instead of silent failures.
- Add a **Copy debug report** button with app version, platform, plugin version, sync settings summary, and last error. Exclude vault contents and auth secrets.

Acceptance criteria:

- Plugin loads on iOS and Android Obsidian.
- Failed prerequisites produce actionable messages.
- Debug report contains no credentials or note content.

### 2. Safer sync state and change tracking

Current state relies on path, mtime, ctime, size, and optional hash. To match Sync-like reliability, the engine needs stronger metadata.

Planned work:

- Store stable file identity records:
  - Path.
  - Size.
  - Modified time.
  - SHA-256 content hash.
  - Remote UUID when available.
  - Last successful sync time.
  - Last known side: local, remote, both.
- Hash files lazily and cache hashes to avoid expensive rescans.
- Add sync journal entries for each operation before applying changes.
- Add crash recovery that can resume or roll back incomplete operations.
- Add database migration helpers for future sync-state schema changes.

Acceptance criteria:

- Interrupted sync can be detected on next launch.
- User can run **Repair sync state** without deleting notes.
- Sync database migrations are versioned and reversible where practical.

### 3. Rename and move detection

Official Sync handles file moves without treating every move as delete plus upload.

Planned work:

- Detect local renames by matching previous hash/size to new path.
- Detect remote renames by tracking remote UUIDs from Filen.
- Add rename operations to the plan:
  - `rename-local`.
  - `rename-remote`.
  - `move-local-folder` where practical.
- Preserve version history when Filen supports server-side move/rename APIs.
- Fall back to upload/download when a true remote rename is unavailable.

Acceptance criteria:

- Renaming a note syncs as a rename when metadata proves identity.
- Rename conflicts keep both paths and report clearly.

### 4. Conflict resolution UI

Current behavior creates conflict copies but does not help resolve them.

Planned work:

- Add a **Conflict center** view.
- Show local, remote, and baseline metadata.
- Provide actions:
  - Keep local.
  - Keep remote.
  - Keep both.
  - Open local conflict copy.
  - Mark resolved.
- For Markdown/text files, add a side-by-side diff and simple merge workflow.
- For binary files, show metadata and open/restore options.
- Make conflict strategy configurable:
  - Ask every time.
  - Prefer newest.
  - Prefer local.
  - Prefer remote.
  - Keep both.

Acceptance criteria:

- Conflicts are visible in one place.
- Resolving a conflict updates sync state safely.
- No automatic overwrite occurs without a preserved recoverable copy.

### 5. Version history and recovery

Official Sync has strong restore/version-history UX. Obsidian Filen Sync already exposes file versions but can improve discovery and bulk restore.

Planned work:

- Add **Version history** command for the active file.
- Add version history from the activity view.
- Show version metadata consistently:
  - Timestamp.
  - Size.
  - Version number.
  - Remote UUID.
- Add preview for text/Markdown versions.
- Add restore modes:
  - Restore over current file.
  - Restore as copy.
  - Download version to conflict/recovery folder.
- Add bulk recovery:
  - Restore deleted file.
  - Browse recently deleted remote files, if Filen API supports it.
  - Export recovery report.

Acceptance criteria:

- User can restore a previous note without leaving Obsidian.
- Restore operations are journaled and undo-safe where possible.

### 6. Selective sync and exclusions

Official Sync lets users choose what types of data sync. This plugin needs easier controls beyond raw ignore patterns.

Planned work:

- Add toggles for common exclusions:
  - Obsidian workspace/layout state.
  - Plugin data.
  - Themes and snippets.
  - Large attachments.
  - Hidden folders.
  - `.git`.
- Add max-file-size setting.
- Add file extension include/exclude lists.
- Add dry-run preview before applying changed ignore rules.
- Add per-folder **Exclude from Obsidian Filen Sync** context menu action.

Acceptance criteria:

- Non-technical users can configure selective sync without writing globs.
- Changing exclusions never silently deletes remote/local data without confirmation.

### 7. Settings, themes, snippets, and plugin data sync

Official Sync can sync Obsidian configuration. This should be explicit and conservative.

Planned work:

- Add optional sync categories:
  - Core settings.
  - Hotkeys.
  - Appearance/theme settings.
  - CSS snippets.
  - Community plugin list.
  - Individual community plugin settings.
- Default to off for plugin data sync.
- Show risk warnings for syncing plugin data across mobile/desktop.
- Maintain a protected ignore list for volatile files:
  - Workspace state.
  - Cache.
  - Plugin runtime databases unless explicitly enabled.
- Add config conflict resolution separate from note conflict resolution.

Acceptance criteria:

- User can sync selected settings intentionally.
- Volatile Obsidian state is not synced by default.

### 8. Near-realtime sync behavior

Official Sync feels immediate. Obsidian Filen Sync can approximate this without requiring hidden background services.

Planned work:

- Improve local file event batching.
- Add remote polling with adaptive backoff:
  - Short interval while Obsidian is active.
  - Longer interval while idle.
  - Pause when offline.
- Add **Sync when app resumes** for mobile.
- Add **Sync before app sleeps/unloads** best effort.
- Add remote change quick scan that avoids full tree walks when possible.
- Queue sync requests so only one sync runs at a time.

Acceptance criteria:

- Edits sync shortly after save when enabled.
- Mobile resumes trigger a safe sync check.
- Background polling is clearly configurable and off/conservative by default.

### 9. Sync plan preview and health dashboard

Official Sync gives confidence through status visibility.

Planned work:

- Add **Preview sync plan** command.
- Show counts before applying:
  - Uploads.
  - Downloads.
  - Local deletes.
  - Remote deletes.
  - Renames.
  - Conflicts.
  - Skipped files.
- Add health dashboard:
  - Last successful sync.
  - Last error.
  - Files tracked.
  - Remote folder.
  - Auth status.
  - Pending operations.
- Add per-file status icons in activity view.
- Add warnings for dangerous operations, especially bulk deletes.

Acceptance criteria:

- User can inspect what will happen before first sync or after major changes.
- Bulk delete operations require confirmation.

### 10. Performance and large vault support

Official Sync handles large vaults with incremental behavior. This plugin should reduce full scans.

Planned work:

- Cache remote tree metadata.
- Incremental local scan using Obsidian file events plus periodic verification.
- Limit concurrent remote operations with configurable concurrency.
- Add retry with exponential backoff for transient network/API failures.
- Add chunked or streaming upload/download where Filen SDK supports it.
- Add memory caps for mobile.
- Skip hashing huge files unless required by conflict detection.

Acceptance criteria:

- Large vault sync does not freeze the UI.
- Network failures retry safely and surface final errors clearly.

### 11. Security and privacy hardening

Planned work:

- Review saved Filen auth storage and document exactly what is stored.
- Add optional passphrase lock for plugin auth data if feasible.
- Redact secrets from all logs and debug reports.
- Avoid logging full paths when user selects privacy mode.
- Add explicit disclosure for Filen network requests in README/settings.
- Add dependency review before releases.

Acceptance criteria:

- No credentials appear in console logs or debug reports.
- Privacy behavior is documented in app and README.

### 12. Testing and release quality

Planned work:

- Add unit tests for sync decision matrix:
  - New local.
  - New remote.
  - Both changed.
  - Deletes.
  - Renames.
  - Ignored paths.
- Add mocked Filen remote for deterministic tests.
- Add migration tests for sync database schema.
- Add mobile smoke-test checklist.
- Add release checklist:
  - `npm run build`.
  - Lint.
  - Manual desktop test.
  - Manual Android test.
  - Manual iOS test if available.
  - Fresh install test.
  - Upgrade test.

Acceptance criteria:

- Sync decision logic is covered by automated tests.
- Each release has repeatable manual verification steps.

## Suggested implementation phases

### Phase 1: Reliability and diagnostics ✅

- Mobile compatibility audit. ✅
- Startup self-checks (Web Crypto, IndexedDB, Fetch, ReadableStream, TextEncoder, Network). ✅
- Copy diagnostics report (command palette + settings button). ✅
- Better error messages for mobile-specific failures. ✅
- Retry with exponential backoff for transient network failures. ✅
- Error tracking for debug reports. ✅

### Phase 2: Safer sync core

- Versioned sync-state schema.
- Operation journal.
- Crash recovery.
- Stronger hash/remote UUID tracking.
- Sync plan preview.

### Phase 3: Recovery UX

- Conflict center.
- Text diff and merge actions.
- Improved version history.
- Restore as copy.

### Phase 4: Sync parity features

- Rename/move detection.
- Selective sync UI.
- Optional settings/theme/snippet sync.
- Adaptive remote polling and mobile resume sync.

### Phase 5: Scale and polish

- Incremental remote/local scans.
- Large vault performance tuning.
- Health dashboard.
- Full release checklist and test suite.

## Non-goals for now

- Replacing official Obsidian Sync protocol.
- Running hidden background services outside Obsidian.
- Syncing without user-controlled Filen credentials.
- Sending telemetry or vault analytics.

## Open questions

- Which Filen APIs expose stable UUIDs, deleted files, server-side moves, and efficient remote delta scans?
- Can Filen SDK uploads preserve version history for overwrite vs delete/recreate?
- How reliable is IndexedDB/localforage on all Obsidian mobile versions?
- What is the safest way to sync `.obsidian` settings without breaking mobile/desktop differences?
- Should auth data be optionally encrypted with a user passphrase despite Obsidian already storing plugin data locally?
