// ============================================================
// 管理員後台 - admin.js
// 與一般使用者頁面（app.js）完全分開的獨立程式。
// 這裡不會、也不需要引用 app.js 的任何東西（複製了少數幾個同名的小工具函式，
// 例如 escapeHtml／renderBlockView，避免兩邊互相依賴）。
// ============================================================

import { db, auth, adminSignIn, adminSignOut, onAuthStateChanged } from "./admin-firebase-config.js";
import {
  collection, doc, getDoc, getDocs, updateDoc, query, orderBy, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const root = document.getElementById("admin-root");

let currentUser = null;
let tripsCache = [];

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
      <p class="admin-muted">
        「檢視內容」會用管理員身份直接唯讀顯示天數、景點、許願池留言與記帳明細，不需要先加入該行程。
        「停用」會讓所有成員（含統籌人）都無法再檢視或編輯行程內容，只有管理員能恢復。
      </p>
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
  tbodyEl.innerHTML = tripsCache.map((t) => `
    <tr>
      <td>${escapeHtml(t.name || "（未命名）")}</td>
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
    await updateDoc(doc(db, "trips", tripId), {
      disabled: nextDisabled,
      disabledAt: serverTimestamp(),
      disabledBy: currentUser?.uid || null,
    });
    trip.disabled = nextDisabled;
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
function renderMembersSection(trip) {
  const members = trip.members || [];
  return `
    <h2 class="admin-section-title">👥 成員與權限</h2>
    ${members.length === 0 ? `<p class="admin-muted">沒有成員資料。</p>` : `
      <table class="admin-table">
        <thead><tr><th>名稱</th><th>權限</th><th>綁定裝置數</th></tr></thead>
        <tbody>
          ${members.map((m) => `
            <tr>
              <td>${escapeHtml(m.name || "（未命名）")}</td>
              <td>${escapeHtml(permissionLabel(m.permission))}</td>
              <td>${Array.isArray(m.uids) ? m.uids.length : (m.uid ? 1 : 0)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `}
  `;
}

async function showTripDetail(tripId) {
  const trip = tripsCache.find((t) => t.id === tripId);
  if (!trip) return;

  render(`
    <div class="admin-card">
      <button id="admin-back-btn" class="admin-secondary-btn" style="margin-bottom:12px;">← 回到行程清單</button>
      <h1>${escapeHtml(trip.name || "（未命名）")}</h1>
      <p class="admin-muted">行程 ID：<code>${escapeHtml(trip.id)}</code>　建立時間：${fmtDate(trip.createdAt)}</p>
      <p class="admin-muted">載入內容中...</p>
    </div>
  `);
  document.getElementById("admin-back-btn").onclick = () => showTripList(currentUser);

  try {
    const daysSnap = await getDocs(query(collection(db, "trips", tripId, "days"), orderBy("order", "asc")));
    const days = daysSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const daysWithSpots = await Promise.all(days.map(async (day) => {
      const spotsSnap = await getDocs(query(collection(db, "trips", tripId, "days", day.id, "spots"), orderBy("order", "asc")));
      const spots = spotsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const spotsWithWishes = await Promise.all(spots.map(async (spot) => {
        const wishesSnap = await getDocs(query(collection(db, "trips", tripId, "days", day.id, "spots", spot.id, "wishes"), orderBy("createdAt", "desc")));
        const wishes = wishesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return { ...spot, wishes };
      }));
      return { ...day, spots: spotsWithWishes };
    }));

    const expensesSnap = await getDocs(query(collection(db, "trips", tripId, "expenses"), orderBy("date", "asc")));
    const expenses = expensesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const memberNameById = {};
    (trip.members || []).forEach((m) => { memberNameById[m.id] = m.name; });

    render(`
      <div class="admin-card">
        <button id="admin-back-btn" class="admin-secondary-btn" style="margin-bottom:12px;">← 回到行程清單</button>
        <div class="admin-topbar">
          <div>
            <h1>${escapeHtml(trip.name || "（未命名）")}</h1>
            <p class="admin-muted">行程 ID：<code>${escapeHtml(trip.id)}</code>　建立時間：${fmtDate(trip.createdAt)}</p>
          </div>
          <div style="text-align:right;">
            <span class="admin-badge ${trip.disabled === true ? "admin-badge-disabled" : "admin-badge-active"}">${trip.disabled === true ? "已停用" : "啟用中"}</span><br/>
            <button id="admin-toggle-btn" class="admin-secondary-btn" style="margin-top:8px;">${trip.disabled === true ? "恢復啟用" : "停用此行程"}</button>
          </div>
        </div>
        <p class="admin-muted">以下內容為唯讀檢視，管理後台不提供編輯功能；要編輯請透過一般行程頁面，並先成為該行程的成員。</p>

        ${renderMembersSection(trip)}

        <h2 class="admin-section-title">📅 天數與景點</h2>
        ${daysWithSpots.length === 0 ? `<p class="admin-muted">目前沒有任何天數。</p>` : daysWithSpots.map((day) => `
          <div class="admin-day-block">
            <h3>${escapeHtml(day.title || "（未命名天數）")}${day.date ? `　${escapeHtml(day.date)}` : ""}</h3>
            ${(day.blocks || []).length ? `<div class="admin-blocks">${day.blocks.map(renderBlockView).join("")}</div>` : ""}
            ${day.spots.length === 0 ? `<p class="admin-muted" style="margin-left:12px;">（沒有景點）</p>` : day.spots.map((spot) => `
              <div class="admin-spot-block">
                <h4>${escapeHtml(spot.title || "（未命名景點）")}${spot.time ? `　${escapeHtml(spot.time)}` : ""}</h4>
                ${(spot.blocks || []).length ? `<div class="admin-blocks">${spot.blocks.map(renderBlockView).join("")}</div>` : ""}
                ${spot.wishes.length ? `
                  <div class="admin-wishes">
                    <p class="admin-muted" style="margin:8px 0 4px;">許願池留言（${spot.wishes.length}）：</p>
                    ${spot.wishes.map((w) => `
                      <div class="admin-wish">
                        <div class="admin-wish-meta">${escapeHtml(w.authorName || "匿名旅伴")}　${fmtDate(w.createdAt)}</div>
                        ${w.text ? `<div>${escapeHtml(w.text)}</div>` : ""}
                        ${w.imageUrl ? `<img src="${escapeHtml(w.imageUrl)}" loading="lazy" style="max-width:160px;border-radius:6px;margin-top:4px;">` : ""}
                      </div>
                    `).join("")}
                  </div>
                ` : ""}
              </div>
            `).join("")}
          </div>
        `).join("")}

        <h2 class="admin-section-title">💰 記帳明細</h2>
        ${expenses.length === 0 ? `<p class="admin-muted">目前沒有任何記帳明細。</p>` : `
          <table class="admin-table">
            <thead><tr><th>日期</th><th>項目</th><th>金額</th><th>付款人</th><th>分攤對象</th><th>備註</th></tr></thead>
            <tbody>
              ${expenses.map((e) => `
                <tr>
                  <td>${escapeHtml(e.date || "")}</td>
                  <td>${escapeHtml(e.title || "")}</td>
                  <td>${fmtMoney(e.amountCents)} ${escapeHtml(e.currency || "")}</td>
                  <td>${escapeHtml(memberNameById[e.payerId] || e.payerId || "")}</td>
                  <td>${(e.splitWith || []).map((id) => escapeHtml(memberNameById[id] || id)).join("、")}</td>
                  <td>${escapeHtml(e.note || "")}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
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
    render(`
      <div class="admin-card">
        <button id="admin-back-btn" class="admin-secondary-btn" style="margin-bottom:12px;">← 回到行程清單</button>
        <p class="admin-muted">載入行程內容失敗：${escapeHtml(err.message || String(err))}</p>
      </div>
    `);
    document.getElementById("admin-back-btn").onclick = () => showTripList(currentUser);
  }
}

// ------------------------------------------------------------
// 進入點
// ------------------------------------------------------------
async function isAdminUser(uid) {
  const snap = await getDoc(doc(db, "admins", uid));
  return snap.exists();
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
