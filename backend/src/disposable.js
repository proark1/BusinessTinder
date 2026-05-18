// Reject disposable / throwaway email domains at signup. The list is short
// and conservative — extend via DISPOSABLE_EMAIL_DOMAINS (comma-separated).

const BUILT_IN = [
  'mailinator.com', 'yopmail.com', 'tempmail.com', 'temp-mail.org', '10minutemail.com',
  'guerrillamail.com', 'getnada.com', 'sharklasers.com', 'throwaway.email', 'trashmail.com',
  'dispostable.com', 'fakemailgenerator.com', 'mintemail.com', 'maildrop.cc', 'inboxbear.com',
  'spamgourmet.com', 'mailnesia.com', 'mohmal.com', 'tempr.email', 'discard.email',
];

const extra = (process.env.DISPOSABLE_EMAIL_DOMAINS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const ALL = new Set([...BUILT_IN, ...extra]);

export function isDisposableEmail(email) {
  const at = String(email || '').lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase().trim();
  return ALL.has(domain);
}
