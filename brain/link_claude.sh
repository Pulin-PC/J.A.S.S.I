#!/bin/zsh
# Optional: pins J.A.S.S.I's brain to YOUR Claude account with a long-lived token (lasts about a year),
# so it keeps working even if `claude` on this Mac is logged out or into another account.
# 1) Sign in with your own account in the browser; 2) paste the token it prints. Stored only in the macOS Keychain.
set -e
CLAUDE="$(command -v claude || echo ~/.local/bin/claude)"
echo "Step 1: sign in with YOUR Claude account in the browser window."
"$CLAUDE" setup-token
echo
echo "Step 2: paste the token shown above (sk-ant-oat…, it may wrap over 2 lines), then press Return TWICE:"
TOKEN=""
while IFS= read -rs LINE && [[ -n "$LINE" ]]; do TOKEN+="$LINE"; done
TOKEN="${TOKEN//[[:space:]]/}"
echo
[[ "$TOKEN" == sk-ant-* && ${#TOKEN} -ge 90 ]] || { echo "That doesn't look like a full token (${#TOKEN} chars). Nothing saved."; exit 1; }
security add-generic-password -U -s JASSI-claude-pulin -a pulin -w "$TOKEN"
unset TOKEN
echo "Linked. J.A.S.S.I's brain now uses your account. Restart it (npm start, or npm run brain)."
