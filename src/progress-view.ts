import { ItemView, WorkspaceLeaf, type ViewStateResult } from "obsidian";
import type { SyncOperation, SyncProgress } from "./sync-engine";

export const FILEN_SYNC_PROGRESS_VIEW_TYPE = "filen-sync-progress-view";

export type SyncViewState = {
	label: string;
	status: string;
	progress: SyncProgress | null;
	rows: Array<{
		path: string;
		status: SyncProgress["state"];
		operation: SyncOperation;
		detail: string;
		at: number;
		active: boolean;
	}>;
};

export class FilenSyncProgressView extends ItemView {
	private operationFilter: SyncOperation | "all" = "change";
	private state: SyncViewState = {
		label: "Idle",
		status: "Waiting",
		progress: null,
		rows: [],
	};
	private stateFilter: SyncProgress["state"] | "all" = "done";

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return FILEN_SYNC_PROGRESS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Filen sync progress";
	}

	getIcon(): string {
		return "sync";
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	async onClose(): Promise<void> {
		this.containerEl.empty();
	}

	updateState(state: SyncViewState): void {
		this.state = state;
		this.render();
	}

	async setState(_state: unknown, _result: ViewStateResult): Promise<void> {
		this.render();
	}

	private render(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("filen-sync-progress-view");

		const header = containerEl.createDiv({ cls: "filen-sync-progress-header" });
		header.createEl("div", { text: this.state.label, cls: "filen-sync-progress-label" });
		header.createEl("div", { text: this.state.status, cls: "filen-sync-progress-status" });

		const progress = this.state.progress;
		const barWrap = containerEl.createDiv({ cls: "filen-sync-progress-bar-wrap" });
		const bar = barWrap.createDiv({ cls: "filen-sync-progress-bar" });
		if (progress !== null && progress.total > 0) {
			bar.style.width = `${Math.max(0, Math.min(100, (progress.current / progress.total) * 100))}%`;
		} else {
			bar.style.width = "0%";
		}

		const body = containerEl.createDiv({ cls: "filen-sync-progress-body" });
		body.createEl("div", {
			text: progress === null ? "No active sync" : `File ${progress.current} of ${progress.total}`,
			cls: "filen-sync-progress-line",
		});
		body.createEl("div", {
			text: progress === null ? "Queue idle" : progress.path,
			cls: "filen-sync-progress-path",
		});
		body.createEl("div", {
			text: progress === null ? "No operation" : progress.detail,
			cls: "filen-sync-progress-detail",
		});

		const filters = containerEl.createDiv({ cls: "filen-sync-progress-filters" });
		this.renderStateFilter(filters);
		this.renderOperationFilter(filters);

		const tableWrap = containerEl.createDiv({ cls: "filen-sync-progress-table-wrap" });
		const table = tableWrap.createEl("table", { cls: "filen-sync-progress-table" });
		const head = table.createTHead();
		const headRow = head.insertRow();
		headRow.createEl("th", { text: "File" });
		headRow.createEl("th", { text: "State" });
		headRow.createEl("th", { text: "Operation" });
		headRow.createEl("th", { text: "Updated" });
		const tbody = table.createTBody();
		const rows = this.filteredRows();

		if (rows.length === 0) {
			const row = tbody.insertRow();
			const cell = row.insertCell();
			cell.colSpan = 4;
			cell.textContent = this.state.rows.length === 0 ? "No file rows yet" : "No rows match filter";
			return;
		}

		for (const rowState of rows) {
			const row = tbody.insertRow();
			row.addClass("filen-sync-progress-row");
			if (rowState.active) {
				row.addClass("is-active");
			}

			const fileCell = row.insertCell();
			fileCell.createDiv({ text: rowState.path, cls: "filen-sync-progress-file" });

			const stateCell = row.insertCell();
			stateCell.createSpan({
				text: stateLabel(rowState.status),
				cls: `filen-sync-progress-badge state-${rowState.status}`,
			});

			const detailCell = row.insertCell();
			detailCell.createDiv({ text: rowState.detail, cls: "filen-sync-progress-detail" });

			const updatedCell = row.insertCell();
			updatedCell.textContent = formatTime(rowState.at);
		}
	}

	private renderStateFilter(parent: HTMLElement): void {
		const label = parent.createEl("label", { cls: "filen-sync-progress-filter" });
		label.createSpan({ text: "State" });
		const select = label.createEl("select");
		for (const option of STATE_FILTER_OPTIONS) {
			select.createEl("option", { text: option.label, value: option.value });
		}
		select.value = this.stateFilter;
		select.addEventListener("change", () => {
			this.stateFilter = readStateFilter(select.value);
			this.render();
		});
	}

	private renderOperationFilter(parent: HTMLElement): void {
		const label = parent.createEl("label", { cls: "filen-sync-progress-filter" });
		label.createSpan({ text: "Operation" });
		const select = label.createEl("select");
		for (const option of OPERATION_FILTER_OPTIONS) {
			select.createEl("option", { text: option.label, value: option.value });
		}
		select.value = this.operationFilter;
		select.addEventListener("change", () => {
			this.operationFilter = readOperationFilter(select.value);
			this.render();
		});
	}

	private filteredRows(): SyncViewState["rows"] {
		return this.state.rows.filter((row) => {
			const stateMatches = this.stateFilter === "all" || row.status === this.stateFilter;
			const operationMatches = this.operationFilter === "all" || row.operation === this.operationFilter;
			return stateMatches && operationMatches;
		});
	}
}

const STATE_FILTER_OPTIONS: Array<{ value: SyncProgress["state"] | "all"; label: string }> = [
	{ value: "done", label: "Done" },
	{ value: "all", label: "All" },
	{ value: "skipped", label: "Skipped" },
	{ value: "active", label: "Checking" },
	{ value: "queued", label: "Queued" },
	{ value: "failed", label: "Failed" },
];

const OPERATION_FILTER_OPTIONS: Array<{ value: SyncOperation | "all"; label: string }> = [
	{ value: "change", label: "Changed" },
	{ value: "all", label: "All" },
	{ value: "no-change", label: "Unchanged/ignored" },
];

const readStateFilter = (value: string): SyncProgress["state"] | "all" =>
	value === "all" || value === "queued" || value === "active" || value === "done" || value === "failed" || value === "skipped"
		? value
		: "done";

const readOperationFilter = (value: string): SyncOperation | "all" =>
	value === "all" || value === "change" || value === "no-change" ? value : "change";

const stateLabel = (state: SyncProgress["state"]): string => {
	switch (state) {
		case "queued":
			return "queued";
		case "active":
			return "checking";
		case "done":
			return "done";
		case "failed":
			return "failed";
		case "skipped":
			return "skipped";
	}
};

const formatTime = (epochMs: number): string => {
	const date = new Date(epochMs);
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};
