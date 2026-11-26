#!/bin/sh
# Compile-checks the Windows build from a Mac:  sh dev/win-check.sh   (from apps/desktop/)
# Needs: rustup target add x86_64-pc-windows-msvc
# It checks the Rust code against the real Windows API. It does not link, build an .exe or run anything:
# the Windows resource compiler (llvm-rc) is replaced by a stand-in that writes an empty file.
set -e
. dev/env.sh
fake="${TMPDIR:-/tmp}/jassi-win-check"
mkdir -p "$fake"
cat > "$fake/llvm-rc" <<'RC'
#!/bin/sh
out=""
while [ $# -gt 0 ]; do case "$1" in /fo|/FO) out="$2"; shift;; esac; shift; done
[ -n "$out" ] && : > "$out"
exit 0
RC
chmod +x "$fake/llvm-rc"
PATH="$fake:$PATH" CC_x86_64_pc_windows_msvc=clang cargo check --target x86_64-pc-windows-msvc "$@"
