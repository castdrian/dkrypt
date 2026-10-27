package dkrypt

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Channel string

const (
	ChannelAppStore   Channel = "appstore"
	ChannelTestFlight Channel = "testflight"
)

type Client struct {
	BaseURL    string
	APIKey     string
	HTTPClient *http.Client
}

type APIError struct {
	StatusCode int
	Code       string
	RequestID  string
	Message    string
	Retryable  bool
	RetryAfter time.Duration
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("dkrypt request failed with HTTP %d: %s", e.StatusCode, e.Message)
	}
	return fmt.Sprintf("dkrypt request failed with HTTP %d", e.StatusCode)
}

func (e *APIError) RecoveryHint() string {
	message := strings.ToLower(e.Message)
	if strings.Contains(message, "idempotency") && strings.Contains(message, "no longer retained") {
		return "The stored result expired. Submit again with a new idempotency key."
	}
	if strings.Contains(message, "idempotency") {
		return "Reuse the original key with the exact same request, or use a new key for changed request details."
	}
	if strings.Contains(message, "not scoped to this bundle") {
		return "Add this bundle ID to the API key's allowed bundle IDs."
	}
	switch e.Code {
	case "unauthorized":
		return "Create or rotate an API key, then update the key used by this client."
	case "bundle_scope_denied":
		return "Add this bundle ID to the API key's allowed bundle IDs."
	case "daily_decrypt_limit":
		return "Wait for the next available allowance slot. Use Retry-After or remediation.nextAvailableAt."
	case "idempotency_conflict":
		return "Use a new idempotency key for the changed request, or retry the original request unchanged."
	case "idempotency_result_expired":
		return "The original result has expired. Submit a new request with a new idempotency key."
	case "testflight_lookup_failed":
		return "Retry after TestFlight is available. Keep the same idempotency key if a job was already submitted."
	default:
		if e.StatusCode == http.StatusTooManyRequests {
			return "Wait for Retry-After or the rate-limit reset before retrying."
		}
		if e.StatusCode >= 500 {
			return "Retry if the operation is safe and retain the request ID for support."
		}
		if e.StatusCode == http.StatusForbidden {
			return "Check the API key's bundle and TestFlight scopes."
		}
		return "Check the request fields and the error message."
	}
}

type Job struct {
	ID            string   `json:"id"`
	CorrelationID string   `json:"correlationId,omitempty"`
	BundleID      string   `json:"bundleId,omitempty"`
	VersionLabel  string   `json:"versionLabel,omitempty"`
	Channel       string   `json:"channel,omitempty"`
	Status        string   `json:"status"`
	Progress      string   `json:"progress,omitempty"`
	Error         string   `json:"error,omitempty"`
	Warnings      []string `json:"warnings,omitempty"`
	ArtifactID    string   `json:"artifactId,omitempty"`
	ArtifactURL   string   `json:"artifactUrl,omitempty"`
	CacheHit      bool     `json:"cacheHit,omitempty"`
	SizeBytes     int64    `json:"sizeBytes,omitempty"`
	SHA256        string   `json:"sha256,omitempty"`
	CreatedAt     string   `json:"createdAt,omitempty"`
	FinishedAt    string   `json:"finishedAt,omitempty"`
}

type ResolvedRelease struct {
	BundleID        string    `json:"bundleId"`
	Channel         string    `json:"channel"`
	ResolvedVersion string    `json:"resolvedVersion"`
	IsTestFlight    bool      `json:"isTestFlight"`
	Build           string    `json:"build,omitempty"`
	CacheHit        bool      `json:"cacheHit"`
	Artifact        *Artifact `json:"artifact,omitempty"`
}

type TestFlightBuild struct {
	ID                   int64  `json:"id"`
	CFBundleShortVersion string `json:"cfBundleShortVersion"`
	CFBundleVersion      string `json:"cfBundleVersion"`
	BundleID             string `json:"bundleId"`
}

type TestFlightDecryptRequest struct {
	BundleID string
	AppID    int64
	Build    TestFlightBuild
}

type JobStatusBatchEntry struct {
	ID    string `json:"id"`
	State string `json:"state"`
	Job   *Job   `json:"job,omitempty"`
}

type JobStatusBatch struct {
	Jobs []JobStatusBatchEntry `json:"jobs"`
}

type Artifact struct {
	ID             string `json:"id"`
	BundleID       string `json:"bundleId"`
	Channel        string `json:"channel,omitempty"`
	VersionLabel   string `json:"versionLabel,omitempty"`
	BuildNumber    string `json:"buildNumber,omitempty"`
	SizeBytes      int64  `json:"sizeBytes"`
	SHA256         string `json:"sha256"`
	FileURL        string `json:"fileUrl,omitempty"`
	CreatedAt      string `json:"createdAt,omitempty"`
	LastAccessedAt string `json:"lastAccessedAt,omitempty"`
}

type ArtifactPage struct {
	Artifacts  []Artifact `json:"artifacts"`
	Total      int        `json:"total"`
	TotalBytes int64      `json:"totalBytes,omitempty"`
	MaxBytes   int64      `json:"maxBytes,omitempty"`
	NextCursor string     `json:"nextCursor,omitempty"`
}

type ArtifactOptions struct {
	Query   string
	Channel Channel
	Limit   int
	Cursor  string
}

func (c *Client) call(ctx context.Context, method, requestPath string, body any, idempotencyKey, accept string) (*http.Response, error) {
	return c.callWithHeaders(ctx, method, requestPath, body, idempotencyKey, accept, nil)
}

func (c *Client) callWithHeaders(ctx context.Context, method, requestPath string, body any, idempotencyKey, accept string, headers http.Header) (*http.Response, error) {
	base, err := parseBaseURL(c.BaseURL)
	if err != nil {
		return nil, err
	}
	target, err := base.Parse(requestPath)
	if err != nil || target.Host != base.Host || target.Scheme != base.Scheme {
		return nil, errors.New("dkrypt requests must use the configured origin")
	}
	var payload io.Reader
	if body != nil {
		encoded, marshalErr := json.Marshal(body)
		if marshalErr != nil {
			return nil, marshalErr
		}
		payload = bytes.NewReader(encoded)
	}
	client := c.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	request, err := http.NewRequestWithContext(ctx, method, target.String(), payload)
	if err != nil {
		return nil, err
	}
	if accept == "" {
		accept = "application/json"
	}
	request.Header.Set("Accept", accept)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if c.APIKey != "" {
		request.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	if idempotencyKey != "" {
		request.Header.Set("Idempotency-Key", idempotencyKey)
	}
	for name, values := range headers {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		response.Body.Close()
		return nil, decodeAPIError(response, detail)
	}
	return response, nil
}

func (c *Client) request(ctx context.Context, method, requestPath string, body any, idempotencyKey string, output any) error {
	response, err := c.call(ctx, method, requestPath, body, idempotencyKey, "application/json")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if output == nil {
		_, err = io.Copy(io.Discard, response.Body)
		return err
	}
	return json.NewDecoder(response.Body).Decode(output)
}

func decodeAPIError(response *http.Response, detail []byte) *APIError {
	var payload struct {
		Code      string `json:"code"`
		RequestID string `json:"requestId"`
		Message   string `json:"message"`
		Error     string `json:"error"`
		Retryable bool   `json:"retryable"`
	}
	_ = json.Unmarshal(detail, &payload)
	message := payload.Message
	if message == "" {
		message = payload.Error
	}
	if message == "" {
		message = strings.TrimSpace(string(detail))
	}
	retryAfter := time.Duration(0)
	if value := response.Header.Get("Retry-After"); value != "" {
		if seconds, err := strconv.Atoi(value); err == nil {
			retryAfter = time.Duration(seconds) * time.Second
		} else if retryAt, err := http.ParseTime(value); err == nil {
			retryAfter = max(time.Until(retryAt), 0)
		}
	}
	return &APIError{
		StatusCode: response.StatusCode,
		Code:       payload.Code,
		RequestID:  payload.RequestID,
		Message:    message,
		Retryable:  payload.Retryable || response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500,
		RetryAfter: retryAfter,
	}
}

func (c *Client) Decrypt(ctx context.Context, bundleID, version, idempotencyKey string) (Job, error) {
	return c.DecryptRelease(ctx, bundleID, version, ChannelAppStore, idempotencyKey)
}

func (c *Client) DecryptLatestTestFlight(ctx context.Context, bundleID, idempotencyKey string) (Job, error) {
	return c.DecryptRelease(ctx, bundleID, "", ChannelTestFlight, idempotencyKey)
}

func (c *Client) DecryptRelease(ctx context.Context, bundleID, version string, channel Channel, idempotencyKey string) (Job, error) {
	if channel == "" {
		channel = ChannelAppStore
	}
	if channel != ChannelAppStore && channel != ChannelTestFlight {
		return Job{}, errors.New("channel must be appstore or testflight")
	}
	if idempotencyKey == "" {
		var err error
		idempotencyKey, err = newIdempotencyKey()
		if err != nil {
			return Job{}, err
		}
	}
	body := map[string]any{"bundleId": bundleID, "channel": channel}
	if version != "" {
		body["version"] = version
	}
	var result Job
	err := c.request(ctx, http.MethodPost, "/v1/decrypts", body, idempotencyKey, &result)
	return result, err
}

func (c *Client) ResolveRelease(ctx context.Context, bundleID, version string, channel Channel) (ResolvedRelease, error) {
	if channel == "" {
		channel = ChannelAppStore
	}
	if channel != ChannelAppStore && channel != ChannelTestFlight {
		return ResolvedRelease{}, errors.New("channel must be appstore or testflight")
	}
	body := map[string]any{"bundleId": bundleID, "channel": channel, "resolveOnly": true}
	if version != "" {
		body["version"] = version
	}
	var result ResolvedRelease
	err := c.request(ctx, http.MethodPost, "/v1/decrypts", body, "", &result)
	return result, err
}

func (c *Client) DecryptTestFlightBuild(ctx context.Context, input TestFlightDecryptRequest, idempotencyKey string) (Job, error) {
	if idempotencyKey == "" {
		var err error
		idempotencyKey, err = newIdempotencyKey()
		if err != nil {
			return Job{}, err
		}
	}
	body := map[string]any{"bundleId": input.BundleID, "appId": input.AppID, "build": input.Build}
	var result Job
	err := c.request(ctx, http.MethodPost, "/v1/testflight/decrypt", body, idempotencyKey, &result)
	return result, err
}

func newIdempotencyKey() (string, error) {
	var token [16]byte
	if _, err := rand.Read(token[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(token[:]), nil
}

func parseBaseURL(value string) (*url.URL, error) {
	base, err := url.Parse(value)
	if err != nil || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" || (base.Path != "" && base.Path != "/") || (base.Scheme != "https" && base.Scheme != "http") {
		return nil, errors.New("invalid dkrypt base URL")
	}
	localHost := strings.EqualFold(base.Hostname(), "localhost") || base.Hostname() == "127.0.0.1" || base.Hostname() == "::1"
	if base.Scheme == "http" && !localHost {
		return nil, errors.New("Use an HTTPS dkrypt URL; HTTP is allowed only for localhost")
	}
	return base, nil
}

func (c *Client) GetJob(ctx context.Context, id string) (Job, error) {
	var result Job
	err := c.request(ctx, http.MethodGet, "/v1/jobs/"+url.PathEscape(id), nil, "", &result)
	return result, err
}

func (c *Client) WaitForJob(ctx context.Context, id string) (Job, error) {
	for {
		path := "/v1/jobs/" + url.PathEscape(id) + "/wait?timeoutSeconds=25"
		var result Job
		if err := c.request(ctx, http.MethodGet, path, nil, "", &result); err != nil {
			return Job{}, err
		}
		if result.Status == "done" || result.Status == "failed" {
			return result, nil
		}
	}
}

func (c *Client) GetJobStatusBatch(ctx context.Context, ids []string) (JobStatusBatch, error) {
	if len(ids) == 0 || len(ids) > 100 {
		return JobStatusBatch{}, errors.New("job status batches must contain between 1 and 100 IDs")
	}
	var result JobStatusBatch
	err := c.request(ctx, http.MethodPost, "/v1/jobs/status", map[string][]string{"ids": ids}, "", &result)
	return result, err
}

func (c *Client) OpenJobEvents(ctx context.Context, id, lastEventID string) (io.ReadCloser, error) {
	requestPath := "/v1/jobs/" + url.PathEscape(id) + "/events"
	headers := make(http.Header)
	if lastEventID != "" {
		headers.Set("Last-Event-ID", lastEventID)
	}
	response, err := c.callWithHeaders(ctx, http.MethodGet, requestPath, nil, "", "text/event-stream", headers)
	if err != nil {
		return nil, err
	}
	return response.Body, nil
}

func (c *Client) GetArtifact(ctx context.Context, id string) (Artifact, error) {
	var result Artifact
	err := c.request(ctx, http.MethodGet, "/v1/artifacts/"+url.PathEscape(id), nil, "", &result)
	return result, err
}

func (c *Client) ListArtifacts(ctx context.Context, query string, limit int, cursor string) (ArtifactPage, error) {
	return c.ListArtifactsWithOptions(ctx, ArtifactOptions{Query: query, Limit: limit, Cursor: cursor})
}

func (c *Client) ListArtifactsWithOptions(ctx context.Context, options ArtifactOptions) (ArtifactPage, error) {
	limit := options.Limit
	if limit < 1 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}
	params := url.Values{"limit": []string{fmt.Sprint(limit)}}
	if options.Query != "" {
		params.Set("q", options.Query)
	}
	if options.Channel != "" {
		if options.Channel != ChannelAppStore && options.Channel != ChannelTestFlight {
			return ArtifactPage{}, errors.New("channel must be appstore or testflight")
		}
		params.Set("channel", string(options.Channel))
	}
	if options.Cursor != "" {
		params.Set("cursor", options.Cursor)
	}
	var result ArtifactPage
	err := c.request(ctx, http.MethodGet, "/v1/artifacts?"+params.Encode(), nil, "", &result)
	return result, err
}

func (c *Client) DownloadArtifact(ctx context.Context, id string) ([]byte, error) {
	artifact, err := c.GetArtifact(ctx, id)
	if err != nil {
		return nil, err
	}
	requestPath := artifact.FileURL
	if requestPath == "" {
		requestPath = "/v1/artifacts/" + url.PathEscape(id) + "/file"
	}
	response, err := c.call(ctx, http.MethodGet, requestPath, nil, "", "application/octet-stream")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != artifact.SizeBytes {
		return nil, fmt.Errorf("IPA size mismatch: dkrypt reports %d bytes, downloaded %d", artifact.SizeBytes, len(data))
	}
	expectedHash := strings.ToLower(artifact.SHA256)
	if len(expectedHash) != 64 {
		return nil, errors.New("dkrypt returned invalid SHA-256 metadata")
	}
	actualHash := sha256.Sum256(data)
	if hex.EncodeToString(actualHash[:]) != expectedHash {
		return nil, errors.New("IPA SHA-256 did not match dkrypt metadata")
	}
	return data, nil
}
