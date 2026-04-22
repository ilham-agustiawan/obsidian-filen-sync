import localforage from "localforage";
import type { SyncedFileRecord } from "./settings";

// Thin IndexedDB wrapper for persisting per-file sync state.
// Keyed by file path; values are SyncedFileRecord objects.
export interface SyncDb {
	getFile(path: string): Promise<SyncedFileRecord | undefined>;
	setFile(path: string, record: SyncedFileRecord): Promise<void>;
	deleteFile(path: string): Promise<void>;
	getAllFiles(): Promise<Map<string, SyncedFileRecord>>;
}

export const SyncDb = {
	// Each vault gets its own localforage database so multiple vaults open in
	// the same Electron app don't share state.
	open(vaultName: string): SyncDb {
		const store = localforage.createInstance({
			name: `obsidian-filen-sync-${vaultName}`,
			storeName: "synced-files",
		});
		return new LocalForageDb(store);
	},
} as const;

class LocalForageDb implements SyncDb {
	constructor(private readonly store: LocalForage) {}

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
			result.set(key, value);
		});
		return result;
	}
}
