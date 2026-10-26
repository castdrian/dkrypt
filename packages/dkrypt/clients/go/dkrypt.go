package dkrypt

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

type Client struct {
	BaseURL string
	APIKey string
	HTTPClient *http.Client
}

type Job struct {
	ID string `json:"id"`
	Status string `json:"status"`
	Progress string `json:"progress,omitempty"`
	Error string `json:"error,omitempty"`
	ArtifactID string `json:"artifactId,omitempty"`
}

type Artifact struct {
	ID string `json:"id"`
	BundleID string `json:"bundleId"`
	VersionLabel string `json:"versionLabel,omitempty"`
	FileSizeBytes int64 `json:"fileSizeBytes,omitempty"`
}

type ArtifactPage struct {
	Artifacts []Artifact `json:"artifacts"`
	NextCursor string `json:"nextCursor,omitempty"`
}

func (c *Client) request(ctx context.Context, method, requestPath string, body any, idempotencyKey string, output any) error {
	base, err := parseBaseURL(c.BaseURL)
	if err != nil { return err }
	target, err := base.Parse(requestPath)
	if err != nil || target.Host != base.Host || target.Scheme != base.Scheme {
		return fmt.Errorf("dkrypt requests must use the configured origin")
	}
	var payload io.Reader
	if body != nil {
		encoded, marshalErr := json.Marshal(body)
		if marshalErr != nil { return marshalErr }
		payload = bytes.NewReader(encoded)
	}
	client := c.HTTPClient
	if client == nil { client = http.DefaultClient }
	request, err := http.NewRequestWithContext(ctx, method, target.String(), payload)
	if err != nil { return err }
	request.Header.Set("Accept", "application/json")
	if body != nil { request.Header.Set("Content-Type", "application/json") }
	if c.APIKey != "" { request.Header.Set("Authorization", "Bearer "+c.APIKey) }
	if idempotencyKey != "" { request.Header.Set("Idempotency-Key", idempotencyKey) }
	response, err := client.Do(request)
	if err != nil { return err }
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("dkrypt request failed with HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(detail)))
	}
	if output == nil { _, err = io.Copy(io.Discard, response.Body); return err }
	return json.NewDecoder(response.Body).Decode(output)
}

func (c *Client) Decrypt(ctx context.Context, bundleID, version, idempotencyKey string) (Job, error) {
	if idempotencyKey == "" { var token [16]byte; if _, err := rand.Read(token[:]); err != nil { return Job{}, err }; idempotencyKey = hex.EncodeToString(token[:]) }
	body := map[string]string{"bundleId": bundleID}
	if version != "" { body["version"] = version }
	var result Job
	err := c.request(ctx, http.MethodPost, "/v1/decrypts", body, idempotencyKey, &result)
	return result, err
}

func parseBaseURL(value string) (*url.URL, error) {
	base, err := url.Parse(value)
	if err != nil || base.Host == "" || (base.Scheme != "https" && base.Scheme != "http") {
		return nil, fmt.Errorf("invalid dkrypt base URL")
	}
	localHost := strings.EqualFold(base.Hostname(), "localhost") || base.Hostname() == "127.0.0.1" || base.Hostname() == "::1"
	if base.Scheme == "http" && !localHost {
		return nil, fmt.Errorf("Use an HTTPS dkrypt URL; HTTP is allowed only for localhost")
	}
	return base, nil
}

func (c *Client) GetJob(ctx context.Context, id string) (Job, error) {
	var result Job
	err := c.request(ctx, http.MethodGet, "/v1/jobs/"+url.PathEscape(id), nil, "", &result)
	return result, err
}

func (c *Client) ListArtifacts(ctx context.Context, query string, limit int, cursor string) (ArtifactPage, error) {
	if limit < 1 { limit = 1 }; if limit > 100 { limit = 100 }
	params := url.Values{"limit": []string{fmt.Sprint(limit)}}
	if query != "" { params.Set("q", query) }; if cursor != "" { params.Set("cursor", cursor) }
	var result ArtifactPage
	err := c.request(ctx, http.MethodGet, "/v1/artifacts?"+params.Encode(), nil, "", &result)
	return result, err
}

func (c *Client) DownloadArtifact(ctx context.Context, id string) ([]byte, error) {
	base, err := parseBaseURL(c.BaseURL)
	if err != nil { return nil, err }
	target, err := base.Parse("/v1/artifacts/"+url.PathEscape(id)+"/file")
	if err != nil || target.Host != base.Host || target.Scheme != base.Scheme { return nil, fmt.Errorf("dkrypt requests must use the configured origin") }
	client := c.HTTPClient; if client == nil { client = http.DefaultClient }
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil); if err != nil { return nil, err }
	request.Header.Set("Accept", "application/octet-stream"); if c.APIKey != "" { request.Header.Set("Authorization", "Bearer "+c.APIKey) }
	response, err := client.Do(request); if err != nil { return nil, err }; defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 { detail, _ := io.ReadAll(io.LimitReader(response.Body, 4096)); return nil, fmt.Errorf("dkrypt download failed with HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(detail))) }
	return io.ReadAll(response.Body)
}
