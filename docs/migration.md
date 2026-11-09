# Migrating to my-agents

The project, npm package and executable are now named `my-agents`. The repository is [13days/my-agents](https://github.com/13days/my-agents). The npm package is not published yet. Before the first release, run a local checkout with `npm install` and `npm start`.

## Keep your data

Renaming or moving the source directory does not move or delete user data. Never remove your CLI data directories when upgrading or uninstalling the npm package.

| Data | Location |
| --- | --- |
| Claude sessions, settings, resources | `CLAUDE_DIR`, default `~/.claude` |
| Codex sessions, login and settings | `CODEX_HOME`, default `~/.codex` |
| Shared agent skills | `AGENTS_HOME`, default `~/.agents` |
| Captured requests | `DATA_DIR/panel-captures.jsonl` |
| Proxy accounts, preferences and session labels | `DATA_DIR/panel-proxy.json`, `DATA_DIR/panel-config.json`, `DATA_DIR/panel-sessions.json` |
| Replicated account credentials | `DATA_DIR/panel-account-vault.enc`; keep `panel-cluster.json` (or standalone `panel-token`) to decrypt it |
| Feishu credentials, bindings, messages and contact labels | `DATA_DIR/panel-feishu*.json*` |

`DATA_DIR` means the resolved panel data directory, not a separate environment variable: explicit `MY_AGENTS_HOME`, otherwise an existing `~/.my-agents`, otherwise the legacy Claude directory. Inspect the running service before changing it. Cluster CLI commands and services must use the same explicit `MY_AGENTS_HOME`. See the [user guide](user-guide.md) and [cluster setup](cluster-setup.md).

The neutral `panel-*` filenames, browser preference keys and Codex provider ID `panel` intentionally remain stable. Existing sessions require the original provider identity to resume. Native `CLAUDE.md`, `AGENTS.md`, `.claude` and `.codex` are engine conventions and retain their names. Exports use `my-agents-bundle`; old `claude-panel-bundle` imports remain accepted. Old gateway context markers are filtered from both engines' histories.

## Move an existing source checkout

1. Back up the entire checkout including `.git` and uncommitted files, CLI session directories and `panel-*` state. Keep backups outside the repository with permissions restricted to your account. For live SQLite databases use the SQLite backup API, not a standalone copy of the main database file while WAL writes continue.
2. Stop active jobs and the old background service before moving. Do not run two Feishu gateways against one bot.
3. Move the checkout to your chosen `my-agents` directory. Preserve a compatibility symlink from the old absolute path while historical CLI sessions, Feishu bindings or other tools still refer to it. Do not bulk-edit native session transcripts or reinitialize Git.
4. Regenerate login startup from the new checkout. The new macOS agent is `io.my-agents.gateway`; unload the old `io.claude-panel.gateway` service and keep its plist in your private backup. Log output is in the selected `DATA_DIR/panel-service.log`.
5. Run `node server.js install-proxy` to replace old shell blocks without adding duplicate wrappers. Both new and old block markers are recognized when removing the hook.
6. Regenerate the terminal Codex capture profile in Engines & connections. Use `codex -p my-agents`. The app checks the installed CLI help: newer CLIs use `CODEX_HOME/my-agents.config.toml`; older CLIs register a managed section in `CODEX_HOME/config.toml`. Existing `claude-panel` layer files remain untouched; the older config format retains that name as an alias. Unrelated settings are preserved and existing user-owned profiles are not overwritten.
7. Verify session IDs, capture IDs, gateway bindings and user/group permissions before removing any backup or compatibility link.

`MY_AGENTS_NO_PROXY_SETUP`, `MY_AGENTS_RC_FILE`, `MY_AGENTS_CODEX_CAPTURE`, `MY_AGENTS_CHAT_TIMEOUT_MS` and `MY_AGENTS_BACKGROUND_SERVICE` replace the corresponding `CCP_*` environment variables. Legacy names remain supported; the new name takes precedence. CLI executables are discovered from npm's global prefix and PATH, with `CLAUDE_CLI` / `CODEX_CLI` available as optional overrides. No installation path is hardcoded.

## Git and npm release

Keep existing Git history, MIT license and contributor attribution. The canonical repository is already `https://github.com/13days/my-agents.git`; do not initialize another repository during installation. Verify the existing origin and preserve unrelated remotes and uncommitted changes. Source updates do not require an npm release. Before any future npm publication, inspect `npm pack --dry-run`, the package allowlist and included manuals; publication is a separate action.

Claude subprocess tools inherit the selected CLI directory at the start of PATH and receive `CLAUDE_CLI`. The shell wrapper also discovers the npm global prefix at invocation time. This keeps a tool running `claude --version` aligned with the CLI that launched the conversation, while respecting an explicit `CLAUDE_CLI` override. Feishu context records the selected engine and actual CLI version.
