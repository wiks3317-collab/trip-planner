// v21p12：在畫面繪製前先套用外觀設定，避免深色主題載入時先閃一下白底。
// （CSP 不允許內嵌 script，所以獨立成檔；邏輯需與 app.js 的 applyAppearance 保持一致）
(function () {
  try {
    var s = JSON.parse(localStorage.getItem("tp_appearance") || "{}");
    var ok = ["light", "dark", "sepia", "forest", "ocean", "dracula", "custom"];
    var html = document.documentElement;
    if (s.v === 2 && ok.indexOf(s.themeId) !== -1) html.setAttribute("data-theme", s.themeId);
    if (s.v === 2 && s.themeId === "custom") {
      var p = JSON.parse(localStorage.getItem("tp_custom_palette") || "null");
      var map = { bg: "--bg", card: "--card-bg", surface: "--surface-muted", text: "--text", muted: "--text-muted",
                  border: "--border", primary: "--primary", onPrimary: "--on-primary", accent: "--accent" };
      if (p) {
        for (var k in map) if (/^#[0-9a-fA-F]{6}$/.test(p[k] || "")) html.style.setProperty(map[k], p[k]);
        var n = parseInt((p.bg || "#ffffff").slice(1), 16);
        var lum = (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255;
        html.style.setProperty("color-scheme", lum < 0.5 ? "dark" : "light");
      }
    }
  } catch (e) { /* 讀不到設定就用預設 */ }
})();
