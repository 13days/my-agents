const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const START = '# >>> my-agents capture profile >>>';
const END = '# <<< my-agents capture profile <<<';
const block = /\n?# >>> my-agents capture profile >>>[\s\S]*?# <<< my-agents capture profile <<<\n?/g;
const formats = new Map();
function codexProfileFormat(cli) {
  if (!formats.has(cli)) {
    try { formats.set(cli, /CONFIG_PROFILE_V2|Layer \$CODEX_HOME\//.test(execFileSync(cli, ['--help'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })) ? 'layer' : 'legacy'); }
    catch { formats.set(cli, 'legacy'); }
  }
  return formats.get(cli);
}
function createCodexProfile({ home, port, apiKey = () => false, format = () => 'legacy' }) {
  const file = path.join(home, 'config.toml');
  const layer = path.join(home, 'my-agents.config.toml');
  const read = () => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };
  return {
    status: () => ({ name: 'my-agents', path: format() === 'layer' ? layer : file, installed: format() === 'layer' ? fs.existsSync(layer) : read().includes(START), format: format(), legacy: fs.existsSync(path.join(home, 'claude-panel.config.toml')) }),
    install(remove = false) {
      if (format() === 'layer') {
        if (fs.existsSync(layer) && !fs.readFileSync(layer, 'utf8').includes(START)) throw new Error('my-agents.config.toml 已存在且不是本应用生成的配置，请先检查；本次未修改。');
        if (remove) { fs.rmSync(layer, { force: true }); return; }
        const base = apiKey() ? `http://127.0.0.1:${port}/codex-openai/v1` : `http://127.0.0.1:${port}/backend-api/codex`;
        const content = `${START}\nmodel_provider = "panel"\n\n[model_providers.panel]\nname = "my-agents"\nbase_url = "${base}"\nwire_api = "responses"\nrequires_openai_auth = true\n${END}\n`;
        fs.mkdirSync(home, { recursive: true });
        const temp = layer + `.${process.pid}.tmp`;
        try { fs.writeFileSync(temp, content, { mode: 0o600 }); fs.renameSync(temp, layer); }
        finally { fs.rmSync(temp, { force: true }); }
        return;
      }
      const original = read(), clean = original.replace(block, '');
      const conflict = /^\s*(?:\[\s*(?:profiles\s*\.\s*(?:["']?my-agents["']?|["']?claude-panel["']?)|model_providers\s*\.\s*["']?panel["']?)(?=[\s.\]])|(?:profiles|model_providers)\s*=|["']?(?:my-agents|claude-panel|panel)["']?\s*=|(?:profiles\s*\.\s*["']?(?:my-agents|claude-panel)["']?|model_providers\s*\.\s*["']?panel["']?)\s*\.)/m;
      if (!remove && conflict.test(clean)) throw new Error('Codex 配置中已有同名或内联 profile/provider，请先检查 config.toml；为避免覆盖你的设置，本次未修改。');
      const base = apiKey() ? `http://127.0.0.1:${port}/codex-openai/v1` : `http://127.0.0.1:${port}/backend-api/codex`;
      const content = remove ? clean : clean + (clean && !clean.endsWith('\n') ? '\n' : '') + `\n${START}\n[model_providers.panel]\nname = "my-agents"\nbase_url = "${base}"\nwire_api = "responses"\nrequires_openai_auth = true\n\n[profiles.my-agents]\nmodel_provider = "panel"\n\n# Compatibility for existing terminal commands.\n[profiles.claude-panel]\nmodel_provider = "panel"\n${END}\n`;
      if (content === original) return;
      fs.mkdirSync(home, { recursive: true });
      if (fs.existsSync(file)) { fs.writeFileSync(file + '.my-agents-backup', original, { mode: 0o600 }); fs.chmodSync(file + '.my-agents-backup', 0o600); }
      const temp = file + `.my-agents-${process.pid}.tmp`;
      try { fs.writeFileSync(temp, content, { mode: 0o600 }); fs.renameSync(temp, file); }
      finally { fs.rmSync(temp, { force: true }); }
    },
  };
}
module.exports = { createCodexProfile, codexProfileFormat };
