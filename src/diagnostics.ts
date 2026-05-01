/**
 * Mobile-first startup diagnostics and debug report generation.
 * Excludes vault contents, file paths, and auth secrets.
 */
import type { App } from "obsidian";

export type CheckResult = {
	label: string;
	ok: boolean;
	detail: string;
};

export type PlatformInfo = {
	appVersion: string;
	platform: string;
	isMobile: boolean;
	pluginVersion: string;
	userAgent: string;
};

export type DiagnosticsReport = PlatformInfo & {
	generatedAt: string;
	checks: CheckResult[];
	syncSettings: {
		email: string;
		remoteRoot: string;
		vaultName: string;
		hasAuth: boolean;
		syncOnSave: boolean;
		syncOnSaveDelaySeconds: number;
		syncIntervalMinutes: number;
		syncStartupDelaySeconds: number;
		ignorePatternsCount: number;
	};
	lastError: string | null;
};

type DiagConfig = {
	app: App;
	pluginVersion: string;
	settingsSnap: {
		email: string;
		remoteRoot: string;
		vaultName: string;
		hasAuth: boolean;
		syncOnSave: boolean;
		syncOnSaveDelaySeconds: number;
		syncIntervalMinutes: number;
		syncStartupDelaySeconds: number;
		ignorePatternsCount: number;
	};
	lastError: string | null;
};

let storedLastError: string | null = null;

export function setLastError(error: string): void {
	storedLastError = error;
}

export function getLastError(): string | null {
	return storedLastError;
}

export function clearLastError(): void {
	storedLastError = null;
}

/**
 * Run startup self-checks. Returns a list of check results.
 * Called during plugin onload to detect mobile-incompatible environments early.
 */
export async function runStartupChecks(): Promise<CheckResult[]> {
	const results: CheckResult[] = [];

	// 1. Web Crypto API
	try {
		if (typeof window === "undefined" || typeof window.crypto === "undefined") {
			results.push({ label: "Web Crypto API", ok: false, detail: "window.crypto is unavailable. Required for hashing and random IDs." });
		} else if (typeof window.crypto.subtle === "undefined") {
			results.push({ label: "Web Crypto API", ok: false, detail: "window.crypto.subtle is unavailable. Required for SHA-256 hashing." });
		} else if (typeof window.crypto.randomUUID !== "function") {
			results.push({ label: "Web Crypto API", ok: false, detail: "window.crypto.randomUUID is unavailable. Required for device IDs." });
		} else {
			// Quick functional test
			try {
				const testId = window.crypto.randomUUID();
				if (testId.length !== 36) {
					results.push({ label: "Web Crypto API", ok: false, detail: "randomUUID() returned unexpected value." });
				} else {
					results.push({ label: "Web Crypto API", ok: true, detail: "Fully available (randomUUID, subtle digest)." });
				}
			} catch {
				results.push({ label: "Web Crypto API", ok: false, detail: "Crypto functions threw an error when called." });
			}
		}
	} catch {
		results.push({ label: "Web Crypto API", ok: false, detail: "Could not access window.crypto." });
	}

	// 2. IndexedDB / localforage
	try {
		if (typeof indexedDB === "undefined") {
			results.push({ label: "IndexedDB", ok: false, detail: "indexedDB is not available. Sync state cannot be persisted." });
		} else {
			// Test opening a database
			try {
				const testResult = await new Promise<boolean>((resolve) => {
					try {
						const req = indexedDB.open("__filen_sync_diag__", 1);
						req.onupgradeneeded = () => {
							req.result.createObjectStore("test");
						};
						req.onsuccess = () => {
							req.result.close();
							indexedDB.deleteDatabase("__filen_sync_diag__");
							resolve(true);
						};
						req.onerror = () => {
							resolve(false);
						};
						req.onblocked = () => {
							resolve(false);
						};
					} catch {
						resolve(false);
					}
				});

				if (testResult) {
					results.push({ label: "IndexedDB", ok: true, detail: "Available and writable." });
				} else {
					results.push({ label: "IndexedDB", ok: false, detail: "IndexedDB failed to open a test database. Sync state may not persist." });
				}
			} catch {
				results.push({ label: "IndexedDB", ok: false, detail: "IndexedDB test threw an error." });
			}
		}
	} catch {
		results.push({ label: "IndexedDB", ok: false, detail: "Could not check IndexedDB availability." });
	}

	// 3. Network reachability
	try {
		if (typeof navigator !== "undefined" && "onLine" in navigator) {
			if (navigator.onLine) {
				results.push({ label: "Network", ok: true, detail: "Online." });
			} else {
				results.push({ label: "Network", ok: false, detail: "Device is offline. Sync requires a network connection." });
			}
		} else {
			results.push({ label: "Network", ok: true, detail: "navigator.onLine not available; assuming online." });
		}
	} catch {
		results.push({ label: "Network", ok: true, detail: "Could not check network state; assuming online." });
	}

	// 4. Fetch API (needed for Filen SDK)
	try {
		// eslint-disable-next-line no-restricted-globals
		if (typeof fetch === "function") {
			results.push({ label: "Fetch API", ok: true, detail: "Available." });
		} else {
			results.push({ label: "Fetch API", ok: false, detail: "fetch() is not available. The Filen SDK requires fetch." });
		}
	} catch {
		results.push({ label: "Fetch API", ok: false, detail: "Could not verify fetch availability." });
	}

	// 5. ReadableStream (needed for Filen SDK downloads)
	try {
		if (typeof ReadableStream === "function") {
			results.push({ label: "ReadableStream", ok: true, detail: "Available." });
		} else {
			results.push({ label: "ReadableStream", ok: false, detail: "ReadableStream is not available. File download/upload may fail." });
		}
	} catch {
		results.push({ label: "ReadableStream", ok: false, detail: "Could not verify ReadableStream availability." });
	}

	// 6. TextEncoder/TextDecoder
	try {
		if (typeof TextEncoder === "function" && typeof TextDecoder === "function") {
			results.push({ label: "TextEncoder/Decoder", ok: true, detail: "Available." });
		} else {
			results.push({ label: "TextEncoder/Decoder", ok: false, detail: "TextEncoder or TextDecoder is not available." });
		}
	} catch {
		results.push({ label: "TextEncoder/Decoder", ok: false, detail: "Could not verify TextEncoder/Decoder availability." });
	}

	return results;
}

/**
 * Check if the environment is critical-failure -- i.e., core APIs needed for
 * plugin operation are missing. If this returns true, the plugin cannot function.
 */
export function hasCriticalFailure(checks: CheckResult[]): boolean {
	const criticalLabels = ["Web Crypto API", "Fetch API"];
	return checks.some((check) => criticalLabels.includes(check.label) && !check.ok);
}

/**
 * Generate platform info for the debug report.
 */
export function getPlatformInfo(pluginVersion: string): PlatformInfo {
	let platform = "unknown";
	let isMobile = false;

	try {
		// eslint-disable-next-line obsidianmd/platform
		const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
		if (/android/i.test(ua)) {
			platform = "android";
			isMobile = true;
		} else if (/iphone|ipad|ipod/i.test(ua)) {
			platform = "ios";
			isMobile = true;
		} else if (/linux/i.test(ua)) {
			platform = "linux";
		} else if (/mac/i.test(ua)) {
			platform = "macos";
		} else if (/win/i.test(ua)) {
			platform = "windows";
		}
	} catch {
		// best-effort
	}

	return {
		appVersion: "unknown",
		platform,
		isMobile,
		pluginVersion,
		// eslint-disable-next-line obsidianmd/platform
		userAgent: (typeof navigator !== "undefined" && navigator.userAgent) || "unknown",
	};
}

/**
 * Generate a full diagnostics report. Safe to share in bug reports.
 */
export async function generateReport(config: DiagConfig): Promise<DiagnosticsReport> {
	const checks = await runStartupChecks();
	const platformInfo = getPlatformInfo(config.pluginVersion);

	return {
		...platformInfo,
		generatedAt: new Date().toISOString(),
		checks,
		syncSettings: {
			email: config.settingsSnap.email ? redactEmail(config.settingsSnap.email) : "(not set)",
			remoteRoot: config.settingsSnap.remoteRoot || "(default)",
			vaultName: "(redacted)",
			hasAuth: config.settingsSnap.hasAuth,
			syncOnSave: config.settingsSnap.syncOnSave,
			syncOnSaveDelaySeconds: config.settingsSnap.syncOnSaveDelaySeconds,
			syncIntervalMinutes: config.settingsSnap.syncIntervalMinutes,
			syncStartupDelaySeconds: config.settingsSnap.syncStartupDelaySeconds,
			ignorePatternsCount: config.settingsSnap.ignorePatternsCount,
		},
		lastError: config.lastError,
	};
}

/**
 * Format a report as human-readable plain text for clipboard copy.
 */
export function formatReportForClipboard(report: DiagnosticsReport): string {
	const lines: string[] = [];
	lines.push("=== Obsidian Filen Sync Diagnostics Report ===");
	lines.push(`Generated: ${report.generatedAt}`);
	lines.push(`Plugin version: ${report.pluginVersion}`);
	lines.push(`Obsidian version: ${report.appVersion}`);
	lines.push(`Platform: ${report.platform}`);
	lines.push(`Mobile: ${report.isMobile ? "yes" : "no"}`);
	lines.push(`User agent: ${report.userAgent}`);
	lines.push("");

	lines.push("--- Environment Checks ---");
	for (const check of report.checks) {
		const icon = check.ok ? "OK" : "FAIL";
		lines.push(`[${icon}] ${check.label}: ${check.detail}`);
	}
	lines.push("");

	lines.push("--- Sync Settings ---");
	lines.push(`Email: ${report.syncSettings.email}`);
	lines.push(`Remote folder: ${report.syncSettings.remoteRoot}`);
	lines.push(`Auth saved: ${report.syncSettings.hasAuth ? "yes" : "no"}`);
	lines.push(`Sync on save: ${report.syncSettings.syncOnSave ? `enabled (${report.syncSettings.syncOnSaveDelaySeconds}s delay)` : "disabled"}`);
	lines.push(`Interval sync: ${report.syncSettings.syncIntervalMinutes > 0 ? `every ${report.syncSettings.syncIntervalMinutes} min` : "disabled"}`);
	lines.push(`Startup sync: ${report.syncSettings.syncStartupDelaySeconds > 0 ? `${report.syncSettings.syncStartupDelaySeconds}s after launch` : "disabled"}`);
	lines.push(`Ignore patterns: ${report.syncSettings.ignorePatternsCount}`);

	if (report.lastError) {
		lines.push("");
		lines.push("--- Last Error ---");
		lines.push(report.lastError);
	}

	lines.push("");
	lines.push("No vault contents, file paths, or auth secrets are included in this report.");
	lines.push("=== End Report ===");

	return lines.join("\n");
}

/**
 * Redact an email address for safe display.
 */
function redactEmail(email: string): string {
	const atIndex = email.indexOf("@");
	if (atIndex <= 0) return "(invalid email)";
	const local = email.slice(0, atIndex);
	const domain = email.slice(atIndex);
	if (local.length <= 2) return `***${domain}`;
	return `${local[0]}***${local[local.length - 1]}${domain}`;
}
