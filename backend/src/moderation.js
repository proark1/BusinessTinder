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
