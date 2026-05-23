// Match-affinity scoring. Pure function over profile shapes.
// Score is 0–100 plus a short list of human-readable reasons.

const COMPLEMENTARY = {
  // Looking-for → skills that make the candidate more useful
  cofounder: ['Engineering', 'Design', 'Product', 'Sales', 'Marketing'],
  hires: ['Engineering', 'Design', 'Product', 'Sales', 'Ops'],
  customers: ['Sales', 'Marketing', 'Domain expert'],
  investors: ['Capital'],
  advisors: ['Domain expert', 'Capital'],
  partnerships: ['Sales', 'Ops', 'Domain expert'],
  networking: [],
};

const STAGE_COMPAT = {
  idea: { idea: 1, mvp: 0.8, live: 0.4, revenue: 0.2, scaling: 0.1 },
  mvp: { idea: 0.7, mvp: 1, live: 0.8, revenue: 0.4, scaling: 0.2 },
  live: { idea: 0.3, mvp: 0.7, live: 1, revenue: 0.8, scaling: 0.4 },
  revenue: { idea: 0.1, mvp: 0.3, live: 0.7, revenue: 1, scaling: 0.8 },
  scaling: { idea: 0.0, mvp: 0.2, live: 0.4, revenue: 0.8, scaling: 1 },
};

export function scoreProfile(me, them) {
  if (!me || !them) return { score: 0, reasons: [] };
  let score = 0;
  const reasons = [];

  const myInd = new Set(me.industries || []);
  const theirInd = new Set(them.industries || []);
  const sharedInd = [...myInd].filter((x) => theirInd.has(x));
  if (sharedInd.length) {
    const points = Math.min(sharedInd.length * 8, 25);
    score += points;
    reasons.push(`Shared: ${sharedInd.slice(0, 3).join(', ')}`);
  }

  const myLookingFor = me.lookingFor || [];
  const theirSkills = new Set(them.skills || []);
  let complement = 0;
  for (const want of myLookingFor) {
    for (const skill of COMPLEMENTARY[want] || []) {
      if (theirSkills.has(skill)) complement += 1;
    }
  }
  if (complement > 0) {
    const points = Math.min(complement * 6, 25);
    score += points;
    reasons.push(`Skills you're looking for`);
  }

  if (me.stage && them.stage) {
    const compat = STAGE_COMPAT[me.stage]?.[them.stage] ?? 0.5;
    score += Math.round(compat * 15);
    if (compat >= 0.8) reasons.push(`Similar stage (${them.stage})`);
  }

  if (me.location && them.location && me.location.toLowerCase() === them.location.toLowerCase()) {
    score += 10;
    reasons.push('Same city');
  } else if (me.remoteOk && them.remoteOk) {
    score += 5;
    reasons.push('Both open to remote');
  }

  if (me.userType && them.userType) {
    if (
      (me.userType === 'founder' && them.userType === 'cofounder_search') ||
      (me.userType === 'cofounder_search' && them.userType === 'founder')
    ) {
      score += 15;
      reasons.push('Founder ↔ co-founder match');
    } else if (
      (me.userType === 'founder' && them.userType === 'investor') ||
      (me.userType === 'investor' && them.userType === 'founder')
    ) {
      score += 10;
      reasons.push('Founder ↔ investor');
    }
  }

  if (them.lastActiveAt) {
    const days = (Date.now() - new Date(them.lastActiveAt).getTime()) / 86400000;
    if (days < 3) {
      score += 5;
      reasons.push('Active this week');
    }
  }

  if (score > 100) score = 100;
  return { score, reasons };
}

export function rankProfiles(me, profiles) {
  return profiles
    .map((p) => ({ profile: p, ...scoreProfile(me, p) }))
    .sort((a, b) => b.score - a.score);
}

export function diversify(ranked, key = (p) => p.profile.userType) {
  // Avoid 3+ of the same userType in a row.
  const out = [...ranked];
  // Light shuffle: if the same type appears 3+ times consecutively, move next different forward.
  for (let i = 2; i < out.length; i += 1) {
    if (key(out[i]) === key(out[i - 1]) && key(out[i - 1]) === key(out[i - 2])) {
      const j = out.findIndex((x, idx) => idx > i && key(x) !== key(out[i]));
      if (j > 0) {
        const [picked] = out.splice(j, 1);
        out.splice(i, 0, picked);
      }
    }
  }
  return out;
}
