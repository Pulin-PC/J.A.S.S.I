#!/bin/zsh
# Start J.A.S.S.I's brain (Claude Code -> your live site) automatically whenever you log in to this Mac.
#   zsh brain/autostart.sh        turn it on (run again after updating brain/bridge.js)
#   zsh brain/autostart.sh off    turn it off
# The brain is copied to ~/.jassi/app (outside Google Drive, so it starts reliably) and run by macOS launchd.
# Log: ~/.jassi/brain.log
set -e
LABEL=com.jassi.brain
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [[ "$1" == "off" ]]; then
  rm -f "$PLIST"
  echo "Auto-start is off. The brain is stopped."
  exit 0
fi

HERE="${0:A:h}"
ROOT="${HERE:h}"
DEST="$HOME/.jassi/app"
[[ -f "$ROOT/.env" ]] && grep -qE '^JASSI_CLOUD_BRAIN_TOKEN=.' "$ROOT/.env" || { echo "No JASSI_CLOUD_URL / JASSI_CLOUD_BRAIN_TOKEN in $ROOT/.env (they are written when you deploy)."; exit 1; }
mkdir -p "$DEST/brain"
cp "$HERE/bridge.js" "$DEST/brain/bridge.js"
grep -E '^JASSI_(CLOUD_URL|CLOUD_BRAIN_TOKEN|CLAUDE_MODEL|CLAUDE_EFFORT)=' "$ROOT/.env" > "$DEST/.env"
chmod 600 "$DEST/.env"

NODE="$(command -v node)"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$DEST/brain/bridge.js</string><string>cloud</string></array>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/.jassi/brain.log</string>
  <key>StandardErrorPath</key><string>$HOME/.jassi/brain.log</string>
</dict>
</plist>
EOF

launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Auto-start is on. The brain starts now and every time you log in. Log: ~/.jassi/brain.log"
