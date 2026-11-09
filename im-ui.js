// IM entry points. A planned channel never receives an active configuration form.
const IM_CHANNELS = [
  { id: 'feishu', name: ['飞书 / Lark', 'Feishu / Lark'], available: true, description: ['机器人接入，支持私聊、群聊与话题', 'Bot access for private chats, groups and topics'] },
  { id: 'wecom', name: ['企业微信', 'WeCom'], available: false, description: ['预留渠道，适配器尚未接入', 'Planned channel; adapter not implemented yet'] },
];
let imSelectedChannel = localStorage.getItem('panel-im-channel') || 'feishu', imRenderRevision = 0;
if (!IM_CHANNELS.some(channel => channel.id === imSelectedChannel)) imSelectedChannel = 'feishu';
if (localStorage.getItem('panel-section') === 'feishu') localStorage.setItem('panel-section', 'im');
function isFeishuView() { return state.type === 'im' && imSelectedChannel === 'feishu'; }
function imHeader(data) {
  return viewHeading('im') + `<div class="im-channels" role="group" aria-label="${esc(rt('IM 渠道', 'IM channels'))}">${IM_CHANNELS.map(channel => {
    const status = !channel.available ? rt('尚未接入', 'Not available') : data?.phase === 'connected' ? rt('已连接', 'Connected') : rt('可接入', 'Available');
    return `<button type="button" class="im-channel" data-im-channel="${channel.id}" aria-pressed="${channel.id === imSelectedChannel}"><span class="im-channel-icon">${icon('chat')}</span><span class="im-channel-copy"><strong>${esc(rt(...channel.name))}</strong><small>${esc(rt(...channel.description))}</small></span><span class="im-channel-state${channel.available ? ' available' : ''}">${esc(status)}</span></button>`;
  }).join('')}</div>`;
}
function bindIMChannelControls() {
  document.querySelectorAll('[data-im-channel]').forEach(button => button.onclick = () => {
    imSelectedChannel = button.dataset.imChannel;
    localStorage.setItem('panel-im-channel', imSelectedChannel);
    writeRoute(); renderIMAccess();
  });
}
function prepareIMPage() {
  $('#empty').style.display = 'none'; $('#metabar').style.display = 'none';
  $('#render').classList.add('wide'); $('#render').style.display = 'block';
  $('#title').firstChild.textContent = rt('IM 接入', 'IM connections'); $('#fpath').textContent = '';
  $('#editBtn').disabled = $('#delBtn').disabled = true;
}
function imChannelError(message) {
  $('#render').innerHTML = imHeader() + `<section class="chart im-channel-placeholder" role="alert"><p>${esc(message)}</p><button type="button" class="btn" data-im-channel="feishu">${esc(rt('重试', 'Retry'))}</button></section>`;
  bindIMChannelControls();
}
async function renderIMAccess() {
  const revision = ++imRenderRevision;
  stopFeishuPolling(); prepareIMPage();
  if (imSelectedChannel === 'feishu') {
    $('#render').innerHTML = imHeader() + `<p class="route-muted im-loading">${esc(rt('正在读取飞书连接…', 'Loading Feishu connection…'))}</p>`;
    bindIMChannelControls();
    return renderFeishuGateway(revision);
  }
  $('#render').innerHTML = imHeader() + `<section class="chart im-channel-placeholder"><span class="im-channel-state">${esc(rt('尚未接入', 'Not available'))}</span><h2>${esc(rt('企业微信', 'WeCom'))}</h2><p>${esc(rt('企业微信适配器尚未实现，目前还不能配置或收发消息。', 'The WeCom adapter is not implemented. Configuration and messaging are not available yet.'))}</p><p class="route-muted">${esc(rt('当前可通过飞书 / Lark 使用会话、引擎、模型和任务管理。后续 IM 渠道将接入同一套工作空间。', 'Use Feishu / Lark for sessions, engines, models and tasks today. Future IM channels will connect to the same workspace.'))}</p><button type="button" class="btn" data-im-channel="feishu">${esc(rt('配置飞书 / Lark', 'Configure Feishu / Lark'))}</button></section>`;
  bindIMChannelControls();
}
