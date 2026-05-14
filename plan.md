# Fix plan for unpushed commit review findings

This plan covers the issues found while reviewing the 6 unpushed commits on `master` ahead of `origin/master`.

## Scope

Fix these review findings before pushing:

1. Conflict handling can lose the remote loser when local wins.
2. Delete-vs-modify cases can delete changed data.
3. Version restore may restore only the remote file and leave local content stale.
4. DB migration writes are not awaited.
5. Lint errors block CI/release readiness.

## Validation baseline

Before changing code, keep the current checks as the baseline:

```bash
npm run build
npm run lint
```

Current state:

- `npm run build` passes.
- `npm run lint` fails with 11 errors and 1 warning.

After all fixes, both commands must pass.

---

## 1. Preserve the correct losing side during conflicts

### Problem

`src/sync-engine.ts` currently creates a conflict copy from the local file before applying either winner:

- If remote wins, this is correct because local is the loser.
- If local wins, this is wrong because remote is the loser. The code uploads local over remote and does not preserve the previous remote content locally.

This can lose the remote version in a local-wins conflict.

### Desired behavior

For every conflict, preserve the side that will be overwritten or removed:

- Local wins: download/save the remote content as a conflict copy, then upload local.
- Remote wins: save the current local content as a conflict copy, then download remote.
- Local-only/remote-only first-sync conflict cases should still preserve both sides where applicable.

### Implementation steps

1. Extend conflict planning so `EntrySyncResult` clearly records the conflict winner.
   - Add a field such as:
     ```ts
     conflictWinner?: "local" | "remote";
     ```
   - Set `conflictWinner: "local"` when `plan.hash` is generated because local is newer/wins.
   - Set `conflictWinner: "remote"` when remote is newer/wins.

2. Replace the current single `writeConflictCopy(path)` behavior with two explicit helpers:
   - `writeLocalConflictCopy(path: string): Promise<string | null>`
     - Current behavior: copy existing local file to a conflict path.
   - `writeRemoteConflictCopy(path: string, remote: RemoteEntry): Promise<string>`
     - Read remote bytes with `remote.readFile(path)`.
     - Write them to a conflict path in the vault.
     - Use remote mtime/ctime metadata where possible.

3. Update `applySyncEntry(..., operation: "conflict")`:
   - If both sides exist and `conflictWinner === "local"`:
     1. Write remote conflict copy.
     2. Upload local.
   - If both sides exist and `conflictWinner === "remote"`:
     1. Write local conflict copy.
     2. Download remote.
   - Return `conflictCopyPath` for whichever copy was created.

4. Make conflict-copy filenames identify the source side.
   - Example suffixes:
     - `.sync-conflict-local-<deviceId>-<timestamp>`
     - `.sync-conflict-remote-<deviceId>-<timestamp>`
   - This makes activity logs and user recovery clearer.

5. Update activity detail strings to reflect the preserved loser.
   - Example:
     - `Both changed; local newer (remote conflict copy made)`
     - `Both changed; remote newer (local conflict copy made)`

### Acceptance criteria

- In a both-changed conflict where local is newer, remote bytes are saved into a conflict copy before upload.
- In a both-changed conflict where remote is newer, local bytes are saved into a conflict copy before download.
- Conflict copies are reported in `SyncOutcome.conflictCopies`.
- `npm run build` passes.

---

## 2. Protect delete-vs-modify cases

### Problem

`src/sync-engine.ts` currently interprets this shape too aggressively:

- Local exists, remote missing, previous baseline exists → delete local.
- Remote exists, local missing, previous baseline exists → delete remote.

This is safe only if the remaining side is unchanged since the baseline. If the remaining side changed, it is a delete-vs-modify conflict and should not be deleted automatically.

### Desired behavior

Use the baseline to distinguish these cases:

| State | Interpretation | Action |
| --- | --- | --- |
| Local unchanged, remote missing, prev exists | Remote deleted | Delete local after confirmation |
| Local changed, remote missing, prev exists | Remote deleted, local modified | Conflict, preserve local |
| Remote unchanged, local missing, prev exists | Local deleted | Delete remote |
| Remote changed, local missing, prev exists | Local deleted, remote modified | Conflict, preserve remote |

### Implementation steps

1. In the local-only branch of `planFile`:
   - If `prev` exists, call `detectLocalChange(prev, local)`.
   - If local is unchanged, keep current `delete-local` plan.
   - If local changed, plan a conflict instead of delete:
     ```ts
     {
       operation: "conflict",
       conflicts: 1,
       applied: 1,
       detail: "Remote deleted; local changed (conflict copy made)",
       hash: localChange.hash,
       conflictWinner: "local"
     }
     ```
   - The apply phase can upload local back to remote and/or keep a local conflict copy depending on final policy.

2. In the remote-only branch of `planFile`:
   - If `prev` exists, check whether remote changed from baseline with `sameRemoteRecord(prev, remote)`.
   - If remote is unchanged, keep current `delete-remote` plan.
   - If remote changed, plan a conflict instead of delete:
     ```ts
     {
       operation: "conflict",
       conflicts: 1,
       applied: 1,
       detail: "Local deleted; remote changed (conflict copy made)",
       conflictWinner: "remote"
     }
     ```
   - The apply phase should download remote back to local or save it as a recovery/conflict copy according to the chosen winner.

3. Decide the safest default winner for delete-vs-modify:
   - Recommended default: modified side wins.
   - Reason: deletion may be accidental, and keeping changed content is safer.

4. Ensure local-delete confirmation still applies only to true `delete-local` operations.
   - Delete-vs-modify conflicts must not appear in the local delete confirmation list.

5. Add activity log messages for delete-vs-modify conflicts.
   - Example:
     - `Conflict detected notes/a.md: remote deleted but local changed`
     - `Conflict detected notes/a.md: local deleted but remote changed`

### Acceptance criteria

- A changed local file is never trashed just because the remote copy disappeared.
- A changed remote file is never permanently removed just because the local copy disappeared.
- Delete confirmation remains for true local deletes.
- Conflict count increases for delete-vs-modify cases.
- `npm run build` passes.

---

## 3. Make version restore update local state reliably

### Problem

`src/file-version-modal.ts` restores a selected version on Filen, then calls `onRestored`.

`src/main.ts` currently passes:

```ts
onRestored: () => { this.scheduleAutoSync(0); }
```

If auto-sync is disabled or paused, `scheduleAutoSync(0)` may do nothing. The user can see a successful restore notice while the local note remains unchanged.

### Desired behavior

After restoring a remote version, local content should be updated or the user should be clearly told what still needs to happen.

### Recommended implementation

Prefer immediate manual sync behavior after restore, independent of auto-sync settings.

1. Change the `FileVersionModalConfig.onRestored` type to support async work:
   ```ts
   onRestored: () => Promise<void> | void;
   ```

2. In `restore(...)`, await `onRestored()` after `restoreFileVersion(...)`:
   ```ts
   await this.config.remote.restoreFileVersion(...);
   await this.config.onRestored();
   ```

3. In `src/main.ts`, pass an immediate sync callback:
   ```ts
   onRestored: async () => {
     await this.runSync("Restore sync", { silent: false });
   }
   ```

4. Because `runSync` is private but called inside the class, this is fine.

5. Avoid duplicate notices:
   - Either let the modal show `Restored version...` and make sync silent,
   - Or show one combined notice after sync.
   - Recommended: use `silent: true` for the sync and keep the modal notice specific to restore.

6. Handle sync failure after successful remote restore:
   - If remote restore succeeds but local sync fails, show:
     - `Version restored on Filen, but local sync failed: <message>. Run Sync now.`
   - Do not claim local restore completed if local sync failed.

### Alternative implementation

If full sync after restore is too heavy:

1. Add a new remote method to read the current restored file:
   - `readFile(path)` already exists.
2. After `restoreFileVersion`, read the file bytes with `remote.readFile(filePath)`.
3. Write the bytes directly to the local file.
4. Update the sync DB baseline for that file.

This is more efficient but needs careful DB update plumbing. The immediate sync approach is simpler and safer for this patch.

### Acceptance criteria

- Restoring a version updates the local note even when auto-sync is disabled.
- If local update fails, the user receives a clear warning.
- No misleading success notice is shown for a partially completed restore.
- `npm run build` passes.

---

## 4. Await DB migration writes

### Problem

`src/db.ts` performs async writes inside `localforage.iterate` but intentionally discards the promises:

```ts
void this.store.setItem(key, value);
```

The migration can mark the schema version as updated before all records are actually migrated.

### Desired behavior

All record writes must complete before schema metadata is advanced.

### Implementation steps

1. Collect migration write promises during iteration:
   ```ts
   const writes: Array<Promise<unknown>> = [];
   await this.store.iterate<Record<string, unknown>, void>((value, key) => {
     if (key === META_KEY) return;
     // mutate value
     writes.push(this.store.setItem(key, value));
   });
   await Promise.all(writes);
   ```

2. Only after `Promise.all(writes)` succeeds:
   - Set `_schemaVersion`.
   - Write `META_KEY`.

3. Optionally avoid unnecessary writes:
   - Track `changed = true` only if a record was modified.
   - Push a write only for changed records.

4. If any migration write fails:
   - Let the error throw.
   - Do not update schema metadata.

### Acceptance criteria

- Schema metadata is updated only after all record migrations finish.
- Failed migrations can be retried on next startup.
- `npm run build` passes.

---

## 5. Fix lint errors

Current lint failures from `npm run lint`:

```text
src/activity-logs.ts
  121:8  error  Unexpected confirm  no-alert

src/file-version-modal.ts
  150:25  error  no-static-styles-assignment
  177:54  error  ui/sentence-case

src/fs-remote.ts
  220:18  error  'Buffer' is not defined  no-undef

src/main.ts
  124:10  error  ui/sentence-case
  265:15  error  ui/sentence-case

src/obsidian-axios-adapter.ts
  59:17  error  no-unnecessary-type-assertion

src/onboarding-modal.ts
  30:32  error  ui/sentence-case

src/settings.ts
  192:10  error    ui/sentence-case
  278:13  error    ui/sentence-case
  287:16  warning  no-unused-vars
  303:13  error    ui/sentence-case
```

### Fix steps

#### 5.1 Replace `confirm()` in activity logs

File: `src/activity-logs.ts`

- Replace browser `confirm("Clear activity logs?")` with an Obsidian `Modal` confirmation.
- Reuse the pattern from `ConfirmActionModal` in `src/main.ts`, or create a small local confirmation modal.
- Keep the UI text short:
  - Title: `Clear activity logs?`
  - Body: `This removes recent sync activity from plugin settings.`
  - Confirm button: `Clear logs`

#### 5.2 Remove direct style assignment in version modal

File: `src/file-version-modal.ts`

Current issue:

```ts
rowsEl.style.display = "none";
```

Fix:

- Add/toggle a CSS class instead, e.g. `is-collapsed`.
- CSS:
  ```css
  .filen-sync-version-rows.is-collapsed {
    display: none;
  }
  ```
- Use:
  ```ts
  rowsEl.toggleClass("is-collapsed", !group.expanded);
  ```

#### 5.3 Fix sentence-case UI lint

Files:

- `src/file-version-modal.ts`
- `src/main.ts`
- `src/onboarding-modal.ts`
- `src/settings.ts`

Options:

1. Change visible copy to sentence case where acceptable.
2. For brand/product names that intentionally break sentence-case, add targeted eslint disables on the exact line.

Recommended:

- Keep proper nouns like `Filen`, `Obsidian`, and `Sync` where needed.
- Use targeted comments only where the lint rule is too strict for product names.
- Avoid broad file-level disables.

Likely strings to inspect:

- Ribbon title: `Filen: sync now`
- Settings hero: `Obsidian Filen Sync`
- Connected account strings
- Login/test/sync buttons
- Onboarding title

#### 5.4 Remove `Buffer` type usage in `fs-remote.ts`

File: `src/fs-remote.ts`

Current code:

```ts
const buffers: Buffer[] = [];
```

Fix:

```ts
const buffers: Uint8Array[] = [];
```

The stream reader values are `Uint8Array`, and `out.set(buf, offset)` supports `Uint8Array`.

#### 5.5 Remove unnecessary assertion in axios adapter

File: `src/obsidian-axios-adapter.ts`

Current code around line 59 has an unnecessary assertion. Replace:

```ts
const view = data as ArrayBufferView;
```

with either:

```ts
const view = data;
```

or adjust the type guard so TypeScript narrows naturally.

#### 5.6 Fix unused catch variable

File: `src/settings.ts`

Current warning:

```ts
} catch (error) {
```

If the error is intentionally ignored, change to:

```ts
} catch {
```

### Acceptance criteria

- `npm run lint` passes with zero errors.
- No broad eslint disables are added unless absolutely necessary.
- UI text remains clear and user-facing strings stay sentence case.

---

## 6. Add focused tests or manual test scripts where practical

This project currently relies mostly on build/lint/manual testing. Add lightweight tests only if the existing setup supports them quickly; otherwise document manual scenarios.

### Manual test scenarios

Use a test vault and a test Filen folder.

#### Conflict: both changed, local newer

1. Sync a file successfully.
2. Modify remote copy.
3. Modify local copy with a newer mtime.
4. Run sync.
5. Verify:
   - Local content remains the winner.
   - Remote losing content is saved as a conflict copy in the vault.
   - Activity logs show conflict.

#### Conflict: both changed, remote newer

1. Sync a file successfully.
2. Modify local copy.
3. Modify remote copy with a newer mtime.
4. Run sync.
5. Verify:
   - Remote content is downloaded.
   - Local losing content is saved as a conflict copy.

#### Delete-vs-modify: remote deleted, local changed

1. Sync a file successfully.
2. Delete the remote file.
3. Modify local file.
4. Run sync.
5. Verify:
   - Local file is not trashed.
   - Conflict is reported.
   - Modified local content is preserved.

#### Delete-vs-modify: local deleted, remote changed

1. Sync a file successfully.
2. Delete local file.
3. Modify remote file.
4. Run sync.
5. Verify:
   - Remote file is not permanently deleted.
   - Conflict is reported.
   - Remote content is preserved/restored locally.

#### Version restore with auto-sync disabled

1. Disable auto-sync.
2. Open version history for a file.
3. Restore an older version.
4. Verify:
   - Local note content changes to restored content.
   - Status/activity logs show the restore sync.

#### Migration retry behavior

1. Use a test IndexedDB/localforage store with schema version 0 records.
2. Run plugin startup.
3. Verify all records receive v1 optional fields before meta says schema version 1.

---

## 7. Final verification before push

Run:

```bash
npm run build
npm run lint
git status --short --branch
git log --oneline --decorate origin/master..HEAD
```

Expected:

- Build passes.
- Lint passes.
- Only intended source/style/plan changes are present.
- Commit history is clear.

If desired, squash/fixup the remediation commits before pushing so the branch history remains easy to review.

## Suggested implementation order

1. Fix `Buffer` type and DB migration await issue.
2. Fix conflict-copy loser preservation.
3. Fix delete-vs-modify planning.
4. Fix version restore local update behavior.
5. Fix lint-only UI/style issues.
6. Run build/lint.
7. Manually test the five sync scenarios above.
