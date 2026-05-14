import { decideMatch, profileCompletionPercent } from "./src/matchEngine.js";
import { buildDiscoverPool } from "./src/discovery.js";
import { applySwipe, undoLastSwipe } from "./src/swipeState.js";
import { serializeState, parseImportedState } from "./src/portability.js";

const seedProfiles = [
  { id: 1, name: "Avery Chen", age: 31, role: "SaaS Founder · FinOps", location: "NYC / Remote", bio: "Building AI-native spend governance for remote teams.", tags: ["B2B SaaS", "AI", "FinTech"], goal: "Needs GTM advisor + pilot customers", image: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=900&q=80", rightSwipesYou: true },
  { id: 2, name: "Noah Rivera", age: 28, role: "Growth Lead · Marketplace", location: "Austin", bio: "Scaled two-sided marketplace to 200k users.", tags: ["Growth", "Marketplace", "Analytics"], goal: "Needs product-design cofounder", image: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=900&q=80", rightSwipesYou: false },
  { id: 3, name: "Priya Shah", age: 35, role: "Angel Investor · HealthTech", location: "SF Bay Area", bio: "Operator-turned-investor backing workflow automation.", tags: ["HealthTech", "Ops", "Capital"], goal: "Needs health startup deal flow", image: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=900&q=80", rightSwipesYou: true },
  { id: 4, name: "Darren Mills", age: 32, role: "CTO · Climate SaaS", location: "London / Remote", bio: "Building tooling for carbon accounting automation.", tags: ["Climate", "SaaS", "Infra"], goal: "Needs enterprise partnerships", image: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=900&q=80", rightSwipesYou: true }
];

const API_BASE = localStorage.getItem("bt_api_base") || "http://localhost:8787";

const state = {
  profiles: JSON.parse(localStorage.getItem("bt_profiles") || JSON.stringify(seedProfiles)),
  index: Number(localStorage.getItem("bt_index") || 0),
  matches: JSON.parse(localStorage.getItem("bt_matches") || "[]"),
  chats: JSON.parse(localStorage.getItem("bt_chats") || "{}"),
  me: JSON.parse(localStorage.getItem("bt_me") || "null"),
  activeChatId: null,
  reported: JSON.parse(localStorage.getItem("bt_reported") || "[]"),
  industry: "all",
  passed: JSON.parse(localStorage.getItem("bt_passed") || "[]"),
  swipeHistory: JSON.parse(localStorage.getItem("bt_swipe_history") || "[]"),
  meUserId: localStorage.getItem("bt_me_user_id") || null,
  apiOnline: false
};

const qs = (id) => document.getElementById(id);
const deck = qs("deck"), statusText = qs("statusText"), matchesList = qs("matchesList");
const template = qs("cardTemplate"), completionBadge = qs("completionBadge");

function persist() {
  localStorage.setItem("bt_profiles", JSON.stringify(state.profiles));
  localStorage.setItem("bt_index", String(state.index));
  localStorage.setItem("bt_matches", JSON.stringify(state.matches));
  localStorage.setItem("bt_chats", JSON.stringify(state.chats));
  localStorage.setItem("bt_me", JSON.stringify(state.me));
  localStorage.setItem("bt_reported", JSON.stringify(state.reported));
  localStorage.setItem("bt_passed", JSON.stringify(state.passed));
  localStorage.setItem("bt_swipe_history", JSON.stringify(state.swipeHistory));
  if (state.meUserId) localStorage.setItem("bt_me_user_id", state.meUserId);
}

function show(viewName) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  qs(`view-${viewName}`).classList.add("active");
  document.querySelector(`[data-view='${viewName}']`).classList.add("active");
}

function profileCompletion() {
  return profileCompletionPercent(state.me);
}

function renderCompletion() {
  completionBadge.textContent = `${profileCompletion()}% profile`;
}


function hydrateProfileForm() {
  if (!state.me) return;
  const form = qs("onboardingForm");
  Object.entries(state.me).forEach(([key, value]) => {
    const field = form.elements.namedItem(key);
    if (field) field.value = value;
  });
  qs("profileSubmitBtn").textContent = "Save Profile";
}


function exportData() {
  const blob = new Blob([serializeState(state)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "businesstinder-data.json";
  a.click();
  URL.revokeObjectURL(url);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = parseImportedState(reader.result);
      state.matches = data.matches;
      state.chats = data.chats;
      state.me = data.me;
      state.reported = data.reported;
      state.passed = data.passed;
      state.swipeHistory = data.swipeHistory;
      persist();
      hydrateProfileForm();
      renderCompletion();
      renderDeck();
      renderMatches();
      qs("profileSavedMsg").textContent = "Data imported successfully.";
    } catch {
      qs("profileSavedMsg").textContent = "Invalid import file.";
    }
  };
  reader.readAsText(file);
}


async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function initApi() {
  try {
    await api('/health');
    state.apiOnline = true;
    qs("profileSavedMsg").textContent = "Connected to API";
  } catch {
    state.apiOnline = false;
  }
}



async function syncMatchesFromApi() {
  if (!state.apiOnline || !state.meUserId) return;
  try {
    const apiMatches = await api(`/matches?userId=${state.meUserId}`);
    const ids = new Set();
    apiMatches.forEach((m) => {
      const otherId = m.userA === state.meUserId ? m.userB : m.userA;
      ids.add(String(otherId));
    });
    state.matches = state.profiles.filter((p) => ids.has(String(p.id)));
    persist();
    renderMatches();
  } catch {}
}

async function syncMessagesFromApi(matchId) {
  if (!state.apiOnline) return;
  try {
    const msgs = await api(`/messages?matchId=${matchId}`);
    state.chats[String(matchId)] = msgs.map((m) => ({ from: String(m.fromUserId) === String(state.meUserId) ? "me" : "them", text: m.text, ts: m.ts }));
    persist();
  } catch {}
}

function showToast(message) {
  const el = qs("matchToast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 1400);
}


function discoverPool() {
  return buildDiscoverPool({
    profiles: state.profiles,
    industry: state.industry,
    reported: state.reported,
    matches: state.matches,
    passed: state.passed
  });
}

function renderDeck() {
  deck.innerHTML = "";
  const pool = discoverPool();
  const remaining = pool.slice(state.index, state.index + 2).reverse();
  remaining.forEach((p, i) => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.style.zIndex = `${10 + i}`;
    node.style.transform = `scale(${1 - i * 0.03}) translateY(${i * 8}px)`;
    node.querySelector(".avatar").src = p.image;
    node.querySelector("h2").textContent = `${p.name}, ${p.age}`;
    node.querySelector(".role").textContent = p.role;
    node.querySelector(".meta").textContent = p.location;
    node.querySelector(".bio").textContent = p.bio;
    node.querySelector(".goal").textContent = p.goal;
    const tags = node.querySelector(".tags");
    p.tags.forEach((tag) => { const li = document.createElement("li"); li.textContent = tag; tags.appendChild(li); });
    if (i === remaining.length - 1) enableSwipe(node);
    deck.appendChild(node);
  });
  if (!remaining.length) statusText.textContent = "No more profiles today. Check matches or come back later.";
}

function ensureChat(matchId) {
  if (!state.chats[matchId]) {
    state.chats[matchId] = [
      { from: "them", text: "Great to match. What are you building right now?", ts: Date.now() }
    ];
  }
}

function onDecision(direction) {
  const pool = discoverPool();
  const current = pool[state.index];
  if (!current) return;

  const next = applySwipe({
    direction,
    current,
    matches: state.matches,
    passed: state.passed,
    history: state.swipeHistory
  });
  state.matches = next.matches;
  state.passed = next.passed;
  state.swipeHistory = next.history;

  if (decideMatch(direction, current.rightSwipesYou)) {
    ensureChat(current.id);
    statusText.textContent = `It’s a match with ${current.name}!`;
    showToast("✨ New match!");
  } else if (direction === "right") {
    statusText.textContent = `${current.name} didn't match.`;
  } else {
    statusText.textContent = `Passed on ${current.name}.`;
  }

  state.index = 0;
  persist();
  if (state.apiOnline && state.meUserId) {
    api("/swipes", { method: "POST", body: JSON.stringify({ fromUserId: state.meUserId, toUserId: String(current.id), direction }) })
      .then(syncMatchesFromApi)
      .catch(() => {});
  }
  renderDeck();
  renderMatches();
}


function handleKeyboardSwipe(event) {
  const activeSwipeView = qs("view-swipe").classList.contains("active");
  if (!activeSwipeView) return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    fling("left");
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    fling("right");
  }
}

function fling(direction) {
  const card = deck.querySelector(".card:last-child");
  if (!card) return;
  card.style.transform = direction === "right" ? "translate(520px,40px) rotate(20deg)" : "translate(-520px,40px) rotate(-20deg)";
  card.style.opacity = "0";
  setTimeout(() => onDecision(direction), 130);
}

function enableSwipe(card) {
  let startX = 0, dx = 0, dragging = false;
  const down = (e) => { dragging = true; startX = e.clientX || 0; };
  const move = (e) => {
    if (!dragging) return;
    dx = (e.clientX || 0) - startX;
    card.style.transform = `translateX(${dx}px) rotate(${dx * 0.06}deg)`;
    const badge = card.querySelector(".badge");
    if (dx > 35) { card.classList.add("like"); card.classList.remove("pass"); badge.textContent = "LIKE"; }
    else if (dx < -35) { card.classList.add("pass"); card.classList.remove("like"); badge.textContent = "PASS"; }
    else { card.classList.remove("like", "pass"); badge.textContent = ""; }
  };
  const up = () => {
    if (!dragging) return;
    dragging = false;
    if (dx > 120) return fling("right");
    if (dx < -120) return fling("left");
    card.style.transform = "translateX(0)"; card.classList.remove("like", "pass");
  };
  card.addEventListener("pointerdown", down);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function renderMatches() {
  matchesList.innerHTML = "";
  if (!state.matches.length) {
    matchesList.innerHTML = "<li>No matches yet. Swipe right on discover.</li>";
    return;
  }
  state.matches.forEach((m) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${m.name} · ${m.role}</span><div class='row-actions'><button class='primary' data-chat='${m.id}'>Chat</button><button data-unmatch='${m.id}'>Unmatch</button><button class='warn' data-report='${m.id}'>Report</button></div>`;
    matchesList.appendChild(li);
  });
}

async function openChat(matchId) {
  await syncMessagesFromApi(matchId);
  state.activeChatId = String(matchId);
  const person = state.matches.find((m) => String(m.id) === String(matchId));
  qs("chatTitle").textContent = person ? `Chat · ${person.name}` : "Chat";
  const box = qs("messages");
  box.innerHTML = "";
  (state.chats[matchId] || []).forEach((m) => {
    const div = document.createElement("div");
    div.className = `msg ${m.from}`;
    const time = new Date(m.ts || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    div.innerHTML = `<div>${m.text}</div><small class="msg-time">${time}</small>`;
    box.appendChild(div);
  });
  box.scrollTop = box.scrollHeight;
  show("chat");
}

qs("leftBtn").addEventListener("click", () => fling("left"));
document.addEventListener("keydown", handleKeyboardSwipe);
qs("rightBtn").addEventListener("click", () => fling("right"));
qs("undoBtn").addEventListener("click", () => {
  const next = undoLastSwipe({
    matches: state.matches,
    passed: state.passed,
    history: state.swipeHistory,
    chats: state.chats
  });
  if (!next.undone) return;
  state.matches = next.matches;
  state.passed = next.passed;
  state.swipeHistory = next.history;
  state.chats = next.chats;
  persist();
  renderDeck();
  renderMatches();
  statusText.textContent = "Undid last swipe.";
});

qs("onboardingForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  state.me = Object.fromEntries(fd.entries());
  if (state.apiOnline && !state.meUserId) {
    try {
      const user = await api("/auth/signup", { method: "POST", body: JSON.stringify({ email: `${state.me.name.replace(/\s+/g,"").toLowerCase()}@demo.local` }) });
      state.meUserId = user.id;
    } catch {}
  }
  if (state.apiOnline && state.meUserId) {
    try { await api("/profiles", { method: "POST", body: JSON.stringify({ userId: state.meUserId, ...state.me }) }); } catch {}
  }
  persist();
  renderCompletion();
  qs("profileSavedMsg").textContent = "Profile saved.";
  qs("profileSubmitBtn").textContent = "Save Profile";
  show("swipe");
});

document.querySelectorAll(".tab").forEach((btn) => btn.addEventListener("click", () => show(btn.dataset.view)));

qs("exportBtn").addEventListener("click", exportData);
qs("importBtn").addEventListener("click", () => qs("importFile").click());
qs("importFile").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) importData(file);
});

matchesList.addEventListener("click", (e) => {
  const chatId = e.target?.dataset?.chat;
  const unmatchId = e.target?.dataset?.unmatch;
  const reportId = e.target?.dataset?.report;
  if (chatId) openChat(chatId);
  if (unmatchId) {
    state.matches = state.matches.filter((m) => String(m.id) !== String(unmatchId));
    delete state.chats[String(unmatchId)];
    persist();
    renderMatches();
  }
  if (reportId) {
    if (!state.reported.includes(String(reportId))) state.reported.push(String(reportId));
    state.matches = state.matches.filter((m) => String(m.id) !== String(reportId));
    persist();
    renderMatches();
    statusText.textContent = "User reported and removed from your list.";
  }
});

qs("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!state.activeChatId) return;
  const input = qs("chatInput");
  const text = input.value.trim();
  if (!text) return;
  state.chats[state.activeChatId].push({ from: "me", text, ts: Date.now() });
  input.value = "";
  persist();
  if (state.apiOnline && state.meUserId) {
    api("/messages", { method: "POST", body: JSON.stringify({ matchId: state.activeChatId, fromUserId: state.meUserId, text }) }).catch(() => {});
  }
  openChat(state.activeChatId);
  setTimeout(() => {
    state.chats[state.activeChatId].push({ from: "them", text: "Nice — tell me more.", ts: Date.now() });
    persist();
    openChat(state.activeChatId);
  }, 500);
});

(async () => {
  await initApi();
  hydrateProfileForm();
  renderCompletion();
  renderDeck();
  renderMatches();
  if (state.me) show("swipe");
  await syncMatchesFromApi();
})();


qs("industryFilter").addEventListener("change", (e) => {
  state.industry = e.target.value;
  state.index = 0;
  renderDeck();
});

qs("resetBtn").addEventListener("click", () => {
  localStorage.removeItem("bt_profiles");
  localStorage.removeItem("bt_index");
  localStorage.removeItem("bt_matches");
  localStorage.removeItem("bt_chats");
  localStorage.removeItem("bt_me");
  localStorage.removeItem("bt_reported");
  localStorage.removeItem("bt_passed");
  localStorage.removeItem("bt_swipe_history");
  location.reload();
});
