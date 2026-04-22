import { FilenSDK } from "@filen/sdk";
import type { FilenAuth } from "./settings";

type FilenStoreConfig = {
	email: string;
	password: string;
	twoFactorCode: string;
	remoteRoot: string;
	auth: FilenAuth | null;
	saveAuth: (auth: FilenAuth) => Promise<void>;
};

type RemoteMilestone = {
	created: number;
	locked: boolean;
	acceptedNodes: string[];
	nodeInfo: Record<string, {
		deviceName: string;
		vaultName: string;
		pluginVersion: string;
		updatedAt: number;
		progress?: string;
	}>;
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type RemoteJournalStore = {
	ensureRoot(): Promise<void>;
	testReadWrite(): Promise<void>;
	listFiles(after: string, limit: number): Promise<string[]>;
	writeFile(key: string, bytes: Uint8Array): Promise<void>;
	readFile(key: string): Promise<Uint8Array>;
	writeMilestone(deviceId: string, vaultName: string): Promise<void>;
	close(): void;
};

export class FilenJournalStore implements RemoteJournalStore {
	private client: FilenSDK | null = null;

	constructor(private readonly config: FilenStoreConfig) {}

	async ensureRoot(): Promise<void> {
		await this.runStep("create remote folder", async () => {
			const fs = (await this.getClient()).fs();
			await fs.mkdir({ path: this.root });
		});

		await this.ensureSyncParameters();
	}

	async testReadWrite(): Promise<void> {
		await this.ensureRoot();
		const key = `_connection_test_${Date.now()}.txt`;
		const expected = "ok";

		await this.runStep("write test file", async () => {
			await this.writeFile(key, new TextEncoder().encode(expected));
		});

		await this.runStep("read test file", async () => {
			const actual = new TextDecoder().decode(await this.readFile(key));
			if (actual !== expected) {
				throw new Error("test file content mismatch");
			}
		});

		await this.runStep("delete test file", async () => {
			const fs = (await this.getClient()).fs();
			await fs.unlink({ path: this.join(key), permanent: true });
		});
	}

	async listFiles(after: string, limit: number): Promise<string[]> {
		await this.ensureRoot();
		const fs = (await this.getClient()).fs();
		const names = await fs.readdir({ path: this.root });

		return names
			.filter((name) => name.endsWith("-docs.jsonl"))
			.filter((name) => name > after)
			.sort((left, right) => left.localeCompare(right))
			.slice(0, limit);
	}

	async writeFile(key: string, bytes: Uint8Array): Promise<void> {
		await this.ensureRoot();
		await this.writeFileContent(key, bytes);
	}

	async readFile(key: string): Promise<Uint8Array> {
		const fs = (await this.getClient()).fs();
		const content = await fs.readFile({ path: this.join(key) });
		return new Uint8Array(content);
	}

	async writeMilestone(deviceId: string, vaultName: string): Promise<void> {
		const value: RemoteMilestone = {
			created: Date.now(),
			locked: false,
			acceptedNodes: [deviceId],
			nodeInfo: {
				[deviceId]: {
					deviceName: deviceId,
					vaultName,
					pluginVersion: "1.0.0",
					updatedAt: Date.now(),
					progress: "manual-sync",
				},
			},
		};

		await this.writeJson("_milestone.json", value);
	}

	close(): void {
		this.client?.logout();
		this.client = null;
	}

	private async ensureSyncParameters(): Promise<void> {
		await this.runStep("read sync parameters", async () => {
			const existing = await this.readJson("_sync_parameters.json");
			if (existing !== null) {
				return;
			}

			await this.writeJson("_sync_parameters.json", {
				protocolVersion: 1,
				pbkdf2salt: crypto.randomUUID(),
			});
		});
	}

	private async writeJson(key: string, value: unknown): Promise<void> {
		const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2));
		await this.writeFileContent(key, bytes);
	}

	private async readJson(key: string): Promise<JsonValue | null> {
		try {
			const fs = (await this.getClient()).fs();
			const bytes = await fs.readFile({ path: this.join(key) });
			return JSON.parse(new TextDecoder().decode(bytes)) as JsonValue;
		} catch (error) {
			if (isNotFoundError(error)) {
				return null;
			}

			throw error;
		}
	}

	private async getClient(): Promise<FilenSDK> {
		if (this.client !== null) {
			return this.client;
		}

		const client = new FilenSDK({
			metadataCache: true,
			connectToSocket: false,
			...(this.config.auth ?? {}),
		});

		if (this.config.auth === null) {
			await this.runStep("login", async () => {
				await client.login({
					email: this.config.email,
					password: this.config.password,
					twoFactorCode: this.config.twoFactorCode || undefined,
				});
			});

			await this.config.saveAuth(toFilenAuth(client.config));
		}

		this.client = client;
		return client;
	}

	private get root(): string {
		const value = this.config.remoteRoot.trim();
		if (value.length === 0) {
			return "/Apps/obsidian-filen-sync/default";
		}

		return value.startsWith("/") ? value : `/${value}`;
	}

	private join(key: string): string {
		return `${this.root.replace(/\/+$/, "")}/${key}`;
	}

	private async writeFileContent(key: string, bytes: Uint8Array): Promise<void> {
		const client = await this.getClient();
		const fs = client.fs();
		const path = this.join(key);

		if (typeof File !== "function") {
			throw new Error("Web File API unavailable in this Obsidian runtime.");
		}

		const parentPath = path.substring(0, path.lastIndexOf("/")) || "/";
		const fileName = path.substring(path.lastIndexOf("/") + 1);
		const parent = await fs.mkdir({ path: parentPath });
		const existing = await fs.pathToItemUUID({ path, type: "file" });
		if (existing !== null) {
			await fs.unlink({ path, permanent: true });
		}

		const file = new File([bytes], fileName, { lastModified: Date.now() });
		await client.cloud().uploadWebFile({
			file,
			parent,
			name: fileName,
		});
		client.init(client.config);
	}

	private async runStep<T>(operation: string, task: () => Promise<T>): Promise<T> {
		try {
			return await task();
		} catch (error) {
			throw new Error(`Filen ${operation} failed: ${errorMessage(error)}`);
		}
	}
}

const isNotFoundError = (error: unknown): boolean => {
	if (isRecord(error)) {
		if (error.code === "ENOENT") {
			return true;
		}

		if (typeof error.message === "string") {
			const message = error.message.toLowerCase();
			return message.includes("not found") || message.includes("no such file or directory");
		}
	}

	return false;
};

const toFilenAuth = (config: unknown): FilenAuth => {
	if (!isRecord(config)) {
		throw new Error("Filen login returned invalid auth config.");
	}

	const authVersion = readAuthVersion(config.authVersion);
	if (authVersion === null) {
		throw new Error("Filen login returned incomplete auth config.");
	}

	const auth: FilenAuth = {
		email: readString(config.email),
		masterKeys: readStringArray(config.masterKeys),
		apiKey: readString(config.apiKey),
		publicKey: readString(config.publicKey),
		privateKey: readString(config.privateKey),
		authVersion,
		baseFolderUUID: readString(config.baseFolderUUID),
		userId: readNumber(config.userId),
	};

	if (
		auth.email.length === 0 ||
		auth.masterKeys.length === 0 ||
		auth.apiKey.length === 0 ||
		auth.publicKey.length === 0 ||
		auth.privateKey.length === 0 ||
		auth.baseFolderUUID.length === 0 ||
		auth.userId <= 0
	) {
		throw new Error("Filen login returned incomplete auth config.");
	}

	return auth;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown): string =>
	typeof value === "string" ? value : "";

const readNumber = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) ? value : 0;

const readAuthVersion = (value: unknown): 1 | 2 | 3 | null => {
	if (value === 1 || value === 2 || value === 3) {
		return value;
	}

	return null;
};

const readStringArray = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const errorMessage = (error: unknown): string => {
	if (error instanceof Error) {
		return error.message;
	}

	if (typeof error === "string") {
		return error;
	}

	return "Unknown error";
};
