# Improvement Plan: obsidian-filen-sync

Comparison of current MVP against `docs/obsidian-livesync-research.md` and `docs/remotely-save-research.md`.

## Gaps

**From LiveSync research:**
- No compression — plan explicitly specified `.jsonl.gz`; current sends raw JSONL
- No content hash — full file re-uploaded on any mtime/ctime drift
- No chunking — deferred, but hash-based dedup is prerequisite

**From remotely-save research:**
- State stored in `settings.json` — bloats plugin data for large vaults; IndexedDB scales better
- No auto-sync — remotely-save supports on-save, interval, and init-delay triggers
- No file filtering — no ignore/allow path rules
- Sequential pull — remote journals applied one-by-one
- Conflict strategy is hard-coded — no user choice (keep_newer, keep_larger)

---

## Priority 1 — Compression (fills planned `.jsonl.gz` gap)

**Problem:** Raw JSONL + Base64 is verbose. Implementation plan explicitly called for deflate.

**Solution:** Compress JSONL with gzip before upload; auto-detect on read via magic bytes.

**`src/bytes.ts`** — add:
```typescript
compress(bytes: Uint8Array): Promise<Uint8Array>   // CompressionStream("gzip")
decompress(bytes: Uint8Array): Promise<Uint8Array>  // DecompressionStream("gzip")
isGzip(bytes: Uint8Array): boolean                  // first 2 bytes: 0x1f 0x8b
```

**`src/journal.ts`** — update `encode()`/`decode()` to be async:
- `encode()`: compress output with gzip
- `decode()`: auto-detect via `Bytes.isGzip()`, decompress if needed (backward compat)

**`src/sync-engine.ts`** — `push()` and `pull()` await async encode/decode.

No journal file naming change needed — magic bytes handle detection transparently.

---

## Priority 2 — Content hash for change detection

**Problem:** mtime/ctime drift (copy, restore, OS touch) causes false re-uploads with identical content. remotely-save's `Entity` has a `hash` field; LiveSync chunks files by content hash.

**Solution:** SHA-256 hash of file content as primary change signal.

**`src/bytes.ts`** — add:
```typescript
sha256hex(bytes: Uint8Array): Promise<string>  // Web Crypto API
```

**`src/settings.ts`** — add `hash: string` to `SyncedFileRecord` (empty string = no hash, falls back to mtime+ctime+size).

**`src/journal.ts`** — add `hash: string` to `FileJournalEntry`.

**`src/sync-engine.ts`**:
- `collectLocalChanges()`: compute hash per file; skip if hash matches cached hash
- `sameFileRecord()`: if both records have non-empty hash, compare hash only
- `applyRemoteEntry()`: store received hash in file state

Backward compatible — old clients ignore hash field.

---

## Priority 3 — Move file state to IndexedDB

**Problem:** `state.files` (Record of all synced file metadata) lives in `settings.json`. A 5,000-note vault with hash fields will bloat settings significantly. remotely-save uses `localforage` (IndexedDB) for prev-sync records.

**Solution:** Replace `state.files: Record<string, SyncedFileRecord>` with an IndexedDB store.

**New file: `src/db.ts`**:
```typescript
// Thin localforage wrapper
type SyncDb = {
  getFile(path: string): Promise<SyncedFileRecord | null>;
  setFile(path: string, record: SyncedFileRecord): Promise<void>;
  deleteFile(path: string): Promise<void>;
  getAllFiles(): Promise<Map<string, SyncedFileRecord>>;
  clear(): Promise<void>;
};
```

**`src/settings.ts`** — remove `files` from `SyncState`; keep `lastPulledKey` and `sentJournalKeys`.

**`src/sync-engine.ts`** — replace `settings.state.files[...]` with `await db.getFile(...)` / `await db.setFile(...)`.

**Migration:** On first load, if `settings.state.files` is non-empty, migrate to IndexedDB then clear from settings.

**New dependency:** `localforage`

---

## Priority 4 — Auto-sync triggers

**Problem:** Manual-only sync is friction. remotely-save supports on-save and interval triggers.

**`src/settings.ts`** — add:
```typescript
syncOnSave: boolean;             // default false
autoSyncIntervalMinutes: number; // default 0 (disabled)
syncOnStartDelaySeconds: number; // default 0 (disabled)
```

**`src/main.ts`** — in `onload()`:
```typescript
if (settings.syncOnSave) {
  // throttled 3s debounce, same as remotely-save
  this.registerEvent(
    this.app.vault.on("modify", () => void this.debouncedSync())
  );
}
if (settings.autoSyncIntervalMinutes > 0) {
  this.registerInterval(
    window.setInterval(() => void this.syncNow(), settings.autoSyncIntervalMinutes * 60_000)
  );
}
if (settings.syncOnStartDelaySeconds > 0) {
  setTimeout(() => void this.syncNow(), settings.syncOnStartDelaySeconds * 1_000);
}
```

Add `isSyncing` guard to skip auto-triggered run if sync already in progress.

---

## Deferred

- **Chunking** — prerequisite (content hash) is Priority 2; add after that lands
- **Conflict strategy setting** (keep_newer, keep_larger) — current conflict-copy behavior is fine for now
- **File filtering** (ignore/allow paths) — add when requested
- **Concurrent pull** — not a bottleneck until large journal backlogs
- **Plugin-level E2EE** — Filen provides at SDK level; defer

---

## Files to modify

| File | Changes |
|---|---|
| `src/bytes.ts` | Add `sha256hex()`, `compress()`, `decompress()`, `isGzip()` |
| `src/settings.ts` | Add `hash` to `SyncedFileRecord`; add auto-sync fields; remove `files` from `SyncState` |
| `src/journal.ts` | Add `hash` to `FileJournalEntry`; make `encode()`/`decode()` async with compression |
| `src/sync-engine.ts` | Hash computation, async encode/decode, use db instead of settings.state.files |
| `src/main.ts` | Auto-sync triggers, `isSyncing` guard |

## New files

| File | Purpose |
|---|---|
| `src/db.ts` | IndexedDB wrapper for prev-sync file records (`localforage`) |

## New dependency

- `localforage` — IndexedDB abstraction (used by remotely-save, widely supported, ~25KB)

---

## Verification

1. `npm run build` — no type errors
2. `npm run deploy:test-vault <path>`
3. Push → confirm journal is gzip (magic bytes `1f 8b`)
4. Pull → confirm decode + apply works
5. Touch file (no content change) → push → confirm not re-uploaded
6. Edit file → push → confirm re-uploaded
7. Large vault → confirm `settings.json` no longer contains file records after migration
8. Enable `syncOnSave` → edit note → confirm auto-sync fires after debounce

---

## Unresolved questions

1. `CompressionStream` on mobile — confirmed in Node 17+ / Chrome 80+; Obsidian minAppVersion 0.15.0 targets Electron ~21, so should be fine, but test on mobile before shipping
2. Scope: all 4 priorities in one PR, or land incrementally?
3. `localforage` bundle size (~25KB) acceptable, or use raw IndexedDB?
