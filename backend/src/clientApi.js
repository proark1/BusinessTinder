const API = (typeof window !== 'undefined' && window.__BT_API__) || 'http://localhost:4000';

function token() {
  return localStorage.getItem('bt_token') || '';
}

async function req(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const r = await fetch(`${API}${path}`, { ...options, headers });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export const api = {
  register: (payload) => req('/auth/register', { method: 'POST', body: JSON.stringify(payload) }),
  login: (payload) => req('/auth/login', { method: 'POST', body: JSON.stringify(payload) }),
  saveProfile: (payload) => req('/profiles', { method: 'POST', body: JSON.stringify(payload) }),
  discover: () => req('/discover'),
  swipe: (payload) => req('/swipes', { method: 'POST', body: JSON.stringify(payload) }),
  matches: () => req('/matches')
};

export function connectWs(onMessage) {
  const ws = new WebSocket(`${API.replace('http', 'ws')}/ws?token=${encodeURIComponent(token())}`);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  return ws;
}
