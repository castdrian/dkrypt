import AdmZip from 'adm-zip';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyzeIpaInIsolatedProcess, inspectIpaInIsolatedProcess, optimizeIpaForDeviceInIsolatedProcess } from '#jobs/ipaInspection.js';

function arm64MachO(platform: number): Buffer {
  const image = Buffer.alloc(80);
  image.writeUInt32LE(0xfeedfacf, 0);
  image.writeUInt32LE(0x0100000c, 4);
  image.writeUInt32LE(2, 16);
  image.writeUInt32LE(48, 20);
  image.writeUInt32LE(0x32, 32);
  image.writeUInt32LE(24, 36);
  image.writeUInt32LE(platform, 40);
  image.writeUInt32LE(14 << 16, 44);
  image.writeUInt32LE(17 << 16, 48);
  image.writeUInt32LE(0x2c, 56);
  image.writeUInt32LE(24, 60);
  image.writeUInt32LE(0, 72);
  return image;
}

function universalMachO(): Buffer {
  const arm64 = arm64MachO(2);
  const x86_64 = Buffer.alloc(32);
  x86_64.writeUInt32BE(0xcffaedfe, 0);
  x86_64.writeUInt32LE(0x01000007, 4);
  const arm64Simulator = arm64MachO(7);
  const arm64Offset = 68;
  const x86Offset = arm64Offset + arm64.length;
  const simulatorOffset = x86Offset + x86_64.length;
  const image = Buffer.alloc(simulatorOffset + arm64Simulator.length);
  image.writeUInt32BE(0xcafebabe, 0);
  image.writeUInt32BE(3, 4);
  image.writeUInt32BE(0x0100000c, 8);
  image.writeUInt32BE(0, 12);
  image.writeUInt32BE(arm64Offset, 16);
  image.writeUInt32BE(arm64.length, 20);
  image.writeUInt32BE(0, 24);
  image.writeUInt32BE(0x01000007, 28);
  image.writeUInt32BE(0, 32);
  image.writeUInt32BE(x86Offset, 36);
  image.writeUInt32BE(x86_64.length, 40);
  image.writeUInt32BE(0, 44);
  image.writeUInt32BE(0x0100000c, 48);
  image.writeUInt32BE(0, 52);
  image.writeUInt32BE(simulatorOffset, 56);
  image.writeUInt32BE(arm64Simulator.length, 60);
  image.writeUInt32BE(0, 64);
  arm64.copy(image, arm64Offset);
  x86_64.copy(image, x86Offset);
  arm64Simulator.copy(image, simulatorOffset);
  return image;
}

test('IPA inspection runs in a separate process and returns verified package metadata', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dkrypt-ipa-inspection-'));
  try {
    const ipaPath = path.join(root, 'app.ipa');
    const archive = new AdmZip();
    archive.addFile('Payload/Example.app/Info.plist', Buffer.from('<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.app</string><key>CFBundleExecutable</key><string>Example</string><key>CFBundleShortVersionString</key><string>1.2</string><key>CFBundleVersion</key><string>42</string></dict></plist>'));
    archive.addFile('Payload/Example.app/Example', universalMachO());
    archive.writeZip(ipaPath);
    const inspection = await inspectIpaInIsolatedProcess(ipaPath);

    expect(inspection.metadata.infoPlist.CFBundleIdentifier).toBe('com.example.app');
    expect(inspection.metadata.summary).toMatchObject({ shortVersion: '1.2', bundleVersion: '42' });
    expect(inspection.metadata.summary.architectures).toEqual(['arm64', 'x86_64']);
    expect(inspection.verification).toMatchObject({ primaryExecutable: 'Payload/Example.app/Example', primaryEncrypted: false });
    const optimizedPath = path.join(root, 'optimized.ipa');
    const optimized = await optimizeIpaForDeviceInIsolatedProcess(ipaPath, optimizedPath, 'arm64');
    expect(optimized.optimization).toMatchObject({ architecture: 'arm64', binariesThinned: 1 });
    expect(optimized.sha256).toMatch(/^[a-f0-9]{64}$/);
    const optimizedInspection = await inspectIpaInIsolatedProcess(optimizedPath);
    expect(optimizedInspection.metadata.summary.architectures).toEqual(['arm64']);
    expect(optimizedInspection.verification.primaryEncrypted).toBe(false);
    const optimizedAnalysis = await analyzeIpaInIsolatedProcess(optimizedPath);
    expect(optimizedAnalysis.executables[0]?.slices).toEqual([{ architecture: 'arm64', platform: 'iOS', minimumOsVersion: '14.0', sdkVersion: '17.0' }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
