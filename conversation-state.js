(function (root, factory) {
  const value = factory();
  if (typeof module === 'object' && module.exports) module.exports = value;
  else root.ConversationState = value;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const warningPhases = { storage_error: '存储异常', native_handoff: '等待原会话接续', native_attachment: '已连接原终端', native_approval: '等待原窗口确认', native_delivery_pending: '投递待确认', node_reconnecting: '等待节点重连', recovery_unknown: '结果待核对', recovery: '结果待核对' };
  function create() { return { text: '', tools: new Map(), reasoning: new Map(), permissions: new Map(), phase: '正在处理', done: false, nativeAttached: false }; }
  function apply(view, event, data = {}) {
    if (view.done && event !== 'input') return view;
    if (event === 'input') { view.done = false; view.phase = '正在处理'; }
    if (event === 'turn') { view.phase = '正在思考'; if (view.nativeAttached) view.warning = ''; }
    if (event === 'warning') { view.nativeAttached ||= data.kind === 'native_attachment'; view.phase = warningPhases[data.kind] || '连接重试中'; view.warning = String(data.warning || '引擎正在重试，请稍候').slice(0, 500); }
    if (event === 'permission') { view.permissions.set(data.id, data); view.phase = '等待你的授权'; }
    if (event === 'permission_resolved') { view.permissions.delete(data.id); view.phase = data.behavior === 'allow' ? '正在处理' : '授权已结束'; }
    if (event === 'text') { view.text += data.text || ''; view.phase = '正在输出'; }
    if (event === 'reasoning') { view.reasoning.set(data.id, data.text); view.phase = '正在思考'; }
    if (event === 'tool') view.tools.set(data.id, { name: data.name, state: '执行中', input: JSON.stringify(data.input || {}, null, 2) });
    if (event === 'tool_result') { const tool = view.tools.get(data.id); if (tool) { tool.state = data.isError ? '失败' : '已完成'; tool.output = typeof data.output === 'string' ? data.output : JSON.stringify(data.output); } }
    if (event === 'error') { view.text += '\n⚠ ' + data.error; view.phase = '失败'; view.done = true; }
    if (event === 'done') { if (data.isError && !view.text) view.text = data.error || '引擎报告执行失败，请检查模型与账号配置'; view.phase = data.isError ? '失败' : data.interrupted ? '已按补充消息继续' : '已完成'; view.done = true; }
    if (event === 'stopped') { view.phase = '已停止'; view.done = true; }
    if (event === 'end') { view.phase = data.state === 'unknown' || view.phase === '结果待核对' ? '结果待核对' : '连接已结束'; view.done = true; }
    return view;
  }
  const translations = { '等待原窗口确认': ['Waiting for terminal approval','元のターミナルの承認待ち'], '投递待确认': ['Delivery awaiting confirmation','送信確認待ち'], '等待节点重连': ['Waiting for node reconnection','ノードの再接続待ち'], '结果待核对': ['Outcome needs review','結果の確認が必要'], '已连接原终端': ['Original terminal connected','元のターミナルに接続済み'], '等待原会话接续': ['Waiting to continue the original session','元のセッションの再開待ち'], '连接重试中': ['Retrying connection','接続を再試行中'] };
  return { create, apply, labels: phase => translations[phase] || [phase, phase] };
});
