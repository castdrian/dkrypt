import AdmZip from 'adm-zip';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { analyzeIpaPackage, readIpaAssetPreview } from '#ipaAnalysis.js';
import { IpaInspectionCapacity, IpaInspectionCapacityError } from '#jobs/ipaInspection.js';

test('IPA analysis worker capacity bounds active and queued requests', async () => {
  const capacity = new IpaInspectionCapacity(1, 1);
  let finishActive: (() => void) | undefined;
  const active = capacity.run(() => new Promise<void>((resolve) => { finishActive = resolve; }));
  const queued = capacity.run(async () => 'queued');
  await Promise.resolve();

  await expect(capacity.run(async () => 'overflow')).rejects.toBeInstanceOf(IpaInspectionCapacityError);
  finishActive?.();
  await active;
  expect(await queued).toBe('queued');
});

function machOArm64(): Buffer {
  const binary = Buffer.alloc(56);
  binary.writeUInt32BE(0xcffaedfe, 0);
  binary.writeUInt32LE(0x0100000c, 4);
  binary.writeUInt32LE(2, 16);
  binary.writeUInt32LE(24, 20);
  binary.writeUInt32LE(0x32, 32);
  binary.writeUInt32LE(24, 36);
  binary.writeUInt32LE(2, 40);
  binary.writeUInt32LE(14 << 16, 44);
  binary.writeUInt32LE(17 << 16, 48);
  return binary;
}

test('IPA analysis reports each executable slice, provisioning profile, signature file, and previewable asset', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dkrypt-ipa-analysis-'));
  const ipaPath = path.join(directory, 'example.ipa');
  const zip = new AdmZip();
  zip.addFile('Payload/Example.app/Info.plist', Buffer.from('<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.app</string><key>CFBundleExecutable</key><string>Example</string></dict></plist>'));
  zip.addFile('Payload/Example.app/Example', machOArm64());
  zip.addFile('Payload/Example.app/_CodeSignature/CodeResources', Buffer.from('signature'));
  zip.addFile('Payload/Example.app/embedded.mobileprovision', Buffer.from('<?xml version="1.0"?><plist version="1.0"><dict><key>Name</key><string>Example Development</string><key>UUID</key><string>profile-uuid</string><key>TeamIdentifier</key><array><string>TEAM123</string></array><key>Platform</key><array><string>iOS</string></array><key>CreationDate</key><date>2026-01-01T00:00:00Z</date><key>ExpirationDate</key><date>2027-01-01T00:00:00Z</date><key>ProvisionedDevices</key><array><string>device-one</string><string>device-two</string></array><key>Entitlements</key><dict><key>get-task-allow</key><true/><key>application-identifier</key><string>TEAM123.com.example.app</string></dict></dict></plist>'));
  zip.addFile('Payload/Example.app/Assets/icon.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  zip.writeZip(ipaPath);

  try {
    const report = analyzeIpaPackage(ipaPath);
    expect(report.executables).toEqual([{
      path: 'Payload/Example.app/Example',
      kind: 'app',
      bundleId: 'com.example.app',
      slices: [{ architecture: 'arm64', platform: 'iOS', minimumOsVersion: '14.0', sdkVersion: '17.0' }],
      analysisState: 'analyzed',
    }]);
    expect(report.signing.signatureFiles).toContain('Payload/Example.app/_CodeSignature/CodeResources');
    expect(report.signing.profiles[0]).toMatchObject({
      name: 'Example Development',
      uuid: 'profile-uuid',
      teamIdentifiers: ['TEAM123'],
      platforms: ['iOS'],
      provisionedDeviceCount: 2,
      distribution: 'development',
      getTaskAllowed: true,
      applicationIdentifier: 'TEAM123.com.example.app',
    });
    expect(report.assets).toMatchObject([{ path: 'Payload/Example.app/Assets/icon.png', mimeType: 'image/png' }]);
    expect(readIpaAssetPreview(ipaPath, report.assets[0]!.path)).toEqual({ data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), mimeType: 'image/png' });
    expect(() => readIpaAssetPreview(ipaPath, 'Payload/../outside.png')).toThrow('invalid');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
