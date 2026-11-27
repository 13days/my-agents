const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Old runners can validate a path but cannot list its children. Use only the
// SSH destination already configured for this node. User paths travel on stdin.
const scan = `import json, os, re, sys
p = json.load(sys.stdin)
cwd = p["cwd"]
names = []
for e in os.scandir(cwd):
    if not p["hidden"] and e.name.startswith("."):
        continue
    try:
        if e.is_dir():
            names.append(e.name)
    except OSError:
        continue
names.sort(key=lambda s: [int(x) if i % 2 else x.casefold() for i, x in enumerate(re.split(r"([0-9]+)", s))])
start = p["offset"]
end = start + 150
print(json.dumps(dict(cwd=cwd, parent=os.path.dirname(cwd), nextOffset=end if end < len(names) else None,
    directories=[dict(name=n, path=os.path.join(cwd, n)) for n in names[start:end]])))`;

function configuredTarget(dataDir, id, savedNodes) {
  let target;
  try { target = JSON.parse(fs.readFileSync(path.join(dataDir, 'panel-deploy.json'), 'utf8'))[id]?.host; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target || savedNodes.find(node => node.id === id)?.ssh;
}

async function browseHost(host, options, sshTarget) {
  try { return await host.listDirectories(options); }
  catch (error) { if (error.message !== '未知方法：host.listDirectories') throw error; }
  const { dir, offset, hidden } = options;
  if (!Number.isSafeInteger(offset) || offset < 0 || typeof dir !== 'string' || dir.length > 4096 || /[\0\r\n]/.test(dir) || !/^(?:~(?:\/|$)|\/|[a-z]:[\\/]|\\\\)/i.test(dir)) throw Error('请输入有效的绝对目录或 ~/ 路径');
  const cwd = await host.resolveDir(dir);
  const target = sshTarget();
  if (typeof target !== 'string' || target.startsWith('-') || !/^[\w.@:[\]-]{1,200}$/.test(target) || host.platform === 'win32') return { cwd, manual: true };
  return new Promise(resolve => {
    const child = execFile('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', target, "exec python3 -c '" + scan + "'"], { timeout: 12000, maxBuffer: 1024 * 1024 }, (error, output) => {
      if (!error) { try { const page = JSON.parse(output); if (page.cwd === cwd && Array.isArray(page.directories)) return resolve(page); } catch {} }
      resolve({ cwd, manual: true });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ cwd, hidden, offset }));
  });
}
module.exports = { browseHost, configuredTarget };
