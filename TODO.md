# TODO

Improvements based on LiveSync + remotely-save research. See `docs/plan/improvements.md` for full context.

## Direct file mirror migration

- [x] Replace `src/filen-store.ts` journal store with `src/fs-remote.ts`
- [x] Rewrite `src/sync-engine.ts` to 3-way local/remote/prev-sync compare
- [x] Remove `state.lastPulledKey` and `state.sentJournalKeys` from settings
- [x] Delete `src/journal.ts` after engine no longer uses journal blobs
- [x] Delete `src/bytes.ts` if no remaining consumer after migration
- [x] Keep `src/db.ts` as prev-sync state store
- [x] Verify Filen `writeFile` mtime behavior
- [x] Verify recursive listing / mkdir behavior in Filen SDK

## Settings + menu ergonomics ✅

- [x] Settings grouped into Account / Advanced / Actions sections
- [x] Auth status row: signed-in/not, email display, Sign out button
- [x] Action buttons in settings: Test connection, Sync now
- [x] Improved descriptions across all fields
- [x] `isSyncing` guard — blocks concurrent syncs, shows notice
- [x] Sync result messages: "up to date" / "nothing to push/pull" instead of raw counts
- [x] Ribbon tooltip updated to "Filen sync: sync now"
- [x] `syncNow()` and `testConnection()` made public (accessible from settings tab)

## Priority 1 — Compression ✅

- [x] `Bytes.compress()` / `Bytes.decompress()` / `Bytes.isGzip()` — `src/bytes.ts`
- [x] `Journal.encode()` async, compresses output with gzip
- [x] `Journal.decode()` async, auto-detects gzip via magic bytes (backward compat)
- [x] `SyncEngine.push()` / `pull()` await async encode/decode

## Priority 2 — Content hash for change detection

- [ ] Consider re-adding hash later if mtime-only comparison proves noisy

## Priority 3 — Move file state to IndexedDB

- [x] Create `src/db.ts` — thin `localforage` wrapper (`SyncDb` interface)
- [x] Remove `files` from `SyncState` — `src/settings.ts`
- [x] Migrate existing `settings.state.files` → IndexedDB on first load — `src/main.ts`
- [x] Replace all `settings.state.files[...]` access with `db.*` calls — `src/sync-engine.ts`
- [x] Add `localforage` dependency

## Priority 4 — Auto-sync triggers

- [ ] Add `syncOnSave`, `autoSyncIntervalMinutes`, `syncOnStartDelaySeconds` to settings — `src/settings.ts`
- [ ] Add settings UI for the three trigger modes — `src/settings.ts`
- [ ] Add `isSyncing` guard to `runSyncTask` — `src/main.ts`
- [ ] Register vault `modify` event listener (debounced 3s) — `src/main.ts`
- [ ] Register interval and startup-delay triggers — `src/main.ts`
