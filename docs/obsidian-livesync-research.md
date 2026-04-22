# Obsidian LiveSync research

Notes from `vrtmrz/obsidian-livesync`. This doc describes what LiveSync does, not what this plugin should implement.

## Core idea

LiveSync does not sync vault files directly.

It uses this pipeline:

```text
Obsidian vault
  -> file event queue
  -> local PouchDB docs
  -> remote replication or journal transfer
  -> local PouchDB docs on another device
  -> Obsidian vault writer
```

## Main layers

| Layer | LiveSync code | Job |
| --- | --- | --- |
| Plugin shell | `src/main.ts` | Wires services, modules, add-ons, lifecycle |
| Core registry | `src/LiveSyncBaseCore.ts` | Registers modules and binds service handlers |
| Services | `src/lib/src/services/**` | Lifecycle, settings, database, replication, vault, conflict |
| File access | `ServiceFileAccess*`, `FileAccess*` | Abstracts Obsidian vault IO |
| Local DB | `LiveSyncLocalDB` | PouchDB wrapper |
| Managers | `LiveSyncManagers` | Hashing, chunking, entries, conflicts |
| Replicators | CouchDB, journal, P2P | Move DB docs to/from remote |
| Result processor | `ReplicateResultProcessor` | Applies replicated docs to vault |

Important pattern: modules register handlers on service events:

- `fileProcessing.processFileEvent`
- `replication.parseSynchroniseResult`
- `replication.onBeforeReplicate`
- `appLifecycle.onLayoutReady`
- `databaseEvents.onDatabaseInitialised`

## Local change flow

1. Obsidian vault event enters `StorageEventManager`.
2. Event goes to `FileProcessingService`.
3. `ServiceFileHandlerBase._anyHandlerProcessesFileEvent()` handles `CREATE`, `CHANGED`, `DELETE`.
4. `ServiceDatabaseFileAccessBase.__store()` reads bytes and builds a `SavingEntry`.
5. `LiveSyncLocalDB.putDBEntry()` delegates to `EntryManager`.
6. `EntryManager` chunks content, stores chunk docs, then stores metadata doc.
7. `EVENT_FILE_SAVED` can trigger `replication.replicateByEvent()`.

## Remote change flow

1. Replicator receives docs.
2. Replicator calls `replication.parseSynchroniseResult(docs)`.
3. `ModuleReplicator` queues docs into `ReplicateResultProcessor`.
4. `ServiceFileHandlerBase._anyProcessReplicatedDoc()` receives metadata docs.
5. It resolves metadata plus chunks into file content.
6. It writes/deletes Obsidian vault files.
7. It avoids writing conflicted docs unless settings allow it.

## Data model

LiveSync stores note data as PouchDB documents.

Metadata doc:

```ts
type MetadataDoc = {
  _id: string;
  _rev?: string;
  path: string;
  ctime: number;
  mtime: number;
  size: number;
  children: string[];
  type: "newnote" | "plain";
  deleted?: boolean;
  _deleted?: boolean;
};
```

Chunk doc:

```ts
type ChunkDoc = {
  _id: string;
  type: "leaf";
  data: string;
};
```

Control docs:

| Doc | Purpose |
| --- | --- |
| sync parameters | Protocol version, PBKDF2 salt |
| milestone | Remote lock, accepted devices, tweak compatibility |
| node info | Local device node ID |
| version | Compatibility checks |

## CouchDB replication

Original LiveSync mode:

- Local PouchDB syncs with remote CouchDB.
- Continuous replication is possible.
- PouchDB revision trees detect conflicts.
- Pulled docs are passed to `parseSynchroniseResult`.

This path depends on CouchDB/PouchDB replication semantics.

## Object-storage journal replication

LiveSync also has a journal mode for S3/MinIO/R2.

Relevant code:

- `LiveSyncJournalReplicator`
- `JournalSyncAbstract`
- `JournalSyncMinio`

Remote layout:

```text
_obsidian_livesync_journal_sync_parameters.json
_00000000-milestone.json
1712345678900-docs.jsonl.gz
```

Send path:

1. Read local PouchDB changes since checkpoint.
2. Fetch exact changed revisions via `bulkGet`.
3. Skip already-known doc/rev keys.
4. Serialize docs as JSONL.
5. Compress with deflate.
6. Encrypt if E2EE enabled.
7. Upload journal file.
8. Save checkpoint: last local seq, sent doc keys, sent files.

Receive path:

1. List remote journal files after last received file.
2. Skip own sent files.
3. Download, decrypt, inflate.
4. Parse JSONL records.
5. Store chunks first.
6. Use `revsDiff` and `bulkDocs(..., { new_edits: false })` for metadata docs.
7. Call `parseSynchroniseResult` for applied docs.
8. Save checkpoint: known doc keys, received files.

Checkpoint shape:

```ts
type Checkpoint = {
  lastLocalSeq: number | string;
  journalEpoch: string;
  knownIDs: Set<string>;
  sentIDs: Set<string>;
  receivedFiles: Set<string>;
  sentFiles: Set<string>;
};
```

Doc key rule:

- Chunk doc: `_id`
- Metadata doc: `_id + "-" + _rev`

## Conflict handling

LiveSync relies on PouchDB revision trees.

- Concurrent edits create conflicting metadata revisions.
- Chunk docs dedupe by content hash.
- Conflict UI can compare current rev and conflicted rev.
- Resolution deletes losing rev or writes merged content as new rev.

Auto-merge:

- Line merge for sensible text files.
- Object/JSON merge for settings-like files.
- User resolution when same line/key changed differently.

## Sources

- LiveSync repo: https://github.com/vrtmrz/obsidian-livesync
- LiveSync docs inspected: `docs/tech_info.md`, `docs/datastructure.md`
- LiveSync files inspected:
  - `src/main.ts`
  - `src/LiveSyncBaseCore.ts`
  - `src/lib/src/pouchdb/LiveSyncLocalDB.ts`
  - `src/lib/src/replication/LiveSyncAbstractReplicator.ts`
  - `src/lib/src/replication/couchdb/LiveSyncReplicator.ts`
  - `src/lib/src/replication/journal/LiveSyncJournalReplicator.ts`
  - `src/lib/src/replication/journal/JournalSyncAbstract.ts`
  - `src/lib/src/replication/journal/objectstore/JournalSyncMinio.ts`
  - `src/lib/src/serviceModules/ServiceFileHandlerBase.ts`
