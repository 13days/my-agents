function createPermissionBridge({ child, publish, autoApprove = false }) {
  const pending = new Map(), resolved = new Set();
  function cancel(id) {
    if (!pending.delete(id)) return;
    publish('permission_resolved', { id, behavior: 'cancelled' });
  }
  return {
    handle(msg) {
      if (msg.type === 'control_cancel_request') { cancel(msg.request_id); return true; }
      if (msg.type !== 'control_request' || msg.request?.subtype !== 'can_use_tool') return false;
      const id = msg.request_id;
      if (typeof id !== 'string' || pending.has(id) || resolved.has(id)) return true;
      pending.set(id, msg.request);
      if (autoApprove) { this.respond(id, 'allow'); return true; }
      publish('permission', { id, tool: msg.request.tool_name, input: msg.request.input, description: msg.request.description || msg.request.decision_reason || '' });
      return true;
    },
    respond(id, behavior) {
      const request = pending.get(id);
      if (!request) throw new Error('该权限请求已结束，请刷新会话');
      if (!['allow', 'deny'].includes(behavior)) throw new Error('无效的权限选择');
      if (child.stdin.destroyed || child.stdin.writableEnded) throw new Error('会话连接已结束');
      const response = behavior === 'allow' ? { behavior, updatedInput: request.input } : { behavior, message: '用户拒绝了本次工具调用' };
      child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response } }) + '\n');
      pending.delete(id); resolved.add(id);
      publish('permission_resolved', { id, behavior, ...(autoApprove ? { automatic: true } : {}) });
    },
    clear() { for (const id of pending.keys()) cancel(id); },
    get size() { return pending.size; },
  };
}
module.exports = { createPermissionBridge };
