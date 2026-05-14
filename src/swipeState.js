import { decideMatch } from './matchEngine.js';

export function applySwipe({ direction, current, matches, passed, history }) {
  const nextMatches = [...matches];
  const nextPassed = [...passed];
  const nextHistory = [...history, { id: current.id, direction }];

  if (decideMatch(direction, current.rightSwipesYou)) {
    if (!nextMatches.find((m) => String(m.id) === String(current.id))) nextMatches.push(current);
  } else {
    if (!nextPassed.includes(String(current.id))) nextPassed.push(String(current.id));
  }

  return { matches: nextMatches, passed: nextPassed, history: nextHistory };
}

export function undoLastSwipe({ matches, passed, history, chats }) {
  if (!history.length) return { matches, passed, history, chats, undone: null };
  const nextHistory = [...history];
  const last = nextHistory.pop();
  const id = String(last.id);
  const nextPassed = passed.filter((p) => p !== id);
  const nextMatches = matches.filter((m) => String(m.id) !== id);
  const nextChats = { ...chats };
  delete nextChats[id];
  return { matches: nextMatches, passed: nextPassed, history: nextHistory, chats: nextChats, undone: last };
}
