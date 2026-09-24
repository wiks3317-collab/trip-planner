// ============================================================
// 旅行行程規劃工具 - app.js
// 純前端 + Firebase Firestore（即時同步資料庫）
// ============================================================

import { db, auth, authReady } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ------------------------------------------------------------
// 小工具
// ------------------------------------------------------------
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// 產生 Google 地圖連結：
// - normalizeMapLink：把使用者貼的「Google地圖連結」欄位轉成可用的網址（沒帶 https:// 也會自動補上）
// - mapSearchLink：把「地址／地點」關鍵字組成 Google 地圖搜尋連結
// - resolveMapHref：連結優先，沒有連結才退回用地址／地點搜尋，再沒有才用最後的 fallback 文字搜尋
function normalizeMapLink(url) {
  const raw = (url || "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}
function mapSearchLink(query) {
  const raw = (query || "").trim();
  if (!raw) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(raw)}`;
}
function resolveMapHref(linkValue, addressValue, fallbackText) {
  return normalizeMapLink(linkValue) || mapSearchLink(addressValue) || mapSearchLink(fallbackText);
}

function newLocalId() {
  return doc(collection(db, "_ids")).id;
}

function toast(msg) {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function fmtMoney(cents) {
  const v = Math.round(cents) / 100;
  return v.toLocaleString("zh-Hant-TW", { maximumFractionDigits: 0 });
}

// ------------------------------------------------------------
// 幣別
// ------------------------------------------------------------
const CURRENCY_OPTIONS = [
  { code: "TWD", label: "新台幣" },
  { code: "JPY", label: "日圓" },
  { code: "USD", label: "美金" },
  { code: "EUR", label: "歐元" },
  { code: "KRW", label: "韓元" },
  { code: "CNY", label: "人民幣" },
  { code: "HKD", label: "港幣" },
  { code: "THB", label: "泰銖" },
  { code: "GBP", label: "英鎊" },
  { code: "AUD", label: "澳幣" },
  { code: "SGD", label: "新加坡幣" },
  { code: "MYR", label: "馬來西亞幣" },
  { code: "PHP", label: "菲律賓披索" },
  { code: "VND", label: "越南盾" },
  { code: "IDR", label: "印尼盾" },
  { code: "MOP", label: "澳門幣" },
  { code: "CAD", label: "加拿大幣" },
  { code: "CHF", label: "瑞士法郎" },
];
function currencyLabel(code) {
  const c = CURRENCY_OPTIONS.find((x) => x.code === code);
  return c ? `${c.code} ${c.label}` : code;
}
function tripCurrencies() {
  const list = state.trip && state.trip.currencies;
  return list && list.length ? list : ["TWD"];
}
function fmtCurrencyAmt(cents, currency) {
  const v = fmtMoney(cents);
  return currency === "TWD" ? `NT$${v}` : `${currency} $${v}`;
}

// 用 fawazahmed0/currency-api（免費、無需金鑰、支援歷史日期）查詢某天的匯率
// 回傳：1 單位 fromCurrency 兌換成多少 TWD；查不到則回傳 null
async function fetchExchangeRate(dateStr, fromCurrency) {
  if (fromCurrency === "TWD") return 1;
  const from = fromCurrency.toLowerCase();
  const dateSeg = dateStr || "latest";
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${dateSeg}/v1/currencies/${from}.json`,
    `https://${dateSeg}.currency-api.pages.dev/v1/currencies/${from}.json`,
  ];
  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      const rate = data[from] && data[from].twd;
      if (typeof rate === "number") return rate;
    } catch {
      // 試下一個備援網址
    }
  }
  return null;
}

function fmtDateTime(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("zh-Hant-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ------------------------------------------------------------
// localStorage 輔助（記住「我在這個裝置上是誰」與「我看過哪些行程」）
// ------------------------------------------------------------
const LS_MY_TRIPS = "tp_my_trips";       // [{id, name}]
const LS_MEMBER_PREFIX = "tp_member_";   // tp_member_{tripId} = memberId

function getMyTrips() {
  try {
    return JSON.parse(localStorage.getItem(LS_MY_TRIPS) || "[]");
  } catch {
    return [];
  }
}
function saveMyTrip(id, name) {
  const list = getMyTrips().filter((t) => t.id !== id);
  list.unshift({ id, name });
  localStorage.setItem(LS_MY_TRIPS, JSON.stringify(list.slice(0, 30)));
}
function updateMyTripName(id, name) {
  const list = getMyTrips();
  const item = list.find((t) => t.id === id);
  if (item) {
    item.name = name;
    localStorage.setItem(LS_MY_TRIPS, JSON.stringify(list));
  }
}
function removeMyTrip(id) {
  localStorage.setItem(LS_MY_TRIPS, JSON.stringify(getMyTrips().filter((t) => t.id !== id)));
}
function getMyMemberId(tripId) {
  // 舊版相容用：新版本不再以 localStorage 選擇身份。
  return localStorage.getItem(LS_MEMBER_PREFIX + tripId) || null;
}
function setMyMemberId(tripId, memberId) {
  // 保留舊資料清理能力，但不再由 UI 呼叫來切換權限。
  if (memberId) localStorage.setItem(LS_MEMBER_PREFIX + tripId, memberId);
  else localStorage.removeItem(LS_MEMBER_PREFIX + tripId);
}
function currentUid() {
  return auth.currentUser?.uid || null;
}

function memberUids(member) {
  const values = Array.isArray(member?.uids) ? [...member.uids] : [];
  if (member?.uid && !values.includes(member.uid)) values.unshift(member.uid);
  return [...new Set(values.filter(Boolean))];
}

// ------------------------------------------------------------
// 外觀設定（顏色 / 字型 / 字級）— 存在裝置本機，套用到整個網頁
// ------------------------------------------------------------
const LS_APPEARANCE = "tp_appearance";

const THEME_PRESETS = [
  { id: "ocean", name: "海洋藍", primary: "#0E6B64", primaryDark: "#0A5450", accent: "#D98E2B", bg: "#EEF3F0" },
  { id: "dusk", name: "薄暮紫", primary: "#5B4B8A", primaryDark: "#453873", accent: "#E8A33D", bg: "#F2EFF7" },
  { id: "forest", name: "山林綠", primary: "#2F6B3A", primaryDark: "#23512C", accent: "#C97B2E", bg: "#EFF4EC" },
  { id: "wheat", name: "麥浪黃", primary: "#B9840F", primaryDark: "#8F6608", accent: "#0E6B64", bg: "#F6F1E6" },
  { id: "slate", name: "石板灰", primary: "#3B5166", primaryDark: "#2C3D4D", accent: "#C9A227", bg: "#EEF0F2" },
];

const FONT_PRESETS = [
  { id: "journal", name: "手札質感", heading: '"LXGW WenKai TC", "Noto Serif TC", serif', body: '"Noto Sans TC", sans-serif' },
  { id: "modern", name: "現代俐落", heading: '"Noto Sans TC", sans-serif', body: '"Noto Sans TC", sans-serif' },
  { id: "refined", name: "細緻雅致", heading: '"Noto Serif TC", serif', body: '"Noto Sans TC", sans-serif' },
];

const SIZE_PRESETS = [
  { id: "sm", name: "小", px: "15px" },
  { id: "md", name: "中", px: "16px" },
  { id: "lg", name: "大", px: "18px" },
];

function loadAppearance() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_APPEARANCE) || "{}");
    return {
      themeId: saved.themeId || "ocean",
      fontId: saved.fontId || "journal",
      sizeId: saved.sizeId || "md",
    };
  } catch {
    return { themeId: "ocean", fontId: "journal", sizeId: "md" };
  }
}
function saveAppearance(settings) {
  localStorage.setItem(LS_APPEARANCE, JSON.stringify(settings));
}
function applyAppearance(settings) {
  const theme = THEME_PRESETS.find((t) => t.id === settings.themeId) || THEME_PRESETS[0];
  const font = FONT_PRESETS.find((f) => f.id === settings.fontId) || FONT_PRESETS[0];
  const size = SIZE_PRESETS.find((s) => s.id === settings.sizeId) || SIZE_PRESETS[1];
  const root = document.documentElement.style;
  root.setProperty("--primary", theme.primary);
  root.setProperty("--primary-dark", theme.primaryDark);
  root.setProperty("--accent", theme.accent);
  root.setProperty("--bg", theme.bg);
  root.setProperty("--font-heading", font.heading);
  root.setProperty("--font-body", font.body);
  root.setProperty("--base-font-size", size.px);
}

// 一載入就先套用外觀設定，讓載入畫面也是對的樣式
applyAppearance(loadAppearance());

// ------------------------------------------------------------
// 行程背景圖片（存在 Firestore 的行程資料裡，所以每個看行程的人都會看到同一張）
// ------------------------------------------------------------
function applyTripBackground(url, dim) {
  const layer = document.getElementById("bg-image-layer");
  if (url) {
    const d = Math.min(Math.max(dim ?? 30, 0), 85) / 100;
    layer.style.backgroundImage = `linear-gradient(rgba(0,0,0,${d}), rgba(0,0,0,${d})), url("${url.replace(/"/g, '\\"')}")`;
    document.body.classList.add("has-bg-image");
  } else {
    layer.style.backgroundImage = "";
    document.body.classList.remove("has-bg-image");
  }
}

// ------------------------------------------------------------
// 全域狀態
// ------------------------------------------------------------
const state = {
  tripId: null,
  trip: null,          // { id, name, members:[{id,name,permission}], ... }
  days: [],             // [{id, title, date, order, blocks}]
  currentDayId: null,
  spots: [],            // spots of currentDayId
  currentSpotId: null,
  currentSpot: null,
  wishes: [],
  expenses: [],
  tripSection: "itinerary", // 'itinerary' | 'expenses'
  unsub: {},             // active onSnapshot unsubscribe fns, keyed
};

function clearUnsub(key) {
  if (state.unsub[key]) {
    state.unsub[key]();
    delete state.unsub[key];
  }
}
function clearAllUnsub() {
  Object.keys(state.unsub).forEach(clearUnsub);
}

function myMember() {
  if (!state.trip || !currentUid()) return null;
  // 權限以 Firebase Authentication 的 UID 綁定，不再採用前端自行選擇的 memberId。
  return (state.trip.members || []).find((m) => m.uid === currentUid() || (Array.isArray(m.uids) && m.uids.includes(currentUid()))) || null;
}
function myPermission() {
  const m = myMember();
  return m ? m.permission : "viewer_unset"; // 尚未選擇身份 -> 視同唯讀
}
function canEditItinerary() {
  const p = myPermission();
  return p === "owner" || p === "editor";
}
function isOwner() {
  return myPermission() === "owner";
}

// ------------------------------------------------------------
// Modal 系統
// ------------------------------------------------------------
function openModal(titleHtml, bodyHtml) {
  const overlay = document.getElementById("modal-overlay");
  const box = document.getElementById("modal-box");
  box.innerHTML = `<div class="modal-title">${titleHtml}</div>${bodyHtml}`;
  overlay.classList.remove("hidden");
}
function closeModal() {
  document.getElementById("modal-overlay").classList.add("hidden");
  document.getElementById("modal-box").innerHTML = "";
}
document.getElementById("modal-overlay").addEventListener("click", (e) => {
  if (e.target.id === "modal-overlay") closeModal();
});

// ------------------------------------------------------------
// 景點詳細面板（彈出式，取代整頁跳轉）
// ------------------------------------------------------------
function showSpotPanel() {
  document.getElementById("spot-panel-overlay").classList.remove("hidden");
}
function hideSpotPanel() {
  document.getElementById("spot-panel-overlay").classList.add("hidden");
  document.getElementById("spot-panel-content").innerHTML = "";
  clearUnsub("spot");
  clearUnsub("wishes");
}
function closeSpotPanel() {
  // 沿用路由，這樣網址列、上一頁鍵都會維持正確狀態
  navigate(`#/trip/${state.tripId}/day/${state.currentDayId}`);
}
document.getElementById("spot-panel-close").addEventListener("click", closeSpotPanel);
document.getElementById("spot-panel-overlay").addEventListener("click", (e) => {
  if (e.target.id === "spot-panel-overlay") closeSpotPanel();
});

// ------------------------------------------------------------
// 路由
// ------------------------------------------------------------
function navigate(hash) {
  if (window.location.hash === hash) {
    route();
  } else {
    window.location.hash = hash;
  }
}
window.addEventListener("hashchange", route);

function parseHash() {
  // #/trip/TRIPID
  // #/trip/TRIPID/day/DAYID
  // #/trip/TRIPID/day/DAYID/spot/SPOTID
  // #/trip/TRIPID/expenses
  // #/import/CODE
  // #/s/CODE  （分享行程用的短代碼）
  const h = window.location.hash.replace(/^#\/?/, "");
  const parts = h.split("/").filter(Boolean);
  const result = {};
  if (parts[0] === "import" && parts[1]) {
    result.importCode = decodeURIComponent(parts[1]);
    return result;
  }
  if (parts[0] === "s" && parts[1]) {
    result.shortCode = decodeURIComponent(parts[1]);
    return result;
  }
  if (parts[0] === "trip" && parts[1]) {
    result.tripId = parts[1];
    if (parts[2] === "day" && parts[3]) {
      result.dayId = parts[3];
      if (parts[4] === "spot" && parts[5]) {
        result.spotId = parts[5];
      }
    } else if (parts[2] === "expenses") {
      result.expenses = true;
    }
  }
  return result;
}

async function route() {
  const r = parseHash();

  if (r.importCode) {
    importSyncCode(r.importCode);
    return;
  }

  if (r.shortCode) {
    resolveTripShortCode(r.shortCode);
    return;
  }

  if (!r.tripId) {
    clearAllUnsub();
    state.tripId = null;
    state.trip = null;
    applyTripBackground(null);
    hideSpotPanel();
    renderWelcome();
    renderTripMenu();
    updateHeader();
    return;
  }

  if (state.tripId !== r.tripId) {
    await loadTrip(r.tripId);
  }

  state.tripSection = r.expenses ? "expenses" : "itinerary";
  state.currentDayId = r.dayId || state.currentDayId;
  state.currentSpotId = r.spotId || null;

  if (!state.trip) {
    // 行程還在載入或不存在
    return;
  }

  updateHeader();
  renderTripMenu();

  // 新版不再讓使用者自行選擇成員身份；未綁定 UID 的使用者視為唯讀訪客。
  // 後續將透過邀請／認領流程正式綁定成員 UID。

  if (state.tripSection === "expenses") {
    hideSpotPanel();
    subscribeExpenses();
    renderExpensesPage();
  } else if (r.spotId) {
    renderTripHome(); // 讓面板底下的當天行程維持在畫面上
    showSpotPanel();
    subscribeSpot(r.dayId, r.spotId);
  } else {
    hideSpotPanel();
    renderTripHome();
  }
}


async function resolveTripShortCode(code) {
  renderLoading();
  const data = await getShortlinkData(code);
  if (!data || data.type !== "trip" || !data.tripId) {
    toast("這組行程代碼或連結已失效，請確認是否輸入正確");
    navigate("");
    return;
  }
  navigate(`#/trip/${data.tripId}`);
}

// ------------------------------------------------------------
// Firestore：行程（trip）
// ------------------------------------------------------------
async function loadTrip(tripId) {
  clearAllUnsub();
  state.tripId = tripId;
  state.trip = null;
  state.days = [];
  state.spots = [];
  state.currentDayId = null;
  state.currentSpotId = null;
  renderLoading();

  const tripRef = doc(db, "trips", tripId);
  const snap = await getDoc(tripRef);
  if (!snap.exists()) {
    toast("找不到這個行程，連結可能有誤");
    navigate("");
    return;
  }
  state.trip = { id: tripId, ...snap.data() };
  saveMyTrip(tripId, state.trip.name);
  applyTripBackground(state.trip.backgroundImageUrl, state.trip.backgroundDim);

  state.unsub.trip = onSnapshot(tripRef, (s) => {
    if (!s.exists()) return;
    state.trip = { id: tripId, ...s.data() };
    updateMyTripName(tripId, state.trip.name);
    applyTripBackground(state.trip.backgroundImageUrl, state.trip.backgroundDim);
    updateHeader();
    // 若目前畫面跟成員/權限有關，重新渲染目前頁面
    route();
  });

  subscribeDays();
}

async function createTrip(name, members) {
  const uid = currentUid();
  let ownerBound = false;
  const boundMembers = (members || []).map((m) => {
    const bindThisOwner = !!uid && m.permission === "owner" && !ownerBound;
    if (bindThisOwner) ownerBound = true;
    return { ...m, uid: bindThisOwner ? uid : (m.uid || null) };
  });
  const owner = boundMembers.find((m) => m.permission === "owner" && m.uid);
  const access = {};
  boundMembers.forEach((m) => {
    const uids = Array.isArray(m.uids) ? m.uids : (m.uid ? [m.uid] : []);
    uids.forEach((uid) => { if (uid && !access[uid]) access[uid] = m.permission; });
  });
  const ref = await addDoc(collection(db, "trips"), {
    name,
    members: boundMembers,
    ownerUid: owner?.uid || null,
    access,
    authModelVersion: 2,
    createdAt: serverTimestamp(),
  });
  saveMyTrip(ref.id, name);
  return ref.id;
}

async function updateTripMembers(members) {
  const normalizedMembers = members.map((m) => ({ ...m, uids: memberUids(m) }));
  const ownerUid = state.trip?.ownerUid || currentUid();
  const owners = normalizedMembers.filter((m) => m.permission === "owner");
  const boundOwner = normalizedMembers.find((m) => memberUids(m).includes(ownerUid));

  // 避免在成員管理畫面中意外移除真正的統籌人，或建立第二位 owner。
  if (!ownerUid || owners.length !== 1 || !boundOwner || boundOwner.permission !== "owner") {
    throw new Error("統籌人資料不完整，請保留原統籌人且不可新增第二位統籌人");
  }

  const access = {};
  normalizedMembers.forEach((m) => {
    memberUids(m).forEach((uid) => { if (uid) access[uid] = m.permission; });
  });
  await updateDoc(doc(db, "trips", state.tripId), {
    members: normalizedMembers,
    access,
    ownerUid,
    authModelVersion: 2,
  });
}

async function createEditAccessRequest() {
  const uid = currentUid();
  if (!uid || !state.tripId || canEditItinerary()) return;

  // 使用申請者 UID 作為文件 ID，避免訪客送出申請前必須查詢整個申請集合。
  // 同一個 UID 在同一個行程中只會有一筆申請資料。
  const requestRef = doc(db, "trips", state.tripId, "accessRequests", uid);
  const existing = await getDoc(requestRef);
  if (existing.exists()) {
    const data = existing.data();
    if (data.status === "pending") {
      toast("你已經送出過編輯權限申請，請等待統籌人處理");
      return;
    }
  }

  await setDoc(requestRef, {
    requestedUid: uid,
    status: "pending",
    createdAt: serverTimestamp(),
  });
  toast("已送出編輯權限申請，請通知統籌人審核");
}

async function loadAccessRequests() {
  const snap = await getDocs(collection(db, "trips", state.tripId, "accessRequests"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function approveAccessRequest(requestId, requestedUid, memberId) {
  const members = (state.trip.members || []).map((m) => ({ ...m }));
  const target = members.find((m) => m.id === memberId);
  if (!target) throw new Error("找不到要綁定的成員");
  if (target.permission === "owner") throw new Error("不能把申請者綁定到統籌人欄位");
  const previousUid = target.uid || null;
  target.uids = [...new Set([...(Array.isArray(target.uids) ? target.uids : []), ...(previousUid ? [previousUid] : []), requestedUid])];
  target.uid = target.uids[0] || requestedUid;
  target.permission = "editor";
  await updateTripMembers(members);
  await updateDoc(doc(db, "trips", state.tripId, "accessRequests", requestId), {
    status: "approved",
    approvedMemberId: memberId,
    approvedAt: serverTimestamp(),
  });
}

async function rejectAccessRequest(requestId) {
  await updateDoc(doc(db, "trips", state.tripId, "accessRequests", requestId), {
    status: "rejected",
    rejectedAt: serverTimestamp(),
  });
}

function isLegacyTrip() {
  return !state.trip?.authModelVersion || !state.trip?.ownerUid || !state.trip?.access;
}

async function claimLegacyTrip() {
  const uid = currentUid();
  if (!uid || !state.trip || !isLegacyTrip()) return;
  const ownerIndex = (state.trip.members || []).findIndex((m) => m.permission === "owner");
  if (ownerIndex < 0) {
    toast("這個舊行程沒有找到統籌人資料，請先在 Firebase Console 確認 members");
    return;
  }
  const members = (state.trip.members || []).map((m, i) => ({
    ...m,
    uid: i === ownerIndex ? uid : (m.uid || null),
  }));
  const access = {};
  normalizedMembers.forEach((m) => {
    memberUids(m).forEach((uid) => { if (uid) access[uid] = m.permission; });
  });
  await updateDoc(doc(db, "trips", state.tripId), {
    members: normalizedMembers,
    ownerUid: uid,
    access,
    authModelVersion: 2,
    migratedAt: serverTimestamp(),
  });
  toast("已將此舊行程綁定到目前裝置的匿名身份");
}

async function updateTripCurrencies(currencies) {
  await updateDoc(doc(db, "trips", state.tripId), { currencies });
}

// 把某個幣別最新查到（或手動輸入）的匯率存回行程資料，這樣同行每個人看到的都是同一組匯率
async function saveTripFxRate(currency, rate, manual) {
  await updateDoc(doc(db, "trips", state.tripId), {
    [`fxRates.${currency}`]: { rate, updatedAt: todayStr(), manual: !!manual },
  });
}

function tripFxRates() {
  return (state.trip && state.trip.fxRates) || {};
}

// 嘗試自動查詢某幣別「最新」匯率（不指定日期，避免抓不到今天還沒公布的資料）並存回行程
async function refreshFxRate(currency) {
  if (currency === "TWD") return true;
  const rate = await fetchExchangeRate("latest", currency);
  if (rate) {
    await saveTripFxRate(currency, rate, false);
    return true;
  }
  return false;
}

async function updateTripBackground(url, dim) {
  await updateDoc(doc(db, "trips", state.tripId), { backgroundImageUrl: url || "", backgroundDim: dim });
}

async function renameTrip(name) {
  await updateDoc(doc(db, "trips", state.tripId), { name });
}

// ------------------------------------------------------------
// Firestore：天數（days）
// ------------------------------------------------------------
function subscribeDays() {
  clearUnsub("days");
  const q = query(collection(db, "trips", state.tripId, "days"), orderBy("order", "asc"));
  state.unsub.days = onSnapshot(q, (snap) => {
    state.days = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if ((!state.currentDayId || !state.days.find((d) => d.id === state.currentDayId)) && state.days.length) {
      state.currentDayId = state.days[0].id;
    }
    if (state.currentDayId) ensureSpotsSubscription(state.currentDayId);
    if (state.tripSection === "itinerary" && !state.currentSpotId) {
      renderTripHome();
    } else if (state.currentSpotId) {
      // 天數列表變動也可能影響麵包屑，重繪 spot 頁
      renderSpotPage();
    }
  });
}

let spotsSubscribedDay = null;
function ensureSpotsSubscription(dayId) {
  if (spotsSubscribedDay === dayId) return;
  spotsSubscribedDay = dayId;
  state.spots = [];
  subscribeSpots(dayId);
}

function selectDay(dayId) {
  state.currentDayId = dayId;
  state.currentSpotId = null;
  ensureSpotsSubscription(dayId);
  navigate(`#/trip/${state.tripId}/day/${dayId}`);
}

async function createDay(title, date) {
  const order = state.days.length;
  const ref = await addDoc(collection(db, "trips", state.tripId, "days"), {
    title, date: date || "", order, blocks: [], createdAt: serverTimestamp(),
  });
  state.currentDayId = ref.id;
  return ref.id;
}
async function updateDayMeta(dayId, data) {
  await updateDoc(doc(db, "trips", state.tripId, "days", dayId), data);
}
async function updateDayBlocks(dayId, blocks) {
  await updateDoc(doc(db, "trips", state.tripId, "days", dayId), { blocks });
}
async function deleteDay(dayId) {
  // 連同底下景點一起刪除
  const spotsSnap = await getDocs(collection(db, "trips", state.tripId, "days", dayId, "spots"));
  const batch = writeBatch(db);
  spotsSnap.docs.forEach((d) => batch.delete(d.ref));
  batch.delete(doc(db, "trips", state.tripId, "days", dayId));
  await batch.commit();
}
async function moveDay(idx, delta) {
  const arr = state.days;
  const j = idx + delta;
  if (j < 0 || j >= arr.length) return;
  const a = arr[idx], b = arr[j];
  const batch = writeBatch(db);
  batch.update(doc(db, "trips", state.tripId, "days", a.id), { order: b.order });
  batch.update(doc(db, "trips", state.tripId, "days", b.id), { order: a.order });
  await batch.commit();
}

// ------------------------------------------------------------
// Firestore：景點 / 時段（spots）
// ------------------------------------------------------------
function subscribeSpots(dayId) {
  clearUnsub("spots");
  const q = query(collection(db, "trips", state.tripId, "days", dayId, "spots"), orderBy("order", "asc"));
  state.unsub.spots = onSnapshot(q, (snap) => {
    state.spots = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (state.tripSection === "itinerary" && !state.currentSpotId) {
      renderTripHome();
    }
  });
}

async function createSpot(dayId, title, time) {
  const order = state.spots.length;
  const ref = await addDoc(collection(db, "trips", state.tripId, "days", dayId, "spots"), {
    title, time: time || "", order, blocks: [], mapUrl: null, createdAt: serverTimestamp(),
  });
  return ref.id;
}
async function updateSpotMeta(dayId, spotId, data) {
  await updateDoc(doc(db, "trips", state.tripId, "days", dayId, "spots", spotId), data);
}
async function updateSpotBlocks(dayId, spotId, blocks) {
  await updateDoc(doc(db, "trips", state.tripId, "days", dayId, "spots", spotId), { blocks });
}
async function deleteSpot(dayId, spotId) {
  const wishesSnap = await getDocs(collection(db, "trips", state.tripId, "days", dayId, "spots", spotId, "wishes"));
  const batch = writeBatch(db);
  wishesSnap.docs.forEach((d) => batch.delete(d.ref));
  batch.delete(doc(db, "trips", state.tripId, "days", dayId, "spots", spotId));
  await batch.commit();
}
// 把一個景點複製到（同一個或另一個）天數；只複製名稱／時間／內容區塊／地圖設定，
// 不會複製許願池留言（因為那是大家在原景點下的留言，複製過去容易造成混淆）。
async function copySpotToDay(spot, targetDayId) {
  const targetSpotsSnap = await getDocs(collection(db, "trips", state.tripId, "days", targetDayId, "spots"));
  const order = targetSpotsSnap.size;
  await addDoc(collection(db, "trips", state.tripId, "days", targetDayId, "spots"), {
    title: spot.title,
    time: spot.time || "",
    blocks: spot.blocks || [],
    mapUrl: spot.mapUrl || null,
    order,
    createdAt: serverTimestamp(),
  });
}
// 把一個景點搬移到另一個天數：在目標天數建立一份一模一樣的景點（含許願池留言），
// 再把原本天數底下的這個景點刪除，等於是「搬過去」而不是複製。
async function moveSpotToDay(sourceDayId, spot, targetDayId) {
  const targetSpotsSnap = await getDocs(collection(db, "trips", state.tripId, "days", targetDayId, "spots"));
  const order = targetSpotsSnap.size;
  const newSpotRef = doc(collection(db, "trips", state.tripId, "days", targetDayId, "spots"));
  const wishesSnap = await getDocs(collection(db, "trips", state.tripId, "days", sourceDayId, "spots", spot.id, "wishes"));
  const batch = writeBatch(db);
  batch.set(newSpotRef, {
    title: spot.title,
    time: spot.time || "",
    blocks: spot.blocks || [],
    mapUrl: spot.mapUrl || null,
    order,
    createdAt: serverTimestamp(),
  });
  wishesSnap.docs.forEach((d) => {
    const newWishRef = doc(collection(db, "trips", state.tripId, "days", targetDayId, "spots", newSpotRef.id, "wishes"));
    batch.set(newWishRef, d.data());
    batch.delete(d.ref);
  });
  batch.delete(doc(db, "trips", state.tripId, "days", sourceDayId, "spots", spot.id));
  await batch.commit();
}
async function moveSpot(dayId, idx, delta) {
  const arr = state.spots;
  const j = idx + delta;
  if (j < 0 || j >= arr.length) return;
  const a = arr[idx], b = arr[j];
  const batch = writeBatch(db);
  batch.update(doc(db, "trips", state.tripId, "days", dayId, "spots", a.id), { order: b.order });
  batch.update(doc(db, "trips", state.tripId, "days", dayId, "spots", b.id), { order: a.order });
  await batch.commit();
}

function subscribeSpot(dayId, spotId) {
  clearUnsub("spot");
  clearUnsub("wishes");
  const spotRef = doc(db, "trips", state.tripId, "days", dayId, "spots", spotId);
  state.unsub.spot = onSnapshot(spotRef, (s) => {
    if (!s.exists()) {
      toast("這個景點已被刪除");
      navigate(`#/trip/${state.tripId}/day/${dayId}`);
      return;
    }
    state.currentSpot = { id: s.id, ...s.data() };
    renderSpotPage();
  });
  const wq = query(collection(db, "trips", state.tripId, "days", dayId, "spots", spotId, "wishes"), orderBy("createdAt", "desc"));
  state.unsub.wishes = onSnapshot(wq, (snap) => {
    state.wishes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderSpotPage();
  });
}

async function addWish(dayId, spotId, text, imageUrl, mapUrl, mapAddress) {
  const m = myMember();
  await addDoc(collection(db, "trips", state.tripId, "days", dayId, "spots", spotId, "wishes"), {
    text: text || "",
    imageUrl: imageUrl || null,
    mapUrl: mapUrl || null,
    mapAddress: mapAddress || null,
    authorId: m ? m.id : null,
    authorName: m ? m.name : "匿名旅伴",
    createdAt: serverTimestamp(),
  });
}
async function updateWish(dayId, spotId, wishId, data) {
  await updateDoc(doc(db, "trips", state.tripId, "days", dayId, "spots", spotId, "wishes", wishId), data);
}
async function deleteWish(dayId, spotId, wishId) {
  await deleteDoc(doc(db, "trips", state.tripId, "days", dayId, "spots", spotId, "wishes", wishId));
}

// ------------------------------------------------------------
// Firestore：記帳（expenses）
// ------------------------------------------------------------
function subscribeExpenses() {
  clearUnsub("expenses");
  const q = query(collection(db, "trips", state.tripId, "expenses"), orderBy("date", "asc"));
  state.unsub.expenses = onSnapshot(q, (snap) => {
    state.expenses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (state.tripSection === "expenses") renderExpensesPage();
  });
}

async function addExpense({ title, amountCents, currency, payerId, splitWith, date, note }) {
  await addDoc(collection(db, "trips", state.tripId, "expenses"), {
    title, amountCents, currency, payerId, splitWith, date, note: note || "",
    createdAt: serverTimestamp(),
  });
}
async function updateExpense(expenseId, { title, amountCents, currency, payerId, splitWith, date, note }) {
  await updateDoc(doc(db, "trips", state.tripId, "expenses", expenseId), {
    title, amountCents, currency, payerId, splitWith, date, note: note || "",
  });
}
async function deleteExpense(expenseId) {
  await deleteDoc(doc(db, "trips", state.tripId, "expenses", expenseId));
}


// ------------------------------------------------------------
// Header / 選單
// ------------------------------------------------------------
function updateHeader() {
  const nameEl = document.getElementById("header-trip-name");
  const badge = document.getElementById("current-member-badge");
  const shareBtn = document.getElementById("share-btn");
  const renameBtn = document.getElementById("rename-trip-btn");
  if (state.trip) {
    nameEl.textContent = state.trip.name;
    const m = myMember();
    badge.textContent = m
      ? `你是：${m.name}${m.permission === "viewer" ? "（唯讀）" : ""} ▾`
      : "選擇你的身份 ▾";
    badge.classList.remove("hidden");
    shareBtn.classList.remove("hidden");
    renameBtn.classList.toggle("hidden", !isOwner());
  } else {
    nameEl.textContent = "旅行行程規劃工具";
    badge.classList.add("hidden");
    shareBtn.classList.add("hidden");
    renameBtn.classList.add("hidden");
  }
}

// 不再提供「切換身份」入口，避免使用者透過前端選擇其他成員而取得其權限。
// document.getElementById("current-member-badge").addEventListener("click", renderMemberSwitchModal);

document.getElementById("rename-trip-btn").addEventListener("click", () => {
  if (!state.trip) return;
  openModal("重新命名行程", `
    <div class="form-row"><label>行程名稱</label><input type="text" id="rename-trip-input" value="${escapeHtml(state.trip.name)}"></div>
    <div class="form-actions">
      <button class="secondary-btn" id="rename-cancel">取消</button>
      <button class="primary-btn" id="rename-confirm">儲存</button>
    </div>
  `);
  const input = document.getElementById("rename-trip-input");
  input.focus();
  input.select();
  document.getElementById("rename-cancel").onclick = closeModal;
  document.getElementById("rename-confirm").onclick = async () => {
    const name = input.value.trim();
    if (!name) return toast("請輸入行程名稱");
    await renameTrip(name);
    closeModal();
  };
});

function renderMemberSwitchModal() {
  if (!state.trip) return;
  const members = state.trip.members || [];
  const my = myMember();
  openModal("切換身份", `
    <p style="font-size:13px;color:var(--text-muted);margin-top:0;">選擇你在「${escapeHtml(state.trip.name)}」中的身份。</p>
    <div class="member-chip-picker">
      ${members.map((m) => `
        <button class="member-pick-btn ${my && my.id === m.id ? "active" : ""}" data-id="${m.id}">
          <span>${escapeHtml(m.name)}</span>
          <span class="perm-tag">${permLabel(m.permission)}</span>
        </button>`).join("")}
    </div>
    <button class="secondary-btn full-width" id="switch-readonly-btn" style="margin-top:14px;">改用唯讀模式瀏覽（不指定身份）</button>
  `);
  document.querySelectorAll("#modal-box .member-pick-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setMyMemberId(state.tripId, btn.dataset.id);
      sessionStorage.removeItem("tp_skip_pick_" + state.tripId);
      closeModal();
      route();
    });
  });
  document.getElementById("switch-readonly-btn").addEventListener("click", () => {
    setMyMemberId(state.tripId, null);
    sessionStorage.setItem("tp_skip_pick_" + state.tripId, "1");
    closeModal();
    route();
  });
}

document.getElementById("share-btn").addEventListener("click", () => {
  renderShareTripModal();
});

async function ensureTripShareCode() {
  if (state.trip && state.trip.shareCode) return { code: state.trip.shareCode, error: null };
  const result = await createShortlink({ type: "trip", tripId: state.tripId });
  if (!result.code) return result;
  try {
    await updateDoc(doc(db, "trips", state.tripId), { shareCode: result.code });
  } catch (err) {
    console.error("[shortlinks] 寫回行程的 shareCode 失敗", err);
    // 就算存回行程資料失敗，這組代碼本身仍然有效，仍可繼續使用
  }
  return result;
}

async function renderShareTripModal() {
  openModal("分享此行程", `<p style="color:var(--text-muted);">正在產生短連結...</p>`);
  const { code, error } = await ensureTripShareCode();
  if (!code) {
    openModal("分享此行程", `
      <p style="color:var(--danger);">${shortlinkErrorMessage(error)}</p>
      <div class="form-actions"><button class="secondary-btn" id="share-close-btn">關閉</button></div>
    `);
    document.getElementById("share-close-btn").onclick = closeModal;
    return;
  }
  const link = `${window.location.origin}${window.location.pathname}#/s/${code}`;

  openModal("分享此行程", `
    <p style="font-size:13px;color:var(--text-muted);margin-top:0;">把下面的短連結或代碼傳給同行的人，他們打開連結，或在左側選單「用連結／代碼加入行程」貼上代碼，都能加入這個行程。</p>
    <div class="form-row">
      <label>短連結</label>
      <input type="text" id="share-link-input" readonly value="${escapeHtml(link)}" onclick="this.select()">
    </div>
    <button class="secondary-btn full-width" id="copy-share-link-btn">📋 複製連結</button>

    <div class="form-row" style="margin-top:14px;">
      <label>行程代碼</label>
      <input type="text" id="share-code-input" readonly value="${escapeHtml(code)}" onclick="this.select()" style="font-size:20px;letter-spacing:3px;text-align:center;font-weight:700;">
    </div>
    <button class="secondary-btn full-width" id="copy-share-code-btn">📋 複製代碼</button>

    <div class="form-actions">
      ${navigator.share ? `<button class="secondary-btn" id="native-share-btn">📤 用系統分享</button>` : ""}
      <button class="primary-btn" id="share-close-btn">完成</button>
    </div>
  `);
  document.getElementById("share-close-btn").onclick = closeModal;
  document.getElementById("copy-share-link-btn").addEventListener("click", () => copyText(link, "連結已複製"));
  document.getElementById("copy-share-code-btn").addEventListener("click", () => copyText(code, "代碼已複製"));
  const nativeBtn = document.getElementById("native-share-btn");
  if (nativeBtn) {
    nativeBtn.addEventListener("click", () => {
      navigator.share({ title: state.trip?.name || "旅行行程", url: link }).catch(() => {});
    });
  }
}

document.getElementById("appearance-btn").addEventListener("click", renderAppearanceModal);

function renderAppearanceModal() {
  const current = loadAppearance();

  openModal("外觀設定", `
    <p style="font-size:13px;color:var(--text-muted);margin-top:0;">這些設定只會套用在這台裝置／瀏覽器上，不會影響同行人看到的樣子。</p>

    <div class="form-row">
      <label>色彩主題</label>
      <div class="theme-swatch-grid" id="theme-swatch-grid">
        ${THEME_PRESETS.map((t) => `
          <button class="theme-swatch ${current.themeId === t.id ? "active" : ""}" data-theme="${t.id}">
            <span class="theme-swatch-dot" style="background:${t.primary};"></span>
            <span class="theme-swatch-label">${escapeHtml(t.name)}</span>
          </button>
        `).join("")}
      </div>
    </div>

    <div class="form-row">
      <label>字體風格</label>
      <div class="font-option-list" id="font-option-list">
        ${FONT_PRESETS.map((f) => `
          <button class="font-option-btn ${current.fontId === f.id ? "active" : ""}" data-font="${f.id}">
            <span class="font-option-preview" style="font-family:${f.heading};">旅程 Aa</span>
            <span class="font-option-name">${escapeHtml(f.name)}</span>
          </button>
        `).join("")}
      </div>
    </div>

    <div class="form-row">
      <label>文字大小</label>
      <div class="size-option-row" id="size-option-row">
        ${SIZE_PRESETS.map((s) => `
          <button class="size-option-btn ${current.sizeId === s.id ? "active" : ""}" data-size="${s.id}">${escapeHtml(s.name)}</button>
        `).join("")}
      </div>
    </div>

    <div class="form-actions">
      <button class="secondary-btn" id="appearance-reset-btn">恢復預設</button>
      <button class="primary-btn" id="appearance-close-btn">完成</button>
    </div>
  `);

  const applyAndSave = (patch) => {
    const settings = { ...loadAppearance(), ...patch };
    saveAppearance(settings);
    applyAppearance(settings);
  };

  document.querySelectorAll("#theme-swatch-grid .theme-swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyAndSave({ themeId: btn.dataset.theme });
      document.querySelectorAll("#theme-swatch-grid .theme-swatch").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });
  document.querySelectorAll("#font-option-list .font-option-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyAndSave({ fontId: btn.dataset.font });
      document.querySelectorAll("#font-option-list .font-option-btn").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });
  document.querySelectorAll("#size-option-row .size-option-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyAndSave({ sizeId: btn.dataset.size });
      document.querySelectorAll("#size-option-row .size-option-btn").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });
  document.getElementById("appearance-reset-btn").addEventListener("click", () => {
    const defaults = { themeId: "ocean", fontId: "journal", sizeId: "md" };
    saveAppearance(defaults);
    applyAppearance(defaults);
    closeModal();
    renderAppearanceModal();
  });
  document.getElementById("appearance-close-btn").onclick = closeModal;
}

document.getElementById("menu-toggle-btn").addEventListener("click", () => {
  document.getElementById("menu-overlay").classList.remove("hidden");
  document.getElementById("trip-menu").classList.remove("hidden");
});
document.getElementById("menu-close-btn").addEventListener("click", closeMenu);
document.getElementById("menu-overlay").addEventListener("click", closeMenu);
function closeMenu() {
  document.getElementById("menu-overlay").classList.add("hidden");
  document.getElementById("trip-menu").classList.add("hidden");
}

function renderTripMenu() {
  ["manage-members-menu-btn", "currency-settings-menu-btn", "background-settings-menu-btn"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });
  if (state.trip && isOwner()) {
    const mkBtn = (id, label, onClick) => {
      const btn = document.createElement("button");
      btn.id = id;
      btn.className = "secondary-btn full-width";
      btn.style.margin = "0 12px 10px";
      btn.style.width = "calc(100% - 24px)";
      btn.textContent = label;
      btn.addEventListener("click", () => { closeMenu(); onClick(); });
      document.getElementById("new-trip-btn").insertAdjacentElement("beforebegin", btn);
    };
    mkBtn("background-settings-menu-btn", "🖼️ 背景圖片設定", renderBackgroundSettingsModal);
    mkBtn("currency-settings-menu-btn", "💱 貨幣設定", renderCurrencySettingsModal);
    mkBtn("manage-members-menu-btn", "👥 管理成員與權限", renderManageMembersModal);
  }

  const list = document.getElementById("trip-list");
  const trips = getMyTrips();
  if (!trips.length) {
    list.innerHTML = `<li style="color:var(--text-muted);cursor:default;">還沒有任何行程</li>`;
  } else {
    list.innerHTML = trips.map((t) => `
      <li class="${t.id === state.tripId ? "active" : ""}" data-tripid="${t.id}">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(t.name)}</span>
        <span class="icon-btn remove-trip-btn" data-tripid="${t.id}" title="從清單移除" style="font-size:14px;">✕</span>
      </li>`).join("");
    list.querySelectorAll("li[data-tripid]").forEach((li) => {
      li.addEventListener("click", (e) => {
        if (e.target.classList.contains("remove-trip-btn")) return;
        navigate(`#/trip/${li.dataset.tripid}`);
        closeMenu();
      });
    });
    list.querySelectorAll(".remove-trip-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeMyTrip(btn.dataset.tripid);
        renderTripMenu();
      });
    });
  }
}

document.getElementById("new-trip-btn").addEventListener("click", () => {
  closeMenu();
  renderNewTripModal();
});
document.getElementById("join-trip-btn").addEventListener("click", () => {
  closeMenu();
  openModal("用連結／代碼加入行程", `
    <div class="form-row">
      <label>貼上同行人傳給你的連結，或行程代碼</label>
      <input type="text" id="join-input" placeholder="https://.../#/s/K7XPQ2 或 K7XPQ2">
    </div>
    <div class="form-actions">
      <button class="secondary-btn" id="join-cancel">取消</button>
      <button class="primary-btn" id="join-confirm">加入</button>
    </div>
  `);
  document.getElementById("join-cancel").onclick = closeModal;
  document.getElementById("join-confirm").onclick = async () => {
    const raw = document.getElementById("join-input").value.trim();
    if (!raw) return;
    closeModal();
    await handleJoinInput(raw);
  };
});

async function handleJoinInput(raw) {
  // 完整的舊版行程連結：.../#/trip/xxxxxx（也支援單純貼 Firestore 行程 ID 的舊用法）
  let m = raw.match(/trip\/([a-zA-Z0-9]+)/);
  if (m) {
    navigate(`#/trip/${m[1]}`);
    return;
  }
  // 短連結格式：.../#/s/CODE，或直接貼代碼本身
  m = raw.match(/\/s\/([a-zA-Z0-9]+)/);
  const code = (m ? m[1] : raw).toUpperCase();
  if (code.length <= 8) {
    renderLoading();
    const data = await getShortlinkData(code);
    if (data && data.type === "trip" && data.tripId) {
      navigate(`#/trip/${data.tripId}`);
      return;
    }
    toast("找不到這組代碼，請確認輸入正確，或改貼完整連結");
    navigate("");
    return;
  }
  // 長度看起來不像短代碼，當作行程 ID 直接嘗試
  navigate(`#/trip/${raw}`);
}

// ------------------------------------------------------------
// 短代碼／短連結（shortlinks 集合）
// 用一組 6 碼英數字代碼取代原本又長又難輸入的行程 ID／同步資料，
// 存一份對照資料在 Firestore 的 shortlinks/{code}，任何人都能用代碼查（get），
// 但無法列出所有代碼、也無法竄改或刪除已存在的代碼（見 README 的安全規則）。
// ------------------------------------------------------------
const SHORT_CODE_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 排除容易看錯的 0/O/1/I/L
function genShortCode(len = 6) {
  let s = "";
  for (let i = 0; i < len; i++) s += SHORT_CODE_CHARS[Math.floor(Math.random() * SHORT_CODE_CHARS.length)];
  return s;
}
async function createShortlink(data, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    const code = genShortCode();
    try {
      await setDoc(doc(db, "shortlinks", code), { ...data, createdAt: serverTimestamp() });
      return { code, error: null };
    } catch (err) {
      console.error("[shortlinks] 建立代碼失敗", err);
      // 權限被拒（Firestore 規則沒開放）不管重試幾次結果都一樣，直接回報，不要浪費時間重試
      if (err && err.code === "permission-denied") {
        return { code: null, error: "permission-denied" };
      }
      // 其他錯誤（例如剛好撞到別人已經用過的代碼，極少見）就重新抽一組再試
    }
  }
  return { code: null, error: "unknown" };
}
async function getShortlinkData(code) {
  try {
    const snap = await getDoc(doc(db, "shortlinks", String(code).trim().toUpperCase()));
    if (!snap.exists()) return null;
    return snap.data();
  } catch (err) {
    console.error("[shortlinks] 查詢代碼失敗", err);
    return null;
  }
}
function shortlinkErrorMessage(error) {
  if (error === "permission-denied") {
    return "連結產生失敗：Firestore 安全規則可能還沒加上 shortlinks 那段設定。請到 Firebase 主控台 → Firestore Database → 規則分頁，確認內容包含 shortlinks 集合的規則（見 README「Part 3：設定 Firestore 安全規則」），改好後記得按「發布」，再回來試一次。";
  }
  return "連結產生失敗，請確認網路連線後再試一次。（可以打開瀏覽器開發者工具的 Console 分頁，看看有沒有更詳細的錯誤訊息）";
}
function copyText(text, successMsg) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast(successMsg));
  } else {
    toast("請手動複製");
  }
}

// ------------------------------------------------------------
// 跨裝置同步「我的行程」清單
// 因為沒有帳號登入，這份清單只存在單一瀏覽器裡。
// 這個功能讓使用者把清單打包成一組短代碼／短連結，帶到另一台裝置匯入。
// ------------------------------------------------------------
function encodeSyncCode(list) {
  return btoa(encodeURIComponent(JSON.stringify(list)));
}
function decodeSyncCode(code) {
  return JSON.parse(decodeURIComponent(atob(code)));
}

function applyIncomingTripList(list) {
  const existing = getMyTrips();
  const existingIds = new Set(existing.map((t) => t.id));
  let addedCount = 0;
  list.forEach((t) => {
    if (t && t.id && t.name && !existingIds.has(t.id)) {
      existing.push({ id: t.id, name: t.name });
      existingIds.add(t.id);
      addedCount++;
    }
  });
  localStorage.setItem(LS_MY_TRIPS, JSON.stringify(existing.slice(0, 30)));
  toast(addedCount ? `已匯入 ${addedCount} 個行程到這台裝置` : "這台裝置的清單已經是最新的了");
  navigate("");
}

async function importSyncCode(rawCode) {
  // 相容舊版連結：舊連結會把整份清單直接編碼在網址裡
  try {
    const legacy = decodeSyncCode(rawCode);
    if (Array.isArray(legacy)) {
      applyIncomingTripList(legacy);
      return;
    }
  } catch {
    // 不是舊格式，當作新版的 Firestore 短代碼繼續查詢
  }
  renderLoading();
  const data = await getShortlinkData(rawCode);
  if (!data || data.type !== "sync" || !Array.isArray(data.list)) {
    toast("同步代碼無效或已失效，請確認複製完整");
    navigate("");
    return;
  }
  applyIncomingTripList(data.list);
}

document.getElementById("sync-devices-btn").addEventListener("click", () => {
  closeMenu();
  renderSyncDevicesModal();
});

async function renderSyncDevicesModal() {
  const trips = getMyTrips();
  openModal("跨裝置同步清單", `<p style="color:var(--text-muted);">正在產生同步代碼...</p>`);
  const { code, error } = await createShortlink({ type: "sync", list: trips });
  if (!code) {
    openModal("跨裝置同步清單", `
      <p style="color:var(--danger);">${shortlinkErrorMessage(error)}</p>
      <div class="form-actions"><button class="secondary-btn" id="sync-close-btn">關閉</button></div>
    `);
    document.getElementById("sync-close-btn").onclick = closeModal;
    return;
  }
  const link = `${window.location.origin}${window.location.pathname}#/import/${code}`;

  openModal("跨裝置同步清單", `
    <p style="font-size:13px;color:var(--text-muted);margin-top:0;">
      在這台裝置上，把下面的短連結或代碼傳給你自己（例如用 LINE「傳給自己」），在另一台裝置打開連結、或在下方貼上代碼匯入，就能把目前的 ${trips.length} 個行程一次加進那台裝置的清單。
    </p>
    <div class="form-row">
      <label>同步連結</label>
      <input type="text" id="sync-link" readonly value="${escapeHtml(link)}" onclick="this.select()">
    </div>
    <button class="secondary-btn full-width" id="copy-sync-link-btn">📋 複製連結</button>

    <div class="form-row" style="margin-top:14px;">
      <label>同步代碼</label>
      <input type="text" id="sync-code" readonly value="${escapeHtml(code)}" onclick="this.select()" style="font-size:20px;letter-spacing:3px;text-align:center;font-weight:700;">
    </div>
    <button class="secondary-btn full-width" id="copy-sync-code-btn">📋 複製代碼</button>

    <div style="margin:20px 0 12px;border-top:1px dashed var(--border);"></div>

    <p style="font-size:13px;color:var(--text-muted);">或者，如果你手上已經有別台裝置給你的同步連結或代碼，貼在這裡匯入：</p>
    <div class="form-row" style="display:flex;gap:8px;">
      <input type="text" id="import-code-input" placeholder="貼上同步連結或代碼" style="flex:1;">
      <button class="primary-btn" id="import-code-btn">匯入</button>
    </div>
    <div class="form-actions">
      <button class="secondary-btn" id="sync-close-btn">關閉</button>
    </div>
  `);
  document.getElementById("sync-close-btn").onclick = closeModal;
  document.getElementById("copy-sync-link-btn").addEventListener("click", () => copyText(link, "連結已複製"));
  document.getElementById("copy-sync-code-btn").addEventListener("click", () => copyText(code, "代碼已複製"));
  document.getElementById("import-code-btn").addEventListener("click", () => {
    const raw = document.getElementById("import-code-input").value.trim();
    if (!raw) return;
    let inputCode = raw;
    const m = raw.match(/import\/([^/?#]+)/);
    if (m) inputCode = decodeURIComponent(m[1]);
    closeModal();
    importSyncCode(inputCode);
  });
}

// ------------------------------------------------------------
// 歡迎頁（尚未選擇行程）
// ------------------------------------------------------------
function renderWelcome() {
  const root = document.getElementById("app-root");
  const trips = getMyTrips();
  root.innerHTML = `
    <div class="card" style="text-align:center;padding:36px 20px;">
      <h2 style="margin-top:0;">✈️ 旅行行程規劃工具</h2>
      <p style="color:var(--text-muted);">建立一個新行程，或從左上角選單切換到你之前建立/加入過的行程。</p>
      <button id="welcome-new-trip" class="primary-btn" style="margin-top:10px;">＋ 建立新行程</button>
    </div>
    ${trips.length ? `
      <div class="section-title">你最近的行程</div>
      ${trips.map((t) => `<div class="card spot-item" data-tripid="${t.id}"><span class="spot-title">${escapeHtml(t.name)}</span><span>›</span></div>`).join("")}
    ` : ""}
  `;
  document.getElementById("welcome-new-trip").addEventListener("click", renderNewTripModal);
  root.querySelectorAll("[data-tripid]").forEach((el) => {
    el.addEventListener("click", () => navigate(`#/trip/${el.dataset.tripid}`));
  });
}

function renderLoading() {
  document.getElementById("app-root").innerHTML = `<div id="loading-screen"><p>載入中...</p></div>`;
}

// ------------------------------------------------------------
// 建立新行程 Modal（含動態成員名單）
// ------------------------------------------------------------
function renderNewTripModal() {
  let members = [
    { localId: "m1", name: "", permission: "owner" },
    { localId: "m2", name: "", permission: "editor" },
  ];

  function rowHtml(m, idx) {
    return `
      <div class="block-editor-row" data-row="${m.localId}">
        <input type="text" placeholder="成員姓名 / 暱稱" value="${escapeHtml(m.name)}" data-field="name" data-row="${m.localId}" style="flex:1;min-width:120px;padding:8px;border:1px solid var(--border);border-radius:8px;">
        <select data-field="permission" data-row="${m.localId}" style="padding:8px;border:1px solid var(--border);border-radius:8px;">
          <option value="owner" ${m.permission === "owner" ? "selected" : ""}>統籌人（可編輯+管理成員）</option>
          <option value="editor" ${m.permission === "editor" ? "selected" : ""}>可編輯行程</option>
          <option value="viewer" ${m.permission === "viewer" ? "selected" : ""}>僅可瀏覽</option>
        </select>
        <button class="icon-btn remove-member-row" data-row="${m.localId}" ${members.length <= 1 ? "disabled" : ""}>✕</button>
      </div>`;
  }

  function renderRows() {
    const wrap = document.getElementById("new-trip-members");
    wrap.innerHTML = members.map(rowHtml).join("");
    wrap.querySelectorAll("input[data-field=name]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const m = members.find((x) => x.localId === inp.dataset.row);
        m.name = inp.value;
      });
    });
    wrap.querySelectorAll("select[data-field=permission]").forEach((sel) => {
      sel.addEventListener("change", () => {
        const m = members.find((x) => x.localId === sel.dataset.row);
        m.permission = sel.value;
      });
    });
    wrap.querySelectorAll(".remove-member-row").forEach((btn) => {
      btn.addEventListener("click", () => {
        members = members.filter((x) => x.localId !== btn.dataset.row);
        renderRows();
      });
    });
  }

  openModal("建立新行程", `
    <div class="form-row">
      <label>行程名稱</label>
      <input type="text" id="new-trip-name" placeholder="例如：東京六日遊">
    </div>
    <div class="form-row">
      <label>同行成員與權限（之後隨時可以在「管理成員」調整）</label>
      <div id="new-trip-members"></div>
      <button class="secondary-btn small-btn" id="add-member-row-btn" style="margin-top:4px;">＋ 新增成員</button>
    </div>
    <div class="form-actions">
      <button class="secondary-btn" id="new-trip-cancel">取消</button>
      <button class="primary-btn" id="new-trip-confirm">建立行程</button>
    </div>
  `);
  renderRows();
  document.getElementById("add-member-row-btn").addEventListener("click", () => {
    members.push({ localId: "m" + (members.length + 1) + "_" + Date.now(), name: "", permission: "editor" });
    renderRows();
  });
  document.getElementById("new-trip-cancel").onclick = closeModal;
  document.getElementById("new-trip-confirm").onclick = async () => {
    const name = document.getElementById("new-trip-name").value.trim();
    const validMembers = members.filter((m) => m.name.trim());
    if (!name) return toast("請輸入行程名稱");
    if (!validMembers.length) return toast("至少要有一位成員");
    const finalMembers = validMembers.map((m) => ({ id: newLocalId(), name: m.name.trim(), permission: m.permission }));
    closeModal();
    renderLoading();
    const tripId = await createTrip(name, finalMembers);
    navigate(`#/trip/${tripId}`);
  };
}

// ------------------------------------------------------------
// 選擇「我是誰」
// ------------------------------------------------------------
function renderMemberPicker() {
  const root = document.getElementById("app-root");
  const members = state.trip.members || [];
  root.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0;">你是「${escapeHtml(state.trip.name)}」的哪一位？</h3>
      <p style="color:var(--text-muted);font-size:13px;">點選你的名字，這個瀏覽器之後就會記得你的身份。請不要選錯別人的名字喔！</p>
      <div class="member-chip-picker">
        ${members.map((m) => `
          <button class="member-pick-btn" data-id="${m.id}">
            <span>${escapeHtml(m.name)}</span>
            <span class="perm-tag">${permLabel(m.permission)}</span>
          </button>`).join("")}
      </div>
      <button class="secondary-btn full-width" id="skip-pick-btn" style="margin-top:14px;">先用唯讀模式瀏覽（不選身份）</button>
    </div>
  `;
  root.querySelectorAll(".member-pick-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setMyMemberId(state.tripId, btn.dataset.id);
      route();
    });
  });
  document.getElementById("skip-pick-btn").addEventListener("click", () => {
    sessionStorage.setItem("tp_skip_pick_" + state.tripId, "1");
    route();
  });
}
function permLabel(p) {
  if (p === "owner") return "統籌人";
  if (p === "editor") return "可編輯";
  return "唯讀";
}


// ------------------------------------------------------------
// 行程主頁（頂端 行程/記帳 分頁 + 天數 tabs + 當日內容）
// ------------------------------------------------------------
function renderTripHome() {
  const root = document.getElementById("app-root");
  const day = state.days.find((d) => d.id === state.currentDayId);

  root.innerHTML = `
    <div class="tabs">
      <button class="tab-btn ${state.tripSection === "itinerary" ? "active" : ""}" id="tab-itinerary">📅 行程</button>
      <button class="tab-btn ${state.tripSection === "expenses" ? "active" : ""}" id="tab-expenses">💰 記帳與分帳</button>
    </div>
    <div class="readonly-banner" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;"><span>目前裝置 UID：<code id="current-device-uid" style="word-break:break-all;">${escapeHtml(currentUid() || "尚未取得")}</code></span><button class="secondary-btn small-btn" id="copy-device-uid-btn">複製 UID</button></div>
    ${isLegacyTrip() ? `<div class="readonly-banner" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;"><span>這是舊版行程資料，目前尚未綁定新的身份權限。</span><button class="secondary-btn small-btn" id="claim-legacy-trip-btn">我是原統籌人，進行資料銜接</button></div>` : (!canEditItinerary() ? `<div class="readonly-banner" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;"><span>你目前是唯讀身份，可以瀏覽行程、許願池留言與記帳，但無法新增或編輯行程內容。</span><button class="secondary-btn small-btn" id="request-edit-access-btn">申請編輯權限</button></div>` : "")}
    <div id="day-selector-wrap"></div>
    <div id="day-content"></div>
  `;

  const copyUidBtn = document.getElementById("copy-device-uid-btn");
  if (copyUidBtn) {
    copyUidBtn.onclick = async () => {
      const uid = currentUid();
      if (!uid) return toast("目前尚未取得 Firebase UID");
      try {
        await navigator.clipboard.writeText(uid);
        toast("UID 已複製");
      } catch (err) {
        console.error(err);
        toast("無法自動複製，請長按或手動選取 UID");
      }
    };
  }

  const claimBtn = document.getElementById("claim-legacy-trip-btn");
  if (claimBtn) {
    claimBtn.onclick = async () => {
      if (!confirm("請確認你是這個舊行程原本的統籌人。確認後，此行程會綁定目前瀏覽器的匿名身份。")) return;
      try {
        claimBtn.disabled = true;
        await claimLegacyTrip();
      } catch (err) {
        console.error(err);
        toast("資料銜接失敗，請先確認 Firebase 規則仍允許舊資料遷移");
      }
    };
  }
  const requestBtn = document.getElementById("request-edit-access-btn");
  if (requestBtn) {
    requestBtn.onclick = async () => {
      try {
        requestBtn.disabled = true;
        await createEditAccessRequest();
      } catch (err) {
        console.error(err);
        toast("申請送出失敗，請確認 Firebase 規則已更新");
        requestBtn.disabled = false;
      }
    };
  }

  document.getElementById("tab-itinerary").onclick = () => navigate(`#/trip/${state.tripId}${state.currentDayId ? "/day/" + state.currentDayId : ""}`);
  document.getElementById("tab-expenses").onclick = () => navigate(`#/trip/${state.tripId}/expenses`);

  renderDaySelector(document.getElementById("day-selector-wrap"), day);

  const contentEl = document.getElementById("day-content");
  if (!day) {
    contentEl.innerHTML = `<div class="empty-hint">${canEditItinerary() ? "還沒有任何天數，點上方「＋ 新增天數」開始規劃吧！" : "行程統籌人還沒有新增任何天數。"}</div>`;
    return;
  }

  contentEl.innerHTML = `
    <div class="card" id="day-header-card">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-weight:700;font-size:16px;">${escapeHtml(day.title)}</div>
          ${day.date ? `<div style="color:var(--text-muted);font-size:13px;margin-top:2px;">${escapeHtml(day.date)}</div>` : ""}
        </div>
        ${canEditItinerary() ? `
          <div style="display:flex;gap:6px;">
            <button class="secondary-btn small-btn" id="edit-day-meta-btn">編輯</button>
            <button class="danger-btn small-btn" id="delete-day-btn">刪除本日</button>
          </div>` : ""}
      </div>
      <div id="day-blocks" style="margin-top:12px;"></div>
    </div>
    <div class="section-title">時段 / 景點</div>
    <div id="spot-list"></div>
    ${canEditItinerary() ? `<button class="primary-btn full-width" id="add-spot-btn">＋ 新增時段／景點</button>` : ""}
  `;

  renderContentBlocks(document.getElementById("day-blocks"), day.blocks || [], {
    editable: canEditItinerary(),
    onChange: (blocks) => updateDayBlocks(day.id, blocks),
  });

  if (canEditItinerary()) {
    document.getElementById("edit-day-meta-btn").addEventListener("click", () => renderEditDayMetaModal(day));
    document.getElementById("delete-day-btn").addEventListener("click", () => {
      openConfirm(`確定要刪除「${day.title}」整天的行程嗎？裡面的景點也會一併刪除。`, async () => {
        await deleteDay(day.id);
        state.currentDayId = null;
        navigate(`#/trip/${state.tripId}`);
        toast("已刪除");
      });
    });
    document.getElementById("add-spot-btn").addEventListener("click", () => renderAddSpotModal(day.id));
  }

  const spotListEl = document.getElementById("spot-list");
  const canEdit = canEditItinerary();
  if (!state.spots.length) {
    spotListEl.innerHTML = `<div class="empty-hint">這天還沒有安排景點</div>`;
  } else {
    spotListEl.innerHTML = state.spots.map((s, i) => `
      <div class="spot-item" data-spotid="${s.id}">
        ${canEdit ? `
          <div class="reorder-col">
            <button class="reorder-btn" data-move="up" data-idx="${i}" ${i === 0 ? "disabled" : ""}>▲</button>
            <button class="reorder-btn" data-move="down" data-idx="${i}" ${i === state.spots.length - 1 ? "disabled" : ""}>▼</button>
          </div>
        ` : ""}
        <div class="spot-time">${escapeHtml(s.time || "")}</div>
        <div class="spot-title" data-nav="${s.id}">${escapeHtml(s.title)}</div>
        <div data-nav="${s.id}">›</div>
      </div>`).join("");
    spotListEl.querySelectorAll("[data-nav]").forEach((el) => {
      el.addEventListener("click", () => {
        navigate(`#/trip/${state.tripId}/day/${day.id}/spot/${el.dataset.nav}`);
      });
    });
    spotListEl.querySelectorAll(".reorder-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = Number(btn.dataset.idx);
        moveSpot(day.id, idx, btn.dataset.move === "up" ? -1 : 1);
      });
    });
  }
}

function dayIndexLabel(dayId) {
  const idx = state.days.findIndex((d) => d.id === dayId);
  return idx >= 0 ? idx + 1 : "?";
}

function renderDaySelector(container, day) {
  if (!state.days.length) {
    container.innerHTML = canEditItinerary()
      ? `<button class="day-selector-btn" id="day-selector-add-btn"><span class="day-selector-title">＋ 新增天數</span></button>`
      : "";
    const addBtn = document.getElementById("day-selector-add-btn");
    if (addBtn) addBtn.addEventListener("click", renderAddDayModal);
    return;
  }
  container.innerHTML = `
    <button class="day-selector-btn" id="day-selector-btn">
      <span class="day-selector-num">Day ${dayIndexLabel(state.currentDayId)}</span>
      <span class="day-selector-title">${day ? escapeHtml(day.title) : "選擇天數"}</span>
      ${day && day.date ? `<span class="day-selector-date">${escapeHtml(day.date)}</span>` : ""}
      <span class="day-selector-chevron">▾</span>
    </button>
  `;
  document.getElementById("day-selector-btn").addEventListener("click", renderDaySelectSheet);
}

function renderDaySelectSheet() {
  const canEdit = canEditItinerary();
  openModal("選擇天數", `
    <div class="day-select-list">
      ${state.days.map((d, i) => `
        <div class="day-select-item ${d.id === state.currentDayId ? "active" : ""}" data-dayid="${d.id}">
          ${canEdit ? `
            <div class="reorder-col">
              <button class="reorder-btn" data-move="up" data-idx="${i}" ${i === 0 ? "disabled" : ""}>▲</button>
              <button class="reorder-btn" data-move="down" data-idx="${i}" ${i === state.days.length - 1 ? "disabled" : ""}>▼</button>
            </div>
          ` : ""}
          <span class="day-select-num" data-nav="${d.id}">${i + 1}</span>
          <span class="day-select-text" data-nav="${d.id}">
            <span class="day-select-title">${escapeHtml(d.title)}</span>
            ${d.date ? `<span class="day-select-date">${escapeHtml(d.date)}</span>` : ""}
          </span>
        </div>
      `).join("")}
    </div>
    ${canEdit ? `<button class="secondary-btn full-width" id="sheet-add-day-btn" style="margin-top:10px;">＋ 新增天數</button>` : ""}
  `);
  document.querySelectorAll("#modal-box [data-nav]").forEach((el) => {
    el.addEventListener("click", () => {
      closeModal();
      selectDay(el.dataset.nav);
    });
  });
  document.querySelectorAll("#modal-box .reorder-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.idx);
      moveDay(idx, btn.dataset.move === "up" ? -1 : 1);
    });
  });
  const addBtn = document.getElementById("sheet-add-day-btn");
  if (addBtn) addBtn.addEventListener("click", () => { closeModal(); renderAddDayModal(); });
}

function openConfirm(message, onConfirm) {
  openModal("請確認", `
    <p>${escapeHtml(message)}</p>
    <div class="form-actions">
      <button class="secondary-btn" id="confirm-cancel">取消</button>
      <button class="danger-btn" id="confirm-ok">確定刪除</button>
    </div>
  `);
  document.getElementById("confirm-cancel").onclick = closeModal;
  document.getElementById("confirm-ok").onclick = async () => {
    closeModal();
    await onConfirm();
  };
}

function renderAddDayModal() {
  openModal("新增天數", `
    <div class="form-row"><label>標題</label><input type="text" id="day-title" placeholder="例如：Day 1 抵達 &amp; 市區觀光"></div>
    <div class="form-row"><label>日期（選填）</label><input type="date" id="day-date"></div>
    <div class="form-actions">
      <button class="secondary-btn" id="day-cancel">取消</button>
      <button class="primary-btn" id="day-confirm">新增</button>
    </div>
  `);
  document.getElementById("day-cancel").onclick = closeModal;
  document.getElementById("day-confirm").onclick = async () => {
    const title = document.getElementById("day-title").value.trim();
    const date = document.getElementById("day-date").value;
    if (!title) return toast("請輸入標題");
    closeModal();
    const id = await createDay(title, date);
    navigate(`#/trip/${state.tripId}/day/${id}`);
  };
}

function renderEditDayMetaModal(day) {
  openModal("編輯本日資訊", `
    <div class="form-row"><label>標題</label><input type="text" id="day-title" value="${escapeHtml(day.title)}"></div>
    <div class="form-row"><label>日期</label><input type="date" id="day-date" value="${escapeHtml(day.date || "")}"></div>
    <div class="form-actions">
      <button class="secondary-btn" id="day-cancel">取消</button>
      <button class="primary-btn" id="day-confirm">儲存</button>
    </div>
  `);
  document.getElementById("day-cancel").onclick = closeModal;
  document.getElementById("day-confirm").onclick = async () => {
    const title = document.getElementById("day-title").value.trim();
    const date = document.getElementById("day-date").value;
    if (!title) return toast("請輸入標題");
    await updateDayMeta(day.id, { title, date });
    closeModal();
  };
}

function renderAddSpotModal(dayId) {
  openModal("新增時段／景點", `
    <div class="form-row"><label>景點／活動名稱</label><input type="text" id="spot-title" placeholder="例如：淺草寺"></div>
    <div class="form-row"><label>時間（選填）</label><input type="time" id="spot-time"></div>
    <div class="form-actions">
      <button class="secondary-btn" id="spot-cancel">取消</button>
      <button class="primary-btn" id="spot-confirm">新增</button>
    </div>
  `);
  document.getElementById("spot-cancel").onclick = closeModal;
  document.getElementById("spot-confirm").onclick = async () => {
    const title = document.getElementById("spot-title").value.trim();
    const time = document.getElementById("spot-time").value;
    if (!title) return toast("請輸入名稱");
    closeModal();
    await createSpot(dayId, title, time);
  };
}


// ------------------------------------------------------------
// 內容區塊（文字 / 圖片 / 表格）— 母頁、子頁通用
// ------------------------------------------------------------
function renderBlockView(block) {
  if (block.type === "text") {
    return `<div class="block-text">${escapeHtml(block.content)}</div>`;
  }
  if (block.type === "image") {
    return `<figure class="block-image"><img src="${escapeHtml(block.url)}" alt="${escapeHtml(block.caption || "")}" loading="lazy">${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ""}</figure>`;
  }
  if (block.type === "table") {
    const rows = block.rows || [];
    return `<div class="block-table"><table>${rows.map((row, ri) => `<tr>${row.map((c) => ri === 0 ? `<th>${escapeHtml(c)}</th>` : `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</table></div>`;
  }
  return "";
}

function renderContentBlocks(container, blocks, { editable, onChange }) {
  const list = blocks || [];
  container.innerHTML = `
    <div id="blocks-render"></div>
    ${editable ? `
      <div class="block-editor-row">
        <button class="secondary-btn small-btn" data-add="text">＋ 文字</button>
        <button class="secondary-btn small-btn" data-add="image">＋ 圖片連結</button>
        <button class="secondary-btn small-btn" data-add="table">＋ 表格</button>
      </div>` : ""}
  `;
  const renderEl = container.querySelector("#blocks-render");
  if (!list.length) {
    renderEl.innerHTML = editable ? "" : `<div class="empty-hint" style="padding:10px 0;">尚無內容</div>`;
  } else {
    renderEl.innerHTML = list.map((b, i) => `
      <div class="content-block" data-idx="${i}">
        ${renderBlockView(b)}
        ${editable ? `
          <div class="block-controls">
            <button class="secondary-btn small-btn" data-act="up" data-idx="${i}" ${i === 0 ? "disabled" : ""}>↑</button>
            <button class="secondary-btn small-btn" data-act="down" data-idx="${i}" ${i === list.length - 1 ? "disabled" : ""}>↓</button>
            <button class="secondary-btn small-btn" data-act="edit" data-idx="${i}">編輯</button>
            <button class="danger-btn small-btn" data-act="del" data-idx="${i}">刪除</button>
          </div>` : ""}
      </div>
    `).join("");
  }

  if (!editable) return;

  container.querySelectorAll("[data-add]").forEach((btn) => {
    btn.addEventListener("click", () => renderBlockEditModal(btn.dataset.add, null, (newBlock) => {
      onChange([...(blocks || []), newBlock]);
    }));
  });
  renderEl.querySelectorAll("[data-act]").forEach((btn) => {
    const idx = Number(btn.dataset.idx);
    btn.addEventListener("click", () => {
      const arr = [...list];
      if (btn.dataset.act === "up" && idx > 0) {
        [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
        onChange(arr);
      } else if (btn.dataset.act === "down" && idx < arr.length - 1) {
        [arr[idx + 1], arr[idx]] = [arr[idx], arr[idx + 1]];
        onChange(arr);
      } else if (btn.dataset.act === "del") {
        arr.splice(idx, 1);
        onChange(arr);
      } else if (btn.dataset.act === "edit") {
        renderBlockEditModal(arr[idx].type, arr[idx], (updated) => {
          arr[idx] = updated;
          onChange(arr);
        });
      }
    });
  });
}

function renderBlockEditModal(type, existing, onSave) {
  let bodyHtml = "";
  if (type === "text") {
    bodyHtml = `<div class="form-row"><textarea id="blk-text" placeholder="輸入文字說明...">${escapeHtml(existing?.content || "")}</textarea></div>`;
  } else if (type === "image") {
    bodyHtml = `
      <div class="form-row"><label>圖片網址</label><input type="text" id="blk-url" placeholder="https://..." value="${escapeHtml(existing?.url || "")}"></div>
      <div class="form-row"><label>圖片說明（選填）</label><input type="text" id="blk-caption" value="${escapeHtml(existing?.caption || "")}"></div>
      ${existing?.url ? `<img src="${escapeHtml(existing.url)}" style="max-width:100%;border-radius:8px;margin-bottom:8px;">` : ""}
    `;
  } else if (type === "table") {
    const rows = existing?.rows || [["欄位1", "欄位2"], ["", ""]];
    bodyHtml = `
      <div class="form-row">
        <label>表格內容（第一列為標題列）</label>
        <div id="table-editor"></div>
        <div style="display:flex;gap:6px;margin-top:6px;">
          <button class="secondary-btn small-btn" id="add-row-btn">＋ 新增列</button>
          <button class="secondary-btn small-btn" id="add-col-btn">＋ 新增欄</button>
        </div>
      </div>
    `;
    // 用閉包保存 rows 供下方渲染使用
    window.__tmpTableRows = rows.map((r) => [...r]);
  }

  openModal(existing ? "編輯區塊" : "新增區塊", `
    ${bodyHtml}
    <div class="form-actions">
      <button class="secondary-btn" id="blk-cancel">取消</button>
      <button class="primary-btn" id="blk-save">儲存</button>
    </div>
  `);

  if (type === "table") {
    const renderTableEditor = () => {
      const rows = window.__tmpTableRows;
      const editorEl = document.getElementById("table-editor");
      editorEl.innerHTML = `<table style="border-collapse:collapse;width:100%;">${rows.map((row, ri) => `
        <tr>${row.map((cell, ci) => `<td style="border:1px solid var(--border);padding:2px;"><input type="text" data-r="${ri}" data-c="${ci}" value="${escapeHtml(cell)}" style="width:100%;border:none;padding:6px;font-size:13px;"></td>`).join("")}
        <td><button class="icon-btn del-row-btn" data-r="${ri}" style="font-size:13px;">✕</button></td></tr>
      `).join("")}</table>`;
      editorEl.querySelectorAll("input").forEach((inp) => {
        inp.addEventListener("input", () => {
          rows[Number(inp.dataset.r)][Number(inp.dataset.c)] = inp.value;
        });
      });
      editorEl.querySelectorAll(".del-row-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (rows.length <= 1) return;
          rows.splice(Number(btn.dataset.r), 1);
          renderTableEditor();
        });
      });
    };
    renderTableEditor();
    document.getElementById("add-row-btn").addEventListener("click", () => {
      const cols = window.__tmpTableRows[0]?.length || 2;
      window.__tmpTableRows.push(new Array(cols).fill(""));
      renderTableEditor();
    });
    document.getElementById("add-col-btn").addEventListener("click", () => {
      window.__tmpTableRows.forEach((r) => r.push(""));
      renderTableEditor();
    });
  }

  document.getElementById("blk-cancel").onclick = closeModal;
  document.getElementById("blk-save").onclick = () => {
    let block;
    if (type === "text") {
      const content = document.getElementById("blk-text").value.trim();
      if (!content) return toast("請輸入文字內容");
      block = { type: "text", content };
    } else if (type === "image") {
      const url = document.getElementById("blk-url").value.trim();
      const caption = document.getElementById("blk-caption").value.trim();
      if (!url) return toast("請輸入圖片網址");
      block = { type: "image", url, caption };
    } else if (type === "table") {
      block = { type: "table", rows: window.__tmpTableRows.map((r) => [...r]) };
      delete window.__tmpTableRows;
    }
    closeModal();
    onSave(block);
  };
}


// ------------------------------------------------------------
// 景點詳細頁（含許願池）
// ------------------------------------------------------------
function renderSpotPage() {
  if (!state.currentSpot) return;
  const root = document.getElementById("spot-panel-content");
  const day = state.days.find((d) => d.id === state.currentDayId) || { title: "" };
  const spot = state.currentSpot;
  const canEdit = canEditItinerary();

  document.getElementById("spot-panel-header-title").textContent = spot.title;

  root.innerHTML = `
    <div class="breadcrumb">${escapeHtml(day.title)} › ${escapeHtml(spot.title)}</div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-weight:700;font-size:17px;">${escapeHtml(spot.title)}</div>
          ${spot.time ? `<div style="color:var(--text-muted);font-size:13px;margin-top:2px;">🕒 ${escapeHtml(spot.time)}</div>` : ""}
        </div>
        ${canEdit ? `
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
            <button class="secondary-btn small-btn" id="edit-spot-meta-btn">編輯</button>
            <button class="secondary-btn small-btn" id="copy-spot-meta-btn">📋 複製</button>
            <button class="secondary-btn small-btn" id="move-spot-meta-btn">🚚 搬移</button>
            <button class="danger-btn small-btn" id="delete-spot-btn">刪除</button>
          </div>` : ""}
      </div>
      ${(() => {
        const href = resolveMapHref(spot.mapUrl, null, spot.title);
        return href ? `<a class="secondary-btn small-btn" href="${escapeHtml(href)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:4px;margin-top:10px;text-decoration:none;">📍 在 Google 地圖上查看</a>` : "";
      })()}
      <div id="spot-blocks" style="margin-top:12px;"></div>
    </div>

    <div class="section-title">💭 許願池</div>
    <div class="card">
      <p style="color:var(--text-muted);font-size:13px;margin-top:0;">大家都可以在這裡留言，寫下想去的地方、想吃的東西，也可以貼圖片連結分享照片（不限權限）</p>
      <div class="form-row" style="display:flex;flex-direction:column;gap:6px;">
        <div style="display:flex;gap:8px;">
          <input type="text" id="wish-input" placeholder="想去...想吃..." style="flex:1;">
          <button class="secondary-btn small-btn" id="wish-img-toggle" title="附上圖片連結">🖼️</button>
          <button class="secondary-btn small-btn" id="wish-map-toggle" title="附上地標">📍 地標</button>
          <button class="primary-btn" id="wish-submit">送出</button>
        </div>
        <input type="text" id="wish-image-input" placeholder="圖片網址（選填，貼上圖片連結）" style="display:none;">
        <div id="wish-map-fields" style="display:none;flex-direction:column;gap:6px;">
          <input type="text" id="wish-map-link-input" placeholder="Google 地圖連結（例如 https://maps.app.goo.gl/3yRm2VmBV6d4LFRN8）">
          <input type="text" id="wish-map-address-input" placeholder="地址／地點（沒填連結的話，會用這個關鍵字搜尋）">
        </div>
      </div>
      <div id="wish-list"></div>
    </div>
  `;

  renderContentBlocks(document.getElementById("spot-blocks"), spot.blocks || [], {
    editable: canEdit,
    onChange: (blocks) => updateSpotBlocks(day.id, spot.id, blocks),
  });

  if (canEdit) {
    document.getElementById("edit-spot-meta-btn").addEventListener("click", () => renderEditSpotMetaModal(day.id, spot));
    document.getElementById("copy-spot-meta-btn").addEventListener("click", () => renderSpotDayPickerModal(day.id, spot, "copy"));
    document.getElementById("move-spot-meta-btn").addEventListener("click", () => renderSpotDayPickerModal(day.id, spot, "move"));
    document.getElementById("delete-spot-btn").addEventListener("click", () => {
      openConfirm(`確定要刪除「${spot.title}」嗎？`, async () => {
        await deleteSpot(day.id, spot.id);
        closeSpotPanel();
        toast("已刪除");
      });
    });
  }

  const wishListEl = document.getElementById("wish-list");
  if (!state.wishes.length) {
    wishListEl.innerHTML = `<div class="empty-hint">還沒有人許願，第一個留言看看吧！</div>`;
  } else {
    const my = myMember();
    wishListEl.innerHTML = state.wishes.map((w) => {
      const mapHref = resolveMapHref(w.mapUrl, w.mapAddress, null);
      return `
      <div class="wish-item" data-wishid="${w.id}">
        <div class="wish-author">${escapeHtml(w.authorName)}</div>
        ${w.text ? `<div class="wish-text">${escapeHtml(w.text)}</div>` : ""}
        ${w.imageUrl ? `<div class="wish-image"><img src="${escapeHtml(w.imageUrl)}" alt="" loading="lazy"></div>` : ""}
        ${mapHref ? `<div class="wish-image"><a href="${escapeHtml(mapHref)}" target="_blank" rel="noopener" style="color:var(--accent);font-size:13px;text-decoration:none;">📍 在 Google 地圖上查看</a></div>` : ""}
        <div class="wish-time">${fmtDateTime(w.createdAt)}
          ${(my && (w.authorId === my.id || isOwner())) ? `<span class="edit-wish-btn" data-wishid="${w.id}" style="color:var(--accent);cursor:pointer;margin-left:8px;">編輯</span><span class="del-wish-btn" data-wishid="${w.id}" style="color:var(--danger);cursor:pointer;margin-left:8px;">刪除</span>` : ""}
        </div>
      </div>
    `;
    }).join("");
    wishListEl.querySelectorAll(".del-wish-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        openConfirm("確定要刪除這則留言嗎？", async () => {
          await deleteWish(day.id, spot.id, btn.dataset.wishid);
        });
      });
    });
    wishListEl.querySelectorAll(".edit-wish-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const wish = state.wishes.find((w) => w.id === btn.dataset.wishid);
        if (wish) renderEditWishModal(day.id, spot.id, wish);
      });
    });
  }

  document.getElementById("wish-img-toggle").addEventListener("click", () => {
    const el = document.getElementById("wish-image-input");
    const showing = el.style.display !== "none";
    el.style.display = showing ? "none" : "block";
    if (!showing) el.focus();
  });

  document.getElementById("wish-map-toggle").addEventListener("click", () => {
    const el = document.getElementById("wish-map-fields");
    const showing = el.style.display !== "none";
    el.style.display = showing ? "none" : "flex";
    if (!showing) document.getElementById("wish-map-link-input").focus();
  });

  const submitWish = async () => {
    const input = document.getElementById("wish-input");
    const imgInput = document.getElementById("wish-image-input");
    const mapLinkInput = document.getElementById("wish-map-link-input");
    const mapAddressInput = document.getElementById("wish-map-address-input");
    const text = input.value.trim();
    const imageUrl = imgInput.value.trim();
    const mapUrl = mapLinkInput.value.trim();
    const mapAddress = mapAddressInput.value.trim();
    if (!text && !imageUrl) return;
    input.value = "";
    imgInput.value = "";
    imgInput.style.display = "none";
    mapLinkInput.value = "";
    mapAddressInput.value = "";
    document.getElementById("wish-map-fields").style.display = "none";
    await addWish(day.id, spot.id, text, imageUrl, mapUrl, mapAddress);
  };
  document.getElementById("wish-submit").addEventListener("click", submitWish);
  document.getElementById("wish-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitWish();
  });
  document.getElementById("wish-image-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitWish();
  });
  document.getElementById("wish-map-link-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitWish();
  });
  document.getElementById("wish-map-address-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitWish();
  });
}

function renderEditWishModal(dayId, spotId, wish) {
  openModal("編輯留言", `
    <div class="form-row"><label>內容</label><textarea id="wish-edit-text" rows="3" placeholder="想去...想吃...">${escapeHtml(wish.text || "")}</textarea></div>
    <div class="form-row"><label>圖片網址（選填）</label><input type="text" id="wish-edit-image" value="${escapeHtml(wish.imageUrl || "")}" placeholder="https://..."></div>
    <div class="form-row"><label>Google 地圖連結（選填）</label><input type="text" id="wish-edit-map-link" value="${escapeHtml(wish.mapUrl || "")}" placeholder="例如 https://maps.app.goo.gl/3yRm2VmBV6d4LFRN8"></div>
    <div class="form-row"><label>地址／地點（選填，沒填連結時會用這個搜尋）</label><input type="text" id="wish-edit-map-address" value="${escapeHtml(wish.mapAddress || "")}" placeholder="例如：淺草寺"></div>
    <div class="form-actions">
      <button class="secondary-btn" id="wish-edit-cancel">取消</button>
      <button class="primary-btn" id="wish-edit-save">儲存</button>
    </div>
  `);
  document.getElementById("wish-edit-cancel").onclick = closeModal;
  document.getElementById("wish-edit-save").onclick = async () => {
    const text = document.getElementById("wish-edit-text").value.trim();
    const imageUrl = document.getElementById("wish-edit-image").value.trim();
    const mapUrl = document.getElementById("wish-edit-map-link").value.trim();
    const mapAddress = document.getElementById("wish-edit-map-address").value.trim();
    if (!text && !imageUrl) return toast("內容和圖片網址不能都空白");
    closeModal();
    await updateWish(dayId, spotId, wish.id, { text, imageUrl: imageUrl || null, mapUrl: mapUrl || null, mapAddress: mapAddress || null });
  };
}

function renderSpotDayPickerModal(sourceDayId, spot, mode) {
  const isMove = mode === "move";
  const otherDays = state.days.filter((d) => d.id !== sourceDayId);
  const sameDay = state.days.find((d) => d.id === sourceDayId);
  const dayRow = (d) => `
    <div class="card spot-item" data-pick-dayid="${d.id}" style="cursor:pointer;">
      <div class="spot-title" style="flex:1;">${escapeHtml(d.title)}${d.date ? `<span style="color:var(--text-muted);font-weight:400;font-size:12.5px;"> ・ ${escapeHtml(d.date)}</span>` : ""}</div>
      <div>›</div>
    </div>`;
  openModal(`${isMove ? "搬移" : "複製"}「${escapeHtml(spot.title)}」到...`, `
    <p style="font-size:13px;color:var(--text-muted);margin-top:0;">
      ${isMove
        ? "選一個天數，會把這個景點（含內容、地圖設定與許願池留言）搬過去，原本天數底下就不會再有這個景點。"
        : "選一個天數，會把這個景點（含內容與地圖設定）複製過去，原本的不會受影響；許願池留言不會一起複製。"}
    </p>
    <div style="display:flex;flex-direction:column;gap:8px;max-height:50vh;overflow-y:auto;">
      ${otherDays.length ? otherDays.map(dayRow).join("") : `<div class="empty-hint">目前沒有其他天數可以${isMove ? "搬" : "複製"}過去</div>`}
      ${(!isMove && sameDay) ? `<div style="border-top:1px solid var(--border);margin-top:4px;padding-top:8px;">${dayRow(sameDay)}<div style="font-size:12px;color:var(--text-muted);margin-top:-4px;">↑ 複製一份到同一天（例如同一個地方要去兩次）</div></div>` : ""}
    </div>
    <div class="form-actions">
      <button class="secondary-btn" id="spot-daypicker-cancel">取消</button>
    </div>
  `);
  document.getElementById("spot-daypicker-cancel").onclick = closeModal;
  document.querySelectorAll("[data-pick-dayid]").forEach((el) => {
    el.addEventListener("click", async () => {
      const targetDayId = el.dataset.pickDayid;
      const targetDay = state.days.find((d) => d.id === targetDayId);
      closeModal();
      if (isMove) {
        await moveSpotToDay(sourceDayId, spot, targetDayId);
        closeSpotPanel();
        toast(`已搬移到「${targetDay ? targetDay.title : ""}」`);
      } else {
        await copySpotToDay(spot, targetDayId);
        toast(`已複製到「${targetDay ? targetDay.title : ""}」`);
      }
    });
  });
}

function renderEditSpotMetaModal(dayId, spot) {
  openModal("編輯景點資訊", `
    <div class="form-row"><label>名稱</label><input type="text" id="spot-title" value="${escapeHtml(spot.title)}"></div>
    <div class="form-row"><label>時間</label><input type="time" id="spot-time" value="${escapeHtml(spot.time || "")}"></div>
    <div class="form-row">
      <label>Google 地圖連結（選填）</label>
      <input type="text" id="spot-mapurl" value="${escapeHtml(spot.mapUrl || "")}" placeholder="例如 https://maps.app.goo.gl/3yRm2VmBV6d4LFRN8">
    </div>
    <p style="font-size:12px;color:var(--text-muted);margin:-6px 0 12px;">沒填的話，會用上面的「名稱」欄位到 Google 地圖搜尋</p>
    <div class="form-actions">
      <button class="secondary-btn" id="spot-cancel">取消</button>
      <button class="primary-btn" id="spot-confirm">儲存</button>
    </div>
  `);
  document.getElementById("spot-cancel").onclick = closeModal;
  document.getElementById("spot-confirm").onclick = async () => {
    const title = document.getElementById("spot-title").value.trim();
    const time = document.getElementById("spot-time").value;
    const mapUrl = document.getElementById("spot-mapurl").value.trim();
    if (!title) return toast("請輸入名稱");
    await updateSpotMeta(dayId, spot.id, { title, time, mapUrl: mapUrl || null });
    closeModal();
  };
}


// ------------------------------------------------------------
// 記帳與分帳結算邏輯（內部一律用「分」為單位計算，避免浮點誤差）
// ------------------------------------------------------------
// 先按幣別分開算「每個人在這個幣別裡是多收還是多付」，完全不牽涉匯率
function computeBalancesByCurrency(expenses, members) {
  const byCurrency = {};
  expenses.forEach((e) => {
    const currency = e.currency || "TWD";
    const balance = (byCurrency[currency] = byCurrency[currency] || {});
    members.forEach((m) => { if (!(m.id in balance)) balance[m.id] = 0; });
    if (!(e.payerId in balance)) balance[e.payerId] = 0;
    balance[e.payerId] += e.amountCents;
    const share = e.amountCents / e.splitWith.length;
    e.splitWith.forEach((mid) => {
      if (!(mid in balance)) balance[mid] = 0;
      balance[mid] -= share;
    });
  });
  return byCurrency;
}

// 把每個幣別的餘額，用（存在行程資料裡的）匯率換算成台幣後加總，
// 缺匯率的幣別會列在 missingCurrencies，該幣別金額暫不計入 balanceTWD
function computeSettlement(expenses, members, fxRates) {
  const byCurrency = computeBalancesByCurrency(expenses, members);
  const balanceTWD = {};
  members.forEach((m) => (balanceTWD[m.id] = 0));
  const missingCurrencies = [];

  Object.entries(byCurrency).forEach(([currency, balance]) => {
    const rate = currency === "TWD" ? 1 : fxRates[currency]?.rate;
    if (!rate) {
      missingCurrencies.push(currency);
      return;
    }
    Object.entries(balance).forEach(([id, amt]) => {
      if (!(id in balanceTWD)) balanceTWD[id] = 0;
      balanceTWD[id] += amt * rate;
    });
  });

  const creditors = [];
  const debtors = [];
  Object.entries(balanceTWD).forEach(([id, amt]) => {
    const rounded = Math.round(amt);
    if (rounded > 0) creditors.push({ id, amt: rounded });
    else if (rounded < 0) debtors.push({ id, amt: -rounded });
  });
  creditors.sort((a, b) => b.amt - a.amt);
  debtors.sort((a, b) => b.amt - a.amt);

  const transactions = [];
  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const c = creditors[ci];
    const d = debtors[di];
    const amt = Math.min(c.amt, d.amt);
    if (amt > 0) transactions.push({ from: d.id, to: c.id, amountCents: amt });
    c.amt -= amt;
    d.amt -= amt;
    if (c.amt === 0) ci++;
    if (d.amt === 0) di++;
  }
  return { balanceTWD, transactions, missingCurrencies, byCurrency };
}

function memberName(id) {
  const m = state.trip.members.find((x) => x.id === id);
  return m ? m.name : "（已移除的成員）";
}

function renderExpensesPage() {
  const root = document.getElementById("app-root");
  const members = state.trip.members;
  const fxRates = tripFxRates();

  // 用到的外幣（有消費紀錄的），排除台幣
  const usedCurrencies = Array.from(new Set(state.expenses.map((e) => e.currency || "TWD"))).filter((c) => c !== "TWD");

  // 依日期分組
  const byDate = {};
  state.expenses.forEach((e) => {
    const key = e.date || "未指定日期";
    (byDate[key] = byDate[key] || []).push(e);
  });
  const dateKeys = Object.keys(byDate).sort();

  const { balanceTWD, transactions, missingCurrencies } = computeSettlement(state.expenses, members, fxRates);

  root.innerHTML = `
    <div class="tabs">
      <button class="tab-btn" id="tab-itinerary">📅 行程</button>
      <button class="tab-btn active" id="tab-expenses">💰 記帳與分帳</button>
    </div>

    ${usedCurrencies.length ? `
      <div class="fx-status-card">
        <div class="fx-status-title">目前使用的幣別匯率</div>
        ${usedCurrencies.map((c) => {
          const info = fxRates[c];
          return `<div class="fx-status-row">
            <span>1 ${escapeHtml(c)} ≈</span>
            <span>
              ${info ? `${info.rate.toFixed(4)} TWD${info.manual ? "（手動）" : "（網路）"}　<span class="fx-updated">${escapeHtml(info.updatedAt)}</span>` : `<span class="fx-missing">尚未取得</span>`}
              <button class="secondary-btn small-btn fx-set-btn" data-currency="${escapeHtml(c)}" style="margin-left:8px;">設定</button>
            </span>
          </div>`;
        }).join("")}
        <button class="secondary-btn small-btn" id="refresh-fx-btn" style="margin-top:8px;">🔄 一次查詢全部（網路）</button>
      </div>
    ` : ""}

    ${missingCurrencies.length ? `
      <div class="readonly-banner">⚠️ ${missingCurrencies.map(escapeHtml).join("、")} 還沒有匯率資料，下面的結算金額暫時還沒把這些幣別的消費算進去。可以按上面「設定」用網路查詢或手動輸入。</div>
    ` : ""}

    <div class="section-title">結算總覽</div>
    <div class="card">
      ${members.map((m) => `
        <div class="balance-row">
          <span>${escapeHtml(m.name)}</span>
          <span style="color:${balanceTWD[m.id] >= 0 ? "#16a34a" : "var(--danger)"};font-weight:600;">
            ${balanceTWD[m.id] > 50 ? `應收 NT$${fmtMoney(balanceTWD[m.id])}` : balanceTWD[m.id] < -50 ? `應付 NT$${fmtMoney(Math.abs(balanceTWD[m.id]))}` : "已結清"}
          </span>
        </div>
      `).join("")}
      <button class="primary-btn full-width" id="open-settlement-btn" style="margin-top:12px;">🧮 結算（查看建議轉帳方式）</button>
    </div>

    <div class="section-title">消費明細</div>
    <button class="primary-btn full-width" id="add-expense-btn" style="margin-bottom:12px;">＋ 新增一筆消費</button>
    <div id="expense-list">
      ${dateKeys.length ? dateKeys.map((dk) => {
        const items = byDate[dk];
        // 依幣別分別列小計（不同幣別不會混加）
        const subtotalByCurrency = {};
        items.forEach((e) => {
          const c = e.currency || "TWD";
          subtotalByCurrency[c] = (subtotalByCurrency[c] || 0) + e.amountCents;
        });
        const subtotalText = Object.entries(subtotalByCurrency)
          .map(([c, cents]) => fmtCurrencyAmt(cents, c))
          .join("　");
        return `
          <div style="margin-bottom:16px;">
            <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--text-muted);margin-bottom:6px;">
              <span>${escapeHtml(dk)}</span><span>小計 ${subtotalText}</span>
            </div>
            ${items.map((e) => {
              const currency = e.currency || "TWD";
              const isForeign = currency !== "TWD";
              const rateInfo = fxRates[currency];
              return `
              <div class="expense-item" data-id="${e.id}">
                <div class="expense-top">
                  <span>${escapeHtml(e.title)} ${isForeign ? `<span class="currency-tag">${escapeHtml(currency)}</span>` : ""}</span>
                  <span class="expense-amount">${fmtCurrencyAmt(e.amountCents, currency)}</span>
                </div>
                ${isForeign ? (rateInfo
                  ? `<div class="expense-fx">≈ NT$${fmtMoney(Math.round(e.amountCents * rateInfo.rate))}（依 ${escapeHtml(rateInfo.updatedAt)} 匯率）</div>`
                  : `<div class="expense-fx expense-fx-missing">尚未取得 ${escapeHtml(currency)} 匯率，還沒換算成台幣</div>`
                ) : ""}
                <div class="expense-meta">
                  ${escapeHtml(memberName(e.payerId))} 先付款，由 ${e.splitWith.map(memberName).map(escapeHtml).join("、")} 分攤
                  ${e.note ? ` · ${escapeHtml(e.note)}` : ""}
                </div>
                <div style="margin-top:6px;display:flex;gap:6px;">
                  <span class="secondary-btn small-btn edit-expense-btn" data-id="${e.id}">編輯</span>
                  <span class="danger-btn small-btn del-expense-btn" data-id="${e.id}">刪除</span>
                </div>
              </div>
            `;
            }).join("")}
          </div>
        `;
      }).join("") : `<div class="empty-hint">還沒有任何消費紀錄</div>`}
    </div>
  `;

  document.getElementById("tab-itinerary").onclick = () => navigate(`#/trip/${state.tripId}${state.currentDayId ? "/day/" + state.currentDayId : ""}`);
  document.getElementById("tab-expenses").onclick = () => {};
  document.getElementById("add-expense-btn").addEventListener("click", () => renderExpenseFormModal(null));
  document.getElementById("open-settlement-btn").addEventListener("click", () => renderSettlementModal(transactions));
  const refreshBtn = document.getElementById("refresh-fx-btn");
  if (refreshBtn) refreshBtn.addEventListener("click", () => handleRefreshRates(usedCurrencies));
  root.querySelectorAll(".fx-set-btn").forEach((btn) => {
    btn.addEventListener("click", () => renderFxRateSettingModal(btn.dataset.currency));
  });
  root.querySelectorAll(".edit-expense-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const expense = state.expenses.find((e) => e.id === btn.dataset.id);
      if (expense) renderExpenseFormModal(expense);
    });
  });
  root.querySelectorAll(".del-expense-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      openConfirm("確定要刪除這筆消費紀錄嗎？", async () => {
        await deleteExpense(btn.dataset.id);
      });
    });
  });
}

function renderSettlementModal(transactions) {
  openModal("結算：建議轉帳方式", `
    <p style="font-size:13px;color:var(--text-muted);margin-top:0;">已自動精簡成最少的轉帳筆數。</p>
    ${transactions.length ? transactions.map((t) => `
      <div class="balance-row">
        <span>${escapeHtml(memberName(t.from))} <span class="settle-arrow">→</span> ${escapeHtml(memberName(t.to))}</span>
        <span style="font-weight:700;">NT$${fmtMoney(t.amountCents)}</span>
      </div>
    `).join("") : `<div class="empty-hint">目前帳務已結清 🎉</div>`}
    <div class="form-actions">
      <button class="primary-btn" id="settlement-close-btn">關閉</button>
    </div>
  `);
  document.getElementById("settlement-close-btn").onclick = closeModal;
}

function renderFxRateSettingModal(currency) {
  const info = tripFxRates()[currency];
  openModal(`設定 ${escapeHtml(currency)} 匯率`, `
    <p style="font-size:13px;color:var(--text-muted);margin-top:0;">
      目前：${info ? `1 ${escapeHtml(currency)} ≈ ${info.rate.toFixed(4)} TWD（${info.manual ? "手動輸入" : "網路查詢"}，${escapeHtml(info.updatedAt)} 更新）` : "尚未設定"}
    </p>
    <button class="secondary-btn full-width" id="fx-auto-btn">🔄 使用網路即時匯率</button>
    <div style="margin:18px 0;border-top:1px dashed var(--border);"></div>
    <div class="form-row">
      <label>或手動輸入：1 ${escapeHtml(currency)} = 多少台幣？</label>
      <input type="number" min="0" step="0.0001" id="fx-manual-input" placeholder="例如：0.21">
    </div>
    <div class="form-actions">
      <button class="secondary-btn" id="fx-cancel-btn">取消</button>
      <button class="primary-btn" id="fx-manual-save-btn">儲存手動匯率</button>
    </div>
  `);
  document.getElementById("fx-cancel-btn").onclick = closeModal;
  document.getElementById("fx-auto-btn").onclick = async () => {
    const btn = document.getElementById("fx-auto-btn");
    btn.disabled = true;
    btn.textContent = "查詢中...";
    const ok = await refreshFxRate(currency);
    if (ok) {
      closeModal();
      toast("已更新為網路查詢的匯率");
    } else {
      btn.disabled = false;
      btn.textContent = "🔄 使用網路即時匯率";
      toast("查詢失敗，請改用下方手動輸入");
    }
  };
  document.getElementById("fx-manual-save-btn").onclick = async () => {
    const val = parseFloat(document.getElementById("fx-manual-input").value);
    if (!(val > 0)) return toast("請輸入正確的匯率數字");
    await saveTripFxRate(currency, val, true);
    closeModal();
    toast("已儲存手動匯率");
  };
}

async function handleRefreshRates(currencies) {
  const btn = document.getElementById("refresh-fx-btn");
  if (btn) { btn.disabled = true; btn.textContent = "查詢中..."; }
  const failed = [];
  for (const c of currencies) {
    const ok = await refreshFxRate(c);
    if (!ok) failed.push(c);
  }
  if (btn) { btn.disabled = false; btn.textContent = "🔄 查詢／更新匯率"; }
  if (failed.length) {
    renderManualFxModal(failed);
  } else {
    toast("匯率已更新");
  }
}

function renderManualFxModal(currencies) {
  openModal("手動輸入匯率", `
    <p style="font-size:13px;color:var(--text-muted);margin-top:0;">自動查詢暫時查不到以下幣別的匯率（常見原因：今天的資料還沒公布），可以先手動輸入，之後隨時可以再按「查詢／更新匯率」重新自動抓取。</p>
    ${currencies.map((c) => `
      <div class="form-row">
        <label>1 ${escapeHtml(c)} = 多少台幣？</label>
        <input type="number" min="0" step="0.0001" id="manual-fx-${escapeHtml(c)}" placeholder="例如：0.21">
      </div>
    `).join("")}
    <div class="form-actions">
      <button class="secondary-btn" id="manual-fx-cancel">取消</button>
      <button class="primary-btn" id="manual-fx-save">儲存</button>
    </div>
  `);
  document.getElementById("manual-fx-cancel").onclick = closeModal;
  document.getElementById("manual-fx-save").onclick = async () => {
    for (const c of currencies) {
      const val = parseFloat(document.getElementById(`manual-fx-${c}`).value);
      if (val > 0) await saveTripFxRate(c, val, true);
    }
    closeModal();
    toast("已儲存手動匯率");
  };
}

function renderExpenseFormModal(existing) {
  const members = state.trip.members;
  const my = myMember();
  const currencies = tripCurrencies();
  const multiCurrency = currencies.length > 1;
  const isEdit = !!existing;
  let splitWith = existing ? [...existing.splitWith] : members.map((m) => m.id); // 預設全員分攤

  openModal(isEdit ? "編輯消費" : "新增消費", `
    <div class="form-row"><label>項目名稱</label><input type="text" id="exp-title" placeholder="例如：午餐" value="${isEdit ? escapeHtml(existing.title) : ""}"></div>
    <div class="form-row" style="display:flex;gap:8px;">
      <div style="flex:1;">
        <label>金額</label>
        <input type="number" id="exp-amount" min="0" step="1" placeholder="0" value="${isEdit ? Math.round(existing.amountCents) / 100 : ""}">
      </div>
      ${multiCurrency ? `
        <div style="width:120px;">
          <label>幣別</label>
          <select id="exp-currency">
            ${currencies.map((c) => `<option value="${c}" ${(isEdit ? existing.currency : "TWD") === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}
          </select>
        </div>
      ` : `<input type="hidden" id="exp-currency" value="TWD">`}
    </div>
    ${multiCurrency ? `<p style="font-size:12px;color:var(--text-muted);margin-top:-6px;">選外幣的話，不用擔心匯率——先記下來，結算時會統一換算成台幣。</p>` : ""}
    <div class="form-row">
      <label>由誰先付款</label>
      <select id="exp-payer">
        ${members.map((m) => `<option value="${m.id}" ${(isEdit ? existing.payerId === m.id : my && m.id === my.id) ? "selected" : ""}>${escapeHtml(m.name)}</option>`).join("")}
      </select>
    </div>
    <div class="form-row">
      <label>要跟誰分攤（可複選）</label>
      <div class="checkbox-group" id="split-group">
        ${members.map((m) => `<div class="checkbox-chip ${splitWith.includes(m.id) ? "checked" : ""}" data-id="${m.id}">${escapeHtml(m.name)}</div>`).join("")}
      </div>
    </div>
    <div class="form-row"><label>日期</label><input type="date" id="exp-date" value="${isEdit ? escapeHtml(existing.date) : todayStr()}"></div>
    <div class="form-row"><label>備註（選填）</label><input type="text" id="exp-note" value="${isEdit ? escapeHtml(existing.note || "") : ""}"></div>
    <div class="form-actions">
      ${isEdit ? `<button class="danger-btn" id="exp-delete" style="margin-right:auto;">刪除</button>` : ""}
      <button class="secondary-btn" id="exp-cancel">取消</button>
      <button class="primary-btn" id="exp-confirm">${isEdit ? "儲存" : "新增"}</button>
    </div>
  `);

  document.querySelectorAll("#split-group .checkbox-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const id = chip.dataset.id;
      if (splitWith.includes(id)) {
        if (splitWith.length === 1) return toast("至少要有一人分攤");
        splitWith = splitWith.filter((x) => x !== id);
        chip.classList.remove("checked");
      } else {
        splitWith.push(id);
        chip.classList.add("checked");
      }
    });
  });

  document.getElementById("exp-cancel").onclick = closeModal;
  if (isEdit) {
    document.getElementById("exp-delete").onclick = () => {
      openConfirm("確定要刪除這筆消費紀錄嗎？", async () => {
        closeModal();
        await deleteExpense(existing.id);
      });
    };
  }
  document.getElementById("exp-confirm").onclick = async () => {
    const title = document.getElementById("exp-title").value.trim();
    const amount = parseFloat(document.getElementById("exp-amount").value);
    const currency = document.getElementById("exp-currency").value;
    const payerId = document.getElementById("exp-payer").value;
    const date = document.getElementById("exp-date").value;
    const note = document.getElementById("exp-note").value.trim();
    if (!title) return toast("請輸入項目名稱");
    if (!amount || amount <= 0) return toast("請輸入正確金額");
    if (!splitWith.length) return toast("請至少選擇一位分攤者");

    const amountCents = Math.round(amount * 100);
    closeModal();

    if (isEdit) {
      await updateExpense(existing.id, { title, amountCents, currency, payerId, splitWith, date, note });
    } else {
      await addExpense({ title, amountCents, currency, payerId, splitWith, date, note });
    }

    // 如果是這趟行程第一次用到這個幣別，順手先查一次匯率（失敗也沒關係，結算頁隨時可以再查／手動輸入）
    if (currency !== "TWD" && !tripFxRates()[currency]) {
      refreshFxRate(currency);
    }
  };
}


// ------------------------------------------------------------
// 貨幣設定（僅統籌人 owner 可操作）
// ------------------------------------------------------------
// ------------------------------------------------------------
// 背景圖片設定（僅統籌人 owner 可操作；存在行程資料裡，大家看到的都一樣）
// ------------------------------------------------------------
function renderBackgroundSettingsModal() {
  const currentUrl = state.trip.backgroundImageUrl || "";
  const currentDim = state.trip.backgroundDim ?? 30;

  openModal("背景圖片設定", `
    <p style="font-size:13px;color:var(--text-muted);margin-top:0;">
      設定整個行程頁面的背景圖片，貼上圖片網址即可（跟景點插圖一樣是用連結，不是上傳檔案）。這是存在行程資料裡的，所以同行的每個人打開這個行程都會看到同一張背景。
    </p>
    <div class="form-row">
      <label>圖片網址</label>
      <input type="text" id="bg-url-input" placeholder="https://..." value="${escapeHtml(currentUrl)}">
    </div>
    <div class="form-row">
      <label>背景暗化程度（讓文字更好讀）</label>
      <input type="range" id="bg-dim-input" min="0" max="80" step="5" value="${currentDim}" style="width:100%;">
    </div>
    <div id="bg-preview" style="height:120px;border-radius:var(--radius-sm);border:1px solid var(--border);background-size:cover;background-position:center;margin-bottom:6px;"></div>
    <div class="form-actions">
      <button class="danger-btn" id="bg-clear-btn">清除背景</button>
      <button class="secondary-btn" id="bg-cancel-btn">取消</button>
      <button class="primary-btn" id="bg-save-btn">儲存</button>
    </div>
  `);

  const preview = document.getElementById("bg-preview");
  const urlInput = document.getElementById("bg-url-input");
  const dimInput = document.getElementById("bg-dim-input");
  const updatePreview = () => {
    const url = urlInput.value.trim();
    const dim = Number(dimInput.value);
    preview.style.backgroundImage = url
      ? `linear-gradient(rgba(0,0,0,${dim / 100}), rgba(0,0,0,${dim / 100})), url("${url.replace(/"/g, '\\"')}")`
      : "none";
  };
  updatePreview();
  urlInput.addEventListener("input", updatePreview);
  dimInput.addEventListener("input", updatePreview);

  document.getElementById("bg-cancel-btn").onclick = closeModal;
  document.getElementById("bg-clear-btn").onclick = async () => {
    await updateTripBackground("", 30);
    closeModal();
    toast("已清除背景圖片");
  };
  document.getElementById("bg-save-btn").onclick = async () => {
    const url = urlInput.value.trim();
    const dim = Number(dimInput.value);
    await updateTripBackground(url, dim);
    closeModal();
    toast(url ? "已更新背景圖片" : "已清除背景圖片");
  };
}

function renderCurrencySettingsModal() {
  let selected = new Set(tripCurrencies());
  selected.add("TWD"); // 結算一律以台幣為準，所以永遠包含

  openModal("貨幣設定", `
    <p style="font-size:13px;color:var(--text-muted);margin-top:0;">
      勾選這趟行程會用到的貨幣。新增消費時，只會列出這裡勾選的貨幣可以選。台幣是結算的基準幣別，會固定顯示。
    </p>
    <div class="checkbox-group" id="currency-checkbox-group">
      ${CURRENCY_OPTIONS.map((c) => `
        <div class="checkbox-chip ${selected.has(c.code) ? "checked" : ""} ${c.code === "TWD" ? "locked" : ""}" data-code="${c.code}">
          ${escapeHtml(currencyLabel(c.code))}
        </div>
      `).join("")}
    </div>
    <p style="font-size:12px;color:var(--text-muted);margin-top:10px;">
      非台幣消費會在新增當下，依「消費日期」自動查詢當天匯率換算成台幣一起記錄；若查詢失敗，會請新增消費的人手動輸入匯率。
    </p>
    <div class="form-actions">
      <button class="secondary-btn" id="currency-cancel">取消</button>
      <button class="primary-btn" id="currency-save">儲存</button>
    </div>
  `);
  document.querySelectorAll("#currency-checkbox-group .checkbox-chip").forEach((chip) => {
    if (chip.dataset.code === "TWD") return; // 台幣鎖定，不能取消
    chip.addEventListener("click", () => {
      const code = chip.dataset.code;
      if (selected.has(code)) {
        selected.delete(code);
        chip.classList.remove("checked");
      } else {
        selected.add(code);
        chip.classList.add("checked");
      }
    });
  });
  document.getElementById("currency-cancel").onclick = closeModal;
  document.getElementById("currency-save").onclick = async () => {
    await updateTripCurrencies(Array.from(selected));
    closeModal();
    toast("已更新貨幣設定");
  };
}

// ------------------------------------------------------------
// 管理成員與權限（僅統籌人 owner 可操作）
// ------------------------------------------------------------
function renderManageMembersModal() {
  let members = state.trip.members.map((m) => ({ ...m }));

  function rowHtml(m) {
    return `
      <div class="block-editor-row" data-row="${m.id}">
        <input type="text" value="${escapeHtml(m.name)}" data-field="name" data-row="${m.id}" style="flex:1;min-width:100px;padding:8px;border:1px solid var(--border);border-radius:8px;">
        <select data-field="permission" data-row="${m.id}" style="padding:8px;border:1px solid var(--border);border-radius:8px;">
          <option value="owner" ${m.permission === "owner" ? "selected" : ""}>統籌人</option>
          <option value="editor" ${m.permission === "editor" ? "selected" : ""}>可編輯</option>
          <option value="viewer" ${m.permission === "viewer" ? "selected" : ""}>唯讀</option>
        </select>
        <button class="icon-btn remove-member-row" data-row="${m.id}">✕</button>
      </div>`;
  }
  function renderRows() {
    const wrap = document.getElementById("manage-members-wrap");
    wrap.innerHTML = members.map(rowHtml).join("");
    wrap.querySelectorAll("input[data-field=name]").forEach((inp) => {
      inp.addEventListener("input", () => {
        members.find((x) => x.id === inp.dataset.row).name = inp.value;
      });
    });
    wrap.querySelectorAll("select[data-field=permission]").forEach((sel) => {
      sel.addEventListener("change", () => {
        members.find((x) => x.id === sel.dataset.row).permission = sel.value;
      });
    });
    wrap.querySelectorAll(".remove-member-row").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (members.length <= 1) return toast("至少要保留一位成員");
        members = members.filter((x) => x.id !== btn.dataset.row);
        renderRows();
      });
    });
  }

  openModal("管理成員與權限", `
    <div id="manage-members-wrap"></div>
    <button class="secondary-btn small-btn" id="manage-add-member-btn" style="margin-top:4px;">＋ 新增成員</button>
    <div style="border-top:1px dashed var(--border);margin-top:16px;padding-top:12px;">
      <h4 style="margin:0 0 8px;">編輯權限申請</h4>
      <div id="access-requests-wrap"><p style="color:var(--text-muted);font-size:13px;">載入中...</p></div>
    </div>
    <p style="font-size:12px;color:var(--text-muted);margin-top:12px;">
      提醒：移除成員不會刪除他過去留下的許願池留言或消費紀錄，但他將無法再用原本的身份登入。
    </p>
    <div class="form-actions">
      <button class="secondary-btn" id="manage-cancel">取消</button>
      <button class="primary-btn" id="manage-save">儲存</button>
    </div>
  `);
  renderRows();
  (async () => {
    const wrap = document.getElementById("access-requests-wrap");
    try {
      const requests = (await loadAccessRequests()).filter((r) => r.status === "pending");
      if (!requests.length) {
        wrap.innerHTML = `<p style="color:var(--text-muted);font-size:13px;">目前沒有待審核申請。</p>`;
        return;
      }
      const candidates = members.filter((m) => m.permission !== "owner" && !m.uid);
      wrap.innerHTML = requests.map((r) => `
        <div class="card" style="padding:10px;margin-bottom:8px;">
          <div style="font-size:12px;word-break:break-all;">UID：${escapeHtml(r.requestedUid)}</div>
          <div style="display:flex;gap:6px;align-items:center;margin-top:8px;">
            <select data-request-member="${r.id}" style="flex:1;padding:8px;border:1px solid var(--border);border-radius:8px;">
              <option value="">選擇要綁定的成員</option>
              ${candidates.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}（${permLabel(m.permission)}）</option>`).join("")}
            </select>
            <button class="primary-btn small-btn" data-approve-request="${r.id}">核准</button>
            <button class="secondary-btn small-btn" data-reject-request="${r.id}">拒絕</button>
          </div>
        </div>`).join("");
      wrap.querySelectorAll("[data-approve-request]").forEach((btn) => {
        btn.onclick = async () => {
          const req = requests.find((r) => r.id === btn.dataset.approveRequest);
          const select = wrap.querySelector(`[data-request-member="${req.id}"]`);
          if (!select.value) return toast("請先選擇要綁定的成員");
          try {
            btn.disabled = true;
            await approveAccessRequest(req.id, req.requestedUid, select.value);
            toast("已核准編輯權限，請通知對方重新整理");
            closeModal();
          } catch (err) {
            console.error(err);
            toast("核准失敗，請確認規則及成員資料");
            btn.disabled = false;
          }
        };
      });
      wrap.querySelectorAll("[data-reject-request]").forEach((btn) => {
        btn.onclick = async () => {
          try {
            await rejectAccessRequest(btn.dataset.rejectRequest);
            toast("已拒絕申請");
            closeModal();
          } catch (err) {
            console.error(err);
            toast("拒絕申請失敗");
          }
        };
      });
    } catch (err) {
      console.error(err);
      wrap.innerHTML = `<p style="color:var(--danger);font-size:13px;">申請資料載入失敗，請確認 Firestore Rules。</p>`;
    }
  })();
  document.getElementById("manage-add-member-btn").addEventListener("click", () => {
    members.push({ id: newLocalId(), name: "", permission: "editor" });
    renderRows();
  });
  document.getElementById("manage-cancel").onclick = closeModal;
  document.getElementById("manage-save").onclick = async () => {
    const cleaned = members.filter((m) => m.name.trim()).map((m) => ({ ...m, name: m.name.trim() }));
    if (!cleaned.length) return toast("至少要有一位成員");
    if (!cleaned.some((m) => m.permission === "owner")) {
      return toast("至少要有一位統籌人（owner）");
    }
    try {
      await updateTripMembers(cleaned);
      closeModal();
      toast("已更新成員設定");
    } catch (err) {
      console.error(err);
      toast(err.message || "成員設定儲存失敗，請確認統籌人資料");
    }
  };
}

// ------------------------------------------------------------
// 啟動
// ------------------------------------------------------------
authReady.then(() => {
  route();
});
