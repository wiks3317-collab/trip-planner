// v21p12：管理後台的外觀（色彩主題）選擇。
// 與主網頁共用同一份設定（localStorage 的 tp_appearance／tp_custom_palette），
// 在這裡改主題，回到主網頁也會一樣；反之亦然。主題色票本身寫在 style.css。
// ⚠️ 主題清單與自訂欄位需與 app.js 的 THEME_PRESETS／PALETTE_FIELDS 保持一致。
(function () {
  var THEMES = [
    ["auto", "跟隨系統", "#ffffff", "#171a21"], ["light", "淺色", "#f6f7f9", "#2563eb"],
    ["dark", "深色", "#0f1115", "#4c8dff"], ["sepia", "護眼米黃", "#f1e8d4", "#a8652a"],
    ["forest", "森林綠", "#eaf2ec", "#2f855a"], ["ocean", "深海藍", "#0b1e2d", "#2bb3d9"],
    ["dracula", "紫夜", "#282a36", "#bd93f9"], ["custom", "自訂", "", ""]
  ];
  var FIELDS = [
    ["bg", "--bg", "頁面背景"], ["card", "--card-bg", "卡片背景"], ["surface", "--surface-muted", "淡色底"],
    ["text", "--text", "文字"], ["muted", "--text-muted", "次要文字"], ["border", "--border", "邊框"],
    ["primary", "--primary", "主色（按鈕）"], ["onPrimary", "--on-primary", "主色上的文字"], ["accent", "--accent", "強調色"]
  ];
  var DEFAULT_PALETTE = { bg: "#f6f7f9", card: "#ffffff", surface: "#eef0f3", text: "#1f2328", muted: "#6b7280",
    border: "#d0d7de", primary: "#2563eb", onPrimary: "#ffffff", accent: "#D98E2B" };
  var LS_A = "tp_appearance", LS_P = "tp_custom_palette";
  var html = document.documentElement;

  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(LS_A) || "{}");
      var ok = s.v === 2 && THEMES.some(function (t) { return t[0] === s.themeId; });
      return { v: 2, themeId: ok ? s.themeId : "auto", sizeId: s.sizeId || "md" };
    } catch (e) { return { v: 2, themeId: "auto", sizeId: "md" }; }
  }
  function saveSettings(s) { try { localStorage.setItem(LS_A, JSON.stringify(s)); } catch (e) {} }
  function loadPalette() {
    var out = {}, k;
    for (k in DEFAULT_PALETTE) out[k] = DEFAULT_PALETTE[k];
    try {
      var p = JSON.parse(localStorage.getItem(LS_P) || "null");
      if (p) FIELDS.forEach(function (f) { if (/^#[0-9a-fA-F]{6}$/.test(p[f[0]] || "")) out[f[0]] = p[f[0]]; });
    } catch (e) {}
    return out;
  }
  function savePalette(p) { try { localStorage.setItem(LS_P, JSON.stringify(p)); } catch (e) {} }
  function isDark(hex) {
    var n = parseInt(hex.slice(1), 16);
    return (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255 < 0.5;
  }
  function apply(s) {
    FIELDS.forEach(function (f) { html.style.removeProperty(f[1]); });
    html.style.removeProperty("color-scheme");
    if (s.themeId === "auto") html.removeAttribute("data-theme"); else html.setAttribute("data-theme", s.themeId);
    if (s.themeId === "custom") {
      var p = loadPalette();
      FIELDS.forEach(function (f) { html.style.setProperty(f[1], p[f[0]]); });
      html.style.setProperty("color-scheme", isDark(p.bg) ? "dark" : "light");
    }
  }
  function snapshot() {
    var probe = document.createElement("span");
    probe.style.display = "none";
    document.body.appendChild(probe);
    var cs = getComputedStyle(html), out = {};
    FIELDS.forEach(function (f) {
      probe.style.color = "";
      probe.style.color = cs.getPropertyValue(f[1]).trim();
      var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(probe).color);
      out[f[0]] = m ? "#" + [m[1], m[2], m[3]].map(function (v) { return (+v).toString(16).padStart(2, "0"); }).join("") : DEFAULT_PALETTE[f[0]];
    });
    probe.remove();
    return out;
  }

  function build() {
    var btn = document.createElement("button");
    btn.id = "admin-theme-btn";
    btn.type = "button";
    btn.title = "外觀設定";
    btn.setAttribute("aria-label", "外觀設定");
    btn.textContent = "🎨";
    var panel = document.createElement("div");
    panel.id = "admin-theme-panel";
    panel.className = "hidden";
    panel.innerHTML =
      '<div class="admin-theme-title">色彩主題</div>' +
      '<div class="theme-swatch-grid" id="admin-theme-grid">' +
      THEMES.map(function (t) {
        var dot = t[0] === "custom"
          ? "background:conic-gradient(#e5484d,#f5a524,#46a758,#2bb3d9,#8e4ec6,#e5484d);"
          : "background:linear-gradient(135deg," + t[2] + " 50%," + t[3] + " 50%);";
        return '<button type="button" class="theme-swatch" data-theme="' + t[0] + '"><span class="theme-swatch-dot" style="' + dot + '"></span><span class="theme-swatch-label">' + t[1] + "</span></button>";
      }).join("") +
      "</div>" +
      '<div class="palette-editor hidden" id="admin-palette-editor">' +
      '<p class="palette-hint">點色塊挑選顏色，畫面會即時變化。</p><div class="palette-grid">' +
      FIELDS.map(function (f) { return '<label class="palette-item"><input type="color" data-key="' + f[0] + '"><span>' + f[2] + "</span></label>"; }).join("") +
      '</div><div class="form-actions" style="margin-top:12px;justify-content:flex-start;gap:8px;">' +
      '<select id="admin-palette-base" aria-label="以哪個主題為起點">' +
      THEMES.filter(function (t) { return t[0] !== "custom"; }).map(function (t) { return '<option value="' + t[0] + '">' + t[1] + "</option>"; }).join("") +
      '</select><button type="button" class="secondary-btn" id="admin-palette-copy">以此主題為起點</button>' +
      '<button type="button" class="secondary-btn" id="admin-palette-undo">還原</button></div></div>';
    document.body.appendChild(btn);
    document.body.appendChild(panel);

    var editor = panel.querySelector("#admin-palette-editor");
    var paletteAtOpen = loadPalette();
    function syncPickers(p) { editor.querySelectorAll('input[type="color"]').forEach(function (i) { i.value = p[i.dataset.key]; }); }
    function refresh() {
      var cur = loadSettings();
      panel.querySelectorAll(".theme-swatch").forEach(function (b) { b.classList.toggle("active", b.dataset.theme === cur.themeId); });
      editor.classList.toggle("hidden", cur.themeId !== "custom");
      syncPickers(loadPalette());
    }
    function setTheme(id) { var s = loadSettings(); s.themeId = id; saveSettings(s); apply(s); refresh(); }

    btn.addEventListener("click", function () {
      var willOpen = panel.classList.contains("hidden");
      panel.classList.toggle("hidden");
      if (willOpen) { paletteAtOpen = loadPalette(); refresh(); }
    });
    document.addEventListener("click", function (e) {
      if (!panel.classList.contains("hidden") && !panel.contains(e.target) && e.target !== btn) panel.classList.add("hidden");
    });
    panel.querySelectorAll(".theme-swatch").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.dataset.theme;
        if (id === "custom" && !localStorage.getItem(LS_P)) savePalette(snapshot());
        setTheme(id);
      });
    });
    editor.querySelectorAll('input[type="color"]').forEach(function (inp) {
      inp.addEventListener("input", function () {
        var p = loadPalette(); p[inp.dataset.key] = inp.value; savePalette(p);
        var s = loadSettings(); s.themeId = "custom"; saveSettings(s); apply(s);
      });
    });
    panel.querySelector("#admin-palette-copy").addEventListener("click", function () {
      var s = loadSettings(); s.themeId = panel.querySelector("#admin-palette-base").value; apply(s);
      savePalette(snapshot());
      setTheme("custom");
    });
    panel.querySelector("#admin-palette-undo").addEventListener("click", function () {
      savePalette(paletteAtOpen); setTheme("custom");
    });
    refresh();
  }

  if (document.body) build(); else document.addEventListener("DOMContentLoaded", build);
})();
