#!/usr/bin/env python3
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('proxy_statusline', Path(__file__).resolve().parents[1] / 'scripts/proxy-statusline.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class StatuslineTest(unittest.TestCase):
    def test_last_request_and_client_are_distinct(self):
        value = module.render_my_agents({'request': {'proxyName': 'Ferry', 'accountName': 'Ferry', 'model': 'ferry-gpt', 'state': 'success'}}, 'claude-opus-5-5')
        self.assertIn('最近请求', value)
        self.assertIn('Ferry / ferry-gpt', value)
        self.assertIn('客户端：claude-opus-5-5', value)

    def test_codex_account_is_explicit(self):
        value = module.render_my_agents({'request': {'proxyName': 'Codex bridge', 'accountName': 'Codex system', 'model': 'gpt-test', 'state': 'pending'}}, 'opus')
        self.assertIn('Codex bridge → Codex system / gpt-test', value)
        self.assertIn('处理中', value)

    def test_no_request_is_configuration_not_observation(self):
        value = module.render_my_agents({'target': {'accountName': 'Ferry', 'model': 'configured'}}, 'opus')
        self.assertIn('配置，待捕获', value)
        self.assertNotIn('最近请求', value)

    def test_failure_and_terminal_sanitization(self):
        value = module.render_my_agents({'request': {'proxyName': 'bad\n\x1b[31m', 'model': 'model\r', 'state': 'error', 'status': 429}}, 'opus')
        self.assertIn('失败', value)
        self.assertIn('HTTP 429', value)
        self.assertNotIn('\n', value)
        self.assertNotIn('\x1b', value)

    def test_missing_session_never_uses_another_request(self):
        response = io.BytesIO(json.dumps({'modelMeaning': 'sent-to-upstream', 'sessionId': '', 'request': {'proxyName': 'other-window', 'model': 'private', 'state': 'success'}, 'target': {'accountName': 'Ferry'}}).encode())
        opener = type('Opener', (), {'open': lambda *_args, **_kwargs: response})()
        output = io.StringIO()
        with patch.object(module, 'my_agents_panel', return_value='http://127.0.0.1:4321'), patch.object(module.sys, 'stdin', io.StringIO('{"model":{"id":"opus"}}')), patch.object(module.urllib.request, 'build_opener', return_value=opener), patch.dict(module.os.environ, {'CLAUDE_CONFIG_DIR': '/nonexistent', 'ANTHROPIC_BASE_URL': 'http://127.0.0.1:4322'}), contextlib.redirect_stdout(output):
            module.main()
        self.assertNotIn('other-window', output.getvalue())
        self.assertIn('待捕获', output.getvalue())

    def test_other_endpoints_show_only_the_client(self):
        self.assertIsNone(module.my_agents_panel('https://api.anthropic.com'))
        self.assertIsNone(module.my_agents_panel('http://127.0.0.1:8790'))


unittest.main()
