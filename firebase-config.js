// ============================================================
// Firebase 設定檔
// 請依照 README.md 的教學，建立你自己的 Firebase 專案後，
// 把下面的設定值換成你自己的（在 Firebase 主控台 > 專案設定 > 你的應用程式 可以找到）
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app-check.js";
import { firebaseConfig, appCheckSiteKey } from "./firebase-options.js"; // 設定值集中在 firebase-options.js

const app = initializeApp(firebaseConfig);

// v21p5：App Check。必須在 getFirestore／getAuth 之前初始化。
// 金鑰留空時完全略過，不影響現有功能；本機開發（localhost）自動使用 debug token。
if (appCheckSiteKey) {
  if (["localhost", "127.0.0.1"].includes(location.hostname)) self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  initializeAppCheck(app, { provider: new ReCaptchaV3Provider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
}
// v21p6：離線支援。啟用 Firestore 本機持久快取（IndexedDB）：
//  - 看過的行程斷網也能開；離線時的新增／修改會先存在這台裝置，恢復網路後自動上傳並讓其他人看到。
//  - 多分頁管理器：同一個瀏覽器開多個分頁不會互相搶快取。
// 瀏覽器不支援 IndexedDB（或初始化失敗）時退回原本「僅記憶體」的行為，網站照常可用，只是沒有離線功能。
let db;
let offlineCacheMode = "memory";
try {
  if (typeof indexedDB === "undefined" || !indexedDB) throw new Error("此瀏覽器沒有 IndexedDB");
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  offlineCacheMode = "persistent";
} catch (err) {
  console.warn("[offline] 無法啟用本機快取，改用僅記憶體模式：", err);
  db = getFirestore(app);
}
const auth = getAuth(app);

// 匿名登入：讓每個瀏覽器有一個穩定的 uid，純技術用途，
// 使用者完全不會看到登入畫面，也不需要輸入帳密。
let authReadyResolve;
let authReadySettled = false;
export const authReady = new Promise((res) => (authReadyResolve = (value) => {
  if (authReadySettled) return;
  authReadySettled = true;
  res(value);
}));

// 注意：全新瀏覽器（例如無痕視窗）第一次載入時，onAuthStateChanged 會先回傳 user = null，
// 這時匿名登入還沒完成。如果此時就讓網站開始讀取資料，Firestore 會因為「未登入」而拒絕，
// 造成邀請連結被誤判為失效。所以只有在真的拿到 user 之後，才算 authReady。
onAuthStateChanged(auth, (user) => {
  if (user) authReadyResolve(user);
});

const authTimeout = setTimeout(() => {
  if (!authReadySettled) {
    console.error("匿名登入逾時：8 秒內沒有完成 Firebase Authentication 初始化");
    authReadyResolve(null);
  }
}, 8000);

signInAnonymously(auth)
  .then((cred) => {
    clearTimeout(authTimeout);
    authReadyResolve(cred.user);
  })
  .catch((err) => {
    clearTimeout(authTimeout);
    console.error("匿名登入失敗", err);
    authReadyResolve(null);
  });

window.__FIREBASE__ = { app, db, auth, offlineCacheMode };
export { app, db, auth, offlineCacheMode };
