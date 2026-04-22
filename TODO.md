# TODO

Improvements based on LiveSync + remotely-save research. See `docs/plan/improvements.md` for full context.

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

- [ ] `Bytes.sha256hex(bytes)` — Web Crypto API — `src/bytes.ts`
- [ ] Add `hash: string` to `SyncedFileRecord` — `src/settings.ts`
- [ ] Add `hash: string` to `FileJournalEntry` — `src/journal.ts`
- [ ] `collectLocalChanges()`: compute + compare hash; skip if unchanged — `src/sync-engine.ts`
- [ ] `sameFileRecord()`: use hash when both records have one — `src/sync-engine.ts`
- [ ] `applyRemoteEntry()`: store hash from remote entry — `src/sync-engine.ts`

## Priority 3 — Move file state to IndexedDB

- [ ] Create `src/db.ts` — thin `localforage` wrapper (`SyncDb` interface)
- [ ] Remove `files` from `SyncState` — `src/settings.ts`
- [ ] Migrate existing `settings.state.files` → IndexedDB on first load — `src/main.ts`
- [ ] Replace all `settings.state.files[...]` access with `db.*` calls — `src/sync-engine.ts`
- [ ] Add `localforage` dependency

## Priority 4 — Auto-sync triggers

- [ ] Add `syncOnSave`, `autoSyncIntervalMinutes`, `syncOnStartDelaySeconds` to settings — `src/settings.ts`
- [ ] Add settings UI for the three trigger modes — `src/settings.ts`
- [ ] Add `isSyncing` guard to `runSyncTask` — `src/main.ts`
- [ ] Register vault `modify` event listener (debounced 3s) — `src/main.ts`
- [ ] Register interval and startup-delay triggers — `src/main.ts`
