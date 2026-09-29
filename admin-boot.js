// v21p5：防點擊劫持（GitHub Pages 無法設定 X-Frame-Options，改用前端防護）。被嵌入 iframe 時隱藏並嘗試跳出。
if (window.top !== window.self) {
  document.documentElement.style.display = "none";
  try { window.top.location = window.self.location; } catch (e) { /* 跨網域被擋，維持隱藏 */ }
}

// 取代原本 admin.html 上的內嵌 onerror（CSP 不允許）。
import("./admin.js?v=21p5").catch(function (err) {
  var root = document.getElementById("admin-root");
  if (!root) return;
  root.innerHTML = "";
  var card = document.createElement("div");
  card.className = "admin-card";
  var h = document.createElement("h1");
  h.textContent = "管理後台載入失敗";
  var p = document.createElement("p");
  p.className = "admin-muted";
  p.textContent = "管理程式載入失敗，請重新整理頁面；若仍發生，請確認 GitHub Pages 已部署最新 v21p5 檔案。" + (err && err.message ? "（" + err.message + "）" : "");
  card.appendChild(h); card.appendChild(p); root.appendChild(card);
});
