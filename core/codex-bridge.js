'use strict';
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const PREFIX = '/codex-subscription';
const invalid = message => Object.assign(new Error(message), { status: 400 });
const equal = (a, b) => { a = Buffer.from(String(a || '')); b = Buffer.from(String(b || '')); return a.length === b.length && crypto.timingSafeEqual(a, b); };
function toResponses(body) {
  if (!body || typeof body.model !== 'string' || !body.model.trim() || !Array.isArray(body.messages)) throw invalid('请提供实际的 Codex 模型 ID 和 messages');
  if (/^claude[-_]/i.test(body.model)) throw invalid('此代理使用 Codex 订阅，请选择账号可用的 OpenAI 模型，不能使用 Claude 模型 ID');
  if (body.stop_sequences?.length || body.output_config?.format || body.output_format) throw invalid('此代理暂不支持 stop_sequences 或结构化输出格式');
  const input = [], instructions = [], ids = new Set(), answered = new Set();
  const textBlocks = value => typeof value === 'string' ? value : (value || []).map(b => { if (b.type !== 'text') throw invalid('system 仅支持文本'); return b.text || ''; }).join('\n');
  if (body.system) instructions.push(textBlocks(body.system));
  for (const message of body.messages) {
    if (message.role === 'system' || message.role === 'developer') { input.push({ role: 'developer', content: textBlocks(message.content) }); continue; }
    if (!['user', 'assistant'].includes(message.role)) throw invalid('不支持的消息角色');
    let pending = [];
    const flush = () => { if (pending.length) input.push({ role: message.role, content: pending }); pending = []; };
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    if (!Array.isArray(blocks)) throw invalid('消息 content 必须是文本或内容块数组');
    for (const block of blocks) {
      if (block.type === 'text') { pending.push({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: String(block.text || '') }); }
      else if (block.type === 'image' && message.role === 'user') {
        const s = block.source;
        if (s?.type === 'base64' && /^image\/(png|jpeg|gif|webp)$/.test(s.media_type) && typeof s.data === 'string') pending.push({ type: 'input_image', image_url: `data:${s.media_type};base64,${s.data}` });
        else if (s?.type === 'url' && /^https:\/\//.test(s.url)) pending.push({ type: 'input_image', image_url: s.url });
        else throw invalid('图片只支持 base64 或 HTTPS URL');
      } else if (block.type === 'tool_use' && message.role === 'assistant') {
        flush();
        if (typeof block.id !== 'string' || ids.has(block.id) || typeof block.name !== 'string' || !block.input || typeof block.input !== 'object' || Array.isArray(block.input)) throw invalid('工具调用 ID、名称或参数无效');
        ids.add(block.id); input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
      } else if (block.type === 'tool_result' && message.role === 'user') {
        flush();
        if (!ids.has(block.tool_use_id) || answered.has(block.tool_use_id)) throw invalid('工具结果未找到唯一的对应调用，请发送完整对话历史');
        answered.add(block.tool_use_id);
        const parts = typeof block.content === 'string' || block.content == null ? [{ type: 'text', text: block.content || '' }] : block.content;
        if (!Array.isArray(parts)) throw invalid('工具结果格式无效');
        const output = parts.map(p => {
          if (p.type === 'text') return { type: 'input_text', text: String(p.text || '') };
          if (p.type === 'image' && p.source?.type === 'base64' && /^image\/(png|jpeg|gif|webp)$/.test(p.source.media_type)) return { type: 'input_image', image_url: `data:${p.source.media_type};base64,${p.source.data}` };
          throw invalid('工具结果暂只支持文本和 base64 图片');
        });
        if (block.is_error) output.unshift({ type: 'input_text', text: '[Tool execution failed]' });
        input.push({ type: 'function_call_output', call_id: block.tool_use_id, output: output.length ? output : '' });
      } else if (['thinking', 'redacted_thinking'].includes(block.type) && message.role === 'assistant') { /* Provider-private reasoning is not portable. */ }
      else throw invalid('此代理尚不支持内容块：' + block.type);
    }
    flush();
  }
  if ([...ids].some(id => !answered.has(id))) throw invalid('对话中有未返回结果的工具调用');
  const tools = (body.tools || []).map(tool => {
    if (tool.type && tool.type !== 'custom') throw invalid('此代理暂不支持服务端工具：' + tool.type + '；请关闭工具搜索并使用客户端工具');
    if (typeof tool.name !== 'string' || !tool.input_schema) throw invalid('工具缺少名称或 input_schema');
    return { type: 'function', name: tool.name, description: tool.description || '', parameters: tool.input_schema, strict: false };
  });
  let tool_choice = 'auto';
  if (body.tool_choice) {
    if (body.tool_choice.type === 'tool') {
      if (!tools.some(t => t.name === body.tool_choice.name)) throw invalid('tool_choice 指向未声明的工具');
      tool_choice = { type: 'function', name: body.tool_choice.name };
    } else if (['auto', 'any', 'none'].includes(body.tool_choice.type)) tool_choice = body.tool_choice.type === 'any' ? 'required' : body.tool_choice.type;
    else throw invalid('不支持的 tool_choice');
  }
  return { model: body.model, instructions: instructions.join('\n\n'), input, tools, tool_choice, parallel_tool_calls: !body.tool_choice?.disable_parallel_tool_use, stream: true, store: false };
}
function createOutput(body, res) {
  const id = 'msg_' + crypto.randomUUID().replaceAll('-', ''), blocks = [], toolIds = new Set();
  let open = -1, started = false, terminal = false, bytes = 0;
  const send = (type, value) => { if (!res.destroyed && !res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`); };
  function start() {
    if (started) return; started = true;
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      send('message_start', { message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    }
  }
  function close() { if (open >= 0) { if (body.stream) send('content_block_stop', { index: open }); open = -1; } }
  function text(delta) {
    if (!delta) return;
    bytes += Buffer.byteLength(delta); if (bytes > 16 * 1024 * 1024) throw new Error('上游输出超过大小限制');
    start();
    if (open < 0 || blocks[open].type !== 'text') { close(); open = blocks.length; blocks.push({ type: 'text', text: '' }); if (body.stream) send('content_block_start', { index: open, content_block: { type: 'text', text: '' } }); }
    blocks[open].text += delta;
    if (body.stream) send('content_block_delta', { index: open, delta: { type: 'text_delta', text: delta } });
  }
  function tool(item) {
    if (toolIds.has(item.call_id)) return;
    if (!body.tools?.some(t => t.name === item.name) || !item.call_id) throw new Error('上游返回未声明的工具或无效调用 ID');
    const input = JSON.parse(item.arguments || '{}');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('上游工具参数不是 JSON 对象');
    start(); close(); toolIds.add(item.call_id);
    const index = blocks.length; blocks.push({ type: 'tool_use', id: item.call_id, name: item.name, input });
    if (body.stream) { send('content_block_start', { index, content_block: { type: 'tool_use', id: item.call_id, name: item.name, input: {} } }); send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }); send('content_block_stop', { index }); }
  }
  function event(ev) {
    if (terminal) return;
    if (ev.type === 'response.output_text.delta') text(ev.delta);
    if (ev.type === 'response.output_item.done' && ev.item?.type === 'function_call') tool(ev.item);
    if (['error', 'response.failed', 'response.incomplete'].includes(ev.type)) throw new Error('Codex 上游未完成响应：' + (ev.response?.error?.message || ev.error?.message || ev.message || ev.response?.incomplete_details?.reason || ev.type));
    if (ev.type === 'response.completed') {
      // Some upstreams only include final items in the terminal response.
      for (const item of ev.response?.output || []) {
        if (item.type === 'function_call') tool(item);
        if (item.type === 'message' && !blocks.some(b => b.type === 'text')) for (const c of item.content || []) if (c.type === 'output_text') text(c.text);
      }
      start(); close(); terminal = true;
      const u = ev.response?.usage || {}, cached = u.input_tokens_details?.cached_tokens || 0;
      const usage = { input_tokens: Math.max(0, (u.input_tokens || 0) - cached), output_tokens: u.output_tokens || 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
      const stop_reason = toolIds.size ? 'tool_use' : 'end_turn';
      if (body.stream) { send('message_delta', { delta: { stop_reason, stop_sequence: null }, usage }); send('message_stop', {}); res.end(); }
      else { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content: blocks, stop_reason, stop_sequence: null, usage })); }
    }
  }
  return { event, done: () => terminal, ping: () => { if (body.stream) { start(); send('ping', {}); } }, fail(error) { if (terminal || res.destroyed || res.writableEnded) return; terminal = true; const value = { type: 'error', error: { type: 'api_error', message: error.message } }; if (res.headersSent) { send('error', { error: value.error }); res.end(); } else { res.writeHead(error.status || 502, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); } } };
}
function createCodexBridge({ token, port, relayToken, models, version = () => '0.167.0', http = require('http') }) {
  const live = new Map();
  async function handle(req, res) {
    const reply = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
    if (req.headers.origin) return reply(403, { error: { message: '代理不接受浏览器跨域请求' } });
    if (!equal(req.headers.authorization, 'Bearer ' + token) && !equal(req.headers['x-api-key'], token)) return reply(401, { type: 'error', error: { type: 'authentication_error', message: 'Codex 订阅代理密钥无效' } });
    const path = new URL(req.url, 'http://localhost').pathname.slice(PREFIX.length);
    if (path === '/v1/models' && req.method === 'GET') {
      try { const catalog = await models(); const data = catalog.models.map(m => ({ id: m.id, type: 'model', display_name: m.name || m.id, created_at: '2026-01-01T00:00:00Z' })); return reply(200, { data, has_more: false, first_id: data[0]?.id || null, last_id: data.at(-1)?.id || null }); }
      catch { return reply(503, { error: { message: 'Codex 订阅模型目录暂不可用，请检查账号状态' } }); }
    }
    if (!['/v1/messages', '/v1/messages/count_tokens'].includes(path) || req.method !== 'POST') return reply(404, { error: { message: '支持 /v1/messages、/v1/messages/count_tokens 和 /v1/models' } });
    let bytes = 0, chunks = [], upstream, ping, output;
    const cancel = () => { clearInterval(ping); upstream?.destroy(); };
    res.on('close', cancel); req.on('aborted', cancel);
    try {
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) throw Object.assign(invalid('请求体超过 16 MiB'), { status: 413 }); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw invalid('请求不是有效 JSON'); }
      const request = toResponses(body);
      if (path.endsWith('/count_tokens')) return reply(200, { input_tokens: Math.ceil(Buffer.byteLength(JSON.stringify(request)) / 3) });
      const meta = body.metadata?.user_id || req.headers['session-id'] || '';
      const session = 'bridge-' + crypto.createHash('sha256').update(typeof meta === 'string' ? meta || crypto.randomUUID() : JSON.stringify(meta)).digest('hex').slice(0, 40);
      const entry = live.get(session) || { inflight: 0 }; entry.inflight++; entry.lastAt = Date.now(); live.set(session, entry);
      res.once('close', () => { entry.inflight--; entry.lastAt = Date.now(); });
      if (live.size > 500) for (const [key, value] of live) { if (!value.inflight) live.delete(key); if (live.size <= 500) break; }
      output = createOutput(body, res);
      ping = setInterval(() => output.ping(), 15000); ping.unref?.();
      const data = Buffer.from(JSON.stringify(request));
      upstream = http.request({ hostname: '127.0.0.1', port, path: '/codex-subscription/internal/responses', method: 'POST', headers: { authorization: 'Bearer ' + relayToken, 'content-type': 'application/json', 'content-length': data.length, 'session-id': session, originator: 'codex_cli_rs', version: version() } }, response => {
        let pending = '', total = 0; const decoder = new StringDecoder('utf8');
        const fail = err => { output.fail(err); cancel(); };
        response.on('error', () => fail(new Error('Codex 上游连接中断')));
        response.on('aborted', () => fail(new Error('Codex 上游响应中断')));
        const consume = text => {
          pending += text; if (Buffer.byteLength(pending) > 16 * 1024 * 1024) throw new Error('上游事件超过大小限制');
          let end;
          while ((end = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, end).trimEnd(); pending = pending.slice(end + 1);
            if (line.startsWith('data:')) { const raw = line.slice(5).trim(); if (raw && raw !== '[DONE]') output.event(JSON.parse(raw)); }
          }
        };
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = []; response.on('data', c => { total += c.length; if (total < 65536) error.push(c); });
          response.on('end', () => { let message = 'Codex 订阅请求失败：HTTP ' + response.statusCode; try { const e = JSON.parse(Buffer.concat(error)); message += ' · ' + (e.error?.message || e.error || e.message || ''); } catch {} fail(Object.assign(new Error(message), { status: response.statusCode })); }); return;
        }
        response.on('data', c => { try { consume(decoder.write(c)); } catch (err) { fail(err); } });
        response.on('end', () => { try { consume(decoder.end() + '\n'); if (!output.done()) throw new Error('Codex 上游提前结束，未收到完成事件'); } catch (err) { fail(err); } finally { clearInterval(ping); } });
      });
      upstream.setTimeout(10 * 60 * 1000, () => upstream.destroy(new Error('Codex 订阅请求超时')));
      upstream.on('error', () => { output.fail(new Error('Codex 订阅代理连接失败或超时')); clearInterval(ping); });
      upstream.end(data);
    } catch (error) { clearInterval(ping); if (output) output.fail(error); else reply(error.status || 400, { type: 'error', error: { type: 'invalid_request_error', message: error.message } }); }
  }
  return { handle, sessions: () => [...live].map(([sessionId, row]) => ({ sessionId, engine: 'claude', provider: 'codex-subscription', running: row.inflight > 0, lastAt: row.lastAt })) };
}
module.exports = { PREFIX, equal, toResponses, createOutput, createCodexBridge };
