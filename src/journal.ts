export type FileJournalEntry = {
	type: "file";
	path: string;
	mtime: number;
	ctime: number;
	size: number;
	contentBase64: string;
};

export type DeleteJournalEntry = {
	type: "delete";
	path: string;
	deletedAt: number;
};

export type JournalEntry = FileJournalEntry | DeleteJournalEntry;

export type JournalEnvelope = {
	protocolVersion: 1;
	deviceId: string;
	createdAt: number;
	entries: JournalEntry[];
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const Journal = {
	encode(envelope: JournalEnvelope): Uint8Array {
		const lines = [
			JSON.stringify({
				type: "header",
				protocolVersion: envelope.protocolVersion,
				deviceId: envelope.deviceId,
				createdAt: envelope.createdAt,
			}),
			...envelope.entries.map((entry) => JSON.stringify(entry)),
		];

		return textEncoder.encode(lines.join("\n"));
	},

	decode(bytes: Uint8Array): JournalEnvelope {
		const lines = textDecoder
			.decode(bytes)
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);

		const header = parseHeader(lines[0]);
		const entries = lines.slice(1).map(parseEntry);

		return {
			protocolVersion: 1,
			deviceId: header.deviceId,
			createdAt: header.createdAt,
			entries,
		};
	},
} as const;

const parseHeader = (line: string | undefined): { deviceId: string; createdAt: number } => {
	if (line === undefined) {
		throw new Error("Journal is empty. Pull stopped; no local files changed.");
	}

	const raw = JSON.parse(line) as unknown;
	if (!isRecord(raw) || raw.type !== "header" || raw.protocolVersion !== 1) {
		throw new Error("Journal header unsupported. Pull stopped; no local files changed.");
	}

	if (typeof raw.deviceId !== "string" || typeof raw.createdAt !== "number") {
		throw new Error("Journal header invalid. Pull stopped; no local files changed.");
	}

	return { deviceId: raw.deviceId, createdAt: raw.createdAt };
};

const parseEntry = (line: string): JournalEntry => {
	const raw = JSON.parse(line) as unknown;
	if (!isRecord(raw) || typeof raw.type !== "string") {
		throw new Error("Journal entry invalid. Pull stopped; no local files changed.");
	}

	if (raw.type === "file") {
		if (
			typeof raw.path === "string" &&
			typeof raw.mtime === "number" &&
			typeof raw.ctime === "number" &&
			typeof raw.size === "number" &&
			typeof raw.contentBase64 === "string"
		) {
			return {
				type: "file",
				path: raw.path,
				mtime: raw.mtime,
				ctime: raw.ctime,
				size: raw.size,
				contentBase64: raw.contentBase64,
			};
		}
	}

	if (raw.type === "delete") {
		if (typeof raw.path === "string" && typeof raw.deletedAt === "number") {
			return { type: "delete", path: raw.path, deletedAt: raw.deletedAt };
		}
	}

	throw new Error("Journal entry shape unsupported. Pull stopped; no local files changed.");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
