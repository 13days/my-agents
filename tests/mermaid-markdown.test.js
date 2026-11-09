const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.slice(html.indexOf('function esc(s)'), html.indexOf('// ---------- 项目作用域 ----------'));
const ctx = vm.createContext({});
vm.runInContext(source, ctx);
const md = text => { ctx.text = text; return vm.runInContext('md(text)', ctx); };

test('complete Mermaid fences become diagrams with escaped source', () => {
  const result = md('```mermaid\nflowchart TD\n A[<script>alert(1)</script>] --> B\n```');
  assert.match(result, /data-mermaid-pending/);
  assert.match(result, /mermaid-source/);
  assert.match(result, /&lt;script&gt;/);
  assert.doesNotMatch(result, /<script>/);
});

test('streaming fences wait for completion; ordinary code stays code', () => {
  assert.doesNotMatch(md('```mermaid\nflowchart TD\n A --> B'), /data-mermaid-pending/);
  assert.equal(md('```js\nconst a = "<b>";\n```'), '<pre><code>const a = &quot;&lt;b&gt;&quot;;</code></pre>');
  assert.match(md('before\n\n```MERMAID\nflowchart TD\n A-->B\n```\n\nafter'), /<p>after<\/p>/);
});
