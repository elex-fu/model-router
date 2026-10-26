package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Diagnostic-only clone: original Transport/body/limits remain unchanged.
type networkTrace struct {
	GetConnMS, GotConnMS, WroteRequestMS, FirstResponseByteMS float64
	ConnectTotalMS                                            float64
	ConnectCalls                                              int
	Reused, WasIdle                                           bool
	IdleMS                                                    float64
}
type sample struct {
	StartSeq           int64
	StartOffsetMS      float64
	StartedEpochMicros int64
	RequestHash        string
	NetTrace           networkTrace
	MS, TTFB           float64
	Status             int
	Err                string
	Bytes              int
	Mode               string
	Fallback           string
}

func pct(v []float64, p float64) float64 {
	if len(v) == 0 {
		return 0
	}
	sort.Float64s(v)
	return v[int(float64(len(v)-1)*p)]
}
func main() {
	url := flag.String("url", "http://127.0.0.1:18088/v1/chat/completions", "")
	keyfile := flag.String("key-file", "", "")
	n := flag.Int("n", 100, "")
	c := flag.Int("c", 1, "")
	stream := flag.Bool("stream", false, "")
	duration := flag.Duration("duration", 0, "")
	out := flag.String("out", "", "")
	flag.Parse()
	key := ""
	if *keyfile != "" {
		b, e := os.ReadFile(*keyfile)
		if e != nil {
			panic(e)
		}
		key = strings.TrimSpace(string(b))
	}
	body, _ := json.Marshal(map[string]any{"model": "gpt-4o-mini", "max_tokens": 64, "messages": []any{map[string]string{"role": "user", "content": "bench"}}, "stream": *stream})
	tr := &http.Transport{MaxIdleConns: 1000, MaxIdleConnsPerHost: 1000, MaxConnsPerHost: 1000, IdleConnTimeout: 90 * time.Second}
	cl := &http.Client{Transport: tr, Timeout: 60 * time.Second}
	var seq atomic.Int64
	var mu sync.Mutex
	rows := make([]sample, 0, *n)
	start := time.Now()
	deadline := start.Add(*duration)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	for i := 0; i < *c; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				idx := seq.Add(1)
				if idx > int64(*n) || (*duration > 0 && time.Now().After(deadline)) {
					return
				}
				req, e := http.NewRequestWithContext(ctx, "POST", *url, bytes.NewReader(body))
				if e != nil {
					panic(e)
				}
				req.Header.Set("Content-Type", "application/json")
				if key != "" {
					req.Header.Set("Authorization", "Bearer "+key)
				}
				t := time.Now()
				var netMu sync.Mutex
				netData := networkTrace{GetConnMS: -1, GotConnMS: -1, WroteRequestMS: -1, FirstResponseByteMS: -1}
				var connectStarted time.Time
				offset := func() float64 { return float64(time.Since(t).Microseconds()) / 1000 }
				trace := &httptrace.ClientTrace{
					GetConn: func(string) { netMu.Lock(); netData.GetConnMS = offset(); netMu.Unlock() },
					GotConn: func(info httptrace.GotConnInfo) {
						netMu.Lock()
						netData.GotConnMS = offset()
						netData.Reused = info.Reused
						netData.WasIdle = info.WasIdle
						netData.IdleMS = float64(info.IdleTime.Microseconds()) / 1000
						netMu.Unlock()
					},
					ConnectStart: func(string, string) {
						netMu.Lock()
						connectStarted = time.Now()
						netData.ConnectCalls++
						netMu.Unlock()
					},
					ConnectDone: func(string, string, error) {
						netMu.Lock()
						if !connectStarted.IsZero() {
							netData.ConnectTotalMS += float64(time.Since(connectStarted).Microseconds()) / 1000
						}
						netMu.Unlock()
					},
					WroteRequest:         func(httptrace.WroteRequestInfo) { netMu.Lock(); netData.WroteRequestMS = offset(); netMu.Unlock() },
					GotFirstResponseByte: func() { netMu.Lock(); netData.FirstResponseByteMS = offset(); netMu.Unlock() },
				}
				req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))
				s := sample{StartSeq: idx, StartOffsetMS: float64(t.Sub(start).Microseconds()) / 1000, StartedEpochMicros: t.UnixMicro()}
				resp, e := cl.Do(req)
				if e != nil {
					s.Err = "client_transport_or_body_read_error"
				} else {
					s.Status = resp.StatusCode
					if requestID := resp.Header.Get("X-Request-Id"); requestID != "" {
						hash := sha256.Sum256([]byte(requestID))
						s.RequestHash = fmt.Sprintf("%x", hash)
					}
					s.Mode = resp.Header.Get("X-Model-Router-Execution-Mode")
					if s.Mode != "" && s.Mode != "strict" && s.Mode != "fast-reserved-max" {
						s.Mode = "other"
					}
					s.Fallback = resp.Header.Get("X-Model-Router-Fast-Fallback")
					switch s.Fallback {
					case "", "client_idempotency", "unbounded_request_field", "snapshot_policy":
					default:
						s.Fallback = "other"
					}
					var first [1]byte
					nn, e := resp.Body.Read(first[:])
					s.TTFB = float64(time.Since(t).Microseconds()) / 1000
					rest, re := io.ReadAll(resp.Body)
					_ = resp.Body.Close()
					s.Bytes = nn + len(rest)
					all := append(first[:nn], rest...)
					if e != nil && e != io.EOF {
						s.Err = "client_transport_or_body_read_error"
					} else if re != nil {
						s.Err = "client_body_drain_error"
					} else if resp.StatusCode != 200 {
						s.Err = "http_non_200"
					} else if *stream && !bytes.Contains(all, []byte("data: [DONE]")) {
						s.Err = "missing SSE DONE"
					} else if !*stream {
						var x map[string]any
						if json.Unmarshal(all, &x) != nil || x["choices"] == nil {
							s.Err = "invalid JSON completion"
						}
					}
				}
				s.MS = float64(time.Since(t).Microseconds()) / 1000
				netMu.Lock()
				s.NetTrace = netData
				netMu.Unlock()
				mu.Lock()
				rows = append(rows, s)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	elapsed := time.Since(start).Seconds()
	lat := []float64{}
	ttfb := []float64{}
	statuses := map[int]int{}
	modes := map[string]int{}
	fallbacks := map[string]int{}
	errs := map[string]int{}
	totalBytes := 0
	for _, r := range rows {
		statuses[r.Status]++
		modes[r.Mode]++
		if r.Fallback != "" {
			fallbacks[r.Fallback]++
		}
		totalBytes += r.Bytes
		if r.Err != "" {
			err := r.Err
			if len(err) > 300 {
				err = err[:300]
			}
			errs[err]++
		} else {
			lat = append(lat, r.MS)
			ttfb = append(ttfb, r.TTFB)
		}
	}
	result := map[string]any{"stream": *stream, "concurrency": *c, "requests": len(rows), "success": len(lat), "duration_s": elapsed, "throughput_success_rps": float64(len(lat)) / elapsed, "bytes": totalBytes, "status_counts": statuses, "execution_modes": modes, "fallback_reasons": fallbacks, "errors": errs, "latency_ms": map[string]float64{"p50": pct(lat, .50), "p95": pct(lat, .95), "p99": pct(lat, .99)}, "body_ttfb_ms": map[string]float64{"p50": pct(ttfb, .50), "p95": pct(ttfb, .95), "p99": pct(ttfb, .99)}}
	result["samples"] = rows
	result["diagnostic_only"] = true
	result["wire_request_unchanged"] = true
	result["trace_scope"] = "httptrace fixed scalars, server request-ID hash only; no URL/header/auth trace payload"
	b, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(b))
	if *out != "" {
		if e := os.WriteFile(*out, append(b, '\n'), 0600); e != nil {
			panic(e)
		}
	}
}
