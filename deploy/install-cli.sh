#!/bin/sh
# Install a host-side CLI wrapper without changing accounts or shell profiles.
set -eu

fail() { printf '%s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
用法：deploy/install-cli.sh [--bin-dir DIR] [--repo DIR] [--runtime-env FILE] [--dry-run]
  --bin-dir DIR       安装目录（默认：~/.local/bin）
  --repo DIR          已构建的 Cardigan 仓库（默认：本脚本所在仓库）
  --runtime-env FILE  运行时配置（默认：~/.config/cardigan/agent-ssh/runtime.env）
  --dry-run          只打印目标和生成内容，不写文件
EOF
}
# Surround each value with single quotes, escaping embedded single quotes.
# The final quote also preserves trailing newlines in command substitutions.
quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

bin_dir="$HOME/.local/bin"
repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
runtime_env="$HOME/.config/cardigan/agent-ssh/runtime.env"
dry_run=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --bin-dir|--repo|--runtime-env)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 需要路径参数"
      case "$2" in --*) fail "$1 需要路径参数" ;; esac
      case "$1" in
        --bin-dir) bin_dir=$2 ;;
        --repo) repo=$2 ;;
        --runtime-env) runtime_env=$2 ;;
      esac
      shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "未知参数：$1" ;;
  esac
done

repo=$(CDPATH='' cd -- "$repo" && pwd -P) || fail "仓库目录不存在：$repo"
[ -f "$repo/apps/cli/dist/bin.js" ] || fail "CLI 尚未构建：请在仓库运行 pnpm exec tsc -b apps/cli"
case "$bin_dir" in /*) ;; *) bin_dir="$PWD/$bin_dir" ;; esac
case "$runtime_env" in /*) ;; *) runtime_env="$PWD/$runtime_env" ;; esac
target="$bin_dir/cardigan"

if [ -e "$target" ] || [ -L "$target" ]; then
  [ -f "$target" ] && [ ! -L "$target" ] || fail "拒绝覆盖：$target 不是普通文件"
  case "$(sed -n '2p' "$target")" in
    '# cardigan:'*) ;;
    *) fail "拒绝覆盖：$target 第二行没有 # cardigan: 标记，不是托管的 Cardigan 命令" ;;
  esac
fi

wrapper() {
  printf '%s\n' '#!/bin/sh' '# cardigan: managed by deploy/install-cli.sh' 'set -eu'
  printf 'cli=%s\n' "$(quote "$repo/apps/cli/dist/bin.js")"
  printf 'runtime_env=%s\n' "$(quote "$runtime_env")"
  cat <<'EOF'
if [ -f "$runtime_env" ]; then
  set -a
  . "$runtime_env"
  set +a
fi

if [ "${CARDIGAN_RUNTIME_MODE:-local}" = agent-ssh ]; then
  groups=$(id -Gn)
  case " $groups " in
    *' cardigan-share '*) ;;
    *)
      quote() {
        printf "'"
        printf '%s' "$1" | sed "s/'/'\\\\''/g"
        printf "'"
      }
      command="exec node $(quote "$cli")"
      for arg do
        command="$command $(quote "$arg")"
      done
      exec sg cardigan-share -c "$command"
      ;;
  esac
fi
exec node "$cli" "$@"
EOF
}

if [ "$dry_run" = true ]; then
  printf '将安装到：%s\n' "$target"
  wrapper
  exit 0
fi

mkdir -p -- "$bin_dir"
temporary=$(mktemp "$bin_dir/.cardigan.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT
trap 'exit 1' HUP INT TERM
wrapper > "$temporary"
chmod 755 "$temporary"
mv -f -- "$temporary" "$target"
printf '已安装：%s\n请将 %s 加入 PATH。\n' "$target" "$bin_dir"
