package main

import (
	"bufio"
	"context"
	"crypto/md5"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	utls "github.com/refraction-networking/utls"
)

// The expected JA3 of the built-in Node.js 24.x default profile, as captured
// from a real Claude Code client.
const expectedJA3Hash = "44f88fca027f27bab4bb08d4af15f23e"

// --- minimal ClientHello capture -------------------------------------------------

// capturedClientHello is the parsed JA3-relevant content of one ClientHello.
type capturedClientHello struct {
	CipherSuites []uint16
	Extensions   []uint16
	Curves       []uint16
	PointFormats []uint16
}

func (c *capturedClientHello) ja3Hash() string {
	var parts []string
	join := func(vals []uint16) string {
		// GREASE values never appear in JA3.
		var kept []string
		for _, v := range vals {
			if isGREASEValue(v) {
				continue
			}
			kept = append(kept, fmt.Sprintf("%d", v))
		}
		return strings.Join(kept, "-")
	}
	parts = append(parts, "771", join(c.CipherSuites), join(c.Extensions), join(c.Curves), join(c.PointFormats))
	sum := md5.Sum([]byte(strings.Join(parts, ",")))
	return hex.EncodeToString(sum[:])
}

// captureClientHello listens once, reads the first TLS record, and parses the
// ClientHello handshake out of it (no handshake is completed).
func captureClientHello(t *testing.T) (*capturedClientHello, string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	type result struct {
		hello *capturedClientHello
		sni   string
		err   error
	}
	done := make(chan result, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			done <- result{err: err}
			return
		}
		defer conn.Close()
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		hello, sni, err := readClientHello(conn)
		done <- result{hello: hello, sni: sni, err: err}
	}()

	helloPort := listener.Addr().(*net.TCPAddr).Port
	_, dialErr := dialTLS(context.Background(), "localhost", helloPort, "", &Profile{})
	res := <-done
	if dialErr == nil {
		t.Fatalf("expected the capture listener to fail the handshake, got success")
	}
	if res.err != nil {
		t.Fatalf("read client hello: %v", res.err)
	}
	return res.hello, res.sni
}

// readClientHello reads one TLS record and extracts the JA3 fields + SNI.
func readClientHello(conn net.Conn) (*capturedClientHello, string, error) {
	header := make([]byte, 5)
	if _, err := io.ReadFull(conn, header); err != nil {
		return nil, "", err
	}
	if header[0] != 0x16 {
		return nil, "", fmt.Errorf("not a handshake record")
	}
	recordLen := int(binary.BigEndian.Uint16(header[3:5]))
	record := make([]byte, recordLen)
	if _, err := io.ReadFull(conn, record); err != nil {
		return nil, "", err
	}
	// Handshake header: type(1) length(3)
	if record[0] != 0x01 {
		return nil, "", fmt.Errorf("not a ClientHello")
	}
	body := record[4:]
	pos := 0
	readU16 := func() uint16 {
		v := binary.BigEndian.Uint16(body[pos : pos+2])
		pos += 2
		return v
	}
	readU8 := func() byte {
		v := body[pos]
		pos++
		return v
	}
	skip := func(n int) { pos += n }

	skip(2) // client_version
	skip(32) // random
	sidLen := int(readU8())
	skip(sidLen)
	cipherLen := int(readU16())
	ciphers := make([]uint16, 0, cipherLen/2)
	for i := 0; i < cipherLen/2; i++ {
		ciphers = append(ciphers, readU16())
	}
	compLen := int(readU8())
	skip(compLen)

	hello := &capturedClientHello{CipherSuites: ciphers}
	sni := ""
	if pos+2 > len(body) {
		return hello, sni, nil // no extensions
	}
	extTotal := int(readU16())
	extEnd := pos + extTotal
	for pos+4 <= extEnd {
		extType := readU16()
		extLen := int(readU16())
		extBody := body[pos : pos+extLen]
		pos += extLen
		hello.Extensions = append(hello.Extensions, extType)
		switch extType {
		case 0: // server_name: list_len(2) name_type(1) name_len(2) name
			if len(extBody) >= 5 {
				listLen := int(binary.BigEndian.Uint16(extBody[0:2]))
				nameType := extBody[2]
				nameLen := int(binary.BigEndian.Uint16(extBody[3:5]))
				if nameType == 0 && 5+nameLen <= len(extBody) && listLen >= nameLen+3 {
					sni = string(extBody[5 : 5+nameLen])
				}
			}
		case 10: // supported_groups
			if len(extBody) >= 2 {
				listLen := int(binary.BigEndian.Uint16(extBody[0:2]))
				for off := 2; off+2 <= 2+listLen && off+2 <= len(extBody); off += 2 {
					hello.Curves = append(hello.Curves, binary.BigEndian.Uint16(extBody[off:off+2]))
				}
			}
		case 11: // ec_point_formats
			if len(extBody) >= 1 {
				listLen := int(extBody[0])
				for off := 1; off < 1+listLen && off < len(extBody); off++ {
					hello.PointFormats = append(hello.PointFormats, uint16(extBody[off]))
				}
			}
		}
	}
	return hello, sni, nil
}

// --- tests ------------------------------------------------------------------------

func TestDefaultProfileJA3(t *testing.T) {
	hello, sni := captureClientHello(t)
	if sni != "localhost" {
		t.Fatalf("SNI mismatch: got %q", sni)
	}
	got := hello.ja3Hash()
	if got != expectedJA3Hash {
		t.Fatalf("JA3 mismatch:\n  got      %s\n  expected %s\nciphers=%v\nexts=%v\ncurves=%v\nformats=%v",
			got, expectedJA3Hash, hello.CipherSuites, hello.Extensions, hello.Curves, hello.PointFormats)
	}
	if len(hello.CipherSuites) != 17 {
		t.Fatalf("expected the 17 Node.js 24.x cipher suites, got %d", len(hello.CipherSuites))
	}
	if hello.Curves[0] != 0x001d || len(hello.Curves) != 3 {
		t.Fatalf("expected X25519/P-256/P-384 curves, got %v", hello.Curves)
	}
}

func newTestTLSServer(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	server.EnableHTTP2 = false
	server.StartTLS()
	t.Cleanup(server.Close)
	return server
}

func hostPort(t *testing.T, target string) (string, int) {
	t.Helper()
	host, portText, err := net.SplitHostPort(target)
	if err != nil {
		t.Fatalf("split target: %v", err)
	}
	var port int
	if _, err := fmt.Sscanf(portText, "%d", &port); err != nil {
		t.Fatalf("parse port: %v", err)
	}
	return host, port
}

func TestDirectDialHandshakeSucceeds(t *testing.T) {
	withTestTLSConfig(t)
	server := newTestTLSServer(t)
	host, port := hostPort(t, server.Listener.Addr().String())
	conn, err := dialTLS(context.Background(), host, port, "", &Profile{})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	client := &http.Client{Transport: &http.Transport{
		DialTLSContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return conn, nil
		},
	}}
	resp, err := client.Get(server.URL)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "ok" {
		t.Fatalf("unexpected body: %q", string(body))
	}
}

// TestHTTPProxyDialHandshakeSucceeds dials through a local HTTP CONNECT proxy
// that requires no auth, proving the hand-written CONNECT tunnel + handshake
// path works end to end.
func TestHTTPProxyDialHandshakeSucceeds(t *testing.T) {
	withTestTLSConfig(t)
	var proxyMu sync.Mutex
	connects := 0
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "connect only", http.StatusMethodNotAllowed)
			return
		}
		proxyMu.Lock()
		connects++
		proxyMu.Unlock()
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "no hijack", http.StatusInternalServerError)
			return
		}
		clientConn, _, err := hijacker.Hijack()
		if err != nil {
			return
		}
		defer clientConn.Close()
		upstream, err := net.Dial("tcp", r.Host)
		if err != nil {
			_, _ = clientConn.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
			return
		}
		defer upstream.Close()
		_, _ = clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
		relay(clientConn, upstream)
	}))
	t.Cleanup(proxy.Close)

	server := newTestTLSServer(t)
	host, port := hostPort(t, server.Listener.Addr().String())
	conn, err := dialTLS(context.Background(), host, port, proxy.URL, &Profile{})
	if err != nil {
		t.Fatalf("dial through proxy: %v", err)
	}
	defer conn.Close()
	if !conn.(*utls.UConn).ConnectionState().HandshakeComplete {
		t.Fatalf("expected a completed handshake")
	}
	proxyMu.Lock()
	got := connects
	proxyMu.Unlock()
	if got != 1 {
		t.Fatalf("expected exactly one CONNECT, got %d", got)
	}
}

// TestSOCKS5ProxyDialHandshakeSucceeds dials through a minimal local SOCKS5
// server (no-auth greeting only), proving the tunnel + handshake path.
func TestSOCKS5ProxyDialHandshakeSucceeds(t *testing.T) {
	withTestTLSConfig(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("socks listen: %v", err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go serveSocks5(t, conn)
		}
	}()

	server := newTestTLSServer(t)
	host, port := hostPort(t, server.Listener.Addr().String())
	proxyURL := fmt.Sprintf("socks5h://127.0.0.1:%d", listener.Addr().(*net.TCPAddr).Port)
	conn, err := dialTLS(context.Background(), host, port, proxyURL, &Profile{})
	if err != nil {
		t.Fatalf("dial through socks5: %v", err)
	}
	defer conn.Close()
	if !conn.(*utls.UConn).ConnectionState().HandshakeComplete {
		t.Fatalf("expected a completed handshake")
	}
}

// serveSocks5 implements the no-auth CONNECT subset of RFC 1928.
func serveSocks5(t *testing.T, conn net.Conn) {
	t.Helper()
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	br := bufio.NewReader(conn)
	// Greeting: version, nmethods, methods...
	header := make([]byte, 2)
	if _, err := io.ReadFull(br, header); err != nil {
		return
	}
	methods := make([]byte, int(header[1]))
	if _, err := io.ReadFull(br, methods); err != nil {
		return
	}
	if _, err := conn.Write([]byte{0x05, 0x00}); err != nil {
		return
	}
	// Request: ver cmd rsv atyp ...
	req := make([]byte, 4)
	if _, err := io.ReadFull(br, req); err != nil {
		return
	}
	if req[1] != 0x01 {
		_, _ = conn.Write([]byte{0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}
	var target []byte
	switch req[3] {
	case 0x01:
		target = make([]byte, 4)
	case 0x03:
		lenByte, err := br.ReadByte()
		if err != nil {
			return
		}
		target = make([]byte, int(lenByte))
	case 0x04:
		target = make([]byte, 16)
	default:
		return
	}
	if _, err := io.ReadFull(br, target); err != nil {
		return
	}
	portBytes := make([]byte, 2)
	if _, err := io.ReadFull(br, portBytes); err != nil {
		return
	}
	var dialAddr string
	if req[3] == 0x03 {
		dialAddr = net.JoinHostPort(string(target), fmt.Sprintf("%d", binary.BigEndian.Uint16(portBytes)))
	} else {
		dialAddr = net.JoinHostPort(net.IP(target).String(), fmt.Sprintf("%d", binary.BigEndian.Uint16(portBytes)))
	}
	upstream, err := net.Dial("tcp", dialAddr)
	if err != nil {
		_, _ = conn.Write([]byte{0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}
	defer upstream.Close()
	// Success reply with a zeroed IPv4 bound address.
	_, _ = conn.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
	relay(conn, upstream)
}

func TestDialTLSRejectsInvalidProfile(t *testing.T) {
	if _, err := dialTLS(context.Background(), "example.com", 443, "", &Profile{SupportedVersions: []uint16{0x0300}}); err == nil {
		t.Fatalf("expected an invalid-profile error")
	}
}

func TestDialTLSRejectsHTTPSandSocks5Proxies(t *testing.T) {
	if _, err := dialTLS(context.Background(), "example.com", 443, "https://proxy.example.com", &Profile{}); err == nil {
		t.Fatalf("expected an https-proxy rejection")
	}
	if _, err := dialTLS(context.Background(), "example.com", 443, "socks5://proxy.example.com", &Profile{}); err == nil {
		t.Fatalf("expected a socks5 rejection")
	}
}

// TestSelfSignedHandshake exercises handshakeTLS against a self-signed
// server where the default profile's ECH-GREASE extension must not break
// the handshake.
func TestSelfSignedHandshake(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("key: %v", err)
	}
	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "sidecar-test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("cert: %v", err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse cert: %v", err)
	}
	certPool := x509.NewCertPool()
	certPool.AddCert(parsed)
	previous := newTLSConfig
	newTLSConfig = func(serverName string) *utls.Config {
		return &utls.Config{ServerName: serverName, RootCAs: certPool}
	}
	t.Cleanup(func() { newTLSConfig = previous })
	cert := tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
	listener, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{
		Certificates: []tls.Certificate{cert},
		NextProtos:   []string{"http/1.1"},
	})
	if err != nil {
		t.Fatalf("tls listen: %v", err)
	}
	defer listener.Close()
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		buf := make([]byte, 16)
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		n, _ := conn.Read(buf)
		_, _ = conn.Write(buf[:n])
		_ = conn.Close()
	}()

	host, port := hostPort(t, listener.Addr().String())
	conn, err := dialTLS(context.Background(), host, port, "", &Profile{})
	if err != nil {
		t.Fatalf("handshake: %v", err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, 4)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(buf) != "ping" {
		t.Fatalf("echo mismatch: %q", string(buf))
	}
}
