package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

// Diagnostic-only clone: original Transport/body/limits remain unchanged.
type networkTrace struct {
	GetConnMonotonicNS, GotConnMonotonicNS, WroteRequestMonotonicNS, FirstResponseByteMonotonicNS string
	GetConnCalls, GotConnCalls, WroteRequestCalls, FirstResponseByteCalls, WriteErrors            int
	GetConnMS, GotConnMS, WroteRequestMS, FirstResponseByteMS                                     float64
	ConnectTotalMS                                                                                float64
	ConnectCalls                                                                                  int
	Reused, WasIdle                                                                               bool
	IdleMS                                                                                        float64
}
type sample struct {
	probe                    *tcpProbe
	StartedMonotonicBeforeNS string
	StartedMonotonicNS       string
	TCPProbe                 tcpProbeResult
	StartSeq                 int64
	StartOffsetMS            float64
	StartedEpochMicros       int64
	RequestHash              string
	NetTrace                 networkTrace
	MS, TTFB                 float64
	Status                   int
	Err                      string
	Bytes                    int
	Mode                     string
	Fallback                 string
}

// Linux diagnostic scalars only. No file descriptor escapes Control and no
// connection is wrapped, written, closed, paused, or reconfigured by probes.
type tcpInfoResult struct {
	Status  string
	Length  uint32
	Metrics map[string]uint64 `json:",omitempty"`
}

func decodeTCPInfo(b []byte) tcpInfoResult {
	if len(b) < 104 {
		return tcpInfoResult{Status: "short_tcp_info", Length: uint32(len(b))}
	}
	out := tcpInfoResult{Status: "available", Length: uint32(len(b)), Metrics: map[string]uint64{}}
	for name, offset := range map[string]int{"state": 0, "ca_state": 1, "retransmits": 2, "backoff": 4} {
		out.Metrics[name] = uint64(b[offset])
	}
	for name, offset := range map[string]int{"rto_us": 8, "unacked": 24, "lost": 32, "retrans": 36, "last_data_sent_ms": 44, "last_data_recv_ms": 52, "rtt_us": 68, "total_retrans": 100, "segs_out": 136, "segs_in": 140, "notsent_bytes": 144, "data_segs_in": 152, "data_segs_out": 156} {
		if len(b) >= offset+4 {
			out.Metrics[name] = uint64(binary.NativeEndian.Uint32(b[offset : offset+4]))
		}
	}
	for name, offset := range map[string]int{"bytes_acked": 120, "bytes_received": 128, "bytes_sent": 200, "bytes_retrans": 208} {
		if len(b) >= offset+8 {
			out.Metrics[name] = binary.NativeEndian.Uint64(b[offset : offset+8])
		}
	}
	return out
}

var tcpUnavailable atomic.Uint32
var tcpGetSockOptCalls atomic.Uint64

func readTCPInfo(conn net.Conn) tcpInfoResult {
	if tcpUnavailable.Load() != 0 {
		return tcpInfoResult{Status: "unavailable_no_retry"}
	}
	control, ok := conn.(syscall.Conn)
	if !ok {
		return tcpInfoResult{Status: "non_syscall_connection"}
	}
	raw, err := control.SyscallConn()
	if err != nil {
		return tcpInfoResult{Status: "syscall_conn_unavailable"}
	}
	var data [256]byte
	length := uint32(len(data))
	var errno syscall.Errno
	err = raw.Control(func(fd uintptr) {
		tcpGetSockOptCalls.Add(1)
		_, _, errno = syscall.Syscall6(syscall.SYS_GETSOCKOPT, fd, syscall.IPPROTO_TCP, syscall.TCP_INFO, uintptr(unsafe.Pointer(&data[0])), uintptr(unsafe.Pointer(&length)), 0)
	})
	if err != nil {
		return tcpInfoResult{Status: "control_unavailable"}
	}
	if errno != 0 {
		if errno == syscall.EPERM || errno == syscall.EACCES {
			tcpUnavailable.Store(1)
			return tcpInfoResult{Status: "permission_denied"}
		}
		if errno == syscall.ENOPROTOOPT || errno == syscall.EOPNOTSUPP || errno == syscall.ENOSYS {
			tcpUnavailable.Store(2)
			return tcpInfoResult{Status: "unsupported"}
		}
		return tcpInfoResult{Status: "getsockopt_error"}
	}
	if length > uint32(len(data)) {
		tcpUnavailable.Store(3)
		return tcpInfoResult{Status: "invalid_returned_length"}
	}
	return decodeTCPInfo(data[:length])
}

var monoUnavailable atomic.Bool

func monotonicNS() string {
	if monoUnavailable.Load() {
		return ""
	}
	var ts syscall.Timespec
	_, _, errno := syscall.Syscall(syscall.SYS_CLOCK_GETTIME, 1, uintptr(unsafe.Pointer(&ts)), 0)
	if errno != 0 {
		monoUnavailable.Store(true)
		return ""
	}
	return strconv.FormatInt(ts.Sec*1_000_000_000+ts.Nsec, 10)
}
func clockAnchor() map[string]string {
	before := monotonicNS()
	wall := strconv.FormatInt(time.Now().UnixNano(), 10)
	after := monotonicNS()
	status := "available"
	if before == "" || after == "" {
		status = "unavailable"
	}
	return map[string]string{"monotonicBeforeNs": before, "wallUnixNs": wall, "monotonicAfterNs": after, "status": status}
}

type tcpObservation struct {
	Phase                            string
	Attempt                          uint32
	Connection                       uint64
	BeginOffsetNS, EndOffsetNS       int64
	BeginMonotonicNS, EndMonotonicNS string
	TCPInfo                          tcpInfoResult
}
type tcpProbeResult struct {
	ObservationClosedOffsetNS                                        int64
	Selected                                                         bool
	ReadAttempts, SkippedCompleted, DiscardedOverlap, DroppedByLimit int32
	Samples                                                          []tcpObservation
}

var probeTimers sync.WaitGroup
var socketOrdinals sync.Map
var socketOrdinalCounter atomic.Uint64

func socketOrdinal(conn net.Conn) uint64 {
	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		return 0
	}
	if value, ok := socketOrdinals.Load(tcp); ok {
		return value.(uint64)
	}
	value, _ := socketOrdinals.LoadOrStore(tcp, socketOrdinalCounter.Add(1))
	return value.(uint64)
}

type tcpProbe struct {
	selected                         bool
	start                            time.Time
	read                             func(net.Conn) tcpInfoResult
	closed                           atomic.Int64
	attempt                          atomic.Uint32
	reads, skipped, overlap, dropped atomic.Int32
	mu                               sync.Mutex
	conn                             net.Conn
	ordinal                          uint64
	connAttempt                      uint32
	samples                          []tcpObservation
	timers                           []*time.Timer
}

func newTCPProbe(start time.Time, selected bool) *tcpProbe {
	return &tcpProbe{start: start, selected: selected, read: readTCPInfo}
}
func (p *tcpProbe) capture(phase string, attempt uint32, conn net.Conn, ordinal uint64, boundary bool) {
	if !p.selected || conn == nil {
		return
	}
	if !boundary && (p.closed.Load() != 0 || p.attempt.Load() != attempt) {
		p.skipped.Add(1)
		return
	}
	if p.reads.Add(1) > 32 {
		p.dropped.Add(1)
		return
	}
	begin := time.Since(p.start).Nanoseconds()
	beginMono := monotonicNS()
	// Recheck immediately before Control; a first-byte hook never waits on this read.
	if !boundary && (p.closed.Load() != 0 || p.attempt.Load() != attempt) {
		p.skipped.Add(1)
		return
	}
	value := p.read(conn)
	end := time.Since(p.start).Nanoseconds()
	endMono := monotonicNS()
	closed := p.closed.Load()
	if !boundary && ((closed != 0 && closed <= end) || p.attempt.Load() != attempt) {
		p.overlap.Add(1)
		return
	}
	row := tcpObservation{Phase: phase, Attempt: attempt, Connection: ordinal, BeginOffsetNS: begin, EndOffsetNS: end, BeginMonotonicNS: beginMono, EndMonotonicNS: endMono, TCPInfo: value}
	p.mu.Lock()
	p.samples = append(p.samples, row)
	p.mu.Unlock()
}
func (p *tcpProbe) gotConn(conn net.Conn) {
	if !p.selected {
		return
	}
	attempt := p.attempt.Add(1)
	ordinal := socketOrdinal(conn)
	p.mu.Lock()
	p.conn = conn
	p.ordinal = ordinal
	p.connAttempt = attempt
	p.mu.Unlock()
	p.capture("got_conn", attempt, conn, ordinal, false)
}
func (p *tcpProbe) wrote() {
	if !p.selected {
		return
	}
	p.mu.Lock()
	conn, ordinal, attempt := p.conn, p.ordinal, p.connAttempt
	p.mu.Unlock()
	p.capture("wrote_request_before_transport_flush", attempt, conn, ordinal, false)
	if attempt > 8 {
		return
	}
	p.mu.Lock()
	if p.closed.Load() == 0 && len(p.timers) < 16 {
		for _, delay := range []time.Duration{200 * time.Millisecond, 500 * time.Millisecond} {
			phase := "pending_" + strconv.FormatInt(delay.Milliseconds(), 10) + "ms_after_wrote_callback"
			probeTimers.Add(1)
			timer := time.AfterFunc(delay, func() { defer probeTimers.Done(); p.capture(phase, attempt, conn, ordinal, false) })
			p.timers = append(p.timers, timer)
		}
	}
	p.mu.Unlock()
}
func (p *tcpProbe) closeObservation(firstByte bool) {
	p.closeObservationAt(firstByte, time.Since(p.start).Nanoseconds())
}
func (p *tcpProbe) closeObservationAt(firstByte bool, at int64) {
	if !p.selected {
		return
	}
	p.closed.CompareAndSwap(0, at+1)
	p.mu.Lock()
	conn, ordinal, attempt := p.conn, p.ordinal, p.connAttempt
	for _, timer := range p.timers {
		if timer.Stop() {
			probeTimers.Done()
		}
	}
	p.timers = nil
	p.mu.Unlock()
	if firstByte {
		p.capture("first_response_byte", attempt, conn, ordinal, true)
	}
}
func (p *tcpProbe) result() tcpProbeResult {
	p.mu.Lock()
	samples := append([]tcpObservation(nil), p.samples...)
	p.mu.Unlock()
	closed := p.closed.Load()
	overlap := p.overlap.Load()
	kept := samples[:0]
	for _, sample := range samples {
		if sample.Phase != "first_response_byte" && closed != 0 && sample.EndOffsetNS >= closed {
			overlap++
			continue
		}
		kept = append(kept, sample)
	}
	return tcpProbeResult{ObservationClosedOffsetNS: closed, Selected: p.selected, ReadAttempts: p.reads.Load(), SkippedCompleted: p.skipped.Load(), DiscardedOverlap: overlap, DroppedByLimit: p.dropped.Load(), Samples: kept}
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
	if runtime.GOOS != "linux" {
		panic("diagnostic_requires_linux")
	}
	initialClock := clockAnchor()
	key := ""
	if *keyfile != "" {
		b, e := os.ReadFile(*keyfile)
		if e != nil {
			panic("diagnostic_setup_or_output_failure")
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
					panic("diagnostic_setup_or_output_failure")
				}
				req.Header.Set("Content-Type", "application/json")
				if key != "" {
					req.Header.Set("Authorization", "Bearer "+key)
				}
				beforeStartedMono := monotonicNS()
				t := time.Now()
				startedMono := monotonicNS()
				probe := newTCPProbe(t, idx <= 256 || idx%1000 == 0)
				var netMu sync.Mutex
				netData := networkTrace{GetConnMS: -1, GotConnMS: -1, WroteRequestMS: -1, FirstResponseByteMS: -1}
				var connectStarted time.Time
				offset := func() float64 { return float64(time.Since(t).Microseconds()) / 1000 }
				trace := &httptrace.ClientTrace{
					GetConn: func(string) {
						mono := monotonicNS()
						netMu.Lock()
						netData.GetConnMonotonicNS = mono
						netData.GetConnCalls++
						netData.GetConnMS = offset()
						netMu.Unlock()
					},
					GotConn: func(info httptrace.GotConnInfo) {
						mono := monotonicNS()
						netMu.Lock()
						netData.GotConnMonotonicNS = mono
						netData.GotConnCalls++
						netData.GotConnMS = offset()
						netData.Reused = info.Reused
						netData.WasIdle = info.WasIdle
						netData.IdleMS = float64(info.IdleTime.Microseconds()) / 1000
						netMu.Unlock()
						probe.gotConn(info.Conn)
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
					WroteRequest: func(info httptrace.WroteRequestInfo) {
						mono := monotonicNS()
						netMu.Lock()
						netData.WroteRequestMonotonicNS = mono
						netData.WroteRequestCalls++
						if info.Err != nil {
							netData.WriteErrors++
						}
						netData.WroteRequestMS = offset()
						netMu.Unlock()
						if info.Err == nil {
							probe.wrote()
						}
					},
					GotFirstResponseByte: func() {
						atNS := time.Since(t).Nanoseconds()
						mono := monotonicNS()
						at := float64(atNS) / 1e6
						probe.closeObservationAt(true, atNS)
						netMu.Lock()
						netData.FirstResponseByteMonotonicNS = mono
						netData.FirstResponseByteCalls++
						netData.FirstResponseByteMS = at
						netMu.Unlock()
					},
				}
				req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))
				s := sample{probe: probe, StartedMonotonicBeforeNS: beforeStartedMono, StartedMonotonicNS: startedMono, StartSeq: idx, StartOffsetMS: float64(t.Sub(start).Microseconds()) / 1000, StartedEpochMicros: t.UnixMicro()}
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
				probe.closeObservation(false)
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
	probeTimers.Wait() // Telemetry drain AFTER all request timing, never an in-path barrier.
	for i := range rows {
		rows[i].TCPProbe = rows[i].probe.result()
		rows[i].probe = nil
	}
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
	result["tcp_info_getsockopt_calls"] = tcpGetSockOptCalls.Load()
	result["clock_anchors"] = []map[string]string{initialClock, clockAnchor()}
	result["tcp_info_scope"] = "Cumulative original-connection Linux TCP_INFO; first256 start sequences and every1000th control only. Readonly getsockopt with returned-length checks; max32 attempted reads/request; no conn wrapper, payload or socket configuration. Timer overlap with firstbyte/terminal discarded. WroteRequest is BEFORE final Transport bufio.Flush, not a flush timestamp."
	result["trace_scope"] = "httptrace fixed scalars, server request-ID hash only; no URL/header/auth trace payload"
	b, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(b))
	if *out != "" {
		if e := os.WriteFile(*out, append(b, '\n'), 0600); e != nil {
			panic("diagnostic_setup_or_output_failure")
		}
	}
}
