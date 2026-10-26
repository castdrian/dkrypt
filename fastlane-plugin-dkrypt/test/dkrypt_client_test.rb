require 'minitest/autorun'
require 'tmpdir'
require 'digest'
require 'json'
require_relative '../lib/fastlane/plugin/dkrypt/client'

class FakeResponse
  attr_reader :code, :body

  def initialize(code, body = '', chunks = nil)
    @code = code.to_s
    @body = body
    @chunks = chunks || [body]
  end

  def [](name)
    nil
  end

  def read_body
    @chunks.each { |chunk| yield chunk }
  end
end

class FakeHttp
  attr_accessor :use_ssl, :open_timeout, :read_timeout, :write_timeout

  def initialize(responses)
    @responses = responses
  end

  def start
    yield self
  end

  def request(request)
    response = @responses.call(request)
    yield response if block_given?
    response
  end
end

class DkryptClientTest < Minitest::Test
  def test_decrypt_waits_for_job_and_downloads_only_matching_hash_and_size
    bytes = 'ipa test payload'
    digest = Digest::SHA256.hexdigest(bytes)
    with_tmpdir do |directory|
      responses = lambda do |request|
        case [request.method, request.path]
        when ['POST', '/v1/decrypts']
          assert_equal 'Bearer test-key', request['Authorization']
          FakeResponse.new(202, JSON.generate({ 'id' => 'job-1', 'status' => 'running' }))
        when ['GET', '/v1/jobs/job-1/wait?timeoutSeconds=25']
          FakeResponse.new(200, JSON.generate({ 'id' => 'job-1', 'status' => 'done', 'artifactId' => 'artifact-1' }))
        when ['GET', '/v1/artifacts/artifact-1']
          FakeResponse.new(200, JSON.generate({ 'id' => 'artifact-1', 'sizeBytes' => bytes.bytesize, 'sha256' => digest, 'versionLabel' => '1.0', 'channel' => 'appstore' }))
        when ['GET', '/v1/artifacts/artifact-1/file']
          FakeResponse.new(200, '', [bytes[0, 4], bytes[4..]])
        else
          raise "unexpected request #{request.method} #{request.path}"
        end
      end
      client = Fastlane::Plugin::Dkrypt::Client.new(
        base_url: 'https://dkrypt.example',
        api_key: 'test-key',
        http_factory: ->(_uri) { FakeHttp.new(responses) },
        sleep: ->(_seconds) {}
      )
      result = client.decrypt(bundle_id: 'com.example.app', output: File.join(directory, 'verified.ipa'))
      assert_equal File.join(directory, 'verified.ipa'), result[:path]
      assert_equal 'job-1', result[:job_id]
      assert_equal bytes, File.binread(result[:path])
    end
  end

  def test_rejects_non_https_remote_origins
    assert_raises(ArgumentError) do
      Fastlane::Plugin::Dkrypt::Client.new(base_url: 'http://dkrypt.example', api_key: 'test-key')
    end
  end

  def test_does_not_promote_an_ipa_with_a_mismatched_hash
    bytes = 'tampered ipa'
    responses = lambda do |request|
      case [request.method, request.path]
      when ['POST', '/v1/decrypts']
        FakeResponse.new(200, JSON.generate({ 'id' => 'job-2', 'status' => 'done', 'artifactId' => 'artifact-2' }))
      when ['GET', '/v1/artifacts/artifact-2']
        FakeResponse.new(200, JSON.generate({ 'id' => 'artifact-2', 'sizeBytes' => bytes.bytesize, 'sha256' => '0' * 64, 'versionLabel' => '1.0', 'channel' => 'appstore' }))
      when ['GET', '/v1/artifacts/artifact-2/file']
        FakeResponse.new(200, '', [bytes])
      else
        raise "unexpected request #{request.method} #{request.path}"
      end
    end
    client = Fastlane::Plugin::Dkrypt::Client.new(
      base_url: 'https://dkrypt.example',
      api_key: 'test-key',
      http_factory: ->(_uri) { FakeHttp.new(responses) },
      sleep: ->(_seconds) {},
      max_attempts: 1
    )
    Dir.mktmpdir('dkrypt-fastlane-test-') do |directory|
      output = File.join(directory, 'unverified.ipa')
      assert_raises(RuntimeError) { client.decrypt(bundle_id: 'com.example.app', output: output) }
      refute File.exist?(output)
    end
  end

  private

  def with_tmpdir
    Dir.mktmpdir('dkrypt-fastlane-test-') { |directory| yield directory }
  end
end
