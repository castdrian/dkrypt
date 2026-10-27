package dkrypt

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDecryptUsesConfiguredOriginAndIdempotency(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		if request.URL.Path != "/v1/decrypts" {
			t.Fatalf("unexpected path: %s", request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer test-key" {
			t.Fatal("API key was not sent")
		}
		if request.Header.Get("Idempotency-Key") != "stable-key" {
			t.Fatal("idempotency key was not sent")
		}
		var body map[string]string
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["bundleId"] != "com.example.app" {
			t.Fatalf("unexpected request body: %v", body)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte("{\"id\":\"job-1\",\"status\":\"queued\"}"))
	}))
	defer server.Close()
	client := Client{BaseURL: server.URL, APIKey: "test-key"}
	job, err := client.Decrypt(context.Background(), "com.example.app", "", "stable-key")
	if err != nil {
		t.Fatal(err)
	}
	if job.ID != "job-1" || job.Status != "queued" || requests != 1 {
		t.Fatalf("unexpected result: %+v, requests=%d", job, requests)
	}
}

func TestRemoteHTTPBaseURLIsRejected(t *testing.T) {
	client := Client{BaseURL: "http://dkrypt.example", APIKey: "test-key"}
	_, err := client.GetJob(context.Background(), "job-1")
	if err == nil || err.Error() != "Use an HTTPS dkrypt URL; HTTP is allowed only for localhost" {
		t.Fatalf("expected remote HTTP to be rejected, got %v", err)
	}
}

func TestListArtifactsEncodesFiltersAndClampsLimits(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Get("q") != "A & B" || request.URL.Query().Get("cursor") != "cursor/one" || request.URL.Query().Get("limit") != "100" {
			t.Fatalf("unexpected query: %s", request.URL.RawQuery)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte("{\"artifacts\":[],\"nextCursor\":\"next\"}"))
	}))
	defer server.Close()
	client := Client{BaseURL: server.URL}
	page, err := client.ListArtifacts(context.Background(), "A & B", 500, "cursor/one")
	if err != nil {
		t.Fatal(err)
	}
	if page.NextCursor != "next" {
		t.Fatalf("unexpected page: %+v", page)
	}
}

func TestDownloadArtifactVerifiesReportedSizeAndSHA256(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer test-key" {
			t.Fatal("API key was not sent")
		}
		if request.URL.Path == "/v1/artifacts/artifact-1" {
			response.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(response).Encode(Artifact{
				ID:        "artifact-1",
				BundleID:  "com.example.app",
				SizeBytes: 8,
				SHA256:    "b03bf2df109ea271d397c2d07f9d067d52079b6007063e4fd069eb3a561ef77d",
				FileURL:   "/v1/artifacts/artifact-1/file",
			})
			return
		}
		if request.URL.Path != "/v1/artifacts/artifact-1/file" {
			t.Fatalf("unexpected path: %s", request.URL.Path)
		}
		_, _ = response.Write([]byte("ipa-data"))
	}))
	defer server.Close()
	client := Client{BaseURL: server.URL, APIKey: "test-key"}
	data, err := client.DownloadArtifact(context.Background(), "artifact-1")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "ipa-data" {
		t.Fatalf("unexpected file data: %s", data)
	}
}
