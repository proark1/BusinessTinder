// Lightweight content moderation. Keyword stub today; swap in a real
// classifier (e.g. Claude) by replacing moderateText when MODERATION_API_KEY is set.

const HARD_BLOCK = [
  'free money', 'crypto guarantee', 'get rich', 'wire transfer',
  'send me your', 'gift card', 'nude', 'sex', 'escort',
];

const SOFT_FLAGS = ['urgent', 'lottery', 'inheritance', 'prince', 'bitcoin doubling'];

export function moderateText(text) {
  if (!text || typeof text !== 'string') return { ok: true, action: 'allow' };
  const t = text.toLowerCase();
  for (const term of HARD_BLOCK) {
    if (t.includes(term)) return { ok: false, action: 'block', reason: `blocked term: ${term}` };
  }
  const flags = SOFT_FLAGS.filter((term) => t.includes(term));
  if (flags.length) return { ok: true, action: 'flag', flags };
  return { ok: true, action: 'allow' };
}

// Magic-number signatures for the image types we accept. Verifying the actual
// bytes (not just the declared MIME) stops a caller smuggling a mislabeled or
// non-image payload past the data-URL allow-list.
const IMAGE_SIGNATURES = {
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/jpg': [[0xff, 0xd8, 0xff]],
};

// Validate an image before we store/echo it. https URLs are trusted through
// (we don't fetch remote bytes here); base64 data URLs must (a) be one of the
// accepted types and (b) actually start with that type's magic bytes. This is
// also the seam where an external NSFW/abuse classifier would be called when
// one is configured.
export function moderateImage(input) {
  if (typeof input !== 'string' || !input) return { ok: false, reason: 'empty image' };
  if (/^https?:\/\//i.test(input)) return { ok: true, action: 'allow' };
  const m = input.match(/^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) return { ok: false, reason: 'not a base64 image data URL' };
  const mime = m[1].toLowerCase();
  let head;
  try {
    head = Buffer.from(m[2].slice(0, 32), 'base64'); // enough for any signature
  } catch {
    return { ok: false, reason: 'undecodable base64' };
  }
  if (mime === 'image/webp') {
    // RIFF....WEBP
    const riff = [0x52, 0x49, 0x46, 0x46].every((b, i) => head[i] === b);
    const webp = [0x57, 0x45, 0x42, 0x50].every((b, i) => head[8 + i] === b);
    return riff && webp ? { ok: true, action: 'allow' } : { ok: false, reason: 'bytes do not match image/webp' };
  }
  const sigs = IMAGE_SIGNATURES[mime];
  if (!sigs) return { ok: false, reason: `unsupported image type: ${mime}` };
  const matches = sigs.some((sig) => sig.every((b, i) => head[i] === b));
  return matches ? { ok: true, action: 'allow' } : { ok: false, reason: `bytes do not match ${mime}` };
}
