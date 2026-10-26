require 'fastlane/action'
require 'fastlane_core/configuration/config_item'
require_relative '../client'

module Fastlane
  module Actions
    class DkryptDecryptAction < Action
      def self.run(options)
        client = Fastlane::Plugin::Dkrypt::Client.new(
          base_url: options[:api_url],
          api_key: options[:api_key],
          request_timeout: options[:request_timeout],
          download_timeout: options[:download_timeout]
        )
        result = client.decrypt(
          bundle_id: options[:bundle_id],
          version: options[:version],
          channel: options[:channel],
          output: options[:output],
          timeout: options[:timeout]
        )
        UI.success("dkrypt downloaded and verified #{result[:channel]} #{result[:version]} to #{result[:path]}")
        result[:path]
      rescue StandardError => error
        UI.user_error!("dkrypt decrypt failed: #{error.message}")
      end

      def self.description
        'Request a dkrypt decrypt and download its IPA after SHA-256 and size verification'
      end

      def self.details
        'Uses the dkrypt public decrypt, job-status and artifact routes. The IPA is written only after its reported size and SHA-256 match.'
      end

      def self.available_options
        [
          FastlaneCore::ConfigItem.new(key: :api_url, env_name: 'DKRYPT_API_URL', description: 'HTTPS origin for dkrypt', default_value: 'https://ipa.dylib.dev', verify_block: proc { |value| raise 'API URL must be a URL' unless value.to_s.match?(/\Ahttps?:\/\//) }),
          FastlaneCore::ConfigItem.new(key: :api_key, env_name: 'DKRYPT_API_KEY', description: 'dkrypt API key with decrypt and artifact access', sensitive: true, optional: false),
          FastlaneCore::ConfigItem.new(key: :bundle_id, description: 'App bundle identifier', optional: false, verify_block: proc { |value| raise 'Bundle ID is invalid' unless value.to_s.match?(/\A[A-Za-z0-9.-]{3,200}\z/) }),
          FastlaneCore::ConfigItem.new(key: :channel, description: 'App Store or TestFlight source', default_value: 'appstore', is_string: true),
          FastlaneCore::ConfigItem.new(key: :version, description: 'Optional exact release selector; TestFlight uses version_build', optional: true),
          FastlaneCore::ConfigItem.new(key: :output, description: 'Destination IPA path', optional: true),
          FastlaneCore::ConfigItem.new(key: :timeout, description: 'Job deadline in seconds', default_value: 1800, type: Integer),
          FastlaneCore::ConfigItem.new(key: :request_timeout, description: 'API request timeout in seconds', default_value: 60, type: Integer),
          FastlaneCore::ConfigItem.new(key: :download_timeout, description: 'IPA download timeout in seconds', default_value: 600, type: Integer),
        ]
      end

      def self.output
        'The absolute path of the integrity-verified IPA'
      end

      def self.return_value
        'The absolute path of the integrity-verified IPA'
      end

      def self.authors
        ['dkrypt']
      end

      def self.is_supported?(platform)
        [:ios, :mac].include?(platform)
      end
    end
  end
end
