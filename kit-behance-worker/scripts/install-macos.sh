#!/bin/zsh
set -euo pipefail

source_dir="${0:A:h:h}"
install_dir="${BEHANCE_WORKER_INSTALL_DIR:-$HOME/Library/Application Support/Kit/BehanceWorker}"
label="com.rangerandfox.kit-behance-worker"
agent_dir="$HOME/Library/LaunchAgents"
log_dir="$HOME/Library/Logs/Kit"
plist="$agent_dir/$label.plist"
env_file="${KIT_ENV_FILE:-$HOME/Library/Application Support/Kit/BehanceWorker/.env}"
dropbox_path="${DROPBOX_SYNC_PATH:-$HOME/Library/CloudStorage/Dropbox-Ranger&Fox/Ranger & Fox}"
profile_dir="${BEHANCE_PROFILE_DIR:-$HOME/Library/Application Support/Kit/BehanceProfile}"
node_path="${KIT_WORKER_NODE:-$(command -v node)}"
node_major="$($node_path -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  echo "Kit's browser worker requires Node.js 22 or newer; found $($node_path --version) at $node_path." >&2
  echo "Set KIT_WORKER_NODE to a supported Node.js binary and run the installer again." >&2
  exit 1
fi

plist_value() {
  print -r -- "$1" | sed -e 's/&/\\\&amp;/g' -e 's/|/\\|/g'
}

install_dir_plist="$(plist_value "$install_dir")"
node_path_plist="$(plist_value "$node_path")"
env_file_plist="$(plist_value "$env_file")"
dropbox_path_plist="$(plist_value "$dropbox_path")"
profile_dir_plist="$(plist_value "$profile_dir")"
log_dir_plist="$(plist_value "$log_dir")"

mkdir -p "$agent_dir" "$log_dir" "$profile_dir" "$install_dir"
if [[ -f "$env_file" ]] && grep -q '^SUPABASE_SERVICE_ROLE_KEY=' "$env_file"; then
  echo "Refusing to install: the dedicated worker environment must not contain SUPABASE_SERVICE_ROLE_KEY." >&2
  exit 1
fi
if ! security find-generic-password -s com.rangerandfox.kit-studio-worker >/dev/null 2>&1; then
  echo "Missing macOS Keychain item: com.rangerandfox.kit-studio-worker" >&2
  exit 1
fi
(cd "$source_dir" && npm run build)
ditto "$source_dir/dist" "$install_dir/dist"
ditto "$source_dir/node_modules" "$install_dir/node_modules"

sed \
  -e "s|__LABEL__|$label|g" \
  -e "s|__NODE__|$node_path_plist|g" \
  -e "s|__WORKER_DIR__|$install_dir_plist|g" \
  -e "s|__ENV_FILE__|$env_file_plist|g" \
  -e "s|__DROPBOX_PATH__|$dropbox_path_plist|g" \
  -e "s|__PROFILE_DIR__|$profile_dir_plist|g" \
  -e "s|__LOG_DIR__|$log_dir_plist|g" \
  "$source_dir/scripts/macos-launch-agent.plist.template" > "$plist"

launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
loaded=false
for attempt in 1 2 3; do
  if launchctl bootstrap "gui/$(id -u)" "$plist"; then
    loaded=true
    break
  fi
  sleep 2
done
if [[ "$loaded" != true ]]; then
  echo "Could not register $label after three attempts." >&2
  exit 1
fi
launchctl kickstart -k "gui/$(id -u)/$label"
echo "Installed and started $label"
