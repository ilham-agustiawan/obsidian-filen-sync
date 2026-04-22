import { App, PluginSettingTab, Setting } from "obsidian";
import type FilenSyncPlugin from "./main";

export type SyncedFileRecord = {
	path: string;
	mtime: number;
	ctime: number;
	size: number;
};

export type SyncState = {
	lastPulledKey: string;
	sentJournalKeys: string[];
	files: Record<string, SyncedFileRecord>;
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
	state: SyncState;
};

const DEFAULT_REMOTE_ROOT = "/Apps/obsidian-filen-sync/default";

export const DEFAULT_SETTINGS: FilenSyncSettings = {
	email: "",
	remoteRoot: DEFAULT_REMOTE_ROOT,
	deviceId: "",
	vaultName: "default",
	auth: null,
	state: {
		lastPulledKey: "",
		sentJournalKeys: [],
		files: {},
	},
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown, fallback: string): string =>
	typeof value === "string" ? value : fallback;

const readNumber = (value: unknown, fallback: number): number =>
	typeof value === "number" && Number.isFinite(value) ? value : fallback;

const readStringArray = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const readAuthVersion = (value: unknown): 1 | 2 | 3 | null => {
	if (value === 1 || value === 2 || value === 3) {
		return value;
	}

	return null;
};

const readSyncedFiles = (value: unknown): Record<string, SyncedFileRecord> => {
	if (!isRecord(value)) {
		return {};
	}

	const files: Record<string, SyncedFileRecord> = {};
	for (const [path, rawRecord] of Object.entries(value)) {
		if (!isRecord(rawRecord)) {
			continue;
		}

		const recordPath = readString(rawRecord.path, path);
		files[path] = {
			path: recordPath,
			mtime: readNumber(rawRecord.mtime, 0),
			ctime: readNumber(rawRecord.ctime, 0),
			size: readNumber(rawRecord.size, 0),
		};
	}

	return files;
};

const readSyncState = (value: unknown): SyncState => {
	if (!isRecord(value)) {
		return DEFAULT_SETTINGS.state;
	}

	return {
		lastPulledKey: readString(value.lastPulledKey, ""),
		sentJournalKeys: readStringArray(value.sentJournalKeys),
		files: readSyncedFiles(value.files),
	};
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
			return { ...DEFAULT_SETTINGS, state: { ...DEFAULT_SETTINGS.state, files: {} }, auth: null };
		}

		return {
			email: readString(value.email, DEFAULT_SETTINGS.email),
			remoteRoot: readString(value.remoteRoot, DEFAULT_REMOTE_ROOT),
			deviceId: readString(value.deviceId, ""),
			vaultName: readString(value.vaultName, DEFAULT_SETTINGS.vaultName),
			auth: readFilenAuth(value.auth),
			state: readSyncState(value.state),
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

		new Setting(containerEl).setName("Sync").setHeading();

		new Setting(containerEl)
			.setName("Email")
			.setDesc("Account email.")
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
			.setDesc(this.plugin.hasSavedAuth() ? "Saved auth active. Only needed to re-auth." : "Needed once to save auth.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder(this.plugin.hasSessionPassword() ? "Password set" : "Password")
					.onChange((value) => {
						this.plugin.setSessionPassword(value);
					});
			});

		new Setting(containerEl)
			.setName("Two-factor code")
			.setDesc("Optional. Needed only when re-auth requires it.")
			.addText((text) =>
				text
					.setPlaceholder("123456")
					.onChange((value) => {
						this.plugin.setSessionTwoFactorCode(value.trim());
					}),
			);

		new Setting(containerEl)
			.setName("Remote folder")
			.setDesc("Folder used for journal files.")
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
			.setName("Vault")
			.setDesc("Stored in remote status metadata.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.vaultName)
					.onChange(async (value) => {
						this.plugin.settings.vaultName = value.trim() || "default";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Saved auth")
			.setDesc(this.plugin.hasSavedAuth() ? "Stored locally in plugin data." : "No saved auth.")
			.addButton((button) =>
				button
					.setButtonText("Clear")
					.setDisabled(!this.plugin.hasSavedAuth())
					.onClick(async () => {
						await this.plugin.clearSavedAuth();
						this.display();
					}),
			);
	}
}
