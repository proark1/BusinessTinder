// Email delivery. Uses Resend when RESEND_API_KEY is set; otherwise logs to
// console so dev environments still complete the flow (the existing dev-mode
// `verifyUrl` / `resetUrl` in the API responses already cover the UX).

import { escapeHtml as esc } from './helpers.js';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'BusinessTinder <noreply@businesstinder.app>';
const APP_URL = process.env.APP_URL || '';

export const HAS_EMAIL = !!RESEND_API_KEY;

export function appUrl(p) {
  if (!p) return APP_URL || '';
  if (/^https?:\/\//.test(p)) return p;
  const base = (APP_URL || '').replace(/\/$/, '');
  return base ? `${base}${p.startsWith('/') ? '' : '/'}${p}` : p;
}

export async function sendEmail({ to, subject, text, html }) {
  if (!RESEND_API_KEY) {
    console.log(`[email:dev] to=${to} subject=${subject}\n${text || ''}`);
    return { delivered: false, reason: 'no-key' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, text, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[email] send failed', res.status, body.slice(0, 200));
      return { delivered: false, reason: 'http-error', status: res.status };
    }
    return { delivered: true };
  } catch (err) {
    console.warn('[email] send error', err?.message);
    return { delivered: false, reason: 'exception' };
  }
}

export async function sendVerifyEmail(to, name, verifyUrl) {
  const url = appUrl(verifyUrl);
  return sendEmail({
    to,
    subject: 'Verify your BusinessTinder account',
    text: `Hi ${name || ''},\n\nClick to verify your email and start matching:\n${url}\n\n— BusinessTinder`,
    html: `<p>Hi ${esc(name)},</p>
      <p>Click below to verify your email and start matching with founders, operators &amp; investors.</p>
      <p><a href="${esc(url)}" style="display:inline-block;padding:12px 20px;background:#1e40af;color:#fff;text-decoration:none;border-radius:10px;">Verify my email</a></p>
      <p style="color:#666;font-size:13px;">Or copy this link: ${esc(url)}</p>`,
  });
}

export async function sendResetEmail(to, name, resetUrl) {
  const url = appUrl(resetUrl);
  return sendEmail({
    to,
    subject: 'Reset your BusinessTinder password',
    text: `Hi ${name || ''},\n\nReset your password (link expires in 1 hour):\n${url}\n\nIf you didn't request this, you can ignore this email.\n\n— BusinessTinder`,
    html: `<p>Hi ${esc(name)},</p>
      <p>Click below to set a new password. This link expires in 1 hour.</p>
      <p><a href="${esc(url)}" style="display:inline-block;padding:12px 20px;background:#1e40af;color:#fff;text-decoration:none;border-radius:10px;">Reset my password</a></p>
      <p style="color:#666;font-size:13px;">If you didn't request this, you can ignore this email.</p>`,
  });
}

export async function sendMessageDigestEmail(to, name, fromName, preview) {
  return sendEmail({
    to,
    subject: `${fromName} sent you a message on BusinessTinder`,
    text: `Hi ${name || ''},\n\n${fromName}: ${preview}\n\nOpen the app to reply.\n\n— BusinessTinder`,
    html: `<p>Hi ${esc(name)},</p>
      <p><strong>${esc(fromName)}</strong> sent you a message:</p>
      <blockquote style="margin:0;padding:10px 14px;border-left:3px solid #1e40af;color:#444;">${esc(preview)}</blockquote>
      <p>Open the app to reply.</p>`,
  });
}

export async function sendMatchEmail(to, name, otherName) {
  return sendEmail({
    to,
    subject: `You matched with ${otherName} on BusinessTinder`,
    text: `Hi ${name || ''},\n\nYou matched with ${otherName} on BusinessTinder. Open the app to start the conversation.\n\n— BusinessTinder`,
    html: `<p>Hi ${esc(name)},</p><p>✨ You matched with <strong>${esc(otherName)}</strong> on BusinessTinder.</p><p>Open the app to start the conversation.</p>`,
  });
}
