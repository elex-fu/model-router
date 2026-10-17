package main

import (
	"context"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	utls "github.com/refraction-networking/utls"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// withTestTLSConfig swaps the sidecar's TLS config builder for one that
// trusts the httptest TLS server's self-signed certificate (production keeps
// system-root verification). httptest creates its package-level certificate
// lazily on the first StartTLS and shares it across servers, so a probe
// server is started (and closed) first.
func withTestTLSConfig(t *testing.T) {
	t.Helper()
	probe := httptest.NewUnstartedServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	probe.StartTLS()
	cert := probe.Certificate()
	probe.Close()
	if cert == nil {
		t.Fatalf("httptest certificate unavailable")
	}
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	previous := newTLSConfig
	newTLSConfig = func(serverName string) *utls.Config {
		return &utls.Config{ServerName: serverName, RootCAs: pool}
	}
	t.Cleanup(func() {
		newTLSConfig = previous
	})
}

// shortTempDir keeps socket paths well under the unix sockaddr_un limit;
// t.TempDir() paths can exceed it on macOS (long test names).
func shortTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "sc*")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() {
		_ = os.RemoveAll(dir)
	})
	return dir
}

func newIpcTestServer(t *testing.T) (*SidecarServer, string) {
	t.Helper()
	socketPath := filepath.Join(shortTempDir(t), "s.sock")
	server, err := NewSidecarServer(socketPath, testLogger())
	if err != nil {
		t.Fatalf("new sidecar server: %v", err)
	}
	go func() {
		_ = server.Serve()
	}()
	t.Cleanup(func() {
		_ = server.Close()
	})
	return server, socketPath
}

// dialSidecar opens one IPC connection and performs the dial handshake,
// returning the tunneled connection after a successful response.
func dialSidecar(t *testing.T, socketPath string, req *DialRequest) (net.Conn, *DialResponse) {
	t.Helper()
	conn, err := net.DialTimeout("unix", socketPath, 2*time.Second)
	if err != nil {
		t.Fatalf("ipc connect: %v", err)
	}
	if err := writeFrame(conn, req); err != nil {
		t.Fatalf("ipc write: %v", err)
	}
	var resp DialResponse
	if err := readFrame(conn, &resp); err != nil {
		t.Fatalf("ipc read: %v", err)
	}
	return conn, &resp
}

func TestIpcDefaultProfileEndToEnd(t *testing.T) {
	withTestTLSConfig(t)
	_, socketPath := newIpcTestServer(t)

	// A plain HTTP server behind the tunnel: the sidecar TLS handshake needs
	// a TLS endpoint. Use the httptest TLS server, then speak HTTP/1.1 over
	// the tunnel ourselves (the sidecar negotiated ALPN http/1.1).
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("sidecar-ok"))
	}))
	server.EnableHTTP2 = false
	server.StartTLS()
	t.Cleanup(server.Close)
	host, port := hostPort(t, server.Listener.Addr().String())

	req := &DialRequest{Host: host, Port: port, ProfileID: "default"}
	conn, resp := dialSidecar(t, socketPath, req)
	defer conn.Close()
	if !resp.OK {
		t.Fatalf("dial response not ok: %+v", resp)
	}
	request := "GET / HTTP/1.1\r\nHost: sidecar-test\r\nConnection: close\r\n\r\n"
	if _, err := conn.Write([]byte(request)); err != nil {
		t.Fatalf("tunnel write: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	if err != nil && !errors.Is(err, io.EOF) {
		t.Fatalf("tunnel read: %v", err)
	}
	if n == 0 {
		t.Fatalf("empty tunnel response")
	}
	if !contains(string(buf[:n]), "sidecar-ok") {
		t.Fatalf("unexpected tunnel payload: %q", string(buf[:n]))
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}

func TestIpcCustomProfilePayload(t *testing.T) {
	withTestTLSConfig(t)
	_, socketPath := newIpcTestServer(t)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	server.EnableHTTP2 = false
	server.StartTLS()
	t.Cleanup(server.Close)
	host, port := hostPort(t, server.Listener.Addr().String())

	req := &DialRequest{
		Host:      host,
		Port:      port,
		ProfileID: "custom",
		Profile: &DialProfilePayload{Name: "test-profile"},
	}
	conn, resp := dialSidecar(t, socketPath, req)
	defer conn.Close()
	if !resp.OK {
		t.Fatalf("dial response not ok: %+v", resp)
	}
}

func TestIpcRejectsInvalidRequests(t *testing.T) {
	_, socketPath := newIpcTestServer(t)
	cases := []struct {
		name string
		req  *DialRequest
	}{
		{"bad profile id", &DialRequest{Host: "example.com", Port: 443, ProfileID: "7"}},
		{"custom without payload", &DialRequest{Host: "example.com", Port: 443, ProfileID: "custom"}},
		{"bad port", &DialRequest{Host: "example.com", Port: 0, ProfileID: "default"}},
		{"url-shaped host", &DialRequest{Host: "https://example.com", Port: 443, ProfileID: "default"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			conn, resp := dialSidecar(t, socketPath, tc.req)
			defer conn.Close()
			if resp.OK {
				t.Fatalf("expected rejection, got ok")
			}
			if resp.Error == "" {
				t.Fatalf("rejection must carry an error message")
			}
		})
	}
}

func TestIpcDialFailureCarriesError(t *testing.T) {
	_, socketPath := newIpcTestServer(t)
	// Nothing listens on this loopback port (one dial to a closed port).
	req := &DialRequest{Host: "127.0.0.1", Port: 1, ProfileID: "default"}
	conn, resp := dialSidecar(t, socketPath, req)
	defer conn.Close()
	if resp.OK {
		t.Fatalf("expected dial failure, got ok")
	}
}

func TestFrameRoundTrip(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	go func() {
		_ = writeFrame(b, map[string]string{"k": "v"})
	}()
	var value map[string]string
	if err := readFrame(a, &value); err != nil {
		t.Fatalf("readFrame: %v", err)
	}
	if value["k"] != "v" {
		t.Fatalf("round trip mismatch: %v", value)
	}
}

func TestReadFrameRejectsOversizedFrame(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	go func() {
		var header [4]byte
		binary.BigEndian.PutUint32(header[:], maxFrameBytes+1)
		_, _ = b.Write(header[:])
	}()
	var value DialResponse
	if err := readFrame(a, &value); err == nil {
		t.Fatalf("expected an out-of-bounds frame error")
	}
}

func TestStaleSocketReplaced(t *testing.T) {
	dir := shortTempDir(t)
	socketPath := filepath.Join(dir, "s.sock")
	first, err := NewSidecarServer(socketPath, testLogger())
	if err != nil {
		t.Fatalf("first server: %v", err)
	}
	go func() {
		_ = first.Serve()
	}()
	time.Sleep(50 * time.Millisecond)
	if err := first.Close(); err != nil {
		t.Fatalf("close first: %v", err)
	}
	// The socket file may still exist after an unclean stop; a new server
	// must take it over.
	second, err := NewSidecarServer(socketPath, testLogger())
	if err != nil {
		t.Fatalf("second server over stale socket: %v", err)
	}
	go func() {
		_ = second.Serve()
	}()
	defer second.Close()
	conn, err := net.DialTimeout("unix", socketPath, 2*time.Second)
	if err != nil {
		t.Fatalf("connect to second server: %v", err)
	}
	_ = conn.Close()
}

func TestSecondServerRefusesLiveSocket(t *testing.T) {
	dir := shortTempDir(t)
	socketPath := filepath.Join(dir, "s.sock")
	first, err := NewSidecarServer(socketPath, testLogger())
	if err != nil {
		t.Fatalf("first server: %v", err)
	}
	go func() {
		_ = first.Serve()
	}()
	defer first.Close()
	time.Sleep(50 * time.Millisecond)
	if _, err := NewSidecarServer(socketPath, testLogger()); err == nil {
		t.Fatalf("expected a refusal when another sidecar is live")
	}
}

func TestDialRequestJSONBounded(t *testing.T) {
	// A profile payload over the frame bound is rejected by readFrame.
	_, socketPath := newIpcTestServer(t)
	conn, err := net.DialTimeout("unix", socketPath, 2*time.Second)
	if err != nil {
		t.Fatalf("ipc connect: %v", err)
	}
	defer conn.Close()
	big := make([]byte, maxFrameBytes)
	payload, _ := json.Marshal(map[string]any{"x": string(big)})
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(payload)))
	// The server drops the connection as soon as the out-of-bounds header is
	// seen, so either write may fail with EPIPE — both are protocol-correct.
	_, _ = conn.Write(header[:])
	_, _ = conn.Write(payload)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 1)
	if _, err := conn.Read(buf); err == nil {
		t.Fatalf("expected the oversized frame to be dropped")
	}
}

// TestContextCanceledDial ensures a canceled context does not hang the
// connection handler.
func TestContextCanceledDial(t *testing.T) {
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	server.EnableHTTP2 = false
	server.StartTLS()
	t.Cleanup(server.Close)
	host, port := hostPort(t, server.Listener.Addr().String())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := dialTLS(ctx, host, port, "", &Profile{}); err == nil {
		t.Fatalf("expected a canceled-dial error")
	}
}

var _ = os.Getenv // keep os imported for future use in this file
