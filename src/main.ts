import { type App, type EventRef, Menu, Modal, Notice, Plugin, TAbstractFile, TFile, setIcon } from "obsidian";
import { handleCrashRecoveryOnStartup, detectIncompleteSyncs, rollbackIncompleteSync, discardIncompleteSync } from "./crash-recovery";
import { SyncDb } from "./db";
import {
	generateReport,
	formatReportForClipboard,
	getLastError,
	hasCriticalFailure,
	runStartupChecks,
	setLastError,
} from "./diagnostics";
import { FilenRemoteFs } from "./fs-remote";
import { ConflictResolutionModal, findConflictCopies } from "./conflict-resolution-modal";
import { FileVersionModal } from "./file-version-modal";
import { FilenSyncSetupModal } from "./onboarding-modal";
import { createSyncPathFilter } from "./path-filters";
import {
	FILEN_SYNC_PROGRESS_VIEW_TYPE,
	FilenSyncProgressView,
	type SyncActivityRow,
	type SyncMetrics,
	type SyncViewState,
} from "./progress-view";
import { FilenSyncSettings, FilenSyncSettingTab, getVaultRemoteRoot } from "./settings";
import { SyncEngine, type ConflictCopy, type SyncMode, type SyncOperation, type SyncPlanPreview, type SyncProgress } from "./sync-engine";
import { SyncJournal, type SyncJournal as ISyncJournal } from "./sync-journal";

/**
 * Retry a function with exponential backoff for transient errors.
 */
const hasSavedVaultName = (value: unknown): value is { vaultName: string } =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	typeof (value as { vaultName?: unknown }).vaultName === "string" &&
	(value as { vaultName: string }).vaultName.trim().length > 0;

async function withRetry<T>(
	fn: () => Promise<T>,
	options: { maxRetries?: number; baseDelayMs?: number; shouldRetry?: (error: unknown) => boolean } = {},
): Promise<T> {
	const { maxRetries = 2, baseDelayMs = 1000 } = options;
	const shouldRetry = options.shouldRetry ?? isTransientError;

	let lastError: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			if (attempt === maxRetries || !shouldRetry(error)) {
				throw error;
			}
			const delay = baseDelayMs * Math.pow(2, attempt);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
	throw lastError;
}

/**
 * Heuristic for transient errors that are worth retrying.
 */
function isTransientError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const lower = message.toLowerCase();
	const transientPatterns = [
		"network",
		"timeout",
		"econnreset",
		"econnrefused",
		"etimedout",
		"enotfound",
		"dns",
		"socket",
		"tls",
		"abort",
		"fetch failed",
		"too many requests",
		"rate limit",
		"503",
		"502",
		"504",
		"429",
		"internal server error",
	];
	return transientPatterns.some((pattern) => lower.includes(pattern));
}

type StatusBarKind = "idle" | "syncing" | "success" | "warning" | "error";

type StatusBarState = {
	kind: StatusBarKind;
	text: string;
	detail: string;
	updatedAt: number | null;
};

const AUTO_SYNC_SUCCESS_COOLDOWN_MS = 30_000;
const AUTO_SYNC_FAILURE_BASE_BACKOFF_MS = 30_000;
const AUTO_SYNC_FAILURE_MAX_BACKOFF_MS = 5 * 60_000;

export default class FilenSyncPlugin extends Plugin {
	settings: FilenSyncSettings;
	private db!: SyncDb;
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
	private journal!: ISyncJournal;
	private syncEngine: SyncEngine | null = null;
	private isSyncing = false;
	private debounceTimer: number | null = null;
	private intervalId: number | null = null;
	private startupTimerId: number | null = null;
	private vaultEventRefs: EventRef[] = [];
	private workspaceEventRefs: EventRef[] = [];
	private autoSyncDomCleanup: (() => void)[] = [];
	private pendingAutoSync = false;
	private nextAutoSyncAllowedAt = 0;
	private autoSyncTransientFailureCount = 0;
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
		this.db = await SyncDb.open(this.app.vault.getName());
		await this.db.runMigrations();
		this.journal = SyncJournal.open(this.app.vault.getName());
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
			name: "Test filen connection",
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

		this.addCommand({
			id: "preview-sync-plan",
			name: "Preview sync plan",
			callback: () => {
				void this.previewSyncPlan();
			},
		});

		this.addCommand({
			id: "repair-sync-state",
			name: "Repair sync state",
			callback: () => {
				void this.repairSyncState();
			},
		});

		this.addCommand({
			id: "copy-diagnostics-report",
			name: "Copy diagnostics report",
			callback: () => {
				void this.copyDiagnosticsReport();
			},
		});

		this.addCommand({
			id: "resolve-conflicts",
			name: "Resolve sync conflicts",
			callback: () => {
				this.openConflictResolver();
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
			void this.runStartupDiagnostics();
			void handleCrashRecoveryOnStartup(this.app, this.journal);
			this.notifyUnresolvedConflicts();
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

		if (!hasSavedVaultName(saved)) {
			this.settings.vaultName = this.app.vault.getName();
			await this.saveSettings();
		}

		if (this.settings.deviceId.length === 0) {
			this.settings.deviceId = window.crypto.randomUUID();
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	refreshSyncTarget(): void {
		this.syncEngine?.close();
		this.syncEngine = null;
	}

	async syncNow() {
		await this.runSyncTask("Sync", async (engine) => {
			if (!await this.confirmSyncPreflight(engine, "bidirectional", false)) {
				return "cancelled";
			}

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
			return { status: parts.join(", "), conflictCopies: result.conflictCopies };
		});
	}

	async pushLocalChanges() {
		await this.runSyncTask("Push", async (engine) => {
			if (!await this.confirmSyncPreflight(engine, "push-local", false)) {
				return "cancelled";
			}

			const result = await engine.sync("push-local", (progress) => {
				this.updateSyncProgress("Push", progress);
			});
			return result.applied > 0 ? `applied ${result.applied}` : "nothing to push";
		});
	}

	async pullRemoteChanges() {
		await this.runSyncTask("Pull", async (engine) => {
			if (!await this.confirmSyncPreflight(engine, "pull-remote", false)) {
				return "cancelled";
			}

			const result = await engine.sync("pull-remote", (progress) => {
				this.updateSyncProgress("Pull", progress);
			});
			if (result.conflictCopies.length > 0) {
				const status = result.applied > 0 ? `applied ${result.applied}, ${result.conflicts} conflict(s)` : `${result.conflicts} conflict(s)`;
				return { status, conflictCopies: result.conflictCopies };
			}
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

	/**
	 * Repair sync state by rolling back incomplete sync batches
	 * and pruning old journal entries.
	 */
	public async repairSyncState(): Promise<void> {
		try {
			const check = await detectIncompleteSyncs(this.journal);
			if (!check.hasIncompleteBatches) {
				new Notice("Sync state is clean. No incomplete operations found.");
				return;
			}

			const count = check.batches.length;
			const confirmed = await new Promise<boolean>((resolve) => {
				const modal = new Modal(this.app);
				modal.modalEl.addClass("filen-sync-repair-modal");
				modal.onOpen = () => {
					modal.contentEl.empty();
					modal.contentEl.createEl("h2", { text: "Repair sync state" });
					modal.contentEl.createEl("p", {
						text: `Found ${count} incomplete sync batch(es) with ${check.entryCount} pending operations. These were left from a previous interrupted sync.`,
					});
					modal.contentEl.createEl("p", {
						text: "Rolling back will mark all incomplete operations as cancelled. No files will be modified.",
						cls: "filen-sync-repair-note",
					});

					const actions = modal.contentEl.createDiv({ cls: "modal-button-container" });
					const cancelBtn = actions.createEl("button", { text: "Cancel" });
					cancelBtn.addEventListener("click", () => { modal.close(); resolve(false); });

					const rollbackBtn = actions.createEl("button", { text: "Roll back incomplete syncs" });
					rollbackBtn.addClass("mod-cta");
					rollbackBtn.addEventListener("click", () => { modal.close(); resolve(true); });
				};
				modal.open();
			});

			if (!confirmed) return;

			for (const batch of check.batches) {
				await rollbackIncompleteSync(this.journal, batch.id);
				await discardIncompleteSync(this.journal, batch.id);
			}

			new Notice(`Sync state repaired: ${count} incomplete batch(es) rolled back.`);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Repair failed: ${message}`);
		}
	}

	/**
	 * Preview what a sync would do and show in a modal.
	 */
	public async previewSyncPlan(): Promise<void> {
		try {
			const engine = this.getSyncEngine();
			const plan = await engine.previewSyncPlan("bidirectional");

			new SyncPlanPreviewModal(this.app, plan).open();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Preview failed: ${message}`);
		}
	}

	public async promptInitialSyncChoice(): Promise<void> {
		try {
			if ((await this.db.getAllFiles()).size > 0) {
				return;
			}

			const engine = this.getSyncEngine();
			const plan = await engine.previewSyncPlan("bidirectional");
			const actionable = plan.summary.uploads + plan.summary.downloads + plan.summary.conflicts;
			if (actionable === 0) {
				return;
			}

			const choice = await chooseInitialSyncMode(this.app, plan);
			switch (choice) {
				case "sync":
					await this.syncNow();
					break;
				case "push":
					await this.pushLocalChanges();
					break;
				case "pull":
					await this.pullRemoteChanges();
					break;
				case null:
					break;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Initial sync check failed: ${message}`);
		}
	}

	/**
	 * Copy a sanitized diagnostics report to the clipboard.
	 * No vault contents, file paths, or auth secrets are included.
	 */
	public async copyDiagnosticsReport(): Promise<void> {
		try {
			const report = await generateReport({
				app: this.app,
				pluginVersion: this.manifest.version,
				settingsSnap: {
					email: this.settings.email,
					remoteRoot: getVaultRemoteRoot(this.settings.remoteRoot, this.settings.vaultName),
					vaultName: this.settings.vaultName,
					hasAuth: this.hasSavedAuth(),
					syncOnSave: this.settings.syncOnSave,
					syncOnSaveDelaySeconds: this.settings.syncOnSaveDelaySeconds,
					syncIntervalMinutes: this.settings.syncIntervalMinutes,
					syncStartupDelaySeconds: this.settings.syncStartupDelaySeconds,
					ignorePatternsCount: this.settings.ignorePatterns.length,
				},
				lastError: getLastError(),
			});

			const text = formatReportForClipboard(report);
			await navigator.clipboard.writeText(text);
			new Notice("Diagnostics report copied to clipboard.");
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Failed to generate report: ${message}`);
			console.error("Obsidian Filen Sync: diagnostics report failed", error);
		}
	}

	private openConflictResolver(): void {
		const copies = findConflictCopies(this.app);
		if (copies.length === 0) {
			new Notice("No unresolved sync conflicts found.");
			return;
		}
		new ConflictResolutionModal(this.app, copies).open();
	}

	private notifyUnresolvedConflicts(): void {
		const copies = findConflictCopies(this.app);
		if (copies.length === 0) return;
		const fragment = new DocumentFragment();
		const container = fragment.createEl("div", { cls: "filen-sync-conflict-notice" });
		container.createEl("span", { text: `Filen Sync: ${copies.length} unresolved conflict${copies.length === 1 ? "" : "s"} in vault.` });
		container.createEl("br");
		const link = container.createEl("a", { text: "Resolve now →", href: "#", cls: "filen-sync-conflict-notice-link" });
		const notice = new Notice(fragment, 0);
		link.addEventListener("click", (e) => {
			e.preventDefault();
			notice.hide();
			new ConflictResolutionModal(this.app, copies).open();
		});
	}

	/**
	 * Run environment checks on startup and show a notice if something is wrong.
	 * Only fires after layout is ready so we can show UI.
	 */
	private async runStartupDiagnostics(): Promise<void> {
		try {
			const checks = await runStartupChecks();
			const failures = checks.filter((check) => !check.ok);

			if (failures.length === 0) return;

			// Log all results for debugging
			console.warn("Obsidian Filen Sync startup diagnostics:", checks);

			if (hasCriticalFailure(checks)) {
				new Notice(
					// eslint-disable-next-line obsidianmd/ui/sentence-case
					`Obsidian Filen Sync: critical issue detected. Open settings → copy diagnostics report for details.`,
					10000,
				);
			} else if (failures.length > 0) {
				const label = failures[0]?.label ?? "Unknown";
				new Notice(
					`Obsidian Filen Sync: "${label}" check failed. Some features may not work.`,
					8000,
				);
			}
		} catch {
			// Silent -- diagnostics are best-effort and should never block plugin load
		}
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
				if (!this.shouldAutoSyncForFileEvent(file, oldPath)) return;
				this.scheduleAutoSync(syncOnSaveDelaySeconds * 1000);
			};
			this.vaultEventRefs.push(this.app.vault.on("modify", handler));
			this.vaultEventRefs.push(this.app.vault.on("create", handler));
			this.vaultEventRefs.push(this.app.vault.on("delete", handler));
			this.vaultEventRefs.push(this.app.vault.on("rename", handler));
		}

		if (syncOnSave || syncIntervalMinutes > 0) {
			this.registerAutoSyncDomEvent(document, "visibilitychange", () => {
				if (document.visibilityState === "visible") {
					this.scheduleAutoSync(1000);
				}
			});
			this.registerAutoSyncDomEvent(window, "focus", () => {
				this.scheduleAutoSync(1000);
			});
			this.registerAutoSyncDomEvent(window, "online", () => {
				this.scheduleAutoSync(1000);
			});
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
		for (const cleanup of this.autoSyncDomCleanup) cleanup();
		this.autoSyncDomCleanup = [];
		this.pendingAutoSync = false;
		this.nextAutoSyncAllowedAt = 0;
		this.autoSyncTransientFailureCount = 0;
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

	private async autoSyncTask(engine: SyncEngine): Promise<string | { status: string; conflictCopies: ConflictCopy[] }> {
		if (!await this.confirmSyncPreflight(engine, "bidirectional", true)) {
			return "cancelled";
		}

		const result = await engine.sync("bidirectional", (progress) => {
			this.updateSyncProgress("Auto-sync", progress);
		});
		if (result.applied === 0 && result.conflicts === 0) return "up to date";
		const parts: string[] = [];
		if (result.applied > 0) parts.push(`applied ${result.applied}`);
		if (result.conflicts > 0) parts.push(`${result.conflicts} conflict(s)`);
		const status = parts.join(", ");
		return result.conflictCopies.length > 0 ? { status, conflictCopies: result.conflictCopies } : status;
	}

	private scheduleAutoSync(delayMs: number): void {
		this.pendingAutoSync = true;
		this.scheduleQueuedAutoSync(delayMs);
	}

	private requestAutoSync(): void {
		if (!this.hasAutoSyncEnabled()) return;
		if (!this.hasSavedAuth()) return;

		if (this.isSyncing) {
			this.pendingAutoSync = true;
			return;
		}

		this.pendingAutoSync = false;
		void this.runSyncTask("Auto-sync", (engine) => this.autoSyncTask(engine), true, { autoSync: true });
	}

	private runPendingAutoSync(): void {
		if (!this.pendingAutoSync || !this.hasAutoSyncEnabled()) return;

		this.scheduleQueuedAutoSync(0);
	}

	private scheduleQueuedAutoSync(delayMs: number): void {
		if (!this.pendingAutoSync || !this.hasAutoSyncEnabled() || !this.hasSavedAuth()) {
			return;
		}

		if (this.isSyncing) {
			return;
		}

		const now = Date.now();
		const cooldownDelayMs = Math.max(0, this.nextAutoSyncAllowedAt - now);
		const waitMs = Math.max(delayMs, cooldownDelayMs);
		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			this.requestAutoSync();
		}, waitMs);
	}

	private setAutoSyncCooldown(delayMs: number): void {
		this.nextAutoSyncAllowedAt = Date.now() + delayMs;
	}

	private resetAutoSyncBackoff(): void {
		this.autoSyncTransientFailureCount = 0;
		this.setAutoSyncCooldown(AUTO_SYNC_SUCCESS_COOLDOWN_MS);
	}

	private bumpAutoSyncBackoff(error: unknown): void {
		this.autoSyncTransientFailureCount += 1;
		const delayMs = getAutoSyncBackoffMs(error, this.autoSyncTransientFailureCount);
		this.setAutoSyncCooldown(delayMs);
	}

	private hasAutoSyncEnabled(): boolean {
		return this.settings.syncOnSave || this.settings.syncIntervalMinutes > 0 || this.settings.syncStartupDelaySeconds > 0;
	}

	private shouldAutoSyncForFileEvent(file: TAbstractFile, oldPath?: string): boolean {
		if (!(file instanceof TFile)) return false;

		const pathFilter = createSyncPathFilter({
			configDir: this.app.vault.configDir,
			pluginId: this.manifest.id,
			ignorePatterns: this.settings.ignorePatterns,
		});
		if (pathFilter.isIgnored(file.path) || (oldPath !== undefined && pathFilter.isIgnored(oldPath))) {
			return false;
		}

		const activePath = this.app.workspace.getActiveFile()?.path ?? this.lastActiveFilePath;
		if (activePath === null) return true;

		return file.path === activePath || oldPath === activePath;
	}

	private registerAutoSyncDomEvent<K extends keyof WindowEventMap>(
		target: Window,
		type: K,
		listener: (event: WindowEventMap[K]) => void,
	): void;
	private registerAutoSyncDomEvent<K extends keyof DocumentEventMap>(
		target: Document,
		type: K,
		listener: (event: DocumentEventMap[K]) => void,
	): void;
	private registerAutoSyncDomEvent(
		target: Window | Document,
		type: string,
		listener: EventListener,
	): void {
		target.addEventListener(type, listener);
		this.autoSyncDomCleanup.push(() => target.removeEventListener(type, listener));
	}

	private async runSyncTask(
		label: string,
		task: (engine: SyncEngine) => Promise<string | { status: string; conflictCopies: ConflictCopy[] }>,
		silent = false,
		options: { autoSync?: boolean } = {},
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
			const raw = await withRetry(() => task(engine));
			const result = typeof raw === "string" ? raw : raw.status;
			const conflictCopies: ConflictCopy[] = typeof raw === "string" ? [] : raw.conflictCopies;
			if (result === "cancelled") {
				if (options.autoSync) {
					this.resetAutoSyncBackoff();
				}
				this.syncProgress = null;
				this.updateViewState({
					...this.syncViewState,
					label,
					status: `${label} cancelled`,
					detail: "No files were changed.",
					progress: null,
					latestScanAt: Date.now(),
				});
				this.setStatus(`${label} cancelled`, "warning", "No files were changed.");
				if (!silent) new Notice(`${label} cancelled.`);
				return;
			}
			if (options.autoSync) {
				this.resetAutoSyncBackoff();
			}
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
			if (conflictCopies.length > 0) {
				if (!silent) {
					new Notice(`${label}: ${result}`);
					new ConflictResolutionModal(this.app, conflictCopies).open();
				} else {
					const fragment = new DocumentFragment();
					const container = fragment.createEl("div", { cls: "filen-sync-conflict-notice" });
					container.createEl("span", { text: `${label}: ${result}` });
					container.createEl("br");
					const link = container.createEl("a", { text: "Resolve conflicts →", href: "#", cls: "filen-sync-conflict-notice-link" });
					const notice = new Notice(fragment, 0);
					link.addEventListener("click", (e) => {
						e.preventDefault();
						notice.hide();
						new ConflictResolutionModal(this.app, conflictCopies).open();
					});
				}
			} else if (!silent) {
				new Notice(`${label}: ${result}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			setLastError(`[${label}] ${message}`);
			if (options.autoSync && isTransientError(error)) {
				this.pendingAutoSync = true;
				this.bumpAutoSyncBackoff(error);
			}
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
			if (message.includes("API key") || message.includes("api key") || message.includes("auth expired")) {
				this.syncEngine?.close();
				this.syncEngine = null;
			}
			if (!silent) new Notice(`${label} failed: ${message}`);
		} finally {
			this.isSyncing = false;
			this.runPendingAutoSync();
		}
	}

	private async confirmSyncPreflight(engine: SyncEngine, mode: SyncMode, silent: boolean): Promise<boolean> {
		const plan = await engine.previewSyncPlan(mode);
		if (!await this.confirmInitialOverrideIfNeeded(plan, silent)) {
			return false;
		}
		if (!await this.confirmLocalDeletesIfNeeded(plan, silent)) {
			return false;
		}
		return true;
	}

	private async confirmInitialOverrideIfNeeded(plan: SyncPlanPreview, silent: boolean): Promise<boolean> {
		const overrides = plan.entries.filter((entry) =>
			(entry.operation === "conflict" && entry.detail.startsWith("No baseline;")) ||
			entry.detail.includes("replaced remote file") ||
			entry.detail.includes("replaced local file"),
		);

		if (overrides.length === 0) {
			return true;
		}

		const examples = overrides.slice(0, 5).map((entry) => entry.path).join(", ");
		const more = overrides.length > 5 ? `, and ${overrides.length - 5} more` : "";
		const message = `Initial sync found ${overrides.length} file(s) that exist both locally and in Filen with no previous sync baseline. Continuing may replace one side with the other. Review these paths first: ${examples}${more}.`;

		if (silent) {
			new Notice("Initial sync needs confirmation before replacing existing files. Run Sync now to continue.");
			return false;
		}

		return confirmAction(this.app, "Override existing files?", message, "Continue and override");
	}

	private async confirmLocalDeletesIfNeeded(plan: SyncPlanPreview, silent: boolean): Promise<boolean> {
		const localDeletes = plan.entries.filter((entry) => entry.operation === "delete-local");
		if (localDeletes.length === 0) {
			return true;
		}

		const examples = localDeletes.slice(0, 8).map((entry) => entry.path).join(", ");
		const more = localDeletes.length > 8 ? `, and ${localDeletes.length - 8} more` : "";
		const message = `This sync would delete ${localDeletes.length} local file(s) from this vault because they were deleted or are missing in Filen. Review these paths before continuing: ${examples}${more}.`;

		if (silent) {
			new Notice("Auto-sync skipped because it would delete local files. Run Sync now to review and confirm.");
			return false;
		}

		return confirmAction(this.app, "Delete local files?", message, "Delete local files");
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
				remoteRoot: getVaultRemoteRoot(this.settings.remoteRoot, this.settings.vaultName),
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
				journal: this.journal,
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
			item.setTitle(this.hasSavedAuth() ? "Open Obsidian Filen Sync settings" : "Connect Filen");
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
			this.setStatus("Ready", "success", `Connected as ${this.settings.email}.`, null);
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

		const iconOnly = isAllFilesSyncedStatus(this.statusBarState);
		setIcon(this.statusBarIconEl, iconForStatus(this.statusBarState, iconOnly));
		this.statusBarTextEl.setText(iconOnly ? "" : `Filen ${this.statusBarState.text}`);
		this.statusBarItemEl.removeClass("is-idle", "is-syncing", "is-success", "is-warning", "is-error");
		this.statusBarItemEl.addClass(`is-${this.statusBarState.kind}`);
		this.statusBarItemEl.toggleClass("is-icon-only", iconOnly);
		const tooltip = this.buildStatusTooltip();
		this.statusBarItemEl.setAttr("aria-label", tooltip);
		this.statusBarItemEl.setAttr("title", tooltip);
	}

	private buildStatusTooltip(): string {
		const statusText = isAllFilesSyncedStatus(this.statusBarState)
			? "All files synced"
			: this.statusBarState.text;
		const detailText = this.statusBarState.text === "Ready"
			? "No pending changes detected."
			: this.statusBarState.detail;

		const lines = [
			statusText,
			detailText,
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

type InitialSyncChoice = "sync" | "push" | "pull" | null;

const chooseInitialSyncMode = (app: App, plan: SyncPlanPreview): Promise<InitialSyncChoice> =>
	new Promise((resolve) => {
		new InitialSyncChoiceModal(app, plan, resolve).open();
	});

class InitialSyncChoiceModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly plan: SyncPlanPreview,
		private readonly resolve: (choice: InitialSyncChoice) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: "Choose initial sync direction" });
		this.contentEl.createEl("p", {
			text: "This vault has no previous Filen sync baseline. Choose how to handle existing local and remote files.",
		});

		const summary = this.contentEl.createEl("ul");
		summary.createEl("li", { text: `${this.plan.summary.uploads} local-only file(s) can be uploaded.` });
		summary.createEl("li", { text: `${this.plan.summary.downloads} remote-only file(s) can be downloaded.` });
		summary.createEl("li", { text: `${this.plan.summary.conflicts} same-path file(s) exist on both sides and may be overridden.` });

		this.contentEl.createEl("p", {
			text: "Use Sync both to mirror both sides. Use Upload local only to seed Filen from this vault. Use Download remote only to seed this vault from Filen.",
		});

		const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
		const laterButton = actions.createEl("button", { text: "Decide later" });
		laterButton.addEventListener("click", () => {
			this.finish(null);
		});

		const pullButton = actions.createEl("button", { text: "Download remote only" });
		pullButton.addEventListener("click", () => {
			this.finish("pull");
		});

		const pushButton = actions.createEl("button", { text: "Upload local only" });
		pushButton.addEventListener("click", () => {
			this.finish("push");
		});

		const syncButton = actions.createEl("button", { text: "Sync both" });
		syncButton.addClass("mod-cta");
		syncButton.addEventListener("click", () => {
			this.finish("sync");
		});
	}

	onClose(): void {
		if (!this.resolved) {
			this.finish(null);
		}
	}

	private finish(choice: InitialSyncChoice): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolve(choice);
		this.close();
	}
}

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

const isAllFilesSyncedStatus = (state: StatusBarState): boolean =>
	state.kind === "success" && (state.text === "up to date" || state.text === "Ready");

const iconForStatus = (state: StatusBarState, iconOnly = false): string => {
	if (iconOnly) {
		return "list-checks";
	}

	switch (state.kind) {
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

const getAutoSyncBackoffMs = (error: unknown, failureCount: number): number => {
	const retryAfterMs = readRetryAfterMs(error);
	if (retryAfterMs !== null) {
		return Math.min(Math.max(retryAfterMs, AUTO_SYNC_FAILURE_BASE_BACKOFF_MS), AUTO_SYNC_FAILURE_MAX_BACKOFF_MS);
	}

	return Math.min(
		AUTO_SYNC_FAILURE_BASE_BACKOFF_MS * Math.pow(2, Math.max(0, failureCount - 1)),
		AUTO_SYNC_FAILURE_MAX_BACKOFF_MS,
	);
};

const readRetryAfterMs = (error: unknown): number | null => {
	const message = error instanceof Error ? error.message : String(error);
	const secondsMatch = message.match(/retry[- ]after[^0-9]*(\d+)\s*(seconds?|secs?|s)\b/iu);
	const secondsValue = secondsMatch?.[1];
	if (secondsValue !== undefined) {
		return Number.parseInt(secondsValue, 10) * 1000;
	}

	const msMatch = message.match(/retry[- ]after[^0-9]*(\d+)\s*(milliseconds?|msecs?|ms)\b/iu);
	const msValue = msMatch?.[1];
	if (msValue !== undefined) {
		return Number.parseInt(msValue, 10);
	}

	return null;
};

const capitalize = (value: string): string => value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);

class SyncPlanPreviewModal extends Modal {
	constructor(app: App, private readonly plan: SyncPlanPreview) {
		super(app);
		this.modalEl.addClass("filen-sync-plan-modal");
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Sync plan preview" });
		contentEl.createEl("p", {
			text: `This is a dry-run preview. No changes will be applied. Mode: ${this.plan.mode}`,
			cls: "filen-sync-plan-description",
		});

		// Summary card
		const summary = contentEl.createDiv({ cls: "filen-sync-plan-summary" });
		const counts = this.plan.summary;
		const summaryItems: Array<{ label: string; count: number; cls: string }> = [
			{ label: "Uploads", count: counts.uploads, cls: "upload" },
			{ label: "Downloads", count: counts.downloads, cls: "download" },
			{ label: "Local deletes", count: counts.localDeletes, cls: "delete" },
			{ label: "Remote deletes", count: counts.remoteDeletes, cls: "delete" },
			{ label: "Conflicts", count: counts.conflicts, cls: "conflict" },
			{ label: "Skipped", count: counts.skipped, cls: "skipped" },
		];

		for (const item of summaryItems) {
			if (item.count > 0 || item.cls === "skipped") {
				const pill = summary.createDiv({ cls: `filen-sync-plan-pill ${item.cls}` });
				pill.createSpan({ text: String(item.count), cls: "filen-sync-plan-pill-count" });
				pill.createSpan({ text: item.label, cls: "filen-sync-plan-pill-label" });
			}
		}

		// Total
		const total = summary.createDiv({ cls: "filen-sync-plan-pill total" });
		total.createSpan({ text: String(counts.total), cls: "filen-sync-plan-pill-count" });
		total.createSpan({ text: "Total files", cls: "filen-sync-plan-pill-label" });

		// Warn about bulk deletes
		const bulkDeletes = counts.localDeletes + counts.remoteDeletes;
		if (bulkDeletes > 10) {
			const warning = contentEl.createDiv({ cls: "filen-sync-plan-warning" });
			warning.createSpan({ text: `⚠ ${bulkDeletes} files would be deleted. Review carefully before running sync.` });
		}

		// File list (limited to first 100)
		const entries = this.plan.entries.filter((e) => e.operation !== "noop");
		if (entries.length > 0) {
			const listHeader = contentEl.createDiv({ cls: "filen-sync-plan-list-header" });
			listHeader.createSpan({ text: `Changed files (${Math.min(entries.length, 100)} of ${entries.length})` });

			const list = contentEl.createDiv({ cls: "filen-sync-plan-list" });
			for (const entry of entries.slice(0, 100)) {
				const row = list.createDiv({ cls: "filen-sync-plan-row" });
				const icon = row.createSpan({ cls: `filen-sync-plan-icon ${entry.operation}` });
				setIcon(icon, iconForPlanOperation(entry.operation));
				row.createSpan({ text: entry.path, cls: "filen-sync-plan-path" });
				row.createSpan({ text: entry.detail, cls: "filen-sync-plan-detail" });
			}

			if (entries.length > 100) {
				contentEl.createDiv({
					text: `... and ${entries.length - 100} more files.`,
					cls: "filen-sync-plan-more",
				});
			}
		} else {
			contentEl.createDiv({
				text: "No changes detected. Your vault is in sync.",
				cls: "filen-sync-plan-empty",
			});
		}

		// Action buttons
		const actions = contentEl.createDiv({ cls: "modal-button-container" });
		const closeBtn = actions.createEl("button", { text: "Close" });
		closeBtn.addEventListener("click", () => this.close());

		const syncBtn = actions.createEl("button", { text: "Run sync now" });
		syncBtn.addClass("mod-cta");
		syncBtn.addEventListener("click", () => {
			this.close();
			// Access the plugin through the app to trigger sync
			const plugin = getFilenSyncPlugin(this.app);
			if (plugin) {
				void plugin.syncNow();
			}
		});
	}
}

/**
 * Look up the FilenSyncPlugin instance from the Obsidian app.
 */
function getFilenSyncPlugin(app: App): FilenSyncPlugin | null {
	const plugins = (app as unknown as Record<string, unknown>).plugins as Record<string, unknown> | undefined;
	if (plugins?.plugins) {
		const pluginMap = plugins.plugins as Record<string, unknown>;
		for (const plugin of Object.values(pluginMap)) {
			if (plugin instanceof FilenSyncPlugin) {
				return plugin;
			}
		}
	}
	return null;
}

const iconForPlanOperation = (operation: SyncOperation): string => {
	switch (operation) {
		case "upload": return "arrow-up";
		case "download": return "arrow-down";
		case "delete-local":
		case "delete-remote": return "trash-2";
		case "conflict": return "alert-triangle";
		default: return "check";
	}
};
