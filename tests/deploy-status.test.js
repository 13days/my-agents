const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

test('rolling deployment treats incomplete health and failed HTTP reads as busy', async () => {
  const src = fs.readFileSync(path.join(__dirname,'../scripts/deploy.js'),'utf8');
  const ctx = vm.createContext({log(){},quote:s=>s});
  vm.runInContext(src.slice(src.indexOf('function remoteApi('),src.indexOf('const api =')),ctx);
  vm.runInContext(src.slice(src.indexOf('async function busyTasks('),src.indexOf('async function waitIdle(')),ctx);
  const machine = {id:'test',label:'Test',port:4321,home:'~'};
  for (const raw of [{error:'unavailable'},{ready:true,tasks:{}},{ready:true,tasks:{running:0,preparing:0,executing:'0'}}]) {
    ctx.api=async()=>raw; assert.ok((await ctx.busyTasks(machine)).length);
  }
  ctx.ssh = (_,cmd)=>{assert.match(cmd,/curl -fsS/);throw Error('HTTP 503');};
  ctx.api = ctx.remoteApi; assert.ok((await ctx.busyTasks(machine)).length);
  ctx.api = async()=>({ready:true,tasks:{running:0,preparing:1,executing:0}});
  assert.ok((await ctx.busyTasks(machine)).length);
  ctx.api = async()=>({ready:true,tasks:{running:0,preparing:0,executing:0}});
  assert.equal((await ctx.busyTasks(machine)).length,0);
});
