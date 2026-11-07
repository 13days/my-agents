const test = require('node:test');
const assert = require('node:assert/strict');
const { createPermissionBridge } = require('../engines/claude/permissions');

test('tool execution waits for an explicit decision; allow preserves original input and is single-use', () => {
  const writes = [], events = [];
  const child = { stdin: { write: data => writes.push(JSON.parse(data)) } };
  const bridge = createPermissionBridge({ child, publish: (event, data) => events.push({ event, data }) });
  bridge.handle({ type: 'control_request', request_id: 'request-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test' } } });
  assert.equal(writes.length, 0);
  assert.equal(events[0].event, 'permission');
  assert.throws(() => bridge.respond('request-1', 'always'), /无效/);
  bridge.respond('request-1', 'allow');
  assert.deepEqual(writes[0], { type: 'control_response', response: { subtype: 'success', request_id: 'request-1', response: { behavior: 'allow', updatedInput: { command: 'npm test' } } } });
  assert.equal(bridge.size, 0);
  assert.throws(() => bridge.respond('request-1', 'allow'), /已结束/);
});

test('deny, CLI cancellation and shutdown resolve pending prompts without granting permission', () => {
  const writes = [], events = [];
  const bridge = createPermissionBridge({ child: { stdin: { write: data => writes.push(JSON.parse(data)) } }, publish: (event, data) => events.push({ event, data }) });
  const request = id => bridge.handle({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });
  request('denied'); bridge.respond('denied', 'deny');
  assert.equal(writes[0].response.response.behavior, 'deny');
  request('cancelled'); bridge.handle({ type: 'control_cancel_request', request_id: 'cancelled' });
  request('shutdown'); bridge.clear();
  assert.equal(bridge.size, 0);
  assert.equal(writes.length, 1);
  assert.equal(events.filter(e => e.event === 'permission_resolved').length, 3);
});

test('bypass mode immediately approves tool requests without publishing an approval prompt', () => {
  const writes = [], events = [];
  const bridge = createPermissionBridge({ autoApprove: true, child: { stdin: { write: data => writes.push(JSON.parse(data)) } }, publish: (event, data) => events.push({ event, data }) });
  const request = { type: 'control_request', request_id: 'auto-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'cat README.md' } } };
  assert.equal(bridge.handle(request), true);
  assert.equal(bridge.size, 0);
  assert.deepEqual(writes[0].response.response, { behavior: 'allow', updatedInput: request.request.input });
  assert.deepEqual(events, [{ event: 'permission_resolved', data: { id: 'auto-1', behavior: 'allow', automatic: true } }]);
  bridge.handle(request);
  assert.equal(writes.length, 1, 'a duplicated control request must not execute twice');
});
