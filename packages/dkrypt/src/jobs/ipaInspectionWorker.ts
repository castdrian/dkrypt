import { extractIpaMetadata } from '#util/ipaMetadata.js';
import { verifyIpaFairPlayDecrypted } from '#util/ipaFairPlay.js';
import { analyzeIpaPackage, readIpaAssetPreview } from '#ipaAnalysis.js';

const ipaPath = process.argv[2];
const mode = process.argv[3] ?? 'inspect';

if (!ipaPath) {
  process.stderr.write('IPA path is required');
  process.exitCode = 1;
} else {
  try {
    if (mode === 'analysis') {
      process.stdout.write(JSON.stringify(analyzeIpaPackage(ipaPath)));
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
