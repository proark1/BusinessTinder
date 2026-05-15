const API_BASE = location.origin;
const TOKEN_KEY = "bt_token";

const qs = (id) => document.getElementById(id);
const deck = qs("deck");
const grid = qs("grid");
const searchResults = qs("searchResults");
const statusText = qs("statusText");
const matchesList = qs("matchesList");
const savedList = qs("savedList");
const likedYouBox = qs("likedYouBox");
const template = qs("cardTemplate");

const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  user: null,
  profile: null,
  pool: [],
  index: 0,
  matches: [],
  saved: [],
  swipeHistory: [],
  activeMatch: null,
  filters: { stage: "", lookingFor: "", industry: "all" },
  view: "cards",
  config: { googleClientId: null, vapidPublicKey: null, freeDailySwipes: 30 },
  ws: null,
  installPrompt: null,
  iceBreakers: [],
};

// ---------- API helper ----------
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(body?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ---------- utilities ----------
function showAuthError(elId, msg) {
  const el = qs(elId);
  el.textContent = msg;
  el.hidden = !msg;
}
function show(viewName) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  qs(`view-${viewName}`).classList.add("active");
  const tab = document.querySelector(`.tab[data-view='${viewName}']`);
  if (tab) tab.classList.add("active");
}
function setLoggedInChrome(loggedIn) {
  qs("topbar").hidden = !loggedIn;
  qs("tabbar").hidden = !loggedIn;
}
function showToast(message) {
  const el = qs("matchToast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 1400);
}
function haptic(ms = 12) {
  if (navigator.vibrate) try { navigator.vibrate(ms); } catch {}
}
function describeUserType(t) {
  return ({ founder: "Founder", cofounder_search: "Co-founder hunt", operator: "Operator", investor: "Investor", advisor: "Advisor" })[t] || t || "";
}
function describeStage(s) {
  return ({ idea: "Idea", mvp: "MVP", live: "Live", revenue: "Revenue", scaling: "Scaling" })[s] || s || "";
}
function avatarFor(profile) {
  return (
    profile?.photoUrl ||
    profile?.avatarUrl ||
    `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(profile?.fullName || profile?.headline || "BT")}`
  );
}
function profileCompletionPercent(p) {
  if (!p) return 0;
  const checks = [
    !!p.headline, !!p.userType, (p.lookingFor || []).length > 0, !!p.bio, !!p.stage,
    (p.industries || []).length > 0, (p.skills || []).length > 0, !!p.location,
    !!p.commitment, !!p.linkedinUrl, !!p.photoUrl, !!p.calLink,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}
function preloadImage(url) {
  if (!url) return;
  const img = new Image();
  img.src = url;
}

// ---------- chip sets ----------
function readChipSet(set) {
  const max = Number(set.dataset.max || 99);
  return [...set.querySelectorAll('input[type="checkbox"]:checked')].map((cb) => cb.value).slice(0, max);
}
function enforceChipMax() {
  document.querySelectorAll(".chip-set").forEach((set) => {
    const max = Number(set.dataset.max || 99);
    set.addEventListener("change", () => {
      const checked = [...set.querySelectorAll('input[type="checkbox"]:checked')];
      if (checked.length > max) checked[checked.length - 1].checked = false;
    });
  });
}
function fillOnboardingForm(profile) {
  if (!profile) return;
  const form = qs("onboardingForm");
  for (const f of ["headline", "userType", "bio", "stage", "location", "commitment", "linkedinUrl", "calLink", "pitchDeckUrl"]) {
    if (form[f]) form[f].value = profile[f] || "";
  }
  if (form.hoursPerWeek) form.hoursPerWeek.value = profile.hoursPerWeek || "";
  if (form.remoteOk) form.remoteOk.checked = !!profile.remoteOk;
  if (form.pastCompaniesText) form.pastCompaniesText.value = (profile.pastCompanies || []).join(", ");
  document.querySelectorAll(".chip-set").forEach((set) => {
    const name = set.dataset.name;
    const values = profile[name] || [];
    set.querySelectorAll('input[type="checkbox"]').forEach((cb) => (cb.checked = values.includes(cb.value)));
  });
  if (profile.photoUrl) {
    qs("photoPreview").src = profile.photoUrl;
    qs("photoPreview").hidden = false;
  }
}

// ---------- deck rendering ----------
function renderCard(p, index, total) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.style.zIndex = `${10 + index}`;
  node.style.transform = `scale(${1 - index * 0.03}) translateY(${index * 8}px)`;
  node.querySelector(".avatar").src = avatarFor(p);
  node.querySelector("h2").textContent = p.fullName || "Anonymous";
  node.querySelector(".role").textContent = p.headline || "";
  node.querySelector(".meta").textContent = `${describeUserType(p.userType)} · ${describeStage(p.stage)} · ${p.location || ""}${p.remoteOk ? " · Remote" : ""}`;
  node.querySelector(".bio").textContent = p.bio || "";
  const tags = node.querySelector(".tags");
  (p.industries || []).slice(0, 4).forEach((t) => {
    const li = document.createElement("li");
    li.textContent = t;
    tags.appendChild(li);
  });
  (p.skills || []).slice(0, 3).forEach((t) => {
    const li = document.createElement("li");
    li.textContent = t;
    li.style.background = "#1f2c4a";
    tags.appendChild(li);
  });
  const lf = (p.lookingFor || []).map((x) => x.replace("_", " ")).join(", ");
  node.querySelector(".goal").textContent = lf ? `Looking for: ${lf}` : "";
  const reasonsEl = node.querySelector(".reasons");
  if (p.matchReasons?.length) reasonsEl.textContent = `✓ ${p.matchReasons.slice(0, 2).join(" · ")}`;
  if (typeof p.matchScore === "number") {
    const pill = node.querySelector(".score-pill");
    pill.textContent = `${p.matchScore}`;
    pill.hidden = false;
  }
  return node;
}

function renderDeck() {
  deck.innerHTML = "";
  if (!state.pool.length) {
    statusText.textContent = "No more profiles. Try changing filters or come back later.";
    return;
  }
  const remaining = state.pool.slice(state.index, state.index + 2).reverse();
  remaining.forEach((p, i) => {
    const node = renderCard(p, i, remaining.length);
    if (i === remaining.length - 1) {
      enableSwipe(node, p);
      enableLongPress(node, p);
    }
    deck.appendChild(node);
  });
  preloadImage(avatarFor(state.pool[state.index + 1]));
  preloadImage(avatarFor(state.pool[state.index + 2]));
}

function renderGrid(target, profiles) {
  target.innerHTML = "";
  if (!profiles.length) {
    target.innerHTML = "<p class='hint'>Nothing here yet.</p>";
    return;
  }
  profiles.forEach((p) => {
    const card = document.createElement("article");
    card.className = "grid-card glass";
    card.innerHTML = `
      <img src="${avatarFor(p)}" alt="" />
      <h3>${p.fullName || ""}</h3>
      <p class="role">${p.headline || ""}</p>
      <p class="meta">${describeUserType(p.userType)} · ${p.location || ""}</p>
      <p class="score">${typeof p.matchScore === "number" ? `${p.matchScore}% match` : ""}</p>
    `;
    card.addEventListener("click", () => {
      const idx = state.pool.findIndex((x) => x.userId === p.userId);
      if (idx >= 0) state.index = idx;
      else state.pool.unshift(p);
      switchView("cards");
      renderDeck();
    });
    target.appendChild(card);
  });
}

function switchView(mode) {
  state.view = mode;
  qs("viewToggle").textContent = mode === "cards" ? "Grid" : "Cards";
  qs("viewToggle").dataset.mode = mode;
  deck.hidden = mode !== "cards";
  grid.hidden = mode !== "grid";
  searchResults.hidden = true;
  if (mode === "grid") renderGrid(grid, state.pool);
}

// ---------- discover / matches / saved ----------
async function loadDiscover() {
  const params = new URLSearchParams();
  if (state.filters.stage) params.set("stage", state.filters.stage);
  if (state.filters.lookingFor) params.set("lookingFor", state.filters.lookingFor);
  if (state.filters.industry && state.filters.industry !== "all") params.set("industry", state.filters.industry);
  try {
    state.pool = await api(`/discover?${params.toString()}`);
    state.index = 0;
    if (state.view === "grid") renderGrid(grid, state.pool);
    else renderDeck();
  } catch (e) {
    statusText.textContent = e.message;
  }
}

async function loadMatches() {
  try {
    state.matches = await api("/matches");
    renderMatches();
  } catch (e) {
    matchesList.innerHTML = `<li>${e.message}</li>`;
  }
}

async function loadSaved() {
  try {
    state.saved = await api("/saved");
    renderSaved();
  } catch {}
}

async function loadLikedYou() {
  try {
    const data = await api("/likes/incoming");
    qs("likedCount").textContent = data.count;
    qs("likedBadge").hidden = data.count === 0;
    if (data.locked) {
      likedYouBox.innerHTML = `<p class="hint">${data.count} ${data.count === 1 ? "person" : "people"} liked you.</p>
        <button class="primary" id="seeLikesBtn" type="button">See who (Pro)</button>`;
      qs("seeLikesBtn")?.addEventListener("click", () => (qs("proModal").hidden = false));
    } else {
      likedYouBox.innerHTML = "";
      (data.profiles || []).forEach((p) => {
        const div = document.createElement("div");
        div.className = "liked-row";
        div.innerHTML = `<img src="${avatarFor(p)}" alt="" /><div><strong>${p.fullName}</strong><br/><small>${p.headline || ""}</small></div>`;
        likedYouBox.appendChild(div);
      });
    }
  } catch {}
}

function renderMatches() {
  matchesList.innerHTML = "";
  if (!state.matches.length) {
    matchesList.innerHTML = "<li>No matches yet. Swipe right on discover.</li>";
    return;
  }
  state.matches.forEach((m) => {
    const other = m.other;
    if (!other) return;
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${other.fullName} · ${other.profile?.headline || ""}`;
    const actions = document.createElement("div");
    actions.className = "row-actions";
    const chatBtn = document.createElement("button");
    chatBtn.className = "primary";
    chatBtn.dataset.matchId = m.id;
    chatBtn.textContent = "Chat";
    const blockBtn = document.createElement("button");
    blockBtn.dataset.blockTarget = other.id;
    blockBtn.textContent = "Block";
    const reportBtn = document.createElement("button");
    reportBtn.className = "warn";
    reportBtn.dataset.reportTarget = other.id;
    reportBtn.textContent = "Report";
    actions.append(chatBtn, blockBtn, reportBtn);
    li.append(label, actions);
    matchesList.appendChild(li);
  });
}

function renderSaved() {
  savedList.innerHTML = "";
  if (!state.saved.length) {
    savedList.innerHTML = "<li>No saved profiles yet.</li>";
    return;
  }
  state.saved.forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${p.fullName} · ${p.headline || ""}</span>`;
    const btn = document.createElement("button");
    btn.textContent = "Remove";
    btn.dataset.unsaveTarget = p.userId;
    li.appendChild(btn);
    savedList.appendChild(li);
  });
}

// ---------- swipe interactions ----------
async function onSwipe(direction, profile) {
  haptic(direction === "right" ? 18 : 8);
  state.swipeHistory.push({ userId: profile.userId, direction });
  state.index += 1;
  try {
    const res = await api("/swipes", {
      method: "POST",
      body: JSON.stringify({ toUserId: profile.userId, direction: direction === "right" ? "RIGHT" : "LEFT" }),
    });
    if (res.matched) {
      haptic(40);
      showMatchModal(profile, res);
      loadMatches();
    } else {
      statusText.textContent = direction === "right" ? `Liked ${profile.fullName}.` : `Passed on ${profile.fullName}.`;
    }
  } catch (e) {
    if (e.status === 429) {
      qs("proModal").hidden = false;
    }
    statusText.textContent = e.message;
  }
  renderDeck();
}

function showMatchModal(profile, res) {
  qs("matchModalText").textContent = `You matched with ${profile.fullName}.`;
  const list = qs("matchModalIcebreakers");
  list.innerHTML = "";
  (res.icebreakers || []).forEach((prompt) => {
    const li = document.createElement("li");
    li.textContent = prompt;
    li.addEventListener("click", () => {
      qs("chatInput").value = prompt;
      qs("matchModal").hidden = true;
      const match = (state.matches || []).find(
        (m) => m.other?.id === profile.userId || m.other?.id === profile.id,
      );
      if (match) openChat(match.id);
    });
    list.appendChild(li);
  });
  qs("matchModal").hidden = false;
  qs("matchModalChat").onclick = async () => {
    qs("matchModal").hidden = true;
    await loadMatches();
    const match = state.matches.find((m) => m.other?.id === profile.userId);
    if (match) openChat(match.id);
  };
  qs("matchModalClose").onclick = () => (qs("matchModal").hidden = true);
}

function fling(direction) {
  const card = deck.querySelector(".card:last-child");
  if (!card || !card._profile) return;
  const profile = card._profile;
  card.style.transform = direction === "right" ? "translate(520px,40px) rotate(20deg)" : "translate(-520px,40px) rotate(-20deg)";
  card.style.opacity = "0";
  setTimeout(() => onSwipe(direction, profile), 130);
}
function enableSwipe(card, profile) {
  card._profile = profile;
  let startX = 0, dx = 0, dragging = false;
  card.addEventListener("pointerdown", (e) => { dragging = true; startX = e.clientX || 0; card.setPointerCapture?.(e.pointerId); });
  card.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    dx = (e.clientX || 0) - startX;
    card.style.transform = `translateX(${dx}px) rotate(${dx * 0.06}deg)`;
    const badge = card.querySelector(".badge");
    if (dx > 35) { card.classList.add("like"); card.classList.remove("pass"); badge.textContent = "LIKE"; }
    else if (dx < -35) { card.classList.add("pass"); card.classList.remove("like"); badge.textContent = "PASS"; }
    else { card.classList.remove("like", "pass"); badge.textContent = ""; }
  });
  const up = (e) => {
    if (!dragging) return;
    dragging = false;
    try { card.releasePointerCapture?.(e?.pointerId); } catch {}
    if (dx > 120) return fling("right");
    if (dx < -120) return fling("left");
    card.style.transform = "translateX(0)";
    card.classList.remove("like", "pass");
  };
  card.addEventListener("pointerup", up);
  card.addEventListener("pointercancel", up);
}
function enableLongPress(card, profile) {
  let timer = null;
  card.addEventListener("pointerdown", () => {
    timer = setTimeout(() => {
      const menu = card.querySelector(".card-overlay-menu");
      menu.hidden = false;
      menu.querySelector(".card-menu-block").onclick = async () => {
        await api("/blocks", { method: "POST", body: JSON.stringify({ targetId: profile.userId }) });
        menu.hidden = true;
        state.pool = state.pool.filter((p) => p.userId !== profile.userId);
        renderDeck();
      };
      menu.querySelector(".card-menu-report").onclick = async () => {
        const reason = prompt("Why are you reporting?");
        await api("/reports", { method: "POST", body: JSON.stringify({ targetId: profile.userId, reason }) });
        menu.hidden = true;
        state.pool = state.pool.filter((p) => p.userId !== profile.userId);
        renderDeck();
      };
    }, 550);
  });
  ["pointerup", "pointermove", "pointercancel"].forEach((e) =>
    card.addEventListener(e, () => { if (timer) { clearTimeout(timer); timer = null; } }),
  );
}

// ---------- onboarding form ----------
async function readPhotoAsDataUrl(file) {
  if (!file) return null;
  if (file.size > 700 * 1024) throw new Error("Photo too large (max 700KB).");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

qs("photoInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const dataUrl = await readPhotoAsDataUrl(file);
    qs("photoPreview").src = dataUrl;
    qs("photoPreview").hidden = false;
    qs("photoPreview").dataset.dataUrl = dataUrl;
  } catch (err) { alert(err.message); }
});

qs("onboardingForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAuthError("onboardingError", "");
  const form = e.target;
  const payload = {
    headline: form.headline.value.trim(),
    userType: form.userType.value,
    bio: form.bio.value.trim(),
    stage: form.stage.value,
    location: form.location.value.trim(),
    remoteOk: form.remoteOk.checked,
    commitment: form.commitment.value || null,
    linkedinUrl: form.linkedinUrl.value.trim() || null,
    calLink: form.calLink.value.trim() || null,
    pitchDeckUrl: form.pitchDeckUrl.value.trim() || null,
    hoursPerWeek: form.hoursPerWeek.value ? Number(form.hoursPerWeek.value) : null,
    pastCompanies: (form.pastCompaniesText.value || "").split(",").map((s) => s.trim()).filter(Boolean),
    lookingFor: readChipSet(document.querySelector('.chip-set[data-name="lookingFor"]')),
    industries: readChipSet(document.querySelector('.chip-set[data-name="industries"]')),
    skills: readChipSet(document.querySelector('.chip-set[data-name="skills"]')),
    photoUrl: qs("photoPreview").dataset.dataUrl || qs("photoPreview").src || null,
  };
  try {
    state.profile = await api("/profiles", { method: "POST", body: JSON.stringify(payload) });
    show("swipe");
    await Promise.all([loadDiscover(), loadMatches(), loadSaved(), loadLikedYou()]);
  } catch (err) {
    showAuthError("onboardingError", err.message);
  }
});

// ---------- auth handlers ----------
qs("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAuthError("loginError", "");
  const fd = new FormData(e.target);
  try {
    const data = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: fd.get("email"), password: fd.get("password") }),
    });
    const me = await fetchMeWithToken(data.token);
    await onAuthSuccess(data.token, me.user, me.profile);
  } catch (err) {
    showAuthError("loginError", err.message);
  }
});
qs("registerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAuthError("registerError", "");
  const fd = new FormData(e.target);
  try {
    const data = await api("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: fd.get("email"),
        password: fd.get("password"),
        fullName: fd.get("fullName"),
        referredBy: fd.get("referredBy") || null,
      }),
    });
    await onAuthSuccess(data.token, data.user, null);
  } catch (err) {
    showAuthError("registerError", err.message);
  }
});
document.querySelectorAll(".auth-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const target = btn.dataset.authTab;
    qs("loginForm").hidden = target !== "login";
    qs("registerForm").hidden = target !== "register";
  });
});

async function fetchMeWithToken(token) {
  const res = await fetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error("Could not fetch /me");
  return res.json();
}

async function onAuthSuccess(token, user, profile) {
  state.token = token;
  state.user = user;
  state.profile = profile || null;
  localStorage.setItem(TOKEN_KEY, token);
  setLoggedInChrome(true);
  updateChrome();
  fillOnboardingForm(profile);
  connectWebSocket();
  if (state.profile) {
    show("swipe");
    await Promise.all([loadDiscover(), loadMatches(), loadSaved(), loadLikedYou()]);
  } else {
    show("onboarding");
  }
}

function logout() {
  state.token = null;
  state.user = null;
  state.profile = null;
  state.pool = [];
  state.matches = [];
  localStorage.removeItem(TOKEN_KEY);
  state.ws?.close();
  setLoggedInChrome(false);
  show("auth");
}

function updateChrome() {
  qs("planBadge").hidden = false;
  qs("planBadge").textContent = state.user?.planTier === "PRO" ? "PRO" : "FREE";
  qs("planBadge").classList.toggle("pro", state.user?.planTier === "PRO");
  qs("settingsPlan").textContent = state.user?.planTier || "FREE";
  qs("settingsReferral").textContent = state.user?.referralCode || "—";
  if (state.profile?.slug) {
    const link = `${API_BASE}/u/${state.profile.slug}`;
    qs("publicProfileLink").href = link;
    qs("publicProfileLink").textContent = link;
  }
}

// ---------- Google login ----------
async function setupGoogle() {
  try {
    state.config = await fetch(`${API_BASE}/auth/config`).then((r) => r.json());
  } catch {}
  if (!state.config.googleClientId) {
    qs("googleDisabledNote").hidden = false;
    return;
  }
  const init = () => {
    if (!window.google?.accounts) return setTimeout(init, 200);
    window.google.accounts.id.initialize({
      client_id: state.config.googleClientId,
      callback: async (resp) => {
        try {
          const referredBy = qs("registerForm")?.referredBy?.value || null;
          const data = await api("/auth/google", { method: "POST", body: JSON.stringify({ credential: resp.credential, referredBy }) });
          const me = await fetchMeWithToken(data.token);
          await onAuthSuccess(data.token, me.user, me.profile);
        } catch (e) {
          showAuthError("loginError", e.message);
        }
      },
    });
    window.google.accounts.id.renderButton(qs("googleBtnWrap"), {
      theme: "filled_black", size: "large", width: 320, text: "continue_with",
    });
  };
  init();
}

// ---------- chat + WS ----------
function connectWebSocket() {
  if (!state.token) return;
  try {
    state.ws?.close();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws?token=${state.token}`);
    state.ws = ws;
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "message" && state.activeMatch?.conversation?.id === msg.message.conversationId) {
          appendMessage(msg.message);
        }
        if (msg.type === "typing" && state.activeMatch?.conversation?.id === msg.conversationId) {
          qs("typingIndicator").hidden = false;
          clearTimeout(window._typingTimer);
          window._typingTimer = setTimeout(() => (qs("typingIndicator").hidden = true), 1800);
        }
      } catch {}
    };
  } catch {}
}

function appendMessage(m) {
  const box = qs("messages");
  const div = document.createElement("div");
  div.className = `msg ${m.senderId === state.user.id ? "me" : "them"}`;
  div.textContent = m.body;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

async function openChat(matchId) {
  const match = state.matches.find((m) => m.id === matchId);
  if (!match || !match.conversation) return;
  state.activeMatch = match;
  qs("chatTitle").textContent = `Chat · ${match.other?.fullName || ""}`;
  qs("bookCallBtn").hidden = !match.other?.profile?.calLink;
  qs("bookCallBtn").onclick = () => window.open(match.other.profile.calLink, "_blank");
  const box = qs("messages");
  box.innerHTML = "";
  let messages = [];
  try {
    messages = await api(`/messages/${match.conversation.id}`);
    messages.forEach(appendMessage);
  } catch {}
  try {
    const ice = await api(`/icebreakers?userId=${match.other.id}`);
    const box2 = qs("icebreakerBox");
    if (messages.length === 0 && ice.prompts?.length) {
      box2.hidden = false;
      box2.innerHTML = `<p class="hint">Icebreakers</p>` + ice.prompts.map((p) => `<button type="button">${p}</button>`).join("");
      box2.querySelectorAll("button").forEach((b) =>
        b.addEventListener("click", () => { qs("chatInput").value = b.textContent; box2.hidden = true; }),
      );
    } else {
      box2.hidden = true;
    }
  } catch {}
  show("chat");
}

qs("chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.activeMatch?.conversation) return;
  const input = qs("chatInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  try {
    if (state.ws?.readyState === 1) {
      state.ws.send(JSON.stringify({
        type: "send_message",
        conversationId: state.activeMatch.conversation.id,
        toUserId: state.activeMatch.other.id,
        body: text,
      }));
      appendMessage({ senderId: state.user.id, body: text, conversationId: state.activeMatch.conversation.id });
    } else {
      const saved = await api(`/messages/${state.activeMatch.conversation.id}`, {
        method: "POST",
        body: JSON.stringify({ body: text }),
      });
      appendMessage(saved);
    }
  } catch (e) {
    alert(e.message);
  }
});

qs("chatInput").addEventListener("input", () => {
  if (state.ws?.readyState !== 1 || !state.activeMatch?.conversation) return;
  state.ws.send(JSON.stringify({
    type: "typing",
    conversationId: state.activeMatch.conversation.id,
    toUserId: state.activeMatch.other.id,
  }));
});

qs("requestVideoBtn").addEventListener("click", async () => {
  if (!state.activeMatch?.conversation) return;
  await api(`/messages/${state.activeMatch.conversation.id}`, {
    method: "POST",
    body: JSON.stringify({ body: "🎥 Requested a video call. Pick a time?", kind: "video_request" }),
  });
  showToast("Video call request sent");
});

// ---------- swipe buttons / filters / search ----------
qs("leftBtn").addEventListener("click", () => fling("left"));
qs("rightBtn").addEventListener("click", () => fling("right"));
qs("undoBtn").addEventListener("click", () => {
  if (state.index > 0) state.index -= 1;
  state.swipeHistory.pop();
  renderDeck();
});
qs("saveBtn").addEventListener("click", async () => {
  const card = deck.querySelector(".card:last-child");
  if (!card?._profile) return;
  await api(`/saved/${card._profile.userId}`, { method: "POST" });
  showToast("Saved to shortlist");
  loadSaved();
});

["filterStage", "filterLookingFor", "industryFilter"].forEach((id) => {
  qs(id).addEventListener("change", (e) => {
    const key = id === "industryFilter" ? "industry" : id === "filterStage" ? "stage" : "lookingFor";
    state.filters[key] = e.target.value;
    loadDiscover();
  });
});
qs("viewToggle").addEventListener("click", () => switchView(state.view === "cards" ? "grid" : "cards"));

let searchTimer = null;
qs("searchInput").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) {
    searchResults.hidden = true;
    deck.hidden = state.view !== "cards";
    grid.hidden = state.view !== "grid";
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const results = await api(`/search?q=${encodeURIComponent(q)}`);
      deck.hidden = true; grid.hidden = true;
      searchResults.hidden = false;
      renderGrid(searchResults, results);
    } catch {}
  }, 250);
});

document.querySelectorAll(".tab").forEach((btn) =>
  btn.addEventListener("click", () => {
    show(btn.dataset.view);
    if (btn.dataset.view === "matches") { loadMatches(); loadSaved(); loadLikedYou(); }
  }),
);

matchesList.addEventListener("click", async (e) => {
  const matchId = e.target?.dataset?.matchId;
  const blockTarget = e.target?.dataset?.blockTarget;
  const reportTarget = e.target?.dataset?.reportTarget;
  if (matchId) openChat(matchId);
  if (blockTarget) {
    await api("/blocks", { method: "POST", body: JSON.stringify({ targetId: blockTarget }) });
    state.matches = state.matches.filter((m) => m.other?.id !== blockTarget);
    renderMatches();
  }
  if (reportTarget) {
    const reason = prompt("Why are you reporting?");
    await api("/reports", { method: "POST", body: JSON.stringify({ targetId: reportTarget, reason }) });
    state.matches = state.matches.filter((m) => m.other?.id !== reportTarget);
    renderMatches();
  }
});
savedList.addEventListener("click", async (e) => {
  const target = e.target?.dataset?.unsaveTarget;
  if (!target) return;
  await api(`/saved/${target}`, { method: "DELETE" });
  loadSaved();
});

// ---------- settings, plan, push, install ----------
qs("settingsBtn").addEventListener("click", () => show("settings"));
qs("logoutBtn").addEventListener("click", logout);
qs("planBadge").addEventListener("click", () => (qs("proModal").hidden = false));
qs("upgradeBtn").addEventListener("click", () => (qs("proModal").hidden = false));
qs("proCloseBtn").addEventListener("click", () => (qs("proModal").hidden = true));
qs("proConfirmBtn").addEventListener("click", async () => {
  await api("/plan/upgrade", { method: "POST" });
  state.user.planTier = "PRO";
  qs("proModal").hidden = true;
  updateChrome();
  loadLikedYou();
});
qs("copyReferralBtn").addEventListener("click", () => {
  navigator.clipboard.writeText(state.user?.referralCode || "");
  showToast("Copied");
});

function urlB64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) arr[i] = raw.charCodeAt(i);
  return arr;
}
qs("enablePushBtn").addEventListener("click", async () => {
  if (!state.config.vapidPublicKey) return alert("Push not configured on the server.");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return alert("Push not supported.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlB64ToUint8Array(state.config.vapidPublicKey),
  });
  const json = sub.toJSON();
  await api("/push/subscribe", { method: "POST", body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }) });
  showToast("Push enabled");
});

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  state.installPrompt = e;
  qs("installAppBtn").hidden = false;
});
qs("installAppBtn").addEventListener("click", async () => {
  if (state.installPrompt) {
    state.installPrompt.prompt();
    state.installPrompt = null;
    qs("installAppBtn").hidden = true;
  }
});

// ---------- boot ----------
async function boot() {
  enforceChipMax();
  await setupGoogle();
  if (state.token) {
    try {
      const me = await fetchMeWithToken(state.token);
      await onAuthSuccess(state.token, me.user, me.profile);
      return;
    } catch {
      logout();
    }
  }
  setLoggedInChrome(false);
  show("auth");
}
boot();
