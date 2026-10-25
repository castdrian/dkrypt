use crate::client::AppleClient;
use crate::error::{ClientError, StoreError};
use crate::model::Account;
use base64::Engine as _;
use futures_util::StreamExt;
use indicatif::{ProgressBar, ProgressStyle};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use url::Url;
#[derive(Debug, Deserialize)]
pub struct DownloadItem {
    #[serde(rename = "URL")]
    pub url: String,
    pub sinfs: Vec<Sinf>,
    #[serde(default)]
    pub metadata: HashMap<String, plist::Value>,
}
impl DownloadItem {
    pub fn latest_external_version_id(&self) -> Option<String> {
        metadata_string(
            &self.metadata,
            &[
                "softwareVersionExternalIdentifier",
                "externalVersionIdentifier",
            ],
        )
    }
}
#[derive(Debug, Clone, Deserialize)]
pub struct Sinf {
    pub id: i64,
    #[serde(with = "serde_bytes")]
    pub sinf: Vec<u8>,
}
mod serde_bytes {
    use serde::{Deserialize, Deserializer};
    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let val = plist::Value::deserialize(deserializer)?;
        match val {
            plist::Value::Data(d) => Ok(d),
            _ => Err(serde::de::Error::custom("expected data")),
        }
    }
}
const MAX_DOWNLOAD_ATTEMPTS: u32 = 3;
const CATALOG_VERSION_LOOKUP_ATTEMPTS: usize = 3;
const CATALOG_VERSION_LOOKUP_TIMEOUT: Duration = Duration::from_secs(10);
const ENT_DOWNLOAD_PATH: &str = "/WebObjects/DownloadDispatch.woa/wa/ent/download";
pub async fn get_download_info(
    client: &AppleClient,
    app_id: i64,
    bundle_id: &str,
    account: &Account,
    external_version_id: Option<&str>,
) -> Result<DownloadItem, ClientError> {
    for attempt in 0..MAX_DOWNLOAD_ATTEMPTS {
        match try_get_download_info(client, app_id, bundle_id, account, external_version_id).await {
            Err(ClientError::Store(StoreError::TemporarilyUnavailable))
                if attempt + 1 < MAX_DOWNLOAD_ATTEMPTS =>
            {
                let delay = 5 * (attempt as u64 + 1);
                tracing::warn!(
                    attempt = attempt + 1,
                    delay,
                    "temporarily unavailable, retrying"
                );
                tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
            }
            other => return other,
        }
    }
    Err(ClientError::Store(StoreError::TemporarilyUnavailable))
}
async fn try_get_download_info(
    client: &AppleClient,
    app_id: i64,
    bundle_id: &str,
    account: &Account,
    external_version_id: Option<&str>,
) -> Result<DownloadItem, ClientError> {
    if let Ok(endpoints) = crate::api::bag::fetch_download_endpoints(client).await
        && let Some(endpoint) = endpoints.ent_download
    {
        match get_ent_download_info(
            client,
            &endpoint,
            app_id,
            bundle_id,
            account,
            external_version_id,
        )
        .await
        {
            Ok(item) => return Ok(item),
            Err(error) if should_try_legacy_download(&error) => {
                tracing::warn!(
                    "Apple ent/download path was unavailable; trying the legacy download path"
                );
            }
            Err(error @ ClientError::Store(_))
            | Err(error @ ClientError::SapSignatureRequired { .. }) => return Err(error),
            Err(error) => return Err(stage_download_error(error, "ent_download")),
        }
    }
    let url = download_url(account, client.guid());
    let body_bytes = download_info_request_body(
        app_id,
        client.guid(),
        external_version_id,
        DownloadVersionKey::ExternalVersionId,
    )?;
    let (status, mut dict) = post_download_info(client, account, &url, &body_bytes).await?;
    if status != reqwest::StatusCode::OK && StoreError::from_plist_dict(&dict).is_none() {
        return Err(ClientError::UnexpectedResponse(
            "download_info_http_failed".into(),
        ));
    }
    if needs_download_dispatch_retry(status, &dict) {
        dict = retry_download_dispatch(client, account, app_id, bundle_id, external_version_id)
            .await?;
    }
    download_item_from_response_dict(&dict)
}
fn should_try_legacy_download(error: &ClientError) -> bool {
    match error {
        ClientError::Sap(_) | ClientError::Http(_) => true,
        ClientError::UnexpectedResponse(reason) => !reason
            .split(';')
            .any(|field| field.contains("http_status=403")),
        ClientError::Store(_) | ClientError::MissingHeader(_) | ClientError::PlistDe(_) => false,
        ClientError::SapSignatureRequired { .. } => false,
    }
}
async fn get_ent_download_info(
    client: &AppleClient,
    endpoint: &Url,
    app_id: i64,
    bundle_id: &str,
    account: &Account,
    requested_external_version_id: Option<&str>,
) -> Result<DownloadItem, ClientError> {
    let external_version_id = match requested_external_version_id {
        Some(version_id) => version_id.to_string(),
        None => lookup_latest_external_version_id(client, account, app_id, bundle_id).await?,
    };
    let dsid = account
        .directory_services_id
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| ClientError::UnexpectedResponse("ent_download_dsid_invalid".into()))?;
    let cache_dir = client.cache_dir();
    let bundle = crate::sap::assets::load(client, &cache_dir.join("apple-assets")).await?;
    let machine = crate::sap::machine::Machine::open(client, cache_dir, &bundle).await?;
    let kbsync = machine.generate_kbsync(client.hardware_id(), dsid)?;
    let serial = ent_download_serial_number(client.hardware_id())?;
    let body = ent_download_request_body(
        app_id,
        client.guid(),
        &external_version_id,
        &kbsync,
        &serial,
    )?;
    let url = ent_download_dispatch_url(endpoint, client.guid());
    let response = client
        .app_store_dispatch_http()?
        .post(url)
        .header(
            "Content-Type",
            "application/x-www-form-urlencoded; charset=utf-8",
        )
        .header("X-Dsid", &account.directory_services_id)
        .header("iCloud-DSID", &account.directory_services_id)
        .header("X-Apple-Store-Front", &account.store_front)
        .header("X-Token", &account.password_token)
        .timeout(Duration::from_secs(45))
        .body(body)
        .send()
        .await?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let response_headers = response.headers().clone();
    let response_body = response.bytes().await?;
    let dict = crate::client::plist_xml::parse_plist_response(&response_body).map_err(|_| {
        ClientError::UnexpectedResponse(response_diagnostic(
            status.as_u16(),
            content_type.as_deref(),
            &response_body,
            &response_headers,
        ))
    })?;
    if status != reqwest::StatusCode::OK && StoreError::from_plist_dict(&dict).is_none() {
        return Err(ClientError::UnexpectedResponse(
            "ent_download_http_failed".into(),
        ));
    }
    let item = download_item_from_response_dict(&dict)?;
    validate_download_response_identity(&dict, app_id, bundle_id, &external_version_id)?;
    if item.url.is_empty() {
        return Err(ClientError::UnexpectedResponse(
            "ent_download_url_missing".into(),
        ));
    }
    Ok(item)
}
#[derive(Clone, Copy)]
enum DownloadVersionKey {
    ExternalVersionId,
    AppExtVrsId,
}
fn download_info_request_body(
    app_id: i64,
    guid: &str,
    external_version_id: Option<&str>,
    version_key: DownloadVersionKey,
) -> Result<Vec<u8>, ClientError> {
    let mut body = plist::Dictionary::new();
    body.insert("salableAdamId".into(), plist::Value::Integer(app_id.into()));
    body.insert("guid".into(), plist::Value::String(guid.to_string()));
    body.insert("creditDisplay".into(), plist::Value::String(String::new()));
    body.insert("serialNumber".into(), plist::Value::String("0".into()));
    if let Some(vid) = external_version_id {
        body.insert(
            match version_key {
                DownloadVersionKey::ExternalVersionId => "externalVersionId",
                DownloadVersionKey::AppExtVrsId => "appExtVrsId",
            }
            .into(),
            plist::Value::String(vid.to_string()),
        );
    }
    let mut body_bytes = Vec::new();
    plist::to_writer_xml(&mut body_bytes, &body)
        .map_err(|e| ClientError::UnexpectedResponse(format!("plist serialize: {e}")))?;
    Ok(body_bytes)
}
fn ent_download_serial_number(hardware_id: &[u8]) -> Result<Vec<u8>, ClientError> {
    if hardware_id.len() != 6 {
        return Err(ClientError::UnexpectedResponse(
            "ent_download_hardware_id_invalid".into(),
        ));
    }
    let mut serial = vec![0x54, 0xC8, 0xB0, 0xA9, 0x88];
    serial.extend_from_slice(&hardware_id[2..]);
    Ok(serial)
}
fn ent_download_request_body(
    app_id: i64,
    guid: &str,
    external_version_id: &str,
    kbsync: &[u8],
    serial_number: &[u8],
) -> Result<Vec<u8>, ClientError> {
    let mut body = plist::Dictionary::new();
    body.insert("creditDisplay".into(), plist::Value::String(String::new()));
    body.insert("guid".into(), plist::Value::String(guid.to_string()));
    body.insert(
        "kbsync".into(),
        plist::Value::String(base64::engine::general_purpose::STANDARD.encode(kbsync)),
    );
    body.insert(
        "salableAdamId".into(),
        plist::Value::String(app_id.to_string()),
    );
    body.insert(
        "serialNumber".into(),
        plist::Value::String(base64::engine::general_purpose::STANDARD.encode(serial_number)),
    );
    body.insert(
        "externalVersionId".into(),
        plist::Value::String(external_version_id.to_string()),
    );
    let mut body_bytes = Vec::new();
    plist::to_writer_xml(&mut body_bytes, &body)
        .map_err(|e| ClientError::UnexpectedResponse(format!("plist serialize: {e}")))?;
    Ok(body_bytes)
}
async fn post_download_info(
    client: &AppleClient,
    account: &Account,
    url: &str,
    body: &[u8],
) -> Result<(reqwest::StatusCode, HashMap<String, plist::Value>), ClientError> {
    let response = client
        .http()
        .post(url)
        .header("Content-Type", "application/x-apple-plist")
        .header("iCloud-DSID", &account.directory_services_id)
        .header("X-Dsid", &account.directory_services_id)
        .body(body.to_vec())
        .send()
        .await?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let response_headers = response.headers().clone();
    let response_body = response.bytes().await?;
    tracing::debug!(%status, response_bytes = response_body.len(), "App Store download metadata response received");
    let dict = crate::client::plist_xml::parse_plist_response(&response_body).map_err(|_| {
        ClientError::UnexpectedResponse(response_diagnostic(
            status.as_u16(),
            content_type.as_deref(),
            &response_body,
            &response_headers,
        ))
    })?;
    Ok((status, dict))
}
pub(crate) fn response_diagnostic(
    status: u16,
    content_type: Option<&str>,
    body: &[u8],
    headers: &reqwest::header::HeaderMap,
) -> String {
    let server = headers
        .get(reqwest::header::SERVER)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            if value.eq_ignore_ascii_case("Apple") {
                "apple"
            } else {
                "other"
            }
        })
        .unwrap_or("missing");
    let commerce_header_count = [
        "apple-originating-system",
        "apple-timing-app",
        "x-apple-jingle-correlation-key",
        "x-apple-responding-instance",
    ]
    .iter()
    .filter(|name| headers.contains_key(**name))
    .count();
    format!(
        "appstore_response_invalid|http_status={status};content_type={};body_format={};body_length={};server={server};commerce_header_count={commerce_header_count}",
        response_content_type(content_type),
        response_body_format(body),
        body.len()
    )
}
fn response_content_type(content_type: Option<&str>) -> &'static str {
    let media_type = content_type
        .and_then(|value| value.split(';').next())
        .unwrap_or_default()
        .trim();
    if [
        "application/x-apple-plist",
        "application/x-apple-binary-plist",
        "application/plist",
    ]
    .iter()
    .any(|expected| media_type.eq_ignore_ascii_case(expected))
    {
        "apple_plist"
    } else if ["application/xml", "text/xml"]
        .iter()
        .any(|expected| media_type.eq_ignore_ascii_case(expected))
    {
        "xml"
    } else if media_type.eq_ignore_ascii_case("text/html") {
        "html"
    } else if media_type.eq_ignore_ascii_case("application/json")
        || media_type.to_ascii_lowercase().ends_with("+json")
    {
        "json"
    } else if media_type.is_empty() {
        "missing"
    } else {
        "other"
    }
}
fn response_body_format(body: &[u8]) -> &'static str {
    let body = &body[body
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(body.len())..];
    if body.is_empty() {
        "empty"
    } else if body.starts_with(b"bplist00") {
        "binary_plist"
    } else if body
        .get(..14)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"<!doctype html"))
        || body
            .get(..5)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"<html"))
    {
        "html"
    } else if [
        b"<?xml".as_slice(),
        b"<plist".as_slice(),
        b"<dict".as_slice(),
    ]
    .iter()
    .any(|prefix| {
        body.get(..prefix.len())
            .is_some_and(|body_prefix| body_prefix.eq_ignore_ascii_case(prefix))
    }) {
        "xml"
    } else if body.starts_with(b"{") || body.starts_with(b"[") {
        "json"
    } else {
        "other"
    }
}
async fn retry_download_dispatch(
    client: &AppleClient,
    account: &Account,
    app_id: i64,
    bundle_id: &str,
    requested_external_version_id: Option<&str>,
) -> Result<HashMap<String, plist::Value>, ClientError> {
    let config = crate::api::bag::fetch_download_endpoints(client)
        .await
        .map_err(|error| {
            let code = match &error {
                ClientError::Http(error) if error.is_timeout() => "update_product_bag_timed_out",
                ClientError::Http(error) if error.is_connect() => {
                    "update_product_bag_network_unavailable"
                }
                _ => "update_product_bag_unavailable",
            };
            ClientError::UnexpectedResponse(code.into())
        })?;
    let endpoint = config.redownload_product.ok_or_else(|| {
        ClientError::UnexpectedResponse("redownload_product_endpoint_missing".into())
    })?;
    let external_version_id = match requested_external_version_id {
        Some(version_id) => version_id.to_string(),
        None => lookup_latest_external_version_id(client, account, app_id, bundle_id).await?,
    };
    let body = download_info_request_body(
        app_id,
        client.guid(),
        Some(&external_version_id),
        DownloadVersionKey::AppExtVrsId,
    )?;
    let redownload_url = download_dispatch_url(&endpoint, client.guid());
    tracing::info!(
        "legacy App Store download returned no package; retrying Apple's redownloadProduct endpoint"
    );
    let (status, response) =
        match post_download_info(client, account, redownload_url.as_str(), &body).await {
            Ok(response) => response,
            Err(error) if is_empty_http_500_response(&error) => {
                return retry_update_product(
                    client,
                    account,
                    app_id,
                    bundle_id,
                    &external_version_id,
                    config.update_product.as_ref(),
                )
                .await;
            }
            Err(error) => return Err(stage_download_error(error, "redownload_product")),
        };
    if status != reqwest::StatusCode::OK {
        if StoreError::from_plist_dict(&response).is_some() {
            return Ok(response);
        }
        return Err(ClientError::UnexpectedResponse(
            "redownload_product_request_failed".into(),
        ));
    }
    if is_unavailable_download_response(status, &response) {
        return retry_update_product(
            client,
            account,
            app_id,
            bundle_id,
            &external_version_id,
            config.update_product.as_ref(),
        )
        .await;
    }
    if is_empty_successful_download(&response) {
        return Err(ClientError::UnexpectedResponse(
            "redownload_product_empty_song_list".into(),
        ));
    }
    Ok(response)
}
async fn retry_update_product(
    client: &AppleClient,
    account: &Account,
    app_id: i64,
    bundle_id: &str,
    external_version_id: &str,
    endpoint: Option<&Url>,
) -> Result<HashMap<String, plist::Value>, ClientError> {
    let endpoint = endpoint
        .ok_or_else(|| ClientError::UnexpectedResponse("update_product_endpoint_missing".into()))?;
    let body = download_info_request_body(
        app_id,
        client.guid(),
        Some(external_version_id),
        DownloadVersionKey::AppExtVrsId,
    )?;
    let update_url = download_dispatch_url(endpoint, client.guid());
    tracing::info!("Apple redownloadProduct did not return a package; retrying updateProduct");
    let (status, response) = post_download_info(client, account, update_url.as_str(), &body)
        .await
        .map_err(|error| stage_download_error(error, "update_product"))?;
    if status != reqwest::StatusCode::OK {
        if StoreError::from_plist_dict(&response).is_some() {
            return Ok(response);
        }
        return Err(ClientError::UnexpectedResponse(
            "update_product_request_failed".into(),
        ));
    }
    if is_empty_successful_download(&response) {
        return Err(ClientError::UnexpectedResponse(
            "update_product_empty_song_list".into(),
        ));
    }
    if StoreError::from_plist_dict(&response).is_none() {
        validate_download_response_identity(&response, app_id, bundle_id, external_version_id)?;
    }
    Ok(response)
}
fn validate_download_response_identity(
    response: &HashMap<String, plist::Value>,
    app_id: i64,
    bundle_id: &str,
    external_version_id: &str,
) -> Result<(), ClientError> {
    let items = response
        .get("songList")
        .and_then(plist::Value::as_array)
        .ok_or_else(|| {
            ClientError::UnexpectedResponse("update_product_song_list_invalid".into())
        })?;
    if items.len() != 1 {
        return Err(ClientError::UnexpectedResponse(
            "update_product_item_count_invalid".into(),
        ));
    }
    let item: DownloadItem = plist::from_value(&items[0]).map_err(ClientError::PlistDe)?;
    let requested_app_id = app_id.to_string();
    if metadata_string(&item.metadata, &["itemId"]).as_deref() != Some(requested_app_id.as_str())
        || item.latest_external_version_id().as_deref() != Some(external_version_id)
    {
        return Err(ClientError::UnexpectedResponse(
            "update_product_app_or_version_mismatch".into(),
        ));
    }
    if metadata_string(&item.metadata, &["softwareVersionBundleId"]).as_deref() != Some(bundle_id) {
        return Err(ClientError::UnexpectedResponse(
            "update_product_bundle_mismatch".into(),
        ));
    }
    Ok(())
}
fn stage_download_error(error: ClientError, stage: &str) -> ClientError {
    match &error {
        ClientError::Http(error) if error.is_timeout() => {
            ClientError::UnexpectedResponse(format!("{stage}_request_timed_out"))
        }
        ClientError::Http(error) if error.is_connect() => {
            ClientError::UnexpectedResponse(format!("{stage}_request_network_unavailable"))
        }
        ClientError::UnexpectedResponse(reason)
            if let Some(diagnostic) = reason.strip_prefix("appstore_response_invalid|") =>
        {
            ClientError::UnexpectedResponse(format!("{stage}_response_invalid|{diagnostic}"))
        }
        ClientError::PlistDe(_) => {
            ClientError::UnexpectedResponse(format!("{stage}_response_invalid"))
        }
        _ => ClientError::UnexpectedResponse(format!("{stage}_request_failed")),
    }
}
fn is_empty_http_500_response(error: &ClientError) -> bool {
    let ClientError::UnexpectedResponse(reason) = error else {
        return false;
    };
    reason
        .strip_prefix("appstore_response_invalid|")
        .is_some_and(|diagnostic| {
            diagnostic
                .split(';')
                .any(|field| field == "http_status=500")
                && diagnostic.split(';').any(|field| field == "body_length=0")
        })
}
fn is_unavailable_download_response(
    status: reqwest::StatusCode,
    dict: &HashMap<String, plist::Value>,
) -> bool {
    let has_failure = dict.get("failureType").is_some();
    let has_items = dict
        .get("songList")
        .and_then(plist::Value::as_array)
        .is_some_and(|items| !items.is_empty());
    let message = dict
        .get("customerMessage")
        .and_then(plist::Value::as_string)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    status == reqwest::StatusCode::OK
        && !has_failure
        && !has_items
        && (message == "no longer available" || message.ends_with(" no longer available"))
}
fn needs_download_dispatch_retry(
    status: reqwest::StatusCode,
    dict: &HashMap<String, plist::Value>,
) -> bool {
    status == reqwest::StatusCode::OK
        && (is_empty_successful_download(dict) || is_unavailable_download_response(status, dict))
}
fn download_dispatch_url(endpoint: &Url, guid: &str) -> Url {
    let mut url = endpoint.clone();
    url.query_pairs_mut().append_pair("guid", guid);
    url
}
fn ent_download_dispatch_url(endpoint: &Url, guid: &str) -> Url {
    let mut url = endpoint.clone();
    if url.path() == "/ent/download" {
        url.set_path(ENT_DOWNLOAD_PATH);
    }
    url.query_pairs_mut().append_pair("guid", guid);
    url
}
#[derive(Deserialize, Clone)]
#[serde(untagged)]
enum FlexibleVersionId {
    String(String),
    Number(serde_json::Number),
}
impl FlexibleVersionId {
    fn into_string(self) -> String {
        match self {
            Self::String(value) => value,
            Self::Number(value) => value.to_string(),
        }
    }
}
#[derive(Deserialize)]
struct IosCatalogVersionLookup {
    #[serde(default)]
    data: Vec<IosCatalogApp>,
}
#[derive(Deserialize)]
struct IosCatalogApp {
    id: String,
    #[serde(rename = "type")]
    item_type: String,
    attributes: IosCatalogAttributes,
}
#[derive(Deserialize)]
struct IosCatalogAttributes {
    #[serde(default, rename = "deviceFamilies")]
    device_families: Vec<String>,
    #[serde(rename = "platformAttributes")]
    platform_attributes: HashMap<String, IosCatalogPlatformAttributes>,
}
#[derive(Deserialize)]
struct IosCatalogPlatformAttributes {
    #[serde(rename = "bundleId")]
    bundle_id: String,
    #[serde(rename = "externalVersionId")]
    external_version_id: FlexibleVersionId,
}
impl IosCatalogVersionLookup {
    fn latest_external_version_id(
        self,
        expected_app_id: &str,
        expected_bundle_id: &str,
    ) -> Result<String, ClientError> {
        if self.data.len() != 1 {
            return Err(ClientError::UnexpectedResponse(
                "redownload_version_lookup_app_missing".into(),
            ));
        }
        let app = self.data.into_iter().next().ok_or_else(|| {
            ClientError::UnexpectedResponse("redownload_version_lookup_app_missing".into())
        })?;
        if app.id != expected_app_id || app.item_type != "apps" {
            return Err(ClientError::UnexpectedResponse(
                "redownload_version_lookup_app_mismatch".into(),
            ));
        }
        if !app
            .attributes
            .device_families
            .iter()
            .any(|family| family.eq_ignore_ascii_case("iphone"))
        {
            return Err(ClientError::UnexpectedResponse(
                "redownload_version_lookup_platform_mismatch".into(),
            ));
        }
        let platform = app
            .attributes
            .platform_attributes
            .get("ios")
            .ok_or_else(|| {
                ClientError::UnexpectedResponse("redownload_version_lookup_platform_missing".into())
            })?;
        if platform.bundle_id != expected_bundle_id {
            return Err(ClientError::UnexpectedResponse(
                "redownload_version_lookup_bundle_mismatch".into(),
            ));
        }
        let version_id = platform.external_version_id.clone().into_string();
        if version_id
            .parse::<u64>()
            .ok()
            .filter(|version_id| *version_id > 0)
            .is_none()
        {
            return Err(ClientError::UnexpectedResponse(
                "redownload_version_lookup_id_missing".into(),
            ));
        }
        Ok(version_id)
    }
}
async fn lookup_latest_external_version_id(
    client: &AppleClient,
    account: &Account,
    app_id: i64,
    bundle_id: &str,
) -> Result<String, ClientError> {
    let country = crate::model::storefront::country_code_from_store_front(&account.store_front)
        .unwrap_or("US")
        .to_ascii_lowercase();
    let app_id_string = app_id.to_string();
    let url = format!("https://apps.apple.com/api/apps/v1/catalog/{country}/apps/{app_id_string}");
    for attempt in 0..CATALOG_VERSION_LOOKUP_ATTEMPTS {
        let response = match client
            .http()
            .get(&url)
            .query(&[("platform", "iphone")])
            .timeout(CATALOG_VERSION_LOOKUP_TIMEOUT)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error)
                if attempt + 1 < CATALOG_VERSION_LOOKUP_ATTEMPTS
                    && (error.is_timeout() || error.is_connect()) =>
            {
                tokio::time::sleep(catalog_lookup_backoff(attempt)).await;
                continue;
            }
            Err(error) => return Err(map_catalog_lookup_request_error(error)),
        };
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(ClientError::UnexpectedResponse(
                "redownload_version_lookup_app_missing".into(),
            ));
        }
        if !response.status().is_success() {
            if should_retry_catalog_lookup(response.status())
                && attempt + 1 < CATALOG_VERSION_LOOKUP_ATTEMPTS
            {
                let Some(delay) = catalog_lookup_retry_delay(
                    response.headers().get(reqwest::header::RETRY_AFTER),
                    attempt,
                ) else {
                    return Err(ClientError::UnexpectedResponse(format!(
                        "redownload_version_lookup_http_failed;http_status={}",
                        response.status().as_u16()
                    )));
                };
                tokio::time::sleep(delay).await;
                continue;
            }
            return Err(ClientError::UnexpectedResponse(format!(
                "redownload_version_lookup_http_failed;http_status={}",
                response.status().as_u16()
            )));
        }
        let body = match response.bytes().await {
            Ok(body) => body,
            Err(error)
                if attempt + 1 < CATALOG_VERSION_LOOKUP_ATTEMPTS
                    && (error.is_timeout() || error.is_connect()) =>
            {
                tokio::time::sleep(catalog_lookup_backoff(attempt)).await;
                continue;
            }
            Err(error) => return Err(map_catalog_lookup_request_error(error)),
        };
        let lookup: IosCatalogVersionLookup = match serde_json::from_slice(&body) {
            Ok(lookup) => lookup,
            Err(_) if attempt + 1 < CATALOG_VERSION_LOOKUP_ATTEMPTS => {
                tokio::time::sleep(catalog_lookup_backoff(attempt)).await;
                continue;
            }
            Err(_) => {
                return Err(ClientError::UnexpectedResponse(
                    "redownload_version_lookup_invalid".into(),
                ));
            }
        };
        return lookup.latest_external_version_id(&app_id_string, bundle_id);
    }
    Err(ClientError::UnexpectedResponse(
        "redownload_version_lookup_request_failed".into(),
    ))
}
fn map_catalog_lookup_request_error(error: reqwest::Error) -> ClientError {
    let reason = if error.is_timeout() {
        "timed_out"
    } else if error.is_connect() {
        "network_unavailable"
    } else {
        "request_failed"
    };
    ClientError::UnexpectedResponse(format!("redownload_version_lookup_{reason}"))
}
fn should_retry_catalog_lookup(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}
fn catalog_lookup_retry_delay(
    retry_after: Option<&reqwest::header::HeaderValue>,
    attempt: usize,
) -> Option<Duration> {
    let retry_after = retry_after.and_then(|value| value.to_str().ok());
    match retry_after.and_then(|value| value.parse::<u64>().ok()) {
        Some(seconds) if seconds <= 30 => Some(Duration::from_secs(seconds)),
        Some(_) => None,
        None => Some(catalog_lookup_backoff(attempt)),
    }
}
fn catalog_lookup_backoff(attempt: usize) -> Duration {
    Duration::from_secs(attempt as u64 + 1)
}
fn is_empty_successful_download(dict: &HashMap<String, plist::Value>) -> bool {
    if StoreError::from_plist_dict(dict).is_some() {
        return false;
    }
    match dict.get("songList") {
        None => true,
        Some(plist::Value::Array(items)) => items.is_empty(),
        Some(_) => false,
    }
}
fn download_item_from_response_dict(
    dict: &HashMap<String, plist::Value>,
) -> Result<DownloadItem, ClientError> {
    match StoreError::from_plist_dict(dict) {
        Some(StoreError::LicenseAlreadyExists) => {
            if let Some(item) = download_item_from_dict(dict)? {
                Ok(item)
            } else {
                Err(ClientError::Store(StoreError::PasswordTokenExpired))
            }
        }
        Some(err) => Err(ClientError::Store(err)),
        None => {
            if let Some(item) = download_item_from_dict(dict)? {
                Ok(item)
            } else {
                Err(ClientError::UnexpectedResponse("missing songList".into()))
            }
        }
    }
}
fn download_item_from_dict(
    dict: &HashMap<String, plist::Value>,
) -> Result<Option<DownloadItem>, ClientError> {
    let Some(song_list) = dict.get("songList") else {
        return Ok(None);
    };
    let song_list = song_list
        .as_array()
        .ok_or_else(|| ClientError::UnexpectedResponse("invalid songList".into()))?;
    let first = song_list
        .first()
        .ok_or_else(|| ClientError::UnexpectedResponse("empty songList".into()))?;
    plist::from_value(first)
        .map(Some)
        .map_err(ClientError::PlistDe)
}
fn metadata_string(metadata: &HashMap<String, plist::Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| metadata.get(*key).and_then(metadata_value_to_string))
}
fn metadata_value_to_string(value: &plist::Value) -> Option<String> {
    match value {
        plist::Value::String(s) => Some(s.clone()),
        plist::Value::Integer(i) => i.as_signed().map(|n| n.to_string()),
        _ => None,
    }
}
pub async fn download_file(
    client: &AppleClient,
    url: &str,
    dest: &Path,
    show_progress: bool,
) -> Result<(), ClientError> {
    let existing_size = if dest.exists() {
        tokio::fs::metadata(dest)
            .await
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };
    let mut req = client.http().get(url);
    if existing_size > 0 {
        req = req.header("Range", format!("bytes={existing_size}-"));
        tracing::info!(existing_size, "resuming download");
    }
    let resp = req.send().await?;
    if resp.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        tracing::info!("file already fully downloaded");
        return Ok(());
    }
    let total_size = resp.content_length().map(|cl| cl + existing_size);
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dest)
        .await
        .map_err(|e| ClientError::UnexpectedResponse(format!("open file: {e}")))?;
    let pb = if show_progress {
        let pb = match total_size {
            Some(total) => {
                let pb = ProgressBar::new(total);
                pb.set_style(
                    ProgressStyle::default_bar()
                        .template("{msg} [{bar:40}] {bytes}/{total_bytes} ({eta})")
                        .unwrap()
                        .progress_chars("=> "),
                );
                pb.set_position(existing_size);
                pb
            }
            None => {
                let pb = ProgressBar::new_spinner();
                pb.set_style(
                    ProgressStyle::default_spinner()
                        .template("{msg} {bytes} {elapsed}")
                        .unwrap(),
                );
                pb
            }
        };
        pb.set_message("Downloading");
        Some(pb)
    } else {
        None
    };
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk)
            .await
            .map_err(|e| ClientError::UnexpectedResponse(format!("write: {e}")))?;
        if let Some(ref pb) = pb {
            pb.inc(chunk.len() as u64);
        }
    }
    file.flush()
        .await
        .map_err(|e| ClientError::UnexpectedResponse(format!("flush: {e}")))?;
    if let Some(pb) = pb {
        pb.finish_with_message("Download complete");
    }
    Ok(())
}
fn download_url(account: &Account, guid: &str) -> String {
    let host = match &account.pod {
        Some(pod) => format!("p{pod}-buy.itunes.apple.com"),
        None => "buy.itunes.apple.com".to_string(),
    };
    format!("https://{host}/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid={guid}")
}
#[cfg(test)]
mod tests {
    use super::*;
    fn sample_download_item() -> plist::Value {
        let mut sinf = plist::Dictionary::new();
        sinf.insert("id".into(), plist::Value::Integer(1.into()));
        sinf.insert("sinf".into(), plist::Value::Data(vec![1, 2, 3]));
        let mut item = plist::Dictionary::new();
        item.insert(
            "URL".into(),
            plist::Value::String("https://example.invalid/app.ipa".into()),
        );
        item.insert(
            "sinfs".into(),
            plist::Value::Array(vec![plist::Value::Dictionary(sinf)]),
        );
        plist::Value::Dictionary(item)
    }
    #[test]
    fn download_item_wins_over_license_already_exists_marker() {
        let mut dict = HashMap::new();
        dict.insert("failureType".into(), plist::Value::String("5002".into()));
        dict.insert(
            "customerMessage".into(),
            plist::Value::String("license already exists".into()),
        );
        dict.insert(
            "songList".into(),
            plist::Value::Array(vec![sample_download_item()]),
        );
        let item = download_item_from_response_dict(&dict).unwrap();
        assert_eq!(item.url, "https://example.invalid/app.ipa");
        assert_eq!(item.sinfs[0].id, 1);
        assert_eq!(item.sinfs[0].sinf, vec![1, 2, 3]);
    }
    #[test]
    fn bare_license_already_exists_requires_reauth_for_download() {
        let mut dict = HashMap::new();
        dict.insert("failureType".into(), plist::Value::String("5002".into()));
        dict.insert(
            "customerMessage".into(),
            plist::Value::String("license already exists".into()),
        );
        let err = download_item_from_response_dict(&dict).unwrap_err();
        assert!(err.is_token_expired());
    }
    #[test]
    fn download_item_reads_current_latest_version_id() {
        let mut item = plist::Dictionary::new();
        item.insert(
            "URL".into(),
            plist::Value::String("https://example.invalid/app.ipa".into()),
        );
        item.insert("sinfs".into(), plist::Value::Array(Vec::new()));
        let mut metadata = plist::Dictionary::new();
        metadata.insert(
            "softwareVersionExternalIdentifier".into(),
            plist::Value::Integer(887118713.into()),
        );
        item.insert("metadata".into(), plist::Value::Dictionary(metadata));
        let item: DownloadItem = plist::from_value(&plist::Value::Dictionary(item)).unwrap();
        assert_eq!(
            item.latest_external_version_id().as_deref(),
            Some("887118713")
        );
    }
    #[test]
    fn download_item_reads_legacy_latest_version_id() {
        let mut item = plist::Dictionary::new();
        item.insert(
            "URL".into(),
            plist::Value::String("https://example.invalid/app.ipa".into()),
        );
        item.insert("sinfs".into(), plist::Value::Array(Vec::new()));
        let mut metadata = plist::Dictionary::new();
        metadata.insert(
            "externalVersionIdentifier".into(),
            plist::Value::String("12345678".into()),
        );
        item.insert("metadata".into(), plist::Value::Dictionary(metadata));
        let item: DownloadItem = plist::from_value(&plist::Value::Dictionary(item)).unwrap();
        assert_eq!(
            item.latest_external_version_id().as_deref(),
            Some("12345678")
        );
    }
    #[test]
    fn download_item_does_not_guess_latest_version_id_from_array() {
        let mut item = plist::Dictionary::new();
        item.insert(
            "URL".into(),
            plist::Value::String("https://example.invalid/app.ipa".into()),
        );
        item.insert("sinfs".into(), plist::Value::Array(Vec::new()));
        let mut metadata = plist::Dictionary::new();
        metadata.insert(
            "softwareVersionExternalIdentifiers".into(),
            plist::Value::Array(vec![plist::Value::Integer(887118713.into())]),
        );
        item.insert("metadata".into(), plist::Value::Dictionary(metadata));
        let item: DownloadItem = plist::from_value(&plist::Value::Dictionary(item)).unwrap();
        assert_eq!(item.latest_external_version_id(), None);
    }
    #[test]
    fn retries_only_empty_successful_download_responses() {
        let empty_success = HashMap::from([("songList".into(), plist::Value::Array(Vec::new()))]);
        let failed_response =
            HashMap::from([("failureType".into(), plist::Value::String("9610".into()))]);
        let available_item = HashMap::from([(
            "songList".into(),
            plist::Value::Array(vec![sample_download_item()]),
        )]);
        assert!(is_empty_successful_download(&empty_success));
        assert!(is_empty_successful_download(&HashMap::new()));
        assert!(!is_empty_successful_download(&failed_response));
        assert!(!is_empty_successful_download(&available_item));
    }
    #[test]
    fn update_product_url_preserves_guid_as_query_parameter() {
        let endpoint =
            url::Url::parse("https://downloaddispatch.itunes.apple.com/up/updateProduct").unwrap();
        let request_url = download_dispatch_url(&endpoint, "AABBCCDDEEFF");
        assert_eq!(
            request_url.as_str(),
            "https://downloaddispatch.itunes.apple.com/up/updateProduct?guid=AABBCCDDEEFF"
        );
    }
    #[test]
    fn ent_download_url_expands_apples_short_bag_alias() {
        let endpoint =
            url::Url::parse("https://downloaddispatch.itunes.apple.com/ent/download").unwrap();
        let request_url = ent_download_dispatch_url(&endpoint, "AABBCCDDEEFF");
        assert_eq!(
            request_url.as_str(),
            "https://downloaddispatch.itunes.apple.com/WebObjects/DownloadDispatch.woa/wa/ent/download?guid=AABBCCDDEEFF"
        );
    }
    #[test]
    fn ent_download_url_preserves_apples_canonical_bag_path() {
        let endpoint = url::Url::parse(&format!(
            "https://downloaddispatch.itunes.apple.com{ENT_DOWNLOAD_PATH}"
        ))
        .unwrap();
        let request_url = ent_download_dispatch_url(&endpoint, "AABBCCDDEEFF");
        assert_eq!(
            request_url.as_str(),
            "https://downloaddispatch.itunes.apple.com/WebObjects/DownloadDispatch.woa/wa/ent/download?guid=AABBCCDDEEFF"
        );
    }
    #[test]
    fn download_info_request_matches_app_store_payload_types_and_fields() {
        let body = download_info_request_body(
            1234,
            "AABBCCDDEEFF",
            Some("5678"),
            DownloadVersionKey::ExternalVersionId,
        )
        .unwrap();
        let request: plist::Dictionary = plist::from_bytes(&body).unwrap();
        assert_eq!(
            request.get("salableAdamId"),
            Some(&plist::Value::Integer(1234.into()))
        );
        assert_eq!(
            request.get("serialNumber"),
            Some(&plist::Value::String("0".into()))
        );
        assert_eq!(
            request.get("guid"),
            Some(&plist::Value::String("AABBCCDDEEFF".into()))
        );
        assert_eq!(
            request.get("externalVersionId"),
            Some(&plist::Value::String("5678".into()))
        );
    }
    #[test]
    fn dispatch_download_request_uses_app_ext_version_id() {
        let body = download_info_request_body(
            1234,
            "AABBCCDDEEFF",
            Some("5678"),
            DownloadVersionKey::AppExtVrsId,
        )
        .unwrap();
        let request: plist::Dictionary = plist::from_bytes(&body).unwrap();
        assert_eq!(
            request.get("appExtVrsId"),
            Some(&plist::Value::String("5678".into()))
        );
        assert!(!request.contains_key("externalVersionId"));
    }
    #[test]
    fn ent_download_request_uses_account_bound_payload_fields() {
        let serial = ent_download_serial_number(&[0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]).unwrap();
        assert_eq!(
            serial,
            vec![0x54, 0xC8, 0xB0, 0xA9, 0x88, 0xCC, 0xDD, 0xEE, 0xFF]
        );
        let body =
            ent_download_request_body(1234, "AABBCCDDEEFF", "5678", &[1, 2, 3], &serial).unwrap();
        let request: plist::Dictionary = plist::from_bytes(&body).unwrap();
        assert_eq!(
            request.get("creditDisplay"),
            Some(&plist::Value::String(String::new()))
        );
        assert_eq!(
            request.get("guid"),
            Some(&plist::Value::String("AABBCCDDEEFF".into()))
        );
        assert_eq!(
            request.get("kbsync"),
            Some(&plist::Value::String("AQID".into()))
        );
        assert_eq!(
            request.get("salableAdamId"),
            Some(&plist::Value::String("1234".into()))
        );
        assert_eq!(
            request.get("serialNumber"),
            Some(&plist::Value::String("VMiwqYjM3e7/".into()))
        );
        assert_eq!(
            request.get("externalVersionId"),
            Some(&plist::Value::String("5678".into()))
        );
    }
    #[test]
    fn platform_version_lookup_accepts_numeric_and_string_ids() {
        let numeric: FlexibleVersionId = serde_json::from_str("123456").unwrap();
        let textual: FlexibleVersionId = serde_json::from_str("\"654321\"").unwrap();
        assert_eq!(numeric.into_string(), "123456");
        assert_eq!(textual.into_string(), "654321");
    }
    #[test]
    fn catalog_version_lookup_requires_matching_app_platform_and_bundle() {
        let lookup: IosCatalogVersionLookup = serde_json::from_str(
            r#"{"data":[{"id":"1234","type":"apps","attributes":{"deviceFamilies":["iphone","ipad"],"platformAttributes":{"ios":{"bundleId":"com.example.app","externalVersionId":"5678"}}}}]}"#,
        )
        .unwrap();
        assert_eq!(
            lookup
                .latest_external_version_id("1234", "com.example.app")
                .unwrap(),
            "5678"
        );
        let lookup: IosCatalogVersionLookup = serde_json::from_str(
            r#"{"data":[{"id":"1234","type":"apps","attributes":{"deviceFamilies":["iphone"],"platformAttributes":{"ios":{"bundleId":"com.example.app","externalVersionId":5678}}}}]}"#,
        )
        .unwrap();
        assert_eq!(
            lookup
                .latest_external_version_id("1234", "com.example.app")
                .unwrap(),
            "5678"
        );
        let lookup: IosCatalogVersionLookup = serde_json::from_str(
            r#"{"data":[{"id":"1234","type":"apps","attributes":{"deviceFamilies":["iphone"],"platformAttributes":{"ios":{"bundleId":"com.other.app","externalVersionId":"5678"}}}}]}"#,
        )
        .unwrap();
        assert!(
            lookup
                .latest_external_version_id("1234", "com.example.app")
                .is_err()
        );
    }
    #[test]
    fn retries_catalog_lookup_rate_limits_and_server_errors_only() {
        assert!(should_retry_catalog_lookup(
            reqwest::StatusCode::TOO_MANY_REQUESTS
        ));
        assert!(should_retry_catalog_lookup(
            reqwest::StatusCode::SERVICE_UNAVAILABLE
        ));
        assert!(!should_retry_catalog_lookup(reqwest::StatusCode::FORBIDDEN));
        assert!(!should_retry_catalog_lookup(reqwest::StatusCode::NOT_FOUND));
    }
    #[test]
    fn catalog_lookup_retry_delay_respects_bounded_retry_after() {
        let retry_after = reqwest::header::HeaderValue::from_static("7");
        assert_eq!(
            catalog_lookup_retry_delay(Some(&retry_after), 0),
            Some(Duration::from_secs(7))
        );
        let retry_after = reqwest::header::HeaderValue::from_static("90");
        assert_eq!(catalog_lookup_retry_delay(Some(&retry_after), 1), None);
        assert_eq!(
            catalog_lookup_retry_delay(None, 2),
            Some(Duration::from_secs(3))
        );
    }
    #[test]
    fn retries_update_product_only_for_an_empty_http_500_response() {
        assert!(is_empty_http_500_response(&ClientError::UnexpectedResponse(
            "appstore_response_invalid|http_status=500;content_type=xml;body_format=empty;body_length=0"
                .into()
        )));
        assert!(!is_empty_http_500_response(&ClientError::UnexpectedResponse(
            "appstore_response_invalid|http_status=403;content_type=xml;body_format=empty;body_length=0"
                .into()
        )));
        assert!(!is_empty_http_500_response(&ClientError::UnexpectedResponse(
            "appstore_response_invalid|http_status=500;content_type=xml;body_format=xml;body_length=24"
                .into()
        )));
    }
    #[test]
    fn recognizes_only_message_only_no_longer_available_downloads() {
        let unavailable = HashMap::from([(
            "customerMessage".into(),
            plist::Value::String("No Longer Available".into()),
        )]);
        let failure = HashMap::from([
            ("failureType".into(), plist::Value::String("2034".into())),
            (
                "customerMessage".into(),
                plist::Value::String("No Longer Available".into()),
            ),
        ]);
        assert!(is_unavailable_download_response(
            reqwest::StatusCode::OK,
            &unavailable
        ));
        assert!(!is_unavailable_download_response(
            reqwest::StatusCode::OK,
            &failure
        ));
        assert!(needs_download_dispatch_retry(
            reqwest::StatusCode::OK,
            &unavailable
        ));
        assert!(!needs_download_dispatch_retry(
            reqwest::StatusCode::FORBIDDEN,
            &unavailable
        ));
        assert!(!needs_download_dispatch_retry(
            reqwest::StatusCode::OK,
            &failure
        ));
    }
    #[test]
    fn requests_download_dispatch_for_empty_volume_store_responses() {
        let empty = HashMap::from([("songList".into(), plist::Value::Array(Vec::new()))]);
        let missing = HashMap::new();
        let available = HashMap::from([(
            "songList".into(),
            plist::Value::Array(vec![sample_download_item()]),
        )]);
        assert!(needs_download_dispatch_retry(
            reqwest::StatusCode::OK,
            &empty
        ));
        assert!(needs_download_dispatch_retry(
            reqwest::StatusCode::OK,
            &missing
        ));
        assert!(!needs_download_dispatch_retry(
            reqwest::StatusCode::OK,
            &available
        ));
    }
    #[test]
    fn verifies_update_product_result_matches_requested_app_bundle_and_version() {
        let mut metadata = plist::Dictionary::new();
        metadata.insert("itemId".into(), plist::Value::Integer(1234.into()));
        metadata.insert(
            "softwareVersionExternalIdentifier".into(),
            plist::Value::String("5678".into()),
        );
        metadata.insert(
            "softwareVersionBundleId".into(),
            plist::Value::String("com.example.app".into()),
        );
        let mut item = plist::Dictionary::new();
        item.insert(
            "URL".into(),
            plist::Value::String("https://example.invalid/app.ipa".into()),
        );
        item.insert("sinfs".into(), plist::Value::Array(Vec::new()));
        item.insert("metadata".into(), plist::Value::Dictionary(metadata));
        let response = HashMap::from([(
            "songList".into(),
            plist::Value::Array(vec![plist::Value::Dictionary(item)]),
        )]);
        assert!(
            validate_download_response_identity(&response, 1234, "com.example.app", "5678").is_ok()
        );
        assert!(
            validate_download_response_identity(&response, 4321, "com.example.app", "5678")
                .is_err()
        );
        assert!(
            validate_download_response_identity(&response, 1234, "com.other.app", "5678").is_err()
        );
        assert!(
            validate_download_response_identity(&response, 1234, "com.example.app", "8765")
                .is_err()
        );
    }
    #[test]
    fn rejects_update_product_responses_with_multiple_items() {
        let response = HashMap::from([(
            "songList".into(),
            plist::Value::Array(vec![sample_download_item(), sample_download_item()]),
        )]);
        assert!(
            validate_download_response_identity(&response, 1234, "com.example.app", "5678")
                .is_err()
        );
    }
    #[test]
    fn response_diagnostic_contains_safe_format_metadata_only() {
        let diagnostic = response_diagnostic(
            403,
            Some("text/html; charset=utf-8"),
            b"<html>private response body</html>",
            &reqwest::header::HeaderMap::new(),
        );
        assert!(diagnostic.contains("http_status=403"));
        assert!(diagnostic.contains("content_type=html"));
        assert!(diagnostic.contains("body_format=html"));
        assert!(diagnostic.contains("body_length=34"));
        assert!(diagnostic.contains("server=missing"));
        assert!(diagnostic.contains("commerce_header_count=0"));
        assert!(!diagnostic.contains("private response body"));
    }

    #[test]
    fn response_diagnostic_records_only_safe_commerce_header_presence() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::SERVER,
            reqwest::header::HeaderValue::from_static("Apple"),
        );
        headers.insert(
            "x-apple-jingle-correlation-key",
            reqwest::header::HeaderValue::from_static("private-correlation-value"),
        );
        let diagnostic = response_diagnostic(403, None, &[], &headers);
        assert!(diagnostic.contains("server=apple"));
        assert!(diagnostic.contains("commerce_header_count=1"));
        assert!(!diagnostic.contains("private-correlation-value"));
    }
}
