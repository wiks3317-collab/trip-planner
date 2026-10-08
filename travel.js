// ============================================================
// v21p13：交通時間（Google Routes API）與地點選擇（Google Places API New）
//
// 只用 REST（fetch），不載入 Maps JavaScript，所以不需要改 CSP（connect-src 已允許 *.googleapis.com）。
// 金鑰放在 maps-config.js；沒填金鑰時，所有功能自動停用，網站其他部分完全不受影響。
// ============================================================
import { mapsApiKey } from "./maps-config.js";

export const TRAVEL_ENABLED = typeof mapsApiKey === "string" && mapsApiKey.trim().length > 10;

export const TRAVEL_MODES = {
  DRIVE:   { icon: "🚗", label: "開車",     gmaps: "driving" },
  WALK:    { icon: "🚶", label: "走路",     gmaps: "walking" },
  TRANSIT: { icon: "🚌", label: "大眾運輸", gmaps: "transit" },
};
export function validMode(m) { return Object.prototype.hasOwnProperty.call(TRAVEL_MODES, m) ? m : null; }

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const PLACES_BASE = "https://places.googleapis.com/v1/";
const LANG = "zh-TW";
const REQ_TIMEOUT_MS = 12000;

// ---------- 小工具 ----------
async function gfetch(url, { method = "GET", body, fieldMask } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const headers = { "X-Goog-Api-Key": mapsApiKey.trim() };
    if (body) headers["Content-Type"] = "application/json";
    if (fieldMask) headers["X-Goog-FieldMask"] = fieldMask;
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    let data = null;
    try { data = await res.json(); } catch { /* 沒有 JSON 內容 */ }
    if (!res.ok) {
      const msg = (data && data.error && (data.error.message || data.error.status)) || `HTTP ${res.status}`;
      const e = new Error(msg);
      e.status = res.status;
      e.apiStatus = data && data.error && data.error.status;
      throw e;
    }
    return data || {};
  } catch (e) {
    if (e && e.name === "AbortError") { const te = new Error("連線逾時"); te.code = "timeout"; throw te; }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export function friendlyApiError(e) {
  const s = e && e.apiStatus;
  if (e && e.code === "timeout") return "連線逾時";
  if (s === "PERMISSION_DENIED" || (e && e.status === 403)) return "金鑰沒有權限（請確認已啟用 Routes API／Places API，且網域限制正確）";
  if (s === "RESOURCE_EXHAUSTED" || (e && e.status === 429)) return "已達 API 使用上限";
  if (s === "INVALID_ARGUMENT") return "地點或時間資料無法計算";
  if (e && e.message === "Failed to fetch") return "網路連線失敗";
  return (e && e.message) || "未知錯誤";
}

// ---------- 從 Google 地圖「完整網址」抽座標（短網址 maps.app.goo.gl 無法在前端解開，會回傳 null）----------
export function parseMapUrlCoords(url) {
  const s = String(url || "");
  if (!s) return null;
  let m = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(s);     // 地點本身的 pin（最準）
  if (!m) m = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(s);       // 地圖視窗中心（通常很接近）
  if (!m) m = /[?&](?:q|query|destination)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(s);
  if (!m) return null;
  const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// ---------- 景點 → 路線端點 ----------
// 優先序：選定的地點（placeId + 座標）→ 座標 → 地圖長網址內的座標 → 用景點名稱當地址搜尋（約略）
export function endpointFor(spot) {
  if (!spot) return null;
  const hasCoord = typeof spot.lat === "number" && typeof spot.lng === "number";
  if (spot.placeId && hasCoord) {
    return { kind: "place", key: "p:" + spot.placeId, wp: { placeId: spot.placeId }, lat: spot.lat, lng: spot.lng, placeId: spot.placeId, approx: false };
  }
  if (hasCoord) {
    return { kind: "coord", key: `c:${spot.lat.toFixed(5)},${spot.lng.toFixed(5)}`, wp: { location: { latLng: { latitude: spot.lat, longitude: spot.lng } } }, lat: spot.lat, lng: spot.lng, approx: false };
  }
  const fromUrl = parseMapUrlCoords(spot.mapUrl);
  if (fromUrl) {
    return { kind: "coord", key: `c:${fromUrl.lat.toFixed(5)},${fromUrl.lng.toFixed(5)}`, wp: { location: { latLng: { latitude: fromUrl.lat, longitude: fromUrl.lng } } }, lat: fromUrl.lat, lng: fromUrl.lng, approx: false };
  }
  const title = String(spot.title || "").trim();
  if (!title) return null;
  return { kind: "text", key: "t:" + title, wp: { address: title }, text: title, approx: true };
}

// 給「在 Google 地圖看路線」連結用（完全不呼叫 API）
export function directionsLink(fromEp, toEp, mode) {
  const f = (ep) => (ep.lat != null ? `${ep.lat},${ep.lng}` : ep.text);
  let u = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(f(fromEp))}&destination=${encodeURIComponent(f(toEp))}`;
  if (fromEp.placeId) u += `&origin_place_id=${encodeURIComponent(fromEp.placeId)}`;
  if (toEp.placeId) u += `&destination_place_id=${encodeURIComponent(toEp.placeId)}`;
  const g = TRAVEL_MODES[mode] && TRAVEL_MODES[mode].gmaps;
  if (g) u += `&travelmode=${g}`;
  return u;
}

// ---------- 大眾運輸的時間點（只在「未來」才帶；有下一站時間就用「抵達時間」，否則用「出發時間」）----------
export function transitWhen(dayDate, fromTime, toTime) {
  const mk = (t) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayDate || "") || !/^\d{1,2}:\d{2}/.test(t || "")) return null;
    const d = new Date(`${dayDate}T${String(t).slice(0, 5).padStart(5, "0")}:00`);
    if (isNaN(d.getTime()) || d.getTime() < Date.now() + 5 * 60 * 1000) return null; // 已過去就交給「現在」
    return d.toISOString();
  };
  const arr = mk(toTime);
  if (arr) return { arrivalTime: arr };
  const dep = mk(fromTime);
  if (dep) return { departureTime: dep };
  return null;
}

// ---------- 路線計算（Routes API：Compute Routes）----------
// 回傳 { seconds, meters }；沒有可用路線回傳 null；其他錯誤丟出 Error
export async function computeRoute(fromEp, toEp, mode, when) {
  if (!TRAVEL_ENABLED) throw new Error("尚未設定 Google Maps API 金鑰");
  const body = {
    origin: fromEp.wp,
    destination: toEp.wp,
    travelMode: mode,
    languageCode: LANG,
    units: "METRIC",
  };
  if (mode === "DRIVE") body.routingPreference = "TRAFFIC_UNAWARE"; // 不看即時路況：計費較低，也比較穩定
  if (mode === "TRANSIT" && when) Object.assign(body, when);
  const data = await gfetch(ROUTES_URL, { method: "POST", body, fieldMask: "routes.duration,routes.distanceMeters" });
  const r = data.routes && data.routes[0];
  if (!r || !r.duration) return null;
  const seconds = Math.round(parseFloat(String(r.duration).replace("s", "")));
  if (!isFinite(seconds)) return null;
  return { seconds, meters: Math.round(r.distanceMeters || 0) };
}

export function fmtDuration(sec) {
  const m = Math.max(1, Math.round(sec / 60));
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} 小時 ${r} 分` : `${h} 小時`;
}
export function fmtDistance(meters) {
  if (!meters) return "";
  return meters >= 1000 ? `${(meters / 1000).toFixed(meters >= 10000 ? 0 : 1)} 公里` : `${Math.round(meters / 10) * 10} 公尺`;
}

// ---------- 地點搜尋（Places API New）----------
function biasBody(bias) {
  return bias && isFinite(bias.lat) && isFinite(bias.lng)
    ? { locationBias: { circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: 50000 } } }
    : {};
}
export function newSessionToken() {
  try { return crypto.randomUUID(); } catch { return String(Date.now()) + Math.random().toString(16).slice(2); }
}

export async function placeAutocomplete(input, sessionToken, bias) {
  const data = await gfetch(PLACES_BASE + "places:autocomplete", {
    method: "POST",
    body: { input, sessionToken, languageCode: LANG, ...biasBody(bias) },
  });
  return (data.suggestions || [])
    .filter((s) => s.placePrediction && s.placePrediction.placeId)
    .map((s) => {
      const p = s.placePrediction;
      const sf = p.structuredFormat || {};
      return {
        placeId: p.placeId,
        name: (sf.mainText && sf.mainText.text) || (p.text && p.text.text) || "",
        secondary: (sf.secondaryText && sf.secondaryText.text) || "",
      };
    });
}

// 只要 id / 地址 / 座標（Essentials 欄位；不要 displayName，避免被算成較貴的 Pro 欄位）。名稱用建議清單的 name。
export async function placeDetails(placeId, sessionToken) {
  const url = `${PLACES_BASE}places/${encodeURIComponent(placeId)}?languageCode=${LANG}&sessionToken=${encodeURIComponent(sessionToken || "")}`;
  const d = await gfetch(url, { fieldMask: "id,formattedAddress,location" });
  if (!d.location) throw new Error("這個地點沒有座標");
  return { placeId: d.id || placeId, address: d.formattedAddress || "", lat: d.location.latitude, lng: d.location.longitude };
}

// 備案：用名稱文字搜尋，取第一筆（Text Search；用在「補齊座標」）
export async function placeTextSearch(text, bias) {
  const data = await gfetch(PLACES_BASE + "places:searchText", {
    method: "POST",
    body: { textQuery: text, languageCode: LANG, pageSize: 1, ...biasBody(bias) },
    fieldMask: "places.id,places.displayName,places.formattedAddress,places.location",
  });
  const p = data.places && data.places[0];
  if (!p || !p.location) return null;
  return {
    placeId: p.id,
    name: (p.displayName && p.displayName.text) || text,
    address: p.formattedAddress || "",
    lat: p.location.latitude,
    lng: p.location.longitude,
  };
}

// ---------- 地點選擇器（DOM 元件；全部用 textContent，不拼 innerHTML）----------
// root：空容器；opts.initial：{ placeId, lat, lng, name, address, source } | null
// opts.bias：{lat,lng} 搜尋偏好中心；opts.getTitle：() => 目前「名稱」欄位文字（沒輸入關鍵字時的預設搜尋字）
// 回傳 { get() }：取得目前選定的地點（或 null）
export function mountPlacePicker(root, opts = {}) {
  let current = opts.initial && typeof opts.initial.lat === "number" ? { ...opts.initial } : null;
  let token = newSessionToken();
  let timer = null;
  let composing = false;
  let seq = 0;

  root.textContent = "";
  const chip = document.createElement("div");
  chip.className = "place-chip";
  const inputRow = document.createElement("div");
  inputRow.className = "place-input-row";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "搜尋並選擇地點（用來計算交通時間）";
  input.setAttribute("autocomplete", "off");
  const list = document.createElement("div");
  list.className = "place-suggest-list hidden";
  const hint = document.createElement("div");
  hint.className = "place-hint";
  inputRow.appendChild(input);
  root.append(chip, inputRow, list, hint);

  function renderChip() {
    chip.textContent = "";
    if (!current) { chip.classList.add("hidden"); return; }
    chip.classList.remove("hidden");
    const txt = document.createElement("div");
    txt.className = "place-chip-text";
    const a = document.createElement("strong");
    a.textContent = "📍 " + (current.name || "已選定地點");
    txt.appendChild(a);
    if (current.address) {
      const b = document.createElement("span");
      b.textContent = current.address;
      txt.appendChild(b);
    }
    if (current.source === "auto") {
      const c = document.createElement("em");
      c.textContent = "自動比對的結果，請確認是否正確，不對請重新搜尋";
      txt.appendChild(c);
    } else if (current.source === "url") {
      const c = document.createElement("em");
      c.textContent = "座標取自地圖連結";
      txt.appendChild(c);
    }
    const x = document.createElement("button");
    x.type = "button";
    x.className = "secondary-btn small-btn";
    x.textContent = "清除";
    x.addEventListener("click", () => { current = null; renderChip(); });
    chip.append(txt, x);
  }
  renderChip();

  function setHint(msg) { hint.textContent = msg || ""; }
  function hideList() { list.classList.add("hidden"); list.textContent = ""; }

  async function search() {
    const q = input.value.trim();
    if (q.length < 2) { hideList(); setHint(""); return; }
    const my = ++seq;
    setHint("搜尋中…");
    try {
      const items = await placeAutocomplete(q, token, opts.bias);
      if (my !== seq) return;
      list.textContent = "";
      if (!items.length) { hideList(); setHint("找不到符合的地點，可換個關鍵字（例如加上城市名）"); return; }
      setHint("");
      items.forEach((it) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "place-suggest-item";
        const n = document.createElement("strong");
        n.textContent = it.name;
        const s = document.createElement("span");
        s.textContent = it.secondary;
        b.append(n, s);
        b.addEventListener("click", async () => {
          setHint("取得地點資料…");
          try {
            const d = await placeDetails(it.placeId, token);
            current = { placeId: d.placeId, lat: d.lat, lng: d.lng, name: it.name, address: d.address || it.secondary, source: "picked" };
            token = newSessionToken(); // 一個 session 結束，下次搜尋換新的
            input.value = "";
            hideList(); setHint("");
            renderChip();
            if (typeof opts.onPick === "function") opts.onPick(current);
          } catch (e) {
            setHint("無法取得地點：" + friendlyApiError(e));
          }
        });
        list.appendChild(b);
      });
      list.classList.remove("hidden");
    } catch (e) {
      if (my !== seq) return;
      hideList();
      setHint("搜尋失敗：" + friendlyApiError(e));
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (composing) return;
    timer = setTimeout(search, 350);
  }
  input.addEventListener("input", schedule);
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; schedule(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(timer); search(); } });
  input.addEventListener("focus", () => {
    if (!input.value && typeof opts.getTitle === "function") {
      const t = (opts.getTitle() || "").trim();
      if (t) input.placeholder = `搜尋並選擇地點，例如：${t}`;
    }
  });

  return { get: () => current };
}
