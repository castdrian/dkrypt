use std::fs::{self, OpenOptions, Permissions};
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process;
use std::time::{Duration, Instant};

use dkrypt_appstore_core::api;
use dkrypt_appstore_core::client::{AppleClient, is_trusted_apple_download_url};
use dkrypt_appstore_core::error::{ClientError, StoreError};
use dkrypt_appstore_core::guid::MachineIdentity;
use dkrypt_appstore_core::model::{Account, App, Platform};
use dkrypt_appstore_core::sap;
use serde::{Deserialize, Serialize};
use url::Url;

const MAX_REQUEST_BYTES: u64 = 64 * 1024;
const MAX_APPSTORE_DOWNLOAD_BYTES: u64 = 200 * 1024 * 1024 * 1024;
const MAX_DOWNLOAD_ATTEMPTS: usize = 3;

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
enum Request {
    Status,
    NetworkCheck,
    Authenticate {
        apple_id: String,
        password: String,
        verification_code: Option<String>,
    },
    Download {
        apple_id: String,
        password: String,
        bundle_id: String,
        #[serde(default)]
        platform: Platform,
        external_version_id: Option<String>,
        output_path: PathBuf,
        max_bytes: Option<u64>,
    },
}

#[derive(Serialize)]
struct Response {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    authenticated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    free_license_claimed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storefront_country: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    external_version_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    network_reachable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    network_latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    network_endpoint: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    network_redirected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    network_range_supported: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    network_rate_limited: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    network_retry_after_seconds: Option<u64>,
}

#[derive(Deserialize)]
struct AppStoreLookupResponse {
    results: Vec<AppStoreLookupResult>,
}

#[derive(Deserialize)]
struct AppStoreLookupResult {
    #[serde(rename = "artworkUrl512")]
    artwork_url: Option<String>,
}

#[derive(Clone, Debug)]
struct DownloaderFailure {
    stage: &'static str,
    code: &'static str,
    diagnostic: Option<String>,
}

impl DownloaderFailure {
    fn new(stage: &'static str, code: &'static str) -> Self {
        Self {
            stage,
            code,
            diagnostic: None,
        }
    }

    fn from_download_error(stage: &'static str, error: &ClientError) -> Self {
        Self {
            stage,
            code: map_download_error(error),
            diagnostic: map_download_diagnostic(error),
        }
    }
}

impl Response {
    fn authenticated(value: bool, storefront_country: Option<&'static str>) -> Self {
        Self {
            ok: true,
            authenticated: Some(value),
            free_license_claimed: None,
            storefront_country,
            external_version_id: None,
            stage: None,
            code: None,
            diagnostic: None,
            network_reachable: None,
            network_latency_ms: None,
            network_endpoint: None,
            network_redirected: None,
            network_range_supported: None,
            network_rate_limited: None,
            network_retry_after_seconds: None,
        }
    }

    fn success(
        free_license_claimed: bool,
        storefront_country: &'static str,
        external_version_id: Option<String>,
    ) -> Self {
        Self {
            ok: true,
            authenticated: None,
            free_license_claimed: Some(free_license_claimed),
            storefront_country: Some(storefront_country),
            external_version_id,
            stage: None,
            code: None,
            diagnostic: None,
            network_reachable: None,
            network_latency_ms: None,
            network_endpoint: None,
            network_redirected: None,
            network_range_supported: None,
            network_rate_limited: None,
            network_retry_after_seconds: None,
        }
    }

    fn failure(failure: DownloaderFailure) -> Self {
        Self {
            ok: false,
            authenticated: None,
            free_license_claimed: None,
            storefront_country: None,
            external_version_id: None,
            stage: Some(failure.stage),
            code: Some(failure.code),
            diagnostic: failure.diagnostic,
            network_reachable: None,
            network_latency_ms: None,
            network_endpoint: None,
            network_redirected: None,
            network_range_supported: None,
            network_rate_limited: None,
            network_retry_after_seconds: None,
        }
    }

    fn network_check(
        reachable: bool,
        latency_ms: u64,
        redirected: bool,
        range_supported: Option<bool>,
        rate_limited: bool,
        retry_after_seconds: Option<u64>,
        diagnostic: Option<String>,
    ) -> Self {
        Self {
            ok: true,
            authenticated: None,
            free_license_claimed: None,
            storefront_country: None,
            external_version_id: None,
            stage: Some("network_check"),
            code: diagnostic.as_deref().map(|_| "apple_network_unavailable"),
            diagnostic,
            network_reachable: Some(reachable),
            network_latency_ms: Some(latency_ms),
            network_endpoint: Some("https://itunes.apple.com/lookup"),
            network_redirected: Some(redirected),
            network_range_supported: range_supported,
            network_rate_limited: Some(rate_limited),
            network_retry_after_seconds: retry_after_seconds,
        }
    }
}

#[tokio::main]
async fn main() {
    let request = read_request().and_then(|request| validate_request(&request).map(|()| request));
    let result = match request {
        Ok(request) => execute(request).await,
        Err(code) => Err(DownloaderFailure::new("request", code)),
    };
    match result {
        Ok(response) => emit(response, 0),
        Err(failure) => emit(Response::failure(failure), 1),
    }
}

fn emit(response: Response, exit_code: i32) {
    let encoded = serde_json::to_string(&response).unwrap_or_else(|_| {
        "{\"ok\":false,\"stage\":\"internal\",\"code\":\"internal_error\"}".to_string()
    });
    println!("{encoded}");
    if exit_code != 0 {
        process::exit(exit_code);
    }
}

fn read_request() -> Result<Request, &'static str> {
    let mut input = Vec::new();
    std::io::stdin()
        .lock()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut input)
        .map_err(|_| "invalid_request")?;
    if input.len() as u64 > MAX_REQUEST_BYTES {
        return Err("invalid_request");
    }
    serde_json::from_slice(&input).map_err(|_| "invalid_request")
}

fn validate_request(request: &Request) -> Result<(), &'static str> {
    match request {
        Request::Status => Ok(()),
        Request::NetworkCheck => Ok(()),
        Request::Authenticate {
            apple_id,
            password,
            verification_code,
        } => {
            if !valid_email(apple_id) || password.is_empty() || password.len() > 1024 {
                return Err("invalid_request");
            }
            if verification_code
                .as_ref()
                .is_some_and(|value| !valid_verification_code(value))
            {
                return Err("invalid_request");
            }
            Ok(())
        }
        Request::Download {
            apple_id,
            password,
            bundle_id,
            platform,
            external_version_id,
            output_path,
            max_bytes,
        } => {
            if !valid_email(apple_id)
                || password.is_empty()
                || password.len() > 1024
                || !valid_bundle_id(bundle_id)
                || !matches!(platform, Platform::IPhone | Platform::AppleTV | Platform::VisionOS)
                || external_version_id.as_ref().is_some_and(|value| {
                    value.is_empty()
                        || value.len() > 64
                        || !value.bytes().all(|byte| byte.is_ascii_digit())
                })
                || !valid_ipa_path(output_path)
                || max_bytes.is_some_and(|value| value == 0 || value > MAX_APPSTORE_DOWNLOAD_BYTES)
            {
                return Err("invalid_request");
            }
            Ok(())
        }
    }
}

fn valid_email(value: &str) -> bool {
    let mut parts = value.split('@');
    let Some(local) = parts.next() else {
        return false;
    };
    let Some(domain) = parts.next() else {
        return false;
    };
    parts.next().is_none()
        && !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && value.len() <= 320
        && !value.bytes().any(|byte| byte.is_ascii_whitespace())
}

fn valid_verification_code(value: &str) -> bool {
    value.len() == 6 && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_bundle_id(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    parts.len() >= 2
        && value.len() <= 255
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.as_bytes()[0].is_ascii_alphanumeric()
                && part.as_bytes()[part.len() - 1].is_ascii_alphanumeric()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn valid_ipa_path(value: &Path) -> bool {
    if !value.is_absolute() || value.extension().is_none_or(|extension| extension != "ipa") {
        return false;
    }
    if fs::symlink_metadata(value).is_ok() {
        return false;
    }
    value.parent().is_some_and(|parent| parent.is_dir())
}

fn map_authentication_error(error: &ClientError, verification_code_provided: bool) -> &'static str {
    match error {
        ClientError::Store(StoreError::AuthCodeRequired) if verification_code_provided => {
            "verification_code_rejected"
        }
        ClientError::Store(StoreError::AuthCodeRequired) => "two_factor_required",
        ClientError::Store(StoreError::InvalidCredentials) => "invalid_credentials",
        ClientError::Store(StoreError::DeviceVerificationFailed) => "device_verification_required",
        ClientError::Store(StoreError::RateLimited) => "rate_limited",
        ClientError::Store(StoreError::TemporarilyUnavailable) => "apple_store_unavailable",
        ClientError::Store(StoreError::AccountDisabled) => "account_disabled",
        ClientError::Store(_) => "apple_sign_in_rejected",
        ClientError::Http(error) if error.is_timeout() => "apple_request_timed_out",
        ClientError::Http(error) if error.is_connect() => "apple_network_unavailable",
        ClientError::Http(_) => "apple_request_failed",
        ClientError::SapSignatureRequired { .. } => "action_signature_rejected",
        ClientError::Sap(_) => "action_signing_failed",
        ClientError::PlistDe(_)
        | ClientError::MissingHeader(_)
        | ClientError::UnexpectedResponse(_) => "apple_response_invalid",
    }
}

async fn execute(request: Request) -> Result<Response, DownloaderFailure> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| DownloaderFailure::new("environment", "invalid_environment"))?;
    let session_directory = home.join(".dkrypt-appstore");
    match request {
        Request::NetworkCheck => Ok(check_network().await),
        Request::Status => load_account(&session_directory)
            .map(|account| {
                let storefront_country = account.as_ref().and_then(|account| {
                    dkrypt_appstore_core::model::storefront::country_code_from_store_front(
                        &account.store_front,
                    )
                });
                Response::authenticated(account.is_some(), storefront_country)
            })
            .map_err(|code| DownloaderFailure::new("session", code)),
        Request::Authenticate {
            apple_id,
            password,
            verification_code,
        } => authenticate(
            &session_directory,
            &apple_id,
            &password,
            verification_code.as_deref(),
        )
        .await
        .map_err(|code| DownloaderFailure::new(authentication_failure_stage(code), code)),
        Request::Download {
            apple_id,
            password,
            bundle_id,
            platform,
            external_version_id,
            output_path,
            max_bytes,
        } => {
            download(
                &session_directory,
                &apple_id,
                &password,
                &bundle_id,
                platform,
                external_version_id.as_deref(),
                &output_path,
                max_bytes.unwrap_or(MAX_APPSTORE_DOWNLOAD_BYTES),
            )
            .await
        }
    }
}

async fn check_network() -> Response {
    const ENDPOINT: &str = "https://itunes.apple.com/lookup?id=310633997&entity=software";
    const MAX_LOOKUP_BYTES: usize = 1_048_576;
    let started_at = Instant::now();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("dkrypt-appstore-network-check")
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !is_trusted_apple_download_url(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build();
    let client = match client {
        Ok(client) => client,
        Err(_) => {
            return Response::network_check(
                false,
                started_at.elapsed().as_millis() as u64,
                false,
                None,
                false,
                None,
                Some("network_client_setup_failed".to_string()),
            );
        }
    };
    let response = client.get(ENDPOINT).send().await;
    match response {
        Ok(response) => {
            let redirected = response.url().as_str() != ENDPOINT;
            if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                return Response::network_check(
                    true,
                    started_at.elapsed().as_millis() as u64,
                    redirected,
                    None,
                    true,
                    response
                        .headers()
                        .get(reqwest::header::RETRY_AFTER)
                        .and_then(|value| value.to_str().ok())
                        .and_then(parse_retry_after_seconds),
                    Some("apple_rate_limited".to_string()),
                );
            }
            if !response.status().is_success() || !is_trusted_apple_download_url(response.url()) {
                return Response::network_check(
                    false,
                    started_at.elapsed().as_millis() as u64,
                    redirected,
                    None,
                    false,
                    None,
                    Some(format!("apple_http_{}", response.status().as_u16())),
                );
            }
            if response
                .content_length()
                .is_some_and(|size| size > MAX_LOOKUP_BYTES as u64)
            {
                return Response::network_check(
                    false,
                    started_at.elapsed().as_millis() as u64,
                    redirected,
                    None,
                    false,
                    None,
                    Some("apple_lookup_response_too_large".to_string()),
                );
            }
            let body = match response.bytes().await {
                Ok(body) if body.len() <= MAX_LOOKUP_BYTES => body,
                _ => {
                    return Response::network_check(
                        false,
                        started_at.elapsed().as_millis() as u64,
                        redirected,
                        None,
                        false,
                        None,
                        Some("apple_lookup_response_invalid".to_string()),
                    );
                }
            };
            let lookup = match serde_json::from_slice::<AppStoreLookupResponse>(&body) {
                Ok(lookup) => lookup,
                Err(_) => {
                    return Response::network_check(
                        false,
                        started_at.elapsed().as_millis() as u64,
                        redirected,
                        None,
                        false,
                        None,
                        Some("apple_lookup_response_invalid".to_string()),
                    );
                }
            };
            let Some(artwork_url) = lookup
                .results
                .first()
                .and_then(|result| result.artwork_url.as_deref())
            else {
                return Response::network_check(
                    false,
                    started_at.elapsed().as_millis() as u64,
                    redirected,
                    None,
                    false,
                    None,
                    Some("apple_download_endpoint_missing".to_string()),
                );
            };
            let artwork_url = match Url::parse(artwork_url) {
                Ok(url) if is_trusted_apple_download_url(&url) => url,
                _ => {
                    return Response::network_check(
                        false,
                        started_at.elapsed().as_millis() as u64,
                        redirected,
                        None,
                        false,
                        None,
                        Some("apple_download_endpoint_rejected".to_string()),
                    );
                }
            };
            let range_response = client
                .get(artwork_url.clone())
                .header(reqwest::header::RANGE, "bytes=0-0")
                .send()
                .await;
            match range_response {
                Ok(response) => {
                    let redirected = redirected || response.url() != &artwork_url;
                    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                        return Response::network_check(
                            true,
                            started_at.elapsed().as_millis() as u64,
                            redirected,
                            None,
                            true,
                            response
                                .headers()
                                .get(reqwest::header::RETRY_AFTER)
                                .and_then(|value| value.to_str().ok())
                                .and_then(parse_retry_after_seconds),
                            Some("apple_rate_limited".to_string()),
                        );
                    }
                    if !response.status().is_success()
                        || !is_trusted_apple_download_url(response.url())
                    {
                        return Response::network_check(
                            false,
                            started_at.elapsed().as_millis() as u64,
                            redirected,
                            None,
                            false,
                            None,
                            Some(format!(
                                "apple_download_http_{}",
                                response.status().as_u16()
                            )),
                        );
                    }
                    let range_supported = supports_single_byte_range(
                        response.status(),
                        response
                            .headers()
                            .get(reqwest::header::CONTENT_RANGE)
                            .and_then(|value| value.to_str().ok()),
                    );
                    Response::network_check(
                        true,
                        started_at.elapsed().as_millis() as u64,
                        redirected,
                        Some(range_supported),
                        false,
                        None,
                        None,
                    )
                }
                Err(error) if error.is_timeout() => Response::network_check(
                    false,
                    started_at.elapsed().as_millis() as u64,
                    redirected,
                    None,
                    false,
                    None,
                    Some("apple_download_request_timed_out".to_string()),
                ),
                Err(error) if error.is_connect() => Response::network_check(
                    false,
                    started_at.elapsed().as_millis() as u64,
                    redirected,
                    None,
                    false,
                    None,
                    Some("apple_download_network_unavailable".to_string()),
                ),
                Err(_) => Response::network_check(
                    false,
                    started_at.elapsed().as_millis() as u64,
                    redirected,
                    None,
                    false,
                    None,
                    Some("apple_download_request_failed".to_string()),
                ),
            }
        }
        Err(error) if error.is_timeout() => Response::network_check(
            false,
            started_at.elapsed().as_millis() as u64,
            false,
            None,
            false,
            None,
            Some("apple_request_timed_out".to_string()),
        ),
        Err(error) if error.is_connect() => Response::network_check(
            false,
            started_at.elapsed().as_millis() as u64,
            false,
            None,
            false,
            None,
            Some("apple_network_unavailable".to_string()),
        ),
        Err(_) => Response::network_check(
            false,
            started_at.elapsed().as_millis() as u64,
            false,
            None,
            false,
            None,
            Some("apple_request_failed".to_string()),
        ),
    }
}

fn parse_retry_after_seconds(value: &str) -> Option<u64> {
    value
        .trim()
        .parse::<u64>()
        .ok()
        .filter(|seconds| *seconds > 0)
}

fn supports_single_byte_range(status: reqwest::StatusCode, content_range: Option<&str>) -> bool {
    status == reqwest::StatusCode::PARTIAL_CONTENT
        && content_range.is_some_and(|value| {
            let Some(total) = value.strip_prefix("bytes 0-0/") else {
                return false;
            };
            total == "*" || total.parse::<u64>().is_ok_and(|length| length > 0)
        })
}

fn authentication_failure_stage(code: &'static str) -> &'static str {
    match code {
        "apple_client_setup_failed" | "storefront_lookup_failed" | "action_signing_failed" => {
            "sign_in_setup"
        }
        "provider_session_storage_failed" => "session_persistence",
        _ => "sign_in",
    }
}

async fn authenticate(
    session_directory: &Path,
    apple_id: &str,
    password: &str,
    verification_code: Option<&str>,
) -> Result<Response, &'static str> {
    ensure_private_directory(session_directory)?;
    let cache_directory = cache_directory(session_directory)?;
    let identity = load_or_create_identity(session_directory)?;
    let cookie_path = session_directory.join("cookies.json");
    let client = AppleClient::new(identity, Some(&cookie_path), cache_directory)
        .map_err(|_| "apple_client_setup_failed")?;
    let bag = api::bag::fetch_bag(&client)
        .await
        .map_err(|_| "storefront_lookup_failed")?;
    let signer = sap::new_default_signer(&client, &bag.sap, client.hardware_id())
        .await
        .map_err(|_| "action_signing_failed")?;
    let account = api::auth::login(
        &client,
        apple_id,
        password,
        verification_code,
        &bag.auth_endpoint,
        Some(&signer),
    )
    .await
    .map_err(|error| map_authentication_error(&error, verification_code.is_some()))?;
    let storefront_country = dkrypt_appstore_core::model::storefront::country_code_from_store_front(
        &account.store_front,
    );
    save_account(session_directory, account).map_err(|_| "provider_session_storage_failed")?;
    client
        .save_cookies(&cookie_path)
        .map_err(|_| "provider_session_storage_failed")?;
    Ok(Response::authenticated(true, storefront_country))
}

async fn download(
    session_directory: &Path,
    apple_id: &str,
    password: &str,
    bundle_id: &str,
    platform: Platform,
    external_version_id: Option<&str>,
    output_path: &Path,
    max_bytes: u64,
) -> Result<Response, DownloaderFailure> {
    let mut account = load_account(session_directory)
        .map_err(|code| DownloaderFailure::new("session", code))?
        .ok_or_else(|| DownloaderFailure::new("session", "authentication_required"))?;
    if !account.email.eq_ignore_ascii_case(apple_id) {
        return Err(DownloaderFailure::new("account", "account_mismatch"));
    }
    account.password = Some(password.to_string());
    let cache_directory = cache_directory(session_directory)
        .map_err(|code| DownloaderFailure::new("environment", code))?;
    let identity = load_or_create_identity(session_directory)
        .map_err(|code| DownloaderFailure::new("session", code))?;
    let cookie_path = session_directory.join("cookies.json");
    let mut client = AppleClient::new(identity, Some(&cookie_path), cache_directory)
        .map_err(|_| DownloaderFailure::new("client_setup", "apple_client_setup_failed"))?;
    client.set_account(account.clone());
    let country = country_code_from_storefront(&account.store_front)?;
    let app = api::lookup::lookup(&client, bundle_id, country, platform)
        .await
        .map_err(|error| DownloaderFailure::new("app_lookup", map_lookup_error(&error)))?
        .ok_or_else(|| DownloaderFailure::new("app_lookup", "app_not_found"))?;
    let mut free_license_claimed = false;
    let item = match get_download_info_with_reauthentication(
        &mut client,
        &app,
        &mut account,
        external_version_id,
        platform,
    )
    .await
    {
        Ok(item) => item,
        Err(error) if should_claim_free_license(app.price, &error) => {
            claim_free_license_with_reauthentication(&mut client, &app, &mut account)
                .await
                .map_err(|error| map_license_claim_error(&error))?;
            free_license_claimed = true;
            match get_download_info_with_reauthentication(
                &mut client,
                &app,
                &mut account,
                external_version_id,
                platform,
            )
            .await
            {
                Ok(item) => item,
                Err(error) if error.is_license_not_found() => {
                    return Err(DownloaderFailure::new(
                        "license_acquisition",
                        "free_app_license_not_confirmed",
                    ));
                }
                Err(error) => {
                    return Err(DownloaderFailure::from_download_error(
                        "download_info",
                        &error,
                    ));
                }
            }
        }
        Err(error) => {
            return Err(DownloaderFailure::from_download_error(
                "download_info",
                &error,
            ));
        }
    };
    let resolved_external_version_id = item.latest_external_version_id();
    verify_requested_version(resolved_external_version_id.as_deref(), external_version_id)
    .map_err(|code| DownloaderFailure::new("version_validation", code))?;
    let temporary_path = resumable_download_path(output_path)
        .map_err(|_| DownloaderFailure::new("download_staging", "download_file_failed"))?;
    let metadata_path = download_metadata_path(&temporary_path);
    let mut temporary = TemporaryDownload::new(temporary_path.clone(), metadata_path.clone());
    let download_client = client
        .download_http()
        .map_err(|_| DownloaderFailure::new("download_client", "download_client_setup_failed"))?;
    if let Err(failure) = stream_download(
        &download_client,
        &item.url,
        &temporary_path,
        &metadata_path,
        max_bytes,
    )
    .await
    {
        if has_resumable_download_state(&temporary_path, &metadata_path) {
            temporary.keep();
        }
        return Err(failure);
    }
    let mut output = TemporaryFile::new(output_path.to_path_buf());
    dkrypt_appstore_core::ipa::patch::patch_ipa(
        &temporary_path,
        output_path,
        &item,
        &account.email,
    )
    .map_err(|_| DownloaderFailure::new("ipa_patching", "ipa_patch_failed"))?;
    output.keep();
    temporary.remove();
    account.password = None;
    save_account(session_directory, account)
        .map_err(|code| DownloaderFailure::new("session_persistence", code))?;
    client.save_cookies(&cookie_path).map_err(|_| {
        DownloaderFailure::new("session_persistence", "provider_session_storage_failed")
    })?;
    Ok(Response::success(free_license_claimed, country, resolved_external_version_id))
}

fn verify_requested_version(
    actual_version: Option<&str>,
    requested_version: Option<&str>,
) -> Result<(), &'static str> {
    let Some(requested_version) = requested_version else {
        return Ok(());
    };
    match actual_version {
        Some(actual_version) if actual_version == requested_version => Ok(()),
        Some(_) => Err("version_mismatch"),
        None => Err("version_unverified"),
    }
}

fn should_claim_free_license(price: Option<f64>, error: &ClientError) -> bool {
    price == Some(0.0) && error.is_license_not_found()
}

fn country_code_from_storefront(store_front: &str) -> Result<&'static str, DownloaderFailure> {
    dkrypt_appstore_core::model::storefront::country_code_from_store_front(store_front)
        .ok_or_else(|| DownloaderFailure::new("app_lookup", "storefront_unrecognized"))
}

async fn get_download_info_with_reauthentication(
    client: &mut AppleClient,
    app: &App,
    account: &mut Account,
    external_version_id: Option<&str>,
    platform: Platform,
) -> Result<dkrypt_appstore_core::api::download::DownloadItem, ClientError> {
    match api::download::get_download_info(
        client,
        app.id,
        &app.bundle_id,
        account,
        external_version_id,
        platform,
    )
    .await
    {
        Err(error) if error.is_token_expired() => {
            *account = api::reauth::reauthenticate(client, account).await?;
            client.set_account(account.clone());
            api::download::get_download_info(
                client,
                app.id,
                &app.bundle_id,
                account,
                external_version_id,
                platform,
            )
            .await
        }
        result => result,
    }
}

async fn claim_free_license_with_reauthentication(
    client: &mut AppleClient,
    app: &App,
    account: &mut Account,
) -> Result<(), ClientError> {
    match api::purchase::claim_free_license(client, app, account).await {
        Err(error) if error.is_token_expired() => {
            *account = api::reauth::reauthenticate(client, account).await?;
            client.set_account(account.clone());
            api::purchase::claim_free_license(client, app, account).await
        }
        result => result,
    }
}

fn map_license_claim_error(error: &ClientError) -> DownloaderFailure {
    let (code, diagnostic) = match error {
        ClientError::Store(StoreError::AuthCodeRequired) => ("two_factor_required", None),
        ClientError::Store(StoreError::DeviceVerificationFailed) => {
            ("device_verification_required", None)
        }
        ClientError::Store(StoreError::RateLimited) => ("apple_rate_limited", None),
        ClientError::Store(StoreError::TemporarilyUnavailable) => ("apple_store_unavailable", None),
        ClientError::Store(StoreError::PasswordTokenExpired | StoreError::SignInRequired) => {
            ("authentication_required", None)
        }
        ClientError::Store(StoreError::InvalidCredentials) => ("authentication_required", None),
        ClientError::Store(StoreError::AccountDisabled) => ("apple_account_disabled", None),
        ClientError::Store(StoreError::PurchaseFailed) => ("free_license_purchase_rejected", None),
        ClientError::Store(StoreError::Unknown { code, .. }) if safe_apple_error_code(code) => (
            "free_license_claim_rejected",
            Some(format!("apple_error_code={code}")),
        ),
        ClientError::Store(StoreError::Unknown { .. }) => ("free_license_claim_failed", None),
        ClientError::Http(error) if error.is_timeout() => ("free_license_claim_timed_out", None),
        ClientError::Http(error) if error.is_connect() => {
            ("free_license_claim_network_unavailable", None)
        }
        ClientError::Http(error) if error.status().is_some_and(|status| status.as_u16() == 429) => {
            ("apple_rate_limited", Some("http_status=429".into()))
        }
        ClientError::Http(error)
            if error
                .status()
                .is_some_and(|status| status.is_server_error()) =>
        {
            let diagnostic = error
                .status()
                .map(|status| format!("http_status={}", status.as_u16()));
            ("apple_store_unavailable", diagnostic)
        }
        ClientError::Http(error) => {
            let diagnostic = error
                .status()
                .map(|status| format!("http_status={}", status.as_u16()));
            ("free_license_claim_http_failed", diagnostic)
        }
        ClientError::UnexpectedResponse(reason)
            if let Some(diagnostic) = reason.strip_prefix("appstore_response_invalid|") =>
        {
            (
                "free_license_claim_response_invalid",
                Some(diagnostic.to_string()),
            )
        }
        ClientError::UnexpectedResponse(reason) if reason == "purchase_http_failed" => {
            ("free_license_claim_http_failed", None)
        }
        ClientError::UnexpectedResponse(reason) if reason.starts_with("purchase_") => (
            "free_license_claim_request_invalid",
            Some(format!("reason={reason}")),
        ),
        ClientError::PlistDe(_) => (
            "free_license_claim_response_invalid",
            Some("response_format=plist_parse_failed".into()),
        ),
        ClientError::UnexpectedResponse(_) => ("free_license_claim_response_invalid", None),
        _ => ("free_license_claim_failed", None),
    };
    DownloaderFailure {
        stage: "license_acquisition",
        code,
        diagnostic,
    }
}

fn safe_apple_error_code(code: &str) -> bool {
    let digits = code.strip_prefix('-').unwrap_or(code);
    !digits.is_empty() && digits.len() <= 8 && digits.bytes().all(|byte| byte.is_ascii_digit())
}

fn map_lookup_error(error: &ClientError) -> &'static str {
    match error {
        ClientError::Http(error) if error.is_timeout() => "app_lookup_timed_out",
        ClientError::Http(error) if error.is_connect() => "app_lookup_network_unavailable",
        ClientError::Http(error) if error.status().is_some_and(|status| status.as_u16() == 429) => {
            "apple_rate_limited"
        }
        ClientError::Http(_) => "app_lookup_http_failed",
        ClientError::PlistDe(_) | ClientError::UnexpectedResponse(_) => {
            "app_lookup_response_invalid"
        }
        ClientError::MissingHeader(_)
        | ClientError::Sap(_)
        | ClientError::SapSignatureRequired { .. } => "app_lookup_failed",
        ClientError::Store(_) => "app_lookup_failed",
    }
}

fn map_download_error(error: &ClientError) -> &'static str {
    match error {
        ClientError::Store(StoreError::AuthCodeRequired) => "two_factor_required",
        ClientError::Store(StoreError::LicenseNotFound) => "app_not_owned",
        ClientError::Store(StoreError::RateLimited) => "apple_rate_limited",
        ClientError::Store(StoreError::TemporarilyUnavailable) => "apple_store_unavailable",
        ClientError::Store(
            StoreError::PasswordTokenExpired
            | StoreError::SignInRequired
            | StoreError::DeviceVerificationFailed,
        ) => "authentication_required",
        ClientError::Store(_) => "download_info_rejected",
        ClientError::Http(error) if error.is_timeout() => "download_info_timed_out",
        ClientError::Http(error) if error.is_connect() => "download_info_network_unavailable",
        ClientError::Http(error) if error.status().is_some_and(|status| status.as_u16() == 429) => {
            "apple_rate_limited"
        }
        ClientError::Http(_) => "download_info_http_failed",
        ClientError::PlistDe(_) => "download_info_plist_invalid",
        ClientError::MissingHeader(_) => "download_info_response_invalid",
        ClientError::UnexpectedResponse(reason) => match reason.as_str() {
            "missing songList" => "download_info_song_list_missing",
            "invalid songList" => "download_info_song_list_invalid",
            "empty songList" => "download_info_song_list_empty",
            "download_info_http_failed" => "download_info_http_failed",
            "ent_download_http_failed" => "download_info_ent_download_http_failed",
            "ent_download_dsid_invalid" | "ent_download_hardware_id_invalid" => {
                "download_info_ent_download_identity_invalid"
            }
            "ent_download_url_missing" => "download_info_ent_download_url_missing",
            reason if reason.starts_with("ent_download_request_timed_out") => {
                "download_info_ent_download_request_timed_out"
            }
            reason if reason.starts_with("ent_download_request_network_unavailable") => {
                "download_info_ent_download_request_network_unavailable"
            }
            reason if reason.starts_with("ent_download_response_invalid") => {
                "download_info_ent_download_response_invalid"
            }
            "redownload_product_endpoint_missing" => {
                "download_info_redownload_product_endpoint_missing"
            }
            "redownload_product_request_timed_out" => {
                "download_info_redownload_product_request_timed_out"
            }
            "redownload_product_request_network_unavailable" => {
                "download_info_redownload_product_request_network_unavailable"
            }
            "redownload_product_request_failed" => {
                "download_info_redownload_product_request_failed"
            }
            "redownload_product_response_invalid" => {
                "download_info_redownload_product_response_invalid"
            }
            reason if reason.starts_with("redownload_product_response_invalid|") => {
                "download_info_redownload_product_response_invalid"
            }
            "redownload_product_empty_song_list" => {
                "download_info_redownload_product_empty_song_list"
            }
            reason if reason.starts_with("redownload_version_lookup_http_failed") => {
                "download_info_redownload_version_lookup_http_failed"
            }
            reason if reason.starts_with("redownload_version_lookup_timed_out") => {
                "download_info_redownload_version_lookup_timed_out"
            }
            reason if reason.starts_with("redownload_version_lookup_network_unavailable") => {
                "download_info_redownload_version_lookup_network_unavailable"
            }
            reason if reason.starts_with("redownload_version_lookup_request_failed") => {
                "download_info_redownload_version_lookup_request_failed"
            }
            reason if reason.starts_with("redownload_version_lookup_") => {
                "download_info_redownload_version_lookup_failed"
            }
            "update_product_bag_timed_out" => "download_info_update_product_bag_timed_out",
            "update_product_bag_network_unavailable" => {
                "download_info_update_product_bag_network_unavailable"
            }
            "update_product_bag_unavailable" => "download_info_update_product_bag_unavailable",
            "update_product_endpoint_missing" => "download_info_update_product_endpoint_missing",
            "update_product_request_timed_out" => "download_info_update_product_request_timed_out",
            "update_product_request_network_unavailable" => {
                "download_info_update_product_request_network_unavailable"
            }
            "update_product_request_failed" => "download_info_update_product_request_failed",
            "update_product_response_invalid" => "download_info_update_product_response_invalid",
            reason if reason.starts_with("update_product_response_invalid|") => {
                "download_info_update_product_response_invalid"
            }
            "update_product_empty_song_list" => "download_info_update_product_empty_song_list",
            "update_product_song_list_invalid"
            | "update_product_item_count_invalid"
            | "update_product_app_or_version_mismatch"
            | "update_product_bundle_mismatch" => "download_info_update_product_response_invalid",
            _ => "download_info_response_invalid",
        },
        ClientError::SapSignatureRequired { .. } => "action_signature_rejected",
        ClientError::Sap(_) => "action_signing_failed",
    }
}

fn map_download_diagnostic(error: &ClientError) -> Option<String> {
    match error {
        ClientError::UnexpectedResponse(reason) => [
            "ent_download_response_invalid|",
            "redownload_product_response_invalid|",
            "redownload_version_lookup_",
            "update_product_response_invalid|",
        ]
        .into_iter()
        .find_map(|prefix| reason.strip_prefix(prefix).map(str::to_owned)),
        _ => None,
    }
}

async fn stream_download(
    client: &dkrypt_appstore_core::client::DownloadHttpClient,
    url: &str,
    destination: &Path,
    metadata_path: &Path,
    max_bytes: u64,
) -> Result<(), DownloaderFailure> {
    let parsed = Url::parse(url)
        .map_err(|_| DownloaderFailure::new("download_url", "download_url_invalid"))?;
    if !is_trusted_apple_download_url(&parsed) {
        return Err(DownloaderFailure::new(
            "download_url",
            "download_url_rejected",
        ));
    }
    for attempt in 0..MAX_DOWNLOAD_ATTEMPTS {
        let saved_etag = load_download_etag(metadata_path);
        let mut offset = fs::metadata(destination)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if offset > max_bytes {
            return Err(DownloaderFailure::new(
                "download_transfer",
                "download_too_large",
            ));
        }
        if offset > 0 && saved_etag.is_none() {
            remove_download_partial(destination, metadata_path);
            offset = 0;
        }
        let mut request = client.get(parsed.clone());
        if offset > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
            if let Some(etag) = saved_etag.as_ref() {
                request = request.header(reqwest::header::IF_RANGE, etag);
            }
        }
        let mut response = request.send().await.map_err(|error| {
            DownloaderFailure::new(
                "download_transfer",
                map_transfer_error(error.is_timeout(), error.is_connect()),
            )
        })?;
        if !is_trusted_apple_download_url(response.url()) {
            return Err(DownloaderFailure::new(
                "download_redirect",
                "download_redirect_rejected",
            ));
        }
        let status = response.status();
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && offset > 0 {
            let complete_length = response
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .and_then(parse_unsatisfied_content_range);
            if complete_length == Some(offset) {
                return Ok(());
            }
        }
        let (write_offset, total_size) =
            if status == reqwest::StatusCode::PARTIAL_CONTENT && offset > 0 {
                let content_range = response
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|value| value.to_str().ok())
                    .and_then(parse_content_range);
                if content_range.is_none_or(|(start, end, total)| {
                    start != offset || end < start || total.is_some_and(|size| size <= end)
                }) {
                    remove_download_partial(destination, metadata_path);
                    if attempt + 1 < MAX_DOWNLOAD_ATTEMPTS {
                        continue;
                    }
                    return Err(DownloaderFailure::new(
                        "download_transfer",
                        "download_range_invalid",
                    ));
                }
                (offset, content_range.and_then(|(_, _, total)| total))
            } else if status == reqwest::StatusCode::PARTIAL_CONTENT {
                return Err(DownloaderFailure::new(
                    "download_transfer",
                    "download_range_invalid",
                ));
            } else if status.is_success() {
                offset = 0;
                let total = response.content_length();
                remove_download_partial(destination, metadata_path);
                (0, total)
            } else {
                let code = if status.is_redirection() {
                    "download_redirect_rejected"
                } else if status.as_u16() == 429 {
                    "apple_rate_limited"
                } else {
                    "download_http_rejected"
                };
                return Err(DownloaderFailure::new("download_transfer", code));
            };
        if total_size.is_some_and(|size| size > max_bytes) || write_offset > max_bytes {
            return Err(DownloaderFailure::new(
                "download_transfer",
                "download_too_large",
            ));
        }
        if let Some(etag) = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.starts_with("W/"))
        {
            save_download_etag(metadata_path, etag).map_err(|_| {
                DownloaderFailure::new("download_staging", "download_disk_write_failed")
            })?;
        } else if write_offset == 0 {
            let _ = fs::remove_file(metadata_path);
        }
        let mut output = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(write_offset > 0)
            .truncate(write_offset == 0)
            .mode(0o600)
            .open(destination)
            .await
            .map_err(|_| {
                DownloaderFailure::new("download_staging", "download_disk_write_failed")
            })?;
        let mut downloaded = write_offset;
        while let Some(chunk) = response.chunk().await.map_err(|error| {
            DownloaderFailure::new(
                "download_transfer",
                map_transfer_error(error.is_timeout(), error.is_connect()),
            )
        })? {
            downloaded = downloaded
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| DownloaderFailure::new("download_transfer", "download_too_large"))?;
            if downloaded > max_bytes || total_size.is_some_and(|size| downloaded > size) {
                return Err(DownloaderFailure::new(
                    "download_transfer",
                    "download_too_large",
                ));
            }
            tokio::io::AsyncWriteExt::write_all(&mut output, &chunk)
                .await
                .map_err(|_| {
                    DownloaderFailure::new("download_staging", "download_disk_write_failed")
                })?;
        }
        tokio::io::AsyncWriteExt::flush(&mut output)
            .await
            .map_err(|_| {
                DownloaderFailure::new("download_staging", "download_disk_write_failed")
            })?;
        if total_size.is_some_and(|size| downloaded != size) {
            if attempt + 1 < MAX_DOWNLOAD_ATTEMPTS && load_download_etag(metadata_path).is_some() {
                continue;
            }
            return Err(DownloaderFailure::new(
                "download_transfer",
                "download_incomplete",
            ));
        }
        if downloaded == 0 {
            return Err(DownloaderFailure::new(
                "download_transfer",
                "download_empty",
            ));
        }
        return Ok(());
    }
    Err(DownloaderFailure::new(
        "download_transfer",
        "download_transfer_failed",
    ))
}

fn parse_content_range(value: &str) -> Option<(u64, u64, Option<u64>)> {
    let range = value.strip_prefix("bytes ")?;
    let (range, total) = range.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let start = start.parse().ok()?;
    let end = end.parse().ok()?;
    let total = if total == "*" {
        None
    } else {
        Some(total.parse().ok()?)
    };
    if end < start || total.is_some_and(|size| size <= end) {
        return None;
    }
    Some((start, end, total))
}

fn parse_unsatisfied_content_range(value: &str) -> Option<u64> {
    let total = value.strip_prefix("bytes */")?;
    total.parse().ok()
}

fn resumable_download_path(output: &Path) -> Result<PathBuf, &'static str> {
    let parent = output.parent().ok_or("invalid_request")?;
    let filename = output
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("invalid_request")?;
    let path = parent.join(format!(".{filename}.partial"));
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink())
        || fs::symlink_metadata(download_metadata_path(&path))
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err("invalid_request");
    }
    Ok(path)
}

fn download_metadata_path(partial: &Path) -> PathBuf {
    partial.with_extension("partial.json")
}

fn load_download_etag(metadata_path: &Path) -> Option<String> {
    let metadata = fs::read(metadata_path).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&metadata).ok()?;
    value
        .get("etag")?
        .as_str()
        .filter(|value| !value.starts_with("W/") && value.len() <= 512)
        .map(str::to_owned)
}

fn save_download_etag(metadata_path: &Path, etag: &str) -> Result<(), &'static str> {
    let bytes =
        serde_json::to_vec(&serde_json::json!({ "etag": etag })).map_err(|_| "download_failed")?;
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(metadata_path)
        .map_err(|_| "download_failed")?;
    file.write_all(&bytes).map_err(|_| "download_failed")?;
    file.sync_all().map_err(|_| "download_failed")
}

fn has_resumable_download_state(partial: &Path, metadata_path: &Path) -> bool {
    fs::metadata(partial).is_ok_and(|metadata| metadata.len() > 0)
        && load_download_etag(metadata_path).is_some()
}

fn remove_download_partial(partial: &Path, metadata_path: &Path) {
    let _ = fs::remove_file(partial);
    let _ = fs::remove_file(metadata_path);
}

fn map_transfer_error(is_timeout: bool, is_connect: bool) -> &'static str {
    if is_timeout {
        "download_transfer_timed_out"
    } else if is_connect {
        "download_transfer_network_unavailable"
    } else {
        "download_transfer_failed"
    }
}

struct TemporaryFile {
    path: PathBuf,
    keep: bool,
}

impl TemporaryFile {
    fn new(path: PathBuf) -> Self {
        Self { path, keep: false }
    }

    fn keep(&mut self) {
        self.keep = true;
    }
}

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_file(&self.path);
        }
    }
}

struct TemporaryDownload {
    path: PathBuf,
    metadata_path: PathBuf,
    keep: bool,
}

impl TemporaryDownload {
    fn new(path: PathBuf, metadata_path: PathBuf) -> Self {
        Self {
            path,
            metadata_path,
            keep: false,
        }
    }

    fn keep(&mut self) {
        self.keep = true;
    }

    fn remove(&mut self) {
        remove_download_partial(&self.path, &self.metadata_path);
        self.keep = true;
    }
}

impl Drop for TemporaryDownload {
    fn drop(&mut self) {
        if !self.keep {
            remove_download_partial(&self.path, &self.metadata_path);
        }
    }
}

#[cfg(test)]
fn temporary_download_path(output: &Path) -> Result<(PathBuf, fs::File), &'static str> {
    let parent = output.parent().ok_or("invalid_request")?;
    for _ in 0..8 {
        let mut random = [0_u8; 8];
        getrandom::fill(&mut random).map_err(|_| "internal_error")?;
        let suffix = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let candidate = parent.join(format!(".dkrypt-download-{suffix}.ipa"));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("download_failed"),
        }
    }
    Err("download_failed")
}

fn ensure_private_directory(path: &Path) -> Result<(), &'static str> {
    fs::create_dir_all(path).map_err(|_| "invalid_environment")?;
    fs::set_permissions(path, Permissions::from_mode(0o700)).map_err(|_| "invalid_environment")
}

fn cache_directory(session_directory: &Path) -> Result<PathBuf, &'static str> {
    let cache = std::env::var_os("DKRYPT_APPSTORE_CACHE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| session_directory.join("cache"));
    fs::create_dir_all(&cache).map_err(|_| "invalid_environment")?;
    Ok(cache)
}

fn account_path(session_directory: &Path) -> PathBuf {
    session_directory.join("account.json")
}

fn load_account(session_directory: &Path) -> Result<Option<Account>, &'static str> {
    let path = account_path(session_directory);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("session_invalid"),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 64 * 1024 {
        return Err("session_invalid");
    }
    let mut account: Account =
        serde_json::from_slice(&fs::read(path).map_err(|_| "session_invalid")?)
            .map_err(|_| "session_invalid")?;
    if !valid_email(&account.email)
        || account.password_token.is_empty()
        || account.directory_services_id.is_empty()
    {
        return Err("session_invalid");
    }
    account.password = None;
    Ok(Some(account))
}

fn save_account(session_directory: &Path, mut account: Account) -> Result<(), &'static str> {
    ensure_private_directory(session_directory)?;
    account.password = None;
    let encoded = serde_json::to_vec(&account).map_err(|_| "internal_error")?;
    let target = account_path(session_directory);
    let mut random = [0_u8; 8];
    getrandom::fill(&mut random).map_err(|_| "internal_error")?;
    let suffix = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let temporary = session_directory.join(format!(".account-{suffix}.tmp"));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|_| "session_write_failed")?;
    file.write_all(&encoded)
        .map_err(|_| "session_write_failed")?;
    file.sync_all().map_err(|_| "session_write_failed")?;
    fs::rename(&temporary, &target).map_err(|_| "session_write_failed")?;
    fs::set_permissions(&target, Permissions::from_mode(0o600)).map_err(|_| "session_write_failed")
}

#[derive(Serialize, Deserialize)]
struct StoredIdentity {
    hardware_id: [u8; 6],
}

fn load_or_create_identity(session_directory: &Path) -> Result<MachineIdentity, &'static str> {
    ensure_private_directory(session_directory)?;
    let path = session_directory.join("identity.json");
    let hardware_id = match fs::read(&path) {
        Ok(bytes) => {
            let identity: StoredIdentity =
                serde_json::from_slice(&bytes).map_err(|_| "session_invalid")?;
            identity.hardware_id
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut identity = StoredIdentity {
                hardware_id: [0; 6],
            };
            getrandom::fill(&mut identity.hardware_id).map_err(|_| "internal_error")?;
            let bytes = serde_json::to_vec(&identity).map_err(|_| "internal_error")?;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
                .map_err(|_| "session_write_failed")?;
            file.write_all(&bytes).map_err(|_| "session_write_failed")?;
            file.sync_all().map_err(|_| "session_write_failed")?;
            identity.hardware_id
        }
        Err(_) => return Err("session_invalid"),
    };
    let guid = hardware_id
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<String>();
    Ok(MachineIdentity {
        guid,
        hardware_id: hardware_id.to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        DownloaderFailure, Response, country_code_from_storefront, load_account,
        map_authentication_error, map_download_diagnostic, map_download_error,
        map_license_claim_error, map_lookup_error, parse_content_range, parse_retry_after_seconds,
        parse_unsatisfied_content_range, resumable_download_path, save_account,
        should_claim_free_license, supports_single_byte_range, temporary_download_path,
        valid_bundle_id, valid_email, valid_verification_code, verify_requested_version,
    };
    use dkrypt_appstore_core::error::{ClientError, StoreError};
    use dkrypt_appstore_core::model::Account;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    #[test]
    fn accepts_normal_apple_account_addresses() {
        assert!(valid_email("person@example.com"));
    }

    #[test]
    fn rejects_malformed_account_addresses() {
        assert!(!valid_email("person"));
        assert!(!valid_email("person@.example.com"));
    }

    #[test]
    fn accepts_app_bundle_identifiers() {
        assert!(valid_bundle_id("com.example.app-2"));
    }

    #[test]
    fn rejects_bundle_identifiers_that_could_be_paths() {
        assert!(!valid_bundle_id("../outside"));
        assert!(!valid_bundle_id("com..example"));
    }

    #[test]
    fn only_accepts_six_digit_verification_codes() {
        assert!(valid_verification_code("123456"));
        assert!(!valid_verification_code("12345x"));
    }

    #[test]
    fn classifies_apple_authentication_failures_without_exposing_provider_details() {
        assert_eq!(
            map_authentication_error(&ClientError::Store(StoreError::InvalidCredentials), false),
            "invalid_credentials"
        );
        assert_eq!(
            map_authentication_error(&ClientError::Store(StoreError::AuthCodeRequired), false),
            "two_factor_required"
        );
        assert_eq!(
            map_authentication_error(&ClientError::Store(StoreError::AuthCodeRequired), true),
            "verification_code_rejected"
        );
        assert_eq!(
            map_authentication_error(
                &ClientError::Store(StoreError::DeviceVerificationFailed),
                false
            ),
            "device_verification_required"
        );
        assert_eq!(
            map_authentication_error(&ClientError::Store(StoreError::RateLimited), false),
            "rate_limited"
        );
        assert_eq!(
            map_authentication_error(
                &ClientError::Store(StoreError::TemporarilyUnavailable),
                false
            ),
            "apple_store_unavailable"
        );
        assert_eq!(
            map_authentication_error(&ClientError::SapSignatureRequired { status: 403 }, false),
            "action_signature_rejected"
        );
        assert_eq!(
            map_authentication_error(&ClientError::Sap("signing failed".into()), false),
            "action_signing_failed"
        );
    }

    #[test]
    fn classifies_download_metadata_failures_without_exposing_provider_details() {
        assert_eq!(
            map_download_error(&ClientError::Store(StoreError::LicenseNotFound)),
            "app_not_owned"
        );
        assert_eq!(
            map_download_error(&ClientError::Store(StoreError::AuthCodeRequired)),
            "two_factor_required"
        );
        assert_eq!(
            map_download_error(&ClientError::Store(StoreError::Unknown {
                code: "secret-store-code".into(),
                message: "secret provider response".into(),
            })),
            "download_info_rejected"
        );
        assert_eq!(
            map_download_error(&ClientError::UnexpectedResponse("missing songList".into())),
            "download_info_song_list_missing"
        );
        assert_eq!(
            map_download_error(&ClientError::UnexpectedResponse("invalid songList".into())),
            "download_info_song_list_invalid"
        );
        assert_eq!(
            map_download_error(&ClientError::UnexpectedResponse("empty songList".into())),
            "download_info_song_list_empty"
        );
        assert_eq!(
            map_download_error(&ClientError::UnexpectedResponse(
                "redownload_product_endpoint_missing".into()
            )),
            "download_info_redownload_product_endpoint_missing"
        );
        assert_eq!(
            map_download_error(&ClientError::UnexpectedResponse(
                "redownload_product_request_timed_out".into()
            )),
            "download_info_redownload_product_request_timed_out"
        );
        assert_eq!(
            map_download_error(&ClientError::UnexpectedResponse(
                "redownload_version_lookup_id_missing".into()
            )),
            "download_info_redownload_version_lookup_failed"
        );
        assert_eq!(
            map_download_error(&ClientError::UnexpectedResponse(
                "redownload_version_lookup_http_failed;http_status=429".into()
            )),
            "download_info_redownload_version_lookup_http_failed"
        );
        assert_eq!(
            map_download_error(&ClientError::UnexpectedResponse(
                "redownload_product_response_invalid|http_status=403".into()
            )),
            "download_info_redownload_product_response_invalid"
        );
        assert_eq!(
            map_download_error(&ClientError::UnexpectedResponse(
                "update_product_bag_unavailable".into()
            )),
            "download_info_update_product_bag_unavailable"
        );
        assert_eq!(
            map_download_error(&ClientError::UnexpectedResponse(
                "update_product_endpoint_missing".into()
            )),
            "download_info_update_product_endpoint_missing"
        );
        assert_eq!(
            map_download_error(&ClientError::UnexpectedResponse(
                "update_product_request_timed_out".into()
            )),
            "download_info_update_product_request_timed_out"
        );
        assert_eq!(
            map_download_error(&ClientError::UnexpectedResponse(
                "update_product_request_network_unavailable".into()
            )),
            "download_info_update_product_request_network_unavailable"
        );
        assert_eq!(
            map_download_error(&ClientError::UnexpectedResponse(
                "update_product_response_invalid".into()
            )),
            "download_info_update_product_response_invalid"
        );
        assert_eq!(
            map_download_error(&ClientError::UnexpectedResponse(
                "update_product_empty_song_list".into()
            )),
            "download_info_update_product_empty_song_list"
        );
        assert_eq!(
            map_download_error(&ClientError::UnexpectedResponse("private response".into())),
            "download_info_response_invalid"
        );
    }

    #[test]
    fn catalog_lookup_diagnostics_keep_only_safe_failure_metadata() {
        let error = ClientError::UnexpectedResponse(
            "redownload_version_lookup_http_failed;http_status=429".into(),
        );
        assert_eq!(
            map_download_diagnostic(&error).as_deref(),
            Some("http_failed;http_status=429")
        );
    }

    #[test]
    fn claims_a_license_only_for_an_unowned_free_app() {
        assert!(should_claim_free_license(
            Some(0.0),
            &ClientError::Store(StoreError::LicenseNotFound)
        ));
        assert!(!should_claim_free_license(
            Some(1.0),
            &ClientError::Store(StoreError::LicenseNotFound)
        ));
        assert!(!should_claim_free_license(
            Some(0.0),
            &ClientError::Store(StoreError::TemporarilyUnavailable)
        ));
        assert!(!should_claim_free_license(
            None,
            &ClientError::Store(StoreError::LicenseNotFound)
        ));
    }

    #[test]
    fn rejects_unknown_storefronts_instead_of_guessing_a_country() {
        assert_eq!(country_code_from_storefront("143443-1,29").unwrap(), "DE");
        let error = country_code_from_storefront("999999").unwrap_err();
        assert_eq!(error.stage, "app_lookup");
        assert_eq!(error.code, "storefront_unrecognized");
    }

    #[test]
    fn successful_download_reports_a_free_license_claim_without_exposing_account_data() {
        assert_eq!(
            serde_json::to_value(Response::success(true, "DE", Some("4567".into()))).unwrap(),
            serde_json::json!({"ok": true, "free_license_claimed": true, "storefront_country": "DE", "external_version_id": "4567"})
        );
        assert_eq!(
            serde_json::to_value(Response::success(false, "DE", None)).unwrap(),
            serde_json::json!({"ok": true, "free_license_claimed": false, "storefront_country": "DE"})
        );
    }

    #[test]
    fn authentication_status_reports_only_a_recognized_storefront_country() {
        assert_eq!(
            serde_json::to_value(Response::authenticated(true, Some("DE"))).unwrap(),
            serde_json::json!({"ok": true, "authenticated": true, "storefront_country": "DE"})
        );
        assert_eq!(
            serde_json::to_value(Response::authenticated(false, None)).unwrap(),
            serde_json::json!({"ok": true, "authenticated": false})
        );
    }

    #[test]
    fn maps_license_claim_errors_to_safe_recovery_codes() {
        let two_factor = map_license_claim_error(&ClientError::Store(StoreError::AuthCodeRequired));
        assert_eq!(two_factor.stage, "license_acquisition");
        assert_eq!(two_factor.code, "two_factor_required");

        let verification =
            map_license_claim_error(&ClientError::Store(StoreError::DeviceVerificationFailed));
        assert_eq!(verification.code, "device_verification_required");

        let purchase_error =
            map_license_claim_error(&ClientError::Store(StoreError::PurchaseFailed));
        assert_eq!(purchase_error.code, "free_license_purchase_rejected");
        assert!(purchase_error.diagnostic.is_none());

        let provider_error = map_license_claim_error(&ClientError::Store(StoreError::Unknown {
            code: "2059".into(),
            message: "private provider message".into(),
        }));
        assert_eq!(provider_error.code, "free_license_claim_rejected");
        assert_eq!(
            provider_error.diagnostic.as_deref(),
            Some("apple_error_code=2059")
        );

        let untrusted_provider_error =
            map_license_claim_error(&ClientError::Store(StoreError::Unknown {
                code: "private-provider-code".into(),
                message: "private provider message".into(),
            }));
        assert_eq!(untrusted_provider_error.code, "free_license_claim_failed");
        assert!(untrusted_provider_error.diagnostic.is_none());

        let malformed_response = map_license_claim_error(&ClientError::UnexpectedResponse(
            "appstore_response_invalid|http_status=403;content_type=html;body_format=html;body_length=34;server=apple;commerce_header_count=0".into(),
        ));
        assert_eq!(
            malformed_response.code,
            "free_license_claim_response_invalid"
        );
        assert_eq!(
            malformed_response.diagnostic.as_deref(),
            Some(
                "http_status=403;content_type=html;body_format=html;body_length=34;server=apple;commerce_header_count=0"
            )
        );

        let invalid_request = map_license_claim_error(&ClientError::UnexpectedResponse(
            "purchase_pod_invalid".into(),
        ));
        assert_eq!(invalid_request.code, "free_license_claim_request_invalid");
        assert_eq!(
            invalid_request.diagnostic.as_deref(),
            Some("reason=purchase_pod_invalid")
        );
    }

    #[test]
    fn preserves_only_safe_update_product_response_metadata() {
        let diagnostic = "http_status=403;content_type=html;body_format=html;body_length=34";
        let error = ClientError::UnexpectedResponse(format!(
            "update_product_response_invalid|{diagnostic}"
        ));
        let failure = DownloaderFailure::from_download_error("download_info", &error);
        assert_eq!(
            failure.code,
            "download_info_update_product_response_invalid"
        );
        assert_eq!(failure.diagnostic.as_deref(), Some(diagnostic));
        assert_eq!(map_download_diagnostic(&error).as_deref(), Some(diagnostic));
    }

    #[test]
    fn preserves_only_safe_ent_download_response_metadata() {
        let diagnostic = "http_status=403;content_type=xml;body_format=empty;body_length=0;server=apple;commerce_header_count=0";
        let error =
            ClientError::UnexpectedResponse(format!("ent_download_response_invalid|{diagnostic}"));
        let failure = DownloaderFailure::from_download_error("download_info", &error);
        assert_eq!(failure.code, "download_info_ent_download_response_invalid");
        assert_eq!(failure.diagnostic.as_deref(), Some(diagnostic));
        assert_eq!(map_download_diagnostic(&error).as_deref(), Some(diagnostic));
    }

    #[test]
    fn preserves_only_safe_redownload_response_metadata() {
        let diagnostic = "http_status=403;content_type=xml;body_format=empty;body_length=0";
        let error = ClientError::UnexpectedResponse(format!(
            "redownload_product_response_invalid|{diagnostic}"
        ));
        let failure = DownloaderFailure::from_download_error("download_info", &error);
        assert_eq!(
            failure.code,
            "download_info_redownload_product_response_invalid"
        );
        assert_eq!(failure.diagnostic.as_deref(), Some(diagnostic));
        assert_eq!(map_download_diagnostic(&error).as_deref(), Some(diagnostic));
    }

    #[test]
    fn classifies_app_lookup_failures_without_exposing_response_contents() {
        assert_eq!(
            map_lookup_error(&ClientError::UnexpectedResponse("private response".into())),
            "app_lookup_response_invalid"
        );
    }

    #[test]
    fn accepts_only_the_requested_app_store_version() {
        assert!(verify_requested_version(Some("123456"), Some("123456")).is_ok());
        assert_eq!(
            verify_requested_version(Some("654321"), Some("123456")),
            Err("version_mismatch")
        );
        assert_eq!(
            verify_requested_version(None, Some("123456")),
            Err("version_unverified")
        );
        assert!(verify_requested_version(None, None).is_ok());
    }

    #[test]
    fn creates_a_private_temporary_download_file_without_reopening_it() {
        let directory = tempdir().expect("create temporary directory");
        let output = directory.path().join("app.ipa");
        let (temporary_path, mut file) =
            temporary_download_path(&output).expect("create download file");
        file.write_all(b"ipa data").expect("write download file");

        assert_eq!(
            std::fs::read(&temporary_path).expect("read download file"),
            b"ipa data"
        );
        assert_eq!(
            std::fs::metadata(temporary_path)
                .expect("inspect download file")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn parses_content_ranges_for_safe_resume_offsets() {
        assert_eq!(
            parse_content_range("bytes 1024-2047/4096"),
            Some((1024, 2047, Some(4096)))
        );
        assert_eq!(
            parse_content_range("bytes 1024-2047/*"),
            Some((1024, 2047, None))
        );
        assert_eq!(parse_content_range("bytes 0-9/10"), Some((0, 9, Some(10))));
        assert_eq!(parse_content_range("items 1024-2047/4096"), None);
        assert_eq!(parse_content_range("bytes 2048-1024/4096"), None);
    }

    #[test]
    fn parses_unsatisfied_ranges_for_completed_partial_files() {
        assert_eq!(parse_unsatisfied_content_range("bytes */4096"), Some(4096));
        assert_eq!(parse_unsatisfied_content_range("bytes 1-4/5"), None);
    }

    #[test]
    fn accepts_only_valid_single_byte_range_probes() {
        assert!(supports_single_byte_range(
            reqwest::StatusCode::PARTIAL_CONTENT,
            Some("bytes 0-0/1024"),
        ));
        assert!(supports_single_byte_range(
            reqwest::StatusCode::PARTIAL_CONTENT,
            Some("bytes 0-0/*"),
        ));
        assert!(!supports_single_byte_range(
            reqwest::StatusCode::PARTIAL_CONTENT,
            Some("bytes 1-1/1024"),
        ));
        assert!(!supports_single_byte_range(
            reqwest::StatusCode::OK,
            Some("bytes 0-0/1024"),
        ));
        assert!(!supports_single_byte_range(
            reqwest::StatusCode::PARTIAL_CONTENT,
            Some("bytes 0-0/0"),
        ));
    }

    #[test]
    fn parses_retry_after_seconds_without_accepting_invalid_values() {
        assert_eq!(parse_retry_after_seconds(" 30 "), Some(30));
        assert_eq!(parse_retry_after_seconds("0"), None);
        assert_eq!(parse_retry_after_seconds("later"), None);
    }

    #[test]
    fn resumes_downloads_at_a_stable_private_partial_path() {
        let directory = tempdir().expect("create temporary directory");
        let output = directory.path().join("app.ipa");
        let partial = resumable_download_path(&output).expect("get resumable path");
        assert_eq!(partial, directory.path().join(".app.ipa.partial"));
        std::fs::write(&partial, b"partial").expect("write prior partial");
        assert_eq!(
            resumable_download_path(&output).expect("reuse partial path"),
            partial
        );
    }

    #[test]
    fn saved_provider_account_does_not_retain_the_apple_password() {
        let directory = tempdir().expect("create temporary directory");
        let account = Account {
            email: "person@example.test".into(),
            password_token: "session-token".into(),
            directory_services_id: "12345".into(),
            name: String::new(),
            store_front: "143441-1,29".into(),
            pod: None,
            password: Some("apple-password".into()),
        };
        save_account(directory.path(), account).expect("save provider account");
        let stored = std::fs::read_to_string(directory.path().join("account.json"))
            .expect("read stored account");

        assert!(!stored.contains("apple-password"));
        assert!(
            load_account(directory.path())
                .expect("load provider account")
                .expect("provider account")
                .password
                .is_none()
        );
    }
}
