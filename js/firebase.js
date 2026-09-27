// ============================================================================
// firebase.js — Firebase initialization
// ============================================================================
// 1. Create a project at https://console.firebase.google.com
// 2. Enable: Authentication (Anonymous), Realtime Database
//    (Firebase Storage is NOT used — media uploads go to your own
//    local server.js instead; see MEDIA_SERVER_URL below)
// 3. Paste your web app config below (Project settings → General → Your apps)
// 4. See README.md for the full setup guide and security rules.
// ============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getDatabase,
  ref,
  set,
  get,
  update,
  remove,
  push,
  onValue,
  onDisconnect,
  serverTimestamp,
  query,
  orderByChild,
  child,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";

// -----------------------------------------------------------------------
// PASTE YOUR FIREBASE CONFIG HERE
// -----------------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyBwyxV-NiEMDk81Bv-uSIP9ndkIkcYBw9A",
  authDomain: "chat-577c5.firebaseapp.com",
  databaseURL: "https://chat-577c5-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "chat-577c5",
  storageBucket: "chat-577c5.firebasestorage.app",
  messagingSenderId: "926139973751",
  appId: "1:926139973751:web:94ebb643f9c1a4d2cc8672",
};

// -----------------------------------------------------------------------
// Media storage
// -----------------------------------------------------------------------
// Images/videos are NOT stored in Firebase Storage in this setup — they're
// uploaded to your own Node/Express server (see server.js) and only the
// returned URL is saved in the Realtime Database message record.
//
// If your media server isn't reachable from wherever a guest opens the
// room (e.g. it only listens on localhost), they won't be able to load
// images/videos sent by others. Expose it via port forwarding, a tunnel
// (ngrok, Cloudflare Tunnel), or a small VPS if you need that to work
// across machines/networks.
export const MEDIA_SERVER_URL = "https://nook-media.amoghbhandari.com.np";

// -----------------------------------------------------------------------
// Configurable limits — safe to tweak
// -----------------------------------------------------------------------
export const MAX_IMAGE_SIZE_MB = 10;
export const MAX_VIDEO_SIZE_MB = 50;
export const ROOM_EXPIRY_MS = 60 * 60 * 1000; // 1 hour of inactivity
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
export const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

/**
 * Resolves once anonymous auth completes. Every page waits on this before
 * touching the database so `request.auth != null` is always true for rules.
 */
function ensureAuth() {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(auth, (user) => {
      if (user) {
        resolve(user);
      } else {
        signInAnonymously(auth).catch(reject);
      }
    }, reject);
  });
}

export {
  app,
  auth,
  db,
  ensureAuth,
  // database helpers
  ref,
  set,
  get,
  update,
  remove,
  push,
  onValue,
  onDisconnect,
  serverTimestamp,
  query,
  orderByChild,
  child,
};
