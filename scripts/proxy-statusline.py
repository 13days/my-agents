#!/usr/bin/env python3
"""Claude Code statusLine command: show my-agents routing beside the client model.

Usage in Claude settings.json:
  "statusLine": {"type": "command", "command": "python3 -I /path/to/my-agents/scripts/proxy-statusline.py"}

The client model and the model my-agents actually sent upstream are shown
separately. Without request evidence for this session only the configured
target is shown, marked as not yet captured.
"""
import json
import os
from pathlib import Path
import plistlib
import re
import sys
import urllib.parse
import urllib.request


def clean(value):
    # No terminal escapes or multiline content from remote metadata.
    return re.sub(r'[\x00-\x1f\x7f-\x9f]', '', str(value))[:160]


def panel_ports():
    ports = {'PORT': os.environ.get('MY_AGENTS_PORT', '4321'), 'PROXY_PORT': os.environ.get('MY_AGENTS_PROXY_PORT', '')}
    # macOS background service written by the panel records its actual ports.
    try:
        service = Path.home() / 'Library/LaunchAgents/io.my-agents.gateway.plist'
        env = plistlib.loads(service.read_bytes()).get('EnvironmentVariables', {})
        ports['PORT'] = env.get('PORT', ports['PORT'])
        ports['PROXY_PORT'] = ports['PROXY_PORT'] or env.get('PROXY_PORT', '')
    except (OSError, ValueError):
        pass
    ports['PROXY_PORT'] = ports['PROXY_PORT'] or str(int(ports['PORT']) + 1)
    return ports


def my_agents_panel(base):
    parsed = urllib.parse.urlsplit(base)
    if parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.path not in ('', '/'):
        return None
    try:
        ports = panel_ports()
        if parsed.port != int(ports['PROXY_PORT']):
            return None
        return 'http://127.0.0.1:' + str(int(ports['PORT']))
    except (TypeError, ValueError):
        return None


def render_my_agents(status, client_model):
    request = status.get('request')
    if request:
        name = request.get('proxyName') or request.get('accountName') or 'my-agents'
        account = request.get('accountName')
        if account and account != name:
            name += ' → ' + account
        labels = {'pending': '处理中', 'success': '最近请求', 'error': '最近请求失败', 'unknown': '结果未确认'}
        label = labels.get(request.get('state'), '结果未确认')
        output = f'代理（{label}）：{clean(name)} / {clean(request.get("model") or "模型待捕获")}'
        if request.get('state') == 'error' and request.get('status'):
            output += ' · HTTP ' + clean(request['status'])
        returned = request.get('responseModel')
        if returned and returned != request.get('model'):
            output += ' · 上游返回 ' + clean(returned)
    else:
        target = status.get('target') or {}
        output = '代理（配置，待捕获）：' + clean(target.get('accountName') or 'my-agents')
        if target.get('model'):
            output += ' / ' + clean(target['model'])
    return output + ' · 客户端：' + clean(client_model)


def main():
    try:
        payload = json.loads(sys.stdin.read())
    except (ValueError, TypeError):
        return
    directory = Path(os.environ.get('CLAUDE_CONFIG_DIR') or str(Path.home() / '.claude'))
    try:
        settings = json.loads((directory / 'settings.json').read_text())
    except (OSError, ValueError):
        settings = {}
    base = os.environ.get('ANTHROPIC_BASE_URL') or settings.get('env', {}).get('ANTHROPIC_BASE_URL', '')
    client_model = (payload.get('model') or {}).get('id') or settings.get('model', '')
    panel = my_agents_panel(base)
    # Don't claim my-agents is in use when the client points somewhere else.
    if not panel:
        print('客户端：' + clean(client_model))
        return
    try:
        session_id = payload.get('session_id') or ''
        query = urllib.parse.urlencode({'sessionId': session_id, 'clientModel': client_model})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(panel + '/api/proxy/statusline?' + query, timeout=0.8) as response:
            status = json.loads(response.read(16384))
        if status.get('modelMeaning') != 'sent-to-upstream':
            raise ValueError('Not a my-agents status response')
        # Without this session's ID, never present another window's request.
        if not session_id or status.get('sessionId') != str(session_id).lower():
            status['request'] = None
        print(render_my_agents(status, client_model))
    except (OSError, ValueError, TypeError):
        print('代理：my-agents 不可达 · 实际模型未确认 · 客户端：' + clean(client_model))


if __name__ == '__main__':
    main()
