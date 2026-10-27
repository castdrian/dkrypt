import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { extractIpaMetadata } from '#util/ipaMetadata.js';
import { verifyIpaFairPlayDecrypted } from '#util/ipaFairPlay.js';
import { analyzeIpaPackage, optimizeIpaForArchitecture, readIpaAssetPreview } from '#ipaAnalysis.js';

const ipaPath = process.argv[2];
const mode = process.argv[3] ?? 'inspect';

async function fileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

if (!ipaPath) {
  process.stderr.write('IPA path is required');
  process.exitCode = 1;
} else {
  try {
    if (mode === 'analysis') {
      process.stdout.write(JSON.stringify(analyzeIpaPackage(ipaPath)));
    } else if (mode === 'optimize') {
      const outputPath = process.argv[4];
      const architecture = process.argv[5];
      if (!outputPath || !architecture) throw new Error('optimized IPA output path and architecture are required');
      const optimization = optimizeIpaForArchitecture(ipaPath, outputPath, architecture);
      if (optimization.binariesThinned === 0 || optimization.bytesSaved <= 0) throw new Error('this IPA has no removable non-device architecture slices');
      const [originalMetadata, metadata, verification, sha256] = await Promise.all([
        extractIpaMetadata(ipaPath),
        extractIpaMetadata(outputPath),
        Promise.resolve(verifyIpaFairPlayDecrypted(outputPath)),
        fileSha256(outputPath),
      ]);
      if (!metadata.summary.architectures?.includes(architecture)) throw new Error('optimized IPA no longer contains the selected device architecture');
      if (verification.primaryEncrypted) throw new Error('optimized IPA primary executable did not pass FairPlay verification');
      if (metadata.infoPlist.CFBundleIdentifier !== originalMetadata.infoPlist.CFBundleIdentifier
        || metadata.infoPlist.CFBundleVersion !== originalMetadata.infoPlist.CFBundleVersion
        || metadata.infoPlist.CFBundleExecutable !== originalMetadata.infoPlist.CFBundleExecutable) throw new Error('optimized IPA identity does not match the source artifact');
      process.stdout.write(JSON.stringify({ optimization, sha256 }));
    } else if (mode === 'asset-preview') {
      const assetPath = process.argv[4];
      if (!assetPath) throw new Error('IPA asset path is required');
      const preview = readIpaAssetPreview(ipaPath, assetPath);
      process.stdout.write(JSON.stringify({ data: preview.data.toString('base64'), mimeType: preview.mimeType }));
    } else {
      const [metadata, verification] = await Promise.all([
        extractIpaMetadata(ipaPath),
        Promise.resolve(verifyIpaFairPlayDecrypted(ipaPath)),
      ]);
      process.stdout.write(JSON.stringify({ metadata, verification }));
    }
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
