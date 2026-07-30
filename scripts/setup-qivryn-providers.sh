#!/usr/bin/env bash
# setup-qivryn-providers.sh
#
# Installs the Qivryn config and .env into ~/.qivryn so the Qivryn
# VS Code extension can use GitHub Copilot and OCA paid models directly —
# no local proxy, no background daemon.
#
# Usage:
#   bash ~/Documents/qivryn/scripts/setup-qivryn-providers.sh
#
# Options:
#   --dry-run       Print what would be done without writing any files
#   --env-only      Regenerate ~/.qivryn/.env only (re-reads OCA token)
#   --copilot-only  Install config only, skip OCA token check
#
# Re-run after any auth change:
#   Copilot:  auto-refreshes — no action needed
#   OCA:      bash ~/Documents/codex-oca-tool/codex-oca-temp.sh refresh
#             bash ~/Documents/qivryn/scripts/setup-qivryn-providers.sh --env-only
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CONFIG_SRC="$REPO_DIR/.qivryn-config/config.yaml"
QIVRYN_DIR="$HOME/.qivryn"
CONFIG_DST="$QIVRYN_DIR/config.yaml"
ENV_DST="$QIVRYN_DIR/.env"
OCA_SECRETS_FILE="${OCA_SECRETS_FILE:-$HOME/.codex/oca-secrets.json}"
COPILOT_AUTH_FILE="${COPILOT_AUTH_FILE:-$HOME/.codex/copilot-auth.json}"

DRY_RUN=0
ENV_ONLY=0
COPILOT_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=1 ;;
    --env-only)     ENV_ONLY=1 ;;
    --copilot-only) COPILOT_ONLY=1 ;;
  esac
done

log()  { printf '  %s\n' "$*"; }
info() { printf '\033[1;34m▶  %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓  %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠  %s\033[0m\n' "$*" >&2; }

write_file() {
  local dst="$1" content="$2" mode="${3:-644}"
  if [ "$DRY_RUN" = "1" ]; then
    printf '[dry-run] would write %s\n' "$dst"
    return
  fi
  mkdir -p "$(dirname "$dst")"
  printf '%s' "$content" > "$dst"
  chmod "$mode" "$dst"
}

# ── Step 1: ensure ~/.qivryn exists ────────────────────────────────────────
info "Checking ~/.qivryn directory"
if [ ! -d "$QIVRYN_DIR" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    log "would create $QIVRYN_DIR"
  else
    mkdir -p "$QIVRYN_DIR"
    ok "Created $QIVRYN_DIR"
  fi
else
  ok "Directory exists: $QIVRYN_DIR"
fi

# ── Step 2: sync models from live backends then write config.yaml ─────────────
if [ "$ENV_ONLY" = "0" ]; then
  info "Syncing models from live backends"
  SYNC_SCRIPT="$REPO_DIR/scripts/sync-models.mjs"
  if [ -f "$SYNC_SCRIPT" ] && command -v node >/dev/null 2>&1; then
    if [ "$DRY_RUN" = "1" ]; then
      log "would run: node $SYNC_SCRIPT"
    else
      node "$SYNC_SCRIPT" 2>&1 | while IFS= read -r line; do log "$line"; done
      ok "Model sync complete: $CONFIG_DST"
    fi
  else
    # Fallback: copy static config
    [ -f "$CONFIG_SRC" ] || { printf '\033[1;31m✗  Source not found: %s\033[0m\n' "$CONFIG_SRC" >&2; exit 1; }
    if [ "$DRY_RUN" = "1" ]; then
      log "would copy $CONFIG_SRC → $CONFIG_DST"
    else
      cp -p "$CONFIG_SRC" "$CONFIG_DST"
      ok "Installed (static): $CONFIG_DST"
    fi
  fi
fi

# ── Step 3: write ~/.qivryn/.env with OCA token ────────────────────────────
if [ "$COPILOT_ONLY" = "0" ]; then
  info "Reading OCA token"
  OCA_KEY=""
  if [ -f "$OCA_SECRETS_FILE" ] && command -v jq >/dev/null 2>&1; then
    OCA_KEY="$(jq -r '.ocaApiKey // empty' "$OCA_SECRETS_FILE" 2>/dev/null || true)"
  fi

  if [ -z "$OCA_KEY" ]; then
    warn "OCA token not found in $OCA_SECRETS_FILE"
    warn "Run: bash ~/Documents/codex-oca-tool/codex-oca-temp.sh login"
    warn "OCA models will not work until this is done."
    [ "$ENV_ONLY" = "1" ] && exit 1
  else
    ok "OCA token found (length=${#OCA_KEY})"
  fi

  ENV_CONTENT="# Qivryn provider env — do not commit.
# Regenerate: bash ~/Documents/qivryn/scripts/setup-qivryn-providers.sh --env-only

OCA_API_KEY=${OCA_KEY}
"
  write_file "$ENV_DST" "$ENV_CONTENT" "600"
  [ "$DRY_RUN" = "0" ] && ok "Wrote $ENV_DST (mode 600)"
fi

# ── Step 4: verify Copilot auth ───────────────────────────────────────────────
info "Checking Copilot auth export"
if [ -f "$COPILOT_AUTH_FILE" ]; then
  ok "Auth file present: $COPILOT_AUTH_FILE"
  ok "Qivryn will auto-refresh the Copilot bearer token at runtime (no proxy needed)"
else
  warn "Copilot auth file not found: $COPILOT_AUTH_FILE"
  warn "Run: bash ~/Documents/codex-oca-tool/install.sh --copilot-setup"
  warn "Then in VS Code: Codex Copilot: Export Token and Enable"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
printf '\n'
info "Done"
[ "$DRY_RUN" = "1" ] && log "(dry-run — nothing written)"
[ "$ENV_ONLY" = "0" ] && [ "$DRY_RUN" = "0" ] && [ -f "$CONFIG_DST" ] && log "Config : $CONFIG_DST"
[ "$COPILOT_ONLY" = "0" ] && [ "$DRY_RUN" = "0" ] && log "Env    : $ENV_DST (chmod 600)"
printf '\n'
printf 'Providers:\n'
printf '  github-copilot  →  https://api.githubcopilot.com/   (direct, auto-refresh)\n'
printf '  mlx             →  built-in local MLX bridge          (Qivryn-managed)\n'
printf '  oca             →  Oracle Code Assist LiteLLM HTTPS  (direct, JWT)\n'
printf '\n'
printf 'Reload VS Code to apply: Developer → Reload Window\n'
printf '\n'
