// ============================================================
// 管理員後台 - admin.js
// 與一般使用者頁面（app.js）完全分開的獨立程式。
// 這裡不會、也不需要引用 app.js 的任何東西。
// ============================================================

import { db, auth, adminSignIn, adminSignOut, onAuthStateChanged } from "./admin-firebase-config.js";
import {
  collection, doc, getDoc, getDocs,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const root = document.getElementById("admin-root");

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

function render(html) {
  root.innerHTML = html;
}

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
        但這個帳號的 UID 還沒被加進 <code>admins</code>集合，所以無法查看管理後台。
      </p>
      <p>你的 UID（把這串貼到 Firebase Console 的 <code>admins</code> 集合，當作文件 ID）：</p>
      <div class="admin-uid-box">${escapeHtml(user.uid)}</div>
      <button id="admin-signout-btn" class="admin-secondary-btn">登出</button>
    </div>
  `);
  document.getElementById("admin-signout-btn").onclick = () => adminSignOut();
}

async function renderDashboard(user) {
  render(`
    <div class="admin-card">
      <div class="admin-topbar">
        <div>
          <h1>管理後台</h1>
          <p class="admin-muted">登入身份：${escapeHtml(user.email || user.uid)}</p>
        </div>
        <button id="admin-signout-btn" class="admin-secondary-btn">登出</button>
      </div>
      <p class="admin-muted">
        目前只顯示每個行程的基本摘要（名稱、成員數、建立時間），不會直接顯示行程內容
        （天數、景點、留言、帳務）。要看完整內容，用下面的「開啟行程」連結，
        跟一般成員一樣受 Firestore Rules 保護。
      </p>
      <div id="admin-trips-status" class="admin-muted">載入行程清單中...</div>
      <table class="admin-table hidden" id="admin-trips-table">
        <thead>
          <tr>
            <th>行程名稱</th>
            <th>成員數</th>
            <th>建立時間</th>
            <th>行程 ID</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="admin-trips-tbody"></tbody>
      </table>
    </div>
  `);
  document.getElementById("admin-signout-btn").onclick = () => adminSignOut();

  const statusEl = document.getElementById("admin-trips-status");
  const tableEl = document.getElementById("admin-trips-table");
  const tbodyEl = document.getElementById("admin-trips-tbody");

  try {
    const snap = await getDocs(collection(db, "trips"));
    const trips = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    trips.sort((a, b) => {
      const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
      const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
      return tb - ta;
    });

    if (trips.length === 0) {
      statusEl.textContent = "目前 Firestore 裡還沒有任何行程。";
      return;
    }

    tbodyEl.innerHTML = trips.map((t) => `
      <tr>
        <td>${escapeHtml(t.name || "（未命名）")}</td>
        <td>${Array.isArray(t.members) ? t.members.length : "—"}</td>
        <td>${fmtDate(t.createdAt)}</td>
        <td><code>${escapeHtml(t.id)}</code></td>
        <td><a class="admin-link" href="./index.html#/trip/${encodeURIComponent(t.id)}" target="_blank" rel="noopener">開啟行程 →</a></td>
      </tr>
    `).join("");

    statusEl.classList.add("hidden");
    tableEl.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    statusEl.textContent = "載入行程清單失敗：" + (err.message || String(err)) +
      "（如果剛部署新的 firestore.rules，請確認已在 Firebase Console 按「發布」）";
  }
}

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
