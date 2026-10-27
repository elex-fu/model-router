package main

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"
)

func TestQuotaCompletionProtocol(t *testing.T) {
	json := `{"choices":[{"message":{"content":"Hello."}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`
	first := `data: {"choices":[{"delta":{"content":"Hello."}}]}` + "\n\n"
	middle := `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}` + "\n\n"
	usage := `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}` + "\n\n"
	done := "data: [DONE]\n\n"
	if err := validateCompletion([]byte(json), false); err != nil {
		t.Fatal(err)
	}
	if err := validateCompletion([]byte(first+middle+usage+done), true); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{first + done + usage + done, first + "data: not-json\n\n" + usage + done, first + middle + usage, first + middle + usage + done + done, first + middle + `data: {"usage":{"prompt_tokens":99}}` + "\n\n" + done} {
		if validateCompletion([]byte(invalid), true) == nil {
			t.Fatalf("accepted malformed SSE %q", invalid)
		}
	}
	if validateCompletion([]byte(`{"choices":[{"message":{"content":"Hello."}}]}`), false) == nil {
		t.Fatal("accepted missing usage")
	}
}

func TestDurationOnlyAndFixedCountAdmission(t *testing.T) {
	start := time.Unix(100, 0)
	deadline := start.Add(60 * time.Second)
	if !validWorkload(0, 32, 60*time.Second) || !validWorkload(10000, 200, 0) || !validWorkload(10, 1, 0) {
		t.Fatal("valid bounded workload rejected")
	}
	for _, next := range []int64{1, 100000, 100001, 1000000} {
		if !admitAttempt(next, 0, 60*time.Second, start, deadline) {
			t.Fatal("duration-only mode hit a hidden count cap or zero-request exit")
		}
	}
	if admitAttempt(1, 0, 60*time.Second, deadline, deadline) || admitAttempt(1, 0, 0, start, deadline) {
		t.Fatal("duration-only loop is not time bounded")
	}
	if !admitAttempt(10000, 10000, 0, start, deadline) || admitAttempt(10001, 10000, 0, start, deadline) {
		t.Fatal("fixed count was truncated or exceeded")
	}
	for _, value := range []struct {
		n, c     int
		duration time.Duration
	}{
		{0, 32, 0}, {-1, 32, time.Second}, {0, 32, 61 * time.Second}, {10000, 200, time.Second}, {100001, 32, 0}, {0, 201, time.Second},
	} {
		if validWorkload(value.n, value.c, value.duration) {
			t.Fatal("invalid or double-bounded workload accepted")
		}
	}
}

func TestPartialAttemptJournalRetainsAdmissionAndErrors(t *testing.T) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	if err := recordAttempt(encoder, 1, "admitted", nil); err != nil {
		t.Fatal(err)
	}
	failed := sample{Status: 429, Err: "HTTP 429: capacity", MS: 12}
	if err := recordAttempt(encoder, 1, "completed", &failed); err != nil {
		t.Fatal(err)
	}
	if err := recordAttempt(encoder, 2, "admitted", nil); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(&buffer)
	for index, event := range []string{"admitted", "completed", "admitted"} {
		var row struct {
			Attempt int64
			Event   string
			Sample  *sample
		}
		if err := decoder.Decode(&row); err != nil {
			t.Fatal(err)
		}
		if row.Event != event || row.Attempt != int64(1+index/2) {
			t.Fatal("partial journal sequence lost")
		}
		if event == "completed" && (row.Sample == nil || row.Sample.Err != failed.Err || row.Sample.Status != 429) {
			t.Fatal("failed attempt not retained")
		}
	}
}

func TestAggregateStreamsAllSamplesAndRejectsPartialJournal(t *testing.T) {
	var journal bytes.Buffer
	encoder := json.NewEncoder(&journal)
	for index := int64(1); index <= 3; index++ {
		if err := recordAttempt(encoder, index, "admitted", nil); err != nil {
			t.Fatal(err)
		}
		if err := recordAttempt(encoder, index, "completed", &sample{Status: 429, Err: "overload retained"}); err != nil {
			t.Fatal(err)
		}
	}
	var output bytes.Buffer
	if err := writeAggregate(&output, bytes.NewReader(journal.Bytes()), map[string]any{"requests": 3}, 3); err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Requests int
		Samples  []sample
	}
	if err := json.Unmarshal(output.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Requests != 3 || len(decoded.Samples) != 3 || decoded.Samples[2].Err != "overload retained" {
		t.Fatal("streamed samples lost")
	}
	if err := writeAggregate(&bytes.Buffer{}, bytes.NewReader(journal.Bytes()), map[string]any{}, 4); err == nil {
		t.Fatal("missing admitted work passed")
	}
	if err := writeAggregate(&bytes.Buffer{}, bytes.NewBufferString(`{"event":"admitted"}`), map[string]any{}, 1); err == nil {
		t.Fatal("unfinished attempt passed")
	}
	if err := writeAggregate(&bytes.Buffer{}, bytes.NewBufferString(`{"event":"completed"}`), map[string]any{}, 1); err == nil {
		t.Fatal("missing completion sample passed")
	}
	if err := writeAggregate(&bytes.Buffer{}, bytes.NewBufferString(`not-json`), map[string]any{}, 0); err == nil {
		t.Fatal("corrupt journal passed")
	}
}
