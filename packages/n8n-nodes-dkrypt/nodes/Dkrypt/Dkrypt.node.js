class Dkrypt {
  description = {
    displayName: 'dkrypt',
    name: 'dkrypt',
    icon: 'file:dkrypt.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: 'Submit and inspect dkrypt decrypt jobs and IPA artifacts',
    defaults: { name: 'dkrypt' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'dkryptApi', required: true }],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        options: [
          { name: 'Decrypt App', value: 'decrypt' },
          { name: 'Get Job', value: 'getJob' },
          { name: 'Wait for Job', value: 'waitForJob' },
          { name: 'List Artifacts', value: 'listArtifacts' },
          { name: 'Download Artifact', value: 'downloadArtifact' },
        ],
        default: 'decrypt',
      },
      { displayName: 'Bundle ID', name: 'bundleId', type: 'string', default: '', required: true, displayOptions: { show: { operation: ['decrypt'] } } },
      { displayName: 'Version', name: 'version', type: 'string', default: '', displayOptions: { show: { operation: ['decrypt'] } } },
      { displayName: 'Idempotency Key', name: 'idempotencyKey', type: 'string', default: '', description: 'Optional stable key for safely retrying the same request', displayOptions: { show: { operation: ['decrypt'] } } },
      { displayName: 'Job ID', name: 'jobId', type: 'string', default: '', required: true, displayOptions: { show: { operation: ['getJob', 'waitForJob'] } } },
      { displayName: 'Wait Timeout', name: 'timeoutSeconds', type: 'number', typeOptions: { minValue: 1, maxValue: 25 }, default: 25, displayOptions: { show: { operation: ['waitForJob'] } } },
      { displayName: 'Search', name: 'query', type: 'string', default: '', displayOptions: { show: { operation: ['listArtifacts'] } } },
      { displayName: 'Limit', name: 'limit', type: 'number', typeOptions: { minValue: 1, maxValue: 100 }, default: 100, displayOptions: { show: { operation: ['listArtifacts'] } } },
      { displayName: 'Artifact ID', name: 'artifactId', type: 'string', default: '', required: true, displayOptions: { show: { operation: ['downloadArtifact'] } } },
      { displayName: 'Binary Property', name: 'binaryProperty', type: 'string', default: 'data', displayOptions: { show: { operation: ['downloadArtifact'] } } },
    ],
  };

  async execute() {
    const results = [];
    const items = this.getInputData();
    const credentials = await this.getCredentials('dkryptApi');
    const origin = new URL(String(credentials.baseUrl));
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if (!['https:', 'http:'].includes(origin.protocol) || (origin.protocol !== 'https:' && !localHost) || origin.username || origin.password || origin.search || origin.hash) throw new Error('dkrypt base URL must use HTTPS; HTTP is allowed only for localhost');
    const baseUrl = origin.origin.replace(/\/$/, '');

    for (let index = 0; index < items.length; index += 1) {
      const operation = this.getNodeParameter('operation', index);
      const options = { method: 'GET', url: baseUrl, headers: { Accept: 'application/json' }, json: true };
      if (operation === 'decrypt') {
        const bundleId = String(this.getNodeParameter('bundleId', index));
        const version = String(this.getNodeParameter('version', index) || '').trim();
        const idempotencyKey = String(this.getNodeParameter('idempotencyKey', index) || '').trim();
        options.method = 'POST';
        options.url += '/v1/decrypts';
        options.body = { bundleId, ...(version ? { version } : {}) };
        if (idempotencyKey) options.headers['Idempotency-Key'] = idempotencyKey;
      } else if (operation === 'getJob' || operation === 'waitForJob') {
        const jobId = encodeURIComponent(String(this.getNodeParameter('jobId', index)));
        options.url += `/v1/jobs/${jobId}`;
        if (operation === 'waitForJob') {
          const timeout = Math.max(1, Math.min(25, Math.floor(Number(this.getNodeParameter('timeoutSeconds', index)))));
          options.url += `/wait?timeoutSeconds=${timeout}`;
        }
      } else if (operation === 'listArtifacts') {
        const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(100, Math.floor(Number(this.getNodeParameter('limit', index)))))) });
        const query = String(this.getNodeParameter('query', index) || '').trim();
        if (query) params.set('q', query);
        options.url += `/v1/artifacts?${params}`;
      } else {
        const artifactId = encodeURIComponent(String(this.getNodeParameter('artifactId', index)));
        const binaryProperty = String(this.getNodeParameter('binaryProperty', index) || 'data');
        const response = await this.helpers.httpRequestWithAuthentication.call(this, 'dkryptApi', {
          method: 'GET',
          url: `${baseUrl}/v1/artifacts/${artifactId}/file`,
          encoding: 'arraybuffer',
          returnFullResponse: true,
          json: false,
        });
        const binary = await this.helpers.prepareBinaryData(response.body, `${artifactId}.ipa`, response.headers?.['content-type'] || 'application/octet-stream');
        results.push({ json: { artifactId }, binary: { [binaryProperty]: binary }, pairedItem: { item: index } });
        continue;
      }

      const response = await this.helpers.httpRequestWithAuthentication.call(this, 'dkryptApi', options);
      results.push({ json: response, pairedItem: { item: index } });
    }
    return [results];
  }
}

module.exports = { Dkrypt };
