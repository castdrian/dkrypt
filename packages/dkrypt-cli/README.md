# dkrypt CLI

The CLI uses only the public decrypt, job-status, and IPA-artifact API. It never sends credentials to a different origin.

Run `dkrypt login` to open a browser and approve CLI access without copying an API key. The generated key expires after 90 days and is stored in a local configuration file restricted to your account. Use `dkrypt login --manual` only when you already have an API key. Environment variables override saved settings. Use `dkrypt login --profile work` to save another instance, `dkrypt profile list` to see saved profile names, and `dkrypt profile use work` to switch the default. Prefix a command with `dkrypt --profile work` to use a profile once. `dkrypt logout` removes the active profile; `dkrypt logout --profile work` removes a specific one. Use `dkrypt completion bash`, `dkrypt completion zsh`, or `dkrypt completion fish` to print shell completions.

The CLI's `follow` command reconnects to the resumable job event stream. The TypeScript and Python SDKs include artifact pagination helpers. Generate reverse-proxy examples before signing in with `dkrypt proxy-config caddy ipa.example.com`, `dkrypt proxy-config nginx ipa.example.com`, or `dkrypt proxy-config traefik ipa.example.com`. Use `--upstream` when dkrypt listens on a different local origin. The Nginx example assumes TLS certificates at the generated Let's Encrypt paths.

Run `dkrypt doctor` (or `dkrypt doctor --json`) to verify the API key and IPA Library using only the public API routes available to generated keys.

Connect an MCP client to your dkrypt account with `dkrypt mcp login`. Sign-in uses a browser OAuth approval and stores short-lived tokens in the profile configuration. Run `dkrypt mcp stdio` as the MCP server command in a desktop agent. Disconnect with `dkrypt mcp logout`. Decrypt plans require an explicit approval in dkrypt before submission.

Run `dkrypt tui` for a keyboard-driven view of the 20 most recent jobs. It refreshes automatically; use `j`/`k` or the arrow keys to select, Enter to show details, `f` to follow a job, `r` to refresh, and `q` to exit.

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

Use `dkrypt --help` to see all commands. API keys need decrypt permission and access to the requested app bundle.
