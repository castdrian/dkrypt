# Fastlane plugin for dkrypt

`dkrypt_decrypt` submits an App Store or TestFlight decrypt, waits for the existing job, downloads the resulting IPA, and checks its SHA-256 and byte count before making the file available to the lane.

The plugin source ships in this repository and is not published to RubyGems. Add the path to this checkout in the consuming project's `fastlane/Pluginfile`, then run `bundle install`:

```ruby
gem 'fastlane-plugin-dkrypt', path: '../dkrypt/fastlane-plugin-dkrypt'
```

Use the plugin action in a lane:

```ruby
default_platform(:ios)

platform :ios do
  lane :decrypt_release do
    ipa_path = dkrypt_decrypt(
      api_key: ENV.fetch('DKRYPT_API_KEY'),
      bundle_id: 'com.example.app',
      channel: 'testflight'
    )
    UI.message("Verified IPA: #{ipa_path}")
  end
end
```

Set `DKRYPT_API_KEY` in the CI secret store. TestFlight requests may omit `version` to resolve the latest available build, or use an exact selector such as `352.0_118977`. Remote dkrypt instances require HTTPS; plain HTTP is accepted only for localhost. The action only writes the IPA after matching both the reported SHA-256 and byte count.
