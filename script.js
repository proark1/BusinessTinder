const API_BASE = location.origin;
const TOKEN_KEY = "bt_token";
const THEME_KEY = "bt_theme"; // "auto" | "light" | "dark"

// Apply the saved theme before anything renders so we don't flash the wrong one.
(function applyInitialTheme() {
  const saved = localStorage.getItem(THEME_KEY) || "auto";
  if (saved === "light" || saved === "dark") {
    document.documentElement.setAttribute("data-theme", saved);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
})();

const qs = (id) => document.getElementById(id);
const deck = qs("deck");
const grid = qs("grid");
const searchResults = qs("searchResults");
const statusText = qs("statusText");
const matchesList = qs("matchesList");
const savedList = qs("savedList");
const likedYouBox = qs("likedYouBox");
const historyList = qs("historyList");
const template = qs("cardTemplate");
const skeletonTpl = qs("skeletonCard");

const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  user: null,
  profile: null,
  pool: [],
  index: 0,
  matches: [],
  saved: [],
  swipeHistoryRemote: [],
  swipeHistory: [],
  activeMatch: null,
  filters: { stage: "", lookingFor: "", industry: "all", maxKm: "" },
  view: "cards",
  config: { googleClientId: null, vapidPublicKey: null, freeDailySwipes: 30, freeDailyLikeReveals: 1, hasCloudUpload: false },
  isEditingProfile: false,
  chatMessagesCache: [],
  chatSearchQuery: "",
  ws: null,
  wsReconnectAttempts: 0,
  installPrompt: null,
  wizardStep: 1,
  pendingPhotos: [],
  pendingVerifyUrl: null,
  pendingResetToken: null,
  prompts: [],
  pendingPrompts: [], // [{ id, answer }, ...] used during onboarding
};

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  } catch (netErr) {
    const e = new Error(`Network error — check your connection. (${netErr.message})`);
    e.status = 0;
    throw e;
  }
  let body = null;
  try { body = await res.clone().json(); } catch {}
  if (!res.ok) {
    // If body has a server-provided error message use it, otherwise tag with
    // the HTTP status so the user sees something more useful than a bare
    // proxy "Not found".
    const baseMsg = body?.error || `Request failed (${res.status} ${res.statusText || ""})`.trim();
    const err = new Error(baseMsg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ---------- utils ----------
function showAuthError(elId, msg) { const el = qs(elId); el.textContent = msg; el.hidden = !msg; }
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
function haptic(ms = 12) { if (navigator.vibrate) try { navigator.vibrate(ms); } catch {} }

// HTML escape for any user-provided string we inject via innerHTML.
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

// ---------- focus trap ----------
const focusTrappers = new Map(); // modalEl -> handler
function trapFocus(modal) {
  const focusables = () =>
    [...modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && !el.hidden && el.offsetParent !== null);
  const prev = document.activeElement;
  const first = focusables()[0];
  first?.focus();
  const handler = (e) => {
    if (e.key === "Escape") { closeModal(modal); return; }
    if (e.key !== "Tab") return;
    const list = focusables();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    if (e.shiftKey && (i <= 0 || i === -1)) { e.preventDefault(); list[list.length - 1].focus(); }
    else if (!e.shiftKey && i === list.length - 1) { e.preventDefault(); list[0].focus(); }
  };
  modal.addEventListener("keydown", handler);
  focusTrappers.set(modal, { handler, prev });
}
function releaseFocus(modal) {
  const t = focusTrappers.get(modal);
  if (!t) return;
  modal.removeEventListener("keydown", t.handler);
  try { t.prev?.focus?.(); } catch {}
  focusTrappers.delete(modal);
}
function openModal(modal) { modal.hidden = false; trapFocus(modal); }
function closeModal(modal) { modal.hidden = true; releaseFocus(modal); }
// Auto-wire close on backdrop click + Esc
function wireModal(modal) {
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(modal); });
}
function describeUserType(t) {
  return ({ founder: "Founder", cofounder_search: "Looking for co-founder", operator: "Operator", investor: "Investor", advisor: "Advisor" })[t] || t || "";
}
function describeStage(s) {
  return ({ idea: "Idea", mvp: "MVP", live: "Live", revenue: "Revenue", scaling: "Scaling" })[s] || s || "";
}
function describeCommitment(v) {
  return ({ full_time: "Full-time", part_time: "Part-time", exploring: "Exploring" })[v] || "";
}
function founderIntentLine(p) {
  const goals = (p?.lookingFor || []).slice(0, 2).map((x) => x.replace(/_/g, " "));
  const goalLine = goals.length ? `Seeking ${goals.join(" + ")}` : "Open to opportunities";
  const stage = describeStage(p?.stage);
  const commitment = describeCommitment(p?.commitment);
  const time = Number.isFinite(Number(p?.hoursPerWeek)) ? `${Number(p.hoursPerWeek)}h/wk` : "";
  const parts = [goalLine, stage, commitment, time].filter(Boolean);
  return parts.join(" · ");
}
function avatarFor(p) {
  return (p?.photos?.[0] || p?.photoUrl || p?.avatarUrl ||
    `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(p?.fullName || p?.headline || "BT")}`);
}
function preloadImage(url) { if (!url) return; const img = new Image(); img.src = url; }
function timeAgo(d) {
  if (!d) return "";
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(d).toLocaleDateString();
}

function lastActiveTier(iso) {
  if (!iso) return null;
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 600) return { cls: "online", label: "Active now" };          // < 10 min
  if (diff < 3600) return { cls: "recent", label: `Active ${Math.floor(diff / 60)}m ago` };
  if (diff < 86400) return { cls: "recent", label: `Active ${Math.floor(diff / 3600)}h ago` };
  if (diff < 7 * 86400) return { cls: "", label: `Active ${Math.floor(diff / 86400)}d ago` };
  return null;
}

function appendLastActiveBadge(node, iso) {
  const tier = lastActiveTier(iso);
  if (!tier) return;
  const span = document.createElement("span");
  span.className = `last-active ${tier.cls}`;
  span.textContent = tier.label;
  node.appendChild(span);
}

// Profile completion (richer version that scores prompts + photos).
function profileCompletionPercent(p) {
  if (!p) return 0;
  const checks = [
    !!p.headline, !!p.userType, (p.lookingFor || []).length > 0, !!p.bio, !!p.stage,
    (p.industries || []).length > 0, (p.skills || []).length > 0, !!p.location,
    (p.photos || []).length > 0 || !!p.photoUrl,
    (p.promptIds || []).length >= 1,
    (p.promptIds || []).length >= 2,
    !!p.linkedinUrl, !!p.calLink, !!p.commitment,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

function completionTip(p) {
  if (!p) return "Build your profile to start matching.";
  if (!(p.photos || []).length && !p.photoUrl) return "Add a profile photo — biggest single boost to match rate.";
  if (!(p.promptIds || []).length) return "Add a prompt — they triple message-start rate.";
  if (!p.linkedinUrl) return "Add a LinkedIn URL for trust signal.";
  if (!p.calLink) return "Add a Cal.com link so matches can book you.";
  if ((p.promptIds || []).length < 3) return "Add one more prompt for a stronger profile.";
  return "Looking great. 👍";
}

// ---------- chip sets ----------
function readChipSet(set) {
  const max = Number(set.dataset.max || 99);
  return [...set.querySelectorAll('input[type="checkbox"]:checked')].map((cb) => cb.value).slice(0, max);
}
function enforceChipMax() {
  document.querySelectorAll(".chip-set").forEach((set) => {
    const max = Number(set.dataset.max || 99);
    let msg = set.querySelector(".chip-limit-msg");
    if (!msg) {
      msg = document.createElement("p");
      msg.className = "chip-limit-msg";
      msg.hidden = true;
      set.appendChild(msg);
    }
    const update = () => {
      const checked = [...set.querySelectorAll('input[type="checkbox"]:checked')];
      if (checked.length > max) {
        const last = checked[checked.length - 1];
        last.checked = false;
        msg.textContent = `You can pick up to ${max}. Uncheck one to add another.`;
        msg.hidden = false;
        clearTimeout(set._limitTimer);
        set._limitTimer = setTimeout(() => (msg.hidden = true), 2200);
      } else {
        msg.hidden = true;
        const left = max - checked.length;
        if (left === 0) {
          msg.textContent = `${max}/${max} selected`;
          msg.hidden = false;
        }
      }
    };
    set.addEventListener("change", update);
    update();
  });
}

// ---------- skeleton + empty ----------
function renderSkeleton(count = 1) {
  deck.innerHTML = "";
  for (let i = 0; i < count; i += 1) {
    const node = skeletonTpl.content.firstElementChild.cloneNode(true);
    deck.appendChild(node);
  }
}
function showEmpty(filtered) {
  qs("emptyDeck").hidden = false;
  qs("emptyDeck").querySelector("p").textContent = filtered
    ? "Try broadening the filters above, invite a friend with your referral code, or check back later."
    : "You're early — invite a friend with your referral code to grow the pool.";
}

// ---------- card rendering ----------
function renderCard(p, index, total) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.style.zIndex = `${10 + index}`;
  node.style.transform = `scale(${1 - index * 0.03}) translateY(${index * 8}px)`;
  node.querySelector(".avatar").src = avatarFor(p);
  node.querySelector("h2").textContent = p.fullName || "Anonymous";
  node.querySelector(".role").textContent = p.headline || "";
  const distBit = typeof p.distanceKm === "number" ? ` · ${p.distanceKm} km away` : "";
  node.querySelector(".meta").textContent = `${describeUserType(p.userType)} · ${describeStage(p.stage)} · ${p.location || ""}${p.remoteOk ? " · Remote" : ""}${distBit}`;
  node.querySelector(".bio").textContent = p.bio || "";
  const intentLine = document.createElement("p");
  intentLine.className = "intent-line";
  intentLine.textContent = founderIntentLine(p);
  node.querySelector(".card-content").insertBefore(intentLine, node.querySelector(".tags"));
  const tags = node.querySelector(".tags");
  (p.industries || []).slice(0, 4).forEach((t) => { const li = document.createElement("li"); li.textContent = t; tags.appendChild(li); });
  (p.skills || []).slice(0, 3).forEach((t) => {
    const li = document.createElement("li"); li.textContent = t;
    li.style.background = "rgba(30,64,175,0.18)"; li.style.borderColor = "rgba(30,64,175,0.4)";
    tags.appendChild(li);
  });
  const lf = (p.lookingFor || []).map((x) => x.replace("_", " ")).join(", ");
  node.querySelector(".goal").textContent = lf ? `Looking for: ${lf}` : "";
  const reasonsEl = node.querySelector(".reasons");
  if (p.matchReasons?.length) reasonsEl.textContent = `✓ ${p.matchReasons.slice(0, 2).join(" · ")}`;
  if (typeof p.matchScore === "number") {
    const pill = node.querySelector(".score-pill");
    pill.textContent = `${p.matchScore}% match`;
    pill.hidden = false;
  }
  if (p.superLikedYou) {
    node.classList.add("superlike");
    const sl = document.createElement("div");
    sl.className = "superlike-badge";
    sl.textContent = "★ SUPER-LIKED YOU";
    node.appendChild(sl);
  }
  if (p.boosted) {
    const b = document.createElement("div");
    b.className = "boost-badge";
    b.textContent = "⚡ Boosted";
    node.appendChild(b);
  }
  if (p.verified) {
    const h2 = node.querySelector("h2");
    const span = document.createElement("span");
    span.className = "verified-pill";
    span.textContent = "✓ verified";
    h2.appendChild(span);
  }
  // Mutual highlights chips (server-supplied)
  if (Array.isArray(p.mutualHighlights) && p.mutualHighlights.length) {
    const row = document.createElement("div");
    row.className = "mutual-row";
    p.mutualHighlights.forEach((h) => {
      const c = document.createElement("span");
      c.className = "mutual-chip";
      c.textContent = h.label;
      row.appendChild(c);
    });
    node.querySelector(".card-content").insertBefore(row, node.querySelector(".reasons"));
  }
  // Last-active badge
  appendLastActiveBadge(node.querySelector(".meta"), p.lastActiveAt);
  // First prompt card preview (if available)
  if (Array.isArray(p.promptIds) && p.promptIds.length) {
    const promptCard = document.createElement("div");
    promptCard.className = "prompt-card";
    const q = document.createElement("div");
    q.className = "prompt-q";
    q.textContent = promptLabel(p.promptIds[0]);
    const a = document.createElement("div");
    a.className = "prompt-a";
    a.textContent = p.promptAnswers?.[0] || "";
    promptCard.append(q, a);
    node.querySelector(".card-content").insertBefore(promptCard, node.querySelector(".goal"));
  }
  return node;
}

function renderDeck() {
  deck.innerHTML = "";
  qs("emptyDeck").hidden = true;
  const remaining = state.pool.slice(state.index, state.index + 2).reverse();
  if (!remaining.length) {
    const hasFilters = state.filters.stage || state.filters.lookingFor || state.filters.industry !== "all";
    showEmpty(hasFilters);
    return;
  }
  remaining.forEach((p, i) => {
    const node = renderCard(p, i, remaining.length);
    if (i === remaining.length - 1) {
      enableSwipe(node, p);
      enableLongPress(node, p);
      node.addEventListener("dblclick", () => openDetail(p));
    }
    deck.appendChild(node);
  });
  preloadImage(avatarFor(state.pool[state.index + 1]));
  preloadImage(avatarFor(state.pool[state.index + 2]));
}

function renderGrid(target, profiles) {
  target.innerHTML = "";
  if (!profiles.length) { target.innerHTML = "<p class='hint'>Nothing here yet.</p>"; return; }
  profiles.forEach((p) => {
    const card = document.createElement("article");
    card.className = "grid-card glass";
    card.innerHTML = `
      <img alt="" />
      <h3></h3>
      <p class="role"></p>
      <p class="meta"></p>
      <p class="score"></p>`;
    card.querySelector("img").src = avatarFor(p);
    card.querySelector("h3").textContent = p.fullName || "";
    card.querySelector(".role").textContent = p.headline || "";
    const km = typeof p.distanceKm === "number" ? ` · ${p.distanceKm} km` : "";
    card.querySelector(".meta").textContent = `${describeUserType(p.userType)} · ${p.location || ""}${km}`;
    card.querySelector(".score").textContent =
      typeof p.matchScore === "number" ? `${p.matchScore}% match` : "";
    card.addEventListener("click", () => openDetail(p));
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

// ---------- detail modal ----------
function openDetail(p) {
  const photos = p.photos?.length ? p.photos : [avatarFor(p)];
  // photos already validated as data:image/(png|jpeg|webp);base64 or https; still escape URL chars defensively.
  qs("detailGallery").innerHTML = photos.map((src) => `<img src="${esc(src)}" alt="" />`).join("");
  const tagList = (arr) => (arr || []).map((x) => `<li>${esc(String(x).replace("_", " "))}</li>`).join("");
  const safeLink = (url) => {
    const s = String(url || "");
    return /^https?:\/\//i.test(s) ? esc(s) : "#";
  };
  const promptHtml = (p.promptIds || [])
    .map((id, i) => p.promptAnswers?.[i]
      ? `<div class="prompt-card"><div class="prompt-q">${esc(promptLabel(id))}</div><div class="prompt-a">${esc(p.promptAnswers[i])}</div></div>`
      : ""
    ).join("");
  const mutualHtml = (p.mutualHighlights || []).length
    ? `<div class="mutual-row">${p.mutualHighlights.map((h) => `<span class="mutual-chip">${esc(h.label)}</span>`).join("")}</div>`
    : "";
  const whyMatchHtml = (p.matchReasons || []).length
    ? `<section class="why-match"><h3>Why this match</h3><ul>${p.matchReasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></section>`
    : "";
  const lastTier = lastActiveTier(p.lastActiveAt);
  const lastHtml = lastTier ? `<span class="last-active ${lastTier.cls}">${esc(lastTier.label)}</span>` : "";
  qs("detailBody").innerHTML = `
    <h2>${esc(p.fullName || "")}${p.verified ? ` <span class="verified-pill">✓ verified</span>` : ""}</h2>
    <p class="role">${esc(p.headline || "")}</p>
    <p class="meta">${esc(describeUserType(p.userType))} · ${esc(describeStage(p.stage))} · ${esc(p.location || "")}${p.remoteOk ? " · Remote OK" : ""} ${lastHtml}</p>
    ${mutualHtml}
    <p class="intent-line">${esc(founderIntentLine(p))}</p>
    ${typeof p.matchScore === "number" ? `<p class="reasons-row">${p.matchScore}% match${p.matchReasons?.length ? " · " + esc(p.matchReasons.join(" · ")) : ""}</p>` : ""}
    <p>${esc(p.bio || "")}</p>
    ${whyMatchHtml}
    ${promptHtml}
    ${p.lookingFor?.length ? `<div class="section"><h3>Looking for</h3><ul class="tags">${tagList(p.lookingFor)}</ul></div>` : ""}
    ${p.industries?.length ? `<div class="section"><h3>Industries</h3><ul class="tags">${tagList(p.industries)}</ul></div>` : ""}
    ${p.skills?.length ? `<div class="section"><h3>What they bring</h3><ul class="tags">${tagList(p.skills)}</ul></div>` : ""}
    ${p.pastCompanies?.length ? `<div class="section"><h3>Past companies</h3><p>${esc(p.pastCompanies.join(" · "))}</p></div>` : ""}
    ${p.commitment ? `<div class="section"><h3>Commitment</h3><p>${esc(p.commitment.replace("_", " "))}${p.hoursPerWeek ? ` · ${Number(p.hoursPerWeek)}h/wk` : ""}</p></div>` : ""}
    ${p.linkedinUrl ? `<div class="section"><h3>LinkedIn</h3><p><a href="${safeLink(p.linkedinUrl)}" target="_blank" rel="noopener">${esc(p.linkedinUrl)}</a></p></div>` : ""}
    ${p.pitchDeckUrl ? `<div class="section"><h3>Pitch deck</h3><p><a href="${safeLink(p.pitchDeckUrl)}" target="_blank" rel="noopener">View deck</a></p></div>` : ""}
    ${p.calLink ? `<div class="section"><h3>Schedule a call</h3><p><a href="${safeLink(p.calLink)}" target="_blank" rel="noopener">${esc(p.calLink)}</a></p></div>` : ""}
    <div class="detail-actions">
      <button class="pass-btn" id="detailPassBtn" type="button">Pass</button>
      <button class="ghost" id="detailSuperBtn" type="button" style="flex:0 0 auto;">★ Super-like</button>
      <button class="like-btn" id="detailLikeBtn" type="button">Like</button>
    </div>`;
  openModal(qs("detailModal"));
  qs("detailPassBtn").onclick = () => { closeModal(qs("detailModal")); onSwipe("left", p); };
  qs("detailLikeBtn").onclick = () => { closeModal(qs("detailModal")); onSwipe("right", p); };
  qs("detailSuperBtn").onclick = () => { closeModal(qs("detailModal")); onSwipe("super", p); };
  // Fire-and-forget view log.
  if (p.userId) api(`/profile-views/${p.userId}`, { method: "POST" }).catch(() => {});
}
qs("detailCloseBtn").addEventListener("click", () => closeModal(qs("detailModal")));

// ---------- discover / matches / saved ----------
async function loadDiscover() {
  renderSkeleton(2);
  const params = new URLSearchParams();
  if (state.filters.stage) params.set("stage", state.filters.stage);
  if (state.filters.lookingFor) params.set("lookingFor", state.filters.lookingFor);
  if (state.filters.industry && state.filters.industry !== "all") params.set("industry", state.filters.industry);
  if (state.filters.maxKm) params.set("maxKm", state.filters.maxKm);
  try {
    state.pool = await api(`/discover?${params.toString()}`);
    state.index = 0;
    if (state.view === "grid") renderGrid(grid, state.pool);
    else renderDeck();
  } catch (e) {
    statusText.textContent = e.message;
  }
}

async function loadSwipeHistory() {
  try {
    state.swipeHistoryRemote = await api("/swipes/history");
    renderSwipeHistory();
  } catch {}
}

function renderSwipeHistory() {
  qs("historyCount").textContent = state.swipeHistoryRemote.length ? ` · ${state.swipeHistoryRemote.length}` : "";
  historyList.innerHTML = "";
  if (!state.swipeHistoryRemote.length) {
    historyList.innerHTML = `<li class="empty"><div class="empty-icon">🕘</div><p>Your recent swipes will show here.</p></li>`;
    return;
  }
  state.swipeHistoryRemote.forEach((h) => {
    const li = document.createElement("li");
    li.className = "match-row";
    const label = h.direction === "RIGHT" ? "Liked" : h.direction === "SUPER_LIKE" ? "Super-liked" : "Passed";
    const when = h.createdAt ? new Date(h.createdAt).toLocaleString() : "recently";
    li.innerHTML = `
      <img alt="" />
      <div class="match-meta">
        <div class="match-name"></div>
        <div class="match-preview"></div>
      </div>
      <div class="match-side"><span class="history-pill ${h.direction}">${label}</span><small>${when}</small></div>`;
    li.querySelector("img").src = h.avatarUrl || avatarFor(h);
    li.querySelector(".match-name").textContent = h.fullName || "Unknown";
    li.querySelector(".match-preview").textContent = h.headline || "";
    historyList.appendChild(li);
  });
}

async function loadMatches() {
  try {
    state.matches = await api("/matches");
    renderMatches();
    updateUnreadDot();
  } catch (e) {
    matchesList.innerHTML = `<li class="hint">${e.message}</li>`;
  }
}

let _matchesRefetchTimer = null;
// Coalesce rapid refetch triggers (incoming WS messages, read receipts) into a
// single /matches call so a busy thread doesn't refetch the whole inbox on
// every message.
function scheduleLoadMatches() {
  clearTimeout(_matchesRefetchTimer);
  _matchesRefetchTimer = setTimeout(loadMatches, 150);
}

async function loadSaved() {
  try { state.saved = await api("/saved"); renderSaved(); } catch {}
}

async function loadViewedYou() {
  try {
    const data = await api("/profile-views/incoming");
    qs("viewsCount").textContent = data.count ? ` · ${data.count}` : "";
    const box = qs("viewsBox");
    if (!box) return;
    box.innerHTML = "";
    if (data.locked) {
      box.innerHTML = `<div class="liked-locked">
        <div class="big">${data.count}</div>
        <p>${data.count === 1 ? "person" : "people"} viewed your profile</p>
        <button class="primary" id="seeViewsBtn" type="button">Upgrade to Pro to see who</button>
      </div>`;
      qs("seeViewsBtn")?.addEventListener("click", () => openModal(qs("proModal")));
      return;
    }
    if (!data.profiles?.length) {
      box.innerHTML = `<div class="empty"><div class="empty-icon">👀</div><p>No one viewed you in the last 30 days yet.</p></div>`;
      return;
    }
    data.profiles.forEach((p) => {
      const div = document.createElement("div");
      div.className = "liked-row";
      div.innerHTML = `<img alt="" /><div><strong></strong><br/><small style="color:var(--text-2)"></small></div>`;
      div.querySelector("img").src = avatarFor(p);
      div.querySelector("strong").textContent = p.fullName || "";
      div.querySelector("small").textContent = p.headline || "";
      div.addEventListener("click", () => openDetail(p));
      box.appendChild(div);
    });
  } catch {}
}

function renderLikerRow(p, container) {
  const div = document.createElement("div");
  div.className = "liked-row";
  div.innerHTML = `<img alt="" /><div><strong></strong><br/><small style="color:var(--text-2)"></small></div>`;
  div.querySelector("img").src = avatarFor(p);
  div.querySelector("strong").textContent = p.fullName || "";
  div.querySelector("small").textContent = p.headline || "";
  div.addEventListener("click", () => openDetail(p));
  container.appendChild(div);
}

async function loadLikedYou() {
  try {
    const data = await api("/likes/incoming");
    qs("likedCount").textContent = data.count;
    qs("likedBadge").hidden = data.count === 0;
    qs("likedYouCount").textContent = data.count ? ` · ${data.count}` : "";
    likedYouBox.innerHTML = "";

    if (!data.count) {
      likedYouBox.innerHTML = `<div class="empty"><div class="empty-icon">💌</div><p>No one has liked you yet. Make sure your profile photo and headline are strong.</p></div>`;
      return;
    }

    if (data.locked) {
      // Render revealed (full) cards + silhouettes for the rest.
      (data.revealedProfiles || []).forEach((p) => renderLikerRow(p, likedYouBox));
      const stillMasked = (data.silhouettes || []).filter((s) => !s.revealed);
      if (stillMasked.length) {
        const grid = document.createElement("div");
        grid.className = "silhouette-grid";
        stillMasked.forEach(() => {
          const cell = document.createElement("div");
          cell.className = "silhouette";
          cell.textContent = "?";
          grid.appendChild(cell);
        });
        likedYouBox.appendChild(grid);
      }
      const callout = document.createElement("div");
      callout.className = "liked-locked";
      const remaining = (data.dailyRevealLimit || 0) - (data.revealsToday || 0);
      callout.innerHTML = `
        <div class="big">${data.count}</div>
        <p>${data.count === 1 ? "person" : "people"} liked your profile</p>
        <div class="reveal-actions">
          <button class="ghost" id="revealOneBtn" type="button" ${data.canReveal ? "" : "disabled"}>
            ${data.canReveal ? `Reveal one (${remaining} left today)` : "No free reveals left today"}
          </button>
          <button class="primary" id="seeLikesBtn" type="button">See everyone with Pro</button>
        </div>`;
      likedYouBox.appendChild(callout);
      qs("seeLikesBtn")?.addEventListener("click", () => openModal(qs("proModal")));
      qs("revealOneBtn")?.addEventListener("click", async () => {
        try {
          const r = await api("/likes/reveal", { method: "POST" });
          if (r.profile) showToast(`${r.profile.fullName} liked you`);
          await loadLikedYou();
        } catch (e) {
          if (e.status === 429) openModal(qs("proModal"));
          else showToast(e.message);
        }
      });
      return;
    }

    (data.profiles || []).forEach((p) => renderLikerRow(p, likedYouBox));
  } catch {}
}

function renderMatches() {
  qs("matchesCount").textContent = state.matches.length ? ` · ${state.matches.length}` : "";
  matchesList.innerHTML = "";
  if (!state.matches.length) {
    matchesList.innerHTML = `<li class="empty"><div class="empty-icon">💼</div><p>No matches yet. Go swipe right on someone great.</p></li>`;
    return;
  }
  state.matches.forEach((m) => {
    const other = m.other; if (!other) return;
    const li = document.createElement("li");
    li.className = "match-row";
    li.dataset.matchId = m.id;
    li.innerHTML = `
      <img alt="" />
      <div class="match-meta">
        <div class="match-name"></div>
        <div class="match-preview"></div>
      </div>
      <div class="match-side"></div>`;
    li.querySelector("img").src = avatarFor({
      photos: other.profile?.photos, photoUrl: other.profile?.photoUrl,
      avatarUrl: other.avatarUrl, fullName: other.fullName,
    });
    li.querySelector(".match-name").textContent = other.fullName || "";
    appendLastActiveBadge(li.querySelector(".match-name"), other.profile?.lastActiveAt);
    const preview = m.lastMessage?.body
      ? (m.lastMessage.senderId === state.user.id ? "You: " : "") + m.lastMessage.body
      : (other.profile?.headline || "Say hi 👋");
    li.querySelector(".match-preview").textContent = preview;
    const side = li.querySelector(".match-side");
    if (m.unreadCount > 0) {
      const pill = document.createElement("span");
      pill.className = "unread-pill";
      pill.textContent = String(m.unreadCount);
      side.appendChild(pill);
    }
    if (m.lastMessage) {
      const ts = document.createElement("span");
      ts.className = "match-ts";
      ts.textContent = timeAgo(m.lastMessage.createdAt);
      side.appendChild(ts);
    }
    li.addEventListener("click", () => openChat(m.id));
    matchesList.appendChild(li);
  });
}

function renderSaved() {
  qs("savedCount").textContent = state.saved.length ? ` · ${state.saved.length}` : "";
  savedList.innerHTML = "";
  if (!state.saved.length) {
    savedList.innerHTML = `<li class="empty"><div class="empty-icon">★</div><p>Tap the star on a card to shortlist someone for later.</p></li>`;
    return;
  }
  state.saved.forEach((p) => {
    const li = document.createElement("li");
    li.className = "match-row";
    li.innerHTML = `
      <img alt="" />
      <div class="match-meta">
        <div class="match-name"></div>
        <div class="match-preview"></div>
      </div>
      <div class="match-side"><button class="ghost">Remove</button></div>`;
    li.querySelector("img").src = avatarFor(p);
    li.querySelector(".match-name").textContent = p.fullName || "";
    li.querySelector(".match-preview").textContent = p.headline || "";
    const removeBtn = li.querySelector("button");
    removeBtn.dataset.unsaveTarget = p.userId;
    li.addEventListener("click", (ev) => {
      if (ev.target?.dataset?.unsaveTarget) return;
      openDetail(p);
    });
    savedList.appendChild(li);
  });
}

function updateUnreadDot() {
  const hasUnread = state.matches.some((m) => m.unreadCount > 0);
  document.querySelector('.tab[data-view="matches"]')?.classList.toggle("has-unread", hasUnread);
}

// ---------- swipe ----------
function dirToServer(d) {
  if (d === "right") return "RIGHT";
  if (d === "super") return "SUPER_LIKE";
  return "LEFT";
}
async function onSwipe(direction, profile) {
  haptic(direction === "right" ? 18 : direction === "super" ? 28 : 8);
  const inPool = state.pool.some((p) => p.userId === profile.userId);
  state.swipeHistory.push({ userId: profile.userId, direction });
  if (inPool) state.index += 1;
  try {
    const res = await api("/swipes", {
      method: "POST",
      body: JSON.stringify({ toUserId: profile.userId, direction: dirToServer(direction) }),
    });
    if (res.matched) {
      haptic(40);
      showMatchModal(profile, res);
      loadMatches();
    } else {
      const verb = direction === "right" ? "Liked" : direction === "super" ? "Super-liked" : "Passed on";
      statusText.textContent = `${verb} ${profile.fullName}.`;
    }
  } catch (e) {
    if (e.status === 429) {
      openModal(qs("proModal"));
      statusText.textContent = "You've used your free swipes for today. Pro is unlimited.";
    } else {
      statusText.textContent = e.message;
    }
  }
  if (inPool) renderDeck();
}

function showMatchModal(profile, res) {
  qs("matchModalText").textContent = `You and ${profile.fullName} both swiped right.`;
  const list = qs("matchModalIcebreakers");
  list.innerHTML = "";
  (res.icebreakers || []).forEach((prompt) => {
    const li = document.createElement("li");
    li.textContent = prompt;
    li.addEventListener("click", async () => {
      closeModal(qs("matchModal"));
      await loadMatches();
      const match = state.matches.find((m) => m.other?.id === profile.userId);
      if (match) {
        openChat(match.id)
          .then(() => { qs("chatInput").value = prompt; qs("chatInput").focus(); })
          .catch(() => {});
      }
    });
    list.appendChild(li);
  });
  openModal(qs("matchModal"));
  qs("matchModalChat").onclick = async () => {
    closeModal(qs("matchModal"));
    await loadMatches();
    const match = state.matches.find((m) => m.other?.id === profile.userId);
    if (match) openChat(match.id);
  };
  qs("matchModalClose").onclick = () => (closeModal(qs("matchModal")));
}

function fling(direction) {
  const card = deck.querySelector(".card:last-child");
  if (!card || !card._profile) return;
  const profile = card._profile;
  card.style.transform =
    direction === "right" ? "translate(520px,40px) rotate(20deg)" :
    direction === "super" ? "translate(0,-560px) scale(0.9)" :
    "translate(-520px,40px) rotate(-20deg)";
  card.style.opacity = "0";
  setTimeout(() => onSwipe(direction, profile), 130);
}
function enableSwipe(card, profile) {
  card._profile = profile;
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;
  card.addEventListener("pointerdown", (e) => {
    dragging = true;
    startX = e.clientX || 0;
    startY = e.clientY || 0;
    card.setPointerCapture?.(e.pointerId);
  });
  card.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    dx = (e.clientX || 0) - startX;
    dy = (e.clientY || 0) - startY;
    const badge = card.querySelector(".badge");
    if (dy < -40 && Math.abs(dy) > Math.abs(dx)) {
      // Upward swipe → super-like cue
      card.style.transform = `translateY(${dy}px) scale(${Math.max(0.85, 1 + dy / 1200)})`;
      card.classList.remove("like", "pass");
      card.classList.add("superlike");
      badge.textContent = "SUPER";
      return;
    }
    card.classList.remove("superlike");
    card.style.transform = `translateX(${dx}px) rotate(${dx * 0.06}deg)`;
    if (dx > 35) { card.classList.add("like"); card.classList.remove("pass"); badge.textContent = "LIKE"; }
    else if (dx < -35) { card.classList.add("pass"); card.classList.remove("like"); badge.textContent = "PASS"; }
    else { card.classList.remove("like", "pass"); badge.textContent = ""; }
  });
  const up = (e) => {
    if (!dragging) return; dragging = false;
    try { card.releasePointerCapture?.(e?.pointerId); } catch {}
    if (dy < -120 && Math.abs(dy) > Math.abs(dx)) return fling("super");
    if (dx > 120) return fling("right");
    if (dx < -120) return fling("left");
    card.style.transform = "translateX(0)"; card.classList.remove("like", "pass", "superlike");
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

// ---------- onboarding wizard ----------
const STEP_COUNT = 4;
function showWizardStep(n) {
  state.wizardStep = n;
  document.querySelectorAll(".wizard-step").forEach((el) => el.classList.remove("active"));
  document.querySelector(`.wizard-step[data-step="${n}"]`).classList.add("active");
  document.querySelectorAll(".wizard-progress > span").forEach((el, i) => {
    el.classList.toggle("active", i + 1 === n);
    el.classList.toggle("done", i + 1 < n);
  });
  qs("wizardBack").hidden = n === 1;
  qs("wizardNext").hidden = n === STEP_COUNT;
  qs("wizardSubmit").hidden = n !== STEP_COUNT;
  qs("wizardSubmit").textContent = state.isEditingProfile ? "Save changes" : "Publish profile";
  qs("editModeBanner").hidden = !state.isEditingProfile;
  if (n === STEP_COUNT) renderPreviewCard();
}

function enterProfileEditor() {
  state.isEditingProfile = !!state.profile;
  fillOnboardingForm(state.profile);
  showWizardStep(1);
  show("onboarding");
}
function validateStep(n) {
  const form = qs("onboardingForm");
  if (n === 1) {
    if (!form.headline.value.trim()) return "Add a headline.";
    if (!form.userType.value) return "Choose what you are.";
    if (!form.location.value.trim()) return "Add a location.";
  }
  if (n === 2) {
    if (!form.bio.value.trim()) return "Add a one-liner about what you're building.";
    if (!form.stage.value) return "Pick a stage.";
    if (readChipSet(document.querySelector('.chip-set[data-name="industries"]')).length === 0) return "Pick at least one industry.";
  }
  if (n === 3) {
    if (readChipSet(document.querySelector('.chip-set[data-name="lookingFor"]')).length === 0) return "Pick at least one goal.";
  }
  return null;
}
function gatherProfilePayload() {
  const form = qs("onboardingForm");
  return {
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
    photos: state.pendingPhotos.length ? state.pendingPhotos : (state.profile?.photos || []),
    prompts: state.pendingPrompts.filter((p) => p.id && p.answer?.trim()),
  };
}
function renderPreviewCard() {
  const p = gatherProfilePayload();
  p.fullName = state.user?.fullName || "";
  const photo = p.photos?.[0] || avatarFor(p);
  const card = qs("previewCard");
  card.innerHTML = `
    <img alt="" />
    <h3></h3>
    <p class="role"></p>
    <p class="meta"></p>
    <p class="bio"></p>
    <ul class="tags"></ul>
    <p class="meta lf" style="margin-top:10px;"></p>`;
  card.querySelector("img").src = photo;
  card.querySelector("h3").textContent = p.fullName;
  card.querySelector(".role").textContent = p.headline || "";
  card.querySelector(".meta").textContent =
    `${describeUserType(p.userType)} · ${describeStage(p.stage)} · ${p.location || ""}${p.remoteOk ? " · Remote" : ""}`;
  card.querySelector(".bio").textContent = p.bio || "";
  const tags = card.querySelector(".tags");
  (p.industries || []).slice(0, 4).forEach((t) => {
    const li = document.createElement("li");
    li.textContent = t;
    tags.appendChild(li);
  });
  card.querySelector(".lf").textContent = p.lookingFor?.length
    ? `Looking for: ${p.lookingFor.join(", ")}`
    : "";
}

qs("wizardNext").addEventListener("click", () => {
  const err = validateStep(state.wizardStep);
  if (err) { showAuthError("onboardingError", err); return; }
  showAuthError("onboardingError", "");
  showWizardStep(state.wizardStep + 1);
});
qs("wizardBack").addEventListener("click", () => {
  showAuthError("onboardingError", "");
  showWizardStep(Math.max(1, state.wizardStep - 1));
});

// Photo gallery (up to 5 data URLs)
function renderPhotoGallery() {
  const g = qs("photoGallery");
  g.innerHTML = "";
  state.pendingPhotos.forEach((src, i) => {
    const wrap = document.createElement("div");
    wrap.style.position = "relative";
    wrap.innerHTML = `<img src="${src}" alt="" /><button type="button" style="position:absolute;top:-4px;right:-4px;width:20px;height:20px;border-radius:50%;background:#000;color:#fff;border:0;">✕</button>`;
    wrap.querySelector("button").onclick = () => { state.pendingPhotos.splice(i, 1); renderPhotoGallery(); };
    g.appendChild(wrap);
  });
  if (state.pendingPhotos.length < 5) {
    const add = document.createElement("label");
    add.className = "photo-add";
    add.innerHTML = "＋<input type='file' accept='image/png,image/jpeg,image/webp' style='display:none;' />";
    add.querySelector("input").addEventListener("change", async (e) => {
      const file = e.target.files?.[0]; if (!file) return;
      if (file.size > 3 * 1024 * 1024) return alert("Photo too large (max 3MB).");
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
      add.classList.add("uploading");
      try {
        const up = await api("/upload", { method: "POST", body: JSON.stringify({ dataUrl, folder: "profile" }) });
        state.pendingPhotos.push(up.url || dataUrl);
      } catch (err) {
        // Fall back to inline so users aren't blocked if the upload service is down.
        console.warn("upload failed, using inline", err?.message);
        state.pendingPhotos.push(dataUrl);
      } finally {
        renderPhotoGallery();
      }
    });
    g.appendChild(add);
  }
}
// hide the old single-file input; new gallery handles it
qs("photoInput").style.display = "none";

function fillOnboardingForm(profile) {
  if (!profile) { state.pendingPhotos = []; renderPhotoGallery(); return; }
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
  state.pendingPhotos = profile.photos?.length ? [...profile.photos] : (profile.photoUrl ? [profile.photoUrl] : []);
  renderPhotoGallery();
  state.pendingPrompts = (profile.promptIds || []).map((id, i) => ({ id, answer: profile.promptAnswers?.[i] || "" }));
  renderPromptsEditor();
}

qs("onboardingForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAuthError("onboardingError", "");
  try {
    const payload = gatherProfilePayload();
    const wasEditing = state.isEditingProfile;
    state.profile = await api("/profiles", { method: "POST", body: JSON.stringify(payload) });
    state.isEditingProfile = false;
    updateChrome();
    show(wasEditing ? "settings" : "swipe");
    if (wasEditing) { loadSettingsData(); showToast("Profile saved"); }
    await Promise.all([loadDiscover(), loadMatches(), loadSaved(), loadLikedYou(), loadViewedYou(), loadSwipeHistory()]);
  } catch (err) {
    showAuthError("onboardingError", err.message);
  }
});

qs("editCancelBtn").addEventListener("click", () => {
  state.isEditingProfile = false;
  fillOnboardingForm(state.profile);
  show(state.profile ? "settings" : "auth");
  if (state.profile) loadSettingsData();
});

// ---------- auth ----------
qs("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAuthError("loginError", "");
  const fd = new FormData(e.target);
  try {
    const data = await api("/auth/login", { method: "POST", body: JSON.stringify({ email: fd.get("email"), password: fd.get("password") }) });
    const me = await fetchMeWithToken(data.token);
    await onAuthSuccess(data.token, me.user, me.profile);
  } catch (err) { showAuthError("loginError", err.message); }
});
qs("registerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAuthError("registerError", "");
  const fd = new FormData(e.target);
  try {
    const data = await api("/auth/register", { method: "POST", body: JSON.stringify({
      email: fd.get("email"), password: fd.get("password"), fullName: fd.get("fullName"), referredBy: fd.get("referredBy") || null,
    }) });
    state.pendingVerifyUrl = data.verifyUrl || null;
    await onAuthSuccess(data.token, data.user, null);
  } catch (err) { showAuthError("registerError", err.message); }
});
function clearAuthFeedback() {
  ["loginError", "registerError", "forgotError", "forgotHint", "resetError"].forEach((id) => {
    const el = qs(id); if (!el) return; el.textContent = ""; el.hidden = true;
  });
}

const AUTH_COPY = {
  login: { title: "Welcome back", subtitle: "Sign in to keep matching with founders, operators & investors." },
  register: { title: "Get started", subtitle: "Build your network in 60 seconds — co-founders, investors, first hires." },
  forgot: { title: "Reset password", subtitle: "We'll email you a link to set a new password." },
  reset: { title: "Pick a new password", subtitle: "Last step — choose something memorable." },
};
function setAuthMode(mode) {
  const copy = AUTH_COPY[mode] || AUTH_COPY.login;
  qs("authTitle").textContent = copy.title;
  qs("authSubtitle").textContent = copy.subtitle;
  // Sync the pill thumb position so it animates left/right.
  const pill = document.querySelector(".auth-pill");
  if (pill) pill.dataset.mode = mode === "register" ? "register" : "login";
  document.querySelectorAll(".auth-tab").forEach((b) => {
    const isActive = b.dataset.authTab === mode;
    b.classList.toggle("active", isActive);
    b.setAttribute("aria-selected", String(isActive));
  });
}

document.querySelectorAll(".auth-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.authTab;
    qs("loginForm").hidden = target !== "login";
    qs("registerForm").hidden = target !== "register";
    qs("forgotForm").hidden = true;
    qs("resetForm").hidden = true;
    setAuthMode(target);
    clearAuthFeedback();
  });
});

// Password show/hide toggles on every .pwd-toggle button.
document.querySelectorAll(".pwd-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = btn.parentElement.querySelector("input");
    if (!input) return;
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    btn.textContent = showing ? "👁" : "🙈";
  });
});

qs("forgotLink").addEventListener("click", (e) => {
  e.preventDefault();
  qs("loginForm").hidden = true;
  qs("registerForm").hidden = true;
  qs("forgotForm").hidden = false;
  setAuthMode("forgot");
  clearAuthFeedback();
});
qs("forgotCancel").addEventListener("click", () => {
  qs("forgotForm").hidden = true;
  qs("loginForm").hidden = false;
  setAuthMode("login");
  clearAuthFeedback();
});
qs("forgotForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAuthError("forgotError", "");
  const fd = new FormData(e.target);
  try {
    const r = await api("/auth/forgot", { method: "POST", body: JSON.stringify({ email: fd.get("email") }) });
    const hint = qs("forgotHint");
    if (r.resetUrl) {
      hint.innerHTML = `Dev mode: <a href="${r.resetUrl}">${r.resetUrl}</a>`;
    } else {
      hint.textContent = "If that email exists, a reset link is on the way.";
    }
    hint.hidden = false;
  } catch (err) { showAuthError("forgotError", err.message); }
});

qs("resetForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAuthError("resetError", "");
  const fd = new FormData(e.target);
  try {
    const r = await api("/auth/reset", { method: "POST", body: JSON.stringify({ token: state.pendingResetToken, password: fd.get("password") }) });
    if (r.token) {
      const me = await fetchMeWithToken(r.token);
      await onAuthSuccess(r.token, me.user, me.profile);
    }
  } catch (err) { showAuthError("resetError", err.message); }
});

// Check URL for ?reset=<token> on load and surface the reset form.
(function checkResetParam() {
  const params = new URLSearchParams(location.search);
  const t = params.get("reset");
  if (t) {
    state.pendingResetToken = t;
    qs("loginForm").hidden = true;
    qs("registerForm").hidden = true;
    qs("resetForm").hidden = false;
    setAuthMode("reset");
  }
})();
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
    await Promise.all([loadDiscover(), loadMatches(), loadSaved(), loadLikedYou(), loadViewedYou(), loadSwipeHistory()]);
  } else {
    showWizardStep(1);
    show("onboarding");
  }
}
function logout() {
  state.token = null; state.user = null; state.profile = null;
  state.pool = []; state.matches = []; state.saved = [];
  localStorage.removeItem(TOKEN_KEY);
  state.ws?.close();
  setLoggedInChrome(false);
  show("auth");
}
function updateChrome() {
  qs("planBadge").hidden = false;
  qs("planBadge").textContent = state.user?.planTier === "PRO" ? "PRO" : "FREE";
  qs("planBadge").classList.toggle("pro", state.user?.planTier === "PRO");
  qs("settingsPlan").textContent =
    state.user?.planTier === "PRO"
      ? `PRO${state.user?.planExpiresAt ? ` · until ${new Date(state.user.planExpiresAt).toLocaleDateString()}` : ""}`
      : "FREE";
  qs("settingsReferral").textContent = state.user?.referralCode || "—";
  qs("settingsEmail").textContent = state.user?.email || "—";
  renderEmailNotifBtn();
  if (state.profile?.slug) {
    const link = `${API_BASE}/u/${state.profile.slug}`;
    qs("publicProfileLink").href = link;
    qs("publicProfileLink").textContent = link;
  }
  // Completion ring + tip
  const pct = profileCompletionPercent(state.profile);
  const ring = qs("completionRing");
  if (ring) {
    ring.style.setProperty("--p", String(pct));
    qs("completionPct").textContent = `${pct}%`;
    qs("completionTip").textContent = completionTip(state.profile);
  }
  // Verify banner
  const banner = qs("verifyBanner");
  if (state.user && !state.user.emailVerified) {
    banner.hidden = false;
    qs("verifyDevLinkBtn").hidden = !state.pendingVerifyUrl;
    qs("verifyDevLinkBtn").onclick = () => state.pendingVerifyUrl && (location.href = state.pendingVerifyUrl);
  } else {
    banner.hidden = true;
  }
  // Admin entry
  qs("adminRow").hidden = !state.user?.isAdmin;
  // Boost status + backend readiness are settings-only widgets — fetched by
  // loadSettingsData() when the settings view opens, not on every chrome
  // refresh (each was an extra API/DB round-trip per login, save, upgrade…).
  if (qs("view-settings")?.classList.contains("active")) loadSettingsData();
  // Auto-detect ?verified=1 redirect from email link
  if (new URLSearchParams(location.search).get("verified") === "1") {
    showToast("Email verified ✓");
    state.pendingVerifyUrl = null;
    history.replaceState({}, "", location.pathname);
  }
}


async function loadReadiness() {
  const summary = qs("readinessSummary");
  const list = qs("readinessList");
  if (!summary || !list) return;
  summary.textContent = "Checking backend readiness…";
  list.innerHTML = "";
  try {
    const r = await api('/ops/readiness');
    summary.textContent = r.ok
      ? `Ready for production-critical checks (${r.summary.passing}/${r.summary.total} passing)`
      : `Not production-ready yet (${r.summary.passing}/${r.summary.total} passing)`;
    (r.checks || []).forEach((c) => {
      const li = document.createElement('li');
      li.className = `readiness-item ${c.ok ? 'ok' : 'warn'}`;
      li.innerHTML = `<strong>${esc(c.key)}</strong>${esc(c.detail)}`;
      list.appendChild(li);
    });
  } catch (e) {
    summary.textContent = `Readiness check unavailable: ${e.message}`;
  }
}

// ---------- Google ----------
async function fetchPrompts() {
  try {
    const r = await fetch(`${API_BASE}/prompts`).then((r) => r.json());
    state.prompts = r.prompts || [];
  } catch { state.prompts = []; }
}

function promptLabel(id) {
  return state.prompts.find((p) => p.id === id)?.label || id;
}

function renderPromptsEditor() {
  const list = qs("promptsList");
  if (!list) return;
  list.innerHTML = "";
  state.pendingPrompts.forEach((entry, i) => {
    const row = document.createElement("div");
    row.className = "prompt-row";
    const select = document.createElement("select");
    select.innerHTML = `<option value="">Pick a prompt…</option>` + state.prompts.map((p) =>
      `<option value="${p.id}" ${p.id === entry.id ? "selected" : ""}>${p.label}</option>`
    ).join("");
    select.addEventListener("change", (e) => {
      state.pendingPrompts[i].id = e.target.value;
    });
    const ta = document.createElement("textarea");
    ta.maxLength = 240;
    ta.placeholder = "Your answer (240 char max)…";
    ta.value = entry.answer || "";
    ta.addEventListener("input", () => { state.pendingPrompts[i].answer = ta.value; });
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "prompt-rm";
    rm.textContent = "Remove";
    rm.addEventListener("click", () => {
      state.pendingPrompts.splice(i, 1);
      renderPromptsEditor();
    });
    row.append(select, ta, rm);
    list.appendChild(row);
  });
  qs("addPromptBtn").disabled = state.pendingPrompts.length >= 3;
  qs("addPromptBtn").textContent = state.pendingPrompts.length >= 3
    ? "Maximum 3 prompts"
    : "+ Add a prompt";
}
document.addEventListener("click", (e) => {
  if (e.target?.id !== "addPromptBtn") return;
  if (state.pendingPrompts.length >= 3) return;
  state.pendingPrompts.push({ id: "", answer: "" });
  renderPromptsEditor();
});

async function setupGoogle() {
  try { state.config = await fetch(`${API_BASE}/auth/config`).then((r) => r.json()); } catch {}
  if (!state.config.googleClientId) { qs("googleDisabledNote").hidden = false; return; }
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
        } catch (e) { showAuthError("loginError", e.message); }
      },
    });
    window.google.accounts.id.renderButton(qs("googleBtnWrap"), { theme: "filled_black", size: "large", width: 320, text: "continue_with" });
  };
  init();
}

// ---------- chat ----------
function connectWebSocket() {
  if (!state.token) return;
  try {
    state.ws?.close();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    state.ws = ws;
    ws.onopen = () => {
      // Auth via handshake message (token no longer in URL).
      ws.send(JSON.stringify({ type: "auth", token: state.token }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "auth_ok") {
          state.wsReconnectAttempts = 0;
        }
        if (msg.type === "message") {
          if (state.activeMatch?.conversation?.id === msg.message.conversationId) {
            appendMessage(msg.message);
            api(`/conversations/${msg.message.conversationId}/read`, { method: "POST" })
              .then(scheduleLoadMatches)
              .catch(() => {});
          } else {
            scheduleLoadMatches();
          }
        }
        if (msg.type === "typing" && state.activeMatch?.conversation?.id === msg.conversationId) {
          qs("typingIndicator").hidden = false;
          clearTimeout(window._typingTimer);
          window._typingTimer = setTimeout(() => (qs("typingIndicator").hidden = true), 1800);
        }
      } catch {}
    };
    ws.onclose = () => {
      if (!state.token) return; // logged out
      state.wsReconnectAttempts += 1;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(state.wsReconnectAttempts, 5));
      setTimeout(connectWebSocket, delay);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  } catch {}
}
function messageMatchesSearch(m) {
  if (!state.chatSearchQuery) return true;
  if (m.kind === "image") return false; // search is text-only
  return String(m.body || "").toLowerCase().includes(state.chatSearchQuery);
}
function buildMessageNode(m) {
  const div = document.createElement("div");
  div.className = `msg ${m.senderId === state.user.id ? "me" : "them"}`;
  div.dataset.messageId = m.id || "";
  if (m.kind === "image") {
    const img = document.createElement("img");
    img.src = m.body;
    img.alt = "Shared photo";
    img.className = "msg-image";
    img.addEventListener("click", () => window.open(m.body, "_blank"));
    div.appendChild(img);
  } else {
    div.appendChild(document.createTextNode(m.body || ""));
  }
  if (m.createdAt) {
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = timeAgo(m.createdAt);
    div.appendChild(ts);
  }
  return div;
}
function appendMessage(m) {
  state.chatMessagesCache.push(m);
  const box = qs("messages");
  if (!messageMatchesSearch(m)) return;
  box.appendChild(buildMessageNode(m));
  box.scrollTop = box.scrollHeight;
}
function rerenderChatMessages() {
  const box = qs("messages");
  box.innerHTML = "";
  state.chatMessagesCache.filter(messageMatchesSearch).forEach((m) => box.appendChild(buildMessageNode(m)));
  box.scrollTop = box.scrollHeight;
}

async function openChat(matchId) {
  const match = state.matches.find((m) => m.id === matchId);
  if (!match || !match.conversation) return;
  state.activeMatch = match;
  state.chatMessagesCache = [];
  state.chatSearchQuery = "";
  qs("chatSearchInput").value = "";
  qs("chatTitle").textContent = `${match.other?.fullName || "Chat"}`;
  qs("bookCallBtn").hidden = !match.other?.profile?.calLink;
  qs("bookCallBtn").onclick = () => window.open(match.other.profile.calLink, "_blank");
  const box = qs("messages");
  box.innerHTML = "";
  let messages = [];
  try {
    messages = await api(`/messages/${match.conversation.id}`);
    messages.forEach(appendMessage);
    // Read receipt: under the latest of my messages that the other side has READ.
    const mine = messages.filter((m) => m.senderId === state.user.id);
    const lastRead = mine.reverse().find((m) => m.status === "READ");
    if (lastRead) {
      const node = box.lastElementChild;
      if (node?.classList.contains("me")) {
        const r = document.createElement("span");
        r.className = "read-receipt";
        r.textContent = `Read · ${timeAgo(lastRead.createdAt)}`;
        node.appendChild(r);
      }
    }
  } catch {}
  try {
    const ice = await api(`/icebreakers?userId=${match.other.id}`);
    const box2 = qs("icebreakerBox");
    if (messages.length === 0 && ice.prompts?.length) {
      box2.hidden = false;
      box2.innerHTML = `<p class="hint">Icebreakers</p>` + ice.prompts.map((p) => `<button type="button">${p}</button>`).join("");
      box2.querySelectorAll("button").forEach((b) =>
        b.addEventListener("click", () => { qs("chatInput").value = b.textContent; qs("chatInput").focus(); box2.hidden = true; }),
      );
    } else {
      box2.hidden = true;
    }
  } catch {}
  api(`/conversations/${match.conversation.id}/read`, { method: "POST" })
    .then(scheduleLoadMatches)
    .catch(() => {});
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
      state.ws.send(JSON.stringify({ type: "send_message", conversationId: state.activeMatch.conversation.id, toUserId: state.activeMatch.other.id, body: text }));
      appendMessage({ senderId: state.user.id, body: text, conversationId: state.activeMatch.conversation.id, createdAt: new Date().toISOString() });
    } else {
      const saved = await api(`/messages/${state.activeMatch.conversation.id}`, { method: "POST", body: JSON.stringify({ body: text }) });
      appendMessage(saved);
    }
  } catch (e) { alert(e.message); }
});
qs("chatInput").addEventListener("input", () => {
  if (state.ws?.readyState !== 1 || !state.activeMatch?.conversation) return;
  state.ws.send(JSON.stringify({ type: "typing", conversationId: state.activeMatch.conversation.id, toUserId: state.activeMatch.other.id }));
});
// Photo attachments in chat. Uploads via /upload (cloud when configured,
// echoes a base64 data URL in dev) then sends a kind="image" message whose
// body is the URL.
qs("chatPhotoInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) return alert("Photo too large (max 4MB).");
  if (!state.activeMatch?.conversation) return;
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  try {
    const up = await api("/upload", { method: "POST", body: JSON.stringify({ dataUrl, folder: "chat" }) });
    const convoId = state.activeMatch.conversation.id;
    const toUserId = state.activeMatch.other.id;
    if (state.ws?.readyState === 1) {
      state.ws.send(JSON.stringify({ type: "send_message", conversationId: convoId, toUserId, body: up.url, kind: "image" }));
      appendMessage({ senderId: state.user.id, body: up.url, kind: "image", conversationId: convoId, createdAt: new Date().toISOString() });
    } else {
      const saved = await api(`/messages/${convoId}`, { method: "POST", body: JSON.stringify({ body: up.url, kind: "image" }) });
      appendMessage(saved);
    }
  } catch (err) {
    alert(`Couldn't send photo: ${err.message}`);
  }
});

qs("chatSearchInput").addEventListener("input", (e) => {
  state.chatSearchQuery = e.target.value.trim().toLowerCase();
  rerenderChatMessages();
});

// ---------- swipe buttons / filters / search ----------
qs("leftBtn").addEventListener("click", () => fling("left"));
qs("rightBtn").addEventListener("click", () => fling("right"));
qs("superLikeBtn").addEventListener("click", () => fling("super"));

// Keyboard shortcuts for swipe (only when discover view is active and no modal open)
document.addEventListener("keydown", (e) => {
  const swipeActive = qs("view-swipe")?.classList.contains("active");
  const anyModal = document.querySelector(".modal:not([hidden])");
  const inField = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if (!swipeActive || anyModal || inField) return;
  switch (e.key) {
    case "ArrowLeft": e.preventDefault(); fling("left"); break;
    case "ArrowRight": e.preventDefault(); fling("right"); break;
    case "ArrowUp": e.preventDefault(); fling("super"); break;
    case "z": case "Z": e.preventDefault(); qs("undoBtn").click(); break;
    case "s": case "S": e.preventDefault(); qs("saveBtn").click(); break;
    case "d": case "D": e.preventDefault(); qs("detailBtn").click(); break;
  }
});
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
qs("detailBtn").addEventListener("click", () => {
  const card = deck.querySelector(".card:last-child");
  if (card?._profile) openDetail(card._profile);
});

qs("filtersToggle").addEventListener("click", () => {
  const r = qs("filtersRow");
  r.hidden = !r.hidden;
});

function renderActiveFilterChips() {
  let chipRow = document.getElementById("activeFilterChips");
  if (!chipRow) {
    chipRow = document.createElement("div");
    chipRow.id = "activeFilterChips";
    chipRow.className = "filter-chip-row";
    qs("filtersRow").after(chipRow);
  }
  const active = [];
  if (state.filters.stage) active.push({ key: "stage", label: state.filters.stage });
  if (state.filters.lookingFor) active.push({ key: "lookingFor", label: state.filters.lookingFor });
  if (state.filters.industry && state.filters.industry !== "all") active.push({ key: "industry", label: state.filters.industry });
  if (state.filters.maxKm) active.push({ key: "maxKm", label: `≤ ${state.filters.maxKm} km` });
  chipRow.innerHTML = active.map((a) => `<span class="filter-chip">${esc(a.label)}<button type="button" data-filter="${a.key}" aria-label="Remove filter">✕</button></span>`).join("");
  chipRow.querySelectorAll("button[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.filter;
      state.filters[k] = k === "industry" ? "all" : "";
      const selectId = k === "industry" ? "industryFilter"
        : k === "stage" ? "filterStage"
        : k === "maxKm" ? "filterDistance"
        : "filterLookingFor";
      qs(selectId).value = k === "industry" ? "all" : "";
      renderActiveFilterChips();
      loadDiscover();
    }),
  );
}

["filterStage", "filterLookingFor", "industryFilter", "filterDistance"].forEach((id) => {
  qs(id).addEventListener("change", (e) => {
    const key = id === "industryFilter" ? "industry"
      : id === "filterStage" ? "stage"
      : id === "filterDistance" ? "maxKm"
      : "lookingFor";
    state.filters[key] = e.target.value;
    renderActiveFilterChips();
    loadDiscover();
  });
});
qs("emptyResetBtn").addEventListener("click", () => {
  state.filters = { stage: "", lookingFor: "", industry: "all", maxKm: "" };
  qs("filterStage").value = ""; qs("filterLookingFor").value = "";
  qs("industryFilter").value = "all"; qs("filterDistance").value = "";
  renderActiveFilterChips();
  loadDiscover();
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

// Tabs (bottom nav)
document.querySelectorAll(".tab").forEach((btn) =>
  btn.addEventListener("click", () => {
    if (btn.dataset.view === "onboarding" && state.profile) {
      // Entering "Profile" with an existing profile means edit mode.
      enterProfileEditor();
      return;
    }
    show(btn.dataset.view);
    if (btn.dataset.view === "matches") { loadMatches(); loadSaved(); loadLikedYou(); loadViewedYou(); loadSwipeHistory(); }
    if (btn.dataset.view === "settings") loadSettingsData();
  }),
);

qs("editProfileBtn").addEventListener("click", enterProfileEditor);

// Tabs (within matches)
document.querySelectorAll(".tab-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    const pane = btn.dataset.pane;
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.toggle("active", p.dataset.pane === pane));
  }),
);

savedList.addEventListener("click", async (e) => {
  const target = e.target?.dataset?.unsaveTarget;
  if (!target) return;
  e.stopPropagation();
  await api(`/saved/${target}`, { method: "DELETE" });
  loadSaved();
});

// ---------- settings, plan, push, install ----------
// Fetch the settings-only widgets (boost status, backend readiness) only when
// the settings view is actually opened.
function loadSettingsData() {
  refreshBoostStatus();
  loadReadiness();
}
qs("settingsBtn").addEventListener("click", () => { show("settings"); loadSettingsData(); });
qs("logoutBtn").addEventListener("click", logout);
qs("refreshReadinessBtn")?.addEventListener("click", loadReadiness);
qs("topbarLogoutBtn").addEventListener("click", () => {
  if (confirm("Log out?")) logout();
});

// Theme picker: auto / light / dark, persisted in localStorage and applied
// to <html data-theme>. "auto" lets prefers-color-scheme decide.
function applyTheme(choice) {
  if (choice === "light" || choice === "dark") {
    document.documentElement.setAttribute("data-theme", choice);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  localStorage.setItem(THEME_KEY, choice);
  document.querySelectorAll(".theme-picker button[data-theme-pick]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.themePick === choice);
  });
}
function currentTheme() {
  return localStorage.getItem(THEME_KEY) || "auto";
}
document.querySelectorAll(".theme-picker button[data-theme-pick]").forEach((btn) => {
  btn.addEventListener("click", () => applyTheme(btn.dataset.themePick));
});
// Initialize the picker's active state to whatever's stored.
applyTheme(currentTheme());

qs("deleteAccountBtn").addEventListener("click", async () => {
  if (!confirm("Permanently delete your account and all your data? This cannot be undone.")) return;
  try {
    await api("/me", { method: "DELETE" });
    logout();
  } catch (e) { alert(e.message); }
});

qs("manageBlocksBtn").addEventListener("click", async () => {
  const wrap = qs("blockedListWrap");
  if (!wrap.hidden) { wrap.hidden = true; return; }
  try {
    const blocks = await api("/blocks");
    const list = qs("blockedList");
    list.innerHTML = "";
    if (!blocks.length) {
      list.innerHTML = `<li class="hint">No one is blocked.</li>`;
    } else {
      blocks.forEach((b) => {
        const li = document.createElement("li");
        li.className = "match-row";
        li.innerHTML = `
          <div class="match-meta">
            <div class="match-name"></div>
            <div class="match-preview"></div>
          </div>
          <button class="ghost">Unblock</button>`;
        li.querySelector(".match-name").textContent = b.fullName || "Unknown";
        li.querySelector(".match-preview").textContent = b.headline || "";
        li.querySelector("button").dataset.unblock = b.targetId;
        list.appendChild(li);
      });
      list.querySelectorAll("button[data-unblock]").forEach((b) =>
        b.addEventListener("click", async () => {
          await api(`/blocks/${b.dataset.unblock}`, { method: "DELETE" });
          qs("manageBlocksBtn").click(); qs("manageBlocksBtn").click(); // refresh
        }),
      );
    }
    wrap.hidden = false;
  } catch (e) { alert(e.message); }
});
qs("unmatchBtn").addEventListener("click", async () => {
  if (!state.activeMatch?.id) return;
  const name = state.activeMatch.other?.fullName || "this person";
  if (!confirm(`Unmatch ${name}? This deletes the conversation.`)) return;
  try {
    await api(`/matches/${state.activeMatch.id}`, { method: "DELETE" });
    state.activeMatch = null;
    state.chatMessagesCache = [];
    showToast("Unmatched");
    await loadMatches();
    show("matches");
  } catch (e) {
    alert(e.message);
  }
});

let boostCountdownTimer = null;
let boostRequestSeq = 0;
async function refreshBoostStatus() {
  const btn = qs("boostBtn");
  const status = qs("boostStatus");
  // Token every call. After the await, if a newer call has started we
  // bail out — its result will overwrite ours anyway and we'd otherwise
  // leak a setInterval or render stale UI.
  const seq = ++boostRequestSeq;
  try {
    const s = await api("/boost/status");
    if (seq !== boostRequestSeq) return;
    clearInterval(boostCountdownTimer);
    boostCountdownTimer = null;
    if (!s.isPro) {
      btn.textContent = "Pro only";
      btn.disabled = true;
      btn.classList.remove("active");
      status.textContent = "Pro-only · jump to the top of decks for 30 min, once a day";
      return;
    }
    if (s.active) {
      btn.classList.add("active");
      btn.disabled = true;
      btn.textContent = "Boosted";
      const tick = () => {
        const left = new Date(s.boostUntil).getTime() - Date.now();
        if (left <= 0) {
          clearInterval(boostCountdownTimer);
          refreshBoostStatus();
          return;
        }
        const m = Math.floor(left / 60_000);
        const sec = Math.floor((left % 60_000) / 1000);
        status.textContent = `Boosted — ${m}m ${String(sec).padStart(2, "0")}s left at the top of decks`;
      };
      tick();
      boostCountdownTimer = setInterval(tick, 1000);
      return;
    }
    btn.classList.remove("active");
    btn.disabled = !!s.usedToday;
    btn.textContent = s.usedToday ? "Used today" : "Boost · 30 min";
    status.textContent = s.usedToday
      ? "Boost used today. Comes back tomorrow."
      : "Tap to spend your daily boost — 30 min at the top of others' decks.";
  } catch {
    /* boost is non-critical UI */
  }
}
qs("boostBtn").addEventListener("click", async () => {
  try {
    await api("/boost", { method: "POST" });
    showToast("Boost activated · 30 min at the top");
    refreshBoostStatus();
  } catch (e) {
    if (e.status === 402) openModal(qs("proModal"));
    else showToast(e.message);
  }
});

qs("verifyResendBtn").addEventListener("click", async () => {
  try {
    const r = await api("/auth/resend-verify", { method: "POST" });
    if (r.alreadyVerified) { showToast("Already verified"); updateChrome(); return; }
    if (r.verifyUrl) {
      state.pendingVerifyUrl = r.verifyUrl;
      updateChrome();
    }
    showToast(r.verifyUrl ? "Verification link ready" : "Verification email sent");
  } catch (e) { showToast(e.message); }
});

qs("adminOpenBtn").addEventListener("click", openAdminModal);
qs("adminCloseBtn").addEventListener("click", () => closeModal(qs("adminModal")));

async function openAdminModal() {
  const modal = qs("adminModal");
  const body = qs("adminQueueBody");
  body.innerHTML = `<p class="hint">Loading…</p>`;
  openModal(modal);
  try {
    const q = await api("/admin/queue");
    body.innerHTML = "";

    // Top: seed-fakes tool.
    const seedRow = document.createElement("div");
    seedRow.className = "admin-row";
    seedRow.innerHTML = `<div><strong>Seed test users</strong><div class="settings-sub">Creates up to 30 demo profiles for testing (idempotent).</div></div><button class="ghost" type="button" id="seedFakesBtn">Seed 30</button>`;
    body.appendChild(seedRow);
    qs("seedFakesBtn").addEventListener("click", async () => {
      const btn = qs("seedFakesBtn");
      btn.disabled = true; btn.textContent = "Seeding…";
      try {
        const r = await api("/admin/seed-fakes", { method: "POST" });
        const out = document.createElement("div");
        out.className = "admin-row";
        out.innerHTML = `<div><strong>${r.created} created · ${r.skipped} already existed</strong><div class="settings-sub">Sign in as any of them with password <code>${esc(r.credentials.password)}</code></div></div>`;
        body.insertBefore(out, seedRow.nextSibling);
        showToast(`${r.created} test users added`);
        if (r.created > 0) loadDiscover();
      } catch (e) { alert(e.message); }
      finally { btn.disabled = false; btn.textContent = "Seed 30"; }
    });

    const usersTitle = document.createElement("h3");
    usersTitle.textContent = `Recent signups (${q.recentUsers?.length || 0})`;
    body.appendChild(usersTitle);
    (q.recentUsers || []).slice(0, 20).forEach((u) => {
      const row = document.createElement("div");
      row.className = "admin-row";
      row.innerHTML = `<div><strong></strong><div class="settings-sub"></div></div><button class="ghost" type="button"></button>`;
      row.querySelector("strong").textContent = u.fullName || u.email;
      row.querySelector(".settings-sub").textContent = `${u.email}${u.emailVerified ? " · email ✓" : ""}${u.verified ? " · verified ✓" : ""}`;
      const btn = row.querySelector("button");
      btn.textContent = u.verified ? "Unverify" : "Verify";
      btn.addEventListener("click", async () => {
        try {
          await api("/admin/verify", { method: "POST", body: JSON.stringify({ userId: u.id, verified: !u.verified }) });
          u.verified = !u.verified;
          btn.textContent = u.verified ? "Unverify" : "Verify";
          showToast(u.verified ? "Verified" : "Unverified");
        } catch (e) { alert(e.message); }
      });
      body.appendChild(row);
    });
    const reportsTitle = document.createElement("h3");
    reportsTitle.textContent = `Reports (${q.reports?.length || 0})`;
    reportsTitle.style.marginTop = "12px";
    body.appendChild(reportsTitle);
    (q.reports || []).slice(0, 20).forEach((r) => {
      const div = document.createElement("div");
      div.className = "admin-row";
      div.innerHTML = `<div><strong></strong><div class="settings-sub"></div></div>`;
      div.querySelector("strong").textContent = `Report on user ${r.targetId.slice(0, 8)}…`;
      div.querySelector(".settings-sub").textContent = r.reason || "(no reason)";
      body.appendChild(div);
    });
    if (!q.recentUsers?.length && !q.reports?.length) body.innerHTML = `<p class="hint">Queue empty.</p>`;
  } catch (e) {
    body.innerHTML = `<p class="hint">${esc(e.message)}</p>`;
  }
}

qs("planBadge").addEventListener("click", () => openModal(qs("proModal")));
qs("upgradeBtn").addEventListener("click", () => openModal(qs("proModal")));
qs("proCloseBtn").addEventListener("click", () => closeModal(qs("proModal")));
qs("proConfirmBtn").addEventListener("click", async () => {
  await api("/plan/upgrade", { method: "POST" });
  state.user.planTier = "PRO";
  closeModal(qs("proModal"));
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
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return alert("Push not supported on this device.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(state.config.vapidPublicKey) });
  const json = sub.toJSON();
  await api("/push/subscribe", { method: "POST", body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }) });
  showToast("Push enabled");
});

function renderEmailNotifBtn() {
  const btn = qs("emailNotifBtn");
  if (!btn) return;
  const optedOut = !!state.user?.emailOptOut;
  btn.textContent = optedOut ? "Off" : "On";
  btn.classList.toggle("active", !optedOut);
}
qs("emailNotifBtn")?.addEventListener("click", async () => {
  const nextOptOut = !state.user?.emailOptOut;
  try {
    const r = await api("/me/notifications", { method: "POST", body: JSON.stringify({ emailOptOut: nextOptOut }) });
    if (state.user) state.user.emailOptOut = r.emailOptOut;
    renderEmailNotifBtn();
    showToast(r.emailOptOut ? "Activity emails off" : "Activity emails on");
  } catch (e) { showToast(e.message); }
});
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  state.installPrompt = e;
  qs("installRow").hidden = false;
});
qs("installAppBtn").addEventListener("click", async () => {
  if (state.installPrompt) {
    state.installPrompt.prompt();
    state.installPrompt = null;
    qs("installRow").hidden = true;
  }
});

// ---------- boot ----------
function setupPullToRefresh() {
  // Mount a single indicator at the top of <main>.
  const main = document.querySelector("main");
  if (!main) return;
  let indicator = document.getElementById("refreshIndicator");
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.id = "refreshIndicator";
    indicator.className = "refresh-indicator";
    indicator.textContent = "Pull to refresh";
    main.prepend(indicator);
  }
  let startY = 0, pulling = false, ready = false;
  main.addEventListener("touchstart", (e) => {
    if (window.scrollY > 4) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });
  main.addEventListener("touchmove", (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 12) {
      indicator.classList.add("pulling");
      indicator.textContent = dy > 70 ? "Release to refresh" : "Pull to refresh";
      ready = dy > 70;
    }
  }, { passive: true });
  main.addEventListener("touchend", async () => {
    if (!pulling) return;
    pulling = false;
    if (ready) {
      indicator.classList.remove("pulling");
      indicator.classList.add("refreshing");
      indicator.textContent = "Refreshing…";
      const view = document.querySelector(".view.active")?.id;
      if (view === "view-swipe") await loadDiscover();
      else if (view === "view-matches") { await Promise.all([loadMatches(), loadSaved(), loadLikedYou(), loadViewedYou()]); }
      indicator.classList.remove("refreshing");
      indicator.textContent = "Pull to refresh";
    } else {
      indicator.classList.remove("pulling");
    }
    ready = false;
  });
}

async function boot() {
  enforceChipMax();
  ["matchModal", "proModal", "detailModal", "adminModal"].forEach((id) => wireModal(qs(id)));
  setupPullToRefresh();
  await Promise.all([setupGoogle(), fetchPrompts()]);
  if (state.token) {
    try {
      const me = await fetchMeWithToken(state.token);
      await onAuthSuccess(state.token, me.user, me.profile);
      return;
    } catch { logout(); }
  }
  setLoggedInChrome(false);
  show("auth");
}
boot();
