const API_BASE = location.origin;
const TOKEN_KEY = "bt_token";

const qs = (id) => document.getElementById(id);
const deck = qs("deck"),
  statusText = qs("statusText"),
  matchesList = qs("matchesList");
const template = qs("cardTemplate"),
  completionBadge = qs("completionBadge");

const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  user: null,
  profile: null,
  pool: [],
  index: 0,
  matches: [],
  swipeHistory: [],
  activeMatch: null,
  industry: "all",
  config: { googleClientId: null },
};

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error(body?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

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

function profileCompletionPercent(p) {
  if (!p) return 0;
  const checks = [
    !!p.headline,
    !!p.userType,
    Array.isArray(p.lookingFor) && p.lookingFor.length > 0,
    !!p.bio,
    !!p.stage,
    Array.isArray(p.industries) && p.industries.length > 0,
    Array.isArray(p.skills) && p.skills.length > 0,
    !!p.location,
    !!p.commitment,
    !!p.linkedinUrl,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

function renderCompletion() {
  completionBadge.textContent = `${profileCompletionPercent(state.profile)}% profile`;
}

function showToast(message) {
  const el = qs("matchToast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 1400);
}

function describeUserType(t) {
  return ({
    founder: "Founder",
    cofounder_search: "Looking for co-founder",
    operator: "Operator",
    investor: "Investor",
    advisor: "Advisor",
  })[t] || t || "";
}

function describeStage(s) {
  return ({
    idea: "Idea stage",
    mvp: "Building MVP",
    live: "Live",
    revenue: "Revenue",
    scaling: "Scaling",
  })[s] || s || "";
}

function avatarFor(profile, user) {
  return (
    profile?.avatarUrl ||
    user?.avatarUrl ||
    `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(user?.fullName || profile?.headline || "BT")}`
  );
}

function filteredPool() {
  if (state.industry === "all") return state.pool;
  return state.pool.filter((p) => (p.industries || []).includes(state.industry));
}

function renderDeck() {
  deck.innerHTML = "";
  const pool = filteredPool();
  const remaining = pool.slice(state.index, state.index + 2).reverse();
  remaining.forEach((p, i) => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.style.zIndex = `${10 + i}`;
    node.style.transform = `scale(${1 - i * 0.03}) translateY(${i * 8}px)`;
    node.querySelector(".avatar").src = avatarFor(p, p);
    node.querySelector("h2").textContent = p.fullName || "Anonymous";
    node.querySelector(".role").textContent = p.headline || "";
    node.querySelector(".meta").textContent = `${describeUserType(p.userType)} · ${describeStage(p.stage)} · ${p.location || ""}${p.remoteOk ? " · Remote OK" : ""}`;
    node.querySelector(".bio").textContent = p.bio || "";
    const tags = node.querySelector(".tags");
    (p.industries || []).slice(0, 4).forEach((tag) => {
      const li = document.createElement("li");
      li.textContent = tag;
      tags.appendChild(li);
    });
    (p.skills || []).slice(0, 3).forEach((tag) => {
      const li = document.createElement("li");
      li.textContent = tag;
      li.style.background = "#1f2c4a";
      tags.appendChild(li);
    });
    const lookingFor = (p.lookingFor || []).map((x) => x.replace("_", " ")).join(", ");
    node.querySelector(".goal").textContent = lookingFor ? `Looking for: ${lookingFor}` : "";
    if (i === remaining.length - 1) enableSwipe(node, p);
    deck.appendChild(node);
  });
  if (!remaining.length) statusText.textContent = "No more profiles. Come back later.";
}

async function loadDiscover() {
  try {
    state.pool = await api("/discover");
    state.index = 0;
    renderDeck();
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
    actions.append(chatBtn);
    li.append(label, actions);
    matchesList.appendChild(li);
  });
}

async function onSwipe(direction, profile) {
  state.swipeHistory.push({ userId: profile.userId, direction });
  state.index += 1;
  try {
    const res = await api("/swipes", {
      method: "POST",
      body: JSON.stringify({ toUserId: profile.userId, direction: direction === "right" ? "RIGHT" : "LEFT" }),
    });
    if (res.matched) {
      statusText.textContent = `It's a match with ${profile.fullName}!`;
      showToast("✨ New match!");
      loadMatches();
    } else {
      statusText.textContent = direction === "right" ? `Liked ${profile.fullName}.` : `Passed on ${profile.fullName}.`;
    }
  } catch (e) {
    statusText.textContent = e.message;
  }
  renderDeck();
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
    card.style.transform = "translateX(0)";
    card.classList.remove("like", "pass");
  };
  card.addEventListener("pointerdown", down);
  card.addEventListener("pointermove", move);
  card.addEventListener("pointerup", up);
  card.addEventListener("pointercancel", up);
}

function fillOnboardingForm(profile) {
  const form = qs("onboardingForm");
  if (!profile) return;
  form.headline.value = profile.headline || "";
  form.userType.value = profile.userType || "";
  form.bio.value = profile.bio || "";
  form.stage.value = profile.stage || "";
  form.location.value = profile.location || "";
  form.commitment.value = profile.commitment || "";
  form.linkedinUrl.value = profile.linkedinUrl || "";
  form.remoteOk.checked = !!profile.remoteOk;
  document.querySelectorAll(".chip-set").forEach((set) => {
    const name = set.dataset.name;
    const values = profile[name] || [];
    set.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = values.includes(cb.value);
    });
  });
}

function readChipSet(set) {
  const max = Number(set.dataset.max || 99);
  const checked = [...set.querySelectorAll('input[type="checkbox"]:checked')].map((cb) => cb.value);
  return checked.slice(0, max);
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

async function onAuthSuccess(token, user, profile) {
  state.token = token;
  state.user = user;
  state.profile = profile || null;
  localStorage.setItem(TOKEN_KEY, token);
  setLoggedInChrome(true);
  renderCompletion();
  if (state.profile) {
    fillOnboardingForm(state.profile);
    show("swipe");
    await Promise.all([loadDiscover(), loadMatches()]);
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
  setLoggedInChrome(false);
  show("auth");
}

async function setupGoogle() {
  try {
    state.config = await fetch(`${API_BASE}/auth/config`).then((r) => r.json());
  } catch {
    state.config = { googleClientId: null };
  }
  if (!state.config.googleClientId) {
    qs("googleDisabledNote").hidden = false;
    return;
  }
  const init = () => {
    if (!window.google || !window.google.accounts) return setTimeout(init, 200);
    window.google.accounts.id.initialize({
      client_id: state.config.googleClientId,
      callback: async (resp) => {
        try {
          const data = await api("/auth/google", {
            method: "POST",
            body: JSON.stringify({ credential: resp.credential }),
          });
          const me = await fetchMeWithToken(data.token);
          await onAuthSuccess(data.token, me.user, me.profile);
        } catch (e) {
          showAuthError("loginError", e.message);
        }
      },
    });
    window.google.accounts.id.renderButton(qs("googleBtnWrap"), {
      theme: "filled_black",
      size: "large",
      width: 320,
      text: "continue_with",
    });
  };
  init();
}

async function fetchMeWithToken(token) {
  const res = await fetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error("Could not fetch /me");
  return res.json();
}

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
    lookingFor: readChipSet(document.querySelector('.chip-set[data-name="lookingFor"]')),
    industries: readChipSet(document.querySelector('.chip-set[data-name="industries"]')),
    skills: readChipSet(document.querySelector('.chip-set[data-name="skills"]')),
  };
  try {
    state.profile = await api("/profiles", { method: "POST", body: JSON.stringify(payload) });
    renderCompletion();
    show("swipe");
    await Promise.all([loadDiscover(), loadMatches()]);
  } catch (err) {
    showAuthError("onboardingError", err.message);
  }
});

qs("leftBtn").addEventListener("click", () => fling("left"));
qs("rightBtn").addEventListener("click", () => fling("right"));
qs("undoBtn").addEventListener("click", () => {
  if (state.index > 0) state.index -= 1;
  state.swipeHistory.pop();
  renderDeck();
});

qs("industryFilter").addEventListener("change", (e) => {
  state.industry = e.target.value;
  state.index = 0;
  renderDeck();
});

document.querySelectorAll(".tab").forEach((btn) =>
  btn.addEventListener("click", () => show(btn.dataset.view)),
);

matchesList.addEventListener("click", (e) => {
  const matchId = e.target?.dataset?.matchId;
  if (matchId) openChat(matchId);
});

async function openChat(matchId) {
  const match = state.matches.find((m) => m.id === matchId);
  if (!match || !match.conversation) return;
  state.activeMatch = match;
  qs("chatTitle").textContent = `Chat · ${match.other?.fullName || ""}`;
  const box = qs("messages");
  box.innerHTML = "";
  try {
    const messages = await api(`/messages/${match.conversation.id}`);
    messages.forEach((m) => {
      const div = document.createElement("div");
      div.className = `msg ${m.senderId === state.user.id ? "me" : "them"}`;
      div.textContent = m.body;
      box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;
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
    await api(`/messages/${state.activeMatch.conversation.id}`, {
      method: "POST",
      body: JSON.stringify({ body: text }),
    });
    openChat(state.activeMatch.id);
  } catch {}
});

qs("logoutBtn").addEventListener("click", logout);

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
