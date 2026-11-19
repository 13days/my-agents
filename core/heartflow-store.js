const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const copy = value => JSON.parse(JSON.stringify(value));
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const uid = () => crypto.randomUUID();
function createHeartflowStore({ dir, now = Date.now }) {
  const file = path.join(dir, 'panel-heartflow.json');
  let state = { schema: 1, config: { enabled: false, chats: [], intervalSeconds: 60, model: '', selfId: '', since: now(), modelEnabled: true }, messages: {}, matters: {}, proposals: {}, checks: [], deliveries: {}, cursor: {}, source: {} };
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  function transaction(fn) {
    const next = copy(state), result = fn(next);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = file + '.' + uid() + '.tmp', fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file); state = next; return copy(result ?? null);
  }
  const proposal = (s, id, version) => {
    const p = Object.hasOwn(s.proposals,id) && s.proposals[id]; if (!p) fail('建议不存在', 404);
    if (p.version !== version) fail('建议已经更新，请刷新后重新 check', 409);
    return p;
  };
  function validateDraft(s, input) {
    const messageIds = [...new Set(input.messageIds || [])], matterIds = [...new Set(input.matterIds || [])];
    if (!messageIds.length || messageIds.length > 30 || messageIds.some(id => !s.messages[id] || s.messages[id].deleted)) fail('请选择 1–30 条有效来源消息');
    if (matterIds.length > 20 || matterIds.some(id => !s.matters[id])) fail('关联事项不存在');
    const title = String(input.title || '').trim(), summary = String(input.summary || '').trim();
    if (!title || title.length > 160 || summary.length > 12000) fail('建议标题或摘要长度无效');
    const actions = (input.actions || []).map(a => ({ id: a.id || uid(), sessionId: String(a.sessionId || ''), sessionTitle: String(a.sessionTitle || '').slice(0,160), engine: a.engine === 'claude' ? 'claude' : 'codex', machineId: String(a.machineId || ''), cwd: String(a.cwd || ''), prompt: String(a.prompt || '').trim() }));
    if (actions.length > 8 || new Set(actions.map(a => a.id)).size !== actions.length || actions.some(a => !a.prompt || a.prompt.length > 12000 || a.sessionId.length > 100 || a.cwd.length > 2000)) fail('每项行动需有执行内容，最多 8 项');
    return { title, summary, reason: String(input.reason || '').slice(0,3000), messageIds, matterIds, actions };
  }
  return {
    snapshot: () => copy(state), transaction,
    configure(input) { return transaction(s => {
      const c = s.config;
      if ('chats' in input) {
        if (!Array.isArray(input.chats) || input.chats.length > 30 || input.chats.some(x => !/^oc_[\w-]+$/.test(x.id))) fail('最多选择 30 个有效聊天');
        c.chats = input.chats.map(x => ({ id: x.id, name: String(x.name || x.id).slice(0,160) }));
      }
      if ('notifyEnabled' in input) c.notifyEnabled = !!input.notifyEnabled;
      if ('notifyUserId' in input) { if(input.notifyUserId && !/^ou_[\w-]+$/.test(input.notifyUserId)) fail('请输入有效的机器人配对用户 ID'); c.notifyUserId = input.notifyUserId; }
      if ('panelUrl' in input) { const u=String(input.panelUrl||'');if(u && !/^https?:\/\/[^\s]+$/.test(u))fail('面板链接必须是 HTTP(S) 地址'); c.panelUrl=u.slice(0,1000); }
      if ('enabled' in input) c.enabled = !!input.enabled;
      if ('modelEnabled' in input) c.modelEnabled = !!input.modelEnabled;
      if ('model' in input) c.model = String(input.model).slice(0,100);
      if ('selfId' in input) c.selfId = String(input.selfId).slice(0,100);
      if ('intervalSeconds' in input) c.intervalSeconds = Math.max(30, Math.min(3600, Number(input.intervalSeconds) || 60));
      if ('since' in input) { const since = Number(input.since); if (!Number.isFinite(since) || since < now()-30*86400000 || since > now()) fail('起始时间需在最近 30 天内'); c.since = since; s.cursor = {}; }
      return c;
    }); },
    ingest(messages) { return transaction(s => {
      const changed = [];
      for (const m of messages) {
        if (!m.id || !m.chatId || typeof m.text !== 'string') continue;
        const old = s.messages[m.id];
        if (old && old.text === m.text && old.deleted === m.deleted) {Object.assign(old,{identityEnriched:m.identityEnriched??old.identityEnriched,mentionNames:m.mentionNames||old.mentionNames,senderType:m.senderType||old.senderType});if(m.senderName&&m.senderName!==m.senderId)old.senderName=m.senderName;continue;}
        if (old && Number(old.updatedAt) > Number(m.updatedAt)) continue;
        s.messages[m.id] = { ...m, revision: (old?.revision || 0) + 1, receivedAt: now() }; changed.push(m.id);
        for (const p of Object.values(s.proposals)) if (p.messageIds.includes(m.id) && ['pending','deferred'].includes(p.state)) { p.version++; p.state = 'pending'; p.sourceChanged = true; p.updatedAt = now(); }
      }
      const names=new Map();
      for(const m of Object.values(s.messages)){if(m.senderName&&m.senderName!==m.senderId)names.set(m.senderId,m.senderName);for(const ref of m.mentionNames||[])if(ref.id&&ref.name)names.set(ref.id,ref.name);}
      for(const m of Object.values(s.messages))if(names.has(m.senderId))m.senderName=names.get(m.senderId);
      return changed;
    }); },
    matter(input) { return transaction(s => {
      const id = input.id || uid(), old = Object.hasOwn(s.matters,id) && s.matters[id];
      if (input.id && !old) fail('事项不存在',404);
      const title = String(input.title || '').trim(); if (!title || title.length > 160) fail('请填写事项名称');
      return s.matters[id] = { ...old, id, title, description: String(input.description || '').slice(0,6000), updatedAt: now() };
    }); },
    draft(input) { return transaction(s => {
      const fields = validateDraft(s,input), id = uid();
      return s.proposals[id] = { ...fields, id, version:1, state:'pending', createdAt:now(), updatedAt:now(), model:input.model || '', sourceChanged:false };
    }); },
    review(id, input) { return transaction(s => {
      const p = proposal(s,id,input.version);
      if (!['pending','deferred'].includes(p.state)) fail('此建议已经处理',409);
      if (!['save','approve','ignore','defer'].includes(input.decision)) fail('未知 check 操作');
      const before = copy(p), edited = ['ignore','defer'].includes(input.decision) ? copy(p) : validateDraft(s,input.draft || p);
      Object.assign(p,edited); p.version++; p.updatedAt = now(); p.sourceChanged = false;
      const selected = input.actionIds || p.actions.map(a=>a.id);
      if (input.decision === 'approve' && (!selected.length || selected.some(id=>!p.actions.some(a=>a.id===id)))) fail('请选择要执行的行动');
      if (input.decision === 'approve') {
        for (const a of p.actions.filter(a=>selected.includes(a.id))) {
          if (!a.sessionId && (!a.cwd || !a.machineId)) fail('新任务必须明确执行机器与目录');
          if (Object.values(s.deliveries).some(d=>d.proposalId===id && d.action.id===a.id)) fail('行动已经批准，未重复投递',409);
          const deliveryId = uid();
          s.deliveries[deliveryId] = { id:deliveryId, proposalId:id, version:p.version, messageId:uid(), action:copy(a), sources:p.messageIds.map(id=>copy(s.messages[id])), state:'queued', createdAt:now(), updatedAt:now() };
        }
        p.actions = p.actions.filter(a=>!selected.includes(a.id)); p.state = p.actions.length ? 'pending' : 'approved';
      } else p.state = input.decision === 'ignore' ? 'ignored' : input.decision === 'defer' ? 'deferred' : 'pending';
      s.checks.push({ id:uid(), proposalId:id, at:now(), decision:input.decision, reason:String(input.reason || '').slice(0,2000), before, after:copy(p), selectedActionIds:input.decision==='approve'?selected:[], approvedActions:input.decision==='approve'?edited.actions.filter(a=>selected.includes(a.id)):[], learning:true });
      return p;
    }); },
    combine(inputs, splitIds) { return transaction(s => {
      if (!Array.isArray(inputs) || !inputs.length || inputs.length>20) fail('请选择建议');
      const ps=inputs.map(x=>proposal(s,x.id,x.version));
      if (ps.some(p=>p.state!=='pending')) fail('只能整理待确认建议');
      const before=copy(ps); let ids=[...new Set(ps.flatMap(p=>p.messageIds))];
      if (splitIds) { if (ps.length!==1 || !splitIds.length || splitIds.length>=ids.length || splitIds.some(id=>!ids.includes(id))) fail('拆分需选择部分来源消息'); ids=[...new Set(splitIds)]; }
      const id=uid(), p={...copy(ps[0]),id,version:1,messageIds:ids,matterIds:[...new Set(ps.flatMap(p=>p.matterIds))],actions:[],summary:ps.map(p=>p.summary).join('\n').slice(0,12000),reason:'整理后请重新确认行动范围',createdAt:now(),updatedAt:now()};
      for(const key of ['noticeMessageId','noticeOwner','noticeState','notifiedVersion','historyFingerprint','followupFingerprint','topic','resolutions','resolvedActions'])delete p[key];
      s.proposals[id]=p;
      for (const old of ps) { old.version++; if(splitIds) {old.messageIds=old.messageIds.filter(id=>!ids.includes(id));old.actions=[];} else old.state='merged'; }
      s.checks.push({id:uid(),at:now(),decision:splitIds?'split':'merge',before,after:copy(p),learning:true}); return p;
    }); },
    feedback(id,input) {return transaction(s=>{
      const p=proposal(s,id,input.version),reason=String(input.reason||'').trim();
      if(!reason||reason.length>2000)fail('请填写 1–2000 字的纠正内容');
      const check={id:uid(),proposalId:id,at:now(),decision:'feedback',reason,before:copy(p),after:copy(p),learning:true};
      s.checks.push(check);return check;
    });},
    learning(id, enabled) { return transaction(s=>{const check=s.checks.find(c=>c.id===id);if(!check)fail('记录不存在',404);check.learning=!!enabled;return check;}); },
    claim(id) { return transaction(s=>{const d=s.deliveries[id];if(!d || d.state!=='queued')return null;d.state='dispatching';d.updatedAt=now();return d;}); },
    delivery(id, patch) { return transaction(s=>Object.assign(s.deliveries[id],patch,{updatedAt:now()})); },
    recover() { return transaction(s=>{for(const d of Object.values(s.deliveries))if(['dispatching','accepted','running'].includes(d.state)){d.state='unknown';d.error='服务重启，需核对原任务；未自动重发';}}); },
  };
}
module.exports={createHeartflowStore};
