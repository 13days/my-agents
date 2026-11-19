function heartflowCard({proposal:p,owner,coordinator,panelUrl=''}) {
  const resolved=(p.resolutions||[]).map(r=>r.reason+'\n'+r.evidence.map(e=>e.quote).join('\n')).join('\n\n');
  const active=!p.state||['pending','deferred'].includes(p.state);
  const actions=p.actions.map((a,i)=>`${i+1}. ${a.sessionId?'续接 '+(a.sessionTitle||a.sessionId):'新建任务'}\n${a.engine} · ${a.machineId} · ${a.cwd}\n${a.prompt}`).join('\n\n');
  const content=`${resolved ? '执行记录核对：\n'+resolved+'\n\n' : ''}${p.summary}\n\n推荐依据：${p.reason}\n\n${actions}\n\n版本 ${p.version} · 确认后追加排队，正在执行的任务不会被打断。`;
  const value=decision=>({action:'heartflow_review',id:p.id,version:p.version,owner,coordinator,decision});
  const elements=[{tag:'div',text:{tag:'plain_text',content:content.slice(0,16000)}}];
  const buttons=[];
  // Never approve a truncated action description from a card.
  if(active&&content.length<=16000&&p.actions.length)buttons.push({tag:'button',text:{tag:'plain_text',content:'确认全部行动'},type:'primary',value:value('approve')});
  if(active)buttons.push({tag:'button',text:{tag:'plain_text',content:'暂缓'},value:value('defer')},{tag:'button',text:{tag:'plain_text',content:'忽略'},value:value('ignore')});
  if(panelUrl)buttons.push({tag:'button',text:{tag:'plain_text',content:'查看来源 / 修改关联'},url:panelUrl.replace(/\/$/,'')+'/heartflow'});
  if(buttons.length)elements.push({tag:'action',actions:buttons});
  return {config:{wide_screen_mode:true},header:{title:{tag:'plain_text',content:'心流 · '+p.title},template:'purple'},elements};
}
module.exports={heartflowCard};
