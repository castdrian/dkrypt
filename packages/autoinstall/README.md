# autoinstall

The dkrypt device-side tweak for headless App Store and TestFlight installs on jailbroken iOS.

It injects into SpringBoard, TestFlight, App Store, and PassbookUIService to launch apps with the screen dark, request installs through the device's already-signed-in account, and confirm the App Store install sheet without a tap.

Starting with 1.7.0, dkrypt prefers the standalone `autoinstall-appstore` helper for App Store installs. It calls `appstored` directly without opening App Store or arming accessibility confirmation. Older packages and devices without the required private interfaces retain the App Store bridge path. A failed or uncertain submitted purchase never falls back to another backend.

The helper runs as `mobile`, including when invoked from root SSH sessions. Before a verified-free purchase, it repairs biometric opt-in only when the active account has no valid biometric identity. It preserves working biometric authorization and does not change account password settings. Authorization prompts still require action on the device.

Installed-bundle inspection parses the exact bundle identifier, checks the executable, and validates the union of `SinfPaths` and `SinfReplicationPaths`. Versioned SINF and SUPF licenses remain supported. An empty `SC_Info` directory is insufficient.

## Device requirements

- Rootless jailbreak with ElleKit
- An Apple ID signed in to App Store and TestFlight
- No device passcode

OpenSSH is only needed for the initial package install and for repairing a missing device agent. After installation, dkrypt reaches the device through the authenticated loopback agent on the USBMux connection, including preflight, bridge actions, and SpringBoard recovery. The agent is not exposed on the device network. Wi-Fi-only connections still use OpenSSH.

## Build

The build host needs Theos.

```sh
gmake clean package
```

The package is written to `packages/dev.adrian.autoinstall_<version>_iphoneos-arm64.deb`.

Run the Foundation-based regression tests on macOS with `make autoinstall-test` from the repository root. They cover free-purchase validation, sanitized store errors, incomplete bundles, extension licenses, and path traversal. These tests do not replace a live iOS purchase test.

From the repository root, use the release rail to build, install, restart SpringBoard, check the heartbeat, and roll back when possible:

```sh
make autoinstall-deploy
moon run autoinstall:package
```

## Device agent

The package includes `autoinstall-device-agent`, a launch daemon that listens on `127.0.0.1:5913`. dkrypt forwards that port over the paired USBMux connection. The first connection bootstraps the per-device secret; all later requests use signed, replay-limited frames and can execute the existing bridge commands without opening a new SSH session.

## Bridge

dkrypt communicates through authenticated, per-operation files under `/tmp/autoinstall/v1`.

| Channel | Capabilities |
| --- | --- |
| SpringBoard | App launch, dark display mode, screen status |
| TestFlight | Trains, builds, installs, diagnostics |
| App Store | Current and pinned-version installs, diagnostics |

Each response carries the request ID. Transactions and heartbeat files are persisted per channel so dkrypt can recover safely after interruptions.

## Safety

The tweak only automates installs using the Apple ID already present on the device. dkrypt never receives Apple credentials. Keep the pairing host trusted and keep OpenSSH restricted when it is enabled for bootstrap or Wi-Fi access.

The direct helper persists purchase operation results under `/var/mobile/Library/Caches/dev.adrian.autoinstall.appstore` to avoid resubmitting the same operation. Reusing an operation ID with different app or build parameters is rejected. An interrupted operation remains uncertain until checked on the device. Error responses include error domains, codes, and dialog identifiers, excluding raw account and purchase-replay payloads.

The App Store implementation draws on the [appstorectl private-API research](https://github.com/appknox/appstorectl/blob/master/docs/HOW-IT-WORKS.md). Private API availability and device authorization behavior must be validated on each supported iOS release.
