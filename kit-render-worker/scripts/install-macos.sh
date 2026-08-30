#!/bin/zsh
set -euo pipefail

source_dir="${0:A:h:h}"
install_dir="${RENDER_WORKER_INSTALL_DIR:-$HOME/Library/Application Support/Kit/RenderWorker}"
label="com.rangerandfox.kit-render-worker"
agent_dir="$HOME/Library/LaunchAgents"
log_dir="$HOME/Library/Logs/Kit"
plist="$agent_dir/$label.plist"
env_file="${KIT_ENV_FILE:-$HOME/atlas-setup/Kit/bolt/.env}"
dropbox_path="${DROPBOX_SYNC_PATH:-$HOME/Library/CloudStorage/Dropbox-Ranger&Fox/Ranger & Fox}"
ffmpeg_path="${FFMPEG_PATH:-/Applications/Plaud.app/Contents/Resources/ffmpeg}"
aerender_path="${AERENDER_PATH:-/Applications/Adobe After Effects 2026/aerender}"
afterfx_path="${AFTERFX_PATH:-/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects}"
node_path="$(command -v node)"
ffprobe_path="$source_dir/node_modules/@ffprobe-installer/darwin-arm64/ffprobe"

for required in "$env_file" "$dropbox_path" "$ffmpeg_path" "$ffprobe_path"; do
  [[ -e "$required" ]] || { print -u2 "Missing required path: $required"; exit 1; }
done

plist_value() {
  print -r -- "$1" | sed -e 's/&/\\&amp;/g' -e 's/|/\\|/g'
}

mkdir -p "$agent_dir" "$log_dir" "$install_dir"
npm run build
ditto "$source_dir/dist" "$install_dir/dist"
ditto "$source_dir/node_modules" "$install_dir/node_modules"

sed \
  -e "s|__LABEL__|$label|g" \
  -e "s|__NODE__|$(plist_value "$node_path")|g" \
  -e "s|__WORKER_DIR__|$(plist_value "$install_dir")|g" \
  -e "s|__ENV_FILE__|$(plist_value "$env_file")|g" \
  -e "s|__DROPBOX_PATH__|$(plist_value "$dropbox_path")|g" \
  -e "s|__FFMPEG__|$(plist_value "$ffmpeg_path")|g" \
  -e "s|__FFPROBE__|$(plist_value "$install_dir/node_modules/@ffprobe-installer/darwin-arm64/ffprobe")|g" \
  -e "s|__AERENDER__|$(plist_value "$aerender_path")|g" \
  -e "s|__AFTERFX__|$(plist_value "$afterfx_path")|g" \
  -e "s|__LOG_DIR__|$(plist_value "$log_dir")|g" \
  "$source_dir/scripts/macos-launch-agent.plist.template" > "$plist"

launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl kickstart -k "gui/$(id -u)/$label"
echo "Installed and started $label"
