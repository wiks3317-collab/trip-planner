// 由 index.html 內嵌腳本搬出（CSP 不允許內嵌 script）。
// v21p5：防點擊劫持（GitHub Pages 無法設定 X-Frame-Options，改用前端防護）。被嵌入 iframe 時隱藏並嘗試跳出。
if (window.top !== window.self) {
  document.documentElement.style.display = "none";
  try { window.top.location = window.self.location; } catch (e) { /* 跨網域被擋，維持隱藏 */ }
}
    (function () {
      function showError(titleText, err) {
        var root = document.getElementById("app-root");
        if (!root) return;
        var box = document.createElement("div");
        box.className = "card";
        box.style.cssText = "margin:20px;padding:20px;";
        var title = document.createElement("h3");
        title.textContent = titleText;
        var msg = document.createElement("pre");
        msg.style.cssText = "white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--text-muted);text-align:left;";
        var detail = "";
        if (err) {
          detail = err.stack || err.message || String(err);
        }
        msg.textContent = detail || "未取得錯誤內容。";
        var hint = document.createElement("p");
        hint.style.cssText = "font-size:12px;color:var(--text-muted);";
        hint.textContent = "這個畫面是診斷資訊。請把錯誤內容截圖給我，我可以據此定位是哪個 Firebase 模組或網站程式載入失敗。";
        box.appendChild(title);
        box.appendChild(msg);
        box.appendChild(hint);
        root.innerHTML = "";
        root.appendChild(box);
      }

      window.addEventListener("error", function (event) {
        if (event && event.error) {
          showError("⚠️ JavaScript 載入或執行錯誤", event.error);
        } else if (event && event.message) {
          showError("⚠️ JavaScript 載入或執行錯誤", new Error(event.message));
        }
      });

      window.addEventListener("unhandledrejection", function (event) {
        showError("⚠️ Promise 初始化錯誤", event ? event.reason : null);
      });

      import("./app.js?v=21p13").catch(function (err) {
        showError("⚠️ 網站程式載入失敗", err);
      });

      setTimeout(function () {
        if (document.getElementById("loading-screen")) {
          showError("⚠️ 網站初始化逾時", new Error("app.js 沒有在 10 秒內完成載入。這通常代表 Firebase CDN 模組、app.js 本身或其相依模組載入失敗。"));
        }
      }, 10000);
    }());

// v21p6：註冊 Service Worker，讓網站本身（HTML／JS／CSS／Firebase 模組）斷網時也能打開。
// 註冊失敗不影響網站正常運作（只是沒有離線開啟功能）。管理後台（admin.html）不受影響、不會被快取。
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").catch(function (err) {
      console.warn("[sw] 註冊失敗（不影響一般使用）", err);
    });
  });
}
