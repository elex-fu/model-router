#!/bin/bash
# Generate a disposable local CA + 127.0.0.1 server certificate for TLS mock runs.
# Everything is written into the run directory (default /tmp/model-router-local-ab)
# with 0600/0700 permissions and must never be committed.
set -euo pipefail

RUN_DIR="${LOCAL_AB_RUN_DIR:-/tmp/model-router-local-ab}"
mkdir -p "$RUN_DIR"
chmod 700 "$RUN_DIR"

CA_KEY="$RUN_DIR/ca-key.pem"
CA_CERT="$RUN_DIR/certificate.pem"
SRV_KEY="$RUN_DIR/tls-key.pem"
SRV_CSR="$RUN_DIR/tls.csr"
SRV_CERT="$RUN_DIR/tls-cert.pem"
SRV_EXT="$RUN_DIR/tls.ext"

umask 077

if [ ! -f "$CA_KEY" ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out "$CA_KEY"
  openssl req -x509 -new -key "$CA_KEY" -sha256 -days 30 -subj "/CN=model-router-local-ab-ca" -out "$CA_CERT"
fi

openssl ecparam -name prime256v1 -genkey -noout -out "$SRV_KEY"
cat > "$SRV_EXT" <<'EOF'
subjectAltName = IP:127.0.0.1
EOF
openssl req -new -key "$SRV_KEY" -subj "/CN=127.0.0.1" -out "$SRV_CSR"
openssl x509 -req -in "$SRV_CSR" -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial \
  -sha256 -days 30 -extfile "$SRV_EXT" -out "$SRV_CERT"
rm -f "$SRV_CSR" "$SRV_EXT"

echo "wrote $CA_CERT (CA, pass via NODE_EXTRA_CA_CERTS) and $SRV_CERT/$SRV_KEY (mock -cert/-key)"
