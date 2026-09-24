// ============================================================
// Firebase 設定檔
// 請依照 README.md 的教學，建立你自己的 Firebase 專案後，
// 把下面的設定值換成你自己的（在 Firebase 主控台 > 專案設定 > 你的應用程式 可以找到）
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

// ⬇⬇⬇ 把這裡換成你自己 Firebase 專案的設定 ⬇⬇⬇
const firebaseConfig = {
  apiKey: "AIzaSyBVxVdsmkpKATI81D_uiJdIk9bp5lhngdk",
  authDomain: "my-trip-planner-d1b84.firebaseapp.com",
  projectId: "my-trip-planner-d1b84",
  storageBucket: "my-trip-planner-d1b84.firebasestorage.app",
  messagingSenderId: "1098126379589",
  appId: "1:1098126379589:web:69cc751290a9374011b12c",
  measurementId: "G-0K01H21D23"
};
// ⬆⬆⬆ 把這裡換成你自己 Firebase 專案的設定 ⬆⬆⬆

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// 匿名登入：讓每個瀏覽器有一個穩定的 uid，純技術用途，
// 使用者完全不會看到登入畫面，也不需要輸入帳密。
let authReadyResolve;
export const authReady = new Promise((res) => (authReadyResolve = res));

// 注意：全新瀏覽器（例如無痕視窗）第一次載入時，onAuthStateChanged 會先回傳 user = null，
// 這時匿名登入還沒完成。如果此時就讓網站開始讀取資料，Firestore 會因為「未登入」而拒絕，
// 造成邀請連結被誤判為失效。所以只有在真的拿到 user 之後，才算 authReady。
onAuthStateChanged(auth, (user) => {
  if (user) authReadyResolve(user);
});

signInAnonymously(auth)
  .then((cred) => authReadyResolve(cred.user))
  .catch((err) => {
    console.error("匿名登入失敗", err);
    authReadyResolve(null);
  });

window.__FIREBASE__ = { app, db, auth };
export { app, db, auth };
