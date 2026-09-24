// ============================================================
// 管理員後台專用 Firebase 設定檔（admin.html 專用）
//
// 這份檔案跟 firebase-config.js 是分開的、各自獨立初始化：
// - firebase-config.js／app.js：一般使用者頁面，用「匿名登入」。
// - admin-firebase-config.js／admin.js：管理員後台，用「Google 登入」。
// 兩者互不影響：一般使用者完全不會載入這份檔案，這份檔案也不會
// 動到 app.js 既有的任何邏輯。
//
// ⚠️ 请把下面 firebaseConfig 換成跟 firebase-config.js 裡「完全相同」的
// 那組設定值（同一個 Firebase 專案）。兩份檔案目前是各自獨立維護，
// 如果之後在 Firebase 主控台建立了新的網頁應用程式設定，記得兩份都要更新。
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

// ⬇⬇⬇ 換成跟 firebase-config.js 相同的設定 ⬇⬇⬇
const firebaseConfig = {
  apiKey: "AIzaSyBVxVdsmkpKATI81D_uiJdIk9bp5lhngdk",
  authDomain: "my-trip-planner-d1b84.firebaseapp.com",
  projectId: "my-trip-planner-d1b84",
  storageBucket: "my-trip-planner-d1b84.firebasestorage.app",
  messagingSenderId: "1098126379589",
  appId: "1:1098126379589:web:69cc751290a9374011b12c",
  measurementId: "G-0K01H21D23"
};
// ⬆⬆⬆ 換成跟 firebase-config.js 相同的設定 ⬆⬆⬆

// 用不同的 app 名稱（"admin"）初始化，避免萬一同一個瀏覽器分頁裡
// 同時載入到一般頁面邏輯時互相干擾（正常情況下 admin.html 與
// index.html 是完全不同的頁面，不會同時存在，這只是多一層保險）。
const adminApp = initializeApp(firebaseConfig, "admin");
const db = getFirestore(adminApp);
const auth = getAuth(adminApp);
const googleProvider = new GoogleAuthProvider();

async function adminSignIn() {
  const cred = await signInWithPopup(auth, googleProvider);
  return cred.user;
}

async function adminSignOut() {
  await signOut(auth);
}

export { adminApp, db, auth, googleProvider, adminSignIn, adminSignOut, onAuthStateChanged };
