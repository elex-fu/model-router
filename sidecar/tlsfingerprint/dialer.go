package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/url"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/proxy"
)

// dialTLS establishes one fingerprinted TLS connection to host:port, through
// the optional egress proxy, using the given profile. Three dial paths
// (sub2api parity):
//
//   - direct:      TCP connect → uTLS handshake;
//   - http proxy:  TCP to the proxy → hand-written CONNECT tunnel (with
//     Basic Proxy-Authorization when userinfo is present) → uTLS handshake;
//   - socks5h:     SOCKS5 tunnel (golang.org/x/net/proxy, credentials via
//     RFC 1929) → uTLS handshake. The destination hostname is sent to the
//     proxy (remote DNS), matching the gateway's socks5h-only posture.
//
// HTTPS proxies are rejected here: the gateway falls back to its ordinary
// undici transport for them (drop the fingerprint, keep the proxy) rather
// than silently downgrading the proxy.
func dialTLS(ctx context.Context, host string, port int, proxyURL string, profile *Profile) (net.Conn, error) {
	if err := validateProfile(profile); err != nil {
		return nil, err
	}
	addr := net.JoinHostPort(host, fmt.Sprintf("%d", port))

	var conn net.Conn
	if proxyURL == "" {
		var d net.Dialer
		var err error
		conn, err = d.DialContext(ctx, "tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("tls fingerprint dial: %w", err)
		}
	} else {
		parsed, err := parseProxyURL(proxyURL)
		if err != nil {
			return nil, err
		}
		switch parsed.Scheme {
		case "http":
			conn, err = dialHTTPProxyTunnel(ctx, parsed, addr)
		case "socks5h":
			conn, err = dialSocks5Tunnel(ctx, parsed, addr)
		default:
			// validateProxyURL only admits http/socks5h; unreachable defensively.
			return nil, fmt.Errorf("tls fingerprint proxy protocol is unsupported")
		}
		if err != nil {
			return nil, err
		}
	}
	return handshakeTLS(ctx, conn, profile, host)
}

// parseProxyURL validates the egress proxy URL. Only http and socks5h are
// admitted; socks5 is upgraded to socks5h (remote DNS) by the caller side
// before it ever reaches the sidecar, so it is refused here.
func parseProxyURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("tls fingerprint proxy url is invalid")
	}
	switch parsed.Scheme {
	case "http":
		return parsed, nil
	case "socks5h":
		return parsed, nil
	default:
		return nil, fmt.Errorf("tls fingerprint proxy protocol is unsupported")
	}
}

// dialHTTPProxyTunnel establishes a CONNECT tunnel through an HTTP proxy,
// writing the CONNECT request by hand so the tunnel bytes stay under our
// control (Proxy-Authorization Basic when userinfo is present).
func dialHTTPProxyTunnel(ctx context.Context, proxy *url.URL, addr string) (net.Conn, error) {
	proxyAddr := proxy.Host
	if proxy.Port() == "" {
		proxyAddr = net.JoinHostPort(proxy.Hostname(), "80")
	}
	d := net.Dialer{}
	conn, err := d.DialContext(ctx, "tcp", proxyAddr)
	if err != nil {
		return nil, fmt.Errorf("tls fingerprint proxy connect: %w", err)
	}

	req := &http.Request{
		Method: "CONNECT",
		URL:    &url.URL{Opaque: addr},
		Host:   addr,
		Header: make(http.Header),
	}
	if proxy.User != nil {
		password, _ := proxy.User.Password()
		auth := base64.StdEncoding.EncodeToString([]byte(proxy.User.Username() + ":" + password))
		req.Header.Set("Proxy-Authorization", "Basic "+auth)
	}
	if err := req.Write(conn); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("tls fingerprint proxy write: %w", err)
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, req)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("tls fingerprint proxy read: %w", err)
	}
	// CONNECT responses have no body; resp wraps the same conn the TLS
	// handshake continues on, so the body must not be closed.
	if resp.StatusCode != http.StatusOK {
		_ = conn.Close()
		return nil, fmt.Errorf("tls fingerprint proxy CONNECT failed: %s", resp.Status)
	}
	return conn, nil
}

// dialSocks5Tunnel establishes a SOCKS5 tunnel with username/password auth
// when the proxy URL carries userinfo (RFC 1928/1929).
func dialSocks5Tunnel(ctx context.Context, target *url.URL, addr string) (net.Conn, error) {
	var auth *proxy.Auth
	if target.User != nil {
		password, _ := target.User.Password()
		auth = &proxy.Auth{User: target.User.Username(), Password: password}
	}
	proxyAddr := target.Host
	if target.Port() == "" {
		proxyAddr = net.JoinHostPort(target.Hostname(), "1080")
	}
	dialer, err := proxy.SOCKS5("tcp", proxyAddr, auth, proxy.Direct)
	if err != nil {
		return nil, fmt.Errorf("tls fingerprint socks5 dialer: %w", err)
	}
	conn, err := dialer.Dial("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("tls fingerprint socks5 connect: %w", err)
	}
	return conn, nil
}

// newTLSConfig builds the uTLS config for one handshake. Production always
// verifies certificates against the system roots; tests swap this for a
// test-CA-aware builder (httptest servers are self-signed).
var newTLSConfig = func(serverName string) *utls.Config {
	return &utls.Config{ServerName: serverName}
}

// handshakeTLS performs the uTLS ClientHello handshake on an established
// connection. SNI is the destination hostname exactly as dialed.
func handshakeTLS(ctx context.Context, conn net.Conn, profile *Profile, host string) (net.Conn, error) {
	spec := buildClientHelloSpec(profile)
	tlsConn := utls.UClient(conn, newTLSConfig(host), utls.HelloCustom)
	if err := tlsConn.ApplyPreset(spec); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("tls fingerprint preset: %w", err)
	}
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("tls fingerprint handshake: %w", err)
	}
	return tlsConn, nil
}
