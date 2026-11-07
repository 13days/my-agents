const test = require('node:test');
const assert = require('node:assert/strict');
const cards = require('../feishu-cards');
const context = { owner: 'ou_owner', key: '["ou_owner","oc_chat","main"]' };
const nodes = value => value && typeof value === 'object' ? [value, ...Object.values(value).flatMap(nodes)] : [];
const actions = card => nodes(card).filter(node => node.type === 'callback').map(node => node.value);

test('session pages retain global command numbers and callback routing while hiding technical paths', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: 'session-' + (i + 5), title: '*title* ' + i, project: '/workspace/project', running: i === 0 }));
  const card = cards.sessionList({ ...context, rows, total: 17, page: 1, query: 'project', selected: rows[1].id });
  assert.equal(card.schema, '2.0');
  const details = card.body.elements.find(node => node.tag === 'collapsible_panel');
  assert.equal(details.expanded, false);
  assert.match(JSON.stringify(card), /6\. /);
  assert.ok(actions(card).some(value => value.action === 'sessions' && value.page === 2 && value.query === 'project'));
  assert.ok(actions(card).some(value => value.action === 'switch' && value.id === rows[1].id));
  assert.ok(actions(card).every(value => value.owner === context.owner && value.key === context.key));
});

test('task cards fold logs, preserve explicit permission decisions, and remove stop after completion', () => {
  const view = { phase: '等待你的授权', done: false, text: '正在检查', tools: new Map([['tool', { name: 'Bash', state: '执行中', input: '{"command":"npm test"}' }]]), permissions: new Map([['p1', { id: 'p1', tool: 'Bash', input: { command: 'npm test' } }]]) };
  const options = { ...context, binding: { id: 'session', cwd: '/project' }, title: '项目检查', view, elapsed: 3000 };
  const pending = cards.task(options);
  assert.equal(pending.header.template, 'orange');
  assert.equal(pending.body.elements.find(node => node.element_id === 'execution_details').expanded, false);
  assert.ok(actions(pending).some(value => value.action === 'permission' && value.requestId === 'p1' && value.behavior === 'allow'));
  view.done = true; view.phase = '已完成';
  const complete = cards.task(options);
  assert.equal(complete.header.template, 'green');
  assert.equal(actions(complete).some(value => ['stop', 'permission'].includes(value.action)), false);
});

test('large CJK output and parallel tool calls stay within message size and component budgets', () => {
  const view = { phase: '等待你的授权', done: false, text: '中'.repeat(9000), tools: new Map(Array.from({ length: 30 }, (_, i) => [i, { name: 'Bash', state: '已完成', input: '中'.repeat(5000), output: '中'.repeat(5000) }])), permissions: new Map(Array.from({ length: 10 }, (_, i) => [i, { id: 'p' + i, tool: 'Bash', description: '中'.repeat(1000), input: { command: '中'.repeat(5000) } }])) };
  const card = cards.task({ ...context, binding: { id: 'session', cwd: '/workspace/project' }, title: '任务', view, elapsed: 30000 });
  assert.ok(Buffer.byteLength(JSON.stringify({ msg_type: 'interactive', content: JSON.stringify(card) })) < 30000);
  assert.ok(nodes(card).filter(node => node.tag).length < 200);
  assert.match(JSON.stringify(card), /完整回复/);
});

test('simple group cards show tool status while withholding intermediate text, tool arguments and session data', () => {
  const view = { phase: '正在输出', done: false, text: '尚未完成的模型输出', tools: new Map([['t', { name: 'Bash', state: '执行中', input: 'private-input', output: 'private-output' }]]), permissions: new Map() };
  const options = { ...context, detailed: false, binding: { id: 'private-session-id', cwd: '/private/project' }, title: 'private-title', view, elapsed: 1000 };
  let rendered = JSON.stringify(cards.task(options));
  assert.match(rendered, /Bash/);
  assert.doesNotMatch(rendered, /尚未完成|private-|会话信息|查看会话|会话列表/);
  assert.equal(actions(cards.task(options)).length, 0);
  view.done = true; view.text = '最终模型输出'; view.phase = '已完成';
  rendered = JSON.stringify(cards.task(options)); assert.match(rendered, /最终模型输出/);
});

test('engine choices and conversation cards expose both engines with topic-scoped callbacks', () => {
  const picker = cards.enginePicker({ ...context, location: '当前话题', engine: 'codex', defaultEngine: 'claude', cwd: '/project' });
  const choices = actions(picker).filter(value => value.action === 'use_engine');
  assert.deepEqual(choices.map(value => value.engine), ['claude', 'codex']);
  assert.ok(choices.every(value => value.key === context.key));
  assert.match(JSON.stringify(picker), /分别保留上下文/);
  const current = cards.currentSession({ ...context, binding: { id: 'codex-session', cwd: '/project', engine: 'codex' }, running: false });
  assert.match(JSON.stringify(current), /Codex/);
  assert.ok(actions(current).some(value => value.action === 'engine'));
  const task = cards.task({ ...context, binding: { id: 'codex-session', cwd: '/project', engine: 'codex' }, title: 'Task', view: { text: 'Done', phase: '已完成', done: true, tools: new Map(), permissions: new Map() }, elapsed: 1000 });
  assert.match(JSON.stringify(task), /Codex/);
  assert.ok(actions(task).some(value => value.action === 'engine'));
  const claudeProject = cards.projectList({ ...context, rows: ['/project'], total: 1, page: 0, engine: 'claude' });
  assert.equal(actions(claudeProject).find(value => value.action === 'new').engine, 'claude');
});

test('new session cards confirm project and engine without offering nonexistent history', () => {
  const binding = { id: 'not-started-id', cwd: '/workspace/project', engine: 'codex' };
  const pending = cards.currentSession({ ...context, binding, running: false });
  assert.ok(actions(pending).some(value => value.action === 'projects' && value.engine === 'codex'));
  assert.equal(actions(pending).some(value => ['history', 'switch', 'sessions'].includes(value.action)), false);
  assert.doesNotMatch(JSON.stringify(pending), /最近对话|not-started-id/);
  const existing = cards.currentSession({ ...context, binding, item: { id: binding.id, title: 'Existing', engine: 'codex' }, running: false });
  assert.ok(actions(existing).some(value => value.action === 'history'));
  const legacy = cards.currentSession({ ...context, binding: { id: binding.id, cwd: binding.cwd }, item: { id: binding.id, engine: 'codex' }, running: false });
  assert.equal(actions(legacy).find(value => value.action === 'projects').engine, 'codex');
});

test('detailed task cards show available Codex reasoning summaries and real tool results', () => {
  const task = cards.task({ ...context, binding: { id: 'codex-session', cwd: '/project', engine: 'codex' }, title: 'Check file', view: { text: 'Done', phase: '已完成', done: true, reasoning: new Map([['r', 'Public summary']]), tools: new Map([['t', { name: 'shell', state: '已完成', input: 'pwd', output: '/project' }]]), permissions: new Map() }, elapsed: 1000 });
  const text = JSON.stringify(task); assert.match(text, /思考摘要/); assert.match(text, /Public summary/); assert.match(text, /pwd/); assert.match(text, /shell/);
});
