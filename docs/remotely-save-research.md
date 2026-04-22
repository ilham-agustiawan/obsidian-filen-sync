# remotely-save: Research Notes

Reference for rebuilding the sync engine with filen.io as the cloud backend.

Source studied: [`remotely-save/remotely-save`](https://github.com/remotely-save/remotely-save)

---

## Mental Model

Sync is solved as a **three-state problem**:

```
LOCAL (current vault) ↔ PREV_SYNC (last synced state, in IndexedDB) ↔ REMOTE (cloud)
```

By comparing each file across all three states, the engine knows exactly what changed and where:

| local vs prev | remote vs prev | Decision |
|---|---|---|
| same | same | no-op |
| changed | same | push local → remote |
| same | changed | pull remote → local |
| missing | same | delete from remote |
| same | missing | delete from local |
| changed | changed | **conflict** → resolve by strategy |
| new | new | conflict |

---

## Core Abstraction: `FakeFs` (`src/fsAll.ts`)

Every storage backend extends this abstract class. All cloud providers and the local vault use the same interface.

```typescript
abstract class FakeFs {
  abstract kind: string;

  // List ALL files/folders recursively. Called once per sync.
  abstract walk(): Promise<Entity[]>;

  // Get metadata for a single path.
  abstract stat(key: string): Promise<Entity>;

  // Create a folder (key must end with "/").
  abstract mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity>;

  // Write binary file content with explicit timestamps.
  abstract writeFile(key: string, content: ArrayBuffer, mtime: number, ctime: number): Promise<Entity>;

  // Download file as raw bytes.
  abstract readFile(key: string): Promise<ArrayBuffer>;

  // Move/rename a file or folder.
  abstract rename(key1: string, key2: string): Promise<void>;

  // Delete a file or folder.
  abstract rm(key: string): Promise<void>;

  // Verify credentials work.
  // Default impl (checkConnectCommonOps) creates/writes/reads/deletes a test file.
  abstract checkConnect(callbackFunc?: any): Promise<boolean>;

  abstract getUserDisplayName(): Promise<string>;
  abstract revokeAuth(): Promise<any>;
  abstract allowEmptyFile(): boolean;
}
```

### Path conventions

- Folders: trailing slash — `"notes/"`, `"notes/subdir/"`
- Files: no trailing slash — `"notes/daily.md"`
- No leading slash
- Forward slashes always (Obsidian normalizes this)
- All timestamps are **milliseconds** since Unix epoch

---

## Key Data Type: `Entity` (`src/baseTypes.ts`)

Represents a single file or folder at a point in time.

```typescript
interface Entity {
  keyRaw: string;        // Unencrypted path (always present)
  key?: string;          // May differ from keyRaw when encryption is on

  mtimeCli?: number;     // Client-side modification time (ms)
  ctimeCli?: number;     // Client-side creation time (ms)
  mtimeSvr?: number;     // Server-side modification time (ms)

  prevSyncTime?: number; // When this file was last synced (populated from DB)

  sizeRaw: number;       // Actual byte size
  sizeEnc?: number;      // Encrypted byte size (larger due to overhead)

  etag?: string;         // Version/hash identifier (optional)
  hash?: string;

  synthesizedFolder?: boolean; // Inferred from file paths, not returned by API
}
```

For a filen.io adapter:
- `mtimeSvr` = filen's `lastModified` in milliseconds
- `sizeRaw` = file size in bytes
- `etag`/`hash` = filen's UUID or content hash if available

---

## Local Filesystem Adapter: `FakeFsLocal` (`src/fsLocal.ts`)

Wraps Obsidian's `Vault` API.

```typescript
constructor(
  vault: Vault,
  syncConfigDir: boolean,      // include .obsidian/
  syncBookmarks: boolean,
  configDir: string,           // ".obsidian"
  pluginID: string,
  profiler: Profiler | undefined,
  deleteToWhere: "obsidian" | "system"
)
```

Key behaviours:
- `walk()` uses `vault.getAllLoadedFiles()` — returns `TFile` and `TFolder`
- Folders get a trailing `/` appended to their path
- `writeFile()` calls `vault.adapter.writeBinary(key, content, { mtime, ctime })`
- `rm()` calls `vault.adapter.trashLocal()` or `vault.adapter.trashSystem()`
- Skips paths starting with `_debug_remotely_save/`

---

## Sync Algorithm (Decision Engine)

Located in `pro/src/sync.ts` (proprietary module, not public). Runs in stages:

### Stage 1 — Walk

```typescript
const localFiles  = await fsLocal.walk();
const remoteFiles = await fsRemote.walk();
const prevSync    = await db.getAllPrevSyncRecords(vaultID, profileID);
```

### Stage 2 — Ensemble

Merge all three lists into `Map<string, MixedEntity>`:

```typescript
interface MixedEntity {
  key: string;
  local?: Entity;    // undefined = file not on local
  remote?: Entity;   // undefined = file not on remote
  prevSync?: Entity; // undefined = never synced before
  decision?: DecisionType;
}
```

### Stage 3 — Decide

For each `MixedEntity`:

```
localEqualPrev  = (local.mtime == prevSync.mtime && local.size == prevSync.size)
remoteEqualPrev = (remote.mtime == prevSync.mtime && remote.size == prevSync.size)
```

Full decision table (files):

| Condition | Decision |
|---|---|
| all three equal / sizes match | `equal` |
| local≠prev, remote=prev | `local_is_modified_then_push` |
| local=prev, remote≠prev | `remote_is_modified_then_pull` |
| local exists, no prev, no remote | `local_is_created_then_push` |
| remote exists, no prev, no local | `remote_is_created_then_pull` |
| no local, no prev, remote exists | `remote_is_created_then_pull` |
| local missing, remote=prev | `local_is_deleted_thus_also_delete_remote` |
| remote missing, local=prev | `remote_is_deleted_thus_also_delete_local` |
| local≠prev AND remote≠prev | `conflict_modified_then_*` |
| local new AND remote new | `conflict_created_then_*` |
| exceeds `skipSizeLargerThan` | `*_too_large_then_do_nothing` |

Folder decisions use the same logic with `folder_` prefixed variants.

### Stage 4 — Execute

| Decision | Operations |
|---|---|
| push | `remote.writeFile(key, await local.readFile(key), mtime, ctime)` |
| pull | `local.writeFile(key, await remote.readFile(key), mtime, ctime)` |
| delete remote | `remote.rm(key)` |
| delete local | `local.rm(key)` |
| mkdir remote | `remote.mkdir(key)` |
| mkdir local | `local.mkdir(key)` |
| equal / skip | nothing |

Concurrency: default 5 parallel operations via `p-queue`.

### Stage 5 — Update DB

After each successful operation, upsert the `prevSync` record with the new `Entity`, so the next sync has an accurate baseline.

---

## Conflict Resolution

```typescript
type ConflictActionType = "keep_newer" | "keep_larger" | "smart_conflict"
```

- **keep_newer**: Use file with the later `mtime`. Ties go to local.
- **keep_larger**: Use file with more bytes (`sizeRaw`).
- **smart_conflict**: Attempt 3-way text merge (markdown only). Falls back to `keep_newer` on failure.

---

## Sync Direction

```typescript
type SyncDirectionType =
  | "bidirectional"
  | "incremental_pull_only"
  | "incremental_push_only"
  | "incremental_pull_and_delete_only"
  | "incremental_push_and_delete_only"
```

Pull-only: local changes are ignored. Push-only: remote changes are ignored.

---

## Local State Database (`src/localdb.ts`)

Uses **IndexedDB** via `localforage`. Database name: `"remotelysavedb"`.

### Prev-sync records (core table)

Key format: `${vaultRandomID}\t${profileID}\t${filePath}`  
Value: `Entity` snapshot from last successful sync

```typescript
// Load at sync start
const prev = await getAllPrevSyncRecordsByVaultAndProfile(db, vaultID, profileID);

// Save after each successful file operation
await upsertPrevSyncRecordByVaultAndProfile(db, vaultID, profileID, entityAfterSync);
```

### Other tables

| Table | Purpose |
|---|---|
| `vaultRandomIDMappingTbl` | Maps vault path ↔ nanoid (multi-vault support) |
| `syncPlanRecordTbl` | Last 20 sync decision logs (debug) |
| `lastSuccessSyncTimeTbl` | Timestamp of last clean sync |
| `lastFailedSyncTimeTbl` | Timestamp of last failed sync |
| `pluginVersionTbl` | Detect upgrades, trigger migrations |

---

## Plugin Lifecycle (`src/main.ts`)

```
onload()
 ├─ loadSettings()
 ├─ prepareDBs()              — init IndexedDB, generate/load vaultRandomID
 ├─ addRibbonIcon()           — manual sync trigger
 ├─ addStatusBarItem()        — last sync time display
 ├─ addCommand("start-sync")  — command palette trigger
 ├─ addCommand("start-sync-dry-run")
 ├─ addSettingTab()           — settings UI
 └─ setup auto triggers:
     ├─ enableAutoSyncIfSet()    → setInterval(syncRun, intervalMs)
     ├─ enableInitSyncIfSet()    → setTimeout(syncRun, delayMs)
     └─ toggleSyncOnSaveIfSet()  → vault.on("modify"/"create"/"delete"/"rename")
                                    → syncRun (throttled, 3s)
```

### `syncRun(triggerSource)`

```typescript
type SyncTriggerSourceType = "manual" | "dry" | "auto" | "auto_once_init" | "auto_sync_on_save"
```

1. Guard: if `isSyncing === true`, abort.
2. Create `fsLocal` (Obsidian vault).
3. Create `fsRemote` (cloud adapter).
4. Optionally wrap `fsRemote` in `fsEncrypt` if password is set.
5. Call `syncer(fsLocal, fsRemote, db, settings, callbacks)`.
6. On completion: update status bar, emit `SYNC_DONE` event.

---

## File Path Filtering

Two modes (mutually exclusive):

- **Block list** (`ignorePaths: string[]`): regex patterns; matching paths are skipped.
- **Allow list** (`onlyAllowPaths: string[]`): if non-empty, only matching paths are synced.

Extra flags:
- `syncConfigDir: boolean` — include `.obsidian/`
- `syncUnderscoreItems: boolean` — include files starting with `_`

Inheritance rule: if a folder is skipped, all its children are skipped. If a child matches the allow list, its parents are un-skipped.

---

## Settings Structure (relevant subset)

```typescript
interface RemotelySavePluginSettings {
  serviceType: string;              // which provider is active

  autoRunEveryMilliseconds: number; // 0 = disabled
  initRunAfterMilliseconds: number; // delay before first sync on startup
  syncOnSaveAfterMilliseconds: number; // delay after file change

  concurrency: number;              // default 5
  skipSizeLargerThan: number;       // -1 = unlimited

  ignorePaths: string[];
  onlyAllowPaths: string[];

  syncConfigDir: boolean;
  syncUnderscoreItems: boolean;

  conflictAction: ConflictActionType;
  syncDirection: SyncDirectionType;

  deleteToWhere: "system" | "obsidian";

  password: string;                 // encryption password (empty = no encryption)
}
```

---

## Filen.io Adapter: What to Implement

Create `src/fsFilen.ts` extending `FakeFs`:

```typescript
import FilenSDK from "@filen/sdk";
import { FakeFs } from "./fsAll";
import type { Entity } from "./baseTypes";

export interface FilenConfig {
  email: string;
  password: string;         // Used by SDK to derive keys
  syncFolderPath: string;   // Remote folder, e.g. "/Obsidian/MyVault"
}

export class FakeFsFilen extends FakeFs {
  kind = "filen" as const;
  private sdk: FilenSDK;
  private config: FilenConfig;

  constructor(config: FilenConfig) {
    super();
    this.sdk = new FilenSDK({ email: config.email, password: config.password });
    this.config = config;
  }

  async walk(): Promise<Entity[]> { /* ... */ }
  async stat(key: string): Promise<Entity> { /* ... */ }
  async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> { /* ... */ }
  async writeFile(key: string, content: ArrayBuffer, mtime: number, ctime: number): Promise<Entity> { /* ... */ }
  async readFile(key: string): Promise<ArrayBuffer> { /* ... */ }
  async rename(key1: string, key2: string): Promise<void> { /* ... */ }
  async rm(key: string): Promise<void> { /* ... */ }
  async checkConnect(): Promise<boolean> { return this.checkConnectCommonOps(); }
  async getUserDisplayName(): Promise<string> { /* ... */ }
  async revokeAuth(): Promise<any> {}
  allowEmptyFile(): boolean { return true; }
}
```

### `walk()` — hardest method

Must return a flat `Entity[]` where:
- Every file: `{ keyRaw: "folder/sub/file.md", sizeRaw: 1234, mtimeSvr: 1700000000000 }`
- Every folder: `{ keyRaw: "folder/", sizeRaw: 0, mtimeSvr: ... }`

If the Filen SDK doesn't return explicit folder entries, synthesize them by collecting unique parent paths from file keys.

### `writeFile()` — timestamps matter

The caller passes `mtime`/`ctime` from the source file. These must be set on the remote object so that next sync's comparison is accurate. If Filen's API doesn't support setting timestamps natively, store them in a metadata sidecar or use Filen's custom metadata field.

---

## Full Sync Flow

```
User triggers sync (ribbon / command / auto / on-save)
│
├─ isSyncing guard
│
├─ fsLocal.walk()    → vault files/folders
├─ fsFilen.walk()    → remote files/folders under syncFolderPath
├─ db.getPrevSync()  → last synced state
│
├─ ensemble()  → Map<path, MixedEntity>
├─ filter()    → remove ignored paths
│
├─ for each MixedEntity:
│   └─ compare (local, prevSync, remote) → assign Decision
│
├─ execute() with concurrency=5:
│   ├─ push:          fsFilen.writeFile(key, await fsLocal.readFile(key), mtime, ctime)
│   ├─ pull:          fsLocal.writeFile(key, await fsFilen.readFile(key), mtime, ctime)
│   ├─ delete remote: fsFilen.rm(key)
│   ├─ delete local:  fsLocal.rm(key)
│   └─ mkdir:         fsFilen.mkdir(key) or fsLocal.mkdir(key)
│
├─ db.upsertPrevSync() for each completed file
└─ update status bar, emit SYNC_DONE
```

---

## What to Copy vs. Rewrite

| File | Action | Notes |
|---|---|---|
| `fsAll.ts` | Copy | Abstract base class, provider-agnostic |
| `fsLocal.ts` | Copy | Obsidian vault adapter works as-is |
| `baseTypes.ts` | Copy + trim | Keep `Entity`, decision types; remove S3/Dropbox refs |
| `localdb.ts` | Copy + trim | Keep prev-sync logic; remove multi-provider noise |
| `misc.ts` | Copy + trim | Path utilities are fully generic |
| `pro/src/sync.ts` | **Reimplement** | Proprietary — not in public repo; rewrite from decision table above |
| `fsFilen.ts` | **Write new** | Our core contribution |
| `main.ts` | **Write new** | Simpler lifecycle; no OAuth/Dropbox complexity |
| `settings.ts` | **Write new** | Only filen config fields |

---

## Suggested File Structure

```
src/
  main.ts          # Plugin lifecycle only
  settings.ts      # FilenConfig + plugin settings + defaults
  baseTypes.ts     # Entity, DecisionType, shared interfaces
  fsAll.ts         # Abstract FakeFs base class
  fsLocal.ts       # Obsidian vault adapter
  fsFilen.ts       # Filen.io adapter
  sync/
    engine.ts      # Decision algorithm: ensemble → plan → execute
    decisions.ts   # Decision type definitions + decision table logic
  db/
    index.ts       # IndexedDB wrapper (localforage)
    prevSync.ts    # Prev-sync record CRUD
  misc.ts          # Path utilities
```

---

## Dependencies to Add

```json
{
  "@filen/sdk": "latest",
  "localforage": "^1",
  "p-queue": "^8",
  "nanoid": "^5"
}
```
