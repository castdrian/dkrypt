require 'digest'
require 'fileutils'
require 'json'
require 'net/http'
require 'openssl'
require 'securerandom'
require 'tempfile'
require 'time'
require 'uri'

module Fastlane
  module Plugin
    module Dkrypt
      class Client
        def initialize(base_url:, api_key:, http_factory: nil, sleep: nil, max_attempts: 5, request_timeout: 60, download_timeout: 600)
          @origin = validate_origin(base_url)
          @api_key = api_key.to_s.strip
          raise ArgumentError, 'DKRYPT_API_KEY is required' if @api_key.empty?
          @http_factory = http_factory || ->(uri) { Net::HTTP.new(uri.host, uri.port) }
          @sleep = sleep || ->(seconds) { Kernel.sleep(seconds) }
          @max_attempts = [[max_attempts.to_i, 1].max, 8].min
          @request_timeout = [[request_timeout.to_i, 1].max, 300].min
          @download_timeout = [[download_timeout.to_i, 1].max, 3600].min
        end

        def decrypt(bundle_id:, version: nil, channel: 'appstore', output: nil, timeout: 1800)
          raise ArgumentError, 'bundle_id must be a valid bundle identifier' unless bundle_id.to_s.match?(/\A[A-Za-z0-9.-]{3,200}\z/)
          raise ArgumentError, 'channel must be appstore or testflight' unless %w[appstore testflight].include?(channel)
          selector = version.to_s.strip
          if channel == 'testflight' && !selector.empty? && !selector.match?(/\A.+_\d+\z/)
            raise ArgumentError, 'TestFlight versions must include a build number, such as 352.0_118977'
          end
          if channel == 'appstore' && selector.include?('_')
            raise ArgumentError, 'App Store versions cannot contain a TestFlight build number'
          end

          deadline = monotonic_time + [[timeout.to_i, 1].max, 86_400].min
          job = request_json(Net::HTTP::Post, '/v1/decrypts', {
            'bundleId' => bundle_id,
            'channel' => channel,
            **(selector.empty? ? {} : { 'version' => selector })
          }, idempotency_key: SecureRandom.uuid, deadline: deadline)
          raise 'dkrypt did not return a job ID' unless job['id'].is_a?(String) && !job['id'].empty?
          job_id = job['id']
          until %w[done failed].include?(job['status'])
            remaining = deadline - monotonic_time
            raise "dkrypt job #{job_id} exceeded #{timeout} seconds" if remaining <= 0
            wait_seconds = [remaining.floor, 25].min
            job = request_json(Net::HTTP::Get, "/v1/jobs/#{path_component(job_id)}/wait?timeoutSeconds=#{wait_seconds}", nil, deadline: deadline)
          end
          raise "dkrypt job #{job_id} failed: #{job['error'] || 'unknown failure'}" if job['status'] == 'failed'

          artifact_id = job['artifactId'] || job.dig('artifact', 'id')
          raise "dkrypt job #{job_id} completed without an artifact" unless artifact_id.is_a?(String) && !artifact_id.empty?
          artifact = request_json(Net::HTTP::Get, "/v1/artifacts/#{path_component(artifact_id)}", nil, deadline: deadline)
          destination = File.expand_path(output || "#{safe_filename(bundle_id)}-#{safe_filename(artifact['versionLabel'] || artifact['buildNumber'] || artifact_id)}.ipa")
          download_verified(artifact, destination)
          { path: destination, job_id: job_id, artifact_id: artifact_id, version: artifact['versionLabel'], channel: artifact['channel'], sha256: artifact['sha256'], size_bytes: artifact['fileSizeBytes'] }
        end

        private

        def validate_origin(value)
          uri = URI.parse(value.to_s)
          local = %w[localhost 127.0.0.1 ::1].include?(uri.host)
          raise ArgumentError, 'dkrypt API URL must use HTTPS; HTTP is allowed only for localhost' unless uri.is_a?(URI::HTTP) && (uri.scheme == 'https' || (uri.scheme == 'http' && local))
          raise ArgumentError, 'dkrypt API URL must be an origin without credentials, query, fragment, or path' unless uri.userinfo.nil? && (uri.path.nil? || uri.path == '/' || uri.path.empty?) && uri.query.nil? && uri.fragment.nil?
          "#{uri.scheme}://#{uri.host}:#{uri.port}"
        rescue URI::InvalidURIError
          raise ArgumentError, 'dkrypt API URL is invalid'
        end

        def request_json(method, resource, body = nil, idempotency_key: nil, deadline: nil)
          uri = same_origin_uri(resource)
          last_error = nil
          @max_attempts.times do |attempt|
            request = method.new(uri.request_uri)
            request['Accept'] = 'application/json'
            request['Authorization'] = "Bearer #{@api_key}"
            request['Content-Type'] = 'application/json' if body
            request['Idempotency-Key'] = idempotency_key if idempotency_key
            request.body = JSON.generate(body) if body
            begin
              response = perform(uri, request, remaining_timeout(deadline, @request_timeout))
              code = response.code.to_i
              if retryable?(code)
                last_error = "HTTP #{code}"
                retry_pause(attempt, response['Retry-After'], deadline) if attempt + 1 < @max_attempts
                next
              end
              raise response_error(response) unless code.between?(200, 299)
              return JSON.parse(response.body.to_s)
            rescue Net::OpenTimeout, Net::ReadTimeout, SocketError, IOError, SystemCallError, OpenSSL::SSL::SSLError => error
              last_error = error.message
              retry_pause(attempt, nil, deadline) if attempt + 1 < @max_attempts
            end
          end
          raise "dkrypt request failed after #{@max_attempts} attempts: #{last_error || 'unknown failure'}"
        end

        def download_verified(artifact, destination)
          expected_size = artifact['sizeBytes'] || artifact['fileSizeBytes']
          expected_hash = artifact['sha256'].to_s.downcase
          raise 'dkrypt did not return a valid IPA size' unless expected_size.is_a?(Integer) && expected_size.positive?
          raise 'dkrypt did not return a valid IPA SHA-256' unless expected_hash.match?(/\A[a-f0-9]{64}\z/)
          resource = artifact['fileUrl'] || "/v1/artifacts/#{path_component(artifact.fetch('id'))}/file"
          uri = same_origin_uri(resource)
          FileUtils.mkdir_p(File.dirname(destination))
          temporary = "#{destination}.#{SecureRandom.hex(8)}.partial"
          deadline = monotonic_time + @download_timeout
          last_error = nil

          @max_attempts.times do |attempt|
            begin
              digest = Digest::SHA256.new
              received = 0
              response_body = +''
              File.open(temporary, 'wb', 0o600) do |file|
                request = Net::HTTP::Get.new(uri.request_uri)
                request['Accept'] = 'application/octet-stream'
                request['Authorization'] = "Bearer #{@api_key}"
                response = perform(uri, request, remaining_timeout(deadline, @download_timeout)) do |http_response|
                  http_response.read_body do |chunk|
                    if http_response.code.to_i.between?(200, 299)
                      received += chunk.bytesize
                      raise 'IPA download exceeded the reported size' if received > expected_size
                      digest.update(chunk)
                      file.write(chunk)
                    elsif response_body.bytesize < 8_192
                      response_body << chunk.byteslice(0, 8_192 - response_body.bytesize)
                    end
                  end
                end
                code = response.code.to_i
                if retryable?(code)
                  last_error = "HTTP #{code}"
                  raise RetryDownload if attempt + 1 < @max_attempts
                  raise last_error
                end
                raise response_error(response, response_body) unless code.between?(200, 299)
              end
              raise 'IPA download size did not match dkrypt metadata' unless received == expected_size
              raise 'IPA download SHA-256 did not match dkrypt metadata' unless digest.hexdigest == expected_hash
              File.rename(temporary, destination)
              return
            rescue RetryDownload
              FileUtils.rm_f(temporary)
              @sleep.call(retry_delay(attempt))
            rescue Net::OpenTimeout, Net::ReadTimeout, SocketError, IOError, SystemCallError, OpenSSL::SSL::SSLError => error
              last_error = error.message
              FileUtils.rm_f(temporary)
              @sleep.call(retry_delay(attempt)) if attempt + 1 < @max_attempts
            rescue StandardError
              FileUtils.rm_f(temporary)
              raise
            end
          end
          FileUtils.rm_f(temporary)
          raise "IPA download failed after #{@max_attempts} attempts: #{last_error || 'integrity check failed'}"
        end

        class RetryDownload < StandardError
        end

        def perform(uri, request, timeout, &block)
          http = @http_factory.call(uri)
          http.use_ssl = uri.scheme == 'https' if http.respond_to?(:use_ssl=)
          http.open_timeout = [timeout, 10].min if http.respond_to?(:open_timeout=)
          http.read_timeout = timeout if http.respond_to?(:read_timeout=)
          http.write_timeout = timeout if http.respond_to?(:write_timeout=)
          http.start { |connection| connection.request(request, &block) }
        end

        def same_origin_uri(resource)
          target = URI.join("#{@origin}/", resource.to_s)
          origin = URI.parse(@origin)
          raise 'dkrypt returned a URL outside its configured origin' unless target.scheme == origin.scheme && target.host == origin.host && target.port == origin.port
          raise 'dkrypt returned an invalid artifact URL' unless target.userinfo.nil? && target.fragment.nil?
          target
        end

        def response_error(response, response_body = nil)
          body = response_body.nil? ? response.body.to_s : response_body
          begin
            payload = JSON.parse(body)
            payload['message'] || payload['error'] || "HTTP #{response.code}"
          rescue JSON::ParserError
            "HTTP #{response.code}: #{body.byteslice(0, 500)}"
          end
        end

        def retryable?(code)
          [408, 425, 429].include?(code) || code >= 500
        end

        def retry_pause(attempt, retry_after, deadline)
          delay = retry_after.to_s.match?(/\A\d+(?:\.\d+)?\z/) ? retry_after.to_f : retry_delay(attempt)
          raise 'dkrypt request exceeded its deadline' if deadline && monotonic_time + delay >= deadline
          @sleep.call(delay)
        end

        def retry_delay(attempt)
          [0.5 * (2**attempt), 8].min
        end

        def remaining_timeout(deadline, cap)
          remaining = deadline ? deadline - monotonic_time : cap
          raise 'dkrypt request exceeded its deadline' if remaining <= 0
          [remaining.ceil, cap].min
        end

        def monotonic_time
          Process.clock_gettime(Process::CLOCK_MONOTONIC)
        end

        def path_component(value)
          URI.encode_www_form_component(value.to_s).gsub('+', '%20')
        end

        def safe_filename(value)
          value.to_s.gsub(/[^A-Za-z0-9._-]+/, '-').gsub(/\A-+|-+\z/, '')
        end
      end
    end
  end
end
