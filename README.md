# Filen Sync

Manual Obsidian vault sync through Filen.

## Status

MVP. Desktop and mobile target.

Implemented:

- Filen login through `@filen/sdk`
- Remote journal folder under `/Apps/obsidian-filen-sync/default`
- Manual **Sync now**, **Push local changes**, **Pull remote changes**
- Whole-file journal entries
- Delete propagation
- Conflict copies for local edits touched by remote changes

Not implemented yet:

- Compression
- Plugin-level E2EE
- Continuous background sync
- Chunking
- Background sync

## Use

1. Install deps: `npm install`
2. Build: `npm run build`
3. Enable plugin in Obsidian desktop.
4. Set Filen email, password, optional 2FA code, and remote folder.
5. Run **Filen Sync: Sync now** from command palette.

Password and 2FA are used once to create saved Filen auth. Clear saved auth in settings to sign out.

## Deploy test vault

```bash
npm run deploy:test-vault
```

Default vault:

```text
/Users/agustiawan/Developer/git/kepano-obsidian
```

Override:

```bash
TEST_VAULT_PATH=/path/to/vault npm run deploy:test-vault
```

## Remote layout

```text
/Apps/obsidian-filen-sync/default/
  _sync_parameters.json
  _milestone.json
  <timestamp>-<device-id>-<random>-docs.jsonl
```

## License note

`@filen/sdk` is AGPL. This plugin is AGPL-3.0-only.
