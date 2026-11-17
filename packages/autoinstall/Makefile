THEOS_PACKAGE_SCHEME=rootless
FINALPACKAGE=1
INSTALL_TARGET_PROCESSES = TestFlight SpringBoard AppStore PassbookUIService PassbookSecureUIService PassbookUISceneService AuthKitUIService StoreKitUIService AppleIDSetupUIService CoreAuthUI AccountAuthenticationDialog

ARCHS := arm64
TARGET := iphone:clang:latest:15.0

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = autoinstall
autoinstall_FILES = $(shell find sources -name "*.x*" -o -name "*.m*")
autoinstall_CFLAGS = -fobjc-arc -DBRIDGE_VERSION='@"$(THEOS_PACKAGE_BASE_VERSION)"'
autoinstall_FRAMEWORKS = Foundation UIKit StoreKit

TOOL_NAME = autoinstall-device-agent autoinstall-appstore
autoinstall-appstore_FILES = appstore/main.m
autoinstall-appstore_CFLAGS = -fobjc-arc
autoinstall-appstore_FRAMEWORKS = Foundation StoreKit
autoinstall-appstore_CODESIGN_FLAGS = -Sappstore/entitlements.plist
autoinstall-appstore_INSTALL_PATH = /usr/libexec
autoinstall-device-agent_FILES = device-agent/DeviceAgent.m
autoinstall-device-agent_CFLAGS = -fobjc-arc -DAGENT_VERSION='@"$(THEOS_PACKAGE_BASE_VERSION)"'
autoinstall-device-agent_FRAMEWORKS = Foundation
autoinstall-device-agent_INSTALL_PATH = /usr/libexec

BUNDLE_NAME = AutoinstallPrefs
AutoinstallPrefs_FILES = preferences/AutoinstallRootListController.m
AutoinstallPrefs_FRAMEWORKS = UIKit
AutoinstallPrefs_RESOURCE_FILES = preferences/Resources/Info.plist
AutoinstallPrefs_INSTALL_PATH = /Library/PreferenceBundles
AutoinstallPrefs_CFLAGS = -fobjc-arc -DAUTOINSTALL_PREFS_VERSION='@"$(THEOS_PACKAGE_BASE_VERSION)"'
AutoinstallPrefs_LDFLAGS = -undefined dynamic_lookup

include $(THEOS_MAKE_PATH)/tweak.mk

include $(THEOS_MAKE_PATH)/tool.mk

include $(THEOS_MAKE_PATH)/bundle.mk

after-stage::
	mkdir -p $(THEOS_STAGING_DIR)$(THEOS_PACKAGE_INSTALL_PREFIX)/usr/share/doc/dev.adrian.autoinstall
	cp appstore/NOTICE $(THEOS_STAGING_DIR)$(THEOS_PACKAGE_INSTALL_PREFIX)/usr/share/doc/dev.adrian.autoinstall/appstorectl-NOTICE
