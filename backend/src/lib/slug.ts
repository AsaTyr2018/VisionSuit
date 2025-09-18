const DEFAULT_FALLBACK = 'item';

const toAscii = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]+/g, '')
    .trim();

export const slugify = (value: string, fallback = DEFAULT_FALLBACK): string => {
  const normalized = toAscii(value)
    .toLowerCase()
    .replace(/[_\s-]+/g, '-');

  const compacted = normalized.replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');

  if (compacted.length > 0) {
    return compacted;
  }

  const fallbackValue = toAscii(fallback)
    .toLowerCase()
    .replace(/[_\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return fallbackValue.length > 0 ? fallbackValue : DEFAULT_FALLBACK;
};

export const buildUniqueSlug = async (
  baseValue: string,
  exists: (slug: string) => Promise<boolean>,
  fallback = DEFAULT_FALLBACK,
): Promise<string> => {
  const base = slugify(baseValue, fallback);
  let candidate = base;
  let index = 2;

  // eslint-disable-next-line no-await-in-loop
  while (await exists(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }

  return candidate;
};

export const sanitizeFilename = (value: string, fallback = DEFAULT_FALLBACK) => {
  const extensionMatch = value.match(/\.([^.]+)$/);
  const extension = extensionMatch?.[1] ? `.${extensionMatch[1].toLowerCase()}` : '';
  const basename = extension ? value.slice(0, -extension.length) : value;
  const slug = slugify(basename, fallback);
  return `${slug}${extension}`;
};
