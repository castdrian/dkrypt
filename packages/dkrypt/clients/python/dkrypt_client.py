from __future__ import annotations

import json
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from time import sleep
from urllib.error import HTTPError, URLError
from urllib.parse import SplitResult, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROUTES = (
    "GET /v1/artifacts",
    "GET /v1/artifacts/{id}",
    "GET /v1/artifacts/{id}/file",
    "GET /v1/decrypt",
    "GET /v1/jobs/{id}",
    "GET /v1/jobs/{id}/events",
    "GET /v1/jobs/{id}/wait",
    "POST /v1/decrypts",
    "POST /v1/jobs/status",
    "POST /v1/testflight/decrypt",
)

@dataclass
class DkryptClient:
    base_url: str
    api_key: str | None = None
    retry_attempts: int = 3
    retry_base_delay: float = 0.25
    retry_max_delay: float = 30.0

    def request(self, method: str, path: str, body: object | None = None) -> object:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        response = self._send(method, path, payload, "application/json")
        return json.loads(response.decode("utf-8"))

    def download(self, path: str) -> bytes:
        return self._send("GET", path, None, "application/octet-stream")

    def decrypt(self, bundle_id: str, version: str | None = None, idempotency_key: str | None = None) -> object:
        from uuid import uuid4
        headers = {"Idempotency-Key": idempotency_key or str(uuid4())}
        body = {"bundleId": bundle_id}
        if version:
            body["version"] = version
        payload = json.dumps(body).encode("utf-8")
        return json.loads(self._send("POST", "/v1/decrypts", payload, "application/json", headers).decode("utf-8"))

    def get_job(self, job_id: str) -> object:
        from urllib.parse import quote
        return self.request("GET", f"/v1/jobs/{quote(job_id, safe='')}")

    def wait_for_job(self, job_id: str, timeout_seconds: int = 25) -> object:
        from urllib.parse import quote
        from urllib.parse import urlencode
        timeout = max(1, min(25, int(timeout_seconds)))
        return self.request("GET", f"/v1/jobs/{quote(job_id, safe='')}/wait?{urlencode({'timeoutSeconds': timeout})}")

    def iter_job_events(self, job_id: str):
        from urllib.parse import quote
        last_event_id = None
        reconnect_delay_seconds = 0.25
        while True:
            headers = {"Accept": "text/event-stream"}
            if last_event_id:
                headers["Last-Event-ID"] = last_event_id
            url = self._build_url(f"/v1/jobs/{quote(job_id, safe='')}/events")
            attempts = max(1, min(5, int(self.retry_attempts)))
            for attempt in range(attempts):
                request = Request(url, headers=headers, method="GET")
                if self.api_key:
                    request.add_unredirected_header("Authorization", f"Bearer {self.api_key}")
                try:
                    handler = DkryptRedirectHandler(self._origin(urlsplit(self.base_url)), self.api_key)
                    with build_opener(handler).open(request, timeout=35) as response:
                        current = {"event": "message", "id": None, "data": []}
                        for raw_line in response:
                            line = raw_line.decode("utf-8") if isinstance(raw_line, bytes) else raw_line
                            line = line.rstrip("\r\n")
                            if not line:
                                if current["event"] == "snapshot" and current["data"]:
                                    snapshot = json.loads("\n".join(current["data"]))
                                    if current["id"]:
                                        last_event_id = current["id"]
                                    yield snapshot
                                    job = snapshot.get("job", {}) if isinstance(snapshot, dict) else {}
                                    if isinstance(job, dict) and job.get("status") in ("done", "failed"):
                                        return
                                current = {"event": "message", "id": None, "data": []}
                                continue
                            if line.startswith(":"):
                                continue
                            field, separator, value = line.partition(":")
                            if separator and value.startswith(" "):
                                value = value[1:]
                            if field == "event":
                                current["event"] = value
                            elif field == "id" and "\0" not in value:
                                current["id"] = value
                            elif field == "data":
                                current["data"].append(value)
                            elif field == "retry" and value.isdecimal():
                                reconnect_delay_seconds = min(30.0, int(value) / 1000)
                    break
                except HTTPError as error:
                    if attempt + 1 < attempts and error.code in (429, 502, 503, 504):
                        delay = self._retry_after(error.headers.get("Retry-After"))
                        error.close()
                        sleep(self._retry_delay(attempt) if delay is None else delay)
                        continue
                    detail = error.read().decode("utf-8", errors="replace")
                    raise RuntimeError(f"dkrypt request failed with HTTP {error.code}: {detail}") from error
                except URLError:
                    if attempt + 1 >= attempts:
                        break
                    sleep(self._retry_delay(attempt))
            sleep(reconnect_delay_seconds)

    def follow_job(self, job_id: str):
        for snapshot in self.iter_job_events(job_id):
            if isinstance(snapshot, dict) and isinstance(snapshot.get("job"), dict):
                yield snapshot["job"]

    def list_artifacts(self, query: str | None = None, limit: int = 100, cursor: str | None = None) -> object:
        from urllib.parse import urlencode
        params = {"limit": max(1, min(100, int(limit)))}
        if query:
            params["q"] = query
        if cursor:
            params["cursor"] = cursor
        return self.request("GET", f"/v1/artifacts?{urlencode(params)}")

    def iter_artifacts(self, query: str | None = None, limit: int = 100, cursor: str | None = None):
        seen_cursors = set()
        while True:
            page = self.list_artifacts(query, limit, cursor)
            if not isinstance(page, dict):
                raise RuntimeError("dkrypt artifact page has an invalid response")
            yield from page.get("artifacts", [])
            next_cursor = page.get("nextCursor")
            if not next_cursor:
                return
            if next_cursor in seen_cursors:
                raise RuntimeError("dkrypt artifact pagination returned a repeated cursor")
            seen_cursors.add(next_cursor)
            cursor = next_cursor

    def list_all_artifacts(self, query: str | None = None, limit: int = 100, cursor: str | None = None) -> list[object]:
        return list(self.iter_artifacts(query, limit, cursor))

    def download_artifact(self, artifact_id: str) -> bytes:
        from urllib.parse import quote
        return self.download(f"/v1/artifacts/{quote(artifact_id, safe='')}/file")

    def _send(self, method: str, path: str, payload: bytes | None, accept: str, extra_headers: dict[str, str] | None = None) -> bytes:
        headers = {"Accept": accept}
        headers.update(extra_headers or {})
        if payload is not None:
            headers["Content-Type"] = "application/json"
        url = self._build_url(path)
        normalized_method = method.upper()
        safe_to_retry = normalized_method in ("GET", "HEAD", "OPTIONS") or any(name.lower() == "idempotency-key" for name in headers)
        attempts = max(1, min(5, int(self.retry_attempts))) if safe_to_retry else 1
        for attempt in range(attempts):
            request = Request(url, data=payload, headers=headers, method=normalized_method)
            if self.api_key:
                request.add_unredirected_header("Authorization", f"Bearer {self.api_key}")
            try:
                redirect_handler = DkryptRedirectHandler(self._origin(urlsplit(self.base_url)), self.api_key)
                with build_opener(redirect_handler).open(request) as response:
                    return response.read()
            except HTTPError as error:
                if attempt + 1 < attempts and error.code in (429, 502, 503, 504):
                    delay = self._retry_after(error.headers.get("Retry-After"))
                    error.close()
                    sleep(self._retry_delay(attempt) if delay is None else delay)
                    continue
                detail = error.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"dkrypt request failed with HTTP {error.code}: {detail}") from error
            except URLError:
                if attempt + 1 >= attempts:
                    raise
                sleep(self._retry_delay(attempt))
        raise RuntimeError("dkrypt request could not be completed")

    def _retry_delay(self, attempt: int) -> float:
        return min(max(0.0, self.retry_max_delay), max(0.0, self.retry_base_delay) * (2 ** attempt))

    def _retry_after(self, value: str | None) -> float | None:
        if value is None:
            return None
        try:
            return min(30.0, max(0.0, float(value)))
        except ValueError:
            try:
                from datetime import datetime, timezone
                return min(30.0, max(0.0, (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds()))
            except (TypeError, ValueError, OverflowError):
                return None

    def _build_url(self, path: str) -> str:
        base_url = self.base_url.rstrip("/") + "/"
        request_url = urljoin(base_url, path)
        base = urlsplit(base_url)
        target = urlsplit(request_url)
        if (
            target.scheme.lower() not in ("http", "https")
            or target.username is not None
            or target.password is not None
            or self._origin(base) != self._origin(target)
        ):
            raise ValueError("dkrypt requests must use the configured origin")
        return request_url

    @staticmethod
    def _origin(url: SplitResult) -> tuple[str, str | None, int]:
        scheme = url.scheme.lower()
        default_port = 443 if scheme == "https" else 80
        port = url.port
        return scheme, url.hostname, default_port if port is None else port

class DkryptRedirectHandler(HTTPRedirectHandler):
    def __init__(self, origin: tuple[str, str | None, int], api_key: str | None):
        super().__init__()
        self.origin = origin
        self.api_key = api_key

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        target = urlsplit(newurl)
        if (
            redirected is not None
            and self.api_key
            and target.username is None
            and target.password is None
            and DkryptClient._origin(target) == self.origin
        ):
            redirected.add_unredirected_header("Authorization", f"Bearer {self.api_key}")
        return redirected
