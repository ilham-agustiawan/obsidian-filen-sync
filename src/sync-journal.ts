import localforage from "localforage";
import type { SyncOperation } from "./sync-engine";

/**
 * Journal entry that records a sync operation *before* it is applied.
 * Enables crash recovery: if Obsidian/Filen crashes mid-sync, the next
 * launch can detect incomplete operations.
 */
export type JournalEntry = {
	/** Unique id for this entry (UUID). */
	id: string;
	/** The sync batch id this entry belongs to. */
	batchId: string;
	/** File path this operation targets. */
	path: string;
	/** Type of operation. */
	operation: SyncOperation;
	/** Human-readable detail. */
	detail: string;
	/** Unix-ms when the entry was created. */
	createdAt: number;
	/** Current status. */
	status: "pending" | "applied" | "rolled-back";
	/** Optional metadata snapshot before the operation (for rollback). */
	prevRecord?: unknown;
};

export type JournalBatch = {
	/** Unique batch id (UUID). */
	id: string;
	/** Label describing the sync run. */
	label: string;
	/** Unix-ms when the batch started. */
	startedAt: number;
	/** Current state of the batch. */
	status: "in-progress" | "completed" | "rolled-back";
};

export interface SyncJournal {
	/** Begin a new journal batch. Returns the batch id. */
	startBatch(label: string): Promise<string>;

	/** Log a pending operation. Call before applying the change. */
	logPending(entry: Omit<JournalEntry, "id" | "createdAt" | "status">): Promise<string>;

	/** Mark a journal entry as successfully applied. */
	markApplied(entryId: string): Promise<void>;

	/** Mark a journal entry as rolled back. */
	markRolledBack(entryId: string): Promise<void>;

	/** Mark the entire batch as completed. */
	completeBatch(batchId: string): Promise<void>;

	/** Roll back the entire batch. */
	rollbackBatch(batchId: string): Promise<void>;

	/** Get all entries for a batch. */
	getBatchEntries(batchId: string): Promise<JournalEntry[]>;

	/** Get all pending batches (in-progress, not completed/rolled-back). */
	getPendingBatches(): Promise<JournalBatch[]>;

	/** Delete all entries for a batch (cleanup after successful completion). */
	pruneBatch(batchId: string): Promise<void>;
}

export const SyncJournal = {
	open(vaultName: string): SyncJournal {
		const store = localforage.createInstance({
			name: `obsidian-filen-sync-${vaultName}`,
			storeName: "sync-journal",
		});
		return new LocalForageJournal(store);
	},
} as const;

class LocalForageJournal implements SyncJournal {
	constructor(private readonly store: ReturnType<typeof localforage.createInstance>) {}

	async startBatch(label: string): Promise<string> {
		const id = window.crypto.randomUUID();
		await this.store.setItem(batchKey(id), {
			id,
			label,
			startedAt: Date.now(),
			status: "in-progress",
		} satisfies JournalBatch);
		return id;
	}

	async logPending(entry: Omit<JournalEntry, "id" | "createdAt" | "status">): Promise<string> {
		const id = window.crypto.randomUUID();
		const full: JournalEntry = {
			...entry,
			id,
			createdAt: Date.now(),
			status: "pending",
		};
		await this.store.setItem(entryKey(id), full);
		return id;
	}

	async markApplied(entryId: string): Promise<void> {
		const entry = await this.store.getItem<JournalEntry>(entryKey(entryId));
		if (entry) {
			entry.status = "applied";
			await this.store.setItem(entryKey(entryId), entry);
		}
	}

	async markRolledBack(entryId: string): Promise<void> {
		const entry = await this.store.getItem<JournalEntry>(entryKey(entryId));
		if (entry) {
			entry.status = "rolled-back";
			await this.store.setItem(entryKey(entryId), entry);
		}
	}

	async completeBatch(batchId: string): Promise<void> {
		const batch = await this.store.getItem<JournalBatch>(batchKey(batchId));
		if (batch) {
			batch.status = "completed";
			await this.store.setItem(batchKey(batchId), batch);
		}
	}

	async rollbackBatch(batchId: string): Promise<void> {
		const batch = await this.store.getItem<JournalBatch>(batchKey(batchId));
		if (batch) {
			batch.status = "rolled-back";
			await this.store.setItem(batchKey(batchId), batch);
		}

		// Mark all entries as rolled-back
		await this.store.iterate<JournalEntry, void>((value, key) => {
			if (key.startsWith("entry:") && value.batchId === batchId && value.status === "pending") {
				value.status = "rolled-back";
				void this.store.setItem(key, value);
			}
		});
	}

	async getBatchEntries(batchId: string): Promise<JournalEntry[]> {
		const entries: JournalEntry[] = [];
		await this.store.iterate<JournalEntry, void>((value, key) => {
			if (key.startsWith("entry:") && value.batchId === batchId) {
				entries.push(value);
			}
		});
		return entries.sort((a, b) => a.createdAt - b.createdAt);
	}

	async getPendingBatches(): Promise<JournalBatch[]> {
		const batches: JournalBatch[] = [];
		await this.store.iterate<JournalBatch, void>((value, key) => {
			if (key.startsWith("batch:") && value.status === "in-progress") {
				batches.push(value);
			}
		});
		return batches;
	}

	async pruneBatch(batchId: string): Promise<void> {
		const keysToRemove: string[] = [];

		await this.store.iterate<unknown, void>((_value, key) => {
			if (key === batchKey(batchId) || (key.startsWith("entry:") && key.includes(batchId))) {
				keysToRemove.push(key);
			}
		});

		for (const key of keysToRemove) {
			await this.store.removeItem(key);
		}
	}
}

const batchKey = (id: string): string => `batch:${id}`;
const entryKey = (id: string): string => `entry:${id}`;
