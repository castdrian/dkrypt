pub mod cookie_jar;
pub mod plist_xml;
use crate::error::ClientError;
use crate::guid::MachineIdentity;
use crate::model::Account;
use reqwest_cookie_store::CookieStoreMutex;
use std::path::{Path, PathBuf};
use std::sync::Arc;
pub type DownloadHttpClient = reqwest::Client;
const USER_AGENT: &str =
    "Configurator/2.17 (Macintosh; OS X 15.2; 24C5089c) AppleWebKit/0620.1.16.11.6";
fn is_auth_endpoint(url: &reqwest::Url) -> bool {
    url.path()
        .trim_end_matches('/')
        .ends_with("/wa/authenticate")
}
pub fn is_trusted_apple_download_url(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && (host == "apple.com"
            || host.ends_with(".apple.com")
            || host == "mzstatic.com"
            || host.ends_with(".mzstatic.com"))
}
pub struct AppleClient {
    http: reqwest::Client,
    cookie_store: Arc<CookieStoreMutex>,
    machine: MachineIdentity,
    cache_dir: PathBuf,
    account: Option<Account>,
}
impl AppleClient {
    pub fn new(
        machine: MachineIdentity,
        cookie_path: Option<&Path>,
        cache_dir: impl Into<PathBuf>,
    ) -> Result<Self, ClientError> {
        let cookie_store = cookie_jar::new_cookie_store(cookie_path)?;
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .cookie_provider(cookie_store.clone())
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                let from_auth = attempt.previous().last().is_some_and(is_auth_endpoint);
                if from_auth
                    || attempt.previous().len() >= 10
                    || !is_trusted_apple_download_url(attempt.url())
                {
                    attempt.stop()
                } else {
                    attempt.follow()
                }
            }))
            .build()?;
        Ok(Self {
            http,
            cookie_store,
            machine,
            cache_dir: cache_dir.into(),
            account: None,
        })
    }
    pub fn guid(&self) -> &str {
        &self.machine.guid
    }
    pub fn hardware_id(&self) -> &[u8] {
        &self.machine.hardware_id
    }
    pub fn cache_dir(&self) -> &Path {
        &self.cache_dir
    }
    pub fn account(&self) -> Option<&Account> {
        self.account.as_ref()
    }
    pub fn set_account(&mut self, account: Account) {
        self.account = Some(account);
    }
    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }
    pub fn download_http(&self) -> Result<DownloadHttpClient, ClientError> {
        let cookie_store = self.cookie_store.clone();
        reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .cookie_provider(cookie_store)
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 10 || !is_trusted_apple_download_url(attempt.url()) {
                    attempt.stop()
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .map_err(ClientError::from)
    }
    pub fn app_store_dispatch_http(&self) -> Result<DownloadHttpClient, ClientError> {
        reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .cookie_provider(self.cookie_store.clone())
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(ClientError::from)
    }
    pub fn save_cookies(&self, path: &Path) -> Result<(), ClientError> {
        cookie_jar::save_cookie_store(&self.cookie_store, path)
    }
    #[cfg(test)]
    pub(crate) fn for_tests() -> Self {
        Self::new(
            crate::guid::MachineIdentity {
                guid: "AABBCCDDEEFF".into(),
                hardware_id: vec![0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF],
            },
            None,
            std::env::temp_dir().join("dkrypt-appstore-test-cache"),
        )
        .expect("build test client")
    }
}
#[cfg(test)]
mod tests {
    use super::{is_auth_endpoint, is_trusted_apple_download_url};
    fn url(s: &str) -> reqwest::Url {
        reqwest::Url::parse(s).unwrap()
    }
    #[test]
    fn auth_endpoint_matches_with_and_without_trailing_slash() {
        assert!(is_auth_endpoint(&url(
            "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate"
        )));
        assert!(is_auth_endpoint(&url(
            "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate/"
        )));
    }
    #[test]
    fn auth_endpoint_matches_pod_hosts() {
        assert!(is_auth_endpoint(&url(
            "https://p14-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate/"
        )));
    }
    #[test]
    fn non_auth_endpoints_do_not_match() {
        assert!(!is_auth_endpoint(&url(
            "https://p14-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=X"
        )));
        assert!(!is_auth_endpoint(&url(
            "https://init.itunes.apple.com/bag.xml?ix=5"
        )));
    }
    #[test]
    fn download_url_requires_https_and_an_apple_cdn_host() {
        assert!(is_trusted_apple_download_url(&url(
            "https://iosapps.itunes.apple.com/app.ipa"
        )));
        assert!(is_trusted_apple_download_url(&url(
            "https://is1-ssl.mzstatic.com/app.ipa"
        )));
        assert!(!is_trusted_apple_download_url(&url(
            "https://localhost/app.ipa"
        )));
        assert!(!is_trusted_apple_download_url(&url(
            "https://apple.com.attacker.invalid/app.ipa"
        )));
        assert!(!is_trusted_apple_download_url(&url(
            "http://iosapps.itunes.apple.com/app.ipa"
        )));
        assert!(!is_trusted_apple_download_url(&url(
            "https://iosapps.itunes.apple.com:8443/app.ipa"
        )));
    }
}
