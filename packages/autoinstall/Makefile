THEOS_PACKAGE_SCHEME=rootless
FINALPACKAGE=1
INSTALL_TARGET_PROCESSES = TestFlight SpringBoard AppStore PassbookUIService PassbookSecureUIService PassbookUISceneService AuthKitUIService StoreKitUIService AppleIDSetupUIService CoreAuthUI AccountAuthenticationDialog

ARCHS := arm64
TARGET := iphone:clang:latest:15.0

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = autoinstall
autoinstall_FILES = $(shell find sources -name "*.x*" -o -name "*.m*")
autoinstall_CFLAGS = -fobjc-arc -DBRIDGE_VERSION='@"$(THEOS_PACKAGE_BASE_VERSION)"'
autoinstall_FRAMEWORKS = Foundation UIKit

TOOL_NAME = autoinstall-device-agent
autoinstall-device-agent_FILES = device-agent/DeviceAgent.m
autoinstall-device-agent_CFLAGS = -fobjc-arc -DAGENT_VERSION='@"$(THEOS_PACKAGE_BASE_VERSION)"'
autoinstall-device-agent_FRAMEWORKS = Foundation
autoinstall-device-agent_INSTALL_PATH = /usr/libexec

include $(THEOS_MAKE_PATH)/tweak.mk

include $(THEOS_MAKE_PATH)/tool.mk

after-stage::
	$(ECHO_NOTHING)mkdir -p $(THEOS_STAGING_DIR)/Library/LaunchDaemons$(ECHO_END)
	$(ECHO_NOTHING)cp resources/dev.adrian.autoinstall.device-agent.plist $(THEOS_STAGING_DIR)/Library/LaunchDaemons/$(ECHO_END)
