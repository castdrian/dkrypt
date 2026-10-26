use reqwest::{Client, Method, Response, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::error::Error;

#[derive(Clone)]
pub struct DkryptClient {
    base_url: Url,
    api_key: Option<String>,
    http: Client,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub status: String,
    pub progress: Option<String>,
    pub error: Option<String>,
    pub artifact_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub bundle_id: String,
    pub version_label: Option<String>,
    pub file_size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPage {
    pub artifacts: Vec<Artifact>,
    pub next_cursor: Option<String>,
}

impl DkryptClient {
    pub fn new(base_url: &str, api_key: Option<String>) -> Result<Self, Box<dyn Error + Send + Sync>> {
        let base_url = Url::parse(base_url)?;
        let host = base_url.host_str().unwrap_or_default();
        let allows_http = ["localhost", "127.0.0.1", "::1"].contains(&host);
        if !["http", "https"].contains(&base_url.scheme()) || host.is_empty() { return Err("invalid dkrypt base URL".into()); }
        if base_url.scheme() == "http" && !allows_http { return Err("Use an HTTPS dkrypt URL; HTTP is allowed only for localhost".into()); }
        Ok(Self { base_url, api_key, http: Client::new() })
    }

    fn url(&self, path: &str) -> Result<Url, Box<dyn Error + Send + Sync>> {
        let target = self.base_url.join(path)?;
        if target.origin() != self.base_url.origin() { return Err("dkrypt requests must use the configured origin".into()); }
        Ok(target)
    }

    async fn send(&self, method: Method, path: &str, body: Option<Value>, idempotency_key: Option<&str>) -> Result<Response, Box<dyn Error + Send + Sync>> {
        let mut request = self.http.request(method, self.url(path)?).header("Accept", "application/json");
        if let Some(key) = &self.api_key { request = request.bearer_auth(key); }
        if let Some(key) = idempotency_key { request = request.header("Idempotency-Key", key); }
        if let Some(body) = body { request = request.json(&body); }
        let response = request.send().await?;
        if !response.status().is_success() { let status = response.status(); let detail = response.text().await.unwrap_or_default(); return Err(format!("dkrypt request failed with HTTP {status}: {detail}").into()); }
        Ok(response)
    }

    pub async fn decrypt(&self, bundle_id: &str, version: Option<&str>, idempotency_key: &str) -> Result<Job, Box<dyn Error + Send + Sync>> {
        let mut body = json!({"bundleId": bundle_id});
        if let Some(version) = version { body["version"] = json!(version); }
        Ok(self.send(Method::POST, "/v1/decrypts", Some(body), Some(idempotency_key)).await?.json().await?)
    }

    pub async fn get_job(&self, id: &str) -> Result<Job, Box<dyn Error + Send + Sync>> {
        let path = format!("/v1/jobs/{}", encode_path_component(id));
        Ok(self.send(Method::GET, &path, None, None).await?.json().await?)
    }

    pub async fn list_artifacts(&self, query: Option<&str>, limit: usize, cursor: Option<&str>) -> Result<ArtifactPage, Box<dyn Error + Send + Sync>> {
        let mut url = self.url("/v1/artifacts")?;
        { let mut params = url.query_pairs_mut(); params.append_pair("limit", &limit.clamp(1, 100).to_string()); if let Some(query) = query { params.append_pair("q", query); } if let Some(cursor) = cursor { params.append_pair("cursor", cursor); } }
        let path = url.path().to_string() + "?" + url.query().unwrap_or_default();
        Ok(self.send(Method::GET, &path, None, None).await?.json().await?)
    }

    pub async fn download_artifact(&self, id: &str) -> Result<Vec<u8>, Box<dyn Error + Send + Sync>> {
        let path = format!("/v1/artifacts/{}/file", encode_path_component(id));
        let mut request = self.http.get(self.url(&path)?).header("Accept", "application/octet-stream");
        if let Some(key) = &self.api_key { request = request.bearer_auth(key); }
        let response = request.send().await?;
        if !response.status().is_success() { let status = response.status(); let detail = response.text().await.unwrap_or_default(); return Err(format!("dkrypt download failed with HTTP {status}: {detail}").into()); }
        Ok(response.bytes().await?.to_vec())
    }
}

fn encode_path_component(value: &str) -> String {
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) { result.push(byte as char); }
        else { result.push_str(&format!("%{byte:02X}")); }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::DkryptClient;

    #[test]
    fn client_rejects_requests_to_a_different_origin() {
        let client = DkryptClient::new("https://dkrypt.example", None).expect("valid base URL");
        assert!(client.url("https://attacker.example/v1/jobs").is_err());
        assert!(client.url("//attacker.example/v1/jobs").is_err());
    }

    #[test]
    fn client_allows_plain_http_only_for_localhost() {
        assert!(DkryptClient::new("http://localhost:3000", None).is_ok());
        assert!(DkryptClient::new("http://127.0.0.1:3000", None).is_ok());
        assert!(DkryptClient::new("http://dkrypt.example", None).is_err());
    }
}
