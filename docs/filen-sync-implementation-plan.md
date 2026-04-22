# Filen sync implementation plan

Future design for this plugin.

## Recommendation

Use LiveSync's object-storage journal model.

Do not recreate LiveSync's CouchDB path. Filen is not CouchDB-compatible.

Filen should be an opaque remote folder that stores:

```text
_sync_parameters.json
_milestone.json
<timestamp>-<device-id>-<random>-docs.jsonl.gz
```

## Filen SDK facts

Official docs say:

- Package: `@filen/sdk`.
- TypeScript SDK.
- Supports Node.js, browsers, React Native.
- Browser use needs bundler plus Node polyfills.
- Virtual FS supports `mkdir`, `readdir`, `stat`, `readFile`, `writeFile`, upload/download helpers.
- Generated docs recommend `metadataCache: true` and `connectToSocket: true` for virtual FS freshness.
- SDK license is AGPL-3.0. Decide project licensing before adding dependency.

## Target architecture

```text
Obsidian vault
  -> StorageEventQueue
  -> LocalSyncDatabase
      -> EntryManager
      -> ChunkStore
      -> ConflictManager
  -> FilenJournalReplicator
      -> FilenJournalStore
      -> remote control JSON
  -> ReplicationResultProcessor
  -> Obsidian vault writer
```

## Suggested modules

| Module | Responsibility |
| --- | --- |
| `settings` | Validate settings, auth mode, remote root |
| `vault` | Obsidian read/write/stat/list wrapper |
| `local-db` | IndexedDB/PouchDB wrapper |
| `entry` | path ID, metadata, chunk save/load |
| `journal` | JSONL pack/unpack, checkpoints |
| `filen-store` | Filen SDK adapter only |
| `replicator` | sync orchestration |
| `conflict` | detect and resolve conflicts |
| `commands` | sync, rebuild, status, auth |

## Remote store interface

```ts
interface RemoteJournalStore {
  isAvailable(): Promise<boolean>;
  listFiles(after: string, limit?: number): Promise<string[]>;
  uploadFile(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  downloadFile(key: string): Promise<Uint8Array>;
  uploadJson<T>(key: string, value: T): Promise<void>;
  downloadJson<T>(key: string): Promise<T | null>;
  reset(): Promise<void>;
  usage(): Promise<{ estimatedSize?: number }>;
}
```

Conceptual Filen adapter:

```ts
class FilenJournalStore implements RemoteJournalStore {
  constructor(private readonly fsRoot: string, private readonly filen: FilenSDK) {}

  async listFiles(after: string, limit?: number): Promise<string[]> {
    const names = await this.filen.fs().readdir({ path: this.fsRoot });
    return names
      .filter((name) => name > after)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .slice(0, limit);
  }

  async uploadFile(key: string, bytes: Uint8Array): Promise<void> {
    await this.filen.fs().writeFile({
      path: `${this.fsRoot}/${key}`,
      content: Buffer.from(bytes),
    });
  }

  async downloadFile(key: string): Promise<Uint8Array> {
    const content = await this.filen.fs().readFile({ path: `${this.fsRoot}/${key}` });
    return new Uint8Array(content);
  }
}
```

Exact SDK types must be checked during implementation.

## Remote control files

`_sync_parameters.json`:

```ts
type SyncParameters = {
  protocolVersion: number;
  pbkdf2salt: string;
};
```

`_milestone.json`:

```ts
type RemoteMilestone = {
  created: number;
  locked: boolean;
  cleaned?: boolean;
  acceptedNodes: string[];
  nodeInfo: Record<string, {
    deviceName: string;
    vaultName: string;
    pluginVersion: string;
    updatedAt: number;
    progress?: string;
  }>;
};
```

## Local database choice

Use local PouchDB unless proven too heavy.

Pros:

- Revision trees and `revsDiff` solve conflict plumbing.
- IndexedDB adapter fits Obsidian runtime.
- LiveSync proves model works.

Cons:

- More dependency weight.
- Mobile needs early testing.

Avoid direct file mirror to Filen. It loses revision history, conflict fidelity, rename/delete safety, chunk dedupe, and batch semantics.

## MVP scope

Build:

1. Minimal lifecycle and settings tab.
2. Filen auth spike.
3. `FilenJournalStore`.
4. Local DB with metadata docs and whole-file chunks.
5. Manual push command.
6. Manual pull command.
7. DB-to-vault writer.
8. Delete handling.
9. Conflict marker files.

Skip initially:

- Content-defined chunking.
- Continuous background sync.
- Auto-merge.
- Hidden file sync.
- Plugin/theme sync.
- Remote config QR flow.

Whole-file chunking is acceptable for MVP. Add chunk splitting after end-to-end sync works.

## Sync algorithm

Push:

1. Commit pending file events.
2. Read local DB changes since checkpoint.
3. Serialize unsent docs as JSONL.
4. Deflate bytes.
5. Encrypt bytes if plugin E2EE enabled.
6. Upload unique journal file.
7. Save checkpoint.

Pull:

1. List remote journal files after checkpoint.
2. Skip own sent files.
3. Download each file.
4. Decrypt and inflate.
5. Apply chunks first.
6. Apply metadata docs with revision preservation.
7. Queue applied docs for vault write.
8. Save checkpoint.

## Conflict MVP

1. Detect `_conflicts`.
2. If one side deleted and one side edited, keep edited content and mark conflict.
3. If both changed same markdown file, create conflict copy:
   - `note.md`
   - `note.sync-conflict-<device>-<timestamp>.md`
4. Add UI resolution later.

## Encryption plan

Filen already encrypts account data. Still keep plugin E2EE for portability and defense-in-depth.

Rules:

- Do not encrypt `_sync_parameters.json`.
- Derive plugin key from passphrase plus `pbkdf2salt`.
- Encrypt journal files.
- Encrypt `_milestone.json` only if readable device status is not needed.

## Risks

| Risk | Mitigation |
| --- | --- |
| Filen SDK AGPL | Decide license before install |
| Browser polyfills | Spike build first |
| Mobile runtime | Test auth + read/write early |
| Filen listing semantics | Use sortable filenames and checkpoints |
| Filename collision | Include device ID and random suffix |
| Clock skew | Never rely on timestamp for correctness |
| Remote reset | Use `locked`/`cleaned` milestone first |
| Large first sync | Batch journal packs |
| Secret storage | Prefer session material over raw password |

## Implementation order

1. Add Filen SDK spike branch.
2. Verify `npm run build` with SDK bundled.
3. Verify desktop read/write under `/Apps/obsidian-filen-sync/test`.
4. Verify mobile read/write before building sync core.
5. Add `RemoteJournalStore` and `FilenJournalStore`.
6. Add local DB and journal pack/unpack.
7. Add manual push/pull.
8. Add vault writer and delete support.
9. Add conflict marker handling.
10. Add E2EE.
11. Add background triggers.
12. Add chunk splitting.

## Source refs

- Filen SDK getting started: https://docs.filen.io/docs/sdk/getting-started/
- Filen file system docs: https://docs.filen.io/docs/sdk/file-system/
- Filen generated SDK docs: https://sdk-ts-docs.filen.io/
