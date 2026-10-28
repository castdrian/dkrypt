use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Platform {
    #[serde(rename = "iphone")]
    IPhone,
    #[serde(rename = "ipad")]
    IPad,
    #[serde(rename = "appletv")]
    AppleTV,
    #[serde(rename = "visionos")]
    VisionOS,
}
impl Default for Platform {
    fn default() -> Self {
        Self::IPhone
    }
}
impl Platform {
    pub fn search_entity(&self) -> &'static str {
        match self {
            Self::IPhone => "software",
            Self::IPad => "iPadSoftware",
            Self::AppleTV => "tvSoftware",
            Self::VisionOS => "software",
        }
    }
    pub fn lookup_entity(&self) -> &'static str {
        self.search_entity()
    }
    pub fn catalog_platform_name(&self) -> &'static str {
        match self {
            Self::IPhone | Self::IPad => "iphone",
            Self::AppleTV => "appletv",
            Self::VisionOS => "realityDevice",
        }
    }
    pub fn device_family(&self) -> &'static str {
        match self {
            Self::IPhone | Self::IPad => "iphone",
            Self::AppleTV => "tvos",
            Self::VisionOS => "realityDevice",
        }
    }
    pub fn catalog_attribute_name(&self) -> &'static str {
        match self {
            Self::IPhone | Self::IPad => "ios",
            Self::AppleTV => "appletvos",
            Self::VisionOS => "xros",
        }
    }
    pub fn bundle_platform_name(&self) -> Option<&'static str> {
        match self {
            Self::AppleTV => Some("AppleTVOS"),
            Self::VisionOS => Some("XROS"),
            _ => None,
        }
    }
}
impl std::fmt::Display for Platform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::IPhone => write!(f, "iphone"),
            Self::IPad => write!(f, "ipad"),
            Self::AppleTV => write!(f, "appletv"),
            Self::VisionOS => write!(f, "visionos"),
        }
    }
}
impl std::str::FromStr for Platform {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "iphone" => Ok(Self::IPhone),
            "ipad" => Ok(Self::IPad),
            "appletv" | "apple_tv" => Ok(Self::AppleTV),
            "visionos" | "xros" => Ok(Self::VisionOS),
            other => Err(format!("unknown platform: {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Platform;

    #[test]
    fn app_store_catalog_platform_metadata_uses_public_store_values() {
        assert_eq!(Platform::AppleTV.catalog_platform_name(), "appletv");
        assert_eq!(Platform::AppleTV.device_family(), "tvos");
        assert_eq!(Platform::AppleTV.catalog_attribute_name(), "appletvos");
        assert_eq!(Platform::VisionOS.catalog_platform_name(), "realityDevice");
        assert_eq!(Platform::VisionOS.device_family(), "realityDevice");
        assert_eq!(Platform::VisionOS.catalog_attribute_name(), "xros");
    }
}
