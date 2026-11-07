const fs = require('fs');
const os = require('os');
const path = require('path');

// Where the panel keeps its own files (panel-*.json, tokens, captures, Feishu
// state). Older versions wrote them next to Claude's files in ~/.claude, and a
// running older panel may still be using them, so nothing moves automatically:
//   1. MY_AGENTS_HOME, when set;
//   2. ~/.my-agents, once it exists (created by `my-agents migrate-data`);
//   3. the legacy Claude directory.
const OWN = /^(panel-|panel\.|lark-cli$)/;

function resolveDataDir({ env = process.env, home = os.homedir(), claudeDir = path.join(home, '.claude') } = {}) {
  if (env.MY_AGENTS_HOME) return { dir: path.resolve(env.MY_AGENTS_HOME), legacy: false };
  const preferred = path.join(home, '.my-agents');
  try { if (fs.statSync(preferred).isDirectory()) return { dir: preferred, legacy: false }; } catch {}
  return { dir: claudeDir, legacy: true };
}

// Copies the panel's files from the legacy directory. The originals stay as a
// backup; files already in the target are never overwritten.
function migrateDataDir({ from, to }) {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  const copied = [], skipped = [];
  let names = [];
  try { names = fs.readdirSync(from).filter(name => OWN.test(name) && !name.endsWith('.tmp')); } catch {}
  for (const name of names) {
    const target = path.join(to, name);
    if (fs.existsSync(target)) { skipped.push(name); continue; }
    fs.cpSync(path.join(from, name), target, { recursive: true, preserveTimestamps: true, errorOnExist: true });
    copied.push(name);
  }
  fs.writeFileSync(path.join(to, 'MIGRATED.json'), JSON.stringify({ from, at: new Date().toISOString(), copied, skipped }, null, 2) + '\n', { mode: 0o600 });
  return { copied, skipped };
}
module.exports = { resolveDataDir, migrateDataDir };
