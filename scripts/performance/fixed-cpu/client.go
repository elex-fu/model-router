// Fixed-quota client derived from the repository timing client. Standard library only.
// Every attempted request is retained, including overload, protocol and transport errors.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type sample struct {
	MS, TTFB float64
	Status   int
	Err      string
	Bytes    int
	Mode     string
	Fallback string
}

// Exactly one admission bound is active: positive count OR positive duration.
// n=0 is duration-only, not an empty workload or an unlimited loop.
func validWorkload(n, c int, duration time.Duration) bool {
	return n >= 0 && n <= 100000 && c >= 1 && c <= 200 && duration >= 0 && duration <= 60*time.Second && ((n == 0 && duration > 0) || (n > 0 && duration == 0))
}
func admitAttempt(next int64, n int, duration time.Duration, now, deadline time.Time) bool {
	if n == 0 {
		return duration > 0 && now.Before(deadline)
	}
	return next <= int64(n) && duration == 0
}
func recordAttempt(journal *json.Encoder, attempt int64, event string, value *sample) error {
	return journal.Encode(struct {
		Attempt  int64   `json:"attempt"`
		Event    string  `json:"event"`
		AtUnixNS string  `json:"at_unix_ns"`
		Sample   *sample `json:"sample,omitempty"`
	}{attempt, event, fmt.Sprint(time.Now().UnixNano()), value})
}

// Stream final samples from the owned journal: no attempt-count-sized slices or
// error maps live in the 512-MiB driver. Exact tails are computed by the host.
func writeAggregate(output io.Writer, journal io.Reader, metadata map[string]any, expected int) error {
	prefix, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	if _, err = output.Write(prefix[:len(prefix)-1]); err != nil {
		return err
	}
	if len(prefix) > 2 {
		if _, err = io.WriteString(output, ","); err != nil {
			return err
		}
	}
	if _, err = io.WriteString(output, `"samples":[`); err != nil {
		return err
	}
	decoder := json.NewDecoder(journal)
	encoder := json.NewEncoder(output)
	admitted, completed := 0, 0
	for {
		var row struct {
			Event  string
			Sample *sample
		}
		if err = decoder.Decode(&row); err == io.EOF {
			break
		} else if err != nil {
			return err
		}
		switch row.Event {
		case "admitted":
			admitted++
		case "completed":
			if row.Sample == nil {
				return fmt.Errorf("journal completion missing sample")
			}
			if completed > 0 {
				if _, err = io.WriteString(output, ","); err != nil {
					return err
				}
			}
			if err = encoder.Encode(row.Sample); err != nil {
				return err
			}
			completed++
		default:
			return fmt.Errorf("unknown attempt journal event")
		}
	}
	if completed != expected || admitted != expected {
		return fmt.Errorf("incomplete attempt journal: admitted=%d completed=%d expected=%d", admitted, completed, expected)
	}
	_, err = io.WriteString(output, "]}\n")
	return err
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
	if !validWorkload(*n, *c, *duration) || *out == "" {
		panic("positive count OR duration-only n=0; c<=200, duration<=60s and output required")
	}
	key := ""
	if *keyfile != "" {
		b, e := os.ReadFile(*keyfile)
		if e != nil {
			panic(e)
		}
		key = strings.TrimSpace(string(b))
	}
	body, _ := json.Marshal(map[string]any{"model": "native-fast-ci-model", "max_tokens": 64, "messages": []any{map[string]string{"role": "user", "content": "bench"}}, "stream": *stream})
	tr := &http.Transport{MaxIdleConns: 1000, MaxIdleConnsPerHost: 1000, MaxConnsPerHost: 1000, IdleConnTimeout: 90 * time.Second}
	cl := &http.Client{Transport: tr, Timeout: 60 * time.Second}
	journalFile, err := os.OpenFile(*out+".attempts.jsonl", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		panic(err)
	}
	defer journalFile.Close()
	journal := json.NewEncoder(journalFile)
	var seq atomic.Int64
	var mu sync.Mutex
	requests, successes, totalBytes := 0, 0, 0
	var resourceBefore syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &resourceBefore); err != nil {
		panic(err)
	}
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
				if !admitAttempt(idx, *n, *duration, time.Now(), deadline) {
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
				mu.Lock()
				if err := recordAttempt(journal, idx, "admitted", nil); err != nil {
					panic(err)
				}
				mu.Unlock()
				t := time.Now()
				s := sample{}
				resp, e := cl.Do(req)
				if e != nil {
					s.Err = e.Error()
				} else {
					s.Status = resp.StatusCode
					s.Mode = resp.Header.Get("X-Model-Router-Execution-Mode")
					s.Fallback = resp.Header.Get("X-Model-Router-Fast-Fallback")
					var first [1]byte
					nn, e := resp.Body.Read(first[:])
					s.TTFB = float64(time.Since(t).Microseconds()) / 1000
					rest, re := io.ReadAll(io.LimitReader(resp.Body, 1048577))
					_ = resp.Body.Close()
					s.Bytes = nn + len(rest)
					all := append(first[:nn], rest...)
					if e != nil && e != io.EOF {
						s.Err = e.Error()
					} else if re != nil {
						s.Err = re.Error()
					} else if resp.StatusCode != 200 {
						s.Err = fmt.Sprintf("HTTP %d: %s", resp.StatusCode, all)
					} else if media, _, parseError := mime.ParseMediaType(resp.Header.Get("Content-Type")); parseError != nil || (*stream && media != "text/event-stream") || (!*stream && media != "application/json") {
						s.Err = "wrong response content type"
					} else if len(all) > 1048576 {
						s.Err = "response exceeds 1 MiB"
					} else if err := validateCompletion(all, *stream); err != nil {
						s.Err = err.Error()
					} else if s.Mode != "fast-reserved-max" || s.Fallback != "" {
						s.Err = "wrong execution mode or fallback"
					}
				}
				s.MS = float64(time.Since(t).Microseconds()) / 1000
				mu.Lock()
				if err := recordAttempt(journal, idx, "completed", &s); err != nil {
					panic(err)
				}
				requests++
				totalBytes += s.Bytes
				if s.Err == "" {
					successes++
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	completed := time.Now()
	deadlineExceeded := ctx.Err() != nil
	var resourceAfter syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &resourceAfter); err != nil {
		panic(err)
	}
	// Final durability flush is outside both driver-loop clock/resource endpoints.
	// The enclosing whole-app cgroup interval still includes external helper work.
	if err := journalFile.Sync(); err != nil {
		panic(err)
	}
	elapsed := completed.Sub(start).Seconds()
	result := map[string]any{"url": *url, "stream": *stream, "concurrency": *c, "requests": requests, "success": successes, "duration_s": elapsed, "throughput_success_rps": float64(successes) / elapsed, "bytes": totalBytes,
		"summary_scope": "constant-memory numeric driver totals; exact all-attempt and success tails/status/errors computed from streamed raw samples by host"}
	result["started_at_unix_ns"] = fmt.Sprint(start.UnixNano())
	result["completed_at_unix_ns"] = fmt.Sprint(completed.UnixNano())
	result["clock_scope"] = "same-host CLOCK_REALTIME endpoints paired with monotonic duration; verify clock stability before cross-process drain duration"
	result["deadline_exceeded"] = deadlineExceeded
	result["partial_attempt_journal"] = "admission and completion JSONL written directly during the external driver loop; retained even without final aggregate JSON"
	result["request_limit"] = *n
	result["admission_duration_s"] = duration.Seconds()
	cpuMS := func(r syscall.Rusage) float64 {
		return float64(r.Utime.Sec+r.Stime.Sec)*1000 + float64(r.Utime.Usec+r.Stime.Usec)/1000
	}
	result["driver_resource"] = map[string]any{"cpu_ms": cpuMS(resourceAfter) - cpuMS(resourceBefore), "max_rss_kib_process_lifetime": resourceAfter.Maxrss, "scope": "driver process and all native threads during request loop; peak RSS observed at loop end includes startup, excludes later serialization; external to app quota; no serialization CPU included"}
	journalInput, err := os.Open(*out + ".attempts.jsonl")
	if err != nil {
		panic(err)
	}
	defer journalInput.Close()
	aggregate, err := os.OpenFile(*out, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		panic(err)
	}
	defer aggregate.Close()
	if err = writeAggregate(aggregate, journalInput, result, requests); err != nil {
		panic(err)
	}
	if err = aggregate.Sync(); err != nil {
		panic(err)
	}
	// Stdout is bounded metadata, never a second copy of all raw attempts.
	if err = json.NewEncoder(os.Stdout).Encode(result); err != nil {
		panic(err)
	}

}

func validateCompletion(all []byte, stream bool) error {
	type completion struct {
		Choices []struct {
			Message      struct{ Content string }
			Delta        struct{ Content string }
			FinishReason *string `json:"finish_reason"`
		}
		Usage struct {
			Prompt int `json:"prompt_tokens"`
			Output int `json:"completion_tokens"`
			Total  int `json:"total_tokens"`
		}
	}
	validateUsage := func(x completion) bool { return x.Usage.Prompt == 10 && x.Usage.Output == 5 && x.Usage.Total == 15 }
	if !stream {
		var x completion
		if json.Unmarshal(all, &x) != nil || len(x.Choices) != 1 || x.Choices[0].Message.Content != "Hello." || !validateUsage(x) {
			return fmt.Errorf("invalid JSON content or usage")
		}
		return nil
	}
	events := []string{}
	for _, line := range strings.Split(string(all), "\n") {
		if strings.HasPrefix(line, "data: ") {
			events = append(events, strings.TrimPrefix(line, "data: "))
		}
	}
	if len(events) != 4 || events[3] != "[DONE]" {
		return fmt.Errorf("invalid SSE event count or DONE")
	}
	var first, middle, last completion
	if json.Unmarshal([]byte(events[1]), &middle) != nil || len(middle.Choices) != 1 || middle.Choices[0].FinishReason == nil || *middle.Choices[0].FinishReason != "stop" {
		return fmt.Errorf("invalid SSE terminal event")
	}
	if json.Unmarshal([]byte(events[0]), &first) != nil || len(first.Choices) != 1 || first.Choices[0].Delta.Content != "Hello." || json.Unmarshal([]byte(events[2]), &last) != nil || !validateUsage(last) {
		return fmt.Errorf("invalid SSE content or usage")
	}
	return nil
}
