# Plan: Direct file mirror (remotely-save model)

Replace journal blobs with a 1:1 vault mirror on Filen. Change detection via
3-way mtime+size comparison (local vs remote vs prevSync in IndexedDB).

## Architecture

```
LOCAL vault files
   ↕  mtime+size
PREV SYNC state  ← IndexedDB (SyncDb)
   ↕  mtime+size
REMOTE Filen folder  ← mirrors vault tree
```

Decision table: see `docs/remotely-save-research.md` §Stage 3.

## Files

| File | Action |
|---|---|
| `src/fs-remote.ts` | New — Filen remote FS adapter (replaces `filen-store.ts`) |
| `src/sync-engine.ts` | Rewrite — 3-way compare; drop push/pull journal model |
| `src/settings.ts` | Remove `state.lastPulledKey`, `state.sentJournalKeys` |
| `src/journal.ts` | Delete |
| `src/bytes.ts` | Delete (if no other consumer) |
| `src/db.ts` | Keep — `SyncedFileRecord` shape already correct |

### `RemoteFs` interface (`src/fs-remote.ts`)

```ts
type RemoteEntry = {
  path: string;   // relative to vault root, e.g. "notes/daily.md"
  mtime: number;  // FSStats.mtimeMs
  size: number;   // FSStats.size
  isDir: boolean;
};

type RemoteFs = {
  walk(): Promise<RemoteEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array, mtime: number, ctime: number): Promise<void>;
  rm(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  checkConnect(): Promise<void>;
};
```

`walk()`: `fs.readdir({ path: root, recursive: true })` + `fs.stat()` per entry.
Synthesize folder entries from path segments if SDK omits them.

### `sync()` stages (`src/sync-engine.ts`)

1. Walk local → `Map<path, {mtime, size, ctime}>`
2. Walk remote → `Map<path, RemoteEntry>`
3. Load prevSync from `SyncDb` → `Map<path, SyncedFileRecord>`
4. Ensemble into `Map<path, MixedEntry>`
5. Decide per entry (decision table)
6. Execute with p-queue (concurrency 5)
7. Upsert `SyncDb` after each success

Conflict strategy: write conflict copy of local file before overwriting.
Tie-break: keep_newer (higher mtime wins; ties go to local).

---

## Unresolved questions

1. **mtime round-trip**: does `filen.fs().writeFile()` honour `File.lastModified` as
   the remote mtime, or does it always stamp the upload time? If not preserved,
   every sync sees every file as modified. Must verify before committing to this model.

2. **Bulk listing**: does `readdir({ recursive: true })` return stats (mtime, size) inline,
   or does walk require N separate `stat()` calls? Check if `cloud().listDirectory()`
   returns metadata in one response — critical for large vault performance.

3. **Folder entries**: does `readdir` return folder entries, or only files? Determines
   whether folder entries must be synthesized from file path segments.

4. **Recursive mkdir**: does `filen.fs().mkdir()` create intermediate parents, or only
   one level at a time?

5. **Socket**: `connectToSocket: false` is currently hardcoded. With a live mirror,
   should socket be enabled so remote changes are detected without full-walk polling?
   Cost: persistent network connection, battery impact on mobile.
