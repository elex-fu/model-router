// Standalone disposable mock for local A/B benchmark runs. No dependency
// outside the Go standard library. Serves both the OpenAI chat/completions
// and the Anthropic /v1/messages fixture routes (JSON + SSE) so the MR
// gateway fast and strict paths can be benchmarked against one upstream.
// TLS is optional (-cert/-key) so TLS-vs-plain attribution runs use the
// exact same source; /metrics always reports TLS handshake counters.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type connectionIdentity struct{}

type mockServer struct {
	connectionSequence   atomic.Uint64
	inferenceConnections atomic.Uint64
	inferenceTLSFull     atomic.Uint64
	inferenceTLSResumed  atomic.Uint64
	seenConnections      sync.Map
	delay                time.Duration
	pricing              []byte
	pricingHash          string
	prefix               string
	sequence             atomic.Uint64
	received             atomic.Uint64
	completed            atomic.Uint64
	jsonCount            atomic.Uint64
	streamCount          atomic.Uint64
	unexpected           atomic.Uint64
	badRequests          atomic.Uint64
	writeErrors          atomic.Uint64
	pricingRequests      atomic.Uint64
	inFlight             atomic.Int64
	providers            [5]atomic.Uint64
}

func newMockServer(delay time.Duration, pricing []byte) *mockServer {
	sum := sha256.Sum256(pricing)
	return &mockServer{delay: delay, pricing: pricing, pricingHash: hex.EncodeToString(sum[:]), prefix: strconv.FormatInt(time.Now().UnixNano(), 36)}
}

func (m *mockServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/healthz":
		m.healthz(w)
	case "/metrics":
		m.metrics(w)
	case "/pricing.json":
		m.pricingRequests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.Write(m.pricing)
	case "/pricing.sha256":
		m.pricingRequests.Add(1)
		w.Header().Set("Content-Type", "text/plain")
		io.WriteString(w, m.pricingHash+"\n")
	case "/v1/chat/completions":
		m.chat(w, r, "openai")
	case "/v1/messages":
		m.chat(w, r, "anthropic")
	default:
		m.unexpected.Add(1)
		http.Error(w, "local mock: unexpected path", http.StatusNotFound)
	}
}

func (m *mockServer) healthz(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	io.WriteString(w, `{"status":"ok","local_mock":true}`)
}

func (m *mockServer) metrics(w http.ResponseWriter) {
	p := map[string]uint64{}
	for i := 0; i < len(m.providers); i++ {
		p[fmt.Sprintf("provider_%d", i)] = m.providers[i].Load()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"inference_connections": m.inferenceConnections.Load(), "inference_tls_full": m.inferenceTLSFull.Load(), "inference_tls_resumed": m.inferenceTLSResumed.Load(), "received": m.received.Load(), "completed": m.completed.Load(), "json": m.jsonCount.Load(), "sse": m.streamCount.Load(), "unexpected_paths": m.unexpected.Load(), "bad_requests": m.badRequests.Load(), "write_errors": m.writeErrors.Load(), "in_flight": m.inFlight.Load(), "pricing_requests": m.pricingRequests.Load(), "providers": p, "delay_ms": float64(m.delay) / float64(time.Millisecond)})
}

// metricsOnly restricts the plain sidecar listener to observation endpoints
// so TLS runs still expose /metrics to curl without a TLS client.
type metricsOnly struct{ m *mockServer }

func (h metricsOnly) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/healthz":
		h.m.healthz(w)
	case "/metrics":
		h.m.metrics(w)
	default:
		http.Error(w, "plain sidecar serves observation endpoints only", http.StatusNotFound)
	}
}


// chat answers one fixture request for the given protocol. The provider
// model alias and the per-account bearer tokens are the ones the native
// fast HTTP seed fixture registers (r9-* identities); this mock never sees
// real credentials.
func (m *mockServer) chat(w http.ResponseWriter, r *http.Request, protocol string) {
	if _, loaded := m.seenConnections.LoadOrStore(r.Context().Value(connectionIdentity{}), true); !loaded {
		m.inferenceConnections.Add(1)
		if r.TLS != nil {
			if r.TLS.DidResume {
				m.inferenceTLSResumed.Add(1)
			} else {
				m.inferenceTLSFull.Add(1)
			}
		}
	}
	m.received.Add(1)
	m.inFlight.Add(1)
	defer m.inFlight.Add(-1)
	if r.Method != http.MethodPost {
		m.badRequests.Add(1)
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		m.badRequests.Add(1)
		http.Error(w, "read failed", 400)
		return
	}
	var req struct {
		Model    string            `json:"model"`
		Stream   bool              `json:"stream"`
		Messages []json.RawMessage `json:"messages"`
	}
	if err = json.Unmarshal(body, &req); err != nil || req.Model != "r9-provider-model-"+protocol || len(req.Messages) == 0 {
		m.badRequests.Add(1)
		http.Error(w, "expected native fixture provider "+protocol+" request", 400)
		return
	}
	provider := 0
	for i := 1; i <= 2; i++ {
		if r.Header.Get("Authorization") == fmt.Sprintf("Bearer r9-%s-account-%d", protocol, i) {
			provider = i
			break
		}
	}
	if provider == 0 {
		m.badRequests.Add(1)
		http.Error(w, "unexpected fixture credential", 401)
		return
	}
	m.providers[provider].Add(1)
	id := "mock-" + m.prefix + "-" + strconv.FormatUint(m.sequence.Add(1), 10)
	select {
	case <-time.After(m.delay):
	case <-r.Context().Done():
		return
	}
	w.Header().Set("X-Request-Id", id)
	w.Header().Set("Cache-Control", "no-store")
	usage := map[string]int{"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
	if protocol == "anthropic" {
		// Real Anthropic usage always carries the cache counters; the strict
		// gateway's usage observer requires them (usage missing them is
		// retained as an unknown outcome and holds capacity reservations).
		usage = map[string]int{
			"input_tokens":                 10,
			"output_tokens":                5,
			"cache_read_input_tokens":      0,
			"cache_creation_input_tokens":  0,
		}
	}
	created := int64(1700000000)
	if !req.Stream {
		m.jsonCount.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if protocol == "openai" {
			err = json.NewEncoder(w).Encode(map[string]any{"id": "chatcmpl-" + id, "object": "chat.completion", "created": created, "model": req.Model, "choices": []any{map[string]any{"index": 0, "message": map[string]string{"role": "assistant", "content": "Hello."}, "finish_reason": "stop"}}, "usage": usage})
		} else {
			err = json.NewEncoder(w).Encode(map[string]any{"id": "msg_" + id, "type": "message", "role": "assistant", "model": req.Model, "content": []any{map[string]string{"type": "text", "text": "Hello."}}, "stop_reason": "end_turn", "usage": usage})
		}
		if err != nil {
			m.writeErrors.Add(1)
			return
		}
		m.completed.Add(1)
		return
	}
	m.streamCount.Add(1)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher, ok := w.(http.Flusher)
	if !ok {
		m.writeErrors.Add(1)
		http.Error(w, "flush unsupported", 500)
		return
	}
	chunks := []map[string]any{}
	if protocol == "openai" {
		chunks = []map[string]any{
			{"id": "chatcmpl-" + id, "object": "chat.completion.chunk", "created": created, "model": req.Model, "choices": []any{map[string]any{"index": 0, "delta": map[string]string{"role": "assistant", "content": "Hello."}, "finish_reason": nil}}},
			{"id": "chatcmpl-" + id, "object": "chat.completion.chunk", "created": created, "model": req.Model, "choices": []any{map[string]any{"index": 0, "delta": map[string]string{}, "finish_reason": "stop"}}},
			{"id": "chatcmpl-" + id, "object": "chat.completion.chunk", "created": created, "model": req.Model, "choices": []any{}, "usage": usage},
		}
	} else {
		chunks = []map[string]any{
			{"type": "message_start", "message": map[string]any{"id": "msg_" + id, "type": "message", "role": "assistant", "model": req.Model, "content": []any{}, "usage": usage}},
			{"type": "content_block_start", "index": 0, "content_block": map[string]string{"type": "text", "text": ""}},
			{"type": "content_block_delta", "index": 0, "delta": map[string]string{"type": "text_delta", "text": "Hello."}},
			{"type": "content_block_stop", "index": 0},
			{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn"}, "usage": map[string]int{"output_tokens": 5}},
			{"type": "message_stop"},
		}
	}
	for _, chunk := range chunks {
		data, _ := json.Marshal(chunk)
		if protocol == "anthropic" {
			if _, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", chunk["type"], data); err != nil {
				m.writeErrors.Add(1)
				return
			}
		} else if _, err = fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
			m.writeErrors.Add(1)
			return
		}
		flusher.Flush()
	}
	if protocol == "openai" {
		if _, err = io.WriteString(w, "data: [DONE]\n\n"); err != nil {
			m.writeErrors.Add(1)
			return
		}
		flusher.Flush()
	}
	m.completed.Add(1)
}

func main() {
	addr := flag.String("addr", "127.0.0.1:18453", "loopback-only listen address")
	cert := flag.String("cert", "", "local TLS certificate (enables HTTPS)")
	key := flag.String("key", "", "local TLS key")
	delay := flag.Duration("delay", 5*time.Millisecond, "delay before each first response byte")

	flag.Parse()
	if !strings.HasPrefix(*addr, "127.0.0.1:") {
		log.Fatal("mock must bind TCP IPv4 loopback")
	}
	pricing := []byte(`{}`)
	if *delay != 5*time.Millisecond {
		log.Fatal("fixed 5ms delay required")
	}
	mock := newMockServer(*delay, pricing)
	server := &http.Server{Addr: *addr, Handler: mock, ConnContext: func(ctx context.Context, c net.Conn) context.Context {
		return context.WithValue(ctx, connectionIdentity{}, mock.connectionSequence.Add(1))
	}, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 120 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(c)
	}()
	log.Printf("Disposable local mock listening on %s; delay=%s; pricing_sha256=%s", *addr, *delay, mock.pricingHash)
	serve := server.ListenAndServe
	if *cert != "" {
		serve = func() error { return server.ListenAndServeTLS(*cert, *key) }
		// TLS mode: also expose /metrics + /healthz on the next port as
		// plain HTTP so bench profiles can scrape deltas without a TLS
		// client; inference endpoints stay TLS-only.
		host, portText, err := net.SplitHostPort(*addr)
		if err != nil {
			log.Fatal(err)
		}
		port, err := strconv.Atoi(portText)
		if err != nil {
			log.Fatal(err)
		}
		sidecar := &http.Server{Addr: net.JoinHostPort(host, strconv.Itoa(port+1)), Handler: metricsOnly{m: mock}, ReadHeaderTimeout: 5 * time.Second}
		go func() {
			log.Printf("Plain observation sidecar listening on %s", sidecar.Addr)
			if err := sidecar.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Fatal(err)
			}
		}()
		go func() {
			<-ctx.Done()
			c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			sidecar.Shutdown(c)
		}()
	}
	if err := serve(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
