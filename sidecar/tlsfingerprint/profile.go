// Package main implements the model-router TLS fingerprint sidecar.
//
// It is a small, independently deployed process that owns uTLS: it dials
// provider endpoints (directly or through an HTTP CONNECT / SOCKS5 egress
// proxy) with a pinned ClientHello fingerprint, then relays the plaintext
// bytes over a local Unix socket to the Node gateway. The Node side never
// links Go or uTLS; the sidecar never touches PostgreSQL, credentials, or
// request bodies — it only sees host/port/proxy/profile facts.
//
// Port of sub2api's internal/pkg/tlsfingerprint dialer (three dial paths +
// the Node.js 24.x default fingerprint tables), adapted to a stateless
// IPC model: profiles are resolved by the caller (PG is authoritative on the
// Node side) and shipped inline in each dial request.
package main

// Profile contains a complete TLS ClientHello configuration. Empty slice
// fields fall back to the built-in Node.js 24.x defaults at spec-build time.
//
// The JSON field names match the saas_tls_fingerprint_profiles columns
// (migration 116) one-to-one so the gateway can forward a resolved profile
// row verbatim.
type Profile struct {
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

// Default TLS fingerprint captured from Claude Code (Node.js 24.x) via a
// tls-fingerprint-web capture server.
//
//	JA3:  44f88fca027f27bab4bb08d4af15f23e
//	JA4:   t13d1714h1_5b57614c22b0_7baf387fc6ff
var (
	// defaultCipherSuites: the 17 cipher suites from Node.js 24.x. Order is
	// critical for JA3 matching.
	defaultCipherSuites = []uint16{
		0x1301, // TLS_AES_128_GCM_SHA256
		0x1302, // TLS_AES_256_GCM_SHA384
		0x1303, // TLS_CHACHA20_POLY1305_SHA256
		0xc02b, // TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
		0xc02f, // TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
		0xc02c, // TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
		0xc030, // TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
		0xcca9, // TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256
		0xcca8, // TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256
		0xc009, // TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA
		0xc013, // TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA
		0xc00a, // TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA
		0xc014, // TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA
		0x009c, // TLS_RSA_WITH_AES_128_GCM_SHA256
		0x009d, // TLS_RSA_WITH_AES_256_GCM_SHA384
		0x002f, // TLS_RSA_WITH_AES_128_CBC_SHA
		0x0035, // TLS_RSA_WITH_AES_256_CBC_SHA
	}

	// defaultCurves: the three supported groups from Node.js 24.x.
	defaultCurves = []uint16{0x001d, 0x0017, 0x0018} // X25519, secp256r1, secp384r1

	// defaultPointFormats: uncompressed only.
	defaultPointFormats = []uint16{0}

	// defaultSignatureAlgorithms: the nine schemes from Node.js 24.x.
	defaultSignatureAlgorithms = []uint16{
		0x0403, // ecdsa_secp256r1_sha256
		0x0804, // rsa_pss_rsae_sha256
		0x0401, // rsa_pkcs1_sha256
		0x0503, // ecdsa_secp384r1_sha384
		0x0805, // rsa_pss_rsae_sha384
		0x0501, // rsa_pkcs1_sha384
		0x0806, // rsa_pss_rsae_sha512
		0x0601, // rsa_pkcs1_sha512
		0x0201, // rsa_pkcs1_sha1
	}

	// defaultALPNProtocols: the provider transport is HTTP/1.1 only.
	defaultALPNProtocols = []string{"http/1.1"}

	// defaultSupportedVersions: TLS 1.3 then TLS 1.2.
	defaultSupportedVersions = []uint16{0x0304, 0x0303}

	// defaultKeyShareGroups: X25519 key share.
	defaultKeyShareGroups = []uint16{0x001d}

	// defaultPSKModes: psk_dhe_ke.
	defaultPSKModes = []uint16{1}

	// defaultExtensionOrder: the Node.js 24.x extension order.
	defaultExtensionOrder = []uint16{
		0,     // server_name
		65037, // encrypted_client_hello
		23,    // extended_master_secret
		65281, // renegotiation_info
		10,    // supported_groups
		11,    // ec_point_formats
		35,    // session_ticket
		16,    // alpn
		5,     // status_request
		13,    // signature_algorithms
		18,    // signed_certificate_timestamp
		51,    // key_share
		45,    // psk_key_exchange_modes
		43,    // supported_versions
	}
)

// Bounded profile validation: the sidecar is on the hot path for every
// dialed connection, so a malformed profile is rejected up front with a
// bounded-size error instead of failing inside uTLS.
func validateProfile(p *Profile) error {
	if p == nil {
		// nil is the "all defaults" profile (profile_id "default" ships no
		// payload); it is always valid.
		return nil
	}
	if len(p.Name) > 128 {
		return errInvalidProfile("profile name is too long")
	}
	if len(p.CipherSuites) > 64 || len(p.Extensions) > 64 ||
		len(p.SignatureAlgorithms) > 64 || len(p.SupportedVersions) > 8 {
		return errInvalidProfile("profile list field exceeds the bounded length")
	}
	if len(p.Curves) > 32 || len(p.PointFormats) > 8 || len(p.KeyShareGroups) > 8 || len(p.PSKModes) > 8 {
		return errInvalidProfile("profile list field exceeds the bounded length")
	}
	if len(p.ALPNProtocols) > 8 {
		return errInvalidProfile("profile alpn list exceeds the bounded length")
	}
	for _, alpn := range p.ALPNProtocols {
		if len(alpn) == 0 || len(alpn) > 255 {
			return errInvalidProfile("profile alpn entry is invalid")
		}
	}
	for _, v := range p.SupportedVersions {
		// TLS 1.0..TLS 1.3 only; a ClientHello advertising anything else is
		// malformed by construction.
		if v < 0x0301 || v > 0x0304 {
			return errInvalidProfile("profile supported version is invalid")
		}
	}
	return nil
}

type invalidProfileError string

func (e invalidProfileError) Error() string { return string(e) }

func errInvalidProfile(reason string) error {
	return invalidProfileError("tls fingerprint profile is invalid: " + reason)
}
