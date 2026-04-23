import { Menu, Notice, Plugin, TAbstractFile, TFile } from "obsidian";
import { SyncDb } from "./db";
import { FilenRemoteFs } from "./fs-remote";
import { FileVersionModal } from "./file-version-modal";
import { FILEN_SYNC_PROGRESS_VIEW_TYPE, FilenSyncProgressView, type SyncViewState } from "./progress-view";
import { FilenSyncSettings, FilenSyncSettingTab } from "./settings";
import { SyncEngine, type SyncProgress } from "./sync-engine";

export default class FilenSyncPlugin extends Plugin {
	settings: FilenSyncSettings;
	private db: SyncDb = SyncDb.open("__init__"); // replaced in onload
	private sessionPassword = "";
	private sessionTwoFactorCode = "";
	private statusBarItemEl: HTMLElement | null = null;
	private syncEngine: SyncEngine | null = null;
	private isSyncing = false;
	private syncProgress: SyncProgress | null = null;
	private syncViewState: SyncViewState = {
		label: "Idle",
		status: "Waiting",
		progress: null,
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
		this.setStatus("Idle");

		this.addRibbonIcon("sync", "Filen sync: sync now", () => {
			void this.syncNow();
		});

		this.addRibbonIcon("history", "Filen sync: file versions", () => {
			void this.openActiveFileVersions();
		});

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
			name: "Open sync progress",
			callback: () => {
				void this.openProgressView();
			},
		});

		this.addCommand({
			id: "open-active-file-versions",
			name: "Open active file versions",
			callback: () => {
				void this.openActiveFileVersions();
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				this.addFileMenuItems(menu, file);
			}),
		);

		this.addSettingTab(new FilenSyncSettingTab(this.app, this));
	}

	onunload() {
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
		this.settings.auth = null;
		await this.saveSettings();
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

	private async runSyncTask(label: string, task: (engine: SyncEngine) => Promise<string>) {
		if (this.isSyncing) {
			new Notice("Sync already in progress.");
			return;
		}

		this.isSyncing = true;
		this.syncProgress = null;
		this.updateViewState(label, "Starting", null, []);
		void this.openProgressView();
		try {
			this.setStatus(`${label}...`);
			const engine = this.getSyncEngine();
			const result = await task(engine);
			this.syncProgress = null;
			this.updateViewState(label, result, null, this.syncViewState.rows);
			this.setStatus(result);
			new Notice(`${label}: ${result}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			this.syncProgress = null;
			this.updateViewState(label, `${label} failed`, null, this.syncViewState.rows);
			this.setStatus(`${label} failed`);
			console.error(`${label} failed`, error);
			if (message.includes("API key") || message.includes("auth expired")) {
				this.syncEngine?.close();
				this.syncEngine = null;
			}
			new Notice(`${label} failed: ${message}`);
		} finally {
			this.isSyncing = false;
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
				},
			});

			this.syncEngine = new SyncEngine({
				app: this.app,
				db: this.db,
				settings: this.settings,
				remote: store,
			});
		}

		return this.syncEngine;
	}

	private updateSyncProgress(label: string, progress: SyncProgress) {
		this.syncProgress = progress;
		const rows = this.syncViewState.rows.filter((row) => row.path !== progress.path);
		rows.push({
			path: progress.path,
			status: progress.state,
			operation: progress.operation,
			detail: progress.detail,
			at: progress.at,
			active: progress.state === "active",
		});
		this.updateViewState(label, `File ${progress.current} of ${progress.total}`, progress, rows);
		this.setStatus(`${label} ${progress.current}/${progress.total}: ${progress.path}`);
	}

	private updateViewState(label: string, status: string, progress: SyncProgress | null, rows: SyncViewState["rows"]) {
		this.syncViewState = { label, status, progress, rows };
		const leaves = this.app.workspace.getLeavesOfType(FILEN_SYNC_PROGRESS_VIEW_TYPE);
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof FilenSyncProgressView) {
				view.updateState(this.syncViewState);
			}
		}
	}

	private async openProgressView() {
		const leaf = this.app.workspace.getLeftLeaf(false);
		if (leaf === null) {
			return;
		}
		await leaf.setViewState({
			type: FILEN_SYNC_PROGRESS_VIEW_TYPE,
			active: true,
		});
		const view = leaf.view;
		if (view instanceof FilenSyncProgressView) {
			view.updateState(this.syncViewState);
		}
	}

	private async openActiveFileVersions() {
		const file = this.app.workspace.getActiveFile();
		if (file === null) {
			new Notice("No active file.");
			return;
		}

		const remote = this.getSyncEngine().remote;
		const modal = new FileVersionModal({
			app: this.app,
			remote,
			path: file.path,
			onRestored: async () => {
				await this.syncNow();
			},
			confirmRestore: async (version) =>
				window.confirm(`Restore version from ${new Date(version.timestamp).toLocaleString()} for ${file.path}? Current content will be replaced.`),
			confirmDelete: async (version) =>
				window.confirm(`Delete version from ${new Date(version.timestamp).toLocaleString()} for ${file.path}? This cannot be undone.`),
		});
		modal.open();
	}

	private addFileMenuItems(menu: Menu, file: TAbstractFile) {
		if (!(file instanceof TFile)) {
			return;
		}

		menu.addItem((item) => {
			item.setTitle("Open file versions");
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
				await this.syncNow();
			},
			confirmRestore: async (version) =>
				window.confirm(`Restore version from ${new Date(version.timestamp).toLocaleString()} for ${path}? Current content will be replaced.`),
			confirmDelete: async (version) =>
				window.confirm(`Delete version from ${new Date(version.timestamp).toLocaleString()} for ${path}? This cannot be undone.`),
		});
		modal.open();
	}

	private setStatus(value: string) {
		this.statusBarItemEl?.setText(`Filen sync: ${value}`);
	}
}
