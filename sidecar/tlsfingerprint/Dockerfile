# TLS fingerprint sidecar (batch-2 §2.4, task #7).
#
# Multi-stage build: the Go module is compiled with the pinned toolchain
# image, then copied into a distroless-style scratch runtime. The binary is
# a deployment artifact managed by the orchestrator (compose/systemd); the
# Node gateway only connects to its Unix socket.

FROM golang:1.27-alpine AS build
WORKDIR /src
COPY sidecar/tlsfingerprint/go.mod sidecar/tlsfingerprint/go.sum ./
RUN go mod download
COPY sidecar/tlsfingerprint/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/tlsfingerprint-sidecar .

FROM alpine:3.20
RUN addgroup -S sidecar && adduser -S sidecar -G sidecar \
    && mkdir -p /run/model-router && chown sidecar:sidecar /run/model-router
COPY --from=build /out/tlsfingerprint-sidecar /usr/local/bin/tlsfingerprint-sidecar
USER sidecar
ENV MODEL_ROUTER_TLS_FINGERPRINT_SIDECAR_SOCKET=/run/model-router/tls-fingerprint.sock
ENTRYPOINT ["/usr/local/bin/tlsfingerprint-sidecar"]
