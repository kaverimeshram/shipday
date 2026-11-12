import { describe, expect, it } from 'vitest';
import { imageType, MAX_IMAGE_BYTES } from '../src/image.js';

describe('campaign image inspection', () => {
  it('accepts JPEG, PNG, and WebP signatures', () => {
    expect(imageType(Uint8Array.from([0xff, 0xd8, 0xff, 0x00]))).toBe('image/jpeg');
    expect(imageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(imageType(Uint8Array.from([...'RIFF----WEBP'].map(char => char.charCodeAt(0))))).toBe('image/webp');
    const oversized = new Uint8Array(MAX_IMAGE_BYTES + 1).fill(0);
    oversized.set([0xff, 0xd8, 0xff]);
    expect(imageType(oversized)).toBeNull();
  });

  it('rejects content that only claims to be an image', () => {
    expect(imageType(new TextEncoder().encode('<script>alert(1)</script>'))).toBeNull();
  });
});
