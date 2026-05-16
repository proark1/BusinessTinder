// Curated profile prompts (Hinge-style). Frontend renders these as a picker.
export const PROMPTS = [
  { id: 'building',              label: "I'm building…" },
  { id: 'skill_to_hire',         label: "The skill I'd hire today is…" },
  { id: 'industry_bet',          label: "The bet I'd make in my industry…" },
  { id: 'best_with',             label: "I work best with people who…" },
  { id: 'wrong_about',           label: "Most people in my space are wrong about…" },
  { id: 'shipped',               label: "What I shipped I'm most proud of…" },
  { id: 'learned_hard_way',      label: "Something I learned the hard way…" },
  { id: 'dream_advisor',         label: "My dream advisor would be…" },
  { id: 'biggest_open_question', label: "The biggest open question for my company…" },
  { id: 'first_pilot',           label: "The first pilot customer I'd love…" },
  { id: 'one_year_plan',         label: "In 12 months I want to…" },
  { id: 'side_obsession',        label: "An obsession outside work…" },
];

const VALID_IDS = new Set(PROMPTS.map((p) => p.id));

/**
 * Normalize a client-submitted prompts payload. Accepts either:
 *   { promptIds: [...], promptAnswers: [...] }
 *   { prompts: [{ id, answer }, ...] }
 * Returns { promptIds, promptAnswers } capped to 3 valid entries with trimmed,
 * ≤240-char answers. Any invalid entry is dropped silently.
 */
export function normalizePrompts(input) {
  let pairs = [];
  if (Array.isArray(input?.prompts)) {
    pairs = input.prompts.map((p) => [p?.id, p?.answer]);
  } else if (Array.isArray(input?.promptIds) && Array.isArray(input?.promptAnswers)) {
    pairs = input.promptIds.map((id, i) => [id, input.promptAnswers[i]]);
  }
  const out = [];
  for (const [id, answer] of pairs) {
    if (!VALID_IDS.has(id)) continue;
    const a = String(answer ?? '').trim();
    if (!a) continue;
    out.push([id, a.slice(0, 240)]);
    if (out.length >= 3) break;
  }
  return {
    promptIds: out.map(([id]) => id),
    promptAnswers: out.map(([, a]) => a),
  };
}

export function mutualHighlights(me, them) {
  if (!me || !them) return [];
  const out = [];
  const sharedInd = (me.industries || []).filter((x) => (them.industries || []).includes(x));
  if (sharedInd.length) out.push({ kind: 'industry', label: `Both in ${sharedInd[0]}` });
  const sharedSkills = (me.skills || []).filter((x) => (them.skills || []).includes(x));
  if (sharedSkills.length) out.push({ kind: 'skill', label: `Both bring ${sharedSkills[0]}` });
  if (me.stage && them.stage && me.stage === them.stage) out.push({ kind: 'stage', label: `Same stage` });
  if (me.location && them.location && me.location.toLowerCase() === them.location.toLowerCase()) {
    out.push({ kind: 'location', label: `Same city` });
  } else if (me.remoteOk && them.remoteOk) {
    out.push({ kind: 'remote', label: `Both open to remote` });
  }
  if (
    (me.userType === 'founder' && them.userType === 'cofounder_search') ||
    (me.userType === 'cofounder_search' && them.userType === 'founder')
  ) {
    out.push({ kind: 'pair', label: 'Founder ↔ co-founder' });
  }
  return out.slice(0, 3);
}
