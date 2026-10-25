use crate::client::AppleClient;
use crate::error::{ClientError, StoreError};
use crate::model::{Account, App};
use std::collections::HashMap;
use std::time::Duration;
use url::Url;

const PURCHASE_PATH: &str = "/WebObjects/MZFinance.woa/wa/buyProduct";
const PURCHASE_TIMEOUT: Duration = Duration::from_secs(45);
const STANDARD_FREE_LICENSE_PRICING_PARAMETER: &str = "STDQ";
const ALTERNATE_FREE_LICENSE_PRICING_PARAMETER: &str = "GAME";

pub async fn claim_free_license(
    client: &AppleClient,
    app: &App,
    account: &Account,
) -> Result<(), ClientError> {
    if app.price != Some(0.0) {
        return Err(ClientError::UnexpectedResponse(
            "paid_app_purchase_not_supported".into(),
        ));
    }
    match submit_free_license_purchase(
        client,
        app,
        account,
        STANDARD_FREE_LICENSE_PRICING_PARAMETER,
    )
    .await
    {
        Err(error) => match retry_pricing_parameter(&error) {
            Some(pricing_parameter) => {
                tracing::warn!(
                    app_id = app.id,
                    "retrying free-license claim with alternate pricing parameter"
                );
                submit_free_license_purchase(client, app, account, pricing_parameter).await
            }
            None => Err(error),
        },
        result => result,
    }
}

async fn submit_free_license_purchase(
    client: &AppleClient,
    app: &App,
    account: &Account,
    pricing_parameter: &str,
) -> Result<(), ClientError> {
    let (url, body) = build_purchase_request(client.guid(), app, account, pricing_parameter)?;
    let response = client
        .app_store_dispatch_http()?
        .post(url)
        .header("Content-Type", "application/x-apple-plist")
        .header("iCloud-DSID", &account.directory_services_id)
        .header("X-Dsid", &account.directory_services_id)
        .header("X-Apple-Store-Front", &account.store_front)
        .header("X-Token", &account.password_token)
        .timeout(PURCHASE_TIMEOUT)
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
    let body = response.bytes().await?;
    parse_purchase_response(status, &body).map_err(|error| {
        classify_invalid_purchase_response(
            error,
            status,
            content_type.as_deref(),
            &body,
            &response_headers,
        )
    })
}

fn build_purchase_request(
    guid: &str,
    app: &App,
    account: &Account,
    pricing_parameter: &str,
) -> Result<(Url, Vec<u8>), ClientError> {
    if app.id <= 0 {
        return Err(ClientError::UnexpectedResponse(
            "purchase_app_id_invalid".into(),
        ));
    }
    if account.directory_services_id.parse::<u64>().is_err() || account.store_front.is_empty() {
        return Err(ClientError::UnexpectedResponse(
            "purchase_account_invalid".into(),
        ));
    }
    let host = match account.pod.as_deref() {
        Some(pod)
            if !pod.is_empty()
                && pod.len() <= 3
                && pod.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            format!("p{pod}-buy.itunes.apple.com")
        }
        Some(_) => {
            return Err(ClientError::UnexpectedResponse(
                "purchase_pod_invalid".into(),
            ));
        }
        None => "buy.itunes.apple.com".into(),
    };
    let url = Url::parse(&format!("https://{host}{PURCHASE_PATH}"))
        .map_err(|_| ClientError::UnexpectedResponse("purchase_url_invalid".into()))?;
    let mut payload = plist::Dictionary::new();
    for (key, value) in [
        ("appExtVrsId", "0".to_string()),
        ("hasAskedToFulfillPreorder", "true".to_string()),
        ("buyWithoutAuthorization", "true".to_string()),
        ("hasDoneAgeCheck", "true".to_string()),
        ("guid", guid.to_string()),
        ("needDiv", "0".to_string()),
        ("origPage", format!("Software-{}", app.id)),
        ("origPageLocation", "Buy".to_string()),
        ("price", "0".to_string()),
        ("pricingParameters", pricing_parameter.to_string()),
        ("productType", "C".to_string()),
    ] {
        payload.insert(key.into(), plist::Value::String(value));
    }
    payload.insert(
        "salableAdamId".into(),
        plist::Value::String(app.id.to_string()),
    );
    let mut body = Vec::new();
    plist::to_writer_xml(&mut body, &plist::Value::Dictionary(payload))
        .map_err(|_| ClientError::UnexpectedResponse("purchase_request_invalid".into()))?;
    Ok((url, body))
}

fn retry_pricing_parameter(error: &ClientError) -> Option<&'static str> {
    matches!(
        error,
        ClientError::Store(StoreError::TemporarilyUnavailable)
    )
    .then_some(ALTERNATE_FREE_LICENSE_PRICING_PARAMETER)
}

fn parse_purchase_response(status: reqwest::StatusCode, body: &[u8]) -> Result<(), ClientError> {
    let response: HashMap<String, plist::Value> =
        crate::client::plist_xml::parse_plist_response(body)?;
    if let Some(error) = StoreError::from_plist_dict(&response) {
        return if matches!(error, StoreError::LicenseAlreadyExists) {
            Ok(())
        } else {
            Err(ClientError::Store(error))
        };
    }
    if status == reqwest::StatusCode::INTERNAL_SERVER_ERROR {
        return Ok(());
    }
    if !status.is_success() {
        return Err(ClientError::UnexpectedResponse(
            "purchase_http_failed".into(),
        ));
    }
    let purchase_succeeded = response
        .get("jingleDocType")
        .and_then(plist::Value::as_string)
        == Some("purchaseSuccess");
    let status_succeeded = response
        .get("status")
        .and_then(plist::Value::as_unsigned_integer)
        == Some(0);
    if purchase_succeeded && status_succeeded {
        Ok(())
    } else {
        Err(ClientError::Store(StoreError::PurchaseFailed))
    }
}

fn classify_invalid_purchase_response(
    error: ClientError,
    status: reqwest::StatusCode,
    content_type: Option<&str>,
    body: &[u8],
    headers: &reqwest::header::HeaderMap,
) -> ClientError {
    match error {
        ClientError::PlistDe(_) => ClientError::UnexpectedResponse(
            super::download::response_diagnostic(status.as_u16(), content_type, body, headers),
        ),
        error => error,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ALTERNATE_FREE_LICENSE_PRICING_PARAMETER, STANDARD_FREE_LICENSE_PRICING_PARAMETER,
        build_purchase_request, claim_free_license, classify_invalid_purchase_response,
        parse_purchase_response, retry_pricing_parameter,
    };
    use crate::client::AppleClient;
    use crate::error::{ClientError, StoreError};
    use crate::guid::MachineIdentity;
    use crate::model::{Account, App};
    use std::collections::HashMap;

    fn app(price: Option<f64>) -> App {
        App {
            id: 12345,
            bundle_id: "com.example.free".into(),
            name: "Free app".into(),
            version: None,
            price,
            extra: HashMap::new(),
        }
    }

    fn account(pod: Option<&str>) -> Account {
        Account {
            email: "person@example.test".into(),
            password_token: "token".into(),
            directory_services_id: "123456789".into(),
            name: "Person".into(),
            store_front: "143441".into(),
            pod: pod.map(str::to_string),
            password: None,
        }
    }

    fn purchase_response(fields: &[(&str, plist::Value)]) -> Vec<u8> {
        let mut response = plist::Dictionary::new();
        for (key, value) in fields {
            response.insert((*key).into(), value.clone());
        }
        let mut body = Vec::new();
        plist::to_writer_xml(&mut body, &plist::Value::Dictionary(response)).unwrap();
        body
    }

    #[test]
    fn builds_the_free_purchase_request_without_a_guid_query_parameter() {
        let (url, body) = build_purchase_request(
            "AABBCCDDEEFF",
            &app(Some(0.0)),
            &account(Some("14")),
            STANDARD_FREE_LICENSE_PRICING_PARAMETER,
        )
        .unwrap();
        let payload: plist::Dictionary = plist::from_bytes(&body).unwrap();
        assert_eq!(
            url.as_str(),
            "https://p14-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/buyProduct"
        );
        assert!(url.query().is_none());
        assert_eq!(
            payload.get("price").and_then(plist::Value::as_string),
            Some("0")
        );
        assert_eq!(
            payload
                .get("pricingParameters")
                .and_then(plist::Value::as_string),
            Some(STANDARD_FREE_LICENSE_PRICING_PARAMETER)
        );
        assert_eq!(
            payload.get("productType").and_then(plist::Value::as_string),
            Some("C")
        );
        assert_eq!(
            payload.get("guid").and_then(plist::Value::as_string),
            Some("AABBCCDDEEFF")
        );
        assert_eq!(
            payload
                .get("salableAdamId")
                .and_then(plist::Value::as_string),
            Some("12345")
        );
    }

    #[test]
    fn retries_free_license_claims_with_the_alternate_parameter_only_when_temporarily_unavailable()
    {
        assert_eq!(
            retry_pricing_parameter(&ClientError::Store(StoreError::TemporarilyUnavailable)),
            Some(ALTERNATE_FREE_LICENSE_PRICING_PARAMETER)
        );
        assert_eq!(
            retry_pricing_parameter(&ClientError::Store(StoreError::PurchaseFailed)),
            None
        );
        assert_eq!(
            retry_pricing_parameter(&ClientError::Store(StoreError::DeviceVerificationFailed)),
            None
        );
    }

    #[test]
    fn builds_the_alternate_free_purchase_request() {
        let (_, body) = build_purchase_request(
            "AABBCCDDEEFF",
            &app(Some(0.0)),
            &account(None),
            ALTERNATE_FREE_LICENSE_PRICING_PARAMETER,
        )
        .unwrap();
        let payload: plist::Dictionary = plist::from_bytes(&body).unwrap();
        assert_eq!(
            payload
                .get("pricingParameters")
                .and_then(plist::Value::as_string),
            Some(ALTERNATE_FREE_LICENSE_PRICING_PARAMETER)
        );
    }

    #[test]
    fn uses_the_default_purchase_host_without_a_pod() {
        let (url, _) = build_purchase_request(
            "AABBCCDDEEFF",
            &app(Some(0.0)),
            &account(None),
            STANDARD_FREE_LICENSE_PRICING_PARAMETER,
        )
        .unwrap();
        assert_eq!(url.host_str(), Some("buy.itunes.apple.com"));
    }

    #[test]
    fn refuses_paid_or_unknown_price_apps_before_building_a_purchase_request() {
        let client = AppleClient::new(
            MachineIdentity {
                guid: "AABBCCDDEEFF".into(),
                hardware_id: vec![0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF],
            },
            None,
            std::env::temp_dir().join("dkrypt-appstore-purchase-test"),
        )
        .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for price in [Some(0.99), None] {
            let error = runtime
                .block_on(claim_free_license(&client, &app(price), &account(None)))
                .unwrap_err();
            assert!(
                matches!(error, ClientError::UnexpectedResponse(reason) if reason == "paid_app_purchase_not_supported")
            );
        }
    }

    #[test]
    fn accepts_a_successful_purchase_response() {
        let body = purchase_response(&[
            (
                "jingleDocType",
                plist::Value::String("purchaseSuccess".into()),
            ),
            ("status", plist::Value::Integer(0.into())),
        ]);
        assert!(parse_purchase_response(reqwest::StatusCode::OK, &body).is_ok());
    }

    #[test]
    fn classifies_unparseable_purchase_response_without_retaining_body_contents() {
        let body = b"<html>private response body</html>";
        let status = reqwest::StatusCode::FORBIDDEN;
        let parser_error = parse_purchase_response(status, body).unwrap_err();
        let error = classify_invalid_purchase_response(
            parser_error,
            status,
            Some("text/html; charset=utf-8"),
            body,
            &reqwest::header::HeaderMap::new(),
        );
        let ClientError::UnexpectedResponse(diagnostic) = error else {
            panic!("expected a safe invalid-response diagnostic");
        };
        assert!(diagnostic.contains("http_status=403"));
        assert!(diagnostic.contains("content_type=html"));
        assert!(diagnostic.contains("body_format=html"));
        assert!(diagnostic.contains("body_length=34"));
        assert!(!diagnostic.contains("private response body"));
    }

    #[test]
    fn treats_an_existing_license_as_success() {
        let body = purchase_response(&[("failureType", plist::Value::String("5002".into()))]);
        assert!(parse_purchase_response(reqwest::StatusCode::OK, &body).is_ok());
    }

    #[test]
    fn accepts_apples_internal_error_response_as_an_existing_license() {
        let body = purchase_response(&[(
            "jingleDocType",
            plist::Value::String("purchaseSuccess".into()),
        )]);
        assert!(parse_purchase_response(reqwest::StatusCode::INTERNAL_SERVER_ERROR, &body).is_ok());
    }

    #[test]
    fn reports_a_purchase_failure_without_returning_provider_details() {
        let body = purchase_response(&[
            ("failureType", plist::Value::String("2059".into())),
            (
                "customerMessage",
                plist::Value::String("Purchase couldn't be completed".into()),
            ),
        ]);
        assert!(matches!(
            parse_purchase_response(reqwest::StatusCode::OK, &body),
            Err(ClientError::Store(StoreError::PurchaseFailed))
        ));
    }
}
