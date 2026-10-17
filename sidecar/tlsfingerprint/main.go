// Command tlsfingerprint-sidecar is the model-router TLS fingerprint sidecar.
//
// It listens on a Unix socket (default /run/model-router/tls-fingerprint.sock,
// overridable with -listen or MODEL_ROUTER_TLS_FINGERPRINT_SIDECAR_SOCKET)
// and serves the dial protocol described in server.go. The process is
// expected to be managed by the deployment (systemd/compose), not spawned by
// the Node gateway — the gateway only connects to the socket.
//
// Build:  make build   (produces ./bin/tlsfingerprint-sidecar)
// Run:    ./bin/tlsfingerprint-sidecar -listen /run/model-router/tls-fingerprint.sock
package main

import (
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
)

const defaultSocketPath = "/run/model-router/tls-fingerprint.sock"

func main() {
	var socketPath string
	flag.StringVar(&socketPath, "listen", "", "Unix socket path to listen on")
	flag.Parse()
	if socketPath == "" {
		socketPath = os.Getenv("MODEL_ROUTER_TLS_FINGERPRINT_SIDECAR_SOCKET")
	}
	if socketPath == "" {
		socketPath = defaultSocketPath
	}

	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	server, err := NewSidecarServer(socketPath, logger)
	if err != nil {
		logger.Error("tls_fingerprint_sidecar_start_failed", "error", err.Error())
		os.Exit(1)
	}
	logger.Info("tls_fingerprint_sidecar_listening", "socket", socketPath)

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-signals
		_ = server.Close()
	}()

	if err := server.Serve(); err != nil {
		logger.Error("tls_fingerprint_sidecar_serve_failed", "error", err.Error())
		os.Exit(1)
	}
	logger.Info("tls_fingerprint_sidecar_stopped")
}
