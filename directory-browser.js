// The authenticated panel lists folders on the selected execution host, including headless nodes.
function chooseMachineDirectory(machine, { initial, reset = false } = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'node-access-dialog directory-browser';
  dialog.setAttribute('aria-labelledby', 'directory-title');
  dialog.innerHTML = `<header><div><h2 id="directory-title">${esc(rt('选择文件夹', 'Choose a folder'))}</h2><span>${esc(machine.label || machine.id)}</span></div><button type="button" class="btn" data-cancel>${esc(rt('取消', 'Cancel'))}</button></header>
    <form class="directory-location"><label><span>${esc(rt('当前位置', 'Location'))}</span><input spellcheck="false" autocomplete="off" aria-label="${esc(rt('文件夹路径', 'Folder path'))}"></label><button class="btn">${esc(rt('前往', 'Go'))}</button></form>
    <div class="directory-tools"><button type="button" class="btn" data-home>${esc(rt('主目录', 'Home'))}</button><button type="button" class="btn" data-parent>${esc(rt('上一级', 'Up one level'))}</button><label><input type="checkbox"> ${esc(rt('显示隐藏目录', 'Show hidden folders'))}</label></div>
    <div class="directory-entries"></div><p role="status" aria-live="polite"></p><footer>${reset ? `<button class="btn" data-reset>${esc(rt('恢复为用户主目录', 'Use home by default'))}</button>` : ''}<button class="btn primary" data-choose>${esc(rt('选择此文件夹', 'Choose this folder'))}</button></footer>`;
  const get = selector => dialog.querySelector(selector);
  const location = get('.directory-location input'), entries = get('.directory-entries'), status = get('[role=status]');
  const choose = get('[data-choose]'), up = get('[data-parent]'), hidden = get('[type=checkbox]');
  let selected = null, page = null, revision = 0;
  async function browse(path, offset = 0) {
    const current = ++revision;
    choose.disabled = true; up.disabled = true; entries.inert = true;
    location.value = path; status.textContent = rt('正在读取目录…', 'Loading folders…');
    if (!offset) entries.replaceChildren();
    try {
      const query = new URLSearchParams({ machineId: machine.id, path, offset, hidden: hidden.checked ? '1' : '0' });
      const next = await api('GET', 'workspaces/directories?' + query);
      if (!dialog.open || current !== revision) return;
      page = next; location.value = page.cwd; entries.querySelector('[data-more]')?.remove();
      for (const folder of page.directories) {
        const button = document.createElement('button');
        button.type = 'button'; button.innerHTML = icon('folder'); button.append(document.createTextNode(folder.name));
        button.onclick = () => browse(folder.path);
        entries.append(button);
      }
      if (page.nextOffset != null) {
        const more = document.createElement('button'); more.type = 'button'; more.dataset.more = '';
        more.textContent = rt('显示更多文件夹', 'Show more folders'); more.onclick = () => browse(page.cwd, page.nextOffset); entries.append(more);
      }
      entries.inert = false; choose.disabled = false; up.disabled = page.parent === page.cwd;
      status.textContent = entries.children.length ? '' : rt('此处没有可见的子文件夹。', 'No visible subfolders here.');
    } catch (error) {
      if (current !== revision || !dialog.open) return;
      page = null; entries.replaceChildren(); status.textContent = error.message;
    }
  }
  get('form').onsubmit = event => { event.preventDefault(); browse(location.value.trim() || '~'); };
  location.oninput = () => { ++revision; choose.disabled = true; };
  get('[data-home]').onclick = () => browse('~');
  up.onclick = () => { if (page) browse(page.parent); };
  hidden.onchange = () => browse(location.value || '~');
  get('[data-cancel]').onclick = () => dialog.close();
  if (reset) get('[data-reset]').onclick = () => { selected = ''; dialog.close(); };
  choose.onclick = () => { if (page) { selected = page.cwd; dialog.close(); } };
  document.body.append(dialog);
  return new Promise(resolve => {
    dialog.addEventListener('close', () => { ++revision; dialog.remove(); resolve(selected); }, { once: true });
    dialog.showModal(); browse(initial || machine.defaultDirectory || '~');
  });
}
