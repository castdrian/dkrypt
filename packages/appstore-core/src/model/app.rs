use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct App {
    #[serde(rename = "trackId")]
    pub id: i64,
    #[serde(rename = "bundleId")]
    pub bundle_id: String,
    #[serde(rename = "trackName")]
    pub name: String,
    pub version: Option<String>,
    pub price: Option<f64>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}
#[derive(Debug, Deserialize)]
pub struct SearchResponse {
    #[serde(rename = "resultCount")]
    pub count: u32,
    pub results: Vec<App>,
}

#[cfg(test)]
mod tests {
    use super::App;

    #[test]
    fn missing_price_remains_unknown() {
        let app: App = serde_json::from_value(serde_json::json!({
            "trackId": 12345,
            "bundleId": "com.example.app",
            "trackName": "Example"
        }))
        .unwrap();

        assert_eq!(app.price, None);
    }
}
