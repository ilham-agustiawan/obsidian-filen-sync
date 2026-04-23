# Filen sync architecture

Current design: direct file mirror to Filen.

Filen is used as an opaque remote filesystem. Sync state lives locally in
IndexedDB.

## Data flow

```text
Obsidian vault
  -> SyncEngine
      -> local walk: TFile metadata + content hash when needed
      -> prev-sync records: IndexedDB / localforage
      -> remote walk: Filen folder entries
  -> per-file decision
  -> vault writer or Filen writer
  -> update prev-sync record
```

## Main modules

| Module | Responsibility |
| --- | --- |
| `src/main.ts` | Plugin lifecycle, commands, status bar, views, auth session |
| `src/settings.ts` | Settings validation, saved Filen auth, settings UI |
| `src/fs-remote.ts` | Filen SDK boundary and `RemoteFs` implementation |
| `src/sync-engine.ts` | 3-way compare, conflict copies, push/pull/write logic |
| `src/db.ts` | IndexedDB prev-sync records via `localforage` |
| `src/progress-view.ts` | Sync progress workspace view |
| `src/file-version-modal.ts` | Filen version list/restore/delete UI |

## Remote FS interface

```ts
type RemoteFs = {
  walk(): Promise<RemoteEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array, mtime: number, ctime: number): Promise<void>;
  rm(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  getFileVersions(path: string): Promise<RemoteFileVersion[]>;
  restoreFileVersion(path: string, versionUuid: string): Promise<void>;
  deleteFileVersion(versionUuid: string): Promise<void>;
  checkConnect(): Promise<void>;
  close(): void;
};
```

Filen SDK details stay inside `src/fs-remote.ts`. Sync logic only sees this
interface.

## Remote layout

```text
/Apps/obsidian-filen-sync/default/
  <vault-relative-file-path>
```

Examples:

```text
/Apps/obsidian-filen-sync/default/notes/today.md
/Apps/obsidian-filen-sync/default/assets/photo.jpg
```

## Local state

`SyncDb` stores one `SyncedFileRecord` per path:

```ts
type SyncedFileRecord = {
  path: string;
  mtime: number;
  ctime: number;
  size: number;
  hash?: string;
};
```

Database name is `obsidian-filen-sync-${vaultName}`. Store name is
`synced-files`.

## Sync algorithm

1. Ensure remote root exists.
2. Walk local vault files, skipping plugin data under `.obsidian/plugins/obsidian-filen-sync/`.
3. Walk remote Filen tree, skipping `.obsidian`.
4. Load all prev-sync records from IndexedDB.
5. Merge paths from all three sources.
6. Decide per file from local/remote/prev state.
7. Execute upload, download, delete, skip, or conflict action.
8. Update or delete prev-sync record after success.

Current implementation is sequential. That keeps state updates simple for MVP.

## Conflict behavior

- New on both sides with no baseline: choose newer mtime; count as conflict.
- Changed on both sides: write local conflict copy, then apply newer side.
- Pull mode with both changed: write local conflict copy, then download remote.
- Push mode with both changed: upload local without conflict copy.

Conflict copy format:

```text
note.sync-conflict-<device-id>-<timestamp>.md
```

## Known implementation gap

Delete propagation is incomplete:

| Case | Expected | Current |
| --- | --- | --- |
| local missing, remote equals prev | delete remote | downloads remote in bidirectional |
| remote missing, local equals prev | delete local | uploads local in bidirectional |

Track fix in `TODO.md`.

## Deferred design

- Auto-sync triggers.
- File filters.
- Plugin-level E2EE.
- Chunking/dedup.
- Rename detection.
- Concurrent execution.

## Source refs

- `docs/remotely-save-research.md`: 3-way sync model.
- `docs/filen-sdk-typescript-research.md`: Filen SDK facts.
