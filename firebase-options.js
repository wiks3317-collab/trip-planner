// 全站共用的 Firebase 設定：firebase-config.js 與 admin-firebase-config.js 都從這裡讀取，只需維護這一份。
export const firebaseConfig = {
  apiKey: "AIzaSyBVxVdsmkpKATI81D_uiJdIk9bp5lhngdk",
  authDomain: "my-trip-planner-d1b84.firebaseapp.com",
  projectId: "my-trip-planner-d1b84",
  storageBucket: "my-trip-planner-d1b84.firebasestorage.app",
  messagingSenderId: "1098126379589",
  appId: "1:1098126379589:web:69cc751290a9374011b12c",
  measurementId: "G-0K01H21D23"
};

// Firebase App Check（reCAPTCHA v3）網站金鑰。留空 = 不啟用（網站照常運作）。
// 設定步驟見 README「v21p5 安全補強：App Check」。這是「網站金鑰」，本來就可公開，不是密鑰。
export const appCheckSiteKey = "";
