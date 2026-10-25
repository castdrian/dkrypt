# n8n-nodes-dkrypt

Community node for the dkrypt public API. It can submit an App Store decrypt, inspect or wait for a job, list IPA artifacts, and download an artifact as binary data.

Install the package in an n8n instance that permits community nodes. Create a dkrypt API key with decrypt and IPA library access, then configure its HTTPS base URL and API key in the credential. The API key remains limited to dkrypt's public decrypt, job status, and artifact routes.

The Wait for Job operation performs one bounded status wait of at most 25 seconds. Use it in a loop with Get Job or Wait for Job when the workflow should continue until the job reaches a terminal state.

For local development, run `npm test` from this directory. Publish the package to a registry or use its directory in an n8n community-node environment to install it.
