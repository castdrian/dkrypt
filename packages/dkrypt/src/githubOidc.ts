import { createPublicKey, verify, type webcrypto } from 'node:crypto';
import { listGithubOidcPolicies, type GithubOidcPolicy } from '#store/integrationRepository.js';

const issuer = 'https://token.actions.githubusercontent.com';
const jwksUrl = 'https://token.actions.githubusercontent.com/.well-known/jwks';
let cachedKeys = new Map<string, webcrypto.JsonWebKey>();
let cacheUntil = 0;

export interface GithubOidcClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nbf?: number;
  repository_id: string;
  workflow_ref: string;
  ref?: string;
  environment?: string;
}

export function githubOidcPolicyMatches(policy: GithubOidcPolicy, claims: GithubOidcClaims, now = Date.now()): boolean {
  const seconds = Math.floor(now / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  return policy.enabled
    && claims.iss === issuer
    && typeof claims.sub === 'string' && claims.sub.length > 0
    && audience.length === 1 && audience[0] === policy.audience
    && Number.isInteger(claims.exp) && claims.exp > seconds
    && Number.isInteger(claims.iat) && claims.iat <= seconds + 30 && claims.iat >= seconds - 600
    && claims.exp - claims.iat <= 600
    && (claims.nbf === undefined || (Number.isInteger(claims.nbf) && claims.nbf <= seconds + 30))
    && claims.repository_id === policy.repositoryId
    && claims.workflow_ref === policy.workflowRef
    && (policy.ref ? claims.ref === policy.ref : claims.environment === policy.environment)
    && (policy.ref ? !claims.environment : true);
}

async function githubJwks(force = false): Promise<Map<string, webcrypto.JsonWebKey>> {
  if (!force && Date.now() < cacheUntil && cachedKeys.size) return cachedKeys;
  const response = await fetch(jwksUrl, { signal: AbortSignal.timeout(4000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('GitHub OIDC key discovery failed');
  const payload = await response.json() as { keys?: Array<webcrypto.JsonWebKey & { kid?: string; kty?: string; use?: string }> };
  const keys = new Map((payload.keys ?? []).filter((key) => key.kty === 'RSA' && key.alg === 'RS256' && key.use === 'sig' && typeof key.kid === 'string').map((key) => [key.kid!, key]));
  if (!keys.size) throw new Error('GitHub OIDC keys are unavailable');
  cachedKeys = keys;
  cacheUntil = Date.now() + 5 * 60_000;
  return keys;
}

export function verifyGithubOidcSignature(token: string, jwk: webcrypto.JsonWebKey): GithubOidcClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2]!, 'base64url'))) return undefined;
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as GithubOidcClaims;
  } catch {
    return undefined;
  }
}

export async function authenticateGithubOidc(token: string): Promise<GithubOidcPolicy | undefined> {
  if (token.length > 16_384) return undefined;
  const policies = listGithubOidcPolicies().filter((policy) => policy.enabled);
  if (!policies.length) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return undefined;
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as { alg?: string; kid?: string; typ?: string };
    if (header.alg !== 'RS256' || !header.kid || (header.typ && header.typ !== 'JWT')) return undefined;
    let keys = await githubJwks();
    if (!keys.has(header.kid)) keys = await githubJwks(true);
    const jwk = keys.get(header.kid);
    if (!jwk) return undefined;
    const claims = verifyGithubOidcSignature(token, jwk);
    if (!claims) return undefined;
    return policies.find((policy) => githubOidcPolicyMatches(policy, claims));
  } catch {
    return undefined;
  }
}
