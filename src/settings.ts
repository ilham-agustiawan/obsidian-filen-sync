import { App, PluginSettingTab, Setting } from "obsidian";
import type FilenSyncPlugin from "./main";

export type SyncedFileRecord = {
	path: string;
	mtime: number;
	ctime: number;
	size: number;
	hash?: string;
};

export type FilenAuth = {
	email: string;
	masterKeys: string[];
	apiKey: string;
	publicKey: string;
	privateKey: string;
	authVersion: 1 | 2 | 3;
	baseFolderUUID: string;
	userId: number;
};

export type FilenSyncSettings = {
	email: string;
	remoteRoot: string;
	deviceId: string;
	vaultName: string;
	auth: FilenAuth | null;
	syncOnSave: boolean;
	syncOnSaveDelaySeconds: number;
	syncIntervalMinutes: number;
	syncStartupDelaySeconds: number;
};

const DEFAULT_REMOTE_ROOT = "/Apps/obsidian-filen-sync/default";

export const DEFAULT_SETTINGS: FilenSyncSettings = {
	email: "",
	remoteRoot: DEFAULT_REMOTE_ROOT,
	deviceId: "",
	vaultName: "default",
	auth: null,
	syncOnSave: false,
	syncOnSaveDelaySeconds: 5,
	syncIntervalMinutes: 0,
	syncStartupDelaySeconds: 0,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown, fallback: string): string =>
	typeof value === "string" ? value : fallback;

const readBoolean = (value: unknown, fallback: boolean): boolean =>
	typeof value === "boolean" ? value : fallback;

const readNumber = (value: unknown, fallback: number): number =>
	typeof value === "number" && Number.isFinite(value) ? value : fallback;

const clampNumber = (value: number, min: number, max: number): number =>
	Math.min(max, Math.max(min, value));

const readStringArray = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const readAuthVersion = (value: unknown): 1 | 2 | 3 | null => {
	if (value === 1 || value === 2 || value === 3) {
		return value;
	}

	return null;
};

const readFilenAuth = (value: unknown): FilenAuth | null => {
	if (!isRecord(value)) {
		return null;
	}

	const email = readString(value.email, "");
	const masterKeys = readStringArray(value.masterKeys);
	const apiKey = readString(value.apiKey, "");
	const publicKey = readString(value.publicKey, "");
	const privateKey = readString(value.privateKey, "");
	const authVersion = readAuthVersion(value.authVersion);
	const baseFolderUUID = readString(value.baseFolderUUID, "");
	const userId = readNumber(value.userId, 0);

	if (
		email.length === 0 ||
		masterKeys.length === 0 ||
		apiKey.length === 0 ||
		publicKey.length === 0 ||
		privateKey.length === 0 ||
		authVersion === null ||
		baseFolderUUID.length === 0 ||
		userId <= 0
	) {
		return null;
	}

	return {
		email,
		masterKeys,
		apiKey,
		publicKey,
		privateKey,
		authVersion,
		baseFolderUUID,
		userId,
	};
};

export const FilenSyncSettings = {
	fromSaved(value: unknown): FilenSyncSettings {
		if (!isRecord(value)) {
			return { ...DEFAULT_SETTINGS };
		}

		return {
			email: readString(value.email, DEFAULT_SETTINGS.email),
			remoteRoot: readString(value.remoteRoot, DEFAULT_REMOTE_ROOT),
			deviceId: readString(value.deviceId, ""),
			vaultName: readString(value.vaultName, DEFAULT_SETTINGS.vaultName),
			auth: readFilenAuth(value.auth),
			syncOnSave: readBoolean(value.syncOnSave, DEFAULT_SETTINGS.syncOnSave),
			syncOnSaveDelaySeconds: clampNumber(
				readNumber(value.syncOnSaveDelaySeconds, DEFAULT_SETTINGS.syncOnSaveDelaySeconds),
				1,
				30,
			),
			syncIntervalMinutes: readNumber(value.syncIntervalMinutes, DEFAULT_SETTINGS.syncIntervalMinutes),
			syncStartupDelaySeconds: readNumber(value.syncStartupDelaySeconds, DEFAULT_SETTINGS.syncStartupDelaySeconds),
		};
	},
} as const;

export class FilenSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: FilenSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── Account ─────────────────────────────────────────────────────────

		new Setting(containerEl).setName("Account").setHeading();

		new Setting(containerEl)
			.setName("Email")
			.setDesc("Your filen.io account email.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.email)
					.onChange(async (value) => {
						this.plugin.settings.email = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Password")
			.setDesc(
				this.plugin.hasSavedAuth()
					? "Credentials saved. Re-enter only to sign in to a different account."
					: "Enter once to authenticate. Credentials are saved locally after first sync.",
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder(this.plugin.hasSessionPassword() ? "••••••••" : "Password")
					.onChange((value) => {
						this.plugin.setSessionPassword(value);
					});
			});

		new Setting(containerEl)
			.setName("Two-factor code")
			.setDesc("Only needed if your account has 2FA enabled.")
			.addText((text) =>
				text
					.setPlaceholder("123456")
					.onChange((value) => {
						this.plugin.setSessionTwoFactorCode(value.trim());
					}),
			);

		const hasSavedAuth = this.plugin.hasSavedAuth();
		new Setting(containerEl)
			.setName(hasSavedAuth ? "Signed in" : "Not signed in")
			.setDesc(
				hasSavedAuth
					? `Signed in as ${this.plugin.settings.email}. Credentials stored in plugin data.`
					: "Enter your email and password above, then run a sync to authenticate.",
			)
			.addButton((button) =>
				button
					.setButtonText("Sign out")
					.setWarning()
					.setDisabled(!hasSavedAuth)
					.onClick(async () => {
						await this.plugin.clearSavedAuth();
						this.display();
					}),
			);

		// ── Advanced ─────────────────────────────────────────────────────────

		new Setting(containerEl).setName("Advanced").setHeading();

		new Setting(containerEl)
			.setName("Remote folder")
			.setDesc("Filen folder that mirrors the vault. Change only when syncing multiple separate vaults.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_REMOTE_ROOT)
					.setValue(this.plugin.settings.remoteRoot)
					.onChange(async (value) => {
						this.plugin.settings.remoteRoot = value.trim() || DEFAULT_REMOTE_ROOT;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Vault name")
			.setDesc("Label stored in the remote sync log to identify this vault.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.vaultName)
					.onChange(async (value) => {
						this.plugin.settings.vaultName = value.trim() || "default";
						await this.plugin.saveSettings();
					}),
			);

		// ── Auto-sync ────────────────────────────────────────────────────────

		new Setting(containerEl).setName("Auto-sync").setHeading();

		new Setting(containerEl)
			.setName("Sync on file save")
			.setDesc("Trigger a bidirectional sync after the active file changes.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnSave)
					.onChange(async (value) => {
						this.plugin.settings.syncOnSave = value;
						await this.plugin.saveSettings();
						this.plugin.refreshAutoSync();
					}),
			);

		const delaySetting = new Setting(containerEl);
		delaySetting
			.setName(`Sync on save delay (${this.plugin.settings.syncOnSaveDelaySeconds} sec)`)
			.setDesc("Wait this many seconds after the active file changes before syncing.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 30, 1)
					.setValue(this.plugin.settings.syncOnSaveDelaySeconds)
					.setDynamicTooltip()
					.onChange(async (value) => {
						delaySetting.setName(`Sync on save delay (${value} sec)`);
						this.plugin.settings.syncOnSaveDelaySeconds = value;
						await this.plugin.saveSettings();
						this.plugin.refreshAutoSync();
					}),
			);

		const formatInterval = (n: number) => (n === 0 ? "off" : `${n} min`);
		const intervalSetting = new Setting(containerEl);
		intervalSetting
			.setName(`Sync interval (${formatInterval(this.plugin.settings.syncIntervalMinutes)})`)
			.setDesc("Automatically sync in the background every set number of minutes. 0 to disable.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 60, 1)
					.setValue(this.plugin.settings.syncIntervalMinutes)
					.setDynamicTooltip()
					.onChange(async (value) => {
						intervalSetting.setName(`Sync interval (${formatInterval(value)})`);
						this.plugin.settings.syncIntervalMinutes = value;
						await this.plugin.saveSettings();
						this.plugin.refreshAutoSync();
					}),
			);

		new Setting(containerEl)
			.setName("Startup sync delay (seconds)")
			.setDesc("Sync once after this many seconds after Obsidian loads. 0 to disable. Takes effect on next restart.")
			.addText((text) =>
				text
					.setPlaceholder("0")
					.setValue(String(this.plugin.settings.syncStartupDelaySeconds))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (Number.isFinite(parsed) && parsed >= 0) {
							this.plugin.settings.syncStartupDelaySeconds = parsed;
							await this.plugin.saveSettings();
						}
					}),
			);

		// ── Actions ──────────────────────────────────────────────────────────

		new Setting(containerEl).setName("Actions").setHeading();

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Verify credentials and remote folder are reachable.")
			.addButton((button) =>
				button
					.setButtonText("Test")
					.onClick(() => {
						void this.plugin.testConnection();
					}),
			);

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Compare local and remote. Apply the changed side; keep conflict copies when both changed.")
			.addButton((button) =>
				button
					.setButtonText("Sync")
					.setCta()
					.onClick(() => {
						void this.plugin.syncNow();
					}),
			);

		new Setting(containerEl)
			.setName("Push changed local files")
			.setDesc("Upload local changes only. Unchanged and remote-only files stay untouched.")
			.addButton((button) =>
				button
					.setButtonText("Push")
					.onClick(() => {
						void this.plugin.pushLocalChanges();
					}),
			);

		new Setting(containerEl)
			.setName("Pull changed remote files")
			.setDesc("Download remote changes only. Unchanged and local-only files stay untouched.")
			.addButton((button) =>
				button
					.setButtonText("Pull")
					.onClick(() => {
						void this.plugin.pullRemoteChanges();
					}),
			);
	}
}
