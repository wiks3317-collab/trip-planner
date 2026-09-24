// ============================================================
// 管理員後台 - admin.js
// 與一般使用者頁面（app.js）完全分開的獨立程式。
// 這裡不會、也不需要引用 app.js 的任何東西（複製了少數幾個同名的小工具函式，
// 例如 escapeHtml／renderBlockView，避免兩邊互相依賴）。
// ============================================================

import { db, auth, adminSignIn, adminSignOut, onAuthStateChanged } from "./admin-firebase-config.js";
import {
  collection, doc, getDoc, getDocs, updateDoc, query, orderBy, serverTimestamp, writeBatch, limit,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const root = document.getElementById("admin-root");

let currentUser = null;
let tripsCache = [];
let adminCanEdit = false;
let detailCtx = null;

// ------------------------------------------------------------
// 小工具（獨立複製一份，不依賴 app.js）
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

function fmtDate(ts) {
  try {
    if (!ts) return "（無資料）";
    const d = typeof ts.toDate === "function" ? ts.toDate() : new Date(ts);
    return d.toLocaleString("zh-Hant-TW", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "（無資料）";
  }
}

function fmtMoney(cents) {
  const v = Math.round(cents || 0) / 100;
  return v.toLocaleString("zh-Hant-TW", { maximumFractionDigits: 0 });
}

function permissionLabel(p) {
  if (p === "owner") return "統籌人";
  if (p === "editor") return "可編輯";
  if (p === "viewer") return "唯讀";
  return p || "—";
}

// 內容區塊（文字／圖片／表格）唯讀渲染，對應 app.js 的 renderBlockView，
// 只給管理後台的唯讀檢視用，沒有任何編輯功能。
function renderBlockView(block) {
  if (!block) return "";
  if (block.type === "text") {
    return `<div class="admin-block-text">${escapeHtml(block.content)}</div>`;
  }
  if (block.type === "image") {
    return `<figure class="admin-block-image"><img src="${escapeHtml(block.url)}" alt="${escapeHtml(block.caption || "")}" loading="lazy">${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ""}</figure>`;
  }
  if (block.type === "table") {
    const rows = block.rows || [];
    return `<div class="admin-block-table"><table>${rows.map((row, ri) => `<tr>${row.map((c) => ri === 0 ? `<th>${escapeHtml(c)}</th>` : `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</table></div>`;
  }
  return "";
}

function render(html) {
  root.innerHTML = html;
}

// ------------------------------------------------------------
// 登入前／非管理員畫面
// ------------------------------------------------------------
function renderSignedOut() {
  render(`
    <div class="admin-card">
      <h1>行程規劃工具 · 管理後台</h1>
      <p class="admin-muted">這裡只給系統管理員使用，一般行程請直接用行程連結開啟，不需要從這裡登入。</p>
      <button id="admin-signin-btn" class="admin-primary-btn">使用 Google 帳號登入</button>
    </div>
  `);
  document.getElementById("admin-signin-btn").onclick = async () => {
    try {
      await adminSignIn();
    } catch (err) {
      console.error(err);
      render(`
        <div class="admin-card">
          <h1>登入失敗</h1>
          <p class="admin-muted">${escapeHtml(err.message || String(err))}</p>
          <button id="admin-retry-btn" class="admin-secondary-btn">重試</button>
        </div>
      `);
      document.getElementById("admin-retry-btn").onclick = () => renderSignedOut();
    }
  };
}

function renderNotAdmin(user) {
  render(`
    <div class="admin-card">
      <h1>沒有管理員權限</h1>
      <p class="admin-muted">
        已用 Google 帳號「${escapeHtml(user.email || "")}」登入，
        但這個帳號的 UID 還沒被加進 <code>admins</code> 集合，所以無法查看管理後台。
      </p>
      <p>你的 UID（把這串貼到 Firebase Console 的 <code>admins</code> 集合，當作文件 ID）：</p>
      <div class="admin-uid-box">${escapeHtml(user.uid)}</div>
      <button id="admin-signout-btn" class="admin-secondary-btn">登出</button>
    </div>
  `);
  document.getElementById("admin-signout-btn").onclick = () => adminSignOut();
}

// ------------------------------------------------------------
// 行程清單（摘要）
// ------------------------------------------------------------
function dashboardShellHtml(user) {
  return `
    <div class="admin-card">
      <div class="admin-topbar">
        <div>
          <h1>管理後台</h1>
          <p class="admin-muted">登入身份：${escapeHtml(user.email || user.uid)}</p>
        </div>
        <button id="admin-signout-btn" class="admin-secondary-btn">登出</button>
      </div>
      <div class="admin-row-actions" style="margin:8px 0;"><button class="admin-secondary-btn" data-act="audit">📜 稽核紀錄</button></div>
      <p class="admin-muted">
        「檢視內容」會用管理員身份直接顯示天數、景點、許願池留言與記帳明細，不需要先加入該行程。
        「停用」會讓所有成員（含統籌人）都無法再檢視或編輯行程內容，只有管理員能恢復。
      </p>
      <div class="admin-row-actions" style="margin:8px 0;"><input id="admin-search" type="search" placeholder="搜尋行程名稱或 ID" style="flex:1;min-width:160px;padding:8px 10px;border:1px solid var(--border,#DCE3DC);border-radius:8px;font:inherit;"><select id="admin-filter" style="padding:8px;border-radius:8px;border:1px solid var(--border,#DCE3DC);font:inherit;"><option value="all">全部</option><option value="active">啟用中</option><option value="disabled">已停用</option></select></div>
      <div id="admin-trips-status" class="admin-muted hidden"></div>
      <table class="admin-table" id="admin-trips-table">
        <thead>
          <tr>
            <th>行程名稱</th>
            <th>成員數</th>
            <th>建立時間</th>
            <th>狀態</th>
            <th>行程 ID</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="admin-trips-tbody"></tbody>
      </table>
    </div>
  `;
}

function showTripList(user) {
  render(dashboardShellHtml(user));
  document.getElementById("admin-signout-btn").onclick = () => adminSignOut();
  renderTripsTable();
}

function renderTripsTable() {
  const tbodyEl = document.getElementById("admin-trips-tbody");
  if (!tbodyEl) return;
  const searchEl = document.getElementById("admin-search");
  const filterEl = document.getElementById("admin-filter");
  if (searchEl && !searchEl.dataset.bound) {
    searchEl.dataset.bound = "1";
    searchEl.oninput = renderTripsTable;
    filterEl.onchange = renderTripsTable;
  }
  const kw = (searchEl?.value || "").trim().toLowerCase();
  const st = filterEl?.value || "all";
  const rows = tripsCache.filter((t) =>
    (st === "all" || (st === "disabled") === (t.disabled === true)) &&
    (!kw || (t.name || "").toLowerCase().includes(kw) || t.id.toLowerCase().includes(kw)));
  tbodyEl.innerHTML = rows.map((t) => `
    <tr>
      <td>${escapeHtml(t.name || "（未命名）")}<div class="admin-muted" style="font-size:12px;">統籌人：${escapeHtml(ownerNames(t))}</div></td>
      <td>${Array.isArray(t.members) ? t.members.length : "—"}</td>
      <td>${fmtDate(t.createdAt)}</td>
      <td>${t.disabled === true ? '<span class="admin-badge admin-badge-disabled">已停用</span>' : '<span class="admin-badge admin-badge-active">啟用中</span>'}</td>
      <td><code>${escapeHtml(t.id)}</code></td>
      <td class="admin-row-actions">
        <button class="admin-link-btn" data-action="detail" data-tripid="${escapeHtml(t.id)}">檢視內容</button>
        <a class="admin-link" href="./index.html#/trip/${encodeURIComponent(t.id)}" target="_blank" rel="noopener">開啟行程 →</a>
        <button class="admin-link-btn admin-danger" data-action="toggle" data-tripid="${escapeHtml(t.id)}">${t.disabled === true ? "恢復啟用" : "停用"}</button>
      </td>
    </tr>
  `).join("");

  tbodyEl.querySelectorAll('[data-action="detail"]').forEach((btn) => {
    btn.onclick = () => showTripDetail(btn.dataset.tripid);
  });
  tbodyEl.querySelectorAll('[data-action="toggle"]').forEach((btn) => {
    btn.onclick = () => toggleTripDisabled(btn.dataset.tripid).then(() => renderTripsTable());
  });
}

async function renderDashboard(user) {
  currentUser = user;
  render(dashboardShellHtml(user));
  document.getElementById("admin-signout-btn").onclick = () => adminSignOut();

  const statusEl = document.getElementById("admin-trips-status");
  statusEl.classList.remove("hidden");
  statusEl.textContent = "載入行程清單中...";

  try {
    const snap = await getDocs(collection(db, "trips"));
    tripsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    tripsCache.sort((a, b) => {
      const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
      const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
      return tb - ta;
    });

    if (tripsCache.length === 0) {
      statusEl.textContent = "目前 Firestore 裡還沒有任何行程。";
      return;
    }

    statusEl.classList.add("hidden");
    renderTripsTable();
  } catch (err) {
    console.error(err);
    statusEl.classList.remove("hidden");
    statusEl.textContent = "載入行程清單失敗：" + (err.message || String(err)) +
      "（如果剛部署新的 firestore.rules，請確認已在 Firebase Console 按「發布」）";
  }
}

// ------------------------------------------------------------
// 停用／恢復啟用
// ------------------------------------------------------------
async function toggleTripDisabled(tripId) {
  const trip = tripsCache.find((t) => t.id === tripId);
  if (!trip) return false;
  const nextDisabled = trip.disabled !== true;
  const confirmMsg = nextDisabled
    ? `確定要停用行程「${trip.name || tripId}」嗎？\n停用後，所有成員（含統籌人）都無法再檢視或編輯內容，只有管理員能恢復。`
    : `確定要恢復啟用行程「${trip.name || tripId}」嗎？\n恢復後，原本的成員與權限會照舊生效。`;
  if (!window.confirm(confirmMsg)) return false;

  try {
    let reason = "";
    if (nextDisabled) {
      const input = window.prompt("停用原因（選填，會顯示在管理後台）：", "");
      if (input === null) return false;
      reason = input.trim().slice(0, 300);
    }
    const upd = nextDisabled
      ? { disabled: true, disabledAt: serverTimestamp(), disabledBy: currentUser?.uid || null, disabledReason: reason }
      : { disabled: false, disabledAt: null, disabledBy: currentUser?.uid || null, disabledReason: "" };
    await commitWithAudit(tripId, nextDisabled ? "disable" : "enable", { reason }, (b) => b.update(doc(db, "trips", tripId), upd));
    Object.assign(trip, upd);
    return true;
  } catch (err) {
    console.error(err);
    window.alert("操作失敗：" + (err.message || String(err)));
    return false;
  }
}

// ------------------------------------------------------------
// 行程完整內容（唯讀檢視）
// ------------------------------------------------------------
function ownerNames(trip) {
  return (trip.members || []).filter((m) => m.permission === "owner").map((m) => m.name || "（未命名）").join("、") || "—";
}

// ------------------------------------------------------------
// 稽核紀錄：所有管理員的寫入都跟一筆 adminAuditLogs 放在同一個 batch 裡一起提交
// ------------------------------------------------------------
async function commitWithAudit(tripId, action, detail, build) {
  const batch = writeBatch(db);
  build(batch);
  batch.set(doc(collection(db, "adminAuditLogs")), {
    adminUid: currentUser?.uid || null,
    adminEmail: currentUser?.email || null,
    tripId,
    action,
    detail: detail || {},
    createdAt: serverTimestamp(),
  });
  await batch.commit();
}

const btn = (act, label, data = {}, danger = false) =>
  `<button class="admin-link-btn${danger ? " admin-danger" : ""}" data-act="${act}" ${Object.entries(data).map(([k, v]) => `data-${k}="${escapeHtml(v)}"`).join(" ")}>${label}</button>`;

function renderMembersSection(trip) {
  const members = trip.members || [];
  return `
    <h2 class="admin-section-title">👥 成員與權限</h2>
    ${members.length === 0 ? `<p class="admin-muted">沒有成員資料。</p>` : `
      <table class="admin-table">
        <thead><tr><th>名稱</th><th>權限</th><th>綁定 UID</th></tr></thead>
        <tbody>
          ${members.map((m) => {
            const uids = Array.isArray(m.uids) ? m.uids : (m.uid ? [m.uid] : []);
            return `<tr><td>${escapeHtml(m.name || "（未命名）")}</td><td>${escapeHtml(permissionLabel(m.permission))}</td><td><code style="font-size:11px;word-break:break-all;">${uids.map(escapeHtml).join("<br>") || "—"}</code></td></tr>`;
          }).join("")}
        </tbody>
      </table>
    `}
  `;
}

// ------------------------------------------------------------
// 行程內容載入（許願池留言預設不載入，點開才讀，匯出時才全部讀）
// ------------------------------------------------------------
async function loadWishes(tripId, dayId, spotId) {
  const snap = await getDocs(query(collection(db, "trips", tripId, "days", dayId, "spots", spotId, "wishes"), orderBy("createdAt", "desc")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadTripTree(tripId, withWishes) {
  const daysSnap = await getDocs(query(collection(db, "trips", tripId, "days"), orderBy("order", "asc")));
  const days = await Promise.all(daysSnap.docs.map(async (d) => {
    const spotsSnap = await getDocs(query(collection(db, "trips", tripId, "days", d.id, "spots"), orderBy("order", "asc")));
    const spots = await Promise.all(spotsSnap.docs.map(async (s) => {
      const spot = { id: s.id, ...s.data() };
      if (withWishes) spot.wishes = await loadWishes(tripId, d.id, s.id);
      return spot;
    }));
    return { id: d.id, ...d.data(), spots };
  }));
  const expSnap = await getDocs(query(collection(db, "trips", tripId, "expenses"), orderBy("date", "asc")));
  return { days, expenses: expSnap.docs.map((d) => ({ id: d.id, ...d.data() })) };
}

function renderBlocksAdmin(blocks, dayId, spotId) {
  return (blocks || []).map((b, i) => `
    <div>${renderBlockView(b)}${adminCanEdit ? `<div class="admin-row-actions">${b.type === "text" ? btn("block-edit", "編輯文字", { day: dayId, spot: spotId || "", idx: i }) : ""}${btn("block-del", "移除區塊", { day: dayId, spot: spotId || "", idx: i }, true)}</div>` : ""}</div>
  `).join("");
}

function wishesHtml(wishes, dayId, spotId) {
  if (!wishes.length) return `<p class="admin-muted">沒有許願池留言。</p>`;
  return wishes.map((w) => `
    <div class="admin-wish">
      <div class="admin-wish-meta">${escapeHtml(w.authorName || "匿名旅伴")}　${fmtDate(w.createdAt)}</div>
      ${w.text ? `<div>${escapeHtml(w.text)}</div>` : ""}
      ${w.imageUrl ? `<img src="${escapeHtml(w.imageUrl)}" loading="lazy" style="max-width:160px;border-radius:6px;margin-top:4px;">` : ""}
      ${adminCanEdit ? btn("wish-del", "刪除留言", { day: dayId, spot: spotId, wish: w.id }, true) : ""}
    </div>
  `).join("");
}

async function showTripDetail(tripId) {
  const trip = tripsCache.find((t) => t.id === tripId);
  if (!trip) return;
  const back = `<button id="admin-back-btn" class="admin-secondary-btn" style="margin-bottom:12px;">← 回到行程清單</button>`;
  render(`<div class="admin-card">${back}<h1>${escapeHtml(trip.name || "（未命名）")}</h1><p class="admin-muted">載入內容中...</p></div>`);
  document.getElementById("admin-back-btn").onclick = () => showTripList(currentUser);

  try {
    const tree = await loadTripTree(tripId, false);
    detailCtx = { tripId, trip, tree };
    const memberNameById = {};
    (trip.members || []).forEach((m) => { memberNameById[m.id] = m.name; });
    const disabled = trip.disabled === true;

    render(`
      <div class="admin-card">
        ${back}
        <div class="admin-topbar">
          <div>
            <h1>${escapeHtml(trip.name || "（未命名）")}</h1>
            <p class="admin-muted">行程 ID：<code>${escapeHtml(trip.id)}</code>　建立時間：${fmtDate(trip.createdAt)}</p>
            ${disabled && trip.disabledReason ? `<p class="admin-muted">停用原因：${escapeHtml(trip.disabledReason)}</p>` : ""}
          </div>
          <div style="text-align:right;">
            <span class="admin-badge ${disabled ? "admin-badge-disabled" : "admin-badge-active"}">${disabled ? "已停用" : "啟用中"}</span><br/>
            <button id="admin-toggle-btn" class="admin-secondary-btn" style="margin-top:8px;">${disabled ? "恢復啟用" : "停用此行程"}</button>
          </div>
        </div>
        <div class="admin-row-actions" style="margin:8px 0;">${btn("export", "⬇ 匯出 JSON")}${adminCanEdit ? btn("rename", "✏️ 修改行程名稱") : ""}</div>
        <p class="admin-muted">${adminCanEdit ? "你的帳號具有編輯權限，所有修改都會寫入稽核紀錄。" : "目前是唯讀檢視（此帳號的 admins 文件尚未設定 canEdit: true）。"}</p>

        ${renderMembersSection(trip)}

        <h2 class="admin-section-title">📅 天數與景點</h2>
        ${tree.days.length === 0 ? `<p class="admin-muted">目前沒有任何天數。</p>` : tree.days.map((day) => `
          <div class="admin-day-block">
            <h3>${escapeHtml(day.title || "（未命名天數）")}${day.date ? `　${escapeHtml(day.date)}` : ""}</h3>
            ${(day.blocks || []).length ? `<div class="admin-blocks">${renderBlocksAdmin(day.blocks, day.id, "")}</div>` : ""}
            ${day.spots.length === 0 ? `<p class="admin-muted" style="margin-left:12px;">（沒有景點）</p>` : day.spots.map((spot) => `
              <div class="admin-spot-block">
                <h4>${escapeHtml(spot.title || "（未命名景點）")}${spot.time ? `　${escapeHtml(spot.time)}` : ""}</h4>
                ${adminCanEdit ? `<div class="admin-row-actions">${btn("spot-edit", "編輯名稱／時間", { day: day.id, spot: spot.id })}${btn("spot-del", "刪除景點", { day: day.id, spot: spot.id }, true)}</div>` : ""}
                ${(spot.blocks || []).length ? `<div class="admin-blocks">${renderBlocksAdmin(spot.blocks, day.id, spot.id)}</div>` : ""}
                <div class="admin-wishes">${btn("wishes", "載入許願池留言", { day: day.id, spot: spot.id })}<div id="wishes-${escapeHtml(spot.id)}"></div></div>
              </div>
            `).join("")}
          </div>
        `).join("")}

        <h2 class="admin-section-title">💰 記帳明細</h2>
        ${tree.expenses.length === 0 ? `<p class="admin-muted">目前沒有任何記帳明細。</p>` : `
          <div style="overflow-x:auto;"><table class="admin-table">
            <thead><tr><th>日期</th><th>項目</th><th>金額</th><th>付款人</th><th>分攤對象</th><th>備註</th>${adminCanEdit ? "<th></th>" : ""}</tr></thead>
            <tbody>
              ${tree.expenses.map((e) => `
                <tr>
                  <td>${escapeHtml(e.date || "")}</td>
                  <td>${escapeHtml(e.title || "")}</td>
                  <td>${fmtMoney(e.amountCents)} ${escapeHtml(e.currency || "")}</td>
                  <td>${escapeHtml(memberNameById[e.payerId] || e.payerId || "")}</td>
                  <td>${(e.splitWith || []).map((id) => escapeHtml(memberNameById[id] || id)).join("、")}</td>
                  <td>${escapeHtml(e.note || "")}</td>
                  ${adminCanEdit ? `<td>${btn("exp-del", "刪除", { exp: e.id }, true)}</td>` : ""}
                </tr>
              `).join("")}
            </tbody>
          </table></div>
        `}
      </div>
    `);
    document.getElementById("admin-back-btn").onclick = () => showTripList(currentUser);
    document.getElementById("admin-toggle-btn").onclick = async () => {
      const ok = await toggleTripDisabled(tripId);
      if (ok) showTripDetail(tripId);
    };
  } catch (err) {
    console.error(err);
    render(`<div class="admin-card">${back}<p class="admin-muted">載入行程內容失敗：${escapeHtml(err.message || String(err))}</p></div>`);
    document.getElementById("admin-back-btn").onclick = () => showTripList(currentUser);
  }
}

// ------------------------------------------------------------
// 匯出 JSON（也會留下稽核紀錄）
// ------------------------------------------------------------
async function exportTrip() {
  const { tripId, trip } = detailCtx;
  const tree = await loadTripTree(tripId, true);
  const payload = { exportedAt: new Date().toISOString(), trip: { ...trip }, days: tree.days, expenses: tree.expenses };
  const json = JSON.stringify(payload, function (k, v) {
    const raw = this[k];
    return raw && typeof raw.toDate === "function" ? raw.toDate().toISOString() : v;
  }, 2);
  await commitWithAudit(tripId, "export", { days: tree.days.length, expenses: tree.expenses.length }, () => {});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  a.download = `trip-${tripId}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ------------------------------------------------------------
// 稽核紀錄檢視（最近 100 筆）
// ------------------------------------------------------------
async function showAuditLog() {
  const back = `<button id="admin-back-btn" class="admin-secondary-btn" style="margin-bottom:12px;">← 回到行程清單</button>`;
  render(`<div class="admin-card">${back}<p class="admin-muted">載入稽核紀錄中...</p></div>`);
  document.getElementById("admin-back-btn").onclick = () => showTripList(currentUser);
  try {
    const snap = await getDocs(query(collection(db, "adminAuditLogs"), orderBy("createdAt", "desc"), limit(100)));
    const logs = snap.docs.map((d) => d.data());
    render(`
      <div class="admin-card">
        ${back}
        <h1>稽核紀錄</h1>
        <p class="admin-muted">最近 ${logs.length} 筆管理員操作（只能新增、不能修改或刪除）。</p>
        <div style="overflow-x:auto;"><table class="admin-table">
          <thead><tr><th>時間</th><th>管理員</th><th>動作</th><th>行程 ID</th><th>內容</th></tr></thead>
          <tbody>${logs.map((l) => `<tr><td>${fmtDate(l.createdAt)}</td><td>${escapeHtml(l.adminEmail || l.adminUid || "")}</td><td>${escapeHtml(l.action || "")}</td><td><code>${escapeHtml(l.tripId || "")}</code></td><td style="font-size:12px;word-break:break-all;">${escapeHtml(JSON.stringify(l.detail || {}))}</td></tr>`).join("")}</tbody>
        </table></div>
      </div>
    `);
    document.getElementById("admin-back-btn").onclick = () => showTripList(currentUser);
  } catch (err) {
    console.error(err);
    render(`<div class="admin-card">${back}<p class="admin-muted">載入失敗：${escapeHtml(err.message || String(err))}</p></div>`);
    document.getElementById("admin-back-btn").onclick = () => showTripList(currentUser);
  }
}

// ------------------------------------------------------------
// 詳細頁的按鈕事件（事件委派）
// ------------------------------------------------------------
async function onRootClick(e) {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const d = el.dataset;
  try {
    if (d.act === "audit") return await showAuditLog();
    if (!detailCtx) return;
    const { tripId, trip, tree } = detailCtx;
    if (d.act === "export") return await exportTrip();
    if (d.act === "wishes") {
      el.disabled = true;
      el.textContent = "載入中...";
      const wishes = await loadWishes(tripId, d.day, d.spot);
      document.getElementById(`wishes-${d.spot}`).innerHTML = wishesHtml(wishes, d.day, d.spot);
      el.remove();
      return;
    }
    if (!adminCanEdit) return;

    const day = tree.days.find((x) => x.id === d.day);
    const spot = day?.spots.find((x) => x.id === d.spot);
    const dayRef = () => doc(db, "trips", tripId, "days", d.day);
    const spotRef = () => doc(db, "trips", tripId, "days", d.day, "spots", d.spot);

    if (d.act === "rename") {
      const input = window.prompt("新的行程名稱（1～200 字）", trip.name || "");
      if (input === null) return;
      const name = input.trim();
      if (!name || name.length > 200) return window.alert("名稱長度必須在 1～200 字之間");
      await commitWithAudit(tripId, "rename", { from: trip.name || "", to: name }, (b) => b.update(doc(db, "trips", tripId), { name }));
      trip.name = name;
    } else if (d.act === "spot-edit") {
      const title = window.prompt("景點名稱", spot?.title || "");
      if (title === null) return;
      const time = window.prompt("時間（可留空）", spot?.time || "");
      if (time === null) return;
      if (title.length > 500) return window.alert("名稱太長（上限 500 字）");
      await commitWithAudit(tripId, "spot-edit", { dayId: d.day, spotId: d.spot, fromTitle: spot?.title || "", toTitle: title.trim() }, (b) => b.update(spotRef(), { title: title.trim(), time: time.trim() }));
    } else if (d.act === "spot-del") {
      if (!window.confirm(`確定要刪除景點「${spot?.title || ""}」與它的所有留言嗎？此動作無法復原（建議先匯出 JSON）。`)) return;
      const wishes = await loadWishes(tripId, d.day, d.spot);
      if (wishes.length > 400) return window.alert("留言超過 400 則，請先個別刪除留言再刪景點");
      await commitWithAudit(tripId, "spot-delete", { dayId: d.day, spotId: d.spot, title: spot?.title || "", wishes: wishes.length }, (b) => {
        wishes.forEach((w) => b.delete(doc(db, "trips", tripId, "days", d.day, "spots", d.spot, "wishes", w.id)));
        b.delete(spotRef());
      });
    } else if (d.act === "wish-del") {
      if (!window.confirm("確定要刪除這則留言嗎？")) return;
      await commitWithAudit(tripId, "wish-delete", { dayId: d.day, spotId: d.spot, wishId: d.wish }, (b) => b.delete(doc(db, "trips", tripId, "days", d.day, "spots", d.spot, "wishes", d.wish)));
    } else if (d.act === "exp-del") {
      const exp = tree.expenses.find((x) => x.id === d.exp);
      if (!window.confirm(`確定要刪除記帳「${exp?.title || ""}」嗎？`)) return;
      await commitWithAudit(tripId, "expense-delete", { expenseId: d.exp, title: exp?.title || "", amountCents: exp?.amountCents ?? null }, (b) => b.delete(doc(db, "trips", tripId, "expenses", d.exp)));
    } else if (d.act === "block-edit" || d.act === "block-del") {
      const owner = d.spot ? spot : day;
      const blocks = [...(owner?.blocks || [])];
      const i = Number(d.idx);
      if (!blocks[i]) return;
      if (d.act === "block-edit") {
        const text = window.prompt("編輯文字內容", blocks[i].content || "");
        if (text === null) return;
        blocks[i] = { ...blocks[i], content: text };
      } else {
        if (!window.confirm("確定要移除這個內容區塊嗎？")) return;
        blocks.splice(i, 1);
      }
      await commitWithAudit(tripId, d.act, { dayId: d.day, spotId: d.spot || null, index: i }, (b) => b.update(d.spot ? spotRef() : dayRef(), { blocks }));
    } else {
      return;
    }
    await showTripDetail(tripId);
  } catch (err) {
    console.error(err);
    window.alert("操作失敗：" + (err.message || String(err)));
  }
}
root.addEventListener("click", onRootClick);

// ------------------------------------------------------------
// 進入點
// ------------------------------------------------------------
async function isAdminUser(uid) {
  const snap = await getDoc(doc(db, "admins", uid));
  return snap.exists() ? (snap.data() || {}) : null;
}

render(`<div class="admin-card"><p class="admin-muted">載入中...</p></div>`);

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    renderSignedOut();
    return;
  }
  try {
    const ok = await isAdminUser(user.uid);
    if (ok) {
      adminCanEdit = ok.canEdit === true;
      await renderDashboard(user);
    } else {
      renderNotAdmin(user);
    }
  } catch (err) {
    console.error(err);
    render(`
      <div class="admin-card">
        <h1>檢查管理員權限時發生錯誤</h1>
        <p class="admin-muted">${escapeHtml(err.message || String(err))}</p>
        <button id="admin-signout-btn" class="admin-secondary-btn">登出</button>
      </div>
    `);
    document.getElementById("admin-signout-btn").onclick = () => adminSignOut();
  }
});
