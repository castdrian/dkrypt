import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { linkOauthAccount, resolveOauthAccount } from '#account.js';
import {
  getBillingCustomerId,
  getBillingEntitlements,
  upsertBillingCustomer,
  upsertBillingSubscription,
} from '#billing.js';
import {
  type AuthIdentity,
  exportIdentitySnapshot,
  getAuthProfile,
  getLinkedAuthProviders,
  removeAuthIdentity,
  replaceIdentitySnapshot,
  setAuthDisplayName,
  setAuthUsername,
} from '#identity.js';
import { PermissionFlag, serializeBits } from '#permissions.js';
import {
  addAllowedUser,
  createApiKey,
  createRole,
  listAllowedUsers,
  listApiKeysForOwner,
} from '#store/state.js';

function identity(
  provider: 'github' | 'discord',
  providerId: string,
  source: 'oauth' | 'discord_connection' = 'oauth',
): AuthIdentity {
  const username = `${provider}-${providerId}`;
  return {
    provider,
    providerId,
    username,
    displayName: username,
    source,
    updatedAt: new Date().toISOString(),
  };
}

describe('resolveOauthAccount', () => {

  test('manually links and merges a separately used OAuth account into the current account', () => {
    const discordId = randomUUID();
    const githubId = randomUUID();
    const discordUserId = `discord:${discordId}`;
    const githubUserId = `github:${githubId}`;

    resolveOauthAccount({ fallbackUserId: githubUserId, identity: identity('github', githubId) });
    const role = createRole(
      {
        name: `Connected account role ${randomUUID()}`,
        color: '#5865f2',
        permissions: serializeBits(PermissionFlag.viewLogs),
      },
      'tester',
    );
    addAllowedUser(githubUserId, [role.id], 'tester');
    createApiKey('connected account key', githubUserId);
    resolveOauthAccount({ fallbackUserId: discordUserId, identity: identity('discord', discordId) });

    const merged = linkOauthAccount(discordUserId, identity('github', githubId));

    expect(merged.userId).toBe(discordUserId);
    expect(getLinkedAuthProviders(discordUserId).sort()).toEqual(['discord', 'github']);
    expect(listAllowedUsers().some((user) => user.username === githubUserId)).toBe(false);
    expect(listAllowedUsers().find((user) => user.username === discordUserId)?.roleIds).toContain(role.id);
    expect(listApiKeysForOwner(discordUserId)).toHaveLength(1);
  });

  test('removes a linked provider while keeping another OAuth identity', () => {
    const discordId = randomUUID();
    const githubId = randomUUID();
    const userId = `discord:${discordId}`;

    resolveOauthAccount({ fallbackUserId: userId, identity: identity('discord', discordId) });
    linkOauthAccount(userId, identity('github', githubId));
    const profile = removeAuthIdentity(userId, 'github');

    expect(profile?.provider).toBe('discord');
    expect(getLinkedAuthProviders(userId)).toEqual(['discord']);
    const reauthenticated = resolveOauthAccount({ fallbackUserId: `github:${githubId}`, identity: identity('github', githubId) });
    expect(reauthenticated.userId).toBe(`github:${githubId}`);
  });

  test('does not merge a Discord GitHub connection into a legacy GitHub account without review', () => {
    const discordId = randomUUID();
    const githubId = randomUUID();
    const discordUserId = `discord:${discordId}`;
    const connectedGithubIdentity = identity('github', githubId, 'discord_connection');
    const legacyGithubUserId = connectedGithubIdentity.username.toLowerCase();
    const role = createRole(
      {
        name: `Connected legacy role ${randomUUID()}`,
        color: '#5865f2',
        permissions: serializeBits(PermissionFlag.viewLogs),
      },
      'tester',
    );
    addAllowedUser(legacyGithubUserId, [role.id], 'tester');
    createApiKey('connected legacy key', legacyGithubUserId);

    const merged = resolveOauthAccount({
      fallbackUserId: discordUserId,
      identity: identity('discord', discordId),
      discoveredIdentities: [connectedGithubIdentity],
    });

    expect(merged.userId).toBe(discordUserId);
    expect(getLinkedAuthProviders(legacyGithubUserId)).toEqual([]);
    expect(listAllowedUsers().some((user) => user.username === discordUserId)).toBe(false);
    expect(listAllowedUsers().find((user) => user.username === legacyGithubUserId)?.roleIds).toContain(role.id);
    expect(listApiKeysForOwner(legacyGithubUserId)).toHaveLength(1);
  });

  test('does not merge a later GitHub login into a legacy account without review', () => {
    const discordId = randomUUID();
    const githubId = randomUUID();
    const discordUserId = `discord:${discordId}`;
    const legacyGithubUserId = `legacy-${randomUUID()}`;

    resolveOauthAccount({
      fallbackUserId: discordUserId,
      identity: identity('discord', discordId),
      discoveredIdentities: [identity('github', githubId, 'discord_connection')],
    });
    const role = createRole(
      {
        name: `Legacy role ${randomUUID()}`,
        color: '#5865f2',
        permissions: serializeBits(PermissionFlag.viewLogs),
      },
      'tester',
    );
    addAllowedUser(legacyGithubUserId, [role.id], 'tester');
    createApiKey('legacy key', legacyGithubUserId);

    const merged = resolveOauthAccount({
      fallbackUserId: legacyGithubUserId,
      identity: identity('github', githubId),
    });

    expect(merged.userId).toBe(legacyGithubUserId);
    expect(getLinkedAuthProviders(legacyGithubUserId)).toEqual(['github']);
    expect(listAllowedUsers().find((user) => user.username === legacyGithubUserId)?.roleIds).toContain(role.id);
    expect(listApiKeysForOwner(legacyGithubUserId)).toHaveLength(1);
  });

  test('keeps later GitHub and Discord logins separate until explicit linking', () => {
    const discordId = randomUUID();
    const githubId = randomUUID();
    const discordUserId = `discord:${discordId}`;

    const discordProfile = resolveOauthAccount({
      fallbackUserId: discordUserId,
      identity: identity('discord', discordId),
      discoveredIdentities: [identity('github', githubId, 'discord_connection')],
    });
    const githubProfile = resolveOauthAccount({
      fallbackUserId: `github:${githubId}`,
      identity: identity('github', githubId),
    });

    expect(discordProfile.userId).toBe(discordUserId);
    expect(githubProfile.userId).toBe(`github:${githubId}`);
    expect(getLinkedAuthProviders(discordUserId)).toEqual(['discord']);
    expect(listAllowedUsers().filter((user) => user.username === discordUserId)).toHaveLength(0);
  });

  test('merges independently used Discord and GitHub accounts only on explicit link', () => {
    const discordId = randomUUID();
    const githubId = randomUUID();
    const discordUserId = `discord:${discordId}`;
    const githubUserId = `github:${githubId}`;

    resolveOauthAccount({
      fallbackUserId: githubUserId,
      identity: identity('github', githubId),
    });
    setAuthDisplayName(githubUserId, 'Chosen profile name');

    resolveOauthAccount({
      fallbackUserId: discordUserId,
      identity: identity('discord', discordId),
    });
    const role = createRole(
      {
        name: `Merged role ${randomUUID()}`,
        color: '#5865f2',
        permissions: serializeBits(PermissionFlag.viewLogs),
      },
      'tester',
    );
    addAllowedUser(discordUserId, [role.id], 'tester');
    createApiKey('merged key', discordUserId);
    upsertBillingCustomer({
      provider: 'stripe',
      customerId: `ctm_${randomUUID()}`,
      email: 'linked@example.com',
      userId: discordUserId,
      updatedAt: new Date().toISOString(),
    });
    upsertBillingSubscription({
      provider: 'stripe',
      subscriptionId: `sub_${randomUUID()}`,
      customerId: getBillingCustomerId(discordUserId) ?? '',
      userId: discordUserId,
      status: 'active',
      planId: 'priority_api',
      priceId: `pri_${randomUUID()}`,
      productId: `pro_${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const independent = resolveOauthAccount({
      fallbackUserId: discordUserId,
      identity: identity('discord', discordId),
      discoveredIdentities: [identity('github', githubId, 'discord_connection')],
    });

    expect(independent.userId).toBe(discordUserId);
    const merged = linkOauthAccount(githubUserId, identity('discord', discordId));
    expect(merged.userId).toBe(githubUserId);
    expect(merged.displayName).toBe('Chosen profile name');
    expect(getLinkedAuthProviders(githubUserId).sort()).toEqual(['discord', 'github']);
    expect(listAllowedUsers().some((user) => user.username === discordUserId)).toBe(false);
    expect(listAllowedUsers().find((user) => user.username === githubUserId)?.roleIds).toContain(role.id);
    expect(listApiKeysForOwner(githubUserId)).toHaveLength(1);
    expect(getBillingCustomerId(githubUserId)).toBeDefined();
    expect(getBillingEntitlements(githubUserId).planId).toBe('priority_api');
  });

  test('keeps a custom profile name through later OAuth refreshes', () => {
    const githubId = randomUUID();
    const userId = `github:${githubId}`;

    resolveOauthAccount({
      fallbackUserId: userId,
      identity: identity('github', githubId),
    });
    setAuthDisplayName(userId, 'Custom name');
    const refreshed = resolveOauthAccount({
      fallbackUserId: userId,
      identity: {
        ...identity('github', githubId),
        displayName: 'Changed provider name',
      },
    });

    expect(refreshed.displayName).toBe('Custom name');
  });

  test('keeps the account name from its first OAuth login after linking another provider', () => {
    const discordId = randomUUID();
    const githubId = randomUUID();
    const userId = `discord:${discordId}`;
    const discordIdentity = { ...identity('discord', discordId), username: 'first-name', displayName: 'First Name' };
    const githubIdentity = { ...identity('github', githubId), username: 'second-name', displayName: 'Second Name' };

    resolveOauthAccount({ fallbackUserId: userId, identity: discordIdentity });
    const linked = linkOauthAccount(userId, githubIdentity);
    expect(linked.username).toBe('first-name');
    expect(linked.displayName).toBe('First Name');
    const viaGithub = resolveOauthAccount({ fallbackUserId: `github:${githubId}`, identity: githubIdentity });
    expect(viaGithub.username).toBe('first-name');
    expect(viaGithub.displayName).toBe('First Name');
    const viaDiscord = resolveOauthAccount({ fallbackUserId: userId, identity: discordIdentity });
    expect(viaDiscord.username).toBe('first-name');
    expect(viaDiscord.displayName).toBe('First Name');
  });

  test('allocates unique account usernames and preserves a chosen username across OAuth refreshes', () => {
    const firstId = randomUUID();
    const secondId = randomUUID();
    const firstUserId = `discord:${firstId}`;
    const secondUserId = `github:${secondId}`;
    const sharedUsername = `shared-${randomUUID().slice(0, 8)}`;
    resolveOauthAccount({ fallbackUserId: firstUserId, identity: { ...identity('discord', firstId), username: sharedUsername } });
    const second = resolveOauthAccount({ fallbackUserId: secondUserId, identity: { ...identity('github', secondId), username: sharedUsername } });
    expect(second.username).toBe(`${sharedUsername}-2`);
    expect(() => setAuthUsername(secondUserId, sharedUsername.toUpperCase())).toThrow('username is already taken');
    setAuthUsername(secondUserId, 'ChosenAccountName');
    const refreshed = resolveOauthAccount({ fallbackUserId: secondUserId, identity: { ...identity('github', secondId), username: 'renamed-on-github' } });
    expect(refreshed.username).toBe('ChosenAccountName');
    expect(() => setAuthUsername(secondUserId, 'root')).toThrow('username is unavailable');
  });

  test('migrates a merged account to its original OAuth name and keeps it across reloads', () => {
    const original = exportIdentitySnapshot();
    const discordId = randomUUID();
    const githubId = randomUUID();
    const userId = `discord:${discordId}`;
    const discordIdentity = { ...identity('discord', discordId), username: 'original-account-name', displayName: 'Original account name' };
    const githubIdentity = { ...identity('github', githubId), username: 'other-provider-name', displayName: 'Other provider name' };
    try {
      replaceIdentitySnapshot({ profiles: [...original.profiles, {
        userId,
        provider: 'github',
        providerId: githubId,
        username: githubIdentity.username,
        displayName: githubIdentity.displayName,
        identities: [discordIdentity, githubIdentity],
        updatedAt: new Date().toISOString(),
      }] }, { persist: false });
      expect(getAuthProfile(userId)).toMatchObject({ username: 'original-account-name', displayName: 'Original account name', customUsername: 'original-account-name' });
      replaceIdentitySnapshot(exportIdentitySnapshot(), { persist: false });
      expect(getAuthProfile(userId)).toMatchObject({ username: 'original-account-name', displayName: 'Original account name' });
    } finally {
      replaceIdentitySnapshot(original);
    }
  });

  test('uses the first linked OAuth identity for legacy username-based account IDs', () => {
    const original = exportIdentitySnapshot();
    const discordId = randomUUID();
    const githubId = randomUUID();
    const userId = `legacy-${randomUUID()}`;
    const firstIdentity = { ...identity('discord', discordId), username: 'first-linked-name', displayName: 'First linked name' };
    const latestIdentity = { ...identity('github', githubId), username: 'latest-login-name', displayName: 'Latest login name' };
    try {
      replaceIdentitySnapshot({ profiles: [...original.profiles, {
        userId,
        provider: 'github',
        providerId: githubId,
        username: latestIdentity.username,
        displayName: latestIdentity.displayName,
        identities: [firstIdentity, latestIdentity],
        updatedAt: new Date().toISOString(),
      }] }, { persist: false });
      expect(getAuthProfile(userId)).toMatchObject({ username: 'first-linked-name', displayName: 'First linked name' });
    } finally {
      replaceIdentitySnapshot(original);
    }
  });
});
