export function ipaFileSharingAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && typeof File !== 'undefined';
}

function safeFilename(value: string): string {
  const normalized = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().replace(/\.+$/g, '');
  const base = normalized || 'dkrypt-result';
  return base.toLowerCase().endsWith('.ipa') ? base : `${base}.ipa`;
}

export async function prepareIpaForSharing(url: string, suggestedName: string): Promise<File> {
  if (!ipaFileSharingAvailable()) throw new Error('File sharing is not available in this browser');
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(response.status === 410 ? 'This temporary result has expired' : 'Could not open the IPA');
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > 512 * 1024 * 1024) throw new Error('This IPA is too large to pass through the share sheet. Download it first, then share it from Files.');
  const maximumSize = 512 * 1024 * 1024;
  let blob: Blob;
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: BlobPart[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximumSize) {
          await reader.cancel();
          throw new Error('This IPA is too large to pass through the share sheet. Download it first, then share it from Files.');
        }
        const chunk = new Uint8Array(value.byteLength);
        chunk.set(value);
        chunks.push(chunk.buffer);
      }
    } finally {
      reader.releaseLock();
    }
    blob = new Blob(chunks, { type: 'application/octet-stream' });
  } else {
    blob = await response.blob();
  }
  if (blob.size > maximumSize) throw new Error('This IPA is too large to pass through the share sheet. Download it first, then share it from Files.');
  const file = new File([blob], safeFilename(suggestedName), { type: 'application/octet-stream' });
  if (!navigator.canShare?.({ files: [file] })) throw new Error('This browser cannot share IPA files. Download it first, then share it from Files.');
  return file;
}

export async function sharePreparedIpa(file: File, title: string): Promise<void> {
  if (!ipaFileSharingAvailable() || !navigator.canShare({ files: [file] })) throw new Error('This browser cannot share IPA files. Download it first, then share it from Files.');
  await navigator.share({ files: [file], title });
}
