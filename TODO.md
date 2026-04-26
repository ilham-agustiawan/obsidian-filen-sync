# TODO

Current implementation: direct Filen folder mirror.

## Done

- [x] Filen auth through `@filen/sdk`
- [x] Persist saved Filen auth; keep password/2FA session-only
- [x] Direct remote FS adapter: `src/fs-remote.ts`
- [x] 3-way local/remote/prev-sync scan: `src/sync-engine.ts`
- [x] Prev-sync state in IndexedDB via `localforage`: `src/db.ts`
- [x] Content hash fallback for local mtime/ctime drift
- [x] Manual Sync / Push / Pull commands
- [x] Settings actions for connection test and sync modes
- [x] Sync progress view with filters
- [x] File version modal: list, restore, delete Filen versions
- [x] Conflict copy for both-sides edits
- [x] `isSyncing` guard

## Improve

- [ ] **Improve UI/UX to be on par with Obsidian Sync**
  - [x] **Consolidate UI elements**: Remove the 3 ribbon icons (`sync`, `history`, `timer`). Move background sync status to a single dynamic Status Bar item (like Obsidian Sync) with hover details.
  - [x] **Command & Menu migration**: Keep "Sync Now" in Command Palette. Restrict "File versions" access exclusively to the File context menu (right-click).
  - [x] **Settings revamp**: Reorganize settings into logical sections (`Account/Auth`, `Sync Strategy`, `Auto-sync`, `Actions`). Replace password input with a clear "Connected as [email] — Disconnect" state when authenticated.
  - [x] **Activity Log**: Revamp `progress-view.ts` to look more like the native Sync Activity Modal, using standard icons (up/down arrows, trash) for visual clarity.
  - [ ] **Conflict Resolution UX**: Build a UI/Modal to review conflicts side-by-side (Keep Local, Keep Remote, Keep Both) instead of only silently appending `(conflict)` suffixes.
  - [x] **Onboarding**: Add a first-time setup prompt if `!hasSavedAuth()`.
- [x] File filtering: ignore rules for paths/folders beyond plugin data dir
- [x] Auto-sync settings: on save, interval, startup delay
- [x] Debounced vault modify trigger
- [x] Remote walk performance: reduce `stat()` calls if SDK exposes metadata in listing
- [ ] Conflict strategy setting: keep newer, keep local, keep remote
- [x] Safer local deletion path: use Obsidian file manager trash preference
- [x] Mobile runtime verification
