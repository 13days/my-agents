// Runtime command directory shared by the gateway and the offline web guide.
function feishuHelp(engineIds, { detailed = true, copy = zh => zh } = {}) {
  const text = copy;
  const groups = [
    [text('新建与接续', 'Start or resume'), [
      ['/new', text('可附第一条问题，打开新任务。', 'Optionally include the first prompt to open a new task.')],
      ['/current', text('查看当前位置绑定的会话。', 'Show the session bound to this chat.')],
      ['/sessions', text('用关键词找会话，点行尾「切换」。展开「会话详情」查看分支、时间和用户消息。', 'Search by keyword and select Switch on the row. Expand session details for the branch, times and prompts.'), true],
      ['/switch', text('按列表序号、ID 前缀或名称切换。', 'Switch by list number, ID prefix or name.'), true],
      ['/projects', text('从已有项目中选择工作目录。', 'Choose a project directory.'), true],
      ['/history', text('查看最近的对话。', 'Read recent messages.'), true],
      ['/rename', text('后接新名称，为当前会话命名。', 'Append a name to rename the current session.'), true],
    ]],
    [text('任务执行中', 'While a task runs'), [
      ['/queue', text('后接内容，排在当前任务之后。', 'Queue a message after the running task.')],
      ['/steer', text('后接补充要求，引导当前任务。', 'Send guidance to the running task.')],
      ['/stop', text('停止当前任务，接续原终端时断开 IM 同步。', 'Stop the task or detach IM from an attached terminal.')],
      ['/ask', text('将后面的内容作为正文发送，适合以 / 开头的问题。', 'Send the rest as input, including text that starts with /.')],
    ]],
    [text('引擎、模型与账号', 'Engine, model and account'), [
      ['/engine · /use', text('查看引擎，或在命令后指定引擎。', 'Show engines or append an engine name to select one.')],
      [engineIds.map(id => '/' + id).join(' · '), text('切换引擎，可附第一条问题。', 'Switch engines and optionally include a prompt.')],
      ['/model', text('选择会话模型，default 恢复默认。', 'Choose a session model. Use default to restore the default.')],
      ['/model global', text('设置共享默认模型，可填模型 ID、current 或 default。', 'Set the shared default using a model ID, current or default.'), true],
      ['/route', text('选账号，auto 故障转移，rr 轮询，pin 序号或 off 固定或解除，reset 清除冷却，codex direct 或 proxy 切换连接。', 'Choose an account, auto for failover, rr for round robin, pin NUMBER or off to pin or unpin, reset for cooldowns, or codex direct or proxy for the connection.'), true],
    ]],
    [text('聊天与运行位置', 'Chat and machines'), [
      ['/node', text('查看执行机器，或附节点名和项目路径切换。', 'List machines or append a node name and project path to switch.')],
      ['/reply', text('按聊天保存回复格式，支持 wide、card、markdown。', 'Save wide, card or markdown replies for this chat.'), true],
      ['/status', text('查看机器人连接与当前绑定。', 'Check the bot and current binding.')],
      ['/leader', text('查看集群，附节点名可迁移主节点。', 'Show cluster status or append a node name to transfer leadership.'), true],
      ['/help', text('查看当前位置的命令。', 'Show commands for this chat.')],
    ]],
  ];
  return groups.map(([title, rows]) => ({ title, rows: rows.filter(([, , management]) => detailed || !management) }));
}
if (typeof module !== 'undefined' && module.exports) module.exports = { feishuHelp };
