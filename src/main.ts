import { type App, type EventRef, Menu, Modal, Notice, Plugin, TAbstractFile, TFile, setIcon } from "obsidian";
import { SyncDb } from "./db";
import { FilenRemoteFs } from "./fs-remote";
import { FileVersionModal } from "./file-version-modal";
import { FilenSyncSetupModal } from "./onboarding-modal";
import {
	FILEN_SYNC_PROGRESS_VIEW_TYPE,
	FilenSyncProgressView,
	type SyncActivityRow,
	type SyncMetrics,
	type SyncViewState,
} from "./progress-view";
import { FilenSyncSettings, FilenSyncSettingTab } from "./settings";
import { SyncEngine, type SyncProgress } from "./sync-engine";

type StatusBarKind = "idle" | "syncing" | "success" | "warning" | "error";

type StatusBarState = {
	kind: StatusBarKind;
	text: string;
	detail: string;
	updatedAt: number | null;
};

export default class FilenSyncPlugin extends Plugin {
	settings: FilenSyncSettings;
	private db: SyncDb = SyncDb.open("__init__"); // replaced in onload
	private sessionPassword = "";
	private sessionTwoFactorCode = "";
	private statusBarItemEl: HTMLElement | null = null;
	private statusBarIconEl: HTMLElement | null = null;
	private statusBarTextEl: HTMLElement | null = null;
	private statusBarState: StatusBarState = {
		kind: "idle",
		text: "Set up Filen",
		detail: "Open settings to connect your Filen account.",
		updatedAt: null,
	};
	private syncEngine: SyncEngine | null = null;
	private isSyncing = false;
	private debounceTimer: number | null = null;
	private intervalId: number | null = null;
	private startupTimerId: number | null = null;
	private vaultEventRefs: EventRef[] = [];
	private workspaceEventRefs: EventRef[] = [];
	private pendingAutoSync = false;
	private lastActiveFilePath: string | null = null;
	private syncProgress: SyncProgress | null = null;
	private setupPromptShown = false;
	private syncActivityCounter = 0;
	private syncViewState: SyncViewState = {
		label: "Idle",
		status: "Waiting for next sync",
		detail: "No sync has run yet.",
		progress: null,
		latestScanAt: null,
		metrics: createEmptyMetrics(),
		rows: [],
	};

	async onload() {
		this.db = SyncDb.open(this.app.vault.getName());
		await this.loadSettings();
		this.registerView(
			FILEN_SYNC_PROGRESS_VIEW_TYPE,
			(leaf) => new FilenSyncProgressView(leaf),
		);
		this.statusBarItemEl = this.addStatusBarItem();
		this.initializeStatusBar();
		this.setDefaultStatus();

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => {
				void this.syncNow();
			},
		});

		this.addCommand({
			id: "push-local-changes",
			name: "Push changed local files",
			callback: () => {
				void this.pushLocalChanges();
			},
		});

		this.addCommand({
			id: "pull-remote-changes",
			name: "Pull changed remote files",
			callback: () => {
				void this.pullRemoteChanges();
			},
		});

		this.addCommand({
			id: "test-filen-connection",
			name: "Test Filen connection",
			callback: () => {
				void this.testConnection();
			},
		});

		this.addCommand({
			id: "open-sync-progress",
			name: "Open sync activity",
			callback: () => {
				void this.openProgressView();
			},
		});

		this.addCommand({
			id: "toggle-sync-on-save",
			name: "Toggle sync on save",
			callback: () => {
				void this.toggleSyncOnSave();
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				this.addFileMenuItems(menu, file);
			}),
		);

		this.addSettingTab(new FilenSyncSettingTab(this.app, this));
		this.setupAutoSync();
		this.renderStatusBar();
		this.app.workspace.onLayoutReady(() => {
			this.maybePromptForSetup();
		});
	}

	onunload() {
		this.teardownAutoSync();
		this.syncEngine?.close();
		this.syncEngine = null;
	}

	setSessionPassword(value: string) {
		this.sessionPassword = value;
		this.syncEngine?.close();
		this.syncEngine = null;
	}

	setSessionTwoFactorCode(value: string) {
		this.sessionTwoFactorCode = value;
		this.syncEngine?.close();
		this.syncEngine = null;
	}

	hasSessionPassword(): boolean {
		return this.sessionPassword.length > 0;
	}

	hasSavedAuth(): boolean {
		return this.settings.auth !== null;
	}

	async clearSavedAuth() {
		this.syncEngine?.close();
		this.syncEngine = null;
		this.sessionPassword = "";
		this.sessionTwoFactorCode = "";
		this.settings.auth = null;
		await this.saveSettings();
		this.setStatus("Not connected", "idle", "Open settings to connect your Filen account.", null);
	}

	async loadSettings() {
		const saved: unknown = await this.loadData();
		this.settings = FilenSyncSettings.fromSaved(saved);

		if (this.settings.deviceId.length === 0) {
			this.settings.deviceId = crypto.randomUUID();
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async syncNow() {
		await this.runSyncTask("Sync", async (engine) => {
			const result = await engine.sync("bidirectional", (progress) => {
				this.updateSyncProgress("Sync", progress);
			});
			if (result.applied === 0 && result.conflicts === 0) {
				return "up to date";
			}

			const parts: string[] = [];
			if (result.applied > 0) {
				parts.push(`applied ${result.applied}`);
			}
			if (result.conflicts > 0) {
				parts.push(`${result.conflicts} conflict(s)`);
			}
			return parts.join(", ");
		});
	}

	async pushLocalChanges() {
		await this.runSyncTask("Push", async (engine) => {
			const result = await engine.sync("push-local", (progress) => {
				this.updateSyncProgress("Push", progress);
			});
			return result.applied > 0 ? `applied ${result.applied}` : "nothing to push";
		});
	}

	async pullRemoteChanges() {
		await this.runSyncTask("Pull", async (engine) => {
			const result = await engine.sync("pull-remote", (progress) => {
				this.updateSyncProgress("Pull", progress);
			});
			return result.applied > 0 ? `applied ${result.applied}` : "nothing to pull";
		});
	}

	async testConnection() {
		await this.runSyncTask("Connection test", async (engine) => {
			await engine.testRemote();
			return "connection ok";
		});
	}

	openSettingsTab(): void {
		const settingManager = (this.app as App & {
			setting: { open: () => void; openTabById: (id: string) => void };
		}).setting;
		settingManager.open();
		settingManager.openTabById(this.manifest.id);
	}

	public async openProgressView() {
		const existingLeaf = this.app.workspace.getLeavesOfType(FILEN_SYNC_PROGRESS_VIEW_TYPE)[0];
		const leaf = existingLeaf ?? this.app.workspace.getLeftLeaf(false);
		if (leaf === null) {
			return;
		}
		await this.app.workspace.revealLeaf(leaf);
		await leaf.setViewState({
			type: FILEN_SYNC_PROGRESS_VIEW_TYPE,
			active: true,
		});
		const view = leaf.view;
		if (view instanceof FilenSyncProgressView) {
			view.updateState(this.syncViewState);
		}
	}

	setupAutoSync(): void {
		const { syncOnSave, syncOnSaveDelaySeconds, syncIntervalMinutes, syncStartupDelaySeconds } = this.settings;
		const activeFile = this.app.workspace.getActiveFile();
		this.lastActiveFilePath = activeFile?.path ?? null;

		if (syncOnSave) {
			this.workspaceEventRefs.push(this.app.workspace.on("file-open", (file) => {
				this.lastActiveFilePath = file?.path ?? null;
			}));

			const handler = (file: TAbstractFile, oldPath?: string) => {
				if (!this.isActiveFileEvent(file, oldPath)) return;
				this.scheduleAutoSync(syncOnSaveDelaySeconds * 1000);
			};
			this.vaultEventRefs.push(this.app.vault.on("modify", handler));
			this.vaultEventRefs.push(this.app.vault.on("create", handler));
			this.vaultEventRefs.push(this.app.vault.on("delete", handler));
			this.vaultEventRefs.push(this.app.vault.on("rename", handler));
		}

		if (syncIntervalMinutes > 0) {
			this.intervalId = window.setInterval(() => {
				this.requestAutoSync();
			}, syncIntervalMinutes * 60 * 1000);
		}

		if (syncStartupDelaySeconds > 0) {
			this.startupTimerId = window.setTimeout(() => {
				this.startupTimerId = null;
				this.requestAutoSync();
			}, syncStartupDelaySeconds * 1000);
		}
	}

	private teardownAutoSync(): void {
		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		if (this.startupTimerId !== null) {
			window.clearTimeout(this.startupTimerId);
			this.startupTimerId = null;
		}
		for (const ref of this.vaultEventRefs) this.app.vault.offref(ref);
		this.vaultEventRefs = [];
		for (const ref of this.workspaceEventRefs) this.app.workspace.offref(ref);
		this.workspaceEventRefs = [];
		this.pendingAutoSync = false;
	}

	refreshAutoSync(): void {
		this.teardownAutoSync();
		this.setupAutoSync();
		this.renderStatusBar();
	}

	private async toggleSyncOnSave(): Promise<void> {
		this.settings.syncOnSave = !this.settings.syncOnSave;
		await this.saveSettings();
		this.refreshAutoSync();
		new Notice(`Sync on save: ${this.settings.syncOnSave ? "enabled" : "disabled"}`);
	}

	private async autoSyncTask(engine: SyncEngine): Promise<string> {
		const result = await engine.sync("bidirectional", (progress) => {
			this.updateSyncProgress("Auto-sync", progress);
		});
		if (result.applied === 0 && result.conflicts === 0) return "up to date";
		const parts: string[] = [];
		if (result.applied > 0) parts.push(`applied ${result.applied}`);
		if (result.conflicts > 0) parts.push(`${result.conflicts} conflict(s)`);
		return parts.join(", ");
	}

	private scheduleAutoSync(delayMs: number): void {
		if (this.isSyncing) {
			this.pendingAutoSync = true;
			return;
		}

		if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			this.requestAutoSync();
		}, delayMs);
	}

	private requestAutoSync(): void {
		if (!this.hasAutoSyncEnabled()) return;

		if (this.isSyncing) {
			this.pendingAutoSync = true;
			return;
		}

		void this.runSyncTask("Auto-sync", (engine) => this.autoSyncTask(engine), true);
	}

	private runPendingAutoSync(): void {
		if (!this.pendingAutoSync || !this.hasAutoSyncEnabled()) return;

		this.pendingAutoSync = false;
		this.requestAutoSync();
	}

	private hasAutoSyncEnabled(): boolean {
		return this.settings.syncOnSave || this.settings.syncIntervalMinutes > 0 || this.settings.syncStartupDelaySeconds > 0;
	}

	private isActiveFileEvent(file: TAbstractFile, oldPath?: string): boolean {
		const activePath = this.app.workspace.getActiveFile()?.path ?? this.lastActiveFilePath;
		if (activePath === null) return false;

		return file.path === activePath || oldPath === activePath;
	}

	private async runSyncTask(
		label: string,
		task: (engine: SyncEngine) => Promise<string>,
		silent = false,
	) {
		if (this.isSyncing) {
			if (!silent) new Notice("Sync already in progress.");
			return;
		}

		this.isSyncing = true;
		this.syncProgress = null;
		this.updateViewState({
			...this.syncViewState,
			label,
			status: "Starting",
			detail: `Starting ${label.toLowerCase()}...`,
			progress: null,
			latestScanAt: Date.now(),
			metrics: createEmptyMetrics(),
		});
		this.setStatus(`${label} in progress`, "syncing", `Starting ${label.toLowerCase()}...`);
		if (!silent) void this.openProgressView();
		try {
			const engine = this.getSyncEngine();
			const result = await task(engine);
			this.syncProgress = null;
			this.updateViewState({
				...this.syncViewState,
				label,
				status: result,
				detail: describeSyncCompletion(label, result),
				progress: null,
				latestScanAt: Date.now(),
			});
			this.setStatus(
				result,
				result.includes("conflict") ? "warning" : "success",
				`${label} finished: ${result}`,
			);
			if (!silent) new Notice(`${label}: ${result}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			this.syncProgress = null;
			this.updateViewState({
				...this.syncViewState,
				label,
				status: `${label} failed`,
				detail: message,
				progress: null,
				latestScanAt: Date.now(),
			});
			this.setStatus(`${label} failed`, "error", message);
			console.error(`${label} failed`, error);
			if (message.includes("API key") || message.includes("auth expired")) {
				this.syncEngine?.close();
				this.syncEngine = null;
			}
			if (!silent) new Notice(`${label} failed: ${message}`);
		} finally {
			this.isSyncing = false;
			this.runPendingAutoSync();
		}
	}

	private getSyncEngine(): SyncEngine {
		if (this.settings.email.length === 0) {
			throw new Error("Filen email missing. Add it in plugin settings.");
		}

		if (this.settings.auth === null && this.sessionPassword.length === 0) {
			throw new Error("Filen password missing. Enter it once in plugin settings.");
		}

		if (this.syncEngine === null) {
			const store = new FilenRemoteFs({
				email: this.settings.email,
				password: this.sessionPassword,
				twoFactorCode: this.sessionTwoFactorCode,
				remoteRoot: this.settings.remoteRoot,
				auth: this.settings.auth,
				saveAuth: async (auth) => {
					this.settings.auth = auth;
					this.settings.email = auth.email;
					await this.saveSettings();
					if (!this.isSyncing) {
						this.setDefaultStatus();
					} else {
						this.renderStatusBar();
					}
				},
			});

			this.syncEngine = new SyncEngine({
				app: this.app,
				db: this.db,
				pluginId: this.manifest.id,
				settings: this.settings,
				remote: store,
			});
		}

		return this.syncEngine;
	}

	private updateSyncProgress(label: string, progress: SyncProgress) {
		this.syncProgress = progress;
		if (progress.phase === "scan") {
			this.updateViewState({
				...this.syncViewState,
				label,
				status: "Scanning",
				detail: progress.detail,
				progress,
				latestScanAt: progress.at,
			});
			this.setStatus(`${label} in progress`, "syncing", progress.detail);
			return;
		}

		let rows = this.syncViewState.rows;
		let metrics = this.syncViewState.metrics;

		if (shouldLogProgressRow(progress)) {
			rows = appendActivityRow(rows, {
				id: `${progress.at}-${this.syncActivityCounter++}`,
				source: label,
				path: progress.path,
				status: progress.state,
				operation: progress.operation,
				detail: progress.detail,
				at: progress.at,
			});
			metrics = updateMetrics(metrics, progress);
		}

		this.updateViewState({
			...this.syncViewState,
			label,
			status: `File ${progress.current} of ${progress.total}`,
			detail: progress.detail,
			progress,
			latestScanAt: progress.at,
			metrics,
			rows,
		});
		this.setStatus(`${label} in progress`, "syncing", `${progress.current}/${progress.total} · ${progress.path}`);
	}

	private updateViewState(state: SyncViewState) {
		this.syncViewState = state;
		const leaves = this.app.workspace.getLeavesOfType(FILEN_SYNC_PROGRESS_VIEW_TYPE);
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof FilenSyncProgressView) {
				view.updateState(this.syncViewState);
			}
		}
	}

	private addFileMenuItems(menu: Menu, file: TAbstractFile) {
		if (!(file instanceof TFile)) {
			return;
		}

		menu.addSeparator();

		menu.addItem((item) => {
			item.setTitle("Filen: sync now");
			item.setIcon("refresh-cw");
			item.onClick(() => {
				void this.syncNow();
			});
		});

		menu.addItem((item) => {
			item.setTitle("Filen: file versions");
			item.setIcon("history");
			item.onClick(() => {
				void this.openFileVersions(file.path);
			});
		});
	}

	private async openFileVersions(path: string) {
		const remote = this.getSyncEngine().remote;
		const modal = new FileVersionModal({
			app: this.app,
			remote,
			path,
			onRestored: async () => {
				await this.db.deleteFile(path);
				await this.pullRemoteChanges();
			},
			confirmRestore: async (version) => confirmAction(
				this.app,
				"Restore file version",
				`Restore version from ${new Date(version.timestamp).toLocaleString()} for ${path}? Current content will be replaced.`,
				"Restore",
			),
			confirmDelete: async (version) => confirmAction(
				this.app,
				"Delete file version",
				`Delete version from ${new Date(version.timestamp).toLocaleString()} for ${path}? This cannot be undone.`,
				"Delete",
			),
		});
		modal.open();
	}

	private initializeStatusBar(): void {
		if (this.statusBarItemEl === null) {
			return;
		}

		this.statusBarItemEl.empty();
		this.statusBarItemEl.addClass("filen-sync-status-item");
		this.statusBarIconEl = this.statusBarItemEl.createSpan({ cls: "filen-sync-status-icon" });
		this.statusBarTextEl = this.statusBarItemEl.createSpan({ cls: "filen-sync-status-text" });
		this.registerDomEvent(this.statusBarItemEl, "click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.openStatusBarMenu(event);
		});
	}

	private openStatusBarMenu(event: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) => {
			item.setTitle("Sync now");
			item.setIcon("refresh-cw");
			item.onClick(() => {
				void this.syncNow();
			});
		});
		menu.addItem((item) => {
			item.setTitle("Open sync activity");
			item.setIcon("list");
			item.onClick(() => {
				void this.openProgressView();
			});
		});
		menu.addItem((item) => {
			item.setTitle(this.settings.syncOnSave ? "Disable sync on save" : "Enable sync on save");
			item.setIcon("clock-3");
			item.onClick(() => {
				void this.toggleSyncOnSave();
			});
		});
		menu.addSeparator();
		menu.addItem((item) => {
			item.setTitle(this.hasSavedAuth() ? "Open Filen Sync settings" : "Connect Filen");
			item.setIcon("settings");
			item.onClick(() => {
				this.openSettingsTab();
			});
		});
		menu.showAtMouseEvent(event);
	}

	private maybePromptForSetup(): void {
		if (this.hasSavedAuth() || this.setupPromptShown) {
			return;
		}

		this.setupPromptShown = true;
		new FilenSyncSetupModal({
			app: this.app,
			onOpenSettings: () => this.openSettingsTab(),
		}).open();
	}

	private setDefaultStatus(): void {
		if (this.hasSavedAuth()) {
			this.setStatus("Ready", "idle", `Connected as ${this.settings.email}.`, null);
			return;
		}

		this.setStatus("Set up Filen", "idle", "Open settings to connect your Filen account.", null);
	}

	private setStatus(text: string, kind: StatusBarKind, detail: string, updatedAt: number | null = Date.now()): void {
		this.statusBarState = { kind, text, detail, updatedAt };
		this.renderStatusBar();
	}

	private renderStatusBar(): void {
		if (this.statusBarItemEl === null || this.statusBarIconEl === null || this.statusBarTextEl === null) {
			return;
		}

		setIcon(this.statusBarIconEl, iconForStatus(this.statusBarState.kind));
		this.statusBarTextEl.setText(`Filen ${this.statusBarState.text}`);
		this.statusBarItemEl.removeClass("is-idle", "is-syncing", "is-success", "is-warning", "is-error");
		this.statusBarItemEl.addClass(`is-${this.statusBarState.kind}`);
		const tooltip = this.buildStatusTooltip();
		this.statusBarItemEl.setAttr("aria-label", tooltip);
		this.statusBarItemEl.setAttr("title", tooltip);
	}

	private buildStatusTooltip(): string {
		const lines = [
			this.statusBarState.text,
			this.statusBarState.detail,
			this.hasSavedAuth() ? `Account: ${this.settings.email}` : "Account: not connected",
			`Auto-sync: ${this.describeAutoSync()}`,
		];

		if (this.statusBarState.updatedAt !== null) {
			lines.push(`Updated: ${formatStatusTime(this.statusBarState.updatedAt)}`);
		}

		lines.push("Click for actions.");
		return lines.join("\n");
	}

	private describeAutoSync(): string {
		const parts: string[] = [];
		if (this.settings.syncOnSave) {
			parts.push(`on save (${this.settings.syncOnSaveDelaySeconds}s delay)`);
		}
		if (this.settings.syncIntervalMinutes > 0) {
			parts.push(`every ${this.settings.syncIntervalMinutes} min`);
		}
		if (this.settings.syncStartupDelaySeconds > 0) {
			parts.push(`${this.settings.syncStartupDelaySeconds}s after startup`);
		}
		return parts.length > 0 ? parts.join(", ") : "off";
	}
}

const confirmAction = (app: App, title: string, message: string, confirmText: string): Promise<boolean> =>
	new Promise((resolve) => {
		new ConfirmActionModal(app, title, message, confirmText, resolve).open();
	});

class ConfirmActionModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly title: string,
		private readonly message: string,
		private readonly confirmText: string,
		private readonly resolve: (confirmed: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: this.title });
		this.contentEl.createEl("p", { text: this.message });

		const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
		const cancelButton = actions.createEl("button", { text: "Cancel" });
		cancelButton.addEventListener("click", () => {
			this.finish(false);
		});

		const confirmButton = actions.createEl("button", { text: this.confirmText });
		confirmButton.addClass("mod-warning");
		confirmButton.addEventListener("click", () => {
			this.finish(true);
		});
	}

	onClose(): void {
		if (!this.resolved) {
			this.finish(false);
		}
	}

	private finish(confirmed: boolean): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolve(confirmed);
		this.close();
	}
}

const iconForStatus = (kind: StatusBarKind): string => {
	switch (kind) {
		case "syncing":
			return "refresh-cw";
		case "success":
			return "check";
		case "warning":
			return "alert-triangle";
		case "error":
			return "x-circle";
		case "idle":
		default:
			return "cloud";
	}
};

const formatStatusTime = (epochMs: number): string =>
	new Date(epochMs).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});

const MAX_ACTIVITY_ROWS = 200;

const createEmptyMetrics = (): SyncMetrics => ({
	uploaded: 0,
	downloaded: 0,
	deleted: 0,
	conflicts: 0,
	failed: 0,
});

const shouldLogProgressRow = (progress: SyncProgress): progress is SyncProgress & { state: "done" | "failed" } =>
	progress.phase === "sync" && (progress.state === "failed" || (progress.state === "done" && progress.operation !== "noop"));

const appendActivityRow = (rows: SyncActivityRow[], row: SyncActivityRow): SyncActivityRow[] =>
	[row, ...rows].slice(0, MAX_ACTIVITY_ROWS);

const updateMetrics = (metrics: SyncMetrics, progress: SyncProgress): SyncMetrics => {
	if (progress.state === "failed") {
		return { ...metrics, failed: metrics.failed + 1 };
	}

	switch (progress.operation) {
		case "upload":
			return { ...metrics, uploaded: metrics.uploaded + 1 };
		case "download":
			return { ...metrics, downloaded: metrics.downloaded + 1 };
		case "delete-local":
		case "delete-remote":
			return { ...metrics, deleted: metrics.deleted + 1 };
		case "conflict":
			return { ...metrics, conflicts: metrics.conflicts + 1 };
		default:
			return metrics;
	}
};

const describeSyncCompletion = (label: string, result: string): string => {
	if (result === "up to date") {
		return `No file changes detected during the latest ${label.toLowerCase()}.`;
	}

	if (result.startsWith("nothing to ")) {
		return `${capitalize(result)} during the latest ${label.toLowerCase()}.`;
	}

	return `${label} finished: ${result}.`;
};

const capitalize = (value: string): string => value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
