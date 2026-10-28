function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function optionalInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`env var ${name} must be an integer, got ${v}`);
  return n;
}

function optionalFloat(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) throw new Error(`env var ${name} must be a number, got ${v}`);
  if (n < 0 || n > 1) throw new Error(`env var ${name} must be between 0 and 1, got ${v}`);
  return n;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (!v) return fallback;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`env var ${name} must be true or false, got ${v}`);
}

function optionalList(name: string, fallback: string): string[] {
  return (process.env[name] ?? fallback)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

const MAX_OFFLINE_APP_STORE_WORKERS = 4;

export const config = {
  port: optionalInt('PORT', 8080),
  bindHost: optional('BIND_HOST', '127.0.0.1'),

  apiKey: required('API_KEY'),
  sessionSigningSecret: required('SESSION_SIGNING_SECRET'),
  sessionSigningSecretPrevious: optional('SESSION_SIGNING_SECRET_PREVIOUS', ''),
  backupManifestSecret: optional('BACKUP_MANIFEST_SECRET', ''),
  backupManifestSecretPrevious: optionalList('BACKUP_MANIFEST_SECRET_PREVIOUS', ''),
  publicBaseUrl: optional('PUBLIC_BASE_URL', 'http://localhost:8080'),
  trustedProxyAddresses: optionalList('TRUSTED_PROXY_ADDRESSES', 'loopback'),
  abuseSignalSecret: optional('ABUSE_SIGNAL_SECRET', ''),
  turnstileSiteKey: optional('TURNSTILE_SITE_KEY', ''),
  turnstileSecretKey: optional('TURNSTILE_SECRET_KEY', ''),
  ipApiIsKey: optional('IPAPI_IS_KEY', ''),
  ipInfoToken: optional('IPINFO_TOKEN', ''),
  abuseBlockedEmailDomains: optionalList('ABUSE_BLOCKED_EMAIL_DOMAINS', 'mailinator.com,guerrillamail.com,10minutemail.com,temp-mail.org,tempmail.com,yopmail.com,maildrop.cc,getnada.com,dispostable.com,trashmail.com').map((value) => value.toLowerCase()),
  freeNetworkDecryptLimit: Math.max(1, optionalInt('FREE_NETWORK_DECRYPT_LIMIT', 60)),
  freeAnonymousNetworkDecryptLimit: Math.max(1, optionalInt('FREE_ANONYMOUS_NETWORK_DECRYPT_LIMIT', 24)),
  freeAddressDecryptLimit: Math.max(1, optionalInt('FREE_ADDRESS_DECRYPT_LIMIT', 12)),
  freeAnonymousAddressDecryptLimit: Math.max(1, optionalInt('FREE_ANONYMOUS_ADDRESS_DECRYPT_LIMIT', 6)),

  adminPassword: required('ADMIN_PASSWORD'),
  adminPasswordPrevious: optional('ADMIN_PASSWORD_PREVIOUS', ''),
  stateDir: optional('STATE_DIR', '/data/state'),
  stateDatabaseFile: optional('STATE_DATABASE_FILE', 'dkrypt.sqlite'),
  stateDbBusyTimeoutMs: optionalInt('STATE_DB_BUSY_TIMEOUT_MS', 5000),
  stateDbMigrationDryRun: optionalBool('STATE_DB_MIGRATION_DRY_RUN', false),
  artifactDir: optional('ARTIFACT_DIR', '/data/artifacts'),

  githubOauthClientId: optional('GITHUB_OAUTH_CLIENT_ID', ''),
  githubOauthClientSecret: optional('GITHUB_OAUTH_CLIENT_SECRET', ''),
  githubOauthClientSecretPrevious: optional('GITHUB_OAUTH_CLIENT_SECRET_PREVIOUS', ''),
  discordOauthClientId: optional('DISCORD_OAUTH_CLIENT_ID', ''),
  discordOauthClientSecret: optional('DISCORD_OAUTH_CLIENT_SECRET', ''),
  discordOauthClientSecretPrevious: optional('DISCORD_OAUTH_CLIENT_SECRET_PREVIOUS', ''),
  discordBotToken: optional('DISCORD_BOT_TOKEN', ''),

  stripeSecretKey: optional('STRIPE_SECRET_KEY', ''),
  stripeSecretKeyPrevious: optional('STRIPE_SECRET_KEY_PREVIOUS', ''),
  stripeWebhookSecret: optional('STRIPE_WEBHOOK_SECRET', ''),
  stripeWebhookSecretPrevious: optional('STRIPE_WEBHOOK_SECRET_PREVIOUS', ''),
  stripeRegularPriceId: optional('STRIPE_REGULAR_PRICE_ID', ''),
  stripePriorityPriceId: optional('STRIPE_PRIORITY_PRICE_ID', ''),
  stripeApiPriceId: optional('STRIPE_API_PRICE_ID', ''),
  stripePriorityApiPriceId: optional('STRIPE_PRIORITY_API_PRICE_ID', ''),
  stripeAccessPriceId: optional('STRIPE_ACCESS_PRICE_ID', ''),
  stripeStandardPriceId: optional('STRIPE_STANDARD_PRICE_ID', ''),
  stripePlusPriceId: optional('STRIPE_PLUS_PRICE_ID', ''),
  stripeDeveloperPriceId: optional('STRIPE_DEVELOPER_PRICE_ID', ''),
  stripeUnlimitedPriceId: optional('STRIPE_UNLIMITED_PRICE_ID', ''),
  stripeUnlimitedPriorityPriceId: optional('STRIPE_UNLIMITED_PRIORITY_PRICE_ID', ''),
  stripeDecryptCreditPriceId: optional('STRIPE_DECRYPT_CREDIT_PRICE_ID', ''),
  stripeDecryptCreditQuantity: Math.min(100_000, Math.max(1, optionalInt('STRIPE_DECRYPT_CREDIT_QUANTITY', 10))),
  billingGiftEncryptionSecret: optional('BILLING_GIFT_ENCRYPTION_SECRET', ''),
  billingCatalogRollout: optional('BILLING_CATALOG_ROLLOUT', 'off'),
  billingCatalogCanaryUserIds: optionalList('BILLING_CATALOG_CANARY_USER_IDS', ''),

  cryptoBillingEnabled: optionalBool('CRYPTO_BILLING_ENABLED', false),
  cryptoBillingPollIntervalSeconds: optionalInt('CRYPTO_BILLING_POLL_INTERVAL_SECONDS', 300),
  cryptoDunningGraceHours: optionalInt('CRYPTO_DUNNING_GRACE_HOURS', 72),
  nowpaymentsApiKey: optional('NOWPAYMENTS_API_KEY', ''),
  nowpaymentsApiKeyPrevious: optional('NOWPAYMENTS_API_KEY_PREVIOUS', ''),
  nowpaymentsIpnSecret: optional('NOWPAYMENTS_IPN_SECRET', ''),
  nowpaymentsIpnSecretPrevious: optional('NOWPAYMENTS_IPN_SECRET_PREVIOUS', ''),
  nowpaymentsApiBaseUrl: optional('NOWPAYMENTS_API_BASE_URL', 'https://api.nowpayments.io/v1'),
  nowpaymentsEnvironment: optional('NOWPAYMENTS_ENVIRONMENT', 'live'),
  nowpaymentsSupportedAssets: optionalList('NOWPAYMENTS_SUPPORTED_ASSETS', 'USDC,USDT').map((value) => value.toUpperCase()),
  nowpaymentsDefaultAsset: optional('NOWPAYMENTS_DEFAULT_ASSET', 'USDC').toUpperCase(),
  nowpaymentsOutcomeCurrency: optional('NOWPAYMENTS_OUTCOME_CURRENCY', 'USDC').toUpperCase(),
  nowpaymentsPriceCurrency: optional('NOWPAYMENTS_PRICE_CURRENCY', 'EUR').toUpperCase(),

  ipadecryptBin: optional('IPADECRYPT_BIN', 'ipadecrypt'),
  appStoreOfflineDecryptEnabled: optionalBool('APPSTORE_OFFLINE_DECRYPT_ENABLED', true),
  appStoreOfflineFairPlayAuthorized: optionalBool('APPSTORE_OFFLINE_FAIRPLAY_AUTHORIZED', true),
  appStoreOfflineMaxWorkers: Math.min(MAX_OFFLINE_APP_STORE_WORKERS, Math.max(1, optionalInt('APPSTORE_OFFLINE_MAX_WORKERS', 1))),
  appStoreOfflineWorkerMemoryMb: Math.min(32768, Math.max(512, optionalInt('APPSTORE_OFFLINE_WORKER_MEMORY_MB', 8192))),
  appStoreOfflineInspectTimeoutSeconds: Math.min(3600, Math.max(1, optionalInt('APPSTORE_OFFLINE_INSPECT_TIMEOUT_SECONDS', 300))),
  appStoreOfflineAttemptTimeoutSeconds: Math.min(7200, Math.max(30, optionalInt('APPSTORE_OFFLINE_ATTEMPT_TIMEOUT_SECONDS', 900))),
  appStoreOfflineStallTimeoutSeconds: Math.min(3600, Math.max(60, optionalInt('APPSTORE_OFFLINE_STALL_TIMEOUT_SECONDS', 300))),
  appStoreOfflineFallbackReserveSeconds: Math.min(3600, Math.max(30, optionalInt('APPSTORE_OFFLINE_FALLBACK_RESERVE_SECONDS', 180))),
  appStoreOfflineCircuitFailureThreshold: Math.min(20, Math.max(1, optionalInt('APPSTORE_OFFLINE_CIRCUIT_FAILURE_THRESHOLD', 3))),
  appStoreOfflineCircuitCooldownSeconds: Math.min(3600, Math.max(30, optionalInt('APPSTORE_OFFLINE_CIRCUIT_COOLDOWN_SECONDS', 300))),
  appStoreOfflineDownloaderBin: optional('APPSTORE_OFFLINE_DOWNLOADER_BIN', '/usr/local/bin/dkrypt-appstore-downloader'),
  appStoreOfflineDecryptorBin: optional('APPSTORE_OFFLINE_DECRYPTOR_BIN', '/usr/local/bin/fairplay-decrypt'),
  appStoreOfflinePythonBin: optional('APPSTORE_OFFLINE_PYTHON_BIN', '/usr/bin/python3'),
  appStoreOfflineCredentialRetriever: optional('APPSTORE_OFFLINE_CREDENTIAL_RETRIEVER', '/opt/fairplay-decrypt/credential-retrieval/retrieve.py'),
  appStoreOfflineCredentialTimeoutSeconds: Math.min(1800, Math.max(60, optionalInt('APPSTORE_OFFLINE_CREDENTIAL_TIMEOUT_SECONDS', 900))),
  appStoreOfflineAuthenticationTimeoutSeconds: Math.min(900, Math.max(60, optionalInt('APPSTORE_OFFLINE_AUTHENTICATION_TIMEOUT_SECONDS', 300))),
  appStoreOfflineVaultKey: optional('APPSTORE_OFFLINE_VAULT_KEY', ''),
  outputDir: optional('OUTPUT_DIR', '/data/tmp'),
  deviceRuntimeDir: optional('DEVICE_RUNTIME_DIR', '/data/state/device-runtime'),
  deviceSshKeyPath: optional('DEVICE_SSH_KEY_PATH', '/data/device-ssh/id_ed25519'),
  deviceSshPublicKeyPath: optional('DEVICE_SSH_PUBLIC_KEY_PATH', '/data/device-ssh/id_ed25519.pub'),
  deviceSshUser: optional('DEVICE_SSH_USER', 'mobile'),
  deviceSshPort: optionalInt('DEVICE_SSH_PORT', 22),
  deviceTransport: optional('DEVICE_TRANSPORT', 'auto'),
  deviceBridgeSocket: optional('DEVICE_BRIDGE_SOCKET', '/run/dkrypt/device-bridge.sock'),
  deviceBridgeSecret: optional('DEVICE_BRIDGE_SECRET', ''),
  deviceBridgeSecretPrevious: optional('DEVICE_BRIDGE_SECRET_PREVIOUS', ''),
  deviceMuxSocket: optional('DEVICE_MUX_SOCKET', '/run/dkrypt/usbmuxd.sock'),
  devicePairingStore: optional('DEVICE_PAIRING_STORE', '/data/state/device-pairing'),
  deviceBridgeHostId: optional('DEVICE_BRIDGE_HOST_ID', ''),
  netmuxdBin: optional('NETMUXD_BIN', '/usr/local/bin/netmuxd'),
  artifactMaxBytes: optionalInt('ARTIFACT_MAX_BYTES', 200 * 1024 * 1024 * 1024),

  jobMaxWaitSeconds: optionalInt('JOB_MAX_WAIT_SECONDS', 1800),
  jobMaxRetries: optionalInt('JOB_MAX_RETRIES', 1),
  jobProcessGraceSeconds: optionalInt('JOB_PROCESS_GRACE_SECONDS', 10),
  jobRetentionMinutes: optionalInt('JOB_RETENTION_MINUTES', 24 * 60),

  notifyWebhookUrl: optional('NOTIFY_WEBHOOK_URL', ''),
  outboundWebhookSecret: optional('OUTBOUND_WEBHOOK_SECRET', ''),
  outboundWebhookSecretPrevious: optional('OUTBOUND_WEBHOOK_SECRET_PREVIOUS', ''),
  userConcurrencyCap: optionalInt('USER_CONCURRENCY_CAP', 0),
  apiRateLimitPerMinute: Math.max(1, optionalInt('API_RATE_LIMIT_PER_MINUTE', 600)),
  queueSloMinutes: optionalInt('QUEUE_SLO_MINUTES', 30),

  otelExporterOtlpEndpoint: optional('OTEL_EXPORTER_OTLP_ENDPOINT', ''),
  otelExporterOtlpHeaders: optional('OTEL_EXPORTER_OTLP_HEADERS', ''),
  otelExporterOtlpTracesEndpoint: optional('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', ''),
  otelExporterOtlpTracesHeaders: optional('OTEL_EXPORTER_OTLP_TRACES_HEADERS', ''),
  otelExporterOtlpMetricsEndpoint: optional('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', ''),
  otelExporterOtlpMetricsHeaders: optional('OTEL_EXPORTER_OTLP_METRICS_HEADERS', ''),
  otelServiceName: optional('OTEL_SERVICE_NAME', 'dkrypt'),
  otelSampleRate: optionalFloat('OTEL_SAMPLE_RATE', 1),
  otelBatchSize: optionalInt('OTEL_BSP_MAX_EXPORT_BATCH_SIZE', 64),
  otelMaxQueueSize: Math.max(1, optionalInt('OTEL_BSP_MAX_QUEUE_SIZE', 2048)),
  otelFlushIntervalMs: optionalInt('OTEL_BSP_SCHEDULE_DELAY', 5000),

  smtpHost: optional('SMTP_HOST', ''),
  smtpPort: optionalInt('SMTP_PORT', 587),
  smtpUser: optional('SMTP_USER', ''),
  smtpPass: optional('SMTP_PASS', ''),
  smtpPassPrevious: optional('SMTP_PASS_PREVIOUS', ''),
  smtpFrom: optional('SMTP_FROM', 'dkrypt <dkrypt@dylib.dev>'),
};

if (Boolean(config.turnstileSiteKey) !== Boolean(config.turnstileSecretKey)) throw new Error('TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must be configured together');
if (config.trustedProxyAddresses.some((address) => ['*', '0.0.0.0/0', '::/0'].includes(address.toLowerCase()))) throw new Error('TRUSTED_PROXY_ADDRESSES must not trust every proxy');
if (config.abuseSignalSecret.length > 0 && config.abuseSignalSecret.length < 32) throw new Error('ABUSE_SIGNAL_SECRET must be at least 32 characters');

export function isGithubOauthEnabled(): boolean {
  return config.githubOauthClientId !== '' && config.githubOauthClientSecret !== '';
}

export const githubOauthEnabled = isGithubOauthEnabled();

export function isDiscordOauthEnabled(): boolean {
  return config.discordOauthClientId !== '' && config.discordOauthClientSecret !== '';
}

export const discordOauthEnabled = isDiscordOauthEnabled();

export function isDiscordBotEnabled(): boolean {
  return config.discordBotToken !== '';
}
export const discordBotEnabled = isDiscordBotEnabled();
export function stripeKeyEnvironment(secretKey: string): 'live' | 'test' | undefined {
  if (secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_')) return 'live';
  if (secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_')) return 'test';
  return undefined;
}

export function isValidStripeSecretKeyRotation(current: string, previous: string): boolean {
  const currentEnvironment = stripeKeyEnvironment(current);
  return current.length >= 16
    && previous.length >= 16
    && current !== previous
    && currentEnvironment !== undefined
    && currentEnvironment === stripeKeyEnvironment(previous);
}

export const stripeEnvironment = stripeKeyEnvironment(config.stripeSecretKey) ?? 'test';
const stripeRequirements = [
  ['STRIPE_SECRET_KEY', config.stripeSecretKey],
  ['STRIPE_WEBHOOK_SECRET', config.stripeWebhookSecret],
  ['STRIPE_REGULAR_PRICE_ID', config.stripeRegularPriceId],
  ['STRIPE_PRIORITY_PRICE_ID', config.stripePriorityPriceId],
  ['STRIPE_API_PRICE_ID', config.stripeApiPriceId],
  ['STRIPE_PRIORITY_API_PRICE_ID', config.stripePriorityApiPriceId],
] as const;
export const stripeMissingConfiguration = stripeRequirements.filter(([, value]) => value === '').map(([name]) => name);
export const stripeEnabled = stripeMissingConfiguration.length === 0;
export const stripeNewCatalogMissingConfiguration = [
  ['STRIPE_ACCESS_PRICE_ID', config.stripeAccessPriceId],
  ['STRIPE_STANDARD_PRICE_ID', config.stripeStandardPriceId],
  ['STRIPE_PLUS_PRICE_ID', config.stripePlusPriceId],
  ['STRIPE_DEVELOPER_PRICE_ID', config.stripeDeveloperPriceId],
  ['STRIPE_UNLIMITED_PRICE_ID', config.stripeUnlimitedPriceId],
  ['STRIPE_UNLIMITED_PRIORITY_PRICE_ID', config.stripeUnlimitedPriorityPriceId],
].filter(([, value]) => value === '').map(([name]) => name);
if (!['off', 'canary', 'all'].includes(config.billingCatalogRollout)) throw new Error(`env var BILLING_CATALOG_ROLLOUT must be off, canary, or all, got ${config.billingCatalogRollout}`);
if (config.billingCatalogRollout === 'canary' && config.billingCatalogCanaryUserIds.length === 0) throw new Error('BILLING_CATALOG_CANARY_USER_IDS is required when BILLING_CATALOG_ROLLOUT=canary');
if (config.billingCatalogRollout !== 'off' && stripeNewCatalogMissingConfiguration.length > 0) throw new Error(`new billing catalog requires ${stripeNewCatalogMissingConfiguration.join(', ')}`);
export const nowpaymentsEnvironment = config.nowpaymentsEnvironment as 'live' | 'test';
if (config.nowpaymentsEnvironment !== 'live' && config.nowpaymentsEnvironment !== 'test') throw new Error(`env var NOWPAYMENTS_ENVIRONMENT must be live or test, got ${config.nowpaymentsEnvironment}`);
const nowpaymentsRequirements = [
  ['NOWPAYMENTS_API_KEY', config.nowpaymentsApiKey],
  ['NOWPAYMENTS_IPN_SECRET', config.nowpaymentsIpnSecret],
  ['NOWPAYMENTS_API_BASE_URL', config.nowpaymentsApiBaseUrl],
  ['NOWPAYMENTS_OUTCOME_CURRENCY', config.nowpaymentsOutcomeCurrency],
  ['NOWPAYMENTS_PRICE_CURRENCY', config.nowpaymentsPriceCurrency],
] as const;
export const nowpaymentsMissingConfiguration = nowpaymentsRequirements
  .filter(([, value]) => value === '')
  .map(([name]) => name);
export const nowpaymentsConfigured = nowpaymentsMissingConfiguration.length === 0;
export const cryptoBillingEnabled = config.cryptoBillingEnabled && nowpaymentsConfigured;
export function isEmailEnabled(): boolean {
  return config.smtpHost !== '' && config.smtpUser !== '' && config.smtpPass !== '';
}

export const emailEnabled = isEmailEnabled();
