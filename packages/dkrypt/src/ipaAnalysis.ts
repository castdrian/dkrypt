import AdmZip from 'adm-zip';
import { parseBuffer as parseBinaryPlist } from 'bplist-parser';
import { parse as parseXmlPlist } from 'plist';
import { statSync } from 'node:fs';

export interface IpaExecutableSlice {
  architecture: string;
  platform?: string;
  minimumOsVersion?: string;
  sdkVersion?: string;
}

export interface IpaExecutableReport {
  path: string;
  kind: 'app' | 'extension' | 'framework' | 'dynamic-library' | 'other';
  bundleId?: string;
  slices: IpaExecutableSlice[];
  analysisState: 'analyzed' | 'too_large' | 'invalid';
}

export interface IpaSigningProfileReport {
  path: string;
  name?: string;
  uuid?: string;
  teamIdentifiers: string[];
  platforms: string[];
  createdAt?: string;
  expiresAt?: string;
  provisionedDeviceCount?: number;
  distribution: 'development' | 'ad_hoc' | 'enterprise' | 'app_store' | 'unknown';
  getTaskAllowed?: boolean;
  applicationIdentifier?: string;
}

export interface IpaAssetReport {
  path: string;
  sizeBytes: number;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

export interface IpaAnalysisReport {
  executables: IpaExecutableReport[];
  signing: {
    signatureFiles: string[];
    profiles: IpaSigningProfileReport[];
    certificateDetailsAvailable: false;
  };
  assets: IpaAssetReport[];
  assetsTruncated: boolean;
  totalFiles: number;
}

interface MachOSlice {
  architecture: string;
  platform?: string;
  minimumOsVersion?: string;
  sdkVersion?: string;
}

const maxArchiveEntries = 100_000;
const maxTotalExpandedBytes = 4 * 1024 * 1024 * 1024;
const maxExecutableBytes = 256 * 1024 * 1024;
const maxExecutables = 2_000;
const maxAssets = 2_000;
const maxSignatureFiles = 500;
const imageTypes: Record<string, IpaAssetReport['mimeType']> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

function cpuArchitecture(cpuType: number): string {
  return ({
    7: 'i386',
    12: 'arm',
    18: 'ppc',
    0x01000007: 'x86_64',
    0x0100000c: 'arm64',
    0x01000012: 'ppc64',
  } as Record<number, string>)[cpuType] ?? `cpu-${cpuType}`;
}

function readVersion(value: number): string {
  const parts = [(value >>> 16) & 0xffff, (value >>> 8) & 0xff, value & 0xff];
  return parts[2] ? parts.join('.') : parts.slice(0, 2).join('.');
}

function platformName(value: number): string | undefined {
  return ({
    1: 'macOS',
    2: 'iOS',
    3: 'tvOS',
    4: 'watchOS',
    6: 'Mac Catalyst',
    7: 'iOS Simulator',
    8: 'tvOS Simulator',
    9: 'watchOS Simulator',
  } as Record<number, string>)[value];
}

function readUInt32(buffer: Buffer, offset: number, littleEndian: boolean): number | undefined {
  if (offset < 0 || offset + 4 > buffer.length) return undefined;
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function parseThinMachO(buffer: Buffer, start: number, end: number): MachOSlice | undefined {
  if (start + 28 > end) return undefined;
  const magic = buffer.readUInt32BE(start);
  const littleEndian = magic === 0xcefaedfe || magic === 0xcffaedfe;
  const isMachO = [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(magic);
  if (!isMachO) return undefined;
  const cpuType = readUInt32(buffer, start + 4, littleEndian);
  const commandCount = readUInt32(buffer, start + 16, littleEndian);
  const commandBytes = readUInt32(buffer, start + 20, littleEndian);
  if (cpuType === undefined || commandCount === undefined || commandBytes === undefined || commandCount > 65_535) return undefined;
  const headerSize = magic === 0xfeedfacf || magic === 0xcffaedfe ? 32 : 28;
  let cursor = start + headerSize;
  const commandEnd = Math.min(end, cursor + commandBytes);
  const result: MachOSlice = { architecture: cpuArchitecture(cpuType) };
  for (let index = 0; index < commandCount; index += 1) {
    if (cursor + 8 > commandEnd) break;
    const command = readUInt32(buffer, cursor, littleEndian);
    const size = readUInt32(buffer, cursor + 4, littleEndian);
    if (command === undefined || size === undefined || size < 8 || cursor + size > commandEnd) break;
    if (command === 0x32 && size >= 24) {
      const platform = readUInt32(buffer, cursor + 8, littleEndian);
      const minimumOs = readUInt32(buffer, cursor + 12, littleEndian);
      const sdk = readUInt32(buffer, cursor + 16, littleEndian);
      if (platform !== undefined) result.platform = platformName(platform);
      if (minimumOs !== undefined) result.minimumOsVersion = readVersion(minimumOs);
      if (sdk !== undefined) result.sdkVersion = readVersion(sdk);
    } else if (command === 0x25 && size >= 16) {
      const minimumOs = readUInt32(buffer, cursor + 8, littleEndian);
      const sdk = readUInt32(buffer, cursor + 12, littleEndian);
      result.platform = 'iOS';
      if (minimumOs !== undefined) result.minimumOsVersion = readVersion(minimumOs);
      if (sdk !== undefined) result.sdkVersion = readVersion(sdk);
    }
    cursor += size;
  }
  return result;
}

function parseMachOSlices(buffer: Buffer): MachOSlice[] {
  if (buffer.length < 4) return [];
  const magic = buffer.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xbebafeca || magic === 0xcafebabf || magic === 0xbfbafeca) {
    const littleEndian = magic === 0xbebafeca || magic === 0xbfbafeca;
    const is64 = magic === 0xcafebabf || magic === 0xbfbafeca;
    const count = readUInt32(buffer, 4, littleEndian);
    if (count === undefined || count > 4_096) return [];
    const recordSize = is64 ? 32 : 20;
    const slices: MachOSlice[] = [];
    for (let index = 0; index < count; index += 1) {
      const recordOffset = 8 + index * recordSize;
      const offset = is64
        ? Number(littleEndian ? buffer.readBigUInt64LE(recordOffset + 8) : buffer.readBigUInt64BE(recordOffset + 8))
        : readUInt32(buffer, recordOffset + 8, littleEndian);
      const size = is64
        ? Number(littleEndian ? buffer.readBigUInt64LE(recordOffset + 16) : buffer.readBigUInt64BE(recordOffset + 16))
        : readUInt32(buffer, recordOffset + 12, littleEndian);
      if (offset === undefined || size === undefined || !Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset + size > buffer.length) continue;
      const slice = parseThinMachO(buffer, offset, offset + size);
      if (slice && !slices.some((candidate) => candidate.architecture === slice.architecture && candidate.platform === slice.platform)) slices.push(slice);
    }
    return slices;
  }
  const slice = parseThinMachO(buffer, 0, buffer.length);
  return slice ? [slice] : [];
}

interface FatMachOSlice {
  architecture: string;
  platform?: string;
  cpuType: number;
  cpuSubtype: number;
  offset: number;
  size: number;
  align: number;
}

function parseFatMachOSlices(buffer: Buffer): FatMachOSlice[] | undefined {
  if (buffer.length < 8) return undefined;
  const magic = buffer.readUInt32BE(0);
  if (![0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) return undefined;
  const littleEndian = magic === 0xbebafeca || magic === 0xbfbafeca;
  const is64 = magic === 0xcafebabf || magic === 0xbfbafeca;
  const count = readUInt32(buffer, 4, littleEndian);
  const stride = is64 ? 32 : 20;
  if (count === undefined || count < 1 || count > 4_096 || 8 + count * stride > buffer.length) return [];
  const slices: FatMachOSlice[] = [];
  for (let index = 0; index < count; index += 1) {
    const recordOffset = 8 + index * stride;
    const cpuType = readUInt32(buffer, recordOffset, littleEndian);
    const cpuSubtype = readUInt32(buffer, recordOffset + 4, littleEndian);
    const offset = is64
      ? Number(littleEndian ? buffer.readBigUInt64LE(recordOffset + 8) : buffer.readBigUInt64BE(recordOffset + 8))
      : readUInt32(buffer, recordOffset + 8, littleEndian);
    const size = is64
      ? Number(littleEndian ? buffer.readBigUInt64LE(recordOffset + 16) : buffer.readBigUInt64BE(recordOffset + 16))
      : readUInt32(buffer, recordOffset + 12, littleEndian);
    const align = readUInt32(buffer, recordOffset + (is64 ? 24 : 16), littleEndian);
    if (cpuType === undefined || cpuSubtype === undefined || offset === undefined || size === undefined || align === undefined
      || !Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || size <= 0 || offset < 8 + count * stride || offset + size > buffer.length) return [];
    const parsed = parseThinMachO(buffer, offset, offset + size);
    if (!parsed) return [];
    slices.push({ architecture: parsed.architecture, platform: parsed.platform, cpuType, cpuSubtype, offset, size, align });
  }
  const ordered = [...slices].sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    if (previous.offset + previous.size > ordered[index]!.offset) return [];
  }
  return slices;
}

function alignOffset(value: number, power: number): number {
  const alignment = 2 ** Math.min(Math.max(power, 0), 20);
  return Math.ceil(value / alignment) * alignment;
}

function thinFatMachO(buffer: Buffer, architecture: string): Buffer | undefined {
  const slices = parseFatMachOSlices(buffer);
  if (!slices || slices.length === 0) return undefined;
  const retained = slices.filter((slice) => slice.architecture === architecture && slice.platform === 'iOS');
  if (retained.length === 0 || retained.length === slices.length) return undefined;
  if (retained.length === 1) {
    const slice = retained[0]!;
    return Buffer.from(buffer.subarray(slice.offset, slice.offset + slice.size));
  }
  const headerSize = 8 + retained.length * 20;
  let cursor = headerSize;
  const placements = retained.map((slice) => {
    cursor = alignOffset(cursor, slice.align);
    const placement = { slice, offset: cursor };
    cursor += slice.size;
    return placement;
  });
  if (cursor > 0xffffffff) return undefined;
  const output = Buffer.alloc(cursor);
  output.writeUInt32BE(0xcafebabe, 0);
  output.writeUInt32BE(placements.length, 4);
  for (const [index, placement] of placements.entries()) {
    const recordOffset = 8 + index * 20;
    output.writeUInt32BE(placement.slice.cpuType, recordOffset);
    output.writeUInt32BE(placement.slice.cpuSubtype, recordOffset + 4);
    output.writeUInt32BE(placement.offset, recordOffset + 8);
    output.writeUInt32BE(placement.slice.size, recordOffset + 12);
    output.writeUInt32BE(Math.min(placement.slice.align, 20), recordOffset + 16);
    buffer.copy(output, placement.offset, placement.slice.offset, placement.slice.offset + placement.slice.size);
  }
  return output;
}

export interface IpaDeviceOptimizationResult {
  architecture: string;
  binariesThinned: number;
  bytesSaved: number;
  originalBytes: number;
  optimizedBytes: number;
}

export function optimizeIpaForArchitecture(ipaPath: string, outputPath: string, architecture: string): IpaDeviceOptimizationResult {
  if (architecture !== 'arm64') throw new Error('only arm64 iOS device optimization is supported');
  const originalBytes = statSync(ipaPath).size;
  if (originalBytes > 512 * 1024 * 1024) throw new Error('IPA exceeds the safe device-optimization size limit');
  const archive = new AdmZip(ipaPath);
  const entries = archive.getEntries();
  if (entries.length > maxArchiveEntries) throw new Error('IPA contains too many files to optimize safely');
  const totalExpandedBytes = entries.reduce((total, entry) => total + (entry.header.size ?? 0), 0);
  if (totalExpandedBytes > 384 * 1024 * 1024) throw new Error('IPA expands beyond the safe device-optimization limit');
  let binariesThinned = 0;
  for (const entry of entries) {
    if (entry.isDirectory || !entry.entryName.startsWith('Payload/')) continue;
    const original = entry.getData();
    if (original.length < 8) continue;
    const optimized = thinFatMachO(original, architecture);
    if (!optimized || optimized.length >= original.length) continue;
    entry.setData(optimized);
    binariesThinned += 1;
  }
  archive.writeZip(outputPath);
  const optimizedBytes = statSync(outputPath).size;
  return { architecture, binariesThinned, bytesSaved: originalBytes - optimizedBytes, originalBytes, optimizedBytes };
}

function executableKind(filePath: string): IpaExecutableReport['kind'] {
  if (/\.appex\//i.test(filePath)) return 'extension';
  if (/\.app\//i.test(filePath) && !/\/Frameworks\//i.test(filePath)) return 'app';
  if (/\.framework\//i.test(filePath)) return 'framework';
  if (/\.dylib$/i.test(filePath)) return 'dynamic-library';
  return 'other';
}

interface BundleMetadata {
  bundleId?: string;
  executablePath?: string;
}

function bundleMetadata(entries: AdmZip.IZipEntry[]): Map<string, BundleMetadata> {
  const result = new Map<string, BundleMetadata>();
  for (const entry of entries) {
    if (!/^Payload\/.+\.(?:app|appex|framework)\/Info\.plist$/i.test(entry.entryName)) continue;
    try {
      const data = entry.getData();
      const plist = (data.subarray(0, 8).toString('utf8') === 'bplist00'
        ? (parseBinaryPlist(data) as Record<string, unknown>[])[0]
        : parseXmlPlist(data.toString('utf8'))) as Record<string, unknown>;
      const root = entry.entryName.slice(0, -'/Info.plist'.length);
      const metadata: BundleMetadata = {};
      if (typeof plist.CFBundleIdentifier === 'string' && /\.(?:app|appex)$/i.test(root)) metadata.bundleId = plist.CFBundleIdentifier;
      if (typeof plist.CFBundleExecutable === 'string' && /^[^/\\\0]{1,255}$/.test(plist.CFBundleExecutable)) metadata.executablePath = `${root}/${plist.CFBundleExecutable}`;
      result.set(root, metadata);
    } catch {}
  }
  return result;
}

function bundleIdForPath(filePath: string, roots: Map<string, BundleMetadata>): string | undefined {
  let bestRoot = '';
  let result: string | undefined;
  for (const [root, metadata] of roots) {
    if (filePath.startsWith(`${root}/`) && root.length > bestRoot.length) {
      bestRoot = root;
      result = metadata.bundleId;
    }
  }
  return result;
}

function profileObject(entry: AdmZip.IZipEntry): IpaSigningProfileReport | undefined {
  const content = entry.getData().toString('utf8');
  const start = content.indexOf('<plist');
  const end = content.indexOf('</plist>');
  if (start < 0 || end < 0) return undefined;
  try {
    const profile = parseXmlPlist(content.slice(start, end + '</plist>'.length)) as Record<string, unknown>;
    const entitlements = profile.Entitlements && typeof profile.Entitlements === 'object' ? profile.Entitlements as Record<string, unknown> : {};
    const dateValue = (value: unknown) => value instanceof Date ? value.toISOString() : undefined;
    const stringArray = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 20) : [];
    const provisionedDevices = Array.isArray(profile.ProvisionedDevices) ? profile.ProvisionedDevices : undefined;
    const taskAllowed = entitlements['get-task-allow'];
    const allDevices = profile.ProvisionsAllDevices === true;
    const appStoreDistribution = provisionedDevices === undefined && !allDevices;
    const distribution = allDevices ? 'enterprise' : appStoreDistribution ? 'app_store' : taskAllowed === true ? 'development' : 'ad_hoc';
    return {
      path: entry.entryName,
      ...(typeof profile.Name === 'string' ? { name: profile.Name.slice(0, 160) } : {}),
      ...(typeof profile.UUID === 'string' ? { uuid: profile.UUID.slice(0, 80) } : {}),
      teamIdentifiers: stringArray(profile.TeamIdentifier),
      platforms: stringArray(profile.Platform),
      ...(dateValue(profile.CreationDate) ? { createdAt: dateValue(profile.CreationDate) } : {}),
      ...(dateValue(profile.ExpirationDate) ? { expiresAt: dateValue(profile.ExpirationDate) } : {}),
      ...(provisionedDevices ? { provisionedDeviceCount: provisionedDevices.length } : {}),
      distribution,
      ...(typeof taskAllowed === 'boolean' ? { getTaskAllowed: taskAllowed } : {}),
      ...(typeof entitlements['application-identifier'] === 'string' ? { applicationIdentifier: String(entitlements['application-identifier']).slice(0, 240) } : {}),
    };
  } catch {
    return undefined;
  }
}

export function analyzeIpaPackage(ipaPath: string): IpaAnalysisReport {
  const zip = new AdmZip(ipaPath);
  const entries = zip.getEntries();
  if (entries.length > maxArchiveEntries) throw new Error('IPA contains too many files to analyze safely');
  const totalExpanded = entries.reduce((total, entry) => total + (entry.header.size ?? 0), 0);
  if (totalExpanded > maxTotalExpandedBytes) throw new Error('IPA expands beyond the analysis size limit');
  const roots = bundleMetadata(entries);
  const executablePaths = new Set([...roots.values()].flatMap((metadata) => metadata.executablePath ? [metadata.executablePath] : []));
  const executables: IpaExecutableReport[] = [];
  const signatureFiles: string[] = [];
  const profiles: IpaSigningProfileReport[] = [];
  const assets: IpaAssetReport[] = [];
  let assetsTruncated = false;

  for (const entry of entries) {
    if (entry.isDirectory || !entry.entryName.startsWith('Payload/')) continue;
    if (/_CodeSignature\//.test(entry.entryName) && signatureFiles.length < maxSignatureFiles) signatureFiles.push(entry.entryName);
    if (/\/embedded\.mobileprovision$/i.test(entry.entryName)) {
      const profile = profileObject(entry);
      if (profile) profiles.push(profile);
    }
    const extension = /\.([^.\/]+)$/.exec(entry.entryName)?.[1]?.toLowerCase();
    const mimeType = extension ? imageTypes[extension] : undefined;
    if (mimeType) {
      if (assets.length < maxAssets) assets.push({ path: entry.entryName, sizeBytes: entry.header.size ?? 0, mimeType });
      else assetsTruncated = true;
    }
    if (executables.length >= maxExecutables) continue;
    const size = entry.header.size ?? 0;
    if (size > maxExecutableBytes) {
      if (executablePaths.has(entry.entryName) || /\.dylib$/i.test(entry.entryName)) {
        executables.push({ path: entry.entryName, kind: executableKind(entry.entryName), bundleId: bundleIdForPath(entry.entryName, roots), slices: [], analysisState: 'too_large' });
      }
      continue;
    }
    const data = entry.getData();
    const slices = parseMachOSlices(data);
    if (slices.length > 0) {
      executables.push({ path: entry.entryName, kind: executableKind(entry.entryName), bundleId: bundleIdForPath(entry.entryName, roots), slices, analysisState: 'analyzed' });
    } else if (data.length >= 4 && [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(data.readUInt32BE(0))) {
      executables.push({ path: entry.entryName, kind: executableKind(entry.entryName), bundleId: bundleIdForPath(entry.entryName, roots), slices: [], analysisState: 'invalid' });
    }
  }

  return {
    executables,
    signing: { signatureFiles: signatureFiles.sort(), profiles, certificateDetailsAvailable: false },
    assets,
    assetsTruncated,
    totalFiles: entries.filter((entry) => !entry.isDirectory).length,
  };
}

export function readIpaAssetPreview(ipaPath: string, assetPath: string): { data: Buffer; mimeType: IpaAssetReport['mimeType'] } {
  if (!assetPath.startsWith('Payload/') || assetPath.includes('..') || assetPath.includes('\\') || assetPath.includes('\0')) throw new Error('IPA asset path is invalid');
  const extension = /\.([^.\/]+)$/.exec(assetPath)?.[1]?.toLowerCase();
  const mimeType = extension ? imageTypes[extension] : undefined;
  if (!mimeType) throw new Error('IPA asset preview is not supported for this file type');
  const entry = new AdmZip(ipaPath).getEntry(assetPath);
  if (!entry || entry.isDirectory) throw new Error('IPA image asset was not found');
  if ((entry.header.size ?? 0) > 8 * 1024 * 1024) throw new Error('IPA image asset exceeds the preview size limit');
  return { data: entry.getData(), mimeType };
}
