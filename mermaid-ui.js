/* Local, on-demand Mermaid rendering. Incomplete streaming fences remain code. */
(() => {
  let library, libraryTheme, serial = Promise.resolve(), nextId = 0;
  const cache = new Map(), queued = new WeakSet();
  function load() {
    if (!library) library = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/mermaid/mermaid.tiny.js';
      script.onload = () => resolve(window.mermaid);
      script.onerror = () => { script.remove(); library = null; reject(new Error('图表资源加载失败')); };
      document.head.append(script);
    });
    return library;
  }
  async function render(block) {
    const theme = document.documentElement.dataset.theme || 'dark';
    if (!block.isConnected || block.dataset.diagramTheme === theme) return;
    const first = !block.dataset.diagramTheme;
    block.dataset.diagramTheme = theme;
    const source = block.querySelector('.mermaid-source');
    const canvas = block.querySelector('.mermaid-canvas');
    const status = block.querySelector('.mermaid-status');
    const button = block.querySelector('.mermaid-toggle');
    button.onclick = () => {
      source.hidden = !source.hidden;
      button.textContent = source.hidden ? '查看源码' : '收起源码';
      button.setAttribute('aria-expanded', String(!source.hidden));
    };
    status.textContent = '正在绘制图表…';
    try {
      const text = source.querySelector('code').textContent;
      if (text.length > 30000) throw new Error('图表过大');
      const key = theme + text;
      let svg = cache.get(key);
      if (!svg) {
        const mermaid = await load();
        if (!block.isConnected) return;
        if (libraryTheme !== theme) {
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
            maxTextSize: 30000, maxEdges: 200, theme: theme === 'light' ? 'default' : 'dark',
            htmlLabels: false, flowchart: { htmlLabels: false }, fontFamily: 'system-ui, sans-serif' });
          libraryTheme = theme;
        }
        // Cache the template, but give every displayed SVG independent IDs.
        ({ svg } = await mermaid.render('ma-mermaid-template', text));
        cache.set(key, svg);
        if (cache.size > 20) cache.delete(cache.keys().next().value);
      }
      if (!block.isConnected) return;
      svg = svg.replaceAll('ma-mermaid-template', 'ma-mermaid-' + (++nextId));
      canvas.querySelector(':scope > svg')?.remove();
      canvas.hidden = false;
      canvas.insertAdjacentHTML('afterbegin', svg);
      status.textContent = '图表';
      if (first) source.hidden = true;
    } catch (error) {
      status.textContent = '图表未能绘制，请查看源码';
      canvas.hidden = true;
      source.hidden = false;
      button.textContent = '收起源码';
      button.setAttribute('aria-expanded', 'true');
    }
  }
  function scan() {
    const theme = document.documentElement.dataset.theme || 'dark';
    document.querySelectorAll(`#render [data-mermaid-pending], #render [data-diagram-theme]:not([data-diagram-theme="${theme}"])`).forEach(block => {
      if (queued.has(block)) return;
      queued.add(block);
      block.removeAttribute('data-mermaid-pending');
      serial = serial.then(() => {
        queued.delete(block);
        if (!block.isConnected) { block.setAttribute('data-mermaid-pending', ''); return; }
        return render(block);
      }).catch(() => {});
    });
  }
  document.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('render');
    if (!root) return;
    new MutationObserver(scan).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    new MutationObserver(scan).observe(root, { childList: true, subtree: true });
    scan();
  });
})();
