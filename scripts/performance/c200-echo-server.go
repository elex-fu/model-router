// Diagnostic-only, no-database HTTP control. Run/build this file explicitly,
// not the directory (which also contains a standalone client main).
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

const echoRole = "go-http-echo"
const echoResponse = `{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`
const echoMaxConnections = 1024
const echoMaxRequests = 2048
const echoMaxBody = 4096

type echoAnchor struct {
	MonotonicBeforeNs string `json:"monotonicBeforeNs"`
	WallUnixNs        string `json:"wallUnixNs"`
	MonotonicAfterNs  string `json:"monotonicAfterNs"`
	Status            string `json:"status"`
}

var echoClockUnavailable atomic.Bool

func echoMonotonicNS() string {
	if echoClockUnavailable.Load() {
		return ""
	}
	var ts syscall.Timespec
	_, _, errno := syscall.Syscall(syscall.SYS_CLOCK_GETTIME, 1, uintptr(unsafe.Pointer(&ts)), 0)
	if errno != 0 {
		echoClockUnavailable.Store(true)
		return ""
	}
	return strconv.FormatInt(ts.Sec*1_000_000_000+ts.Nsec, 10)
}
func echoClockAnchor() echoAnchor {
	before := echoMonotonicNS()
	wall := strconv.FormatInt(time.Now().UnixNano(), 10)
	after := echoMonotonicNS()
	status := "available"
	if before == "" || after == "" {
		status = "unavailable"
	}
	return echoAnchor{before, wall, after, status}
}

type echoConfig struct {
	port, delayMS int
	state, out    string
}

func echoParseConfig(args []string) (echoConfig, error) {
	c := echoConfig{}
	f := flag.NewFlagSet(echoRole, flag.ContinueOnError)
	f.SetOutput(io.Discard)
	f.IntVar(&c.port, "port", 0, "loopback port")
	f.IntVar(&c.delayMS, "delay-ms", 5, "response delay")
	f.StringVar(&c.state, "state", "", "absolute ready-state file")
	f.StringVar(&c.out, "out", "", "absolute observations file")
	if f.Parse(args) != nil || f.NArg() != 0 || c.port < 0 || c.port > 65535 || c.delayMS < 0 || c.delayMS > 100 || !filepath.IsAbs(c.state) || !filepath.IsAbs(c.out) || filepath.Clean(c.state) == filepath.Clean(c.out) {
		return echoConfig{}, errors.New("go-http-echo: configuration failed")
	}
	return c, nil
}

type echoConnection struct {
	Connection              uint64 `json:"connection"`
	ConnContextMonotonicNs  string `json:"connContextMonotonicNs"`
	ConnStateNewMonotonicNs string `json:"connStateNewMonotonicNs"`
}
type echoRequest struct {
	Request                 uint64 `json:"request"`
	Connection              uint64 `json:"connection"`
	RequestHash             string `json:"requestHash"`
	HandlerStartMonotonicNs string `json:"handlerStartMonotonicNs"`
	BodyDrainedMonotonicNs  string `json:"bodyDrainedMonotonicNs"`
	WriteStartedMonotonicNs string `json:"writeStartedMonotonicNs"`
	HandlerEndMonotonicNs   string `json:"handlerEndMonotonicNs"`
	Status                  int    `json:"status"`
	Outcome                 string `json:"outcome"`
}
type echoContextKey struct{}
type echoRecorder struct {
	connectionsDone                     sync.WaitGroup
	mu                                  sync.Mutex
	connectionCount                     uint64
	requests                            atomic.Uint64
	connections                         []echoConnection
	rows                                []echoRequest
	connIndices                         map[net.Conn]int
	droppedConnections, droppedRequests uint64
	delay                               time.Duration
	handlers                            sync.WaitGroup
}

func echoNewRecorder(delayMS int) *echoRecorder {
	return &echoRecorder{delay: time.Duration(delayMS) * time.Millisecond, connIndices: make(map[net.Conn]int), connections: make([]echoConnection, 0, echoMaxConnections), rows: make([]echoRequest, 0, echoMaxRequests)}
}

// ConnContext is a net/http callback after listener.Accept, not kernel accept time.
// Keep the original listener and connection; never inspect either peer address.
func (e *echoRecorder) connContext(ctx context.Context, conn net.Conn) context.Context {
	stamp := echoMonotonicNS()
	e.connectionsDone.Add(1)
	e.mu.Lock()
	e.connectionCount++
	id := e.connectionCount
	if len(e.connections) < echoMaxConnections {
		e.connIndices[conn] = len(e.connections)
		e.connections = append(e.connections, echoConnection{Connection: id, ConnContextMonotonicNs: stamp})
	} else {
		e.droppedConnections++
	}
	e.mu.Unlock()
	return context.WithValue(ctx, echoContextKey{}, id)
}
func (e *echoRecorder) connState(conn net.Conn, state http.ConnState) {
	if state == http.StateClosed || state == http.StateHijacked {
		defer e.connectionsDone.Done()
	}
	if state != http.StateNew && state != http.StateClosed && state != http.StateHijacked {
		return
	}
	stamp := ""
	if state == http.StateNew {
		stamp = echoMonotonicNS()
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if index, ok := e.connIndices[conn]; ok {
		if state == http.StateNew {
			e.connections[index].ConnStateNewMonotonicNs = stamp
		} else {
			delete(e.connIndices, conn)
		}
	}
}
func (e *echoRecorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	e.handlers.Add(1)
	defer e.handlers.Done()
	row := echoRequest{Request: e.requests.Add(1), HandlerStartMonotonicNs: echoMonotonicNS(), Outcome: "canceled"}
	row.Connection, _ = r.Context().Value(echoContextKey{}).(uint64)
	requestID := fmt.Sprintf("00000000-0000-4000-8000-%012d", row.Request)
	hash := sha256.Sum256([]byte(requestID))
	row.RequestHash = hex.EncodeToString(hash[:])
	defer func() {
		// Handler return is NOT response EOF or a kernel/socket write completion.
		row.HandlerEndMonotonicNs = echoMonotonicNS()
		e.mu.Lock()
		defer e.mu.Unlock()
		if len(e.rows) < echoMaxRequests {
			e.rows = append(e.rows, row)
		} else {
			e.droppedRequests++
		}
	}()
	w.Header().Set("X-Request-Id", requestID)
	body := http.MaxBytesReader(w, r.Body, echoMaxBody)
	_, err := io.Copy(io.Discard, body)
	_ = body.Close()
	if err != nil {
		row.Status = http.StatusBadRequest
		row.Outcome = "body_read_failed"
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			row.Status = http.StatusRequestEntityTooLarge
			row.Outcome = "body_too_large"
		}
		if r.Context().Err() != nil {
			row.Status = 0
			row.Outcome = "canceled"
			return
		}
		w.Header().Set("Content-Length", "0")
		row.WriteStartedMonotonicNs = echoMonotonicNS()
		w.WriteHeader(row.Status)
		return
	}
	row.BodyDrainedMonotonicNs = echoMonotonicNS()
	timer := time.NewTimer(e.delay)
	defer timer.Stop()
	select {
	case <-r.Context().Done():
		return
	case <-timer.C:
	}
	if r.Context().Err() != nil {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(echoResponse)))
	row.Status = http.StatusOK
	row.Outcome = "response_written"
	row.WriteStartedMonotonicNs = echoMonotonicNS()
	w.WriteHeader(row.Status)
	if _, err := io.WriteString(w, echoResponse); err != nil {
		row.Outcome = "write_failed"
	}
}

type echoState struct {
	DiagnosticOnly bool       `json:"diagnosticOnly"`
	PID            int        `json:"pid"`
	Role           string     `json:"role"`
	BoundPort      int        `json:"boundPort"`
	DelayMS        int        `json:"delayMs"`
	ResponseBytes  int        `json:"responseBytes"`
	ClockAnchor    echoAnchor `json:"clockAnchor"`
}
type echoOutput struct {
	DiagnosticOnly               bool             `json:"diagnosticOnly"`
	Role                         string           `json:"role"`
	Phase                        string           `json:"phase"`
	DelayMS                      int              `json:"delayMs"`
	ResponseBytes                int              `json:"responseBytes"`
	BeginClockAnchor             echoAnchor       `json:"beginClockAnchor"`
	EndClockAnchor               echoAnchor       `json:"endClockAnchor"`
	ConnectionTimestampSemantics string           `json:"connectionTimestampSemantics"`
	HandlerEndSemantics          string           `json:"handlerEndSemantics"`
	ConnectionCount              uint64           `json:"connectionCount"`
	RequestCount                 uint64           `json:"requestCount"`
	DroppedConnections           uint64           `json:"droppedConnections"`
	DroppedRequests              uint64           `json:"droppedRequests"`
	Connections                  []echoConnection `json:"connections"`
	Requests                     []echoRequest    `json:"requests"`
}

func (e *echoRecorder) snapshot(begin echoAnchor, delayMS int, phase string) echoOutput {
	e.mu.Lock()
	defer e.mu.Unlock()
	return echoOutput{true, echoRole, phase, delayMS, len(echoResponse), begin, echoClockAnchor(), "ConnContext after listener.Accept; ConnStateNew is a separate net/http callback, neither is kernel accept time", "handler return observation, not response EOF or socket write completion", e.connectionCount, e.requests.Load(), e.droppedConnections, e.droppedRequests, append([]echoConnection{}, e.connections...), append([]echoRequest{}, e.rows...)}
}
func echoWriteJSON(path string, value any) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".c200-go-echo-*")
	if err != nil {
		return errors.New("go-http-echo: output failed")
	}
	name := file.Name()
	defer os.Remove(name)
	if err = file.Chmod(0600); err == nil {
		err = json.NewEncoder(file).Encode(value)
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(name, path)
	}
	if err != nil {
		return errors.New("go-http-echo: output failed")
	}
	return nil
}
func echoRun(c echoConfig) error {
	begin := echoClockAnchor()
	if begin.Status != "available" {
		return errors.New("go-http-echo: clock unavailable")
	}
	listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(c.port)))
	if err != nil {
		return errors.New("go-http-echo: listener setup failed")
	}
	defer listener.Close()
	boundPort := listener.Addr().(*net.TCPAddr).Port
	recorder := echoNewRecorder(c.delayMS)
	server := &http.Server{Handler: recorder, ConnContext: recorder.connContext, ConnState: recorder.connState, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second, IdleTimeout: 5 * time.Second, MaxHeaderBytes: 8192, ErrorLog: log.New(io.Discard, "", 0)}
	signalCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	served := make(chan error, 1)
	go func() { served <- server.Serve(listener) }()
	if err := echoWriteJSON(c.state, echoState{true, os.Getpid(), echoRole, boundPort, c.delayMS, len(echoResponse), echoClockAnchor()}); err != nil {
		_ = server.Close()
		<-served
		recorder.connectionsDone.Wait()
		recorder.handlers.Wait()
		return errors.New("go-http-echo: ready-state failed")
	}
	var serveErr error
	select {
	case <-signalCtx.Done():
	case serveErr = <-served:
		served = nil
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	shutdownErr := server.Shutdown(shutdownCtx)
	cancel()
	if shutdownErr != nil {
		_ = server.Close()
	}
	if served != nil {
		serveErr = <-served
	}
	// Shutdown normally waits for handlers. Close on timeout cancels body reads
	// and delay timers; wait for their deferred observations before serialization.
	recorder.connectionsDone.Wait()
	recorder.handlers.Wait()
	phase := "go-http-echo-complete"
	if shutdownErr != nil || (serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed)) {
		phase = "go-http-echo-failed"
	}
	if err := echoWriteJSON(c.out, recorder.snapshot(begin, c.delayMS, phase)); err != nil {
		return err
	}
	if phase != "go-http-echo-complete" {
		return errors.New("go-http-echo: shutdown failed")
	}
	return nil
}
func main() {
	config, err := echoParseConfig(os.Args[1:])
	if err == nil {
		err = echoRun(config)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}
