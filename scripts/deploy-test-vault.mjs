import { constants, copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const pluginId = "obsidian-filen-sync";
const defaultVault = "/Users/agustiawan/Developer/git/kepano-obsidian";
const vaultPath = process.env.TEST_VAULT_PATH ?? defaultVault;
const pluginDir = path.join(vaultPath, ".obsidian", "plugins", pluginId);
const artifacts = ["main.js", "manifest.json", "styles.css"];

async function assertVaultExists() {
	try {
		const vault = await stat(vaultPath);
		if (!vault.isDirectory()) {
			throw new Error(`${vaultPath} is not a directory`);
		}
	} catch (error) {
		if (error instanceof Error) {
			throw new Error(`Test vault unavailable: ${error.message}`);
		}

		throw error;
	}
}

async function assertArtifactsExist() {
	for (const artifact of artifacts) {
		await stat(artifact);
	}
}

async function deploy() {
	await assertVaultExists();
	await assertArtifactsExist();
	await mkdir(pluginDir, { recursive: true });

	for (const artifact of artifacts) {
		const destination = path.join(pluginDir, artifact);
		await copyFile(artifact, destination, constants.COPYFILE_FICLONE);
	}

	console.log(`Deployed ${pluginId} to ${pluginDir}`);
}

await deploy();
