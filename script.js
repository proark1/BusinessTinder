import { decideMatch, profileCompletionPercent } from "./src/matchEngine.js";
import { buildDiscoverPool } from "./src/discovery.js";

const seedProfiles = [
  { id: 1, name: "Avery Chen", age: 31, role: "SaaS Founder · FinOps", location: "NYC / Remote", bio: "Building AI-native spend governance for remote teams.", tags: ["B2B SaaS", "AI", "FinTech"], goal: "Needs GTM advisor + pilot customers", image: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=900&q=80", rightSwipesYou: true },
  { id: 2, name: "Noah Rivera", age: 28, role: "Growth Lead · Marketplace", location: "Austin", bio: "Scaled two-sided marketplace to 200k users.", tags: ["Growth", "Marketplace", "Analytics"], goal: "Needs product-design cofounder", image: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=900&q=80", rightSwipesYou: false },
  { id: 3, name: "Priya Shah", age: 35, role: "Angel Investor · HealthTech", location: "SF Bay Area", bio: "Operator-turned-investor backing workflow automation.", tags: ["HealthTech", "Ops", "Capital"], goal: "Needs health startup deal flow", image: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=900&q=80", rightSwipesYou: true },
  { id: 4, name: "Darren Mills", age: 32, role: "CTO · Climate SaaS", location: "London / Remote", bio: "Building tooling for carbon accounting automation.", tags: ["Climate", "SaaS", "Infra"], goal: "Needs enterprise partnerships", image: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=900&q=80", rightSwipesYou: true }
];

const state = {
  profiles: JSON.parse(localStorage.getItem("bt_profiles") || JSON.stringify(seedProfiles)),
  index: Number(localStorage.getItem("bt_index") || 0),
  matches: JSON.parse(localStorage.getItem("bt_matches") || "[]"),
  chats: JSON.parse(localStorage.getItem("bt_chats") || "{}"),
  me: JSON.parse(localStorage.getItem("bt_me") || "null"),
  activeChatId: null,
  reported: JSON.parse(localStorage.getItem("bt_reported") || "[]"),
  industry: localStorage.getItem("bt_industry") || "all",
  passed: JSON.parse(localStorage.getItem("bt_passed") || "[]"),
  swipeHistory: JSON.parse(localStorage.getItem("bt_swipe_history") || "[]")
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
  localStorage.setItem("bt_industry", state.industry);
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
      { from: "them", text: "Great to match. What are you building right now?" }
    ];
  }
}

function onDecision(direction) {
  const pool = discoverPool();
  const current = pool[state.index];
  if (!current) return;

  state.swipeHistory.push({ id: current.id, direction });

  if (decideMatch(direction, current.rightSwipesYou)) {
    if (!state.matches.find((m) => m.id === current.id)) {
      state.matches.push(current);
      ensureChat(current.id);
    }
    statusText.textContent = `It’s a match with ${current.name}!`;
    showToast("✨ New match!");
  } else if (direction === "right") {
    if (!state.passed.includes(String(current.id))) state.passed.push(String(current.id));
    statusText.textContent = `${current.name} didn't match.`;
  } else {
    if (!state.passed.includes(String(current.id))) state.passed.push(String(current.id));
    statusText.textContent = `Passed on ${current.name}.`;
  }

  state.index = 0;
  persist();
  renderDeck();
  renderMatches();
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
  const down = (e) => {
    dragging = true;
    startX = e.clientX || 0;
    if (card.setPointerCapture) card.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    if (!dragging) return;
    dx = (e.clientX || 0) - startX;
    card.style.transform = `translateX(${dx}px) rotate(${dx * 0.06}deg)`;
    const badge = card.querySelector(".badge");
    if (dx > 35) { card.classList.add("like"); card.classList.remove("pass"); badge.textContent = "LIKE"; }
    else if (dx < -35) { card.classList.add("pass"); card.classList.remove("like"); badge.textContent = "PASS"; }
    else { card.classList.remove("like", "pass"); badge.textContent = ""; }
  };
  const up = (e) => {
    if (!dragging) return;
    dragging = false;
    if (card.releasePointerCapture && e && e.pointerId != null) {
      try { card.releasePointerCapture(e.pointerId); } catch {}
    }
    if (dx > 120) return fling("right");
    if (dx < -120) return fling("left");
    card.style.transform = "translateX(0)"; card.classList.remove("like", "pass");
  };
  card.addEventListener("pointerdown", down);
  card.addEventListener("pointermove", move);
  card.addEventListener("pointerup", up);
  card.addEventListener("pointercancel", up);
}

function renderMatches() {
  matchesList.innerHTML = "";
  if (!state.matches.length) {
    matchesList.innerHTML = "<li>No matches yet. Swipe right on discover.</li>";
    return;
  }
  state.matches.forEach((m) => {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${m.name} · ${m.role}`;
    const actions = document.createElement("div");
    actions.className = "row-actions";
    const chatBtn = document.createElement("button");
    chatBtn.className = "primary";
    chatBtn.dataset.chat = String(m.id);
    chatBtn.textContent = "Chat";
    const unmatchBtn = document.createElement("button");
    unmatchBtn.dataset.unmatch = String(m.id);
    unmatchBtn.textContent = "Unmatch";
    const reportBtn = document.createElement("button");
    reportBtn.className = "warn";
    reportBtn.dataset.report = String(m.id);
    reportBtn.textContent = "Report";
    actions.append(chatBtn, unmatchBtn, reportBtn);
    li.append(label, actions);
    matchesList.appendChild(li);
  });
}

function openChat(matchId) {
  state.activeChatId = String(matchId);
  const person = state.matches.find((m) => String(m.id) === String(matchId));
  qs("chatTitle").textContent = person ? `Chat · ${person.name}` : "Chat";
  const box = qs("messages");
  box.innerHTML = "";
  (state.chats[matchId] || []).forEach((m) => {
    const div = document.createElement("div");
    div.className = `msg ${m.from}`;
    div.textContent = m.text;
    box.appendChild(div);
  });
  box.scrollTop = box.scrollHeight;
  show("chat");
}

qs("leftBtn").addEventListener("click", () => fling("left"));
qs("rightBtn").addEventListener("click", () => fling("right"));
qs("undoBtn").addEventListener("click", () => {
  const last = state.swipeHistory.pop();
  if (!last) return;
  const id = String(last.id);
  state.passed = state.passed.filter((p) => p !== id);
  state.matches = state.matches.filter((m) => String(m.id) !== id);
  delete state.chats[id];
  persist();
  renderDeck();
  renderMatches();
  statusText.textContent = "Undid last swipe.";
});

qs("onboardingForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  state.me = Object.fromEntries(fd.entries());
  persist();
  renderCompletion();
  show("swipe");
});

document.querySelectorAll(".tab").forEach((btn) => btn.addEventListener("click", () => show(btn.dataset.view)));

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
  state.chats[state.activeChatId].push({ from: "me", text });
  input.value = "";
  persist();
  openChat(state.activeChatId);
  setTimeout(() => {
    state.chats[state.activeChatId].push({ from: "them", text: "Nice — tell me more." });
    persist();
    openChat(state.activeChatId);
  }, 500);
});

renderCompletion();
const industrySelect = qs("industryFilter");
if (industrySelect) industrySelect.value = state.industry;
renderDeck();
renderMatches();
if (state.me) show("swipe");


qs("industryFilter").addEventListener("change", (e) => {
  state.industry = e.target.value;
  state.index = 0;
  persist();
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
  localStorage.removeItem("bt_industry");
  location.reload();
});
