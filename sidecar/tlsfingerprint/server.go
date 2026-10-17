package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	utls "github.com/refraction-networking/utls"
)

// IPC protocol (one request per connection, length-prefixed JSON frames):
//
//	client → sidecar:  u32be length | DialRequest JSON
//	sidecar → client:  u32be length | DialResponse JSON
//
// After a successful response the socket becomes a raw bidirectional byte
// tunnel to the fingerprinted TLS connection — the Node side hands it to
// undici as the connection socket and never speaks the frame protocol again.
//
// profile_id semantics (migration 116 account column):
//
//	"default" → the built-in Node.js 24.x ClientHello (no profile payload);
//	"random"  → uTLS's randomized ClientHello (HelloRandomized);
//	"custom"  → the inline profile resolved by the caller from
//	            saas_tls_fingerprint_profiles (PG is authoritative there;
//	            the sidecar is stateless).
type DialRequest struct {
	Host      string              `json:"host"`
	Port      int                 `json:"port"`
	ProfileID string              `json:"profile_id"`
	Profile   *DialProfilePayload `json:"profile,omitempty"`
	ProxyURL  string              `json:"proxy_url,omitempty"`
}

// DialProfilePayload is the inline profile for profile_id "custom". The JSON
// field names match the saas_tls_fingerprint_profiles columns (migration
// 116) one-to-one so the gateway can forward a resolved row verbatim.
type DialProfilePayload struct {
	Name                string   `json:"name"`
	EnableGREASE        bool     `json:"enable_grease"`
	CipherSuites        []uint16 `json:"cipher_suites"`
	Curves              []uint16 `json:"curves"`
	PointFormats        []uint16 `json:"point_formats"`
	SignatureAlgorithms []uint16 `json:"signature_algorithms"`
	ALPNProtocols       []string `json:"alpn_protocols"`
	SupportedVersions   []uint16 `json:"supported_versions"`
	KeyShareGroups      []uint16 `json:"key_share_groups"`
	PSKModes            []uint16 `json:"psk_modes"`
	Extensions          []uint16 `json:"extensions"`
}

type DialResponse struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

const (
	// maxFrameBytes bounds a dial request; a request larger than this is a
	// protocol error (the connection is dropped).
	maxFrameBytes = 64 * 1024
	// dialTimeout bounds the full dial+handshake for one request.
	dialTimeout = 30 * time.Second
)

// validateDialRequest enforces the bounded input shape before any dialing.
func validateDialRequest(req *DialRequest) error {
	if req == nil {
		return errors.New("dial request is required")
	}
	if req.Host == "" || len(req.Host) > 255 {
		return errors.New("dial request host is invalid")
	}
	// The host is a bare hostname, a literal IP, or a bracketed IPv6 literal
	// — never a URL. Reject control characters and URL-significant bytes.
	for i := 0; i < len(req.Host); i++ {
		c := req.Host[i]
		if c <= 0x20 || c == 0x7f {
			return errors.New("dial request host is invalid")
		}
	}
	for _, forbidden := range []byte{'/', '\\', '?', '#', '@'} {
		for i := 0; i < len(req.Host); i++ {
			if req.Host[i] == forbidden {
				return errors.New("dial request host is invalid")
			}
		}
	}
	if strings.Contains(req.Host, ":") && !(strings.HasPrefix(req.Host, "[") && strings.HasSuffix(req.Host, "]")) {
		return errors.New("dial request host is invalid")
	}
	if req.Port < 1 || req.Port > 65535 {
		return errors.New("dial request port is invalid")
	}
	switch req.ProfileID {
	case "default", "random", "custom":
	default:
		return errors.New("dial request profile id is invalid")
	}
	if req.ProfileID == "custom" && req.Profile == nil {
		return errors.New("dial request custom profile is missing")
	}
	if req.ProfileID != "custom" && req.Profile != nil {
		return errors.New("dial request profile payload is only valid for custom profiles")
	}
	if len(req.ProxyURL) > 2048 {
		return errors.New("dial request proxy url is invalid")
	}
	return nil
}

// dialProfile resolves the request's profile selector into a dialer profile.
// "random" is handled separately by the server (uTLS randomized preset).
func (req *DialRequest) dialProfile() *Profile {
	if req.Profile == nil {
		return nil
	}
	p := Profile(*req.Profile)
	return &p
}

// writeFrame writes one length-prefixed JSON frame.
func writeFrame(w io.Writer, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(payload) > maxFrameBytes {
		return errors.New("frame exceeds the protocol bound")
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(payload)))
	if _, err := w.Write(header[:]); err != nil {
		return err
	}
	_, err = w.Write(payload)
	return err
}

// readFrame reads one length-prefixed JSON frame.
func readFrame(r io.Reader, value any) error {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return err
	}
	length := binary.BigEndian.Uint32(header[:])
	if length == 0 || length > maxFrameBytes {
		return errors.New("frame length is out of bounds")
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return err
	}
	return json.Unmarshal(payload, value)
}

// SidecarServer serves the dial protocol on a Unix socket.
type SidecarServer struct {
	listener net.Listener
	logger   *slog.Logger

	mu      sync.Mutex
	closed  bool
	conns   map[net.Conn]struct{}
	onClose func()
}

// NewSidecarServer creates the socket (removing a stale socket file) and
// starts accepting connections.
func NewSidecarServer(socketPath string, logger *slog.Logger) (*SidecarServer, error) {
	if socketPath == "" {
		return nil, errors.New("socket path is required")
	}
	if dir := filepath.Dir(socketPath); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create socket directory: %w", err)
		}
	}
	// Remove a stale socket from a previous run; fail if something is
	// actually listening on it.
	if info, err := os.Stat(socketPath); err == nil && info.Mode()&os.ModeSocket != 0 {
		if probe, err := net.DialTimeout("unix", socketPath, 250*time.Millisecond); err == nil {
			_ = probe.Close()
			return nil, errors.New("another sidecar is already listening on the socket")
		}
		_ = os.Remove(socketPath)
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, err
	}
	// Same-OS-user IPC only: the socket carries provider-bound plaintext.
	_ = os.Chmod(socketPath, 0o660)
	if logger == nil {
		logger = slog.Default()
	}
	s := &SidecarServer{
		listener: listener,
		logger:   logger,
		conns:    make(map[net.Conn]struct{}),
	}
	return s, nil
}

// Serve accepts connections until Close. Each connection handles exactly one
// dial request and then relays bytes until either side closes.
func (s *SidecarServer) Serve() error {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			s.mu.Lock()
			closed := s.closed
			s.mu.Unlock()
			if closed {
				return nil
			}
			return err
		}
		s.track(conn)
		go s.handleConn(conn)
	}
}

func (s *SidecarServer) track(conn net.Conn) {
	s.mu.Lock()
	s.conns[conn] = struct{}{}
	s.mu.Unlock()
}

func (s *SidecarServer) untrack(conn net.Conn) {
	s.mu.Lock()
	delete(s.conns, conn)
	s.mu.Unlock()
}

// Close stops accepting and tears down every in-flight connection.
func (s *SidecarServer) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	conns := make([]net.Conn, 0, len(s.conns))
	for conn := range s.conns {
		conns = append(conns, conn)
	}
	s.mu.Unlock()
	for _, conn := range conns {
		_ = conn.Close()
	}
	err := s.listener.Close()
	_ = os.Remove(s.listener.Addr().String())
	return err
}

func (s *SidecarServer) handleConn(conn net.Conn) {
	defer s.untrack(conn)
	var req DialRequest
	if err := readFrame(conn, &req); err != nil {
		_ = conn.Close()
		return
	}
	if err := validateDialRequest(&req); err != nil {
		_ = writeFrame(conn, DialResponse{OK: false, Error: err.Error()})
		_ = conn.Close()
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), dialTimeout)
	defer cancel()

	var upstream net.Conn
	var dialErr error
	if req.ProfileID == "random" {
		upstream, dialErr = dialRandomized(ctx, req.Host, req.Port, req.ProxyURL)
	} else {
		upstream, dialErr = dialTLS(ctx, req.Host, req.Port, req.ProxyURL, req.dialProfile())
	}
	if dialErr != nil {
		s.logger.Debug("tls_fingerprint_dial_failed", "host", req.Host, "error", dialErr.Error())
		_ = writeFrame(conn, DialResponse{OK: false, Error: dialErr.Error()})
		_ = conn.Close()
		return
	}
	if err := writeFrame(conn, DialResponse{OK: true}); err != nil {
		_ = upstream.Close()
		_ = conn.Close()
		return
	}
	relay(conn, upstream)
}

// dialRandomized dials with uTLS's built-in randomized ClientHello
// (profile_id = "random"): a per-connection random fingerprint rather than a
// pinned one.
func dialRandomized(ctx context.Context, host string, port int, proxyURL string) (net.Conn, error) {
	addr := net.JoinHostPort(host, fmt.Sprintf("%d", port))
	var conn net.Conn
	if proxyURL == "" {
		var d net.Dialer
		c, err := d.DialContext(ctx, "tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("tls fingerprint dial: %w", err)
		}
		conn = c
	} else {
		parsed, err := parseProxyURL(proxyURL)
		if err != nil {
			return nil, err
		}
		if parsed.Scheme == "http" {
			conn, err = dialHTTPProxyTunnel(ctx, parsed, addr)
		} else {
			conn, err = dialSocks5Tunnel(ctx, parsed, addr)
		}
		if err != nil {
			return nil, err
		}
	}
	tlsConn := utls.UClient(conn, &utls.Config{ServerName: host}, utls.HelloRandomized)
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("tls fingerprint handshake: %w", err)
	}
	return tlsConn, nil
}

// relay copies bytes bidirectionally until either side errors or closes.
func relay(a, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(b, a)
		// Half-close: propagate EOF so the peer sees a clean shutdown.
		if tc, ok := b.(*net.TCPConn); ok {
			_ = tc.CloseWrite()
		} else if uc, ok := b.(interface{ CloseWrite() error }); ok {
			_ = uc.CloseWrite()
		}
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(a, b)
		if tc, ok := a.(*net.TCPConn); ok {
			_ = tc.CloseWrite()
		} else if uc, ok := a.(interface{ CloseWrite() error }); ok {
			_ = uc.CloseWrite()
		}
		done <- struct{}{}
	}()
	<-done
	_ = a.Close()
	_ = b.Close()
	<-done
}
