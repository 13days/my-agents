// Routes Codex started from a terminal through the panel's account pool by managing a small
// block at the top of ~/.codex/config.toml. Top-level keys only (dotted key for the provider),
// so the block never captures keys or tables that follow it. Disabling removes exactly the block.
const fs = require('fs'), path = require('path');

const BEGIN = '# >>> my-agents: terminal Codex uses the panel account pool (managed, toggle in the panel) >>>';
const END = '# <<< my-agents <<<';
const PROVIDER = 'panel';

const quote = value => JSON.stringify(String(value));
function block({ base, token }) {
  return [BEGIN,
    `model_provider = ${quote(PROVIDER)}`,
    `model_providers.${PROVIDER} = { name = "my-agents", base_url = ${quote(base)}, wire_api = "responses", requires_openai_auth = false, experimental_bearer_token = ${quote(token)} }`,
    END, ''].join('\n');
}
function strip(text) {
  const start = text.indexOf(BEGIN);
  if (start < 0) return text;
  const end = text.indexOf(END, start);
  if (end < 0) throw new Error('Codex 配置中的 my-agents 托管段不完整，请手动检查 config.toml');
  return text.slice(0, start) + text.slice(end + END.length).replace(/^\r?\n/, '');
}
// Keys outside our block that would collide with it (duplicate keys make Codex refuse the file).
function conflicts(text) {
  const found = [];
  let table = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const header = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
    if (header) { table = header[1].replace(/\s+/g, ''); if (table === `model_providers.${PROVIDER}` || table.startsWith(`model_providers.${PROVIDER}.`)) found.push(`[${table}]`); continue; }
    if (!table && /^model_provider\s*=/.test(line)) found.push('model_provider');
    if (!table && new RegExp(`^model_providers\\.${PROVIDER}\\b`).test(line)) found.push(`model_providers.${PROVIDER}`);
  }
  return found;
}

function createCodexTerminal({ home, base, token }) {
  const file = () => path.join(home(), 'config.toml');
  const read = () => { try { return fs.readFileSync(file(), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; } };
  const write = text => {
    fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
    const temp = file() + '.my-agents-' + process.pid;
    fs.writeFileSync(temp, text, { mode: 0o600 });
    fs.renameSync(temp, file());
  };
  const status = () => { const text = read(); return { enabled: text.includes(BEGIN), file: file(), base: base() }; };
  function enable() {
    const rest = strip(read()), clash = conflicts(rest);
    if (clash.length) throw new Error(`Codex 配置已自定义 ${clash.join('、')}，为避免覆盖，请先手动移除后再开启`);
    write(block({ base: base(), token: token() }) + rest);
    return status();
  }
  function disable() { const text = read(); if (text.includes(BEGIN)) write(strip(text)); return status(); }
  // The proxy port or auth mode may change between restarts; keep an enabled block current.
  function sync() { const text = read(); if (!text.includes(BEGIN)) return status(); const next = block({ base: base(), token: token() }) + strip(text); if (next !== text) write(next); return status(); }
  return { status, enable, disable, sync };
}

module.exports = { createCodexTerminal, BEGIN, END, PROVIDER };
