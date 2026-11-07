const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { npmGlobalPrefix, globalCliCandidates } = require('./cli-installations');
const { parseVersion, compareVersions } = require('./codex-cli');
let cached;
function resolveClaude({ env = process.env, refresh = false, probe, globalPrefix, platform = process.platform } = {}) {
  if (env.CLAUDE_CLI) return { path: env.CLAUDE_CLI, version: '', source: 'override', candidates: [] };
  const key = JSON.stringify([env.PATH, env.HOME, env.npm_config_prefix, env.NPM_CONFIG_PREFIX, env.npm_execpath, globalPrefix, platform]);
  if (!probe && !refresh && cached?.key === key) return cached.value;
  const prefix = globalPrefix ?? (probe ? '' : npmGlobalPrefix({ env, platform }));
  const npmFiles = globalCliCandidates(prefix, 'claude', platform);
  const paths = platform === 'win32' ? path.win32 : path;
  const extensions = platform === 'win32' ? ['claude.cmd', 'claude.exe', 'claude'] : ['claude'];
  const files = [...new Set([...npmFiles, ...String(env.PATH || '').split(platform === 'win32' ? ';' : path.delimiter).filter(Boolean).flatMap(dir => extensions.map(name => paths.join(dir, name)))])];
  const version = probe || (file => execFileSync(file, ['--version'], { env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
  const found = [];
  for (const file of files) {
    try {
      if (!probe) fs.accessSync(file, fs.constants.X_OK);
      const parts = parseVersion(version(file)); if (!parts) continue;
      found.push({ path: file, version: parts.join('.'), parts, source: npmFiles.includes(file) ? 'npm' : 'path' });
    } catch {}
  }
  found.sort((a, b) => compareVersions(b.parts, a.parts));
  const chosen = found.find(item => item.source === 'npm') || found[0];
  const value = { path: chosen?.path || 'claude', version: chosen?.version || '', source: chosen?.source || 'path', candidates: found.map(({ parts, ...item }) => item) };
  if (!probe) cached = { key, value };
  return value;
}
function claudeEnvironment(env = process.env, info = resolveClaude({ env })) {
  // The CLI itself is launched by absolute path. Its tools must resolve the
  // same installation rather than finding an older binary earlier in PATH.
  if (!path.isAbsolute(info.path)) return { ...env };
  const dir = path.dirname(info.path);
  return { ...env, PATH: [dir, ...String(env.PATH || '').split(path.delimiter).filter(entry => entry && entry !== dir)].join(path.delimiter), CLAUDE_CLI: info.path, MY_AGENTS_CLAUDE_VERSION: info.version || '' };
}
module.exports = { resolveClaude, claudeEnvironment };
