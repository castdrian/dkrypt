import unittest
from email.message import Message
from urllib.error import HTTPError
from unittest.mock import MagicMock, patch

from dkrypt_client import DkryptClient, DkryptRedirectHandler


class Response:
    def __init__(self, body=b'IPA'):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, error_type, error, traceback):
        return False

    def read(self):
        return self.body


class DkryptClientTests(unittest.TestCase):
    @patch('dkrypt_client.DkryptClient._send')
    def test_decrypt_helper_sends_idempotency_key_and_version(self, send):
        send.return_value = b'{"id":"job-1","status":"queued"}'
        client = DkryptClient('https://ipa.dylib.dev', api_key='dk_test_key')

        result = client.decrypt('com.example.app', '3.2', 'request-1')

        self.assertEqual(result, {"id": "job-1", "status": "queued"})
        request = send.call_args.args
        self.assertEqual(request[0:4], ('POST', '/v1/decrypts', b'{"bundleId": "com.example.app", "version": "3.2"}', 'application/json'))
        self.assertEqual(request[4], {'Idempotency-Key': 'request-1'})

    @patch('dkrypt_client.DkryptClient.request')
    def test_follow_job_uses_long_poll_and_stops_on_terminal_state(self, request):
        request.side_effect = [
            {'id': 'job/1', 'status': 'running'},
            {'id': 'job/1', 'status': 'done'},
        ]
        client = DkryptClient('https://ipa.dylib.dev')

        updates = list(client.follow_job('job/1'))

        self.assertEqual([update['status'] for update in updates], ['running', 'done'])
        self.assertEqual(request.call_args_list[0].args, ('GET', '/v1/jobs/job%2F1/wait?timeoutSeconds=25'))
        self.assertEqual(request.call_count, 2)

    @patch('dkrypt_client.build_opener')
    def test_download_returns_binary_bytes_with_api_key(self, build_opener):
        opener = MagicMock()
        opener.open.return_value = Response()
        build_opener.return_value = opener
        client = DkryptClient('https://ipa.dylib.dev', api_key='dk_test_key')

        result = client.download('/v1/artifacts/artifact-1/file')

        request = opener.open.call_args.args[0]
        self.assertEqual(result, b'IPA')
        self.assertEqual(request.get_method(), 'GET')
        self.assertEqual(request.unredirected_hdrs.get('Authorization'), 'Bearer dk_test_key')
        self.assertEqual(request.get_header('Accept'), 'application/octet-stream')

    @patch('dkrypt_client.build_opener')
    def test_download_only_forwards_the_api_key_to_its_configured_origin(self, build_opener):
        opener = MagicMock()
        opener.open.return_value = Response()
        build_opener.return_value = opener
        client = DkryptClient('https://ipa.dylib.dev', api_key='dk_test_key')

        client.download('/v1/artifacts/artifact-1/file')

        request = opener.open.call_args.args[0]
        handler = build_opener.call_args.args[0]
        same_origin_redirect = handler.redirect_request(
            request,
            None,
            302,
            'Found',
            Message(),
            'https://ipa.dylib.dev/v1/artifacts/artifact-1/file',
        )
        cross_origin_redirect = handler.redirect_request(
            request,
            None,
            302,
            'Found',
            Message(),
            'https://attacker.example/collect',
        )
        self.assertEqual(same_origin_redirect.unredirected_hdrs.get('Authorization'), 'Bearer dk_test_key')
        self.assertNotIn('Authorization', dict(cross_origin_redirect.header_items()))

    @patch('dkrypt_client.build_opener')
    def test_download_keeps_at_sign_paths_on_the_configured_origin(self, build_opener):
        opener = MagicMock()
        opener.open.return_value = Response()
        build_opener.return_value = opener
        client = DkryptClient('https://ipa.dylib.dev', api_key='dk_test_key')

        client.download('@attacker.example/collect')

        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'https://ipa.dylib.dev/@attacker.example/collect')
        self.assertEqual(request.unredirected_hdrs.get('Authorization'), 'Bearer dk_test_key')

    @patch('dkrypt_client.build_opener')
    def test_download_rejects_a_path_that_changes_the_request_origin(self, build_opener):
        client = DkryptClient('https://ipa.dylib.dev', api_key='dk_test_key')

        with self.assertRaisesRegex(ValueError, 'configured origin'):
            client.download('https://attacker.example/collect')

        build_opener.assert_not_called()

    @patch('dkrypt_client.build_opener')
    def test_download_distinguishes_port_zero_from_the_default_https_port(self, build_opener):
        client = DkryptClient('https://ipa.dylib.dev:0', api_key='dk_test_key')

        with self.assertRaisesRegex(ValueError, 'configured origin'):
            client.download('https://ipa.dylib.dev:443/collect')

        build_opener.assert_not_called()

    @patch('dkrypt_client.sleep')
    @patch('dkrypt_client.build_opener')
    def test_read_retries_rate_limit_and_honors_retry_after(self, build_opener, sleep_for):
        opener = MagicMock()
        error = HTTPError('https://ipa.dylib.dev/v1/jobs/job-1', 429, 'limited', Message(), None)
        error.headers = Message()
        error.headers['Retry-After'] = '2'
        opener.open.side_effect = [error, Response(b'{"id":"job-1"}')]
        build_opener.return_value = opener
        client = DkryptClient('https://ipa.dylib.dev', retry_base_delay=0)

        result = client.request('GET', '/v1/jobs/job-1')

        self.assertEqual(result, {"id": "job-1"})
        self.assertEqual(opener.open.call_count, 2)
        sleep_for.assert_called_once_with(2.0)

    @patch('dkrypt_client.sleep')
    @patch('dkrypt_client.build_opener')
    def test_write_without_idempotency_key_is_not_retried(self, build_opener, sleep_for):
        opener = MagicMock()
        opener.open.side_effect = HTTPError('https://ipa.dylib.dev/v1/decrypts', 503, 'unavailable', Message(), None)
        build_opener.return_value = opener
        client = DkryptClient('https://ipa.dylib.dev')

        with self.assertRaisesRegex(RuntimeError, 'HTTP 503'):
            client.request('POST', '/v1/decrypts', {'bundleId': 'com.example.app'})

        self.assertEqual(opener.open.call_count, 1)
        sleep_for.assert_not_called()


if __name__ == '__main__':
    unittest.main()
