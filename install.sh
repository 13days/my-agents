#!/bin/sh
# Install a personal copy and start the local panel. Works when piped into sh.
set -eu
install_panel() {
  repo=https://github.com/13days/my-agents.git
  source_dir=${MY_AGENTS_INSTALL_DIR:-"$HOME/.local/share/my-agents/source"}
  if [ "${1:-}" = --help ]; then
    echo 'Usage: sh install.sh [--install-only | --connect ws://panel:port]  (set MY_AGENTS_INSTALL_DIR to choose a checkout)'
    return
  fi
  case "${1:-}" in
    --connect)
      case "${2:-}" in ws://*|wss://*) ;; *) echo '缺少面板 WebSocket 地址。' >&2; exit 2;; esac
      [ -n "${MY_AGENTS_TOKEN:-}" ] || { echo '请从面板「添加机器」重新复制接入命令。' >&2; exit 2; };;
    ''|--install-only) ;;
    *) echo 'Usage: sh install.sh [--install-only | --connect ws://panel:port]' >&2; exit 2;; esac
  command -v git >/dev/null || { echo '请先安装 Git，再运行这条命令。' >&2; exit 1; }
  if [ -e "$source_dir" ]; then
    case "$(git -C "$source_dir" config --local --get remote.origin.url 2>/dev/null || true)" in
      https://github.com/13days/my-agents|"$repo"|git@github.com:13days/my-agents.git) ;;
      *) echo "目录已被占用，请设置 MY_AGENTS_INSTALL_DIR 选择安装位置：$source_dir" >&2; exit 1;;
    esac
    [ -f "$source_dir/scripts/ensure-node.sh" ] || { echo "此目录是旧版源码，请在 $source_dir 先运行 git pull --ff-only。" >&2; exit 1; }
  else
    mkdir -p "$(dirname "$source_dir")"
    git clone --quiet "$repo" "$source_dir"
  fi
  cd "$source_dir"
  bin_dir=$(sh scripts/ensure-node.sh)
  export PATH="$bin_dir:$PATH"
  if [ -z "${1:-}" ] && node -e '
    fetch("http://127.0.0.1:" + (process.env.PORT || 4321) + "/api/health", {signal: AbortSignal.timeout(1500)})
      .then(r => r.json()).then(h => process.exit(h.ready && h.build?.protocolVersion && h.tasks ? 0 : 1)).catch(() => process.exit(1))'; then
    echo "面板已经在运行，打开 http://localhost:${PORT:-4321} 即可。"
    node core/im-clis.js
    return
  fi
  npm install --no-package-lock --no-audit --no-fund
  echo "源码目录 $PWD"
  if ! command -v claude >/dev/null && ! command -v codex >/dev/null; then
    echo '运行任务前，请安装并登录 Codex 或 Claude Code。'
  fi
  if [ "${1:-}" = --install-only ]; then return; fi
  if [ "${1:-}" = --connect ]; then exec "$bin_dir/node" server.js node --hub "$2"; fi
  export MY_AGENTS_NO_PROXY_SETUP=${MY_AGENTS_NO_PROXY_SETUP:-1}
  echo "打开 http://localhost:${PORT:-4321} 进入面板。按 Ctrl+C 结束本次运行。"
  exec "$bin_dir/node" server.js
}
install_panel "$@"
