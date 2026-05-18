// Image upload helper. Uses Cloudinary when CLOUDINARY_URL is configured
// (format: cloudinary://<api_key>:<api_secret>@<cloud_name>). When no cloud
// provider is configured, the caller is responsible for using the inline
// base64 data URL — this module returns null and the route falls back.

import crypto from 'node:crypto';

const CLOUDINARY_URL = process.env.CLOUDINARY_URL || '';

function parseCloudinary(url) {
  const m = url.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
  if (!m) return null;
  return { apiKey: m[1], apiSecret: m[2], cloudName: m[3] };
}

const cloud = CLOUDINARY_URL ? parseCloudinary(CLOUDINARY_URL) : null;
export const HAS_CLOUD_UPLOAD = !!cloud;

// Accepts a base64 data URL (data:image/...;base64,...). Returns an https URL
// or throws on failure. Cloudinary's unsigned upload API accepts data URLs.
export async function uploadDataUrl(dataUrl, folder = 'businesstinder') {
  if (!cloud) throw new Error('Cloud upload not configured');
  const timestamp = Math.floor(Date.now() / 1000);
  // Cloudinary signature: sha1(sorted params + api_secret).
  const paramsToSign = `folder=${folder}&timestamp=${timestamp}`;
  const signature = crypto.createHash('sha1').update(paramsToSign + cloud.apiSecret).digest('hex');

  const form = new FormData();
  form.append('file', dataUrl);
  form.append('api_key', cloud.apiKey);
  form.append('timestamp', String(timestamp));
  form.append('folder', folder);
  form.append('signature', signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud.cloudName}/image/upload`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Cloudinary upload failed: ${res.status} ${body.slice(0, 120)}`);
  }
  const data = await res.json();
  return data.secure_url || data.url || null;
}
