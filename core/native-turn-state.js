const fs = require('fs');
// A gap between HTTP requests can be a local tool execution, not an idle turn.
// Inspect only a bounded tail; no transcript or tool output leaves this machine.
function nativeTurnBusy(file) {
  if (!file) return false;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, length = Math.min(size, 512 * 1024), start = size - length;
    const buffer = Buffer.alloc(length); fs.readSync(fd, buffer, 0, length, start);
    const lines = buffer.toString('utf8').split('\n'); if (start) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      let row; try { row = JSON.parse(lines[i]); } catch { continue; }
      if (row.isSidechain) continue;
      if (row.type === 'result') return false;
      if (!['assistant', 'user'].includes(row.type)) continue;
      if (row.type === 'user') return true;
      const message = row.message || {};
      if (['end_turn', 'stop_sequence'].includes(message.stop_reason)) return false;
      return (message.content || []).some(block => block.type === 'tool_use') || message.stop_reason === 'tool_use';
    }
    return size > 0;
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function tailRows(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, length = Math.min(size, 512 * 1024), buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8').split('\n');
  } catch { return []; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function transcriptCwd(file) {
  const lines = tailRows(file);
  for (let i = lines.length - 1; i >= 0; i--) { try { const row = JSON.parse(lines[i]); if (typeof row.cwd === 'string' && row.cwd) return row.cwd; } catch {} }
  return '';
}
// Is any Claude process on this machine still running this session? Panel-launched
// processes carry the id in their arguments; an interactive terminal is matched by its
// working directory. Unknown (no ps/lsof) counts as alive so behaviour stays conservative.
function claudeProcessAlive(sessionId, cwd, { run = (cmd, args) => require('child_process').execFileSync(cmd, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }) } = {}) {
  let rows;
  try { rows = run('ps', ['-axo', 'pid=,args=']).split('\n').map(line => line.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean); }
  catch { return true; }
  const claude = rows.filter(([, , args]) => /(^|\/)claude(\.exe)?(\s|$)/.test(args.split(/\s+/).slice(0, 2).join(' ')) || /\/claude-code\//.test(args.split(/\s+/)[0]));
  if (claude.some(([, , args]) => args.includes(sessionId))) return true;
  const interactive = claude.filter(([, , args]) => !/\s(-p|--print)(\s|$)/.test(args));
  if (!cwd || !interactive.length) return false;
  const pids = interactive.map(([, pid]) => pid);
  if (process.platform === 'linux') return pids.some(pid => { try { return fs.realpathSync(`/proc/${pid}/cwd`) === fs.realpathSync(cwd); } catch { return false; } });
  let out;
  try { out = run('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')]); } catch (error) { out = error?.stdout ? String(error.stdout) : null; }
  if (out === null) return true;
  let target = cwd; try { target = fs.realpathSync(cwd); } catch {}
  return out.split('\n').some(line => line.startsWith('n') && (line.slice(1) === cwd || line.slice(1) === target));
}
// Transcript says a turn is mid-flight and a process is still around to finish it.
// A process killed mid-tool (panel restart, crash) leaves the transcript "busy" forever.
function nativeTurnLive(file, options = {}) {
  if (!nativeTurnBusy(file)) return false;
  const sessionId = require('path').basename(file, '.jsonl');
  return claudeProcessAlive(sessionId, transcriptCwd(file), options);
}
module.exports = { nativeTurnBusy, nativeTurnLive, claudeProcessAlive };
