import { Notice, Plugin } from "obsidian";
import { FilenSyncSettings, FilenSyncSettingTab } from "./settings";
import { FilenJournalStore } from "./filen-store";
import { SyncEngine } from "./sync-engine";

export default class FilenSyncPlugin extends Plugin {
	settings: FilenSyncSettings;
	private sessionPassword = "";
	private sessionTwoFactorCode = "";
	private statusBarItemEl: HTMLElement | null = null;
	private syncEngine: SyncEngine | null = null;

	async onload() {
		await this.loadSettings();
		this.statusBarItemEl = this.addStatusBarItem();
		this.setStatus("Idle");

		this.addRibbonIcon("sync", "Sync with filen", () => {
			void this.syncNow();
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
			name: "Push local changes",
			callback: () => {
				void this.pushLocalChanges();
			},
		});

		this.addCommand({
			id: "pull-remote-changes",
			name: "Pull remote changes",
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

	private async syncNow() {
		await this.runSyncTask("Sync", async (engine) => {
			const pulled = await engine.pull();
			const pushed = await engine.push();
			return `pulled ${pulled.applied}, conflicts ${pulled.conflicts}, pushed ${pushed.entries}`;
		});
	}

	private async pushLocalChanges() {
		await this.runSyncTask("Push", async (engine) => {
			const result = await engine.push();
			return `pushed ${result.entries}`;
		});
	}

	private async pullRemoteChanges() {
		await this.runSyncTask("Pull", async (engine) => {
			const result = await engine.pull();
			return `pulled ${result.applied}, conflicts ${result.conflicts}`;
		});
	}

	private async testConnection() {
		await this.runSyncTask("Connection", async (engine) => {
			await engine.testRemote();
			return "ok";
		});
	}

	private async runSyncTask(label: string, task: (engine: SyncEngine) => Promise<string>) {
		try {
			this.setStatus(`${label}...`);
			const engine = this.getSyncEngine();
			const result = await task(engine);
			this.setStatus(result);
			new Notice(`${label}: ${result}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			this.setStatus(`${label} failed`);
			console.error(`${label} failed`, error);
			new Notice(`${label} failed: ${message}`);
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
			const store = new FilenJournalStore({
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
				settings: this.settings,
				saveSettings: () => this.saveSettings(),
				remote: store,
			});
		}

		return this.syncEngine;
	}

	private setStatus(value: string) {
		this.statusBarItemEl?.setText(`Filen sync: ${value}`);
	}
}
