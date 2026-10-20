import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { config } from '#config.js';
import { deleteAuthProfile, upsertAuthProfile } from '#identity.js';
import { canSendDirectMailToUser, sendDirectMailToUser, sendMailToAllSubscribed, sendMailToUser } from '#mail.js';

async function startSmtpServer(acceptedPassword: string, rejectedAuthCode = 535): Promise<{
  port: number;
  credentials: string[];
  deliveredMessages: number;
  close: () => Promise<void>;
}> {
  const credentials: string[] = [];
  let deliveredMessages = 0;
  const server = createServer((socket) => {
    let pending = '';
    let authentication: 'username' | 'password' | 'data' | undefined;
    const respondToAuthentication = (password: string) => {
      credentials.push(password);
      socket.write(password === acceptedPassword ? '235 authenticated\r\n' : `${rejectedAuthCode} authentication rejected\r\n`);
    };
    socket.write('220 dkrypt.test ESMTP\r\n');
    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\r\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (authentication === 'data') {
          if (line === '.') {
            deliveredMessages += 1;
            authentication = undefined;
            socket.write('250 queued\r\n');
          }
          continue;
        }
        if (authentication === 'username') {
          authentication = 'password';
          socket.write('334 UGFzc3dvcmQ6\r\n');
          continue;
        }
        if (authentication === 'password') {
          const password = Buffer.from(line, 'base64').toString('utf8');
          authentication = undefined;
          respondToAuthentication(password);
          continue;
        }
        if (line.startsWith('EHLO ')) socket.write('250-dkrypt.test\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10485760\r\n');
        else if (line.startsWith('AUTH PLAIN ')) {
          const encoded = line.slice('AUTH PLAIN '.length);
          const password = Buffer.from(encoded, 'base64').toString('utf8').split('\0').at(-1) ?? '';
          respondToAuthentication(password);
        } else if (line === 'AUTH LOGIN') {
          authentication = 'username';
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (line === 'DATA') {
          authentication = 'data';
          socket.write('354 send message\r\n');
        } else if (line === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    credentials,
    get deliveredMessages() {
      return deliveredMessages;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function withSmtpRotationProfile<T>(
  smtp: Awaited<ReturnType<typeof startSmtpServer>>,
  rejectedPassword: string,
  acceptedPassword: string,
  run: (userId: string) => Promise<T>,
): Promise<T> {
  const previousConfig = {
    host: config.smtpHost,
    port: config.smtpPort,
    user: config.smtpUser,
    password: config.smtpPass,
    previousPassword: config.smtpPassPrevious,
    from: config.smtpFrom,
  };
  const userId = `smtp-rotation-${crypto.randomUUID()}`;
  config.smtpHost = '127.0.0.1';
  config.smtpPort = smtp.port;
  config.smtpUser = 'test-user';
  config.smtpPass = rejectedPassword;
  config.smtpPassPrevious = acceptedPassword;
  config.smtpFrom = 'dkrypt@example.test';
  upsertAuthProfile({
    userId,
    provider: 'github',
    providerId: userId,
    username: userId,
    displayName: 'SMTP rotation test',
    email: 'notify@example.test',
    updatedAt: new Date().toISOString(),
  });

  try {
    return await run(userId);
  } finally {
    deleteAuthProfile(userId);
    config.smtpHost = previousConfig.host;
    config.smtpPort = previousConfig.port;
    config.smtpUser = previousConfig.user;
    config.smtpPass = previousConfig.password;
    config.smtpPassPrevious = previousConfig.previousPassword;
    config.smtpFrom = previousConfig.from;
    await smtp.close();
  }
}

describe('mail', () => {
  test('sendMailToUser is a no-op without SMTP configured', async () => {
    await expect(sendMailToUser('nobody', { subject: 'x', text: 'y' })).resolves.toBeUndefined();
  });

  test('sendMailToAllSubscribed is a no-op without SMTP configured', async () => {
    await expect(sendMailToAllSubscribed({ subject: 'x', text: 'y' }, 'deviceAlert')).resolves.toBeUndefined();
  });

  test('delivers once with the previous SMTP password after a definitive current-password rejection', async () => {
    const currentPassword = 'new-current-smtp-password';
    const previousPassword = 'old-previous-smtp-password';
    const smtp = await startSmtpServer(previousPassword);
    await withSmtpRotationProfile(smtp, currentPassword, previousPassword, async (userId) => {
      await sendMailToUser(userId, { subject: 'Rotation test', text: 'Local test message' });

      expect(smtp.credentials).toEqual([currentPassword, previousPassword]);
      expect(smtp.deliveredMessages).toBe(1);
    });
  });

  test('direct mail reports delivery through the configured SMTP transport', async () => {
    const smtp = await startSmtpServer('working-password');
    await withSmtpRotationProfile(smtp, 'working-password', '', async (userId) => {
      expect(canSendDirectMailToUser(userId)).toBe(true);
      await sendDirectMailToUser(userId, { subject: 'Retry available', text: 'You can retry the job.' });
      expect(smtp.deliveredMessages).toBe(1);
    });
  });

  test('does not try the previous SMTP password after a temporary authentication failure', async () => {
    const currentPassword = 'new-current-smtp-password';
    const previousPassword = 'old-previous-smtp-password';
    const smtp = await startSmtpServer(previousPassword, 454);
    await withSmtpRotationProfile(smtp, currentPassword, previousPassword, async (userId) => {
      await sendMailToUser(userId, { subject: 'Rotation test', text: 'Local test message' });

      expect(smtp.credentials).toEqual([currentPassword]);
      expect(smtp.deliveredMessages).toBe(0);
    });
  });
});
