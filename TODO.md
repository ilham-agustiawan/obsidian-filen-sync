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

## Fix next

- [x] Delete propagation in bidirectional mode
  - local deleted + remote unchanged => delete remote
  - remote deleted + local unchanged => delete local
- [x] Delete propagation in one-way modes
  - push mode should delete remote when local deleted from prev
  - pull mode should delete local when remote deleted from prev
- [x] Remote overwrite semantics: Filen SDK versions on same parent+name; walk deduplicates by path; no code change needed
- [x] Failed row state: mark per-file failures in progress table before throwing

## Improve

- [ ] File filtering: ignore rules for paths/folders beyond plugin data dir
- [ ] Auto-sync settings: on save, interval, startup delay
- [ ] Debounced vault modify trigger
- [ ] Remote walk performance: reduce `stat()` calls if SDK exposes metadata in listing
- [ ] Conflict strategy setting: keep newer, keep local, keep remote
- [ ] Safer local deletion path: trash local where Obsidian adapter supports it
- [ ] Mobile runtime verification

## Deferred

- [ ] Plugin-level E2EE. Filen already encrypts account data.
- [ ] Chunking/dedup. Direct mirror writes whole files.
- [ ] Rename detection. Current model treats rename as delete + create.
- [ ] Background/socket sync. Current SDK uses `connectToSocket: false`.
