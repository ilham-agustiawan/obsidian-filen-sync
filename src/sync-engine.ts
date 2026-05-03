import { App, TAbstractFile, TFile, normalizePath } from "obsidian";
import { createSyncPathFilter, type SyncPathFilter } from "./path-filters";
import type { SyncDb } from "./db";
import type { RemoteEntry, RemoteFs } from "./fs-remote";
import type { SyncedFileRecord } from "./settings";
import type { SyncJournal } from "./sync-journal";

type SyncEngineConfig = {
	app: App;
	db: SyncDb;
	pluginId: string;
	settings: {
		deviceId: string;
		vaultName: string;
		ignorePatterns: string[];
	};
	remote: RemoteFs;
	journal: SyncJournal;
};

type SyncResult = {
	applied: number;
	conflicts: number;
};

type EntrySyncResult = SyncResult & {
	detail: string;
	operation: SyncOperation;
	/** Pre-computed SHA-256 hash (for upload operations). */
	hash?: string;
};

export type SyncMode = "bidirectional" | "push-local" | "pull-remote";

export type SyncOperation = "scan" | "upload" | "download" | "delete-local" | "delete-remote" | "conflict" | "noop";

export type SyncPlanEntry = {
	path: string;
	operation: SyncOperation;
	detail: string;
};

export type SyncPlanPreview = {
	mode: SyncMode;
	entries: SyncPlanEntry[];
	summary: {
		uploads: number;
		downloads: number;
		localDeletes: number;
		remoteDeletes: number;
		conflicts: number;
		skipped: number;
		total: number;
	};
};

export type SyncProgress = {
	current: number;
	total: number;
	path: string;
	phase: "scan" | "sync";
	state: "queued" | "active" | "done" | "failed" | "skipped";
	operation: SyncOperation;
	detail: string;
	at: number;
};

type MixedEntry = {
	path: string;
	local?: LocalEntry;
	remote?: RemoteEntry;
	prev?: SyncedFileRecord;
};

type LocalEntry = {
	path: string;
	mtime: number;
	ctime: number;
	size: number;
	file: TAbstractFile;
};

type PrevRecord = {
	path: string;
	mtime: number;
	ctime: number;
	size: number;
	hash?: string;
	remoteUuid?: string;
	lastSyncAt?: number;
	lastKnownSide?: "local" | "remote" | "both";
};

export class SyncEngine {
	constructor(private readonly config: SyncEngineConfig) {}

	get remote(): RemoteFs {
		return this.config.remote;
	}

	close(): void {
		this.config.remote.close();
	}

	async ensureRemote(): Promise<void> {
		await this.config.remote.mkdir("");
	}

	async testRemote(): Promise<void> {
		await this.config.remote.checkConnect();
	}

	async sync(
		mode: SyncMode = "bidirectional",
		onProgress?: (progress: SyncProgress) => void,
	): Promise<SyncResult> {
		await this.ensureRemote();
		const pathFilter = createSyncPathFilter({
			configDir: this.config.app.vault.configDir,
			pluginId: this.config.pluginId,
			ignorePatterns: this.config.settings.ignorePatterns,
		});
		onProgress?.(scanProgress(1, "Vault and Filen", "Scanning vault and Filen"));
		const [local, remote, prevRecords] = await Promise.all([
			this.walkLocal(pathFilter),
			this.walkRemote(pathFilter),
			this.config.db.getAllFiles(),
		]);
		const prev = filterPrevRecords(prevRecords, pathFilter);
		onProgress?.(scanProgress(2, "Sync database", "Reading previous sync state"));
		const entries = this.ensemble(local, remote, prev);
		onProgress?.(scanProgress(
			3,
			"Change plan",
			prev.size === 0 ? "Initial sync: preparing files" : "Sync: preparing changes",
		));

		// Start a journal batch for crash recovery
		const batchId = await this.config.journal.startBatch(
			mode === "bidirectional" ? "Sync" : mode === "push-local" ? "Push" : "Pull",
		);

		let applied = 0;
		let conflicts = 0;
		const total = entries.length;

		try {
			for (const [index, entry] of entries.entries()) {
				onProgress?.({
					current: index + 1,
					total,
					path: entry.path,
					phase: "sync",
					state: "queued",
					operation: "noop",
					detail: syncModeDetail(mode),
					at: Date.now(),
				});
				onProgress?.({
					current: index + 1,
					total,
					path: entry.path,
					phase: "sync",
					state: "active",
					operation: "noop",
					detail: "Checking changes",
					at: Date.now(),
				});

				// Plan the operation first (for journaling)
				const planEntry = await this.syncEntry(entry, mode);
				const journalEntryId = await this.config.journal.logPending({
					batchId,
					path: entry.path,
					operation: planEntry.operation,
					detail: planEntry.detail,
				});

				let result: EntrySyncResult;
				try {
					result = await this.applySyncEntry(entry, mode, planEntry);
					await this.config.journal.markApplied(journalEntryId);
				} catch (err) {
					onProgress?.({
						current: index + 1,
						total,
						path: entry.path,
						phase: "sync",
						state: "failed",
						operation: planEntry.operation,
						detail: err instanceof Error ? err.message : "Sync failed",
						at: Date.now(),
					});
					throw err;
				}
				applied += result.applied;
				conflicts += result.conflicts;
				onProgress?.({
					current: index + 1,
					total,
					path: entry.path,
					phase: "sync",
					state: result.applied > 0 || result.conflicts > 0 ? "done" : "skipped",
					operation: result.operation,
					detail: result.detail,
					at: Date.now(),
				});
			}

			await this.config.journal.completeBatch(batchId);
			return { applied, conflicts };
		} catch (err) {
			// Leave batch in-progress so crash recovery can detect it
			console.error("Obsidian Filen Sync: sync batch interrupted", err);
			throw err;
		}
	}

	private async walkLocal(pathFilter: SyncPathFilter): Promise<Map<string, LocalEntry>> {
		const entries = new Map<string, LocalEntry>();
		for (const file of this.config.app.vault.getAllLoadedFiles()) {
			if (pathFilter.isIgnored(file.path)) {
				continue;
			}

			if (file instanceof TFile) {
				entries.set(file.path, {
					path: file.path,
					mtime: file.stat.mtime,
					ctime: file.stat.ctime,
					size: file.stat.size,
					file,
				});
			}
		}

		return entries;
	}

	private async walkRemote(pathFilter: SyncPathFilter): Promise<Map<string, RemoteEntry>> {
		const entries = new Map<string, RemoteEntry>();
		for (const entry of await this.config.remote.walk()) {
			if (pathFilter.isIgnored(entry.path)) {
				continue;
			}

			if (entry.isDir) {
				continue;
			}

			entries.set(entry.path, entry);
		}

		return entries;
	}

	private ensemble(
		local: Map<string, LocalEntry>,
		remote: Map<string, RemoteEntry>,
		prev: Map<string, SyncedFileRecord>,
	): MixedEntry[] {
		const paths = new Set<string>([...local.keys(), ...remote.keys(), ...prev.keys()]);
		return [...paths].sort().map((path) => ({
			path,
			local: local.get(path),
			remote: remote.get(path),
			prev: prev.get(path),
		}));
	}

	private async syncEntry(entry: MixedEntry, mode: SyncMode): Promise<EntrySyncResult> {
		return this.planFile(entry, mode);
	}

	/**
	 * Plan what to do with a file entry. Returns the planned operation
	 * WITHOUT applying any changes.
	 */
	private async planFile(entry: MixedEntry, mode: SyncMode): Promise<EntrySyncResult> {
		const local = entry.local;
		const remote = entry.remote;
		const prev = entry.prev;

		if (local === undefined && remote === undefined) {
			return skipped("Missing on both sides");
		}

		if (local !== undefined && remote === undefined) {
			if (mode === "pull-remote") {
				if (prev !== undefined) {
					return { applied: 1, conflicts: 0, detail: "Deleted local file", operation: "delete-local" };
				}
				return skipped("Local-only file ignored");
			}

			if (mode === "bidirectional" && prev !== undefined) {
				return { applied: 1, conflicts: 0, detail: "Deleted local file", operation: "delete-local" };
			}

			const hash = await this.hashLocal(local);
			return { applied: 1, conflicts: 0, detail: "Uploaded local change", operation: "upload", hash };
		}

		if (local === undefined && remote !== undefined) {
			if (mode === "push-local") {
				if (prev === undefined) {
					return skipped("Remote-only file ignored");
				}
				return { applied: 1, conflicts: 0, detail: "Deleted remote file", operation: "delete-remote" };
			}

			if (mode === "bidirectional" && prev !== undefined) {
				return { applied: 1, conflicts: 0, detail: "Deleted remote file", operation: "delete-remote" };
			}

			return { applied: 1, conflicts: 0, detail: "Downloaded remote change", operation: "download" };
		}

		if (local === undefined || remote === undefined) {
			return skipped("File unavailable");
		}

		if (prev === undefined) {
			if (mode === "push-local") {
				const hash = await this.hashLocal(local);
				return { applied: 1, conflicts: 0, detail: "Uploaded local file", operation: "upload", hash };
			}

			if (mode === "pull-remote") {
				return { applied: 1, conflicts: 0, detail: "Downloaded remote file", operation: "download" };
			}

			const newer = chooseNewer(local, remote);
			if (newer === "local") {
				const hash = await this.hashLocal(local);
				return { applied: 1, conflicts: 1, detail: "No baseline; chose newer file", operation: "conflict", hash };
			} else {
				return { applied: 1, conflicts: 1, detail: "No baseline; chose newer file", operation: "conflict" };
			}
		}

		const localChange = await this.detectLocalChange(prev, local);
		const remoteChanged = !sameRemoteRecord(prev, remote);
		const localChanged = localChange.changed;

		if (!localChanged && !remoteChanged) {
			return skipped("Unchanged");
		}

		if (mode === "push-local" && !localChanged) {
			return skipped(remoteChanged ? "Remote-only change ignored" : "Unchanged");
		}

		if (mode === "pull-remote" && !remoteChanged) {
			return skipped(localChanged ? "Local-only change ignored" : "Unchanged");
		}

		if (localChanged && !remoteChanged) {
			if (mode === "pull-remote") {
				return skipped("Local-only change ignored");
			}
			return { applied: 1, conflicts: 0, detail: "Uploaded local change", operation: "upload", hash: localChange.hash };
		}

		if (!localChanged && remoteChanged) {
			if (mode === "push-local") {
				return skipped("Remote-only change ignored");
			}
			return { applied: 1, conflicts: 0, detail: "Downloaded remote change", operation: "download" };
		}

		if (mode === "push-local") {
			return { applied: 1, conflicts: 0, detail: "Uploaded local change", operation: "upload", hash: localChange.hash };
		}

		if (mode === "pull-remote") {
			return { applied: 1, conflicts: 1, detail: "Conflict copy kept; downloaded remote", operation: "conflict" };
		}

		const newer = chooseNewer(local, remote);
		if (newer === "local") {
			return { applied: 1, conflicts: 1, detail: "Conflict copy kept; uploaded local", operation: "conflict", hash: localChange.hash };
		}
		return { applied: 1, conflicts: 1, detail: "Conflict copy kept; downloaded remote", operation: "conflict" };
	}

	/**
	 * Apply a planned sync operation. Performs the actual I/O.
	 */
	private async applySyncEntry(entry: MixedEntry, _mode: SyncMode, plan: EntrySyncResult): Promise<EntrySyncResult> {
		const local = entry.local;
		const remote = entry.remote;
		const prev = entry.prev;

		// Handle delete-local
		if (plan.operation === "delete-local") {
			if (prev !== undefined) {
				await this.config.db.deleteFile(entry.path);
			}
			await this.deleteLocal(entry.path);
			return plan;
		}

		// Handle delete-remote
		if (plan.operation === "delete-remote") {
			await this.config.remote.rm(entry.path);
			if (prev !== undefined) {
				await this.config.db.deleteFile(entry.path);
			}
			return plan;
		}

		// Handle upload (only if local exists)
		if (plan.operation === "upload" && local !== undefined) {
			const hash = plan.hash ?? await this.hashLocal(local);
			await this.pushLocal(entry.path, local, hash);
			return plan;
		}

		// Handle download (only if remote exists)
		if (plan.operation === "download" && remote !== undefined) {
			await this.pullRemote(entry.path, remote);
			return plan;
		}

		// Handle conflict (both sides exist, we need to apply the chosen side)
		if (plan.operation === "conflict") {
			if (local !== undefined && remote !== undefined) {
				await this.writeConflictCopy(local.path);
				const newer = chooseNewer(local, remote);
				if ((newer === "local" && plan.detail.includes("uploaded")) || plan.hash !== undefined) {
					const hash = plan.hash ?? await this.hashLocal(local);
					await this.pushLocal(entry.path, local, hash);
				} else if (remote !== undefined) {
					await this.pullRemote(entry.path, remote);
				}
			} else if (local !== undefined && remote === undefined) {
				// No baseline conflict: upload local
				const hash = plan.hash ?? await this.hashLocal(local);
				await this.pushLocal(entry.path, local, hash);
			} else if (local === undefined && remote !== undefined) {
				await this.pullRemote(entry.path, remote);
			}
			return plan;
		}

		// Handle skipped (noop) - cleanup db for files missing on both sides
		if (plan.operation === "noop" && prev !== undefined && local === undefined && remote === undefined) {
			await this.config.db.deleteFile(entry.path);
		}

		return plan;
	}

	private async pushLocal(path: string, local: LocalEntry, hash: string): Promise<void> {
		const content = await this.config.app.vault.readBinary(this.asFile(local.file));
		await this.config.remote.writeFile(
			path,
			content instanceof Uint8Array ? content : new Uint8Array(content),
			local.mtime,
			local.ctime,
		);
		await this.upsertPrev({
			path: local.path,
			mtime: local.mtime,
			ctime: local.ctime,
			size: local.size,
			hash,
			lastSyncAt: Date.now(),
			lastKnownSide: "local",
		});
	}

	private async pullRemote(path: string, remote: RemoteEntry): Promise<void> {
		const content = await this.config.remote.readFile(path);
		const hash = await sha256Hex(content);
		await ensureLocalFolder(this.config.app, path);
		await this.config.app.vault.adapter.writeBinary(
			normalizePath(path),
			content,
			{ mtime: remote.mtime, ctime: remote.mtime },
		);
		await this.upsertPrev({
			path,
			mtime: remote.mtime,
			ctime: remote.mtime,
			size: remote.size,
			hash,
			lastSyncAt: Date.now(),
			lastKnownSide: "remote",
		});
	}

	private async detectLocalChange(
		prev: SyncedFileRecord,
		local: LocalEntry,
	): Promise<{ changed: boolean; hash: string }> {
		if (sameFileRecord(prev, local) && prev.hash !== undefined) {
			return { changed: false, hash: prev.hash };
		}

		const hash = await this.hashLocal(local);
		if (sameFileRecord(prev, local)) {
			await this.upsertPrev({
				path: local.path,
				mtime: local.mtime,
				ctime: local.ctime,
				size: local.size,
				hash,
			});
			return { changed: false, hash };
		}

		if (prev.hash !== undefined && prev.hash === hash) {
			await this.upsertPrev({
				path: local.path,
				mtime: local.mtime,
				ctime: local.ctime,
				size: local.size,
				hash,
			});
			return { changed: false, hash };
		}

		return { changed: !sameFileRecord(prev, local), hash };
	}

	private async hashLocal(local: LocalEntry): Promise<string> {
		const content = await this.config.app.vault.readBinary(this.asFile(local.file));
		return sha256Hex(content instanceof Uint8Array ? content : new Uint8Array(content));
	}

	private async writeConflictCopy(path: string): Promise<void> {
		const file = this.config.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			return;
		}

		const conflictPath = conflictCopyPath(file.path, this.config.settings.deviceId, Date.now());
		const content = await this.config.app.vault.readBinary(file);
		await ensureLocalFolder(this.config.app, conflictPath);
		await this.config.app.vault.adapter.writeBinary(conflictPath, content, {
			mtime: file.stat.mtime,
			ctime: file.stat.ctime,
		});
	}

	private async deleteLocal(path: string): Promise<void> {
		const file = this.config.app.vault.getAbstractFileByPath(normalizePath(path));
		if (file === null) return;
		await this.config.app.fileManager.trashFile(file);
	}

	private async upsertPrev(record: PrevRecord): Promise<void> {
		// Preserve existing remoteUuid if not provided
		const existing = await this.config.db.getFile(record.path);
		const merged: SyncedFileRecord = {
			...record,
			remoteUuid: record.remoteUuid ?? existing?.remoteUuid,
		};
		await this.config.db.setFile(record.path, merged);
	}

	/**
	 * Try to fetch and store the remote UUID from Filen for a given path.
	 * Best-effort: does not throw if the API call fails.
	 */
	private async trackRemoteUuid(path: string): Promise<void> {
		try {
			// The remote FS doesn't expose a direct UUID lookup method.
			// We rely on the sync record already having the UUID from a
			// previous download. For pure uploads, Filen assigns a UUID
			// on write but doesn't return it via the current SDK.
			// Future Filen SDK updates may expose this.
			// For now, this is a placeholder to keep the API clean.
		} catch {
			// Best-effort: ignore failures
		}
	}

	/**
	 * Preview what a sync would do without applying any changes.
	 * Returns a plan with per-file decisions and summary counts.
	 */
	async previewSyncPlan(mode: SyncMode = "bidirectional"): Promise<SyncPlanPreview> {
		await this.ensureRemote();
		const pathFilter = createSyncPathFilter({
			configDir: this.config.app.vault.configDir,
			pluginId: this.config.pluginId,
			ignorePatterns: this.config.settings.ignorePatterns,
		});
		const [local, remote, prevRecords] = await Promise.all([
			this.walkLocal(pathFilter),
			this.walkRemote(pathFilter),
			this.config.db.getAllFiles(),
		]);
		const prev = filterPrevRecords(prevRecords, pathFilter);
		const entries = this.ensemble(local, remote, prev);

		const planEntries: SyncPlanEntry[] = [];
		const summary = { uploads: 0, downloads: 0, localDeletes: 0, remoteDeletes: 0, conflicts: 0, skipped: 0, total: entries.length };

		for (const entry of entries) {
			const plan = await this.planFile(entry, mode);
			const planEntry: SyncPlanEntry = {
				path: entry.path,
				operation: plan.operation,
				detail: plan.detail,
			};
			planEntries.push(planEntry);

			switch (plan.operation) {
				case "upload": summary.uploads++; break;
				case "download": summary.downloads++; break;
				case "delete-local": summary.localDeletes++; break;
				case "delete-remote": summary.remoteDeletes++; break;
				case "conflict": summary.conflicts++; break;
				default: summary.skipped++; break;
			}
		}

		return { mode, entries: planEntries, summary };
	}

	private asFile(file: TAbstractFile | null): TFile {
		if (!(file instanceof TFile)) {
			throw new Error("expected file");
		}

		return file;
	}
}

const sameFileRecord = (prev: SyncedFileRecord, local: LocalEntry): boolean =>
	prev.path === local.path && prev.mtime === local.mtime && prev.ctime === local.ctime && prev.size === local.size;

const sameRemoteRecord = (prev: SyncedFileRecord, remote: RemoteEntry): boolean =>
	prev.path === remote.path && prev.mtime === remote.mtime && prev.size === remote.size;

const skipped = (detail: string): EntrySyncResult => ({ applied: 0, conflicts: 0, detail, operation: "noop" });

const syncModeDetail = (mode: SyncMode): string => {
	switch (mode) {
		case "bidirectional":
			return "Compare local and remote";
		case "push-local":
			return "Upload changed local files only";
		case "pull-remote":
			return "Download changed remote files only";
	}
};

const scanProgress = (current: number, path: string, detail: string): SyncProgress => ({
	current,
	total: 3,
	path,
	phase: "scan",
	state: "done",
	operation: "scan",
	detail,
	at: Date.now(),
});

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
	const digest = await window.crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
};

const chooseNewer = (local: LocalEntry, remote: RemoteEntry): "local" | "remote" =>
	local.mtime >= remote.mtime ? "local" : "remote";

const filterPrevRecords = (
	records: Map<string, SyncedFileRecord>,
	pathFilter: SyncPathFilter,
): Map<string, SyncedFileRecord> => {
	const filtered = new Map<string, SyncedFileRecord>();
	for (const [path, record] of records) {
		if (!pathFilter.isIgnored(path)) {
			filtered.set(path, record);
		}
	}

	return filtered;
};

const conflictCopyPath = (path: string, deviceId: string, timestamp: number): string => {
	const normalized = normalizePath(path);
	const dotIndex = normalized.lastIndexOf(".");
	const suffix = `.sync-conflict-${safePathSegment(deviceId)}-${timestamp}`;
	if (dotIndex <= 0) {
		return `${normalized}${suffix}`;
	}

	return `${normalized.slice(0, dotIndex)}${suffix}${normalized.slice(dotIndex)}`;
};

const safePathSegment = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

const ensureLocalFolder = async (app: App, path: string): Promise<void> => {
	const parts = normalizePath(path).split("/");
	parts.pop();

	let current = "";
	for (const part of parts) {
		current = current.length === 0 ? part : `${current}/${part}`;
		if (app.vault.getAbstractFileByPath(current) === null) {
			await app.vault.createFolder(current);
		}
	}
};
