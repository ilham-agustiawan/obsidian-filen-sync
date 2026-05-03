import { Modal, Notice, TFile, type App } from "obsidian";
import type { ConflictCopy } from "./sync-engine";

const CONFLICT_MARKER = ".sync-conflict-";

/**
 * Scan the vault for existing conflict copies and reconstruct the original path for each.
 * The conflict copy format is: `{name_without_ext}.sync-conflict-{deviceId}-{timestamp}{ext}`
 */
export function findConflictCopies(app: App): ConflictCopy[] {
	const copies: ConflictCopy[] = [];
	for (const file of app.vault.getAllLoadedFiles()) {
		if (!(file instanceof TFile)) continue;
		const idx = file.path.lastIndexOf(CONFLICT_MARKER);
		if (idx === -1) continue;
		const beforeSuffix = file.path.slice(0, idx);
		const afterSuffix = file.path.slice(idx + CONFLICT_MARKER.length);
		// The original extension is the last `.xxx` segment after the timestamp (digits only).
		// safePathSegment only allows [a-zA-Z0-9_-], so no dots appear before the extension.
		const extMatch = afterSuffix.match(/(\.[^.]+)$/);
		const ext = extMatch ? extMatch[1] : "";
		copies.push({ originalPath: `${beforeSuffix}${ext}`, copyPath: file.path });
	}
	return copies;
}

export class ConflictResolutionModal extends Modal {
	private copies: ConflictCopy[];

	constructor(app: App, copies: ConflictCopy[]) {
		super(app);
		this.copies = [...copies];
		this.modalEl.addClass("filen-sync-conflict-modal");
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: "Sync Conflicts" });

		if (this.copies.length === 0) {
			this.contentEl.createEl("p", { text: "All conflicts resolved.", cls: "filen-sync-conflict-empty" });
			return;
		}

		this.contentEl.createEl("p", {
			text: `${this.copies.length} file${this.copies.length === 1 ? " was" : "s were"} modified on both sides. Your local version was saved as a conflict copy — review and choose which to keep.`,
			cls: "filen-sync-conflict-summary",
		});

		const list = this.contentEl.createDiv({ cls: "filen-sync-conflict-list" });
		for (const copy of this.copies) {
			this.renderRow(list, copy);
		}

		const footer = this.contentEl.createDiv({ cls: "filen-sync-conflict-footer" });
		const discardAllBtn = footer.createEl("button", { text: "Discard all copies" });
		discardAllBtn.addEventListener("click", () => {
			void (async () => {
				discardAllBtn.disabled = true;
				discardAllBtn.setText("Discarding...");
				try {
					for (const copy of [...this.copies]) {
						await this.trashFile(copy.copyPath);
					}
					this.copies = [];
					this.render();
					new Notice("All conflict copies discarded.");
				} catch (error) {
					const message = error instanceof Error ? error.message : "Unknown error";
					new Notice(`Failed to discard: ${message}`);
					discardAllBtn.disabled = false;
					discardAllBtn.setText("Discard all copies");
				}
			})();
		});
	}

	private renderRow(container: HTMLElement, copy: ConflictCopy): void {
		const row = container.createDiv({ cls: "filen-sync-conflict-row" });

		const meta = row.createDiv({ cls: "filen-sync-conflict-meta" });
		meta.createEl("div", { text: copy.originalPath, cls: "filen-sync-conflict-path" });
		// Show just the conflict copy filename, not the full path
		const copyFilename = copy.copyPath.split("/").pop() ?? copy.copyPath;
		meta.createEl("div", { text: `Copy: ${copyFilename}`, cls: "filen-sync-conflict-copy-name" });

		const actions = row.createDiv({ cls: "filen-sync-conflict-actions" });

		const openCurrentBtn = actions.createEl("button", { text: "Open current" });
		openCurrentBtn.addEventListener("click", () => void this.openFile(copy.originalPath));

		const openCopyBtn = actions.createEl("button", { text: "Open copy" });
		openCopyBtn.addEventListener("click", () => void this.openFile(copy.copyPath));

		const discardCopyBtn = actions.createEl("button", { text: "Discard copy" });
		discardCopyBtn.addEventListener("click", () => {
			void (async () => {
				discardCopyBtn.disabled = true;
				discardCopyBtn.setText("Discarding...");
				try {
					await this.trashFile(copy.copyPath);
					this.removeCopy(copy.copyPath);
					row.remove();
					if (this.copies.length === 0) this.render();
				} catch (error) {
					const message = error instanceof Error ? error.message : "Unknown error";
					new Notice(`Failed: ${message}`);
					discardCopyBtn.disabled = false;
					discardCopyBtn.setText("Discard copy");
				}
			})();
		});

		// Restores the local copy over the current (remote-resolved) file.
		// The next sync will detect the change and upload it.
		const restoreCopyBtn = actions.createEl("button", { text: "Restore copy", cls: "filen-sync-conflict-restore" });
		restoreCopyBtn.addEventListener("click", () => {
			void (async () => {
				restoreCopyBtn.disabled = true;
				restoreCopyBtn.setText("Restoring...");
				try {
					await this.restoreCopy(copy);
					this.removeCopy(copy.copyPath);
					row.remove();
					if (this.copies.length === 0) this.render();
					new Notice(`Restored: ${copy.originalPath} — will upload on next sync.`);
				} catch (error) {
					const message = error instanceof Error ? error.message : "Unknown error";
					new Notice(`Failed: ${message}`);
					restoreCopyBtn.disabled = false;
					restoreCopyBtn.setText("Restore copy");
				}
			})();
		});
	}

	private removeCopy(copyPath: string): void {
		this.copies = this.copies.filter((c) => c.copyPath !== copyPath);
	}

	private async openFile(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`File not found: ${path}`);
			return;
		}
		await this.app.workspace.getLeaf(true).openFile(file);
	}

	private async restoreCopy(copy: ConflictCopy): Promise<void> {
		const copyFile = this.app.vault.getAbstractFileByPath(copy.copyPath);
		if (!(copyFile instanceof TFile)) {
			throw new Error(`Conflict copy not found: ${copy.copyPath}`);
		}
		const raw = await this.app.vault.readBinary(copyFile);
		const content = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
		const original = this.app.vault.getAbstractFileByPath(copy.originalPath);
		if (original instanceof TFile) {
			await this.app.vault.modifyBinary(original, content);
		} else {
			await this.app.vault.adapter.writeBinary(copy.originalPath, content);
		}
		await this.trashFile(copy.copyPath);
	}

	private async trashFile(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file === null) return;
		await this.app.fileManager.trashFile(file);
	}
}
