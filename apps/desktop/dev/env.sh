# Build settings for this project. Use:  . dev/env.sh   (from apps/desktop/)
# Homebrew's rustup is not on the PATH by default, and build output must stay out of the synced folder.
if command -v brew >/dev/null 2>&1; then PATH="$(brew --prefix rustup 2>/dev/null)/bin:$PATH"; fi
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$HOME/Library/Caches/jassi/desktop-target"
# Sign dev builds with this Mac's own certificate (dev/local-signing.sh) so permissions survive rebuilds.
# A Developer ID set in APPLE_SIGNING_IDENTITY beforehand wins.
if [ -z "${APPLE_SIGNING_IDENTITY:-}" ] && security find-certificate -c "J.A.S.S.I Local Signing" >/dev/null 2>&1; then
  export APPLE_SIGNING_IDENTITY="J.A.S.S.I Local Signing"
fi
