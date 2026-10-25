class DkryptApi {
  name = 'dkryptApi';
  displayName = 'dkrypt API';
  documentationUrl = 'https://ipa.dylib.dev/reference';
  properties = [
    { displayName: 'Base URL', name: 'baseUrl', type: 'string', default: 'https://ipa.dylib.dev', placeholder: 'https://ipa.dylib.dev', required: true },
    { displayName: 'API Key', name: 'apiKey', type: 'string', typeOptions: { password: true }, default: '', required: true },
  ];
  authenticate = {
    type: 'generic',
    properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
  };
  test = {
    request: { baseURL: '={{$credentials.baseUrl}}', url: '/v1/artifacts?limit=1' },
  };
}

module.exports = { DkryptApi };
