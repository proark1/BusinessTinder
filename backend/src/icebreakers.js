// Icebreaker prompts shown to both users after a match.
// Returns 3 contextual prompts based on the other party's profile.

const GENERIC = [
  "What are you spending most of your week on right now?",
  "What part of your work would you love help on this month?",
  "What's one belief about your space most people get wrong?",
];

const BY_LOOKING_FOR = {
  cofounder: [
    "What does your ideal co-founder look like, day-to-day?",
    "What have you already tried for the part you can't cover yourself?",
  ],
  hires: [
    "What's the first role you'd hire after funding?",
    "What's the biggest skill gap on your team right now?",
  ],
  customers: [
    "Who's your ideal first 10 design partners?",
    "What's the smallest wedge you'd be excited to test together?",
  ],
  investors: [
    "What's the round you're putting together, and the ideal partner?",
    "What traction milestone are you most excited about right now?",
  ],
  advisors: [
    "Where are you most stuck this quarter?",
    "Who has been the highest-leverage advisor for you so far, and why?",
  ],
};

export function suggestIcebreakers(theirProfile) {
  if (!theirProfile) return GENERIC.slice(0, 3);
  const want = (theirProfile.lookingFor || [])[0];
  const targeted = BY_LOOKING_FOR[want] || [];
  return [...targeted.slice(0, 2), ...GENERIC].slice(0, 3);
}
