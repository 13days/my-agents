const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRunStore } = require('../core/run-store');
const { createChatJob } = require('../core/chat-job');
function fixture(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'run-journal-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir; }
test('task journal restores complete output and replays only events after the acknowledged sequence', t => {
 const dir=fixture(t),store=createRunStore({dir}),row=store.begin({conversationId:'conversation-one'},{messageId:'message-one',prompt:'hello'});
 store.update(row.id,{sessionId:'native-thread'});const job=createChatJob({sessionId:'native-thread'},{journal:store.journal(row.id)});
 job.publish('input',{id:'message-one',prompt:'hello'});job.publish('text',{messageId:'message-one',text:'first '});job.publish('text',{messageId:'message-one',text:'second'});job.publish('done',{messageId:'message-one'});
 const restored=createRunStore({dir});restored.recover();assert.equal(restored.find('native-thread').state,'completed');
 assert.deepEqual(restored.journal(row.id).read(2).map(r=>r.event),['text','done']);assert.throws(()=>restored.begin({}, {messageId:'message-one'}),/已经接收/);
 const snapshot=createChatJob({sessionId:'native-thread'},{journal:restored.journal(row.id),recovered:true});assert.equal(snapshot.closed,true);assert.equal(snapshot.events.find(e=>e.event==='text').data.text,'first second');
});
test('an interrupted task recovers as unknown and is never replayed automatically',t=>{
 const dir=fixture(t),store=createRunStore({dir}),row=store.begin({conversationId:'conversation-one'},{messageId:'message-one',prompt:'change files'});
 store.journal(row.id).append('input',{id:'follow-up-message',prompt:'continue'});
 const restored=createRunStore({dir});restored.recover();assert.equal(restored.find(row.id).state,'unknown');assert.equal(restored.hasMessage('follow-up-message'),true);
 assert.equal(restored.journal(row.id).read().at(-1).event,'end');assert.throws(()=>restored.begin({}, {messageId:'follow-up-message'}),/已经接收/);
});
test('one corrupt task does not prevent the proxy and control service from starting',t=>{
 const dir=fixture(t),record=path.join(dir,'runs','broken-task');fs.mkdirSync(record,{recursive:true});fs.writeFileSync(path.join(record,'meta.json'),'{broken');
 const store=createRunStore({dir});assert.equal(store.status().unreadable.length,1);assert.ok(fs.existsSync(path.join(record,'meta.json')));assert.equal(store.begin({}, {messageId:'new-message'}).state,'preparing');
});
