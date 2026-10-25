class DkryptJobTrigger {
  description = {
    displayName: 'dkrypt Job Completion Trigger',
    name: 'dkryptJobTrigger',
    icon: 'file:dkrypt.svg',
    group: ['trigger'],
    version: 1,
    description: 'Start a workflow once a selected dkrypt decrypt job finishes',
    defaults: { name: 'dkrypt Job Completion Trigger' },
    inputs: [],
    outputs: ['main'],
    credentials: [{ name: 'dkryptApi', required: true }],
    polling: true,
    properties: [
      { displayName: 'Job ID', name: 'jobId', type: 'string', default: '', required: true, description: 'The dkrypt job ID to watch' },
    ],
  };

  async poll() {
    const credentials = await this.getCredentials('dkryptApi');
    const origin = new URL(String(credentials.baseUrl));
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if (!['https:', 'http:'].includes(origin.protocol) || (origin.protocol !== 'https:' && !localHost) || origin.username || origin.password || origin.search || origin.hash) throw new Error('dkrypt base URL must use HTTPS; HTTP is allowed only for localhost');
    const jobId = String(this.getNodeParameter('jobId')).trim();
    if (!jobId) throw new Error('Enter a dkrypt job ID to watch');
    const baseUrl = origin.origin.replace(/\/$/, '');
    const job = await this.helpers.httpRequestWithAuthentication.call(this, 'dkryptApi', {
      method: 'GET',
      url: `${baseUrl}/v1/jobs/${encodeURIComponent(jobId)}`,
      json: true,
    });
    if (!['done', 'failed'].includes(job.status)) return null;
    const staticData = this.getWorkflowStaticData('node');
    if (staticData.deliveredJobId === job.id && staticData.deliveredStatus === job.status) return null;
    staticData.deliveredJobId = job.id;
    staticData.deliveredStatus = job.status;
    return [this.helpers.returnJsonArray(job)];
  }
}

module.exports = { DkryptJobTrigger };
