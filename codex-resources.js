const fs = require('node:fs');
const path = require('node:path');

function createCodexResources({ home, agentsHome, summarize, parseFrontmatter }) {
  const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
  const roots = scope => [
    { id: 'agents', anchor: scope || agentsHome, dir: path.join(scope || agentsHome, ...(scope ? ['.agents', 'skills'] : ['skills'])) },
    { id: 'codex', anchor: scope || home, dir: path.join(scope || home, ...(scope ? ['.codex', 'skills'] : ['skills'])) },
  ];
  function writable(anchor, file) {
    const relative = path.relative(anchor, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
    let current = anchor;
    for (const part of ['', ...relative.split(path.sep)]) {
      if (part) current = path.join(current, part);
      try { if (fs.lstatSync(current).isSymbolicLink()) return false; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return true;
  }
  function skills(scope) {
    const found = [];
    for (const root of roots(scope)) {
      const seen = new Set();
      const visit = (dir, depth = 0) => {
        if (depth > 5 || found.length >= 5000) return;
        let real;
        try { real = fs.realpathSync(dir); if (seen.has(real)) return; seen.add(real); } catch { return; }
        const file = path.join(dir, 'SKILL.md');
        if (depth && fs.existsSync(file)) {
          try {
            const content = fs.readFileSync(file, 'utf8'), relative = path.relative(root.dir, dir);
            const installed = relative.split(path.sep).some(part => part.startsWith('.')) || !writable(root.anchor, file);
            found.push({ key: root.id + ':' + relative.split(path.sep).join('/'), name: path.basename(dir), path: file, directory: dir, anchor: root.anchor, description: summarize(content), origin: installed ? 'installed' : 'user', source: root.id, content });
          } catch {}
          return;
        }
        let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (entry.name.startsWith('.') && entry.name !== '.system') continue;
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          visit(path.join(dir, entry.name), depth + 1);
        }
      };
      visit(root.dir);
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }
  function configs(scope) {
    const anchor = scope || home;
    return [
      { key: 'instructions', name: 'AGENTS.md', path: path.join(anchor, 'AGENTS.md'), description: scope ? 'Codex · 项目指令 / Project instructions' : 'Codex · 全局指令 / Global instructions' },
      { key: 'instructions-override', name: 'AGENTS.override.md', path: path.join(anchor, 'AGENTS.override.md'), description: 'Codex · 覆盖指令 / Override instructions' },
      { key: 'settings', name: 'config.toml', path: path.join(anchor, ...(scope ? ['.codex', 'config.toml'] : ['config.toml'])), description: 'Codex · 模型、MCP 与运行配置 / Model, MCP and runtime settings' },
    ].map(item => ({ ...item, anchor, exists: fs.existsSync(item.path), origin: writable(anchor, item.path) ? 'user' : 'installed' }));
  }
  function execute({ type, method, key, scope = '', input = {} }) {
    if (!['skills', 'config'].includes(type)) return fail(400, 'Codex 资源目前支持技能、AGENTS.md 指令与 config.toml 配置');
    if (!key && method === 'GET') {
      const items = type === 'skills' ? skills(scope) : configs(scope);
      return { status: 200, data: { items: items.map(({ key, name, description, origin, source, exists }) => ({ key, name, description, origin, source, exists })) } };
    }
    if (!key && method === 'POST' && type === 'skills') {
      if (typeof input.name !== 'string' || !/^[\w-][\w.-]*$/.test(input.name) || input.name.includes('..')) return fail(400, '技能名称只能包含字母、数字、短横线、下划线和点');
      if (typeof input.content !== 'string') return fail(400, 'content 必须为字符串');
      const root = roots(scope)[0], file = path.join(root.dir, input.name, 'SKILL.md');
      if (!writable(root.anchor, file)) return fail(403, '已安装或链接资源为只读');
      if (fs.existsSync(path.dirname(file))) return fail(409, '同名技能目录已存在');
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, input.content, { flag: 'wx', mode: 0o600 });
      return { status: 201, data: { ok: true, key: root.id + ':' + input.name, path: file } };
    }
    const item = (type === 'skills' ? skills(scope) : configs(scope)).find(item => item.key === key);
    if (!item) return fail(404, '资源不存在');
    if (method === 'GET') {
      const content = item.content ?? (item.exists ? fs.readFileSync(item.path, 'utf8') : '');
      return { status: 200, data: { name: item.name, path: item.path, content, origin: item.origin, meta: type === 'skills' ? parseFrontmatter(content).meta : {}, config: type === 'config', lang: item.path.endsWith('.toml') ? 'toml' : 'md' } };
    }
    if (item.origin === 'installed' || !writable(item.anchor, item.path)) return fail(403, '已安装或链接资源为只读');
    if (method === 'PUT') {
      if (typeof input.content !== 'string') return fail(400, 'content 必须为字符串');
      fs.mkdirSync(path.dirname(item.path), { recursive: true }); fs.writeFileSync(item.path, input.content, { mode: 0o600 });
      return { status: 200, data: { ok: true } };
    }
    if (method === 'DELETE' && type === 'skills') {
      fs.rmSync(item.directory, { recursive: true }); return { status: 200, data: { ok: true } };
    }
    return fail(405, '不支持此操作');
  }
  return { execute };
}
module.exports = { createCodexResources };
