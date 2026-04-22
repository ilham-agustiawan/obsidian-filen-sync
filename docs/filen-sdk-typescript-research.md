# Filen TypeScript SDK research

Research date: 2026-04-22.

## Sources

- Official SDK guide: https://docs.filen.io/docs/sdk/
- Getting started: https://docs.filen.io/docs/sdk/getting-started/
- Authentication: https://docs.filen.io/docs/sdk/authentication/
- File system: https://docs.filen.io/docs/sdk/file-system/
- Cloud: https://docs.filen.io/docs/sdk/cloud/
- Generated TypeDoc: https://sdk-ts-docs.filen.io/
- SDK repo: https://github.com/FilenCloudDienste/filen-sdk-ts
- NPM package: `@filen/sdk`, latest verified with `npm view` as `0.3.12`, license `AGPLv3`.

## What SDK is

`@filen/sdk` is Filen's first-party TypeScript SDK for Node.js, browsers, and React Native.

It exposes:

- `FilenSDK`: auth, config, API groups.
- `filen.fs()`: high-level virtual filesystem, path-based.
- `filen.cloud()`: lower-level file/directory operations, UUID-based.
- Other groups: notes, chats, contacts, crypto, user, API.

For this plugin, prefer `filen.fs()` first. It maps better to journal files under one remote folder.

## Install

```bash
npm install @filen/sdk@latest
```

Current verified package facts:

```text
version: 0.3.12
license: AGPLv3
```

Key runtime warning: browser use needs a bundler plus Node polyfills. Obsidian plugins run in Electron/webview contexts, so confirm bundled SDK works on desktop and mobile before committing to it.

## License risk

SDK package license is `AGPLv3`.

This repository currently uses `0-BSD` in `package.json`. Do not add `@filen/sdk` as a dependency until project licensing implications are accepted.

Decision needed:

- Use AGPL-compatible plugin licensing, or
- avoid SDK dependency and use another integration path, or
- get legal review before release.

## SDK config

Generated docs define:

```ts
type FilenSDKConfig = {
	email?: string;
	password?: string;
	twoFactorCode?: string;
	masterKeys?: string[];
	apiKey?: string;
	publicKey?: string;
	privateKey?: string;
	authVersion?: AuthVersion;
	baseFolderUUID?: string;
	userId?: number;
	metadataCache?: boolean;
	tmpPath?: string;
	connectToSocket?: boolean;
};
```

Recommended init from docs:

```ts
import { FilenSDK } from "@filen/sdk";

const filen = new FilenSDK({
	metadataCache: true,
	connectToSocket: true,
	tmpPath: "<plugin-cache>/filen-sdk",
});

await filen.login({
	email: "user@example.com",
	password: "password",
	twoFactorCode: "123456",
});
```

Plugin implications:

- Do not store raw password after login if SDK config can be persisted safely instead.
- Do not log config, auth response, keys, or email.
- `tmpPath` is Node-only. In Obsidian, use plugin-managed temp/cache path only after runtime test.
- `connectToSocket: true` keeps virtual FS tree fresh; may be battery/network-costly on mobile.
- `metadataCache: true` is recommended by docs; clear it on logout if SDK exposes enough control.

## Main `FilenSDK` methods

Generated docs list:

```ts
new FilenSDK(params?: FilenSDKConfig, workers?: SDKWorker[], axiosInstance?: AxiosInstance)
filen.init(params?: FilenSDKConfig): void
filen.login(params: { email?: string; password?: string; twoFactorCode?: string }): Promise<void>
filen.logout(): void
filen.fs(): FS
filen.cloud(): Cloud
filen.user()
filen.crypto()
filen.api()
```

Use `login()` for auth spike. Use stored config only after verifying exact persisted shape and whether it contains secrets.

## Virtual FS API

`filen.fs()` is path-based and closest to Node `fs`.

Relevant methods:

```ts
fs.mkdir({ path }): Promise<string>
fs.readdir({ path, recursive? }): Promise<string[]>
fs.stat({ path }): Promise<FSStats>
fs.statfs(): Promise<StatFS>
fs.pathToItemUUID({ path, type? }): Promise<string | null>
fs.rename({ from, to }): Promise<void>
fs.unlink({ path, permanent? }): Promise<void>
fs.rm({ path, permanent? }): Promise<void>
fs.rmdir({ path, permanent? }): Promise<void>
fs.rmfile({ path, permanent? }): Promise<void>
fs.writeFile({ path, content, encryptionKey?, abortSignal?, pauseSignal?, onProgress?, onProgressId? }): Promise<CloudItem>
fs.readFile({ path, abortSignal?, pauseSignal?, onProgress?, onProgressId? }): Promise<Buffer>
fs.read({ path, position?, offset?, length?, abortSignal?, pauseSignal?, onProgress?, onProgressId? }): Promise<Buffer>
fs.upload({ path, source, overwriteDirectory?, abortSignal?, pauseSignal?, onProgress?, onProgressId? }): Promise<CloudItem>
fs.download({ path, destination, abortSignal?, pauseSignal?, onProgress?, onProgressId? }): Promise<void>
fs.cp({ from, to, abortSignal?, pauseSignal?, onProgress?, onProgressId? }): Promise<void>
```

Important constraints:

- `upload`, `download`, `writeFile`, and copy helpers are documented as Node-only or memory-heavy in some paths.
- `readFile` reads whole file into memory.
- `read` supports partial reads and is better for large files.
- `cp` downloads then reuploads because Filen E2EE prevents server-side copy.

For journal sync, whole-file `writeFile` and `readFile` are acceptable for MVP because journal files can be bounded. Add size limits before supporting large vaults.

## Cloud API

`filen.cloud()` is lower-level and UUID-based.

Useful methods from TypeDoc:

```ts
cloud.listDirectory({ uuid })
cloud.getDirectory({ uuid })
cloud.getFile({ uuid })
cloud.createDirectory({ uuid, name, parent, renameIfExists })
cloud.renameFile({ uuid, metadata, name, overwriteIfExists })
cloud.renameDirectory(...)
cloud.trashFile({ uuid })
cloud.trashDirectory({ uuid })
cloud.deleteFile(...)
cloud.deleteDirectory(...)
cloud.uploadLocalFile({ source, parent, name })
cloud.uploadLocalFileStream(...)
cloud.uploadWebFile(...)
cloud.downloadFileToLocal(...)
cloud.downloadFileToReadableStream(...)
cloud.fileExists(...)
cloud.directoryExists(...)
```

Use only when virtual FS lacks required behavior, such as efficient UUID lookup, stream support, or lower-level metadata handling.

## Recommended adapter shape

Keep SDK isolated behind one module. Do not let Filen types leak into sync logic.

```ts
export type FilenRemoteError =
	| { type: "auth"; message: string }
	| { type: "not_found"; path: string; message: string }
	| { type: "conflict"; path: string; message: string }
	| { type: "network"; message: string }
	| { type: "unknown"; operation: string; message: string };

export type RemoteJournalStore = {
	ensureRoot(): Promise<Result<void, FilenRemoteError>>;
	listFiles(after: string, limit: number): Promise<Result<string[], FilenRemoteError>>;
	writeFile(key: string, bytes: Uint8Array): Promise<Result<void, FilenRemoteError>>;
	readFile(key: string): Promise<Result<Uint8Array, FilenRemoteError>>;
	deleteFile(key: string): Promise<Result<void, FilenRemoteError>>;
};
```

Why:

- Sync core stays testable without Filen.
- SDK exceptions get mapped at boundary.
- AGPL dependency remains contained if integration must change.
- Runtime polyfill issues stay local.

## MVP remote layout

Use one remote folder:

```text
/Apps/obsidian-filen-sync/<vault-id>/
  _sync_parameters.json
  _milestone.json
  20260422T153000Z-<device-id>-<random>-docs.jsonl.gz
```

Filen path rules to test:

- Whether parent folders are created by `mkdir` recursively.
- Whether `writeFile` overwrites existing files.
- Whether `readdir` returns names only or full child paths for recursive mode.
- Whether case sensitivity matches expectations.
- Maximum practical path length and filename character constraints.

## Runtime spike checklist

Before implementation:

1. Install SDK in branch only after license decision.
2. Build with current esbuild config.
3. Verify Obsidian desktop plugin loads.
4. Verify login with 2FA and without 2FA.
5. Verify `mkdir`, `readdir`, `writeFile`, `readFile`, `stat`, `unlink`.
6. Verify plugin unload calls `filen.logout()` and closes socket.
7. Verify mobile build/load if mobile support remains target.
8. Check bundled `main.js` size.
9. Check whether SDK pulls Node modules needing polyfills.
10. Confirm no secrets appear in logs or saved plugin data.

## Open implementation questions

- Is AGPLv3 acceptable for this plugin?
- Can SDK config be persisted without storing password?
- Does SDK work in Obsidian mobile without heavy polyfills?
- Does `writeFile` overwrite atomically enough for control JSON?
- Does `connectToSocket` keep process/network resources alive after plugin unload?
- Are SDK errors typed, or must adapter classify thrown values defensively?
