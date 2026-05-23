import type { App } from "obsidian";
import type { FilenAuth } from "./settings";

const AUTH_ID = "filen-sync-auth";
const PASSWORD_ID = "filen-sync-password";

/**
 * Typed wrapper around Obsidian's SecretStorage API for this plugin.
 *
 * Hides JSON serialization and the "empty-string sentinel" pattern
 * (SecretStorage has no delete, so we store "" to signal absence).
 */
export class PluginSecrets {
	constructor(private readonly app: App) {}

	// ── Auth ────────────────────────────────────────────────────────

	/** Store the FilenAuth credentials. */
	setAuth(auth: FilenAuth): void {
		this.app.secretStorage.setSecret(AUTH_ID, JSON.stringify(auth));
	}

	/** Retrieve the stored FilenAuth, or null. */
	getAuth(): FilenAuth | null {
		const raw = this.app.secretStorage.getSecret(AUTH_ID);
		if (!raw) return null;
		try {
			return JSON.parse(raw) as FilenAuth;
		} catch {
			return null;
		}
	}

	/** True when auth credentials are present. */
	hasAuth(): boolean {
		return this.getAuth() !== null;
	}

	// ── Password ────────────────────────────────────────────────────

	/** Store the session password. Pass empty string to clear. */
	setPassword(password: string): void {
		this.app.secretStorage.setSecret(PASSWORD_ID, password);
	}

	/** Retrieve the stored password, or empty string. */
	getPassword(): string {
		const raw = this.app.secretStorage.getSecret(PASSWORD_ID);
		return typeof raw === "string" ? raw : "";
	}

	// ── Lifecycle ────────────────────────────────────────────────────

	/** Wipe all secrets (auth + password). */
	clear(): void {
		this.app.secretStorage.setSecret(AUTH_ID, "");
		this.app.secretStorage.setSecret(PASSWORD_ID, "");
	}
}
