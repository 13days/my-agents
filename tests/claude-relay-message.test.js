const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { claudeRelayMessage } = require('../core/claude-relay-message');
const relay = text => ({type:'user',isMeta:true,timestamp:'2026-11-24T06:07:21Z',message:{content:`Another Claude session sent a message:\n[来自飞书 · my-agents-im:message-1]\n\n${text}\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf.`}});
test('bridge display extracts the prompt and hides internal context without exposing arbitrary meta messages',()=>{
 assert.equal(claudeRelayMessage(relay('查到关键问题了吗')).text,'查到关键问题了吗');
 assert.equal(claudeRelayMessage(relay('[my-agents 飞书发送上下文，本轮有效]\nInternal routing\n[/my-agents 飞书发送上下文]\n\n现在是什么问题')).text,'现在是什么问题');
 const array=relay('正文');array.message.content=[{type:'text',text:array.message.content}];assert.equal(claudeRelayMessage(array).text,'正文');
 assert.equal(claudeRelayMessage({...relay('正文'),isSidechain:true}),null);
 assert.equal(claudeRelayMessage({type:'user',isMeta:true,message:{content:'Skill instructions'}}),null);
 assert.equal(claudeRelayMessage(relay('[my-agents 飞书发送上下文，本轮有效]\nmissing close')),null);
 const peer=relay('正文');peer.message.content=peer.message.content.replace('[来自飞书 · my-agents-im:message-1]','Other agent');assert.equal(claudeRelayMessage(peer),null);
});
test('native history retains IM user boundaries and does not glue answers across turns',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-history-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'session.jsonl');
 const assistant=text=>({type:'assistant',message:{content:[{type:'text',text}]}});
 const rows=[{type:'user',message:{content:'首次提问'}},assistant('第一轮'),{type:'user',isMeta:true,message:{content:'Skill instructions'}},relay('接下来呢'),assistant('第二轮'),relay('查到关键问题了吗'),assistant('第三轮')];
 fs.writeFileSync(file,rows.map(JSON.stringify).join('\n'));
 const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 const c=vm.createContext({...require('../message-timing'),claudeRelayMessage,fs,path,Buffer,normalizeTitle:x=>x,isCodexSession:()=>false,readHistory:()=>[],transcriptPathFor:()=>file,transcriptHead:()=>({cwd:dir}),CLAUDE_DIR:dir});
 vm.runInContext(source.slice(source.indexOf('function transcriptUserText('),source.indexOf('// Codex rollouts are keyed')),c);
 const result=c.sessionMessages('session');assert.deepEqual(Array.from(result.messages,m=>[m.role,m.text]),[['user','首次提问'],['assistant','第一轮'],['user','接下来呢'],['assistant','第二轮'],['user','查到关键问题了吗'],['assistant','第三轮']]);
 assert.equal(result.messages[2].source,'feishu');assert.equal(c.latestTranscriptPrompt(file).title,'查到关键问题了吗');
});
