import type { App } from "obsidian";
import { Notice } from "obsidian";
import type { SyncJournal, JournalBatch } from "./sync-journal";

/**
 * Check for incomplete sync batches on startup.
 * If found, return details so the UI can prompt the user.
 */
export type CrashRecoveryCheck = {
	hasIncompleteBatches: boolean;
	batches: JournalBatch[];
	entryCount: number;
};

/**
 * Detect any sync batches that were in-progress when the app last shut down.
 */
export async function detectIncompleteSyncs(journal: SyncJournal): Promise<CrashRecoveryCheck> {
	const batches = await journal.getPendingBatches();

	let entryCount = 0;
	for (const batch of batches) {
		const entries = await journal.getBatchEntries(batch.id);
		entryCount += entries.length;
	}

	return {
		hasIncompleteBatches: batches.length > 0,
		batches,
		entryCount,
	};
}

/**
 * Recover from an interrupted sync batch by rolling it back.
 * This cleans up the journal and notifies the user.
 */
export async function rollbackIncompleteSync(
	journal: SyncJournal,
	batchId: string,
): Promise<void> {
	const entries = await journal.getBatchEntries(batchId);

	// Mark all pending entries as rolled-back
	for (const entry of entries) {
		if (entry.status === "pending") {
			await journal.markRolledBack(entry.id);
		}
	}

	await journal.rollbackBatch(batchId);
}

/**
 * Discard an incomplete sync batch without any recovery steps.
 * Use this when the user accepts that the incomplete operations are harmless.
 */
export async function discardIncompleteSync(
	journal: SyncJournal,
	batchId: string,
): Promise<void> {
	await journal.rollbackBatch(batchId);
	await journal.pruneBatch(batchId);
}

/**
 * Run crash recovery on startup. If incomplete syncs are found, show a
 * notice. The journal entries are left in-place so that a future "Repair
 * sync state" command can inspect or clean them.
 */
export async function handleCrashRecoveryOnStartup(
	app: App,
	journal: SyncJournal,
): Promise<void> {
	const check = await detectIncompleteSyncs(journal);

	if (!check.hasIncompleteBatches) return;

	console.warn(
		"Obsidian Filen Sync: found incomplete sync batches from previous session:",
		check.batches,
	);

	// Auto-discard stale batches older than 1 hour
	const oneHourAgo = Date.now() - 60 * 60 * 1000;
	let autoDiscarded = 0;

	for (const batch of check.batches) {
		if (batch.startedAt < oneHourAgo) {
			await discardIncompleteSync(journal, batch.id);
			autoDiscarded++;
		}
	}

	const remaining = check.batches.length - autoDiscarded;

	if (autoDiscarded > 0 && remaining === 0) {
		new Notice(
			`Obsidian Filen Sync: auto-discarded ${autoDiscarded} stale incomplete sync(s). No action needed.`,
			5000,
		);
		return;
	}

	if (remaining > 0) {
		new Notice(
			`Obsidian Filen Sync: found ${remaining} incomplete sync(s) from last session. Run "Sync now" to verify state, or use "Repair sync state" in the command palette to clean up.`,
			10000,
		);
	}
}
