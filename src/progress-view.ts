import { ItemView, WorkspaceLeaf, setIcon, type ViewStateResult } from "obsidian";
import type { SyncOperation, SyncProgress } from "./sync-engine";

export const FILEN_SYNC_PROGRESS_VIEW_TYPE = "filen-sync-progress-view";

type OperationFilter = "all" | "upload" | "download" | "delete" | "conflict";

type StateFilter = "all" | "done" | "failed";

export type SyncMetrics = {
	uploaded: number;
	downloaded: number;
	deleted: number;
	conflicts: number;
	failed: number;
};

export type SyncActivityRow = {
	id: string;
	source: string;
	path: string;
	status: "done" | "failed";
	operation: SyncOperation;
	detail: string;
	at: number;
};

export type SyncViewState = {
	label: string;
	status: string;
	detail: string;
	progress: SyncProgress | null;
	latestScanAt: number | null;
	metrics: SyncMetrics;
	rows: SyncActivityRow[];
};

export class FilenSyncProgressView extends ItemView {
	private operationFilter: OperationFilter = "all";
	private stateFilter: StateFilter = "all";
	private state: SyncViewState = {
		label: "Idle",
		status: "Waiting for next sync",
		detail: "No sync has run yet.",
		progress: null,
		latestScanAt: null,
		metrics: emptyMetrics(),
		rows: [],
	};

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return FILEN_SYNC_PROGRESS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Filen sync activity";
	}

	getIcon(): string {
		return "refresh-cw";
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
		const scrollTop = containerEl.scrollTop;
		containerEl.empty();
		containerEl.addClass("filen-sync-progress-view");

		const progress = this.state.progress;

		const hero = containerEl.createDiv({ cls: "filen-sync-activity-hero" });
		const heroHeader = hero.createDiv({ cls: "filen-sync-activity-hero-header" });
		heroHeader.createEl("div", { text: `Latest scan · ${this.state.label}`, cls: "filen-sync-progress-label" });
		heroHeader.createEl("div", { text: this.state.status, cls: "filen-sync-progress-status" });

		const heroBody = hero.createDiv({ cls: "filen-sync-progress-body" });
		heroBody.createEl("div", {
			text: summaryLine(progress, this.state.latestScanAt),
			cls: "filen-sync-progress-line",
		});
		heroBody.createEl("div", {
			text: secondaryLine(this.state.label, progress, this.state.latestScanAt),
			cls: "filen-sync-progress-path",
		});
		heroBody.createEl("div", {
			text: this.state.detail,
			cls: "filen-sync-progress-detail",
		});

		const barWrap = hero.createDiv({ cls: "filen-sync-progress-bar-wrap" });
		const bar = barWrap.createDiv({ cls: "filen-sync-progress-bar" });
		bar.setCssProps({
			"--filen-sync-progress-width": progressWidth(progress),
		});

		const metrics = containerEl.createDiv({ cls: "filen-sync-activity-metrics" });
		this.renderMetric(metrics, "Uploaded", String(this.state.metrics.uploaded), "arrow-up");
		this.renderMetric(metrics, "Downloaded", String(this.state.metrics.downloaded), "arrow-down");
		this.renderMetric(metrics, "Deleted", String(this.state.metrics.deleted), "trash-2");
		this.renderMetric(metrics, "Conflicts", String(this.state.metrics.conflicts), "alert-triangle");
		this.renderMetric(metrics, "Failed", String(this.state.metrics.failed), "x-circle");

		const filters = containerEl.createDiv({ cls: "filen-sync-progress-filters" });
		this.renderStateFilter(filters);
		this.renderOperationFilter(filters);

		const section = containerEl.createDiv({ cls: "filen-sync-activity-section" });
		section.createEl("div", { text: "Per-file activity", cls: "filen-sync-activity-section-title" });
		section.createEl("div", {
			text: "Only uploads, downloads, deletes, conflicts, and failures are kept here. No-op auto-sync scans stay in the latest scan summary above.",
			cls: "filen-sync-activity-section-description",
		});

		const list = section.createDiv({ cls: "filen-sync-activity-list" });
		const rows = this.filteredRows();
		if (rows.length === 0) {
			list.createDiv({
				text: this.state.rows.length === 0
					? "No file activity yet. Run a sync or wait for the first real file change."
					: "No activity matches the current filters.",
				cls: "filen-sync-activity-empty",
			});
			window.requestAnimationFrame(() => {
				containerEl.scrollTop = scrollTop;
			});
			return;
		}

		for (const rowState of rows) {
			this.renderRow(list, rowState);
		}

		window.requestAnimationFrame(() => {
			containerEl.scrollTop = scrollTop;
		});
	}

	private renderMetric(parent: HTMLElement, label: string, value: string, icon: string): void {
		const card = parent.createDiv({ cls: "filen-sync-activity-metric" });
		const iconEl = card.createDiv({ cls: "filen-sync-activity-metric-icon" });
		setIcon(iconEl, icon);
		const body = card.createDiv({ cls: "filen-sync-activity-metric-body" });
		body.createEl("div", { text: value, cls: "filen-sync-activity-metric-value" });
		body.createEl("div", { text: label, cls: "filen-sync-activity-metric-label" });
	}

	private renderRow(parent: HTMLElement, rowState: SyncActivityRow): void {
		const row = parent.createDiv({ cls: "filen-sync-activity-row" });
		if (rowState.status === "failed") {
			row.addClass("is-failed");
		}

		const iconWrap = row.createDiv({ cls: "filen-sync-activity-row-icon" });
		setIcon(iconWrap, iconForRow(rowState));

		const content = row.createDiv({ cls: "filen-sync-activity-row-content" });
		const top = content.createDiv({ cls: "filen-sync-activity-row-top" });
		top.createEl("div", { text: titleForRow(rowState), cls: "filen-sync-activity-row-title" });
		top.createEl("div", { text: formatMeta(rowState), cls: "filen-sync-activity-row-time" });

		content.createEl("div", { text: rowState.path, cls: "filen-sync-activity-row-path" });
		content.createEl("div", { text: rowState.detail, cls: "filen-sync-activity-row-detail" });

		row.createSpan({
			text: stateLabel(rowState.status),
			cls: `filen-sync-progress-badge state-${rowState.status}`,
		});
	}

	private renderStateFilter(parent: HTMLElement): void {
		const label = parent.createEl("label", { cls: "filen-sync-progress-filter" });
		label.createSpan({ text: "Result" });
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
		label.createSpan({ text: "Activity" });
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

	private filteredRows(): SyncActivityRow[] {
		return [...this.state.rows]
			.filter((row) => {
				const stateMatches = this.stateFilter === "all" || row.status === this.stateFilter;
				const operationMatches = matchesOperationFilter(row.operation, this.operationFilter);
				return stateMatches && operationMatches;
			})
			.sort((left, right) => right.at - left.at);
	}
}

const STATE_FILTER_OPTIONS: Array<{ value: StateFilter; label: string }> = [
	{ value: "all", label: "All results" },
	{ value: "done", label: "Completed" },
	{ value: "failed", label: "Failed" },
];

const OPERATION_FILTER_OPTIONS: Array<{ value: OperationFilter; label: string }> = [
	{ value: "all", label: "All activity" },
	{ value: "upload", label: "Uploads" },
	{ value: "download", label: "Downloads" },
	{ value: "delete", label: "Deletes" },
	{ value: "conflict", label: "Conflicts" },
];

const readStateFilter = (value: string): StateFilter =>
	value === "all" || value === "done" || value === "failed" ? value : "all";

const readOperationFilter = (value: string): OperationFilter =>
	value === "all" || value === "upload" || value === "download" || value === "delete" || value === "conflict"
		? value
		: "all";

const matchesOperationFilter = (operation: SyncOperation, filter: OperationFilter): boolean => {
	if (filter === "all") return true;
	if (filter === "delete") return operation === "delete-local" || operation === "delete-remote";
	return operation === filter;
};

const stateLabel = (state: SyncActivityRow["status"]): string => {
	switch (state) {
		case "done":
			return "Done";
		case "failed":
			return "Failed";
	}
};

const titleForRow = (row: SyncActivityRow): string => {
	if (row.status === "failed") {
		return "Sync failed";
	}

	switch (row.operation) {
		case "upload":
			return "Uploaded";
		case "download":
			return "Downloaded";
		case "delete-local":
			return "Deleted locally";
		case "delete-remote":
			return "Deleted remotely";
		case "conflict":
			return "Conflict handled";
		case "scan":
			return "Scanning";
		case "noop":
		default:
			return "Activity";
	}
};

const iconForRow = (row: SyncActivityRow): string => {
	if (row.status === "failed") return "x-circle";

	switch (row.operation) {
		case "upload":
			return "arrow-up";
		case "download":
			return "arrow-down";
		case "delete-local":
		case "delete-remote":
			return "trash-2";
		case "conflict":
			return "alert-triangle";
		case "scan":
			return "search";
		case "noop":
		default:
			return "check";
	}
};

const progressWidth = (progress: SyncProgress | null): string => {
	if (progress === null || progress.total <= 0) return "0%";
	return `${Math.max(0, Math.min(100, (progress.current / progress.total) * 100))}%`;
};

const summaryLine = (progress: SyncProgress | null, latestScanAt: number | null): string => {
	if (progress !== null) {
		return progress.phase === "scan" ? "Scanning local, remote, and sync state" : `File ${progress.current} of ${progress.total}`;
	}
	if (latestScanAt === null) {
		return "No sync has run yet";
	}
	return `Completed ${formatDateTime(latestScanAt)}`;
};

const secondaryLine = (label: string, progress: SyncProgress | null, latestScanAt: number | null): string => {
	if (progress !== null) {
		return progress.path;
	}
	if (latestScanAt === null) {
		return "Waiting for the first sync";
	}
	return `Trigger: ${label}`;
};

const formatMeta = (row: SyncActivityRow): string => `${row.source} · ${formatTime(row.at)}`;

const formatTime = (epochMs: number): string => {
	const date = new Date(epochMs);
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

const formatDateTime = (epochMs: number): string => {
	const date = new Date(epochMs);
	return date.toLocaleString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		month: "short",
		day: "numeric",
	});
};

const emptyMetrics = (): SyncMetrics => ({
	uploaded: 0,
	downloaded: 0,
	deleted: 0,
	conflicts: 0,
	failed: 0,
});
