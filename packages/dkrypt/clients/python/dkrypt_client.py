from __future__ import annotations

import json
from dataclasses import dataclass
from urllib.error import HTTPError
from urllib.parse import SplitResult, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROUTES = (
    "GET /v1/artifacts",
    "GET /v1/artifacts/{id}",
    "GET /v1/artifacts/{id}/file",
    "GET /v1/decrypt",
    "GET /v1/jobs/{id}",
    "GET /v1/jobs/{id}/wait",
    "POST /v1/decrypts",
    "POST /v1/jobs/status",
    "POST /v1/testflight/decrypt",
)

@dataclass
class DkryptClient:
    base_url: str
    api_key: str | None = None

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

    def follow_job(self, job_id: str):
        while True:
            job = self.wait_for_job(job_id)
            yield job
            if isinstance(job, dict) and job.get("status") in ("done", "failed"):
                return

    def list_artifacts(self, query: str | None = None, limit: int = 100, cursor: str | None = None) -> object:
        from urllib.parse import urlencode
        params = {"limit": max(1, min(100, int(limit)))}
        if query:
            params["q"] = query
        if cursor:
            params["cursor"] = cursor
        return self.request("GET", f"/v1/artifacts?{urlencode(params)}")

    def download_artifact(self, artifact_id: str) -> bytes:
        from urllib.parse import quote
        return self.download(f"/v1/artifacts/{quote(artifact_id, safe='')}/file")

    def _send(self, method: str, path: str, payload: bytes | None, accept: str, extra_headers: dict[str, str] | None = None) -> bytes:
        headers = {"Accept": accept}
        headers.update(extra_headers or {})
        if payload is not None:
            headers["Content-Type"] = "application/json"
        request = Request(self._build_url(path), data=payload, headers=headers, method=method.upper())
        if self.api_key:
            request.add_unredirected_header("Authorization", f"Bearer {self.api_key}")
        try:
            redirect_handler = DkryptRedirectHandler(self._origin(urlsplit(self.base_url)), self.api_key)
            with build_opener(redirect_handler).open(request) as response:
                return response.read()
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"dkrypt request failed with HTTP {error.code}: {detail}") from error

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
