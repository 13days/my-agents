const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createConversations}=require('../core/conversations');
test('portable checkpoints retain user messages and partial responses across restarts',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'conversation-checkpoints-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=createConversations({dir});store.put('saved-session',{machineId:'mac',project:'/Users/test/app',engine:'claude'});
 store.record('saved-session','input',{id:'turn',prompt:'hello'});store.record('saved-session','text',{messageId:'turn',text:'partial'});store.record('saved-session','error',{});store.flush();
 const restored=createConversations({dir}).get('saved-session');assert.equal(restored.machineId,'mac');assert.equal(restored.state,'interrupted');assert.deepEqual(restored.messages.map(m=>m.text),['hello','partial']);
 store.merge({...restored,updatedAt:restored.updatedAt-1,messages:[]});assert.equal(store.get('saved-session').messages.length,2);
});
