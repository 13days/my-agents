const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { npmGlobalPrefix, globalCliCandidates } = require('./cli-installations');

// Several Codex installs can coexist (e.g. an old Homebrew-global npm package
// and a newer user-prefix one). Services started by launchd see a different
// PATH than an interactive shell, so pick the newest binary explicitly.
function parseVersion(text) {
  const match = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
}
function codexCandidates(env = process.env, prefix = '') {
  return [...new Set([...globalCliCandidates(prefix, 'codex'), ...String(env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'codex'))])];
}
let cached = null;
function resolveCodex({ env = process.env, refresh = false, probe, globalPrefix } = {}) {
  if (env.CODEX_CLI) return { path: env.CODEX_CLI, version: '', candidates: [] };
  if (cached && !refresh) return cached;
  const version = probe || (file => execFileSync(file, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
  const found = [];
  for (const file of codexCandidates(env, globalPrefix ?? (probe ? '' : npmGlobalPrefix({ env })))) {
    try {
      if (!probe) fs.accessSync(file, fs.constants.X_OK);
      const parsed = parseVersion(version(file));
      if (parsed && !found.some(item => fs.existsSync(file) && item.real === safeReal(file))) found.push({ path: file, real: safeReal(file), version: parsed.join('.'), parts: parsed });
    } catch {}
  }
  found.sort((a, b) => compareVersions(b.parts, a.parts));
  const best = found[0];
  cached = { path: best?.path || 'codex', version: best?.version || '', candidates: found.map(({ path: p, version: v }) => ({ path: p, version: v })) };
  return cached;
}
function safeReal(file) { try { return fs.realpathSync(file); } catch { return file; } }
module.exports = { resolveCodex, parseVersion, compareVersions };
