# TLS fingerprint sidecar build targets.
#
# The Go module is intentionally independent of the Node workspace: no Node
# dependency ever links it, and the binary is a deployment artifact managed
# by the deployment (compose/systemd), not by npm.

GO ?= go
BIN := bin/tlsfingerprint-sidecar

.PHONY: build test vet clean

build:
	$(GO) build -o $(BIN) .

test:
	$(GO) test ./...

vet:
	$(GO) vet ./...

clean:
	rm -rf bin
