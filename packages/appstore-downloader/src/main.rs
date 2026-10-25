use std::fs::{self, OpenOptions, Permissions};
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process;

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

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
enum Request {
    Status,
    Authenticate {
        apple_id: String,
        password: String,
        verification_code: Option<String>,
    },
    Download {
        apple_id: String,
        password: String,
        bundle_id: String,
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
    stage: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostic: Option<String>,
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
    fn authenticated(value: bool) -> Self {
        Self {
            ok: true,
            authenticated: Some(value),
            stage: None,
            code: None,
            diagnostic: None,
        }
    }

    fn success() -> Self {
        Self {
            ok: true,
            authenticated: None,
            stage: None,
            code: None,
            diagnostic: None,
        }
    }

    fn failure(failure: DownloaderFailure) -> Self {
        Self {
            ok: false,
            authenticated: None,
            stage: Some(failure.stage),
            code: Some(failure.code),
            diagnostic: failure.diagnostic,
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
            external_version_id,
            output_path,
            max_bytes,
        } => {
            if !valid_email(apple_id)
                || password.is_empty()
                || password.len() > 1024
                || !valid_bundle_id(bundle_id)
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
        Request::Status => load_account(&session_directory)
            .map(|account| Response::authenticated(account.is_some()))
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
            external_version_id,
            output_path,
            max_bytes,
        } => {
            download(
                &session_directory,
                &apple_id,
                &password,
                &bundle_id,
                external_version_id.as_deref(),
                &output_path,
                max_bytes.unwrap_or(MAX_APPSTORE_DOWNLOAD_BYTES),
            )
            .await
        }
    }
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
    save_account(session_directory, account).map_err(|_| "provider_session_storage_failed")?;
    client
        .save_cookies(&cookie_path)
        .map_err(|_| "provider_session_storage_failed")?;
    Ok(Response::authenticated(true))
}

async fn download(
    session_directory: &Path,
    apple_id: &str,
    password: &str,
    bundle_id: &str,
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
    let country = dkrypt_appstore_core::model::storefront::country_code_from_store_front(
        &account.store_front,
    )
    .unwrap_or("US");
    let app = api::lookup::lookup(&client, bundle_id, country, Platform::IPhone)
        .await
        .map_err(|error| DownloaderFailure::new("app_lookup", map_lookup_error(&error)))?
        .ok_or_else(|| DownloaderFailure::new("app_lookup", "app_not_found"))?;
    let item = match get_download_info_with_reauthentication(
        &mut client,
        &app,
        &mut account,
        external_version_id,
    )
    .await
    {
        Ok(item) => item,
        Err(error) if should_claim_free_license(app.price, &error) => {
            claim_free_license_with_reauthentication(&mut client, &app, &mut account)
                .await
                .map_err(|error| map_license_claim_error(&error))?;
            match get_download_info_with_reauthentication(
                &mut client,
                &app,
                &mut account,
                external_version_id,
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
    verify_requested_version(
        item.latest_external_version_id().as_deref(),
        external_version_id,
    )
    .map_err(|code| DownloaderFailure::new("version_validation", code))?;
    let (temporary_path, temporary_file) = temporary_download_path(output_path)
        .map_err(|_| DownloaderFailure::new("download_staging", "download_file_failed"))?;
    let mut temporary = TemporaryFile::new(temporary_path.clone());
    let download_client = client
        .download_http()
        .map_err(|_| DownloaderFailure::new("download_client", "download_client_setup_failed"))?;
    stream_download(&download_client, &item.url, temporary_file, max_bytes).await?;
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
    Ok(Response::success())
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

async fn get_download_info_with_reauthentication(
    client: &mut AppleClient,
    app: &App,
    account: &mut Account,
    external_version_id: Option<&str>,
) -> Result<dkrypt_appstore_core::api::download::DownloadItem, ClientError> {
    match api::download::get_download_info(
        client,
        app.id,
        &app.bundle_id,
        account,
        external_version_id,
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
    destination: fs::File,
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
    let mut response = client.get(parsed).send().await.map_err(|error| {
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
    if !status.is_success() {
        let code = if status.is_redirection() {
            "download_redirect_rejected"
        } else if status.as_u16() == 429 {
            "apple_rate_limited"
        } else {
            "download_http_rejected"
        };
        return Err(DownloaderFailure::new("download_transfer", code));
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes)
    {
        return Err(DownloaderFailure::new(
            "download_transfer",
            "download_too_large",
        ));
    }
    let mut output = tokio::fs::File::from_std(destination);
    let mut downloaded = 0_u64;
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        DownloaderFailure::new(
            "download_transfer",
            map_transfer_error(error.is_timeout(), error.is_connect()),
        )
    })? {
        downloaded = downloaded
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| DownloaderFailure::new("download_transfer", "download_too_large"))?;
        if downloaded > max_bytes {
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
        .map_err(|_| DownloaderFailure::new("download_staging", "download_disk_write_failed"))?;
    if downloaded == 0 {
        return Err(DownloaderFailure::new(
            "download_transfer",
            "download_empty",
        ));
    }
    Ok(())
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

    fn remove(&mut self) {
        let _ = fs::remove_file(&self.path);
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
        DownloaderFailure, load_account, map_authentication_error, map_download_diagnostic,
        map_download_error, map_license_claim_error, map_lookup_error, save_account,
        should_claim_free_license, temporary_download_path, valid_bundle_id, valid_email,
        valid_verification_code, verify_requested_version,
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
