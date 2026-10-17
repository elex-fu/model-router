package main

import (
	utls "github.com/refraction-networking/utls"
)

// isGREASEValue reports whether v matches the TLS GREASE pattern (0x?a?a).
func isGREASEValue(v uint16) bool {
	return v&0x0f0f == 0x0a0a && v>>8 == v&0xff
}

// resolveProfile merges a profile over the built-in Node.js 24.x defaults:
// every empty slice field falls back to the default, so a zero-value profile
// is exactly the default fingerprint.
type resolvedProfile struct {
	CipherSuites        []uint16
	Curves              []utls.CurveID
	PointFormats        []uint8
	SignatureAlgorithms []utls.SignatureScheme
	ALPNProtocols       []string
	SupportedVersions   []uint16
	KeyShareGroups      []utls.CurveID
	PSKModes            []uint8
	Extensions          []uint16
	EnableGREASE        bool
}

func toUTLSCurves(curves []uint16) []utls.CurveID {
	out := make([]utls.CurveID, len(curves))
	for i, c := range curves {
		out[i] = utls.CurveID(c)
	}
	return out
}

func toUint8s(vals []uint16) []uint8 {
	out := make([]uint8, len(vals))
	for i, v := range vals {
		out[i] = uint8(v)
	}
	return out
}

func resolveProfile(p *Profile) resolvedProfile {
	r := resolvedProfile{
		CipherSuites:        defaultCipherSuites,
		Curves:              toUTLSCurves(defaultCurves),
		PointFormats:        toUint8s(defaultPointFormats),
		SignatureAlgorithms: toSchemes(defaultSignatureAlgorithms),
		ALPNProtocols:       defaultALPNProtocols,
		SupportedVersions:   defaultSupportedVersions,
		KeyShareGroups:      toUTLSCurves(defaultKeyShareGroups),
		PSKModes:            toUint8s(defaultPSKModes),
		Extensions:          defaultExtensionOrder,
		EnableGREASE:        false,
	}
	if p == nil {
		return r
	}
	if len(p.CipherSuites) > 0 {
		r.CipherSuites = p.CipherSuites
	}
	if len(p.Curves) > 0 {
		r.Curves = toUTLSCurves(p.Curves)
	}
	if len(p.PointFormats) > 0 {
		r.PointFormats = toUint8s(p.PointFormats)
	}
	if len(p.SignatureAlgorithms) > 0 {
		r.SignatureAlgorithms = toSchemes(p.SignatureAlgorithms)
	}
	if len(p.ALPNProtocols) > 0 {
		r.ALPNProtocols = p.ALPNProtocols
	}
	if len(p.SupportedVersions) > 0 {
		r.SupportedVersions = p.SupportedVersions
	}
	if len(p.KeyShareGroups) > 0 {
		r.KeyShareGroups = toUTLSCurves(p.KeyShareGroups)
	}
	if len(p.PSKModes) > 0 {
		r.PSKModes = toUint8s(p.PSKModes)
	}
	if len(p.Extensions) > 0 {
		r.Extensions = p.Extensions
	}
	r.EnableGREASE = p.EnableGREASE
	return r
}

func toSchemes(vals []uint16) []utls.SignatureScheme {
	out := make([]utls.SignatureScheme, len(vals))
	for i, v := range vals {
		out[i] = utls.SignatureScheme(v)
	}
	return out
}

// buildClientHelloSpec constructs the uTLS ClientHelloSpec from a profile
// (port of sub2api's buildClientHelloSpecFromProfile). Parametric extensions
// (curves, sigalgs, key shares, ...) are populated from the resolved profile;
// unknown extension IDs are sent as GenericExtension (type id + empty body),
// which covers encrypt_then_mac(22) and future extensions; ECH(65037) sends a
// GREASE ECH with random payload because an empty body trips servers that
// validate ECH format.
func buildClientHelloSpec(p *Profile) *utls.ClientHelloSpec {
	r := resolveProfile(p)

	keyShares := make([]utls.KeyShare, len(r.KeyShareGroups))
	for i, g := range r.KeyShareGroups {
		keyShares[i] = utls.KeyShare{Group: g}
	}

	extensions := make([]utls.TLSExtension, 0, len(r.Extensions)+2)
	for _, id := range r.Extensions {
		if isGREASEValue(id) {
			extensions = append(extensions, &utls.UtlsGREASEExtension{})
			continue
		}
		switch id {
		case 0: // server_name
			extensions = append(extensions, &utls.SNIExtension{})
		case 5: // status_request (OCSP)
			extensions = append(extensions, &utls.StatusRequestExtension{})
		case 10: // supported_groups
			extensions = append(extensions, &utls.SupportedCurvesExtension{Curves: r.Curves})
		case 11: // ec_point_formats
			extensions = append(extensions, &utls.SupportedPointsExtension{SupportedPoints: r.PointFormats})
		case 13: // signature_algorithms
			extensions = append(extensions, &utls.SignatureAlgorithmsExtension{SupportedSignatureAlgorithms: r.SignatureAlgorithms})
		case 16: // alpn
			extensions = append(extensions, &utls.ALPNExtension{AlpnProtocols: r.ALPNProtocols})
		case 18: // signed_certificate_timestamp
			extensions = append(extensions, &utls.SCTExtension{})
		case 23: // extended_master_secret
			extensions = append(extensions, &utls.ExtendedMasterSecretExtension{})
		case 35: // session_ticket
			extensions = append(extensions, &utls.SessionTicketExtension{})
		case 43: // supported_versions
			extensions = append(extensions, &utls.SupportedVersionsExtension{Versions: r.SupportedVersions})
		case 45: // psk_key_exchange_modes
			extensions = append(extensions, &utls.PSKKeyExchangeModesExtension{Modes: r.PSKModes})
		case 50: // signature_algorithms_cert
			extensions = append(extensions, &utls.SignatureAlgorithmsCertExtension{SupportedSignatureAlgorithms: r.SignatureAlgorithms})
		case 51: // key_share
			extensions = append(extensions, &utls.KeyShareExtension{KeyShares: keyShares})
		case 0xfe0d: // encrypted_client_hello (65037): GREASE ECH
			extensions = append(extensions, &utls.GREASEEncryptedClientHelloExtension{})
		case 0xff01: // renegotiation_info
			extensions = append(extensions, &utls.RenegotiationInfoExtension{})
		default:
			extensions = append(extensions, &utls.GenericExtension{Id: id})
		}
	}

	// The default order with EnableGREASE wraps the list in GREASE bookends
	// (Chrome-style); an explicit order is sent exactly as configured.
	if r.EnableGREASE && (p == nil || len(p.Extensions) == 0) {
		extensions = append([]utls.TLSExtension{&utls.UtlsGREASEExtension{}}, extensions...)
		extensions = append(extensions, &utls.UtlsGREASEExtension{})
	}

	return &utls.ClientHelloSpec{
		CipherSuites:       r.CipherSuites,
		CompressionMethods: []uint8{0}, // null compression only
		Extensions:         extensions,
		TLSVersMax:         utls.VersionTLS13,
		TLSVersMin:         utls.VersionTLS10,
	}
}
