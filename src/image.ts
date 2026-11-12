import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const signatures: Record<string, number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

export function imageType(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.byteLength > MAX_IMAGE_BYTES) return null;
  if (Object.entries(signatures).some(([type, signature]) => signature.every((value, index) => bytes[index] === value))) {
    return bytes[0] === 0xff ? 'image/jpeg' : 'image/png';
  }
  return bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP' ? 'image/webp' : null;
}

export async function storeCampaignImage(file: File): Promise<{ path: string; type: string; cleanup: () => Promise<void> }> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Product images must be 5 MB or smaller.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = imageType(bytes);
  if (bytes.byteLength !== file.size || !type) throw new Error('Choose a valid JPEG, PNG, or WebP image.');
  const id = randomUUID();
  const directory = resolve(process.env.DATA_DIR || './data', 'uploads');
  const filePath = join(directory, id);
  await mkdir(directory, { recursive: true });
  await writeFile(filePath, bytes, { flag: 'wx', mode: 0o644 });
  return { path: `/media/${id}`, type, cleanup: () => rm(filePath, { force: true }) };
}

export { MAX_IMAGE_BYTES };
