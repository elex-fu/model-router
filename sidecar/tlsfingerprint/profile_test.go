package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestValidateProfileBounds(t *testing.T) {
	cases := []struct {
		name    string
		profile *Profile
		wantErr bool
	}{
		{"nil profile is the all-defaults profile", nil, false},
		{"zero profile is valid (all defaults)", &Profile{}, false},
		{"name over 128 chars", &Profile{Name: string(make([]byte, 129))}, true},
		{"too many cipher suites", &Profile{CipherSuites: make([]uint16, 65)}, true},
		{"too many extensions", &Profile{Extensions: make([]uint16, 65)}, true},
		{"unsupported TLS version", &Profile{SupportedVersions: []uint16{0x0300}}, true},
		{"supported TLS versions ok", &Profile{SupportedVersions: []uint16{0x0304, 0x0303, 0x0302, 0x0301}}, false},
		{"empty alpn entry", &Profile{ALPNProtocols: []string{""}}, true},
		{"alpn entry too long", &Profile{ALPNProtocols: []string{string(make([]byte, 256))}}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateProfile(tc.profile)
			if (err != nil) != tc.wantErr {
				t.Fatalf("validateProfile err=%v wantErr=%v", err, tc.wantErr)
			}
		})
	}
}

func TestResolveProfileDefaults(t *testing.T) {
	// A zero-value profile resolves to the built-in Node.js 24.x defaults
	// exactly (this is what profile_id "default" dials with).
	r := resolveProfile(&Profile{})
	if !reflect.DeepEqual(r.CipherSuites, defaultCipherSuites) {
		t.Fatalf("default cipher suites mismatch")
	}
	if !reflect.DeepEqual(r.Extensions, defaultExtensionOrder) {
		t.Fatalf("default extension order mismatch")
	}
	if !reflect.DeepEqual(r.Curves, toUTLSCurves(defaultCurves)) {
		t.Fatalf("default curves mismatch")
	}
	if !reflect.DeepEqual(r.PointFormats, toUint8s(defaultPointFormats)) {
		t.Fatalf("default point formats mismatch")
	}
	if !reflect.DeepEqual(r.SignatureAlgorithms, toSchemes(defaultSignatureAlgorithms)) {
		t.Fatalf("default signature algorithms mismatch")
	}
	if !reflect.DeepEqual(r.SupportedVersions, defaultSupportedVersions) {
		t.Fatalf("default supported versions mismatch")
	}
	if r.EnableGREASE {
		t.Fatalf("default profile must not enable GREASE")
	}
}

func TestResolveProfileOverrides(t *testing.T) {
	r := resolveProfile(&Profile{
		CipherSuites: []uint16{0x1301},
		Curves:       []uint16{0x001d},
		Extensions:   []uint16{0, 16, 51},
		ALPNProtocols: []string{"h2", "http/1.1"},
		EnableGREASE:  true,
	})
	if len(r.CipherSuites) != 1 || r.CipherSuites[0] != 0x1301 {
		t.Fatalf("cipher override not applied: %v", r.CipherSuites)
	}
	if len(r.Curves) != 1 {
		t.Fatalf("curve override not applied")
	}
	if len(r.Extensions) != 3 || r.Extensions[2] != 51 {
		t.Fatalf("extension override not applied: %v", r.Extensions)
	}
	if len(r.ALPNProtocols) != 2 || r.ALPNProtocols[0] != "h2" {
		t.Fatalf("alpn override not applied: %v", r.ALPNProtocols)
	}
	if !r.EnableGREASE {
		t.Fatalf("grease flag not applied")
	}
	// Non-overridden fields keep their defaults.
	if !reflect.DeepEqual(r.PointFormats, []uint8{0}) {
		t.Fatalf("point formats default lost")
	}
}

func TestIsGREASEValue(t *testing.T) {
	grease := []uint16{0x0a0a, 0x1a1a, 0x2a2a, 0x3a3a, 0x4a4a, 0x5a5a, 0x6a6a, 0x7a7a, 0x8a8a, 0x9a9a, 0xaaaa, 0xbaba, 0xcaca, 0xdada, 0xeaea, 0xfafa}
	for _, v := range grease {
		if !isGREASEValue(v) {
			t.Fatalf("0x%04x should be GREASE", v)
		}
	}
	nonGrease := []uint16{0, 10, 13, 16, 43, 51, 65037, 65281, 0x1301, 0x000a}
	for _, v := range nonGrease {
		if isGREASEValue(v) {
			t.Fatalf("0x%04x should not be GREASE", v)
		}
	}
}

func TestDialRequestJSONShape(t *testing.T) {
	// The wire profile payload must round-trip into the Profile struct with
	// the migration-116 column spellings.
	raw := `{
	  "host": "api.anthropic.com",
	  "port": 443,
	  "profile_id": "custom",
	  "profile": {
	    "name": "macos-node",
	    "enable_grease": true,
	    "cipher_suites": [4865, 4866],
	    "curves": [29, 23, 24],
	    "point_formats": [0],
	    "signature_algorithms": [1027],
	    "alpn_protocols": ["http/1.1"],
	    "supported_versions": [772, 771],
	    "key_share_groups": [29],
	    "psk_modes": [1],
	    "extensions": [0, 16, 51]
	  },
	  "proxy_url": "socks5h://user:pass@127.0.0.1:1080"
	}`
	var req DialRequest
	if err := json.Unmarshal([]byte(raw), &req); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if err := validateDialRequest(&req); err != nil {
		t.Fatalf("validate: %v", err)
	}
	p := req.dialProfile()
	if p == nil || p.Name != "macos-node" || !p.EnableGREASE ||
		len(p.CipherSuites) != 2 || p.CipherSuites[0] != 4865 ||
		len(p.Extensions) != 3 || p.Extensions[1] != 16 ||
		p.ALPNProtocols[0] != "http/1.1" || p.SupportedVersions[0] != 772 {
		t.Fatalf("profile round-trip mismatch: %+v", p)
	}
}

func TestValidateDialRequest(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*DialRequest)
		wantErr bool
	}{
		{"default profile valid", func(r *DialRequest) { r.ProfileID = "default" }, false},
		{"custom without profile payload", func(r *DialRequest) { r.ProfileID = "custom" }, true},
		{"default with profile payload", func(r *DialRequest) {
			r.ProfileID = "default"
			r.Profile = &DialProfilePayload{}
		}, true},
		{"bad profile id", func(r *DialRequest) { r.ProfileID = "42" }, true},
		{"empty host", func(r *DialRequest) { r.Host = "" }, true},
		{"host with space", func(r *DialRequest) { r.Host = "api anthropic.com" }, true},
		{"host with scheme", func(r *DialRequest) { r.Host = "https://api.anthropic.com" }, true},
		{"host with userinfo", func(r *DialRequest) { r.Host = "u@api.anthropic.com" }, true},
		{"bracketed ipv6 literal", func(r *DialRequest) { r.Host = "[2606:4700::6810:85e5]" }, false},
		{"port zero", func(r *DialRequest) { r.Port = 0 }, true},
		{"port over 65535", func(r *DialRequest) { r.Port = 65536 }, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := &DialRequest{Host: "api.anthropic.com", Port: 443, ProfileID: "default"}
			tc.mutate(req)
			err := validateDialRequest(req)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err=%v wantErr=%v", err, tc.wantErr)
			}
		})
	}
}

func TestParseProxyURL(t *testing.T) {
	if _, err := parseProxyURL("https://proxy.example.com:443"); err == nil {
		t.Fatalf("https proxies must be rejected (gateway falls back to the plain transport)")
	}
	if _, err := parseProxyURL("socks5://proxy.example.com"); err == nil {
		t.Fatalf("socks5 must be rejected (socks5h-only posture, remote DNS)")
	}
	parsed, err := parseProxyURL("http://proxy.example.com:8080")
	if err != nil || parsed.Scheme != "http" {
		t.Fatalf("http proxy parse failed: %v", err)
	}
	parsed, err = parseProxyURL("socks5h://u:p@proxy.example.com:1080")
	if err != nil || parsed.Scheme != "socks5h" || parsed.User.Username() != "u" {
		t.Fatalf("socks5h proxy parse failed: %v", err)
	}
}
