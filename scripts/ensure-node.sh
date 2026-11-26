#!/bin/sh
# Print a bin directory usable by both the installer and a later SSH login.
set -eu
usable() {
  [ -x "$1/node" ] && [ -x "$1/npm" ] &&
    "$1/node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' &&
    PATH="$1:$PATH" "$1/npm" --version >/dev/null
}
if command -v node >/dev/null && command -v npm >/dev/null &&
   node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' &&
   npm --version >/dev/null; then
  dirname "$(command -v node)"
  exit 0
fi

base="$HOME/.local/share/my-agents"
runtime="$base/node"
if usable "$runtime/bin"; then echo "$runtime/bin"; exit 0; fi
case "$(uname -s)" in Darwin) platform=darwin;; Linux) platform=linux;; *) echo '请先安装 Node.js 18+ 和 npm，再重试。' >&2; exit 1;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64;; arm64|aarch64) arch=arm64;; *) echo '当前架构请先安装 Node.js 18+ 和 npm。' >&2; exit 1;; esac
if [ -e "$runtime" ]; then echo "请检查已有运行环境 $runtime/bin/node 和 npm，然后重试。" >&2; exit 1; fi
umask 077
mkdir -p "$base"
tmp=$(mktemp -d "$base/.node.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
echo '正在从 nodejs.org 下载并校验当前用户专用的 Node.js 24 LTS…' >&2
dist=https://nodejs.org/dist
curl -fsSL --retry 2 "$dist/latest-v24.x/SHASUMS256.txt" -o "$tmp/sums"
file=$(awk -v suffix="-$platform-$arch.tar.gz" '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-/ && substr($2, length($2)-length(suffix)+1)==suffix {print $2; exit}' "$tmp/sums")
[ -n "$file" ] || { echo 'Node.js 官网缺少此平台的安装包。' >&2; exit 1; }
version=${file#node-}; version=${version%%-*}
curl -fsSL --retry 2 "$dist/$version/$file" -o "$tmp/$file"
(
  cd "$tmp"
  awk -v f="$file" '$2 == f {print $1 "  " f}' sums > checksum
  if command -v sha256sum >/dev/null; then sha256sum -c checksum >&2; else shasum -a 256 -c checksum >&2; fi
  mkdir unpack
  tar -xzf "$file" --strip-components=1 -C unpack
  usable "$tmp/unpack/bin" || { echo '下载的 Node.js 无法在当前系统运行，请安装兼容版本后重试。' >&2; exit 1; }
  unpack/bin/node -e 'const fs = require("fs"); try { fs.renameSync("unpack", process.argv[1]); } catch (e) { if (!["EEXIST","ENOTEMPTY"].includes(e.code)) throw e; }' "$runtime"
)
usable "$runtime/bin"
echo "$runtime/bin"
