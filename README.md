# Filen Sync

Manual Obsidian vault sync through a Filen folder mirror.

Filen Sync is an Obsidian community plugin for syncing vault files to a Filen
folder. It uses a direct remote mirror, stores sync state locally, and keeps
conflict copies when both local and remote files changed.

## Status

Early release. Use with backups.

Targets desktop and mobile.

## Features

- Filen login through `@filen/sdk`
- Saved Filen auth after first login
- Session-only password and 2FA code
- Manual bidirectional sync
- Manual push-local and pull-remote modes
- Optional auto-sync on save, interval, and startup delay
- Dynamic status bar sync indicator with quick actions
- Sync activity view styled closer to native Obsidian Sync
- Conflict copies for both-sides edits
- Filen file version list, restore, and delete from the file context menu
- Local previous-sync state in IndexedDB
- SHA-256 content hash fallback for timestamp drift
- Vault-relative ignore rules with Obsidian-friendly defaults

## Known limitations

- Conflicts keep a local conflict copy, but there is no side-by-side conflict resolution UI yet.
- Conflict strategy is not configurable yet.
- No rename detection; renames are treated as delete + create.
- Auto-sync is lightweight, not realtime socket sync.

## Requirements

- Obsidian `0.15.0` or newer
- Filen account
- Node.js 18+ for development
- npm

## Install

### From source

```bash
npm install
npm run build
```

Copy these files to your vault plugin folder:

```text
<vault>/.obsidian/plugins/obsidian-filen-sync/
  main.js
  manifest.json
```

Then enable **Filen Sync** in **Settings -> Community plugins**.

## Setup

1. Open **Settings -> Filen Sync**.
2. Enter Filen email.
3. Enter password and optional 2FA code.
4. Keep the default remote folder, or set a custom one.
5. Review **Ignore paths** if you want to exclude extra folders or files.
6. Run **Test connection**.
7. Run **Sync now**.

Password and 2FA code are used only for the current Obsidian session. Saved
Filen auth is stored in Obsidian plugin data. Once connected, settings show a
clear connected state with a **Disconnect** action.

## Commands

| Command | Description |
| --- | --- |
| **Filen Sync: Sync now** | Compare local and remote. Apply changed side. Keep conflict copies. |
| **Filen Sync: Push changed local files** | Upload local changes only. |
| **Filen Sync: Pull changed remote files** | Download remote changes only. |
| **Filen Sync: Test Filen connection** | Verify auth and remote write/delete access. |
| **Filen Sync: Open sync activity** | Show current or last sync activity rows. |
| **Filen Sync: Toggle sync on save** | Turn save-triggered background sync on or off. |

## UI

- The plugin uses a single status bar item for sync state, hover details, and quick actions.
- **File versions** are available from the file context menu.
- The settings tab is organized into **Account and authentication**, **Sync strategy**, **Auto-sync**, and **Actions**.
- Default ignore rules skip `.obsidian/cache`, `.obsidian/workspace*.json`, `.git`, `node_modules`, and the plugin's own data folder.

## Remote layout

Default remote root:

```text
/Apps/obsidian-filen-sync/default
```

Files are mirrored directly:

```text
/Apps/obsidian-filen-sync/default/
  notes/example.md
  assets/image.png
```

Plugin sync state stays local in IndexedDB.

## Development

Install dependencies:

```bash
npm install
```

Run development build:

```bash
npm run dev
```

Run production build:

```bash
npm run build
```

Run lint:

```bash
npm run lint
```

Deploy to the default test vault:

```bash
npm run deploy:test-vault
```

Override test vault:

```bash
TEST_VAULT_PATH=/path/to/vault npm run deploy:test-vault
```

## Release

1. Update `manifest.json` and `versions.json`.
2. Run `npm run build`.
3. Create a GitHub release tagged with the exact plugin version, no leading `v`.
4. Attach `manifest.json` and `main.js`.

## Privacy

This plugin talks to Filen only when you run a sync, push, pull, version, or
connection-test action. It does not add telemetry.

Vault file contents and paths are sent to Filen as needed for sync. Filen auth
data is stored in Obsidian plugin data. Password and 2FA code are not persisted
by this plugin.

## Contributing

Issues and pull requests are welcome. Keep changes small, typed, and covered by
the smallest useful verification.

Before submitting:

```bash
npm run build
npm run lint
```

## License

AGPL-3.0-only.

`@filen/sdk` is AGPL, so this plugin is AGPL too.
