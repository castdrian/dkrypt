# dkrypt CLI

The CLI uses only the public decrypt, job-status, and IPA-artifact API. It never sends credentials to a different origin.

```sh
cd packages/dkrypt-cli
npm install --global .
export DKRYPT_API_URL=https://ipa.dylib.dev
export DKRYPT_API_KEY=dk_live_...
dkrypt decrypt com.example.app
dkrypt wait <job-id>
dkrypt artifacts Discord
dkrypt download <artifact-id> Discord.ipa
```

Use `dkrypt --help` to see all commands. API keys need decrypt permission and access to the selected project and app bundle.
