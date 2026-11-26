#!/bin/sh
# One-time, per Mac: a free signing certificate that stays on this Mac only, so every dev build keeps the same identity.
# Without it, builds are signed ad hoc: each rebuild looks like a new app to macOS, and Accessibility, microphone
# and speech permissions stop counting. Real releases use an Apple Developer ID instead (README → Releasing).
# Use:  sh dev/local-signing.sh   (from apps/desktop/). Safe to run again: it does nothing if the certificate exists.
set -eu
NAME="J.A.S.S.I Local Signing"
KC="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -c "$NAME" "$KC" >/dev/null 2>&1; then
  echo "Already set up: $NAME"; exit 0
fi

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$TMP/cert.cnf" -keyout "$TMP/key.pem" -out "$TMP/cert.pem" 2>/dev/null
PASS=$(/usr/bin/openssl rand -hex 16)
/usr/bin/openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$NAME" -out "$TMP/id.p12" -passout "pass:$PASS"
# -T: only codesign may use the key, without asking each time.
security import "$TMP/id.p12" -k "$KC" -P "$PASS" -T /usr/bin/codesign >/dev/null
echo "Created: $NAME (in your login keychain; the private key never leaves this Mac)"
