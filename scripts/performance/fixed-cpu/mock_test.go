package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// In-memory handlers only: these tests never bind a socket.
func TestQuotaMockContract(t *testing.T) {
	for _, stream := range []bool{false, true} {
		mock := newMockServer(0, []byte(`{}`))
		body := `{"model":"r9-provider-model-openai","messages":[{"role":"user","content":"bench"}],"stream":false}`
		if stream {
			body = strings.Replace(body, `"stream":false`, `"stream":true`, 1)
		}
		request := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer r9-openai-account-1")
		response := httptest.NewRecorder()
		mock.ServeHTTP(response, request)
		if response.Code != 200 || mock.received.Load() != 1 || mock.completed.Load() != 1 || mock.badRequests.Load() != 0 || mock.inFlight.Load() != 0 {
			t.Fatal("mock accounting mismatch")
		}
		if stream {
			if response.Header().Get("Content-Type") != "text/event-stream" || strings.Count(response.Body.String(), "data: ") != 4 || strings.Count(response.Body.String(), "[DONE]") != 1 {
				t.Fatal("bad SSE")
			}
		} else {
			var result struct {
				Usage struct {
					Input  int `json:"prompt_tokens"`
					Output int `json:"completion_tokens"`
				}
			}
			if json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Usage.Input != 10 || result.Usage.Output != 5 {
				t.Fatal("bad usage")
			}
		}
	}
}
func TestQuotaMockRejectsUnknownCredential(t *testing.T) {
	mock := newMockServer(0, []byte(`{}`))
	request := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"r9-provider-model-openai","messages":[{}]}`))
	response := httptest.NewRecorder()
	mock.ServeHTTP(response, request)
	if response.Code != 401 || mock.completed.Load() != 0 || mock.badRequests.Load() != 1 {
		t.Fatal("unknown credential accepted")
	}
}
