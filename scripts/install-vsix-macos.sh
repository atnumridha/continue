#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Install a Qivryn VSIX into macOS Visual Studio Code.

Usage:
  scripts/install-vsix-macos.sh [path/to/qivryn.vsix] [--code-cli /path/to/code] [--no-force]

Options:
  --code-cli PATH  VS Code CLI path. Defaults to code on PATH, then the standard macOS app path.
  --no-force      Do not pass --force to code --install-extension.
  -h, --help      Show this help.
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
code_cli="${CODE_CLI:-}"
vsix_path=""
force=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --code-cli)
      code_cli="${2:-}"
      shift 2
      ;;
    --no-force)
      force=0
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$vsix_path" ]]; then
        echo "Only one VSIX path can be provided." >&2
        exit 2
      fi
      vsix_path="$1"
      shift
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS. Use scripts/install-vsix-windows.ps1 on Windows." >&2
  exit 1
fi

if [[ -z "$vsix_path" ]]; then
  command -v node >/dev/null || {
    echo "node is required to infer the default VSIX path. Pass a VSIX path instead." >&2
    exit 1
  }
  version="$(node -p "require('$repo_root/extensions/vscode/package.json').version")"
  vsix_path="$repo_root/extensions/vscode/build/qivryn-${version}.vsix"
fi

if [[ ! -f "$vsix_path" ]]; then
  echo "VSIX not found: $vsix_path" >&2
  echo "Run scripts/build-vsix-macos.sh first, or pass a VSIX path." >&2
  exit 1
fi

if [[ -z "$code_cli" ]]; then
  if [[ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]]; then
    code_cli="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  elif [[ -x "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" ]]; then
    code_cli="/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code"
  elif command -v code >/dev/null; then
    code_cli="$(command -v code)"
  else
    echo "VS Code CLI was not found. Pass --code-cli /path/to/code." >&2
    exit 1
  fi
fi

install_args=(--install-extension "$vsix_path")
if [[ "$force" -eq 1 ]]; then
  install_args+=(--force)
fi

"$code_cli" "${install_args[@]}"
"$code_cli" --list-extensions --show-versions | grep -E '^qivryn\.qivryn@' || true

echo "Installed VSIX: $vsix_path"
