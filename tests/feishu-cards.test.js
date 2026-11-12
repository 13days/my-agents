const test = require('node:test');
const assert = require('node:assert/strict');
const cards = require('../feishu-cards');
const context = { owner: 'ou_owner', key: '["ou_owner","oc_chat","main"]' };
const nodes = value => value && typeof value === 'object' ? [value, ...Object.values(value).flatMap(nodes)] : [];
const actions = card => nodes(card).filter(node => node.type === 'callback').map(node => node.value);

test('model pickers expose callback options with the target session and stay within the card budget', () => {
  const card = cards.modelPicker({ ...context, engine: 'claude', sessionId: 'session-a', model: 'custom-model', models: Array.from({ length: 100 }, (_, index) => ({ id: 'model-' + index, name: '中文模型'.repeat(40) })) });
  const select = nodes(card).find(node => node.tag === 'select_static');
  assert.equal(select.initial_option, 'custom-model');
  assert.equal(select.behaviors[0].value.id, 'session-a');
  assert.equal(select.behaviors[0].value.action, 'set_model');
  assert.equal(select.behaviors[0].value.owner, context.owner);
  assert.equal(select.options.length, 52);
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 28000);
  assert.match(JSON.stringify(card), /前 50 个模型/);
});

test('session pages retain global command numbers and callback routing while hiding technical paths', () => {
  const rows = Array.from({ length: cards.SESSION_PAGE_SIZE }, (_, i) => ({ id: 'session-' + (i + 5), title: '*title* ' + i, project: '/workspace/project', running: i === 0 }));
  const card = cards.sessionList({ ...context, rows, total: 47, page: 1, query: 'project', selected: rows[1].id });
  assert.equal(card.schema, '2.0');
  const details = nodes(card).find(node => node.tag === 'collapsible_panel');
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
  assert.deepEqual(choices.map(value => value.engine), ['claude']);
  assert.ok(choices.every(value => value.key === context.key));
  assert.match(JSON.stringify(picker), /分别保留上下文/);
  const current = cards.currentSession({ ...context, binding: { id: 'codex-session', cwd: '/project', engine: 'codex' }, running: false });
  assert.match(JSON.stringify(current), /Codex/);
  assert.ok(actions(current).some(value => value.action === 'engine'));
  const task = cards.task({ ...context, binding: { id: 'codex-session', cwd: '/project', engine: 'codex' }, title: 'Task', view: { text: 'Done', phase: '已完成', done: true, tools: new Map(), permissions: new Map() }, elapsed: 1000 });
  assert.match(JSON.stringify(task), /Codex/);
  assert.equal(actions(task).some(value => ['engine', 'models', 'nodes'].includes(value.action)), false);
  assert.ok(actions(task).some(value => value.action === 'view'));
  const claudeProject = cards.projectList({ ...context, rows: ['/project'], total: 1, page: 0, engine: 'claude' });
  assert.equal(actions(claudeProject).find(value => value.action === 'new').engine, 'claude');
});

test('new session cards confirm project and engine without offering nonexistent history', () => {
  const binding = { id: 'not-started-id', cwd: '/workspace/project', engine: 'codex' };
  const pending = cards.currentSession({ ...context, binding, running: false });
  assert.ok(actions(pending).some(value => value.action === 'projects' && value.engine === 'codex'));
  assert.equal(actions(pending).some(value => ['history', 'switch', 'sessions'].includes(value.action)), false);
  assert.doesNotMatch(JSON.stringify(pending.body.elements.filter(e => e.tag === 'markdown')), /最近对话|not-started-id/);
  const existing = cards.currentSession({ ...context, binding, item: { id: binding.id, title: 'Existing', engine: 'codex' }, running: false });
  assert.ok(actions(existing).some(value => value.action === 'history'));
  const legacy = cards.currentSession({ ...context, binding: { id: binding.id, cwd: binding.cwd }, item: { id: binding.id, engine: 'codex' }, running: false });
  assert.equal(actions(legacy).find(value => value.action === 'projects').engine, 'codex');
});

test('detailed task cards show available Codex reasoning summaries and real tool results', () => {
  const task = cards.task({ ...context, binding: { id: 'codex-session', cwd: '/project', engine: 'codex' }, title: 'Check file', view: { text: 'Done', phase: '已完成', done: true, reasoning: new Map([['r', 'Public summary']]), tools: new Map([['t', { name: 'shell', state: '已完成', input: 'pwd', output: '/project' }]]), permissions: new Map() }, elapsed: 1000 });
  const text = JSON.stringify(task); assert.match(text, /思考摘要/); assert.match(text, /Public summary/); assert.match(text, /pwd/); assert.match(text, /shell/);
});

test('session choices with long CJK titles retain readable labels within the Feishu budget', () => {
  const rows = Array.from({ length: cards.SESSION_PAGE_SIZE }, (_, i) => ({ id: '11111111-2222-4333-8444-' + String(i).padStart(12, '0'), title: '任务'.repeat(60), project: '/workspace/' + '项目'.repeat(35) }));
  const card = cards.sessionList({ owner: 'ou_' + 'a'.repeat(32), key: JSON.stringify(['ou_' + 'a'.repeat(32), 'oc_' + 'b'.repeat(32), 'om_' + 'c'.repeat(32)]), rows, total: 100, page: 0 });
  assert.equal(actions(card).filter(value => value.action === 'switch').length, cards.SESSION_PAGE_SIZE);
  assert.ok(Buffer.byteLength(JSON.stringify({ msg_type: 'interactive', content: JSON.stringify(card) })) < 30000);
  assert.equal(cards.PAGE_SIZE, 5);
});

test('each session folds user messages and shows actual rounds, creation and activity times', () => {
  const card = cards.sessionList({ ...context, timeZone: 'Asia/Shanghai', rows: [{ id: 'session-user', title: '<image path="/tmp/private.png"></image>帮我修复', engine: 'codex', project: '/work/repo', turns: 12, createdAt: '2026-11-01T01:00:00Z', lastAt: '2026-11-09T01:00:00Z', userMessages: [{ round: 11, text: '用户之前的问题', timestamp: '2026-11-08T01:00:00Z' }, { round: 12, text: '用户最近的问题', timestamp: '2026-11-09T01:00:00Z' }] }], total: 1, page: 0 });
  const fold = nodes(card).find(node => node.tag === 'collapsible_panel');
  assert.equal(fold.expanded, false); assert.match(JSON.stringify(card), /帮我修复/);
  assert.match(JSON.stringify(card), /12 轮/); assert.match(JSON.stringify(card), /创建 2026\/11\/01 09:00/);
  assert.match(JSON.stringify(fold), /用户最近的问题/); assert.doesNotMatch(JSON.stringify(card), /private.png/);
  assert.ok(actions(card).some(value => value.action === 'user_messages' && value.id === 'session-user'));
});

test('session entries retain readable CJK previews within Feishu limits', () => {
  const rows = Array.from({ length: cards.SESSION_PAGE_SIZE }, (_, i) => ({ id: '11111111-2222-4333-8444-' + String(i).padStart(12, '0'), title: '任务'.repeat(60), project: '/workspace/' + '项目'.repeat(35), turns: 200, first: Date.now(), last: Date.now(), userMessages: [199, 200].map(round => ({ round, text: '中'.repeat(100), timestamp: new Date().toISOString() })) }));
  const card = cards.sessionList({ owner: 'ou_' + 'a'.repeat(32), key: JSON.stringify(['ou_' + 'a'.repeat(32), 'oc_' + 'b'.repeat(32), 'om_' + 'c'.repeat(32)]), rows, total: 100, page: 0, query: '中'.repeat(80) });
  assert.equal(nodes(card).filter(node => node.tag === 'collapsible_panel').length, cards.SESSION_PAGE_SIZE);
  assert.equal(actions(card).filter(value => value.action === 'switch').length, cards.SESSION_PAGE_SIZE);
  assert.ok(Buffer.byteLength(JSON.stringify({ msg_type: 'interactive', content: JSON.stringify(card) })) < 30000);
  assert.ok(nodes(card).filter(node => node.tag).length < 200);
});

test('task action rows have at most two full-width buttons so labels remain readable', () => {
  const card = cards.task({ ...context, binding: { id: 'session', cwd: '/project' }, view: { done: false, phase: '正在思考', text: '', tools: new Map(), permissions: new Map() }, title: 'Task', elapsed: 1000 });
  const rows = nodes(card).filter(node => node.tag === 'column_set' && node.columns?.some(column => column.elements?.some(item => item.tag === 'button')));
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.columns.length <= 2));
  assert.ok(rows.flatMap(row => row.columns).every(column => column.elements[0].width === 'fill'));
});

test('historical task actions carry stable ownership without relying on the gateway cache', () => {
  const binding = { id: 'old-session', machineId: 'mac', engine: 'claude', cwd: '/original/project', workspaceId: 'project-a' };
  const current = cards.currentSession({ ...context, binding, exists: true, running: false });
  const history = actions(current).find(value => value.action === 'history');
  assert.deepEqual(history.session, binding);
  const list = cards.sessionList({ ...context, rows: [{ ...binding, project: binding.cwd, title: 'Old session' }], total: 1, page: 0 });
  assert.equal(actions(list).find(value => value.action === 'switch').session.machineId, 'mac');
});


test('session ownership and message expansion both fit the worst-case CJK card budget', () => {
  const rows = Array.from({ length: cards.SESSION_PAGE_SIZE }, (_, i) => ({ id: '11111111-2222-4333-8444-' + String(i).padStart(12, '0'), machineId: 'panel-machine-alpha', engine: 'codex', title: '任务'.repeat(60), project: '/workspace/' + '项目'.repeat(35), turns: 200, first: Date.now(), last: Date.now(), userMessages: [199, 200].map(round => ({ round, text: '中'.repeat(100), timestamp: new Date().toISOString() })) }));
  const card = cards.sessionList({ owner: 'ou_' + 'a'.repeat(32), key: JSON.stringify(['ou_' + 'a'.repeat(32), 'oc_' + 'b'.repeat(32), 'om_' + 'c'.repeat(32)]), rows, total: 100, page: 0, query: '中'.repeat(80) });
  assert.equal(actions(card).filter(value => value.action === 'switch' && value.session.machineId === 'panel-machine-alpha').length, cards.SESSION_PAGE_SIZE);
  assert.equal(actions(card).filter(value => value.action === 'user_messages').length, cards.SESSION_PAGE_SIZE);
  assert.ok(Buffer.byteLength(JSON.stringify({ msg_type: 'interactive', content: JSON.stringify(card) })) < 30000);
});


test('session titles and latest prompts use full-width text and callbacks retain original directories', () => {
 const rows=Array.from({length:cards.SESSION_PAGE_SIZE},(_,i)=>({id:'native-session-'+i,machineId:'mac',engine:'claude',project:'/work/native/worktree',title:'project-plugin-recommendations',latestPrompt:'请检查插件推荐的数据写入与查询链路，这是需要完整辨认的问题',turns:24,userMessages:[{round:24,text:'请核对真实生产调用链路，不要只看登记项',timestamp:'2026-11-10T10:18:00Z'}]}));
 const card=cards.sessionList({...context,rows,total:300,page:0});
 const text=JSON.stringify(card);
 assert.match(text,/project-plugin-recommendations/);assert.match(text,/请检查插件推荐的数据写入与查询链路/);assert.match(text,/请核对真实生产调用链路/);
 assert.ok(card.body.elements.some(e=>e.tag==='markdown'&&e.content.includes('project-plugin-recommendations')));
 assert.ok(actions(card).filter(a=>['switch','user_messages'].includes(a.action)).every(a=>a.session?.cwd==='/work/native/worktree'&&a.session.machineId==='mac'));
 assert.ok(Buffer.byteLength(JSON.stringify({msg_type:'interactive',content:JSON.stringify(card)}))<28000);
});

test('task cards separate conversation navigation from settings and terminal actions', () => {
  const options = { ...context, binding: { id: 's', cwd: '/project', engine: 'claude' }, title: 'Task', elapsed: 2000 };
  for (const phase of ['正在思考', '已完成', '失败', '结果待核对', '连接已结束']) {
    const view = { phase, done: phase !== '正在思考', accepted: true, text: '', tools: new Map(), permissions: new Map() };
    const output = cards.task({ ...options, view }), callbacks = actions(output);
    assert.equal(new Set(callbacks.map(a => a.action)).size, callbacks.length);
    assert.deepEqual(callbacks.slice(0, 2).map(a => a.action), ['history', 'view']);
    assert.equal(callbacks.some(a => a.action === 'stop'), !view.done);
    assert.equal(callbacks.some(a => a.action === 'continue_task'), phase === '失败');
    assert.doesNotMatch(JSON.stringify(output), /查看 \/ 切换/);
    if (['结果待核对', '连接已结束'].includes(phase)) {
      assert.equal(output.header.template, 'orange');
      assert.doesNotMatch(JSON.stringify(output), /正在处理你的请求|本轮已结束/);
    }
  }
});

test('recovery removes stale processing and permission controls from previously saved cards', () => {
  const binding = { id: 's', cwd: '/project', machineId: 'mac', engine: 'claude' };
  const pending = cards.task({ ...context, binding, title: 'Task', elapsed: 2000, view: { phase: '正在处理', done: false, text: '', tools: new Map(), permissions: new Map() } });
  pending.body.elements.push(cards.button('旧版引擎按钮', { ...context, action: 'engine' }));
  const recovered = cards.interruptedTask(pending);
  assert.equal(recovered.header.title.content, '进度同步已中断');
  assert.equal(recovered.header.template, 'orange');
  assert.doesNotMatch(JSON.stringify(recovered), /正在处理你的请求|旧版引擎按钮|停止当前任务/);
  assert.deepEqual(actions(recovered).map(a => a.action), ['history', 'view']);
  assert.deepEqual(actions(recovered)[0].session, binding);
  assert.equal(pending.header.title.content, '正在处理');
  const permission = cards.task({ ...context, binding, title: 'Task', elapsed: 2000, view: { phase: '等待你的授权', done: false, text: '已完成的部分回复', tools: new Map(), permissions: new Map([['p', { id: 'p', tool: 'Bash', input: { command: 'private-command' } }]]) } });
  const restored = cards.interruptedTask(permission);
  assert.match(JSON.stringify(restored), /已完成的部分回复/);
  assert.doesNotMatch(JSON.stringify(restored), /需要授权|private-command|允许本次调用/);
});

test('historical conversation settings cannot offer controls for a different current conversation', () => {
  const output = cards.currentSession({ ...context, binding: { id: 'old', cwd: '/project' }, exists: true, running: true, isCurrent: false });
  assert.deepEqual(actions(output).map(a => a.action), ['history', 'switch']);
  assert.doesNotMatch(JSON.stringify(output), /更换 AI 模型|切换执行机器|结束本轮/);
  const active = cards.currentSession({ ...context, binding: { id: 'current', cwd: '/project' }, exists: true, running: false });
  const controls = nodes(active).find(n => n.tag === 'collapsible_panel' && n.header?.title?.content === '更改模型、账号或执行机器');
  assert.ok(controls && controls.expanded === false);
  assert.deepEqual(actions(controls).map(a => a.action), ['models', 'route', 'nodes', 'engine']);
  assert.ok(actions(controls).every(a => a.expectedSessionId === 'current'));
});

test('native background work stays orange with synchronization controls and an identifiable original session', () => {
 const view = { phase: '等待后台任务', done: false, nativeAttached: true, nativeSession: { id: 'original-session-id', name: 'Original terminal title' }, text: 'The query is still running.', warning: 'One background task is running.', tools: new Map([['agent', { name: 'Agent', state: '执行中' }]]), permissions: new Map() };
 const output = cards.task({ ...context, binding: { id: 'original-session-id', cwd: '/project', engine: 'claude' }, title: 'Inspect rollout', elapsed: 60000, view });
 assert.equal(output.header.title.content, '等待后台任务'); assert.equal(output.header.template, 'orange');
 assert.match(JSON.stringify(output), /Original terminal title/); assert.match(JSON.stringify(output), /断开飞书同步/);
 assert.ok(actions(output).some(a => a.action === 'stop')); assert.equal(actions(output).some(a => a.action === 'continue_task'), false);
 view.phase = '等待原会话汇总'; assert.equal(cards.task({ ...context, binding: { id: 'original-session-id', cwd: '/project' }, title: 'Task', elapsed: 61000, view }).header.template, 'orange');
});
