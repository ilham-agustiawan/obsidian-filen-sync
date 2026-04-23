import { App, TAbstractFile, TFile, normalizePath } from "obsidian";
import type { SyncDb } from "./db";
import type { RemoteEntry, RemoteFs } from "./fs-remote";
import type { SyncedFileRecord } from "./settings";

type SyncEngineConfig = {
	app: App;
	db: SyncDb;
	settings: {
		deviceId: string;
		vaultName: string;
	};
	remote: RemoteFs;
};

type SyncResult = {
	applied: number;
	conflicts: number;
};

type EntrySyncResult = SyncResult & {
	detail: string;
	operation: SyncOperation;
};

export type SyncMode = "bidirectional" | "push-local" | "pull-remote";

export type SyncOperation = "change" | "no-change";

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
		onProgress?.(scanProgress(1, "Vault and Filen", "Scanning vault and Filen"));
		const [local, remote, prev] = await Promise.all([
			this.walkLocal(),
			this.walkRemote(),
			this.config.db.getAllFiles(),
		]);
		onProgress?.(scanProgress(2, "Sync database", "Reading previous sync state"));
		const entries = this.ensemble(local, remote, prev);
		onProgress?.(scanProgress(
			3,
			"Change plan",
			prev.size === 0 ? "Initial sync: preparing files" : "Sync: preparing changes",
		));

		let applied = 0;
		let conflicts = 0;
		const total = entries.length;

		for (const [index, entry] of entries.entries()) {
			onProgress?.({
				current: index + 1,
				total,
				path: entry.path,
				phase: "sync",
				state: "queued",
				operation: "no-change",
				detail: syncModeDetail(mode),
				at: Date.now(),
			});
			onProgress?.({
				current: index + 1,
				total,
				path: entry.path,
				phase: "sync",
				state: "active",
				operation: "no-change",
				detail: "Checking changes",
				at: Date.now(),
			});
			let result: EntrySyncResult;
			try {
				result = await this.syncEntry(entry, mode);
			} catch (err) {
				onProgress?.({
					current: index + 1,
					total,
					path: entry.path,
					phase: "sync",
					state: "failed",
					operation: "change",
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

		return { applied, conflicts };
	}

	private async walkLocal(): Promise<Map<string, LocalEntry>> {
		const entries = new Map<string, LocalEntry>();
		for (const file of this.config.app.vault.getAllLoadedFiles()) {
			if (shouldSkipPath(file.path, this.config.app.vault.configDir)) {
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

	private async walkRemote(): Promise<Map<string, RemoteEntry>> {
		const entries = new Map<string, RemoteEntry>();
		for (const entry of await this.config.remote.walk()) {
			if (shouldSkipPath(entry.path, this.config.app.vault.configDir)) {
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
		return this.syncFile(entry, mode);
	}

	private async syncFile(entry: MixedEntry, mode: SyncMode): Promise<EntrySyncResult> {
		const local = entry.local;
		const remote = entry.remote;
		const prev = entry.prev;

		if (local === undefined && remote === undefined) {
			if (prev !== undefined) {
				await this.config.db.deleteFile(entry.path);
			}

			return skipped("Missing on both sides");
		}

		if (local !== undefined && remote === undefined) {
			if (mode === "pull-remote") {
				if (prev !== undefined) {
					await this.deleteLocal(entry.path);
					await this.config.db.deleteFile(entry.path);
					return applied("Deleted local file");
				}
				return skipped("Local-only file ignored");
			}

			if (mode === "bidirectional" && prev !== undefined) {
				await this.deleteLocal(entry.path);
				await this.config.db.deleteFile(entry.path);
				return applied("Deleted local file");
			}

			await this.pushLocal(entry.path, local, await this.hashLocal(local));
			return applied("Uploaded local change");
		}

		if (local === undefined && remote !== undefined) {
			if (mode === "push-local") {
				if (prev === undefined) {
					return skipped("Remote-only file ignored");
				}

				await this.config.remote.rm(entry.path);
				await this.config.db.deleteFile(entry.path);
				return applied("Deleted remote file");
			}

			if (mode === "bidirectional" && prev !== undefined) {
				await this.config.remote.rm(entry.path);
				await this.config.db.deleteFile(entry.path);
				return applied("Deleted remote file");
			}

			await this.pullRemote(entry.path, remote);
			return applied("Downloaded remote change");
		}

		if (local === undefined || remote === undefined) {
			return skipped("File unavailable");
		}

		if (prev === undefined) {
			if (mode === "push-local") {
				await this.pushLocal(entry.path, local, await this.hashLocal(local));
				return applied("Uploaded local file");
			}

			if (mode === "pull-remote") {
				await this.pullRemote(entry.path, remote);
				return applied("Downloaded remote file");
			}

			const newer = chooseNewer(local, remote);
			if (newer === "local") {
				await this.pushLocal(entry.path, local, await this.hashLocal(local));
			} else {
				await this.pullRemote(entry.path, remote);
			}
			return conflict("No baseline; chose newer file");
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

			await this.pushLocal(entry.path, local, localChange.hash);
			return applied("Uploaded local change");
		}

		if (!localChanged && remoteChanged) {
			if (mode === "push-local") {
				return skipped("Remote-only change ignored");
			}

			await this.pullRemote(entry.path, remote);
			return applied("Downloaded remote change");
		}

		if (mode === "push-local") {
			await this.pushLocal(entry.path, local, localChange.hash);
			return applied("Uploaded local change");
		}

		if (mode === "pull-remote") {
			await this.writeConflictCopy(local.path);
			await this.pullRemote(entry.path, remote);
			return conflict("Conflict copy kept; downloaded remote");
		}

		const newer = chooseNewer(local, remote);
		if (newer === "local") {
			await this.writeConflictCopy(local.path);
			await this.pushLocal(entry.path, local, localChange.hash);
		} else {
			await this.writeConflictCopy(local.path);
			await this.pullRemote(entry.path, remote);
		}

		return conflict(newer === "local" ? "Conflict copy kept; uploaded local" : "Conflict copy kept; downloaded remote");
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
		await this.config.db.setFile(record.path, record);
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

const applied = (detail: string): EntrySyncResult => ({ applied: 1, conflicts: 0, detail, operation: "change" });

const skipped = (detail: string): EntrySyncResult => ({ applied: 0, conflicts: 0, detail, operation: "no-change" });

const conflict = (detail: string): EntrySyncResult => ({ applied: 1, conflicts: 1, detail, operation: "change" });

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
	operation: "no-change",
	detail,
	at: Date.now(),
});

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
};

const chooseNewer = (local: LocalEntry, remote: RemoteEntry): "local" | "remote" =>
	local.mtime >= remote.mtime ? "local" : "remote";

const shouldSkipPath = (path: string, configDir: string): boolean =>
	path.length === 0 || path.startsWith(`${configDir}/plugins/obsidian-filen-sync/`);

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
