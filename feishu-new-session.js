// JSON 2.0 form: field edits are local; only the submit button starts work.
function newSessionForm({ draft, machines, projects, engines, models = [], error = '', owner, key }, limit = 40) {
  const {card,markdown,button}=require('./feishu-cards');
  const plain=content=>({tag:'plain_text',content:String(content).slice(0,48)});
  const options=items=>items.map(([value,label])=>({text:plain(label),value}));
  const select=(name,label,value,items)=>{ if(value&&!items.some(item=>item[0]===value))items.push([value,'当前选择：'+value]); return [markdown('**'+label+'**'),{tag:'select_static',name,required:true,width:'fill',initial_option:value,options:options(items)}]; };
  const fields=[
    ...select('machineId','执行机器',draft.machineId,machines.slice(0,limit).map(m=>[m.id,`${m.label}${m.online===false?' · 离线':''}`])),
    ...select('workspaceId','工作项目',draft.workspaceId||'__default__',[['__default__','所选机器的默认目录'],...projects.slice(0,limit).map(p=>[p.id,p.name]),['__directory__','填写自定义目录']]),
    markdown('自定义目录（仅选择「填写自定义目录」时使用）'),
    {tag:'input',name:'cwd',input_type:'text',default_value:draft.cwd||'',placeholder:plain('所选执行机器上的绝对路径或 ~/ 路径'),max_length:1000},
    ...select('engine','执行引擎',draft.engine,engines.map(e=>[e.id,e.label])),
    ...select('model','模型',draft.model||'__default__',[['__default__',draft.engine === 'codex' ? '默认（账号实时推荐）' : '默认（CLI / 代理配置）'],...models.filter(m=>m.id!=='__default__').slice(0,limit).map(m=>[m.id,m.name||m.id])]),
    markdown('其他模型 ID（选填；填写后优先使用）'),
    {tag:'input',name:'modelId',input_type:'text',default_value:draft.modelId||'',max_length:100},
    ...select('worktree','工作区',draft.worktree===false?'original':'isolated',[['isolated','独立 Git worktree'],['original','使用项目原目录']]),
    markdown('**第一条问题**'),
    {tag:'input',name:'prompt',required:true,input_type:'multiline_text',default_value:draft.prompt||'',placeholder:plain('填写第一条问题，提交后开始执行'),max_length:1000,width:'fill'},
    {...button('提交并开始',{action:'new_submit',draftId:draft.id,revision:draft.revision,owner,key},'primary'),name:'start_session',form_action_type:'submit'},
  ];
  const result = card('新建任务',[
    ...(error?[markdown('**未能启动：** '+String(error).replace(/[<>]/g,''))]:[]),
    markdown('选择完成后一次提交。项目目录按所选机器解析；第一条问题可以直接修改。本表单仅发起人可提交。'),
    ...(projects.length > limit || models.length > limit ? [markdown('下拉框展示部分选项；其他项目可填写自定义目录，模型可直接填写 ID。')] : []),
    {tag:'form',name:'new_session',elements:fields},
  ],{subtitle:'my-agents · 填写后提交',template:error?'orange':'blue',summary:error?'未能启动，修改表单后可重新提交':'选择机器、项目、引擎并填写第一条问题'});
  if (limit > 5 && Buffer.byteLength(JSON.stringify({msg_type:'interactive',content:JSON.stringify(result)})) > 28000) return newSessionForm({draft,machines,projects,engines,models,error,owner,key},Math.max(5,Math.floor(limit/2)));
  return result;
}
module.exports={newSessionForm};
