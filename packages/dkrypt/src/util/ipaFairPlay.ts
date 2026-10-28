import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { parse as parseXmlPlist } from 'plist';
import { parseBuffer as parseBinaryPlist } from 'bplist-parser';

export interface FairPlayVerificationResult {
  encryptedPaths: string[];
  primaryExecutable: string;
  primaryEncrypted: boolean;
}

interface MachOSlice {
  offset: number;
  size: number;
  cpuType: number;
}

export interface IpaFairPlayCompatibility {
  supported: boolean;
  licenseFormat: 'sinf' | 'supf' | 'unknown';
  architectures: string[];
  selector?: string;
  reason?: string;
}

function readUInt32(buffer: Buffer, offset: number, littleEndian: boolean): number | undefined {
  if (offset < 0 || offset + 4 > buffer.length) return undefined;
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function readSlices(buffer: Buffer): MachOSlice[] {
  const magic = readUInt32(buffer, 0, false);
  if (magic === 0xcafebabe || magic === 0xbebafeca || magic === 0xcafebabf || magic === 0xbfbafeca) {
    const littleEndian = magic === 0xbebafeca || magic === 0xbfbafeca;
    const is64 = magic === 0xcafebabf || magic === 0xbfbafeca;
    const count = readUInt32(buffer, 4, littleEndian);
    if (count === undefined || count < 1 || count > 128) return [];
    const stride = is64 ? 32 : 20;
    const slices: MachOSlice[] = [];
    for (let index = 0; index < count; index += 1) {
      const base = 8 + index * stride;
      if (base + stride > buffer.length) return [];
      const offset = is64
        ? littleEndian ? Number(buffer.readBigUInt64LE(base + 8)) : Number(buffer.readBigUInt64BE(base + 8))
        : readUInt32(buffer, base + 8, littleEndian);
      const size = is64
        ? littleEndian ? Number(buffer.readBigUInt64LE(base + 16)) : Number(buffer.readBigUInt64BE(base + 16))
        : readUInt32(buffer, base + 12, littleEndian);
      if (offset === undefined || size === undefined || !Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset + size > buffer.length) return [];
      const cpuType = readUInt32(buffer, base, littleEndian);
      if (cpuType === undefined) return [];
      slices.push({ offset, size, cpuType });
    }
    return slices;
  }
  if ([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(magic ?? -1)) {
    const cpuType = readUInt32(buffer, 4, magic === 0xcefaedfe || magic === 0xcffaedfe);
    return cpuType === undefined ? [] : [{ offset: 0, size: buffer.length, cpuType }];
  }
  return [];
}

function hasEncryptedLoadCommand(buffer: Buffer, slice: MachOSlice): boolean | undefined {
  const magic = readUInt32(buffer, slice.offset, false);
  const littleEndian = magic === 0xcefaedfe || magic === 0xcffaedfe;
  const is64 = magic === 0xfeedfacf || magic === 0xcffaedfe;
  if (![0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(magic ?? -1)) return undefined;
  const headerSize = is64 ? 32 : 28;
  const commandCount = readUInt32(buffer, slice.offset + 16, littleEndian);
  const commandBytes = readUInt32(buffer, slice.offset + 20, littleEndian);
  if (commandCount === undefined || commandBytes === undefined || commandCount > 65_536 || slice.offset + headerSize + commandBytes > slice.offset + slice.size) return undefined;
  let commandOffset = slice.offset + headerSize;
  for (let index = 0; index < commandCount; index += 1) {
    const command = readUInt32(buffer, commandOffset, littleEndian);
    const commandSize = readUInt32(buffer, commandOffset + 4, littleEndian);
    if (command === undefined || commandSize === undefined || commandSize < 8 || commandOffset + commandSize > slice.offset + slice.size) return undefined;
    if ((command === 0x21 || command === 0x2c) && commandSize >= 20) {
      const cryptId = readUInt32(buffer, commandOffset + 16, littleEndian);
      if (cryptId === undefined) return undefined;
      if (cryptId !== 0) return true;
    }
    commandOffset += commandSize;
  }
  return false;
}

function isEncryptedMachO(buffer: Buffer): boolean | undefined {
  const slices = readSlices(buffer);
  if (slices.length === 0) return undefined;
  let parsed = false;
  for (const slice of slices) {
    const encrypted = hasEncryptedLoadCommand(buffer, slice);
    if (encrypted === undefined) continue;
    parsed = true;
    if (encrypted) return true;
  }
  return parsed ? false : undefined;
}

function parseInfoPlist(buffer: Buffer): Record<string, unknown> {
  if (buffer.subarray(0, 8).equals(Buffer.from('bplist00', 'ascii'))) {
    return (parseBinaryPlist(buffer) as Record<string, unknown>[])[0] ?? {};
  }
  return parseXmlPlist(buffer.toString('utf8')) as Record<string, unknown>;
}

function atomFields(data: Buffer, start: number, end: number): Map<string, Buffer> {
  const fields = new Map<string, Buffer>();
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) throw new Error('downloaded IPA contains a truncated FairPlay license');
    const size = data.readUInt32BE(offset);
    if (size < 8 || offset + size > end) throw new Error('downloaded IPA contains an invalid FairPlay license');
    const tag = data.toString('ascii', offset + 4, offset + 8);
    fields.set(tag, data.subarray(offset + 8, offset + size));
    offset += size;
  }
  return fields;
}

function selectorFromSinf(sinf: Buffer): string {
  const root = atomFields(sinf, 0, sinf.length);
  if (root.size !== 1 || !root.has('sinf')) throw new Error('downloaded IPA contains an unsupported FairPlay license');
  const sinfAtom = root.get('sinf')!;
  const sinfFields = atomFields(sinfAtom, 0, sinfAtom.length);
  const schi = sinfFields.get('schi');
  if (!schi) throw new Error('downloaded IPA FairPlay license has no selector');
  const selectorFields = atomFields(schi, 0, schi.length);
  const user = selectorFields.get('user');
  const key = selectorFields.get('key ');
  if (!user || user.length !== 4 || !key || key.length !== 4) {
    throw new Error('downloaded IPA FairPlay license has an invalid selector');
  }
  return createHash('sha256').update(user).update(key).digest('hex');
}

export function inspectIpaFairPlayCompatibility(ipaPath: string): IpaFairPlayCompatibility {
  const archive = new AdmZip(ipaPath);
  const entries = archive.getEntries().filter((entry) => !entry.isDirectory);
  const infoEntry = entries.find((entry) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(entry.entryName));
  const appRoot = infoEntry && /^Payload\/([^/]+\.app)\/Info\.plist$/.exec(infoEntry.entryName)?.[1];
  if (!appRoot || !infoEntry) return { supported: false, licenseFormat: 'unknown', architectures: [], reason: 'primary app bundle metadata is missing' };
  const info = parseInfoPlist(infoEntry.getData());
  const executable = typeof info.CFBundleExecutable === 'string' ? info.CFBundleExecutable : undefined;
  const executableEntry = executable && entries.find((entry) => entry.entryName === `Payload/${appRoot}/${executable}`);
  if (!executableEntry) return { supported: false, licenseFormat: 'unknown', architectures: [], reason: 'primary app executable is missing' };
  const slices = readSlices(executableEntry.getData());
  const architectureNames = new Map<number, string>([[0x0100000c, 'arm64'], [0x01000007, 'x86_64'], [12, 'arm'], [7, 'i386']]);
  const architectures = [...new Set(slices.map((slice) => architectureNames.get(slice.cpuType) ?? `cpu-${slice.cpuType}`))];
  const licenseDirectory = `Payload/${appRoot}/SC_Info/`;
  const sinfEntries = entries.filter((entry) => entry.entryName.startsWith(licenseDirectory) && entry.entryName.endsWith('.sinf') && !entry.entryName.endsWith('.v4.sinf'));
  const supfEntries = entries.filter((entry) => entry.entryName.startsWith(licenseDirectory) && entry.entryName.endsWith('.supf'));
  const licenseFormat = supfEntries.length > 0 ? 'supf' : sinfEntries.length > 0 ? 'sinf' : 'unknown';
  if (supfEntries.length > 0) {
    return { supported: false, licenseFormat, architectures, reason: 'SUPF licenses are not supported by the current server decryptor' };
  }
  if (sinfEntries.length === 0) return { supported: false, licenseFormat, architectures, reason: 'IPA does not contain a supported SINF license' };
  if (!architectures.includes('arm64')) return { supported: false, licenseFormat, architectures, reason: 'primary executable has no supported arm64 slice' };
  try {
    const selectors = new Set(sinfEntries.map((entry) => selectorFromSinf(entry.getData())));
    if (selectors.size > 1) return { supported: false, licenseFormat, architectures, reason: 'IPA contains multiple FairPlay license selectors' };
    return { supported: true, licenseFormat, architectures, selector: selectors.values().next().value! };
  } catch {
    return { supported: false, licenseFormat, architectures, reason: 'SINF license layout is not supported by the current server decryptor' };
  }
}

export function getIpaFairPlayLicenseSelector(ipaPath: string): string {
  const archive = new AdmZip(ipaPath);
  const entries = archive.getEntries().filter((entry) => !entry.isDirectory);
  const appInfo = entries.find((entry) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(entry.entryName));
  const appRoot = appInfo && /^Payload\/([^/]+\.app)\/Info\.plist$/.exec(appInfo.entryName)?.[1];
  if (!appRoot) throw new Error('downloaded IPA does not contain a primary app bundle');
  const sinfEntries = entries.filter((entry) => (
    entry.entryName.startsWith(`Payload/${appRoot}/SC_Info/`)
    && entry.entryName.endsWith('.sinf')
    && !entry.entryName.endsWith('.v4.sinf')
  ));
  const selectors = new Set(sinfEntries.map((entry) => selectorFromSinf(entry.getData())));
  if (selectors.size === 0) throw new Error('downloaded IPA does not contain a supported FairPlay license selector');
  if (selectors.size > 1) throw new Error('downloaded IPA contains multiple FairPlay license selectors');
  return selectors.values().next().value!;
}

export function verifyIpaFairPlayDecrypted(ipaPath: string): FairPlayVerificationResult {
  const archive = new AdmZip(ipaPath);
  const entries = archive.getEntries().filter((entry) => !entry.isDirectory);
  const appInfo = entries.find((entry) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(entry.entryName));
  if (!appInfo) throw new Error('downloaded IPA does not contain Payload/*.app/Info.plist');
  const info = parseInfoPlist(appInfo.getData());
  const appRoot = /^Payload\/([^/]+\.app)\/Info\.plist$/.exec(appInfo.entryName)?.[1];
  if (!appRoot || typeof info.CFBundleExecutable !== 'string' || !info.CFBundleExecutable) {
    throw new Error('downloaded IPA has no primary app executable metadata');
  }
  const primaryExecutable = `Payload/${appRoot}/${info.CFBundleExecutable}`;
  const primaryEntry = entries.find((entry) => entry.entryName === primaryExecutable);
  if (!primaryEntry) throw new Error('downloaded IPA is missing its primary app executable');
  const primaryBuffer = primaryEntry.getData();
  const primarySlices = readSlices(primaryBuffer);
  if (!primarySlices.some((slice) => slice.cpuType === 0x0100000c)) throw new Error('downloaded IPA primary executable has no arm64 Mach-O slice');
  if (isEncryptedMachO(primaryBuffer) === undefined) throw new Error('downloaded IPA primary executable is malformed');
  const encryptedPaths = entries.flatMap((entry) => isEncryptedMachO(entry.getData()) === true ? [entry.entryName] : []);
  const primaryEncrypted = encryptedPaths.includes(primaryExecutable);
  return { encryptedPaths, primaryExecutable, primaryEncrypted };
}
