import { Modal, type App } from "obsidian";

type FilenSyncSetupModalConfig = {
	app: App;
	onOpenSettings: () => void;
};

export class FilenSyncSetupModal extends Modal {
	constructor(private readonly config: FilenSyncSetupModalConfig) {
		super(config.app);
		this.modalEl.addClass("filen-sync-setup-modal");
	}

	onOpen(): void {
		this.contentEl.empty();

		this.contentEl.createEl("h2", { text: "Set up Filen Sync" });
		this.contentEl.createEl("p", {
			text: "Connect your Filen account, choose the remote folder for this vault, then run your first sync.",
			cls: "filen-sync-setup-copy",
		});

		const steps = this.contentEl.createEl("ol", { cls: "filen-sync-setup-steps" });
		steps.createEl("li", { text: "Open plugin settings." });
		steps.createEl("li", { text: "Enter your Filen email, password, and optional 2FA code." });
		steps.createEl("li", { text: "Keep the default remote folder or choose one dedicated to this vault." });
		steps.createEl("li", { text: "Run Sync now to authenticate and create the mirror." });

		const note = this.contentEl.createDiv({ cls: "filen-sync-setup-note" });
		note.createEl("strong", { text: "Privacy" });
		note.createSpan({ text: " Your password and 2FA code stay in memory for this session only." });

		const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
		const later = actions.createEl("button", { text: "Later" });
		later.addEventListener("click", () => this.close());

		const openSettings = actions.createEl("button", { text: "Open settings" });
		openSettings.addClass("mod-cta");
		openSettings.addEventListener("click", () => {
			this.close();
			this.config.onOpenSettings();
		});
	}
}
