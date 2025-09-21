export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif';

const isPng = (buffer: Buffer) =>
  buffer.length >= 8 &&
  buffer[0] === 0x89 &&
  buffer[1] === 0x50 &&
  buffer[2] === 0x4e &&
  buffer[3] === 0x47 &&
  buffer[4] === 0x0d &&
  buffer[5] === 0x0a &&
  buffer[6] === 0x1a &&
  buffer[7] === 0x0a;

const isJpeg = (buffer: Buffer) =>
  buffer.length >= 4 &&
  buffer[0] === 0xff &&
  buffer[1] === 0xd8 &&
  buffer[buffer.length - 2] === 0xff &&
  buffer[buffer.length - 1] === 0xd9;

const isWebp = (buffer: Buffer) =>
  buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';

const isGif = (buffer: Buffer) =>
  buffer.length >= 6 && (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a');

export const detectImageFormat = (buffer: Buffer): ImageFormat | null => {
  if (isPng(buffer)) {
    return 'png';
  }

  if (isJpeg(buffer)) {
    return 'jpeg';
  }

  if (isWebp(buffer)) {
    return 'webp';
  }

  if (isGif(buffer)) {
    return 'gif';
  }

  return null;
};

export const staticImageMimeTypes: Record<'png' | 'jpeg' | 'webp', string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export const isStaticImageFormat = (format: ImageFormat): format is keyof typeof staticImageMimeTypes => format !== 'gif';
