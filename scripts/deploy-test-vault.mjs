import { constants, copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const pluginId = "obsidian-filen-sync";
const vaultPath = process.env.TEST_VAULT_PATH ?? process.argv[2];

if (!vaultPath) {
	throw new Error("Set TEST_VAULT_PATH or pass vault path as argv[2].");
}

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
