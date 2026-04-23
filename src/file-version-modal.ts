import { Component, MarkdownRenderer, Modal, Notice, TFile, type App } from "obsidian";
import type { RemoteFileVersion, RemoteFs } from "./fs-remote";

type FileVersionModalConfig = {
	app: App;
	remote: RemoteFs;
	path: string;
	onRestored: () => Promise<void>;
	confirmRestore: (version: RemoteFileVersion) => Promise<boolean>;
	confirmDelete: (version: RemoteFileVersion) => Promise<boolean>;
};

export class FileVersionModal extends Modal {
	private versions: RemoteFileVersion[] = [];

	constructor(private readonly config: FileVersionModalConfig) {
		super(config.app);
		this.modalEl.addClass("filen-sync-version-modal");
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: "File versions" });
		this.contentEl.createEl("div", { text: this.config.path, cls: "filen-sync-version-path" });
		this.contentEl.createEl("div", { text: "Loading...", cls: "filen-sync-version-status" });

		try {
			this.versions = prepareVersions(await this.config.remote.getFileVersions(this.config.path));
			this.render();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			this.contentEl.empty();
			this.contentEl.createEl("h2", { text: "File versions" });
			this.contentEl.createEl("div", { text: this.config.path, cls: "filen-sync-version-path" });
			this.contentEl.createEl("div", { text: `Failed to load: ${message}`, cls: "filen-sync-version-error" });
			new Notice(`Filen versions failed: ${message}`);
		}
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: "File versions" });
		this.contentEl.createEl("div", { text: this.config.path, cls: "filen-sync-version-path" });

		const summary = this.contentEl.createEl("div", {
			text: `${this.versions.length} previous version${this.versions.length === 1 ? "" : "s"}`,
			cls: "filen-sync-version-summary",
		});
		summary.setAttr("aria-live", "polite");

		const list = this.contentEl.createDiv({ cls: "filen-sync-version-list" });
		this.renderCurrentRow(list);

		if (this.versions.length === 0) {
			list.createEl("div", { text: "No previous versions found.", cls: "filen-sync-version-empty" });
			return;
		}

		this.versions.forEach((version) => {
			const row = list.createDiv({ cls: "filen-sync-version-row" });
			const meta = row.createDiv({ cls: "filen-sync-version-meta" });
			meta.createEl("div", { text: formatTime(version.timestamp), cls: "filen-sync-version-title" });

			const actions = row.createDiv({ cls: "filen-sync-version-actions" });

			const previewButton = actions.createEl("button", { text: "Preview" });
			previewButton.addEventListener("click", () => {
				void (async () => {
					previewButton.disabled = true;
					previewButton.setText("Loading...");
					try {
						const content = await this.config.remote.readFileVersion(version);
						new FileVersionPreviewModal(this.config.app, this.config.path, version, content).open();
					} catch (error) {
						const message = error instanceof Error ? error.message : "Unknown error";
						new Notice(`Filen preview failed: ${message}`);
					} finally {
						previewButton.disabled = false;
						previewButton.setText("Preview");
					}
				})();
			});

			const restoreButton = actions.createEl("button", { text: "Restore" });
			restoreButton.addClass("mod-cta");
			restoreButton.addEventListener("click", () => {
				void (async () => {
					const confirmed = await this.config.confirmRestore(version);
					if (!confirmed) {
						return;
					}

					restoreButton.disabled = true;
					restoreButton.setText("Restoring...");
					try {
						await this.config.remote.restoreFileVersion(this.config.path, version.uuid);
						await this.config.onRestored();
						new Notice(`Restored version from ${formatTime(version.timestamp)}`);
						this.close();
					} catch (error) {
						const message = error instanceof Error ? error.message : "Unknown error";
						restoreButton.disabled = false;
						restoreButton.setText("Restore");
						new Notice(`Filen restore failed: ${message}`);
					}
				})();
			});

			const deleteButton = actions.createEl("button", { text: "Delete", cls: "filen-sync-version-delete" });
			deleteButton.addEventListener("click", () => {
				void (async () => {
					const confirmed = await this.config.confirmDelete(version);
					if (!confirmed) {
						return;
					}

					deleteButton.disabled = true;
					deleteButton.setText("Deleting...");
					try {
						await this.config.remote.deleteFileVersion(version.uuid);
						this.versions = prepareVersions(await this.config.remote.getFileVersions(this.config.path));
						new Notice(`Deleted version from ${formatTime(version.timestamp)}`);
						this.render();
					} catch (error) {
						const message = error instanceof Error ? error.message : "Unknown error";
						deleteButton.disabled = false;
						deleteButton.setText("Delete");
						new Notice(`Filen version delete failed: ${message}`);
					}
				})();
			});
		});
	}

	private renderCurrentRow(list: HTMLElement): void {
		const current = this.config.app.vault.getAbstractFileByPath(this.config.path);
		if (!(current instanceof TFile)) {
			return;
		}

		const row = list.createDiv({ cls: "filen-sync-version-row is-current" });
		const meta = row.createDiv({ cls: "filen-sync-version-meta" });
		const title = meta.createDiv({ cls: "filen-sync-version-title" });
		title.createEl("span", { text: formatTime(current.stat.mtime) });
		title.createEl("span", { text: "Current", cls: "filen-sync-version-badge" });
	}
}

class FileVersionPreviewModal extends Modal {
	private renderComponent: Component | null = null;

	constructor(
		app: App,
		private readonly path: string,
		private readonly version: RemoteFileVersion,
		private readonly content: Uint8Array,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("filen-sync-preview-modal");

		const header = this.contentEl.createDiv({ cls: "filen-sync-preview-header" });
		header.createEl("div", { text: this.path, cls: "filen-sync-version-path" });
		header.createEl("div", { text: formatTime(this.version.timestamp), cls: "filen-sync-version-summary" });

		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(this.content);
		} catch {
			this.contentEl.createEl("div", {
				text: `Binary file (${this.content.byteLength} bytes) — cannot preview.`,
				cls: "filen-sync-preview-binary",
			});
			return;
		}

		const body = this.contentEl.createDiv({ cls: "filen-sync-preview-body markdown-preview-view markdown-rendered" });
		const component = new Component();
		component.load();
		this.renderComponent = component;
		void MarkdownRenderer.render(this.app, text, body, this.path, component);
	}

	onClose(): void {
		this.renderComponent?.unload();
		this.renderComponent = null;
		this.contentEl.empty();
	}
}

const prepareVersions = (versions: RemoteFileVersion[]): RemoteFileVersion[] => {
	const byUuid = new Map<string, RemoteFileVersion>();
	for (const version of versions) {
		if (version.uuid.length === 0) {
			continue;
		}
		const existing = byUuid.get(version.uuid);
		if (existing === undefined || version.timestamp > existing.timestamp) {
			byUuid.set(version.uuid, version);
		}
	}

	return [...byUuid.values()].sort((left, right) => {
		const timestampOrder = right.timestamp - left.timestamp;
		if (timestampOrder !== 0) {
			return timestampOrder;
		}

		const versionOrder = right.version - left.version;
		return versionOrder !== 0 ? versionOrder : left.uuid.localeCompare(right.uuid);
	});
};

const formatTime = (epochMs: number): string =>
	new Date(epochMs).toLocaleString([], {
		year: "numeric",
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
