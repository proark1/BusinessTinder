export function serializeState(state) {
  return JSON.stringify(state, null, 2);
}

export function parseImportedState(raw) {
  const parsed = JSON.parse(String(raw));
  return {
    matches: parsed.matches || [],
    chats: parsed.chats || {},
    me: parsed.me || null,
    reported: parsed.reported || [],
    passed: parsed.passed || [],
    swipeHistory: parsed.swipeHistory || []
  };
}
