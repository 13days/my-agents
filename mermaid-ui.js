/* Local, on-demand Mermaid rendering. Incomplete streaming fences remain code. */
(() => {
  let library, serial = Promise.resolve(), nextId = 0;
  const cache = new Map();
  function load() {
    if (!library) library = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/mermaid/mermaid.tiny.js';
      script.onload = () => {
        try {
          window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict',
            suppressErrorRendering: true, maxTextSize: 30000, maxEdges: 200,
            theme: 'dark', htmlLabels: false, flowchart: { htmlLabels: false },
            fontFamily: 'system-ui, sans-serif',
            themeVariables: { primaryColor: '#292624', primaryTextColor: '#e8e9ec',
              primaryBorderColor: '#dca17d', lineColor: '#9398a3', background: '#191b1f' } });
          resolve(window.mermaid);
        } catch (error) { reject(error); }
      };
      script.onerror = () => { script.remove(); library = null; reject(new Error('图表资源加载失败')); };
      document.head.append(script);
    });
    return library;
  }
  async function render(block) {
    if (!block.isConnected) return;
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
      let svg = cache.get(text);
      if (!svg) {
        const mermaid = await load();
        if (!block.isConnected) return;
        // Cache the template, but give every displayed SVG independent IDs.
        ({ svg } = await mermaid.render('ma-mermaid-template', text));
        cache.set(text, svg);
        if (cache.size > 20) cache.delete(cache.keys().next().value);
      }
      if (!block.isConnected) return;
      svg = svg.replaceAll('ma-mermaid-template', 'ma-mermaid-' + (++nextId));
      canvas.insertAdjacentHTML('afterbegin', svg);
      status.textContent = '图表';
      source.hidden = true;
    } catch (error) {
      status.textContent = '图表未能绘制，请查看源码';
      canvas.hidden = true;
      source.hidden = false;
      button.textContent = '收起源码';
      button.setAttribute('aria-expanded', 'true');
    }
  }
  function scan() {
    document.querySelectorAll('#render [data-mermaid-pending]').forEach(block => {
      block.removeAttribute('data-mermaid-pending');
      serial = serial.then(() => render(block)).catch(() => {});
    });
  }
  document.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('render');
    if (!root) return;
    new MutationObserver(scan).observe(root, { childList: true, subtree: true });
    scan();
  });
})();
