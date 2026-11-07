const path = require('node:path');
const { execFileSync } = require('node:child_process');
const prefixes = new Map();
function npmGlobalPrefix({ env = process.env, platform = process.platform, execute = execFileSync } = {}) {
  const paths = platform === 'win32' ? path.win32 : path;
  const configured = env.npm_config_prefix || env.NPM_CONFIG_PREFIX;
  if (configured && paths.isAbsolute(configured)) return configured;
  const key = JSON.stringify([env.PATH, env.HOME, env.npm_execpath, platform]);
  if (execute === execFileSync && prefixes.has(key)) return prefixes.get(key);
  let prefix = '';
  try {
    const fromScript = env.npm_execpath && /\.(?:c?js)$/i.test(env.npm_execpath);
    const command = fromScript ? process.execPath : platform === 'win32' ? 'npm.cmd' : 'npm';
    const args = [...(fromScript ? [env.npm_execpath] : []), 'prefix', '--global'];
    const value = String(execute(command, args, { env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    if (paths.isAbsolute(value)) prefix = value;
  } catch {}
  if (execute === execFileSync) prefixes.set(key, prefix);
  return prefix;
}
function globalCliCandidates(prefix, name, platform = process.platform) {
  if (!prefix) return [];
  const paths = platform === 'win32' ? path.win32 : path;
  return platform === 'win32' ? [paths.join(prefix, name + '.cmd'), paths.join(prefix, name + '.exe'), paths.join(prefix, name)] : [paths.join(prefix, 'bin', name)];
}
function parseVersion(text) {
  const match = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
}
module.exports = { npmGlobalPrefix, globalCliCandidates, parseVersion, compareVersions };
