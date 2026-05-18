// Geocoding helper. Uses OpenStreetMap Nominatim by default (free, polite use).
// Caches results in memory keyed by the lowercased location string so repeat
// profiles in "Berlin" don't hit the network. Returns null on any failure so
// callers can fall back to text-based comparison.

const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const USER_AGENT = process.env.GEOCODE_USER_AGENT || 'BusinessTinder/1.0 (contact: admin@businesstinder.app)';

const cache = new Map(); // normalized location -> { lat, lng } | null

export function normalizeLocation(loc) {
  return String(loc || '').trim().toLowerCase();
}

export async function geocode(location) {
  const key = normalizeLocation(location);
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  try {
    const url = `${NOMINATIM_URL}/search?q=${encodeURIComponent(location)}&format=json&limit=1&addressdetails=0`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
    });
    if (!res.ok) {
      cache.set(key, null);
      return null;
    }
    const arr = await res.json();
    const hit = Array.isArray(arr) ? arr[0] : null;
    if (!hit?.lat || !hit?.lon) {
      cache.set(key, null);
      return null;
    }
    const result = { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon) };
    cache.set(key, result);
    return result;
  } catch {
    cache.set(key, null);
    return null;
  }
}

// Haversine distance in km. Returns null if either point is missing.
export function distanceKm(a, b) {
  if (!a || !b || typeof a.lat !== 'number' || typeof b.lat !== 'number') return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
