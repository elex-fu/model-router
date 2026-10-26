package main

import (
	"encoding/binary"
	"net"
	"sync"
	"testing"
	"time"
)

type inertConn struct{}

func (*inertConn) Read([]byte) (int, error)         { panic("probe_must_not_read") }
func (*inertConn) Write([]byte) (int, error)        { panic("probe_must_not_write") }
func (*inertConn) Close() error                     { panic("probe_must_not_close") }
func (*inertConn) LocalAddr() net.Addr              { panic("probe_must_not_read_address") }
func (*inertConn) RemoteAddr() net.Addr             { panic("probe_must_not_read_address") }
func (*inertConn) SetDeadline(time.Time) error      { panic("probe_must_not_change_deadline") }
func (*inertConn) SetReadDeadline(time.Time) error  { panic("probe_must_not_change_deadline") }
func (*inertConn) SetWriteDeadline(time.Time) error { panic("probe_must_not_change_deadline") }

func TestTCPInfoReturnedLengthControlsAvailableFields(t *testing.T) {
	short := decodeTCPInfo(make([]byte, 103))
	if short.Status != "short_tcp_info" || short.Metrics != nil {
		t.Fatal("short result must not claim zero-valued fields")
	}
	base := make([]byte, 104)
	binary.NativeEndian.PutUint32(base[100:], 7)
	decoded := decodeTCPInfo(base)
	if decoded.Metrics["total_retrans"] != 7 {
		t.Fatal("base counter missing")
	}
	if _, present := decoded.Metrics["bytes_sent"]; present {
		t.Fatal("unsupported tail field fabricated")
	}
	extended := make([]byte, 216)
	binary.NativeEndian.PutUint64(extended[200:], 123456)
	binary.NativeEndian.PutUint64(extended[208:], 512)
	decoded = decodeTCPInfo(extended)
	if decoded.Metrics["bytes_sent"] != 123456 || decoded.Metrics["bytes_retrans"] != 512 {
		t.Fatal("tail offsets wrong")
	}
}

func TestProbeReadsOriginalConnectionWithoutMutation(t *testing.T) {
	conn := &inertConn{}
	p := newTCPProbe(time.Now(), true)
	p.read = func(observed net.Conn) tcpInfoResult {
		if observed != conn {
			t.Fatal("connection identity changed")
		}
		return tcpInfoResult{Status: "available", Length: 104, Metrics: map[string]uint64{"unacked": 1}}
	}
	p.gotConn(conn)
	p.closeObservation(true)
	p.closeObservation(false)
	r := p.result()
	if len(r.Samples) != 2 || r.Samples[0].Phase != "got_conn" || r.Samples[1].Phase != "first_response_byte" {
		t.Fatal("boundary observations missing")
	}
	for _, s := range r.Samples {
		if s.EndOffsetNS < s.BeginOffsetNS {
			t.Fatal("reversed read interval")
		}
	}
}

func TestFirstByteDoesNotWaitForTimerReadAndOverlappingReadIsDiscarded(t *testing.T) {
	p := newTCPProbe(time.Now(), true)
	p.attempt.Store(1)
	entered, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	p.read = func(net.Conn) tcpInfoResult {
		close(entered)
		<-release
		return tcpInfoResult{Status: "available", Length: 104}
	}
	go func() { defer close(finished); p.capture("pending", 1, &inertConn{}, 1, false) }()
	<-entered
	closed := make(chan struct{})
	go func() { p.closeObservation(false); close(closed) }()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("terminal observation blocked behind TCP_INFO read")
	}
	close(release)
	<-finished
	r := p.result()
	if r.DiscardedOverlap != 1 || len(r.Samples) != 0 {
		t.Fatal("late sample was attributed to completed request")
	}
}

func TestProbeLimitAndSupersededAttemptAreConservative(t *testing.T) {
	p := newTCPProbe(time.Now(), true)
	p.attempt.Store(2)
	var mu sync.Mutex
	reads := 0
	p.read = func(net.Conn) tcpInfoResult {
		mu.Lock()
		reads++
		mu.Unlock()
		return tcpInfoResult{Status: "available", Length: 104}
	}
	conn := &inertConn{}
	p.capture("old_attempt", 1, conn, 1, false)
	for i := 0; i < 40; i++ {
		p.capture("bounded", 2, conn, 2, false)
	}
	r := p.result()
	if reads != 32 || len(r.Samples) != 32 || r.SkippedCompleted != 1 || r.DroppedByLimit != 8 {
		t.Fatal("read cap or attempt fencing failed")
	}
}

func TestUnselectedProbeDoesNotRead(t *testing.T) {
	p := newTCPProbe(time.Now(), false)
	p.read = func(net.Conn) tcpInfoResult { t.Fatal("unselected read"); return tcpInfoResult{} }
	p.gotConn(&inertConn{})
	p.wrote()
	p.closeObservation(true)
	if len(p.result().Samples) != 0 {
		t.Fatal("unselected samples")
	}
}

func TestFinalSnapshotExcludesPreemptionWindowOverlap(t *testing.T) {
	p := newTCPProbe(time.Now(), true)
	p.samples = []tcpObservation{{Phase: "pending", EndOffsetNS: 101}, {Phase: "got_conn", EndOffsetNS: 49}, {Phase: "first_response_byte", EndOffsetNS: 103}}
	p.closed.Store(100)
	r := p.result()
	if r.DiscardedOverlap != 1 || len(r.Samples) != 2 || r.ObservationClosedOffsetNS != 100 {
		t.Fatal("final closed-time fence failed")
	}
}

func TestTimerCancellationDrainsWithoutWaitingInsideRequest(t *testing.T) {
	p := newTCPProbe(time.Now(), true)
	p.read = func(net.Conn) tcpInfoResult { return tcpInfoResult{Status: "available", Length: 104} }
	p.gotConn(&inertConn{})
	p.wrote()
	p.closeObservation(true)
	p.closeObservation(false)
	done := make(chan struct{})
	go func() { probeTimers.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("canceled diagnostic timer leaked")
	}
}
