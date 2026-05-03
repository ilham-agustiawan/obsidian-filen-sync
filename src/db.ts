import localforage from "localforage";
import type { SyncedFileRecord } from "./settings";
import { SYNC_DB_SCHEMA_VERSION } from "./settings";

// Thin IndexedDB wrapper for persisting per-file sync state.
// Keyed by file path; values are SyncedFileRecord objects.
export interface SyncDb {
	getFile(path: string): Promise<SyncedFileRecord | undefined>;
	setFile(path: string, record: SyncedFileRecord): Promise<void>;
	deleteFile(path: string): Promise<void>;
	getAllFiles(): Promise<Map<string, SyncedFileRecord>>;

	/** Current schema version (after migrations). */
	schemaVersion: number;

	/** Run any pending migrations. Returns true if migrations were applied. */
	runMigrations(): Promise<boolean>;
}

const META_KEY = "__filen_sync_meta__";

type DbMeta = {
	schemaVersion: number;
};

export const SyncDb = {
	async open(vaultName: string): Promise<SyncDb> {
		const store = localforage.createInstance({
			name: `obsidian-filen-sync-${vaultName}`,
			storeName: "synced-files",
		});
		const db = new LocalForageDb(store);
		await db.loadMeta();
		return db;
	},
} as const;

class LocalForageDb implements SyncDb {
	private _schemaVersion = 0;

	constructor(private readonly store: ReturnType<typeof localforage.createInstance>) {}

	get schemaVersion(): number {
		return this._schemaVersion;
	}

	async getFile(path: string): Promise<SyncedFileRecord | undefined> {
		const record = await this.store.getItem<SyncedFileRecord>(path);
		return record ?? undefined;
	}

	async setFile(path: string, record: SyncedFileRecord): Promise<void> {
		await this.store.setItem(path, record);
	}

	async deleteFile(path: string): Promise<void> {
		await this.store.removeItem(path);
	}

	async getAllFiles(): Promise<Map<string, SyncedFileRecord>> {
		const result = new Map<string, SyncedFileRecord>();
		await this.store.iterate<SyncedFileRecord, void>((value, key) => {
			if (key !== META_KEY) {
				result.set(key, value);
			}
		});
		return result;
	}

	async loadMeta(): Promise<void> {
		const meta = await this.store.getItem<DbMeta>(META_KEY);
		this._schemaVersion = meta?.schemaVersion ?? 0;
	}

	async runMigrations(): Promise<boolean> {
		let migrated = false;

		// Migration 0 → 1: upgrade existing records to v1 schema
		if (this._schemaVersion < 1) {
			await this.store.iterate<Record<string, unknown>, void>((value, key) => {
				if (key === META_KEY) return;

				// Ensure the record has the new optional fields
				if (typeof value.remoteUuid !== "string") {
					value.remoteUuid = undefined;
				}
				if (typeof value.lastSyncAt !== "number") {
					value.lastSyncAt = undefined;
				}
				if (
					value.lastKnownSide !== "local" &&
					value.lastKnownSide !== "remote" &&
					value.lastKnownSide !== "both"
				) {
					value.lastKnownSide = undefined;
				}

				void this.store.setItem(key, value);
			});

			this._schemaVersion = SYNC_DB_SCHEMA_VERSION;
			await this.store.setItem(META_KEY, { schemaVersion: this._schemaVersion });
			migrated = true;
		}

		// Future migrations go here:
		// if (this._schemaVersion < 2) { ... }

		return migrated;
	}

	/**
	 * Persist the current schema version (call after any migration or schema bump).
	 */
	async writeMeta(): Promise<void> {
		await this.store.setItem(META_KEY, { schemaVersion: this._schemaVersion });
	}
}
