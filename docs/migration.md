# Migrating to my-agents

The project, npm package and executable are now named `my-agents`. The repository is [13days/my-agents](https://github.com/13days/my-agents). The npm package is not published yet. Before the first release, run a local checkout with `npm install` and `npm start`.

## Keep your data

Renaming or moving the source directory does not move or delete user data. Never remove your CLI data directories when upgrading or uninstalling the npm package.

| Data | Location |
| --- | --- |
| Claude sessions, settings, resources | `CLAUDE_DIR`, default `~/.claude` |
| Codex sessions, login and settings | `CODEX_HOME`, default `~/.codex` |
| Shared agent skills | `AGENTS_HOME`, default `~/.agents` |
| Captured requests | `CLAUDE_DIR/panel-captures.jsonl` |
| Proxy accounts, preferences and session labels | `CLAUDE_DIR/panel-proxy.json`, `panel-config.json`, `panel-sessions.json` |
| Feishu credentials, bindings, messages and contact labels | `CLAUDE_DIR/panel-feishu*.json*` |

The neutral `panel-*` filenames, browser preference keys and Codex provider ID `panel` intentionally remain stable. Existing sessions require the original provider identity to resume. Native `CLAUDE.md`, `AGENTS.md`, `.claude` and `.codex` are engine conventions and retain their names. Exports use `my-agents-bundle`; old `claude-panel-bundle` imports remain accepted. Old gateway context markers are filtered from both engines' histories.

## Move an existing source checkout

1. Back up the entire checkout including `.git` and uncommitted files, CLI session directories and `panel-*` state. Keep backups outside the repository with permissions restricted to your account. For live SQLite databases use the SQLite backup API, not a standalone copy of the main database file while WAL writes continue.
2. Stop active jobs and the old background service before moving. Do not run two Feishu gateways against one bot.
3. Move the checkout to your chosen `my-agents` directory. Preserve a compatibility symlink from the old absolute path while historical CLI sessions, Feishu bindings or other tools still refer to it. Do not bulk-edit native session transcripts or reinitialize Git.
4. Regenerate login startup from the new checkout. The new macOS agent is `io.my-agents.gateway`; unload the old `io.claude-panel.gateway` service and keep its plist in your private backup. Log output remains in `CLAUDE_DIR/panel-service.log`.
5. Run `node server.js install-proxy` to replace old shell blocks without adding duplicate wrappers. Both new and old block markers are recognized when removing the hook.
6. Regenerate the terminal Codex capture profile in Engines & connections. Use `codex -p my-agents`. The app checks the installed CLI help: newer CLIs use `CODEX_HOME/my-agents.config.toml`; older CLIs register a managed section in `CODEX_HOME/config.toml`. Existing `claude-panel` layer files remain untouched; the older config format retains that name as an alias. Unrelated settings are preserved and existing user-owned profiles are not overwritten.
7. Verify session IDs, capture IDs, gateway bindings and user/group permissions before removing any backup or compatibility link.

`MY_AGENTS_NO_PROXY_SETUP`, `MY_AGENTS_RC_FILE`, `MY_AGENTS_CODEX_CAPTURE`, `MY_AGENTS_CHAT_TIMEOUT_MS` and `MY_AGENTS_BACKGROUND_SERVICE` replace the corresponding `CCP_*` environment variables. Legacy names remain supported; the new name takes precedence. CLI executables are discovered from npm's global prefix and PATH, with `CLAUDE_CLI` / `CODEX_CLI` available as optional overrides. No installation path is hardcoded.

## Git and npm release

Keep existing Git history, MIT license and contributor attribution. Create an empty `13days/my-agents` repository without a generated README or license, preserve the old repository as `legacy`, then point `origin` at the new URL and push the reviewed history. The local checkout uses the new repository as `origin` and the previous repository as `legacy`. Do not push a data backup or a CLI login directory.

Before publishing, run `npm test`, `npm pack --dry-run`, and install the tarball into an isolated prefix to check the `my-agents` executable. The package uses an explicit runtime file allowlist; private state, credentials and generated data are excluded. Authenticate to npm before `npm publish`; registry name availability alone does not guarantee publication rights. The previous npm package will not be automatically renamed or unpublished.

Claude subprocess tools inherit the selected CLI directory at the start of PATH and receive `CLAUDE_CLI`. The shell wrapper also discovers the npm global prefix at invocation time. This keeps a tool running `claude --version` aligned with the CLI that launched the conversation, while respecting an explicit `CLAUDE_CLI` override. Feishu context records the selected engine and actual CLI version.
