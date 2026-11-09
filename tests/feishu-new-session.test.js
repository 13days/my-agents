const test=require('node:test'),assert=require('node:assert/strict');
const {newSessionForm}=require('../feishu-new-session');
test('large catalogs and a CJK first query fit the Feishu card payload limit',()=>{
 const rows=Array.from({length:100},(_,i)=>({id:'id-'+i,name:'项目'.repeat(40),label:'机器'.repeat(40)}));
 const card=newSessionForm({draft:{id:'draft',revision:0,machineId:'id-90',workspaceId:'id-90',engine:'claude',prompt:'问题'.repeat(500),cwd:'/project'},machines:rows,projects:rows,models:rows,engines:[{id:'claude',label:'Claude Code'}],owner:'owner',key:'key'});
 assert.ok(Buffer.byteLength(JSON.stringify({msg_type:'interactive',content:JSON.stringify(card)}))<28000);
 const form=card.body.elements.find(item=>item.tag==='form');
 assert.equal(form.elements.find(item=>item.name==='prompt').default_value.length,1000);
 for(const select of form.elements.filter(item=>item.tag==='select_static'))assert.ok(select.options.some(option=>option.value===select.initial_option));
});
