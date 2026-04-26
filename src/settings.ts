import { App, PluginSettingTab, Setting } from "obsidian";
import type FilenSyncPlugin from "./main";
import { DEFAULT_IGNORE_PATTERNS, normalizeIgnorePatterns } from "./path-filters";

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
	ignorePatterns: string[];
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
	ignorePatterns: [...DEFAULT_IGNORE_PATTERNS],
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
			return {
				...DEFAULT_SETTINGS,
				ignorePatterns: [...DEFAULT_SETTINGS.ignorePatterns],
			};
		}

		return {
			email: readString(value.email, DEFAULT_SETTINGS.email),
			remoteRoot: readString(value.remoteRoot, DEFAULT_REMOTE_ROOT),
			deviceId: readString(value.deviceId, ""),
			vaultName: readString(value.vaultName, DEFAULT_SETTINGS.vaultName),
			ignorePatterns:
				"ignorePatterns" in value
					? normalizeIgnorePatterns(readStringArray(value.ignorePatterns))
					: [...DEFAULT_SETTINGS.ignorePatterns],
			auth: readFilenAuth(value.auth),
			syncOnSave: readBoolean(value.syncOnSave, DEFAULT_SETTINGS.syncOnSave),
			syncOnSaveDelaySeconds: clampNumber(
				readNumber(value.syncOnSaveDelaySeconds, DEFAULT_SETTINGS.syncOnSaveDelaySeconds),
				5,
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
		containerEl.addClass("filen-sync-settings");

		const intro = containerEl.createDiv({ cls: "filen-sync-settings-hero" });
		intro.createDiv({ text: "Filen Sync", cls: "filen-sync-settings-hero-title" });
		intro.createEl("p", {
			text: "Keep this vault mirrored in Filen with an Obsidian-native flow: connect once, review activity, then run sync on demand or in the background.",
		});

		this.renderAccountSection(containerEl);
		this.renderSyncSection(containerEl);
		this.renderAutoSyncSection(containerEl);
		this.renderActionsSection(containerEl);
	}

	private renderAccountSection(containerEl: HTMLElement): void {
		const section = createSection(
			containerEl,
			"Account and authentication",
			"Connect your Filen account once. Password and 2FA stay in memory for the current Obsidian session only.",
		);

		if (this.plugin.hasSavedAuth()) {
			const card = section.createDiv({ cls: "filen-sync-settings-card is-connected" });
			const header = card.createDiv({ cls: "filen-sync-settings-card-header" });
			header.createEl("div", { text: "Connected", cls: "filen-sync-settings-card-badge" });
			header.createEl("div", {
				text: `Connected as ${this.plugin.settings.email}`,
				cls: "filen-sync-settings-card-title",
			});
			card.createEl("p", {
				text: "Your saved Filen session is stored in plugin data so you do not need to re-enter your password on every launch.",
				cls: "filen-sync-settings-card-copy",
			});
			const actions = card.createDiv({ cls: "filen-sync-settings-card-actions" });
			const disconnect = actions.createEl("button", { text: "Disconnect" });
			disconnect.addClass("mod-warning");
			disconnect.addEventListener("click", () => {
				void (async () => {
					await this.plugin.clearSavedAuth();
					this.display();
				})();
			});
			card.createEl("p", {
				text: "To switch accounts, disconnect first, then enter the new account email and password below.",
				cls: "filen-sync-settings-card-note",
			});

			new Setting(section)
				.setName("Account email")
				.setDesc("Saved with your authenticated Filen session.")
				.addText((text) => text.setValue(this.plugin.settings.email).setDisabled(true));
			return;
		}

		new Setting(section)
			.setName("Email")
			.setDesc("Your Filen account email.")
			.addText((text) =>
				text
					.setPlaceholder("name@example.com")
					.setValue(this.plugin.settings.email)
					.onChange(async (value) => {
						this.plugin.settings.email = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(section)
			.setName("Password")
			.setDesc("Used once to authenticate. It is never stored in plugin settings.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder(this.plugin.hasSessionPassword() ? "••••••••" : "Password")
					.onChange((value) => {
						this.plugin.setSessionPassword(value);
					});
			});

		new Setting(section)
			.setName("Two-factor code")
			.setDesc("Only needed if your Filen account uses 2FA.")
			.addText((text) =>
				text.setPlaceholder("123456").onChange((value) => {
					this.plugin.setSessionTwoFactorCode(value.trim());
				}),
			);
	}

	private renderSyncSection(containerEl: HTMLElement): void {
		const section = createSection(
			containerEl,
			"Sync strategy",
			"Use Sync now for the standard bidirectional flow. Push and pull remain available in the Actions section and the command palette when you want one-way control.",
		);

		new Setting(section)
			.setName("Remote folder")
			.setDesc("Filen folder that mirrors this vault. Keep separate folders for separate vaults.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_REMOTE_ROOT)
					.setValue(this.plugin.settings.remoteRoot)
					.onChange(async (value) => {
						this.plugin.settings.remoteRoot = value.trim() || DEFAULT_REMOTE_ROOT;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(section)
			.setName("Vault name")
			.setDesc("Stored in the sync log so Filen can tell one vault device from another.")
			.addText((text) =>
				text.setValue(this.plugin.settings.vaultName).onChange(async (value) => {
					this.plugin.settings.vaultName = value.trim() || "default";
					await this.plugin.saveSettings();
				}),
			);

		new Setting(section)
			.setName("Ignore paths")
			.setDesc("One vault-relative path or glob per line. Exact paths also ignore subfolders. Defaults skip Obsidian cache and workspace state files.")
			.addTextArea((text) => {
				text
					.setPlaceholder(DEFAULT_IGNORE_PATTERNS.join("\n"))
					.setValue(this.plugin.settings.ignorePatterns.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.ignorePatterns = normalizeIgnorePatterns(value.split(/\r?\n/u));
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 4;
				text.inputEl.cols = 40;
			});

		const note = section.createDiv({ cls: "filen-sync-settings-note" });
		note.createEl("strong", { text: "Conflict handling" });
		note.createSpan({ text: " When both sides changed, Filen Sync keeps a local conflict copy before applying the chosen side." });
		section.createEl("p", {
			text: "The Filen Sync plugin data folder is always ignored automatically.",
			cls: "filen-sync-settings-note",
		});
	}

	private renderAutoSyncSection(containerEl: HTMLElement): void {
		const section = createSection(
			containerEl,
			"Auto-sync",
			"Match the feel of Obsidian Sync with a few lightweight background triggers. Keep them conservative for large vaults.",
		);

		new Setting(section)
			.setName("Sync on file save")
			.setDesc("Run a bidirectional sync shortly after the active file changes.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncOnSave).onChange(async (value) => {
					this.plugin.settings.syncOnSave = value;
					await this.plugin.saveSettings();
					this.plugin.refreshAutoSync();
				}),
			);

		const delaySetting = new Setting(section);
		delaySetting
			.setName(`Sync on save delay (${this.plugin.settings.syncOnSaveDelaySeconds} sec)`)
			.setDesc("Wait this long after a save before syncing. Minimum 5 seconds.")
			.addSlider((slider) =>
				slider
					.setLimits(5, 30, 1)
					.setValue(this.plugin.settings.syncOnSaveDelaySeconds)
					.setDynamicTooltip()
					.onChange(async (value) => {
						delaySetting.setName(`Sync on save delay (${value} sec)`);
						this.plugin.settings.syncOnSaveDelaySeconds = value;
						await this.plugin.saveSettings();
						this.plugin.refreshAutoSync();
					}),
			);

		const intervalSetting = new Setting(section);
		intervalSetting
			.setName(`Background sync interval (${formatInterval(this.plugin.settings.syncIntervalMinutes)})`)
			.setDesc("Run a background sync every set number of minutes. Set to 0 to disable.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 60, 1)
					.setValue(this.plugin.settings.syncIntervalMinutes)
					.setDynamicTooltip()
					.onChange(async (value) => {
						intervalSetting.setName(`Background sync interval (${formatInterval(value)})`);
						this.plugin.settings.syncIntervalMinutes = value;
						await this.plugin.saveSettings();
						this.plugin.refreshAutoSync();
					}),
			);

		new Setting(section)
			.setName("Sync after startup")
			.setDesc("Delay the first automatic sync after Obsidian launches. Set to 0 to disable. Takes effect on the next restart.")
			.addText((text) =>
				text.setPlaceholder("0").setValue(String(this.plugin.settings.syncStartupDelaySeconds)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (Number.isFinite(parsed) && parsed >= 0) {
						this.plugin.settings.syncStartupDelaySeconds = parsed;
						await this.plugin.saveSettings();
						this.plugin.refreshAutoSync();
					}
				}),
			);
	}

	private renderActionsSection(containerEl: HTMLElement): void {
		const section = createSection(
			containerEl,
			"Actions",
			"Manual controls stay available for first syncs, one-way recovery, and spot-checking your Filen connection.",
		);

		new Setting(section)
			.setName("Test connection")
			.setDesc("Verify that your Filen account and remote folder are reachable.")
			.addButton((button) =>
				button.setButtonText("Test").onClick(() => {
					void this.plugin.testConnection();
				}),
			);

		new Setting(section)
			.setName("Open activity log")
			.setDesc("Review the latest scan summary and recent per-file activity.")
			.addButton((button) =>
				button.setButtonText("Open").onClick(() => {
					void this.plugin.openProgressView();
				}),
			);

		new Setting(section)
			.setName("Sync now")
			.setDesc("Compare local and remote changes, then apply the needed uploads, downloads, and deletes.")
			.addButton((button) =>
				button.setButtonText("Sync").setCta().onClick(() => {
					void this.plugin.syncNow();
				}),
			);

		new Setting(section)
			.setName("Push changed local files")
			.setDesc("Upload local changes only.")
			.addButton((button) =>
				button.setButtonText("Push").onClick(() => {
					void this.plugin.pushLocalChanges();
				}),
			);

		new Setting(section)
			.setName("Pull changed remote files")
			.setDesc("Download remote changes only.")
			.addButton((button) =>
				button.setButtonText("Pull").onClick(() => {
					void this.plugin.pullRemoteChanges();
				}),
			);
	}
}

const createSection = (containerEl: HTMLElement, title: string, description: string): HTMLElement => {
	const section = containerEl.createDiv({ cls: "filen-sync-settings-section" });
	section.createDiv({ text: title, cls: "filen-sync-settings-section-title" });
	section.createEl("p", { text: description, cls: "filen-sync-settings-section-description" });
	return section;
};

const formatInterval = (minutes: number): string => (minutes === 0 ? "Off" : `${minutes} min`);
