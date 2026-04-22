import { App, normalizePath, TFile } from "obsidian";
import { Bytes } from "./bytes";
import type { SyncDb } from "./db";
import type { RemoteJournalStore } from "./filen-store";
import { Journal, JournalEntry, JournalEnvelope } from "./journal";
import type { FilenSyncSettings, SyncedFileRecord } from "./settings";

type SyncEngineConfig = {
	app: App;
	db: SyncDb;
	settings: FilenSyncSettings;
	saveSettings: () => Promise<void>;
	remote: RemoteJournalStore;
};

type PushResult = {
	entries: number;
	journalKey: string | null;
};

type LocalChangeSet = {
	entries: JournalEntry[];
	toSet: Map<string, SyncedFileRecord>;
	toDelete: string[];
};

type PullResult = {
	applied: number;
	conflicts: number;
};

const MAX_PULL_FILES = 100;

export class SyncEngine {
	constructor(private readonly config: SyncEngineConfig) {}

	close(): void {
		this.config.remote.close();
	}

	async ensureRemote(): Promise<void> {
		await this.config.remote.ensureRoot();
		await this.config.remote.writeMilestone(
			this.config.settings.deviceId,
			this.config.settings.vaultName,
		);
	}

	async testRemote(): Promise<void> {
		await this.config.remote.testReadWrite();
	}

	async push(): Promise<PushResult> {
		await this.ensureRemote();
		const changes = await this.collectLocalChanges();
		const { entries } = changes;
		if (entries.length === 0) {
			return { entries: 0, journalKey: null };
		}

		const journalKey = this.makeJournalKey();
		const envelope: JournalEnvelope = {
			protocolVersion: 1,
			deviceId: this.config.settings.deviceId,
			createdAt: Date.now(),
			entries,
		};

		await this.config.remote.writeFile(journalKey, await Journal.encode(envelope));
		await applyChangeSet(this.config.db, changes.toSet, changes.toDelete);
		this.config.settings.state.sentJournalKeys = rememberSentKey(
			this.config.settings.state.sentJournalKeys,
			journalKey,
		);
		await this.config.saveSettings();

		return { entries: entries.length, journalKey };
	}

	async pull(): Promise<PullResult> {
		await this.ensureRemote();
		const keys = await this.config.remote.listFiles(
			this.config.settings.state.lastPulledKey,
			MAX_PULL_FILES,
		);

		let applied = 0;
		let conflicts = 0;

		for (const key of keys) {
			if (this.config.settings.state.sentJournalKeys.includes(key)) {
				this.config.settings.state.lastPulledKey = key;
				await this.config.saveSettings();
				continue;
			}

			const envelope = await Journal.decode(await this.config.remote.readFile(key));
			for (const entry of envelope.entries) {
				const result = await this.applyRemoteEntry(entry, envelope.deviceId, envelope.createdAt);
				applied += result.applied;
				conflicts += result.conflicts;
			}

			this.config.settings.state.lastPulledKey = key;
			await this.config.saveSettings();
		}

		return { applied, conflicts };
	}

	private async collectLocalChanges(): Promise<LocalChangeSet> {
		const currentFiles = new Map<string, TFile>();
		for (const file of this.config.app.vault.getFiles()) {
			if (shouldSyncPath(file.path, this.config.app.vault.configDir)) {
				currentFiles.set(file.path, file);
			}
		}

		// Load all known file records from DB once so we don't hit IndexedDB per-file.
		const knownFiles = await this.config.db.getAllFiles();

		const entries: JournalEntry[] = [];
		const toSet = new Map<string, SyncedFileRecord>();
		const toDelete: string[] = [];

		for (const [path, file] of currentFiles) {
			const current = toSyncedFileRecord(file);
			const previous = knownFiles.get(path);

			// Fast path: metadata unchanged — no need to read content.
			if (previous !== undefined && sameFileRecord(previous, current)) {
				continue;
			}

			const content = new Uint8Array(await this.config.app.vault.readBinary(file));
			const hash = await Bytes.sha256hex(content);

			// Content unchanged despite metadata shift — skip to avoid redundant upload.
			if (previous?.hash !== undefined && previous.hash === hash) {
				// Queue metadata update so the fast path triggers next time.
				toSet.set(path, { ...current, hash });
				continue;
			}

			entries.push({
				type: "file",
				path,
				mtime: current.mtime,
				ctime: current.ctime,
				size: current.size,
				hash,
				contentBase64: Bytes.toBase64(content),
			});
			toSet.set(path, { ...current, hash });
		}

		for (const path of knownFiles.keys()) {
			if (currentFiles.has(path)) {
				continue;
			}

			entries.push({ type: "delete", path, deletedAt: Date.now() });
			toDelete.push(path);
		}

		return { entries, toSet, toDelete };
	}

	private async applyRemoteEntry(
		entry: JournalEntry,
		remoteDeviceId: string,
		remoteCreatedAt: number,
	): Promise<PullResult> {
		const localFile = this.getFile(entry.path);
		const previous = await this.config.db.getFile(entry.path);
		const localChanged = localFile !== null && previous !== undefined
			? !sameFileRecord(toSyncedFileRecord(localFile), previous)
			: localFile !== null && previous === undefined;

		if (entry.type === "delete") {
			if (localFile === null) {
				await this.config.db.deleteFile(entry.path);
				return { applied: 0, conflicts: 0 };
			}

			if (localChanged) {
				await this.writeConflictCopy(localFile, remoteDeviceId, remoteCreatedAt);
				return { applied: 0, conflicts: 1 };
			}

			await this.config.app.fileManager.trashFile(localFile);
			await this.config.db.deleteFile(entry.path);
			return { applied: 1, conflicts: 0 };
		}

		if (localFile !== null && localChanged) {
			await this.writeConflictCopy(localFile, remoteDeviceId, remoteCreatedAt);
		}

		await this.writeFileEntry(entry);
		await this.config.db.setFile(entry.path, {
			path: entry.path,
			mtime: entry.mtime,
			ctime: entry.ctime,
			size: entry.size,
			...(entry.hash !== undefined ? { hash: entry.hash } : {}),
		});

		return { applied: 1, conflicts: localFile !== null && localChanged ? 1 : 0 };
	}

	private async writeFileEntry(entry: Extract<JournalEntry, { type: "file" }>): Promise<void> {
		const path = normalizePath(entry.path);
		await this.ensureParentFolder(path);
		await this.config.app.vault.adapter.writeBinary(path, Bytes.fromBase64(entry.contentBase64), {
			mtime: entry.mtime,
			ctime: entry.ctime,
		});
	}

	private async writeConflictCopy(
		file: TFile,
		remoteDeviceId: string,
		remoteCreatedAt: number,
	): Promise<void> {
		const conflictPath = conflictCopyPath(file.path, remoteDeviceId, remoteCreatedAt);
		await this.ensureParentFolder(conflictPath);
		const content = await this.config.app.vault.readBinary(file);
		await this.config.app.vault.adapter.writeBinary(conflictPath, content, {
			mtime: file.stat.mtime,
			ctime: file.stat.ctime,
		});
	}

	private async ensureParentFolder(path: string): Promise<void> {
		const parts = normalizePath(path).split("/");
		parts.pop();

		let current = "";
		for (const part of parts) {
			current = current.length === 0 ? part : `${current}/${part}`;
			if (this.config.app.vault.getAbstractFileByPath(current) === null) {
				await this.config.app.vault.createFolder(current);
			}
		}
	}

	private getFile(path: string): TFile | null {
		const file = this.config.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	private makeJournalKey(): string {
		const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
		const random = crypto.randomUUID().slice(0, 8);
		return `${timestamp}-${this.config.settings.deviceId}-${random}-docs.jsonl`;
	}
}

const toSyncedFileRecord = (file: TFile): SyncedFileRecord => ({
	path: file.path,
	mtime: file.stat.mtime,
	ctime: file.stat.ctime,
	size: file.stat.size,
});

const sameFileRecord = (left: SyncedFileRecord, right: SyncedFileRecord): boolean => {
	if (left.hash !== undefined && right.hash !== undefined) {
		return left.hash === right.hash;
	}

	return (
		left.path === right.path &&
		left.mtime === right.mtime &&
		left.ctime === right.ctime &&
		left.size === right.size
	);
};

const shouldSyncPath = (path: string, configDir: string): boolean => {
	if (path.length === 0) {
		return false;
	}

	return !path.startsWith(`${configDir}/plugins/obsidian-filen-sync/`);
};

const conflictCopyPath = (path: string, remoteDeviceId: string, remoteCreatedAt: number): string => {
	const normalized = normalizePath(path);
	const dotIndex = normalized.lastIndexOf(".");
	const suffix = `.sync-conflict-${safePathSegment(remoteDeviceId)}-${remoteCreatedAt}`;
	if (dotIndex <= 0) {
		return `${normalized}${suffix}`;
	}

	return `${normalized.slice(0, dotIndex)}${suffix}${normalized.slice(dotIndex)}`;
};

const safePathSegment = (value: string): string =>
	value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

const rememberSentKey = (keys: string[], key: string): string[] => [...keys, key].slice(-200);

const applyChangeSet = (
	db: SyncDb,
	toSet: Map<string, SyncedFileRecord>,
	toDelete: string[],
): Promise<void[]> =>
	Promise.all([
		...[...toSet.entries()].map(([path, record]) => db.setFile(path, record)),
		...toDelete.map((path) => db.deleteFile(path)),
	]);
