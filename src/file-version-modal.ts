import { Modal, Notice, Platform, TFile, type App } from "obsidian";
import type { RemoteFileVersion, RemoteFs } from "./fs-remote";

type FileVersionModalConfig = {
	app: App;
	remote: RemoteFs;
	filePath: string;
	fileName: string;
	onRestored: () => void;
};

type VersionGroup = {
	dateLabel: string;
	versions: RemoteFileVersion[];
	expanded: boolean;
};

type DiffLine = { kind: "added" | "removed" | "unchanged"; text: string };

type PreviewState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "ready"; text: string }
	| { kind: "binary" }
	| { kind: "error"; message: string };

type ModalState =
	| { kind: "loading-versions" }
	| { kind: "error-versions"; message: string }
	| {
		kind: "ready";
		groups: VersionGroup[];
		selected: RemoteFileVersion | null;
		preview: PreviewState;
		showDiff: boolean;
		restoring: boolean;
		mobileView: "list" | "preview";
	  };

export class FileVersionModal extends Modal {
	private state: ModalState = { kind: "loading-versions" };
	private previewEl: HTMLElement | null = null;
	private currentFileText = "";

	constructor(private readonly config: FileVersionModalConfig) {
		super(config.app);
		this.modalEl.addClass("filen-sync-version-modal");
	}

	async onOpen(): Promise<void> {
		this.render();

		// Read current local content for diff view
		const localFile = this.app.vault.getAbstractFileByPath(this.config.filePath);
		if (localFile instanceof TFile) {
			try {
				this.currentFileText = await this.app.vault.cachedRead(localFile);
			} catch {
				// diff will show all version lines as added
			}
		}

		try {
			const raw = await this.config.remote.getFileVersions(this.config.filePath);
			const sorted = dedupeAndSort(raw);
			const groups = groupByDate(sorted);
			const firstGroup = groups[0];
			if (firstGroup !== undefined) firstGroup.expanded = true;

			this.state = {
				kind: "ready",
				groups,
				selected: null,
				preview: { kind: "idle" },
				showDiff: false,
				restoring: false,
				mobileView: "list",
			};
			this.render();

			// Auto-select first version
			const first = groups[0]?.versions[0];
			if (first !== undefined) {
				void this.selectVersion(first);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			this.state = { kind: "error-versions", message };
			this.render();
		}
	}

	onClose(): void {
		this.contentEl.empty();
		this.previewEl = null;
	}

	private render(): void {
		this.contentEl.empty();
		this.previewEl = null;

		if (this.state.kind === "loading-versions") {
			this.contentEl.createDiv({ cls: "filen-sync-version-loading", text: "Loading versions…" });
			return;
		}

		if (this.state.kind === "error-versions") {
			const err = this.contentEl.createDiv({ cls: "filen-sync-version-error" });
			err.createEl("strong", { text: "Failed to load versions" });
			err.createEl("p", { text: this.state.message });
			return;
		}

		const state = this.state;

		if (Platform.isMobile) {
			if (state.mobileView === "list") {
				this.renderSidebar(this.contentEl, state);
			} else {
				const panel = this.contentEl.createDiv({ cls: "filen-sync-version-main" });
				this.renderPreviewPanel(panel, state);
			}
		} else {
			const layout = this.contentEl.createDiv({ cls: "filen-sync-version-layout" });
			const sidebar = layout.createDiv({ cls: "filen-sync-version-sidebar" });
			this.renderSidebar(sidebar, state);
			const panel = layout.createDiv({ cls: "filen-sync-version-main" });
			this.renderPreviewPanel(panel, state);
		}
	}

	private renderSidebar(container: HTMLElement, state: Extract<ModalState, { kind: "ready" }>): void {
		if (state.groups.length === 0) {
			container.createDiv({ cls: "filen-sync-version-empty", text: "No previous versions found." });
			return;
		}

		for (const group of state.groups) {
			const groupEl = container.createDiv({ cls: "filen-sync-version-group" });

			const header = groupEl.createDiv({ cls: "filen-sync-version-date-header" });
			const arrow = header.createSpan({ cls: "filen-sync-version-arrow", text: group.expanded ? "▾" : "▸" });
			header.createSpan({ text: group.dateLabel, cls: "filen-sync-version-date-label" });
			header.createSpan({
				text: ` · ${group.versions.length} revision${group.versions.length === 1 ? "" : "s"}`,
				cls: "filen-sync-version-count",
			});

			const rowsEl = groupEl.createDiv({ cls: "filen-sync-version-rows" });
			if (!group.expanded) rowsEl.style.display = "none";

			header.addEventListener("click", () => {
				group.expanded = !group.expanded;
				arrow.setText(group.expanded ? "▾" : "▸");
				rowsEl.style.display = group.expanded ? "" : "none";
			});

			for (const version of group.versions) {
				const isSelected = state.selected?.uuid === version.uuid;
				const row = rowsEl.createDiv({ cls: `filen-sync-version-row${isSelected ? " is-selected" : ""}` });
				row.setAttr("data-uuid", version.uuid);
				row.setText(formatTime(version.timestamp));
				row.addEventListener("click", () => {
					if (Platform.isMobile) {
						state.mobileView = "preview";
					}
					void this.selectVersion(version);
				});
			}
		}
	}

	private renderPreviewPanel(container: HTMLElement, state: Extract<ModalState, { kind: "ready" }>): void {
		const header = container.createDiv({ cls: "filen-sync-version-header" });

		if (Platform.isMobile) {
			const backBtn = header.createEl("button", { text: "← Back", cls: "filen-sync-version-back" });
			backBtn.addEventListener("click", () => {
				state.mobileView = "list";
				this.render();
			});
		}

		header.createSpan({ text: this.config.fileName, cls: "filen-sync-version-title" });

		const toggleLabel = header.createEl("label", { cls: "filen-sync-version-toggle-label" });
		toggleLabel.createSpan({ text: "Show changes" });
		const toggleInput = toggleLabel.createEl("input");
		toggleInput.type = "checkbox";
		toggleInput.checked = state.showDiff;
		toggleInput.addEventListener("change", () => {
			state.showDiff = toggleInput.checked;
			this.renderPreviewContent(state);
		});

		const copyBtn = header.createEl("button", { text: "Copy", cls: "filen-sync-version-copy" });
		copyBtn.addEventListener("click", () => { void this.copyContent(state); });

		const restoreBtn = header.createEl("button", {
			text: state.restoring ? "Restoring…" : "Restore",
			cls: "mod-cta filen-sync-version-restore",
		});
		restoreBtn.disabled = state.restoring || state.selected === null;
		restoreBtn.addEventListener("click", () => { void this.restore(state); });

		const closeBtn = header.createEl("button", { cls: "filen-sync-version-close", text: "×" });
		closeBtn.setAttr("aria-label", "Close");
		closeBtn.addEventListener("click", () => { this.close(); });

		this.previewEl = container.createDiv({ cls: "filen-sync-version-content" });
		this.renderPreviewContent(state);
	}

	private renderPreviewContent(state: Extract<ModalState, { kind: "ready" }>): void {
		const el = this.previewEl;
		if (el === null) return;
		el.empty();

		const { preview, showDiff, selected } = state;

		if (selected === null || preview.kind === "idle") {
			el.createDiv({ cls: "filen-sync-version-placeholder", text: "Select a version to preview." });
			return;
		}

		if (preview.kind === "loading") {
			el.createDiv({ cls: "filen-sync-version-placeholder", text: "Loading…" });
			return;
		}

		if (preview.kind === "binary") {
			el.createDiv({ cls: "filen-sync-version-placeholder", text: "Binary file — cannot preview." });
			return;
		}

		if (preview.kind === "error") {
			el.createDiv({ cls: "filen-sync-version-error-inline", text: `Preview failed: ${preview.message}` });
			return;
		}

		if (showDiff) {
			const diff = computeDiff(this.currentFileText, preview.text);
			for (const line of diff) {
				const lineEl = el.createDiv({ text: line.text || " " });
				if (line.kind === "added") lineEl.addClass("filen-sync-version-diff-added");
				else if (line.kind === "removed") lineEl.addClass("filen-sync-version-diff-removed");
			}
		} else {
			el.setText(preview.text);
		}
	}

	private async selectVersion(version: RemoteFileVersion): Promise<void> {
		if (this.state.kind !== "ready") return;
		const state = this.state;

		state.selected = version;
		state.preview = { kind: "loading" };

		// Update sidebar selection highlight in-place (desktop only)
		if (!Platform.isMobile) {
			for (const row of Array.from(this.contentEl.querySelectorAll<HTMLElement>(".filen-sync-version-row"))) {
				if (row.getAttr("data-uuid") === version.uuid) row.addClass("is-selected");
				else row.removeClass("is-selected");
			}
			// Update restore button disabled state
			const restoreBtn = this.contentEl.querySelector<HTMLButtonElement>(".filen-sync-version-restore");
			if (restoreBtn !== null) restoreBtn.disabled = false;
		} else if (state.mobileView === "preview") {
			this.render();
		}

		this.renderPreviewContent(state);

		try {
			const bytes = await this.config.remote.readFileVersion(version);
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				if (this.state.kind === "ready" && this.state.selected?.uuid === version.uuid) {
					this.state.preview = { kind: "binary" };
					this.renderPreviewContent(this.state);
				}
				return;
			}
			if (this.state.kind === "ready" && this.state.selected?.uuid === version.uuid) {
				this.state.preview = { kind: "ready", text };
				this.renderPreviewContent(this.state);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			if (this.state.kind === "ready" && this.state.selected?.uuid === version.uuid) {
				this.state.preview = { kind: "error", message };
				this.renderPreviewContent(this.state);
			}
		}
	}

	private async restore(state: Extract<ModalState, { kind: "ready" }>): Promise<void> {
		if (state.selected === null || state.restoring) return;
		const version = state.selected;
		state.restoring = true;
		this.render();
		try {
			await this.config.remote.restoreFileVersion(this.config.filePath, version.uuid);
			new Notice(`Restored version from ${formatTime(version.timestamp)}`);
			this.config.onRestored();
			this.close();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Restore failed: ${message}`);
			state.restoring = false;
			this.render();
		}
	}

	private async copyContent(state: Extract<ModalState, { kind: "ready" }>): Promise<void> {
		if (state.preview.kind !== "ready") {
			new Notice("No content to copy.");
			return;
		}
		try {
			await navigator.clipboard.writeText(state.preview.text);
			new Notice("Version content copied.");
		} catch {
			new Notice("Could not copy content.");
		}
	}
}

// --- Helpers ---

const dedupeAndSort = (versions: RemoteFileVersion[]): RemoteFileVersion[] => {
	const byUuid = new Map<string, RemoteFileVersion>();
	for (const v of versions) {
		if (v.uuid.length === 0) continue;
		const existing = byUuid.get(v.uuid);
		if (existing === undefined || v.timestamp > existing.timestamp) byUuid.set(v.uuid, v);
	}
	return [...byUuid.values()].sort((a, b) => {
		const t = b.timestamp - a.timestamp;
		return t !== 0 ? t : b.version - a.version;
	});
};

const groupByDate = (versions: RemoteFileVersion[]): VersionGroup[] => {
	const groups = new Map<string, RemoteFileVersion[]>();
	for (const v of versions) {
		const label = formatDate(v.timestamp);
		let g = groups.get(label);
		if (g === undefined) { g = []; groups.set(label, g); }
		g.push(v);
	}
	return [...groups.entries()].map(([dateLabel, vs]) => ({ dateLabel, versions: vs, expanded: false }));
};

const formatDate = (epochMs: number): string =>
	new Date(epochMs).toLocaleDateString([], { weekday: "short", year: "numeric", month: "short", day: "numeric" });

const formatTime = (epochMs: number): string =>
	new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// LCS-based line diff.
const computeDiff = (oldText: string, newText: string): DiffLine[] => {
	const a = oldText.split("\n");
	const b = newText.split("\n");
	const m = a.length;
	const n = b.length;

	// Flat row-major storage avoids 2-D array index safety issues.
	const dp = new Int32Array((m + 1) * (n + 1));
	const at = (i: number, j: number): number => dp[i * (n + 1) + j] ?? 0;

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i * (n + 1) + j] = a[i - 1] === b[j - 1]
				? at(i - 1, j - 1) + 1
				: Math.max(at(i - 1, j), at(i, j - 1));
		}
	}

	// Trace back
	const result: DiffLine[] = [];
	let i = m;
	let j = n;
	while (i > 0 || j > 0) {
		const aLine = a[i - 1];
		const bLine = b[j - 1];
		if (i > 0 && j > 0 && aLine === bLine && at(i, j) === at(i - 1, j - 1) + 1) {
			result.push({ kind: "unchanged", text: aLine ?? "" });
			i--; j--;
		} else if (j > 0 && (i === 0 || at(i, j - 1) >= at(i - 1, j))) {
			result.push({ kind: "added", text: bLine ?? "" });
			j--;
		} else {
			result.push({ kind: "removed", text: aLine ?? "" });
			i--;
		}
	}
	return result.reverse();
};
