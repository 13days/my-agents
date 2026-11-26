const { card, button, buttons, collapse } = require('../feishu-cards');

// Source messages and prompts can contain literal Markdown and @ tags.
const literal = content => ({ tag: 'div', text: { tag: 'plain_text', content } });

function heartflowCard({ proposal, owner, coordinator, panelUrl = '' }) {
  const { id, title, summary, reason, topic, actions, resolutions = [], state, version } = proposal;
  const review = decision => ({ action: 'heartflow_review', id, version, owner, coordinator, decision });
  const active = !state || ['pending', 'deferred'].includes(state);
  const details = [reason, topic?.summary, ...resolutions.map(item => [item.reason, ...item.evidence.map(e => (e.source === 'feishu' ? (e.senderName || e.senderId) + '：' : '') + e.quote)].join('\n'))].filter(Boolean);
  const render = compact => {
    const elements = [literal(String(summary || title).slice(0, compact ? 500 : 3000))];
    if (actions.length && compact) {
      elements.push(literal(actions.length + ' 项行动，请在助理页面查看完整内容并确认。'));
    } else {
      for (const item of actions) elements.push(literal((item.sessionId ? '续接 ' + (item.sessionTitle || item.sessionId) : '新建任务') + '\n' + [item.engine, item.machineId, item.cwd].filter(Boolean).join(' · ') + '\n' + item.prompt));
    }
    if (details.length) elements.push(collapse('判断依据与后续记录', [literal(details.join('\n\n').slice(0, compact ? 1200 : 5000))]));
    const controls = [];
    if (active && actions.length && !compact) controls.push(button('确认全部行动', review('approve'), 'primary'));
    if (active) controls.push(button('暂缓', review('defer')), button('忽略', review('ignore')));
    if (panelUrl) controls.push({ tag: 'button', text: { tag: 'plain_text', content: '查看助理' }, size: 'small', behaviors: [{ type: 'open_url', default_url: panelUrl.replace(/\/$/, '') + '/assistant' }] });
    if (controls.length) elements.push(buttons(controls));
    return card('助理 · ' + title, elements, { template: 'purple' });
  };
  if (actions.length > 10 || actions.some(item => String(item.prompt).length > 16000)) return render(true);
  const result = render(false);
  return Buffer.byteLength(JSON.stringify({ content: JSON.stringify(result) })) > 27000 ? render(true) : result;
}
module.exports = { heartflowCard };
