require_relative 'lib/fastlane/plugin/dkrypt/version'

Gem::Specification.new do |spec|
  spec.name = 'fastlane-plugin-dkrypt'
  spec.version = Fastlane::Plugin::Dkrypt::VERSION
  spec.authors = ['dkrypt']
  spec.summary = 'Decrypt and download verified IPA artifacts with dkrypt'
  spec.description = 'Fastlane actions for requesting dkrypt App Store and TestFlight decrypts and downloading checksum-verified IPA artifacts.'
  spec.homepage = 'https://github.com/castdrian/dkrypt/tree/main/fastlane-plugin-dkrypt'
  spec.license = 'GPL-3.0-only'
  spec.required_ruby_version = Gem::Requirement.new('>= 3.0')
  spec.files = Dir['lib/**/*.rb', 'README.md', 'LICENSE']
  spec.require_paths = ['lib']
  spec.add_dependency 'fastlane', '>= 2.220', '< 3.0'
end
