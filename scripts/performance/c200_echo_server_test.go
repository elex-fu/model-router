package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestEchoFixedResponseAndUUID(t *testing.T) {
	recorder := echoNewRecorder(0)
	for i := 1; i <= 2; i++ {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"diagnostic"}`))
		recorder.ServeHTTP(response, request)
		if response.Code != http.StatusOK || response.Body.String() != `{"choices":[{"message":{"role":"assistant","content":"ok"}}]}` {
			t.Fatal("unexpected response")
		}
		if response.Header().Get("Content-Type") != "application/json" || response.Header().Get("Content-Length") != strconv.Itoa(len(echoResponse)) {
			t.Fatal("missing fixed response headers")
		}
		expected := "00000000-0000-4000-8000-00000000000" + strconv.Itoa(i)
		if response.Header().Get("X-Request-Id") != expected {
			t.Fatal("unexpected deterministic UUID")
		}
		if response.Header().Get("X-Execution-Mode") != "" {
			t.Fatal("must not impersonate a money-mode response")
		}
		hash := sha256.Sum256([]byte(expected))
		row := recorder.rows[i-1]
		if row.RequestHash != hex.EncodeToString(hash[:]) || row.Status != 200 || row.Outcome != "response_written" {
			t.Fatal("invalid request observation")
		}
		prev := int64(0)
		for _, stamp := range []string{row.HandlerStartMonotonicNs, row.BodyDrainedMonotonicNs, row.WriteStartedMonotonicNs, row.HandlerEndMonotonicNs} {
			ns, err := strconv.ParseInt(stamp, 10, 64)
			if err != nil || ns < prev {
				t.Fatal("invalid monotonic timestamp sequence")
			}
			prev = ns
		}
	}
}
func TestEchoBodyLimit(t *testing.T) {
	for _, size := range []int{echoMaxBody, echoMaxBody + 1} {
		recorder := echoNewRecorder(0)
		response := httptest.NewRecorder()
		recorder.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(strings.Repeat("x", size))))
		want := 200
		if size > echoMaxBody {
			want = 413
		}
		if response.Code != want || recorder.rows[0].Status != want {
			t.Fatal("body cap not enforced")
		}
		if size > echoMaxBody && (response.Body.Len() != 0 || recorder.rows[0].BodyDrainedMonotonicNs != "") {
			t.Fatal("oversized body must not appear drained or echo a body")
		}
	}
}
func TestEchoCancellation(t *testing.T) {
	recorder := echoNewRecorder(100)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	response := httptest.NewRecorder()
	recorder.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/", strings.NewReader("x")).WithContext(ctx))
	if response.Body.Len() != 0 || recorder.rows[0].Status != 0 || recorder.rows[0].WriteStartedMonotonicNs != "" || recorder.rows[0].Outcome != "canceled" {
		t.Fatal("canceled request was written")
	}
}

// No sockets: these connection objects only identify callbacks. Any accidental
// address/read/write inspection panics, ensuring the observer remains passive.
type echoTestConn struct{ id int }

func (*echoTestConn) Read([]byte) (int, error)         { panic("unexpected connection read") }
func (*echoTestConn) Write([]byte) (int, error)        { panic("unexpected connection write") }
func (*echoTestConn) Close() error                     { panic("unexpected connection close") }
func (*echoTestConn) LocalAddr() net.Addr              { panic("unexpected local address read") }
func (*echoTestConn) RemoteAddr() net.Addr             { panic("unexpected remote address read") }
func (*echoTestConn) SetDeadline(time.Time) error      { panic("unexpected deadline") }
func (*echoTestConn) SetReadDeadline(time.Time) error  { panic("unexpected deadline") }
func (*echoTestConn) SetWriteDeadline(time.Time) error { panic("unexpected deadline") }
func TestEchoBoundedObservationsConcurrent(t *testing.T) {
	recorder := echoNewRecorder(0)
	var workers sync.WaitGroup
	for i := 0; i < echoMaxRequests+32; i++ {
		workers.Add(1)
		go func(i int) {
			defer workers.Done()
			conn := &echoTestConn{id: i}
			ctx := recorder.connContext(context.Background(), conn)
			recorder.connState(conn, http.StateNew)
			recorder.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/", strings.NewReader("x")).WithContext(ctx))
			recorder.connState(conn, http.StateClosed)
		}(i)
	}
	workers.Wait()
	recorder.connectionsDone.Wait()
	recorder.handlers.Wait()
	out := recorder.snapshot(echoClockAnchor(), 0, "go-http-echo-complete")
	if len(out.Connections) != echoMaxConnections || len(out.Requests) != echoMaxRequests || out.DroppedConnections != echoMaxRequests+32-echoMaxConnections || out.DroppedRequests != 32 || out.RequestCount != echoMaxRequests+32 || out.ConnectionCount != echoMaxRequests+32 {
		t.Fatal("observation bounds or counters incorrect")
	}
	if len(recorder.connIndices) != 0 {
		t.Fatal("closed connections retained")
	}
	for _, row := range out.Connections {
		if row.ConnContextMonotonicNs == "" || row.ConnStateNewMonotonicNs == "" {
			t.Fatal("connection timestamps missing")
		}
	}
	for _, row := range out.Requests {
		if row.Connection == 0 {
			t.Fatal("connection ordinal missing")
		}
	}
}
func TestEchoConfiguration(t *testing.T) {
	valid := []string{"--port", "0", "--delay-ms", "5", "--state", "/tmp/state.json", "--out", "/tmp/server.json"}
	if _, err := echoParseConfig(valid); err != nil {
		t.Fatal("valid config rejected")
	}
	for _, args := range [][]string{
		{}, {"--port", "-1"}, {"--port", "65536"}, {"--delay-ms", "-1"}, {"--delay-ms", "101"},
		{"--state", "relative", "--out", "/tmp/server.json"}, {"--state", "/tmp/state.json", "--out", "relative"},
		{"--state", "/tmp/state.json", "--out", "/tmp/state.json"}, {"--unknown-secret-value"},
	} {
		if _, err := echoParseConfig(args); err == nil || err.Error() != "go-http-echo: configuration failed" {
			t.Fatal("unsafe configuration error")
		}
	}
}
func TestEchoClockAnchorAndPrivateAtomicOutput(t *testing.T) {
	anchor := echoClockAnchor()
	before, err := strconv.ParseInt(anchor.MonotonicBeforeNs, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	after, err := strconv.ParseInt(anchor.MonotonicAfterNs, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	if anchor.Status != "available" || before > after || anchor.WallUnixNs == "" {
		t.Fatal("invalid bracketed clock anchor")
	}
	path := filepath.Join(t.TempDir(), "state.json")
	state := echoState{true, 42, echoRole, 1234, 5, len(echoResponse), anchor}
	if err := echoWriteJSON(path, state); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatal("output permissions are not private")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got echoState
	if json.Unmarshal(data, &got) != nil || got != state {
		t.Fatal("atomic output mismatch")
	}
	if err := echoWriteJSON(filepath.Join(path, "nope"), state); err == nil || err.Error() != "go-http-echo: output failed" {
		t.Fatal("unsafe output error")
	}
}

type echoErrorBody struct{}

func (echoErrorBody) Read([]byte) (int, error) { return 0, errors.New("sensitive request error") }
func (echoErrorBody) Close() error             { return nil }
func TestEchoBodyErrorRedacted(t *testing.T) {
	recorder := echoNewRecorder(0)
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req.Body = echoErrorBody{}
	response := httptest.NewRecorder()
	recorder.ServeHTTP(response, req)
	if response.Code != 400 || response.Body.Len() != 0 || recorder.rows[0].Outcome != "body_read_failed" {
		t.Fatal("body error not safely classified")
	}
	serialized, _ := json.Marshal(recorder.snapshot(echoClockAnchor(), 0, "go-http-echo-complete"))
	if strings.Contains(string(serialized), "sensitive") {
		t.Fatal("raw error leaked")
	}
}
