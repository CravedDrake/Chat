// ============================================================================
// room.js — chat room application logic
// ============================================================================
import {
  db, ensureAuth, ROOM_EXPIRY_MS, MEDIA_SERVER_URL,
  MAX_IMAGE_SIZE_MB, MAX_VIDEO_SIZE_MB, ALLOWED_IMAGE_TYPES, ALLOWED_VIDEO_TYPES,
  ref, set, get, update, remove, push, onValue, onDisconnect, serverTimestamp,
} from "./firebase.js";
import {
  escapeHTML, renderMessageText, getSavedDisplayName,
  saveDisplayName, formatTime, formatBytes, showToast, copyToClipboard, debounce,
  QUICK_REACTIONS, EMOJI_GROUPS,
} from "./utils.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let uid = null; // set to the real Firebase Auth uid once ensureAuth() resolves in init()
let roomCode = null;
let roomId = null;
let members = {};
let currentMessages = {};
let replyingTo = null;   // { messageId, senderName, preview }
let pendingMedia = null; // { file, type }
let expiryTimer = null;
let hasJoined = false;
let leavingIntentionally = false;

const params = new URLSearchParams(window.location.search);
roomCode = params.get("room")?.toUpperCase() || null;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const loadingScreen = $("loadingScreen");
const loadingLabel = $("loadingLabel");
const joinScreen = $("joinScreen");
const errorScreen = $("errorScreen");
const expiredScreen = $("expiredScreen");
const chatApp = $("chatApp");

function showOnly(screen) {
  [loadingScreen, joinScreen, errorScreen, expiredScreen, chatApp].forEach((s) => {
    s.hidden = s !== screen;
  });
}

function setLoading(label) {
  loadingLabel.textContent = label;
  showOnly(loadingScreen);
}

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------
init();

async function init() {
  if (!roomCode) {
    showError("No room specified", "Use an invite link or enter a room code from the homepage.");
    return;
  }

  setLoading("Connecting…");
  try {
    const user = await ensureAuth();
    uid = user.uid; // must match auth.uid for the security rules to allow reads
  } catch (err) {
    console.error(err);
    showError("Connection failed", "Couldn't reach Firebase. Check your configuration and network connection.");
    return;
  }

  setLoading("Loading room…");
  try {
    const idSnap = await get(ref(db, `roomCodes/${roomCode}`));
    if (!idSnap.exists()) {
      showError("Room not found", "This room doesn't exist. It may have expired or the code may be wrong.");
      return;
    }
    roomId = idSnap.val();

    const roomSnap = await get(ref(db, `rooms/${roomId}`));
    if (!roomSnap.exists() || roomSnap.val().status === "deleted") {
      showExpired();
      return;
    }

    const roomData = roomSnap.val();
    if (isExpired(roomData.lastActivity)) {
      showExpired();
      await cleanupExpiredRoom(roomId, roomData);
      return;
    }

    // Already a member on this device (e.g. refreshed page) → skip name prompt.
    const existingMemberSnap = await get(ref(db, `rooms/${roomId}/members/${uid}`));
    if (existingMemberSnap.exists()) {
      await enterChat(existingMemberSnap.val().name);
    } else {
      showJoinScreen();
    }
  } catch (err) {
    console.error(err);
    showError("Something went wrong", "We couldn't load this room. Please try again.");
  }
}

function isExpired(lastActivity) {
  if (!lastActivity) return false;
  return Date.now() - lastActivity >= ROOM_EXPIRY_MS;
}

function showError(title, message) {
  $("errorTitle").textContent = title;
  $("errorMessage").textContent = message;
  showOnly(errorScreen);
}

function showExpired() {
  showOnly(expiredScreen);
}

function showJoinScreen() {
  $("joinRoomHeading").textContent = `Join room ${roomCode}`;
  const saved = getSavedDisplayName();
  if (saved) $("joinRoomNameInput").value = saved;
  showOnly(joinScreen);
  setTimeout(() => $("joinRoomNameInput").focus(), 50);
}

$("joinRoomForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("joinRoomNameInput").value.trim();
  const errEl = $("joinRoomError");
  errEl.hidden = true;

  if (!name) {
    errEl.textContent = "Please enter a display name.";
    errEl.hidden = false;
    return;
  }
  if (name.length > 24) {
    errEl.textContent = "Name must be 24 characters or fewer.";
    errEl.hidden = false;
    return;
  }

  const btn = $("joinRoomSubmit");
  btn.disabled = true;
  btn.textContent = "Joining…";

  try {
    // Re-check the room hasn't expired between screens.
    const roomSnap = await get(ref(db, `rooms/${roomId}`));
    if (!roomSnap.exists() || roomSnap.val().status === "deleted" || isExpired(roomSnap.val().lastActivity)) {
      showExpired();
      return;
    }
    saveDisplayName(name);
    await joinRoom(escapeHTML(name));
    await enterChat(escapeHTML(name));
  } catch (err) {
    console.error(err);
    errEl.textContent = "Couldn't join the room. Please try again.";
    errEl.hidden = false;
    btn.disabled = false;
    btn.textContent = "Join Room";
  }
});

// ---------------------------------------------------------------------------
// joinRoom() — writes the member record
// ---------------------------------------------------------------------------
async function joinRoom(displayName) {
  await set(ref(db, `rooms/${roomId}/members/${uid}`), {
    name: displayName,
    joinedAt: serverTimestamp(),
    online: true,
    isHost: false,
  });
}

// ---------------------------------------------------------------------------
// Enter chat — sets up presence, listeners, UI
// ---------------------------------------------------------------------------
async function enterChat(displayName) {
  hasJoined = true;
  showOnly(chatApp);
  $("roomCodeText").textContent = roomCode;

  setupPresence();
  listenToMembers();
  listenToMessages();
  listenToRoomStatus();
  startExpiryWatcher();
  wireChatUI();
}

// ---------------------------------------------------------------------------
// Presence — onDisconnect ensures cleanup even on tab close/crash
// ---------------------------------------------------------------------------
function setupPresence() {
  const memberRef = ref(db, `rooms/${roomId}/members/${uid}`);
  const connectedRef = ref(db, ".info/connected");
  onValue(connectedRef, (snap) => {
    if (snap.val() === true) {
      // If everyone disconnects, this member record is removed by Firebase itself.
      onDisconnect(memberRef).remove();
      update(memberRef, { online: true });
    }
  });
}

// ---------------------------------------------------------------------------
// listenToMembers()
// ---------------------------------------------------------------------------
function listenToMembers() {
  onValue(ref(db, `rooms/${roomId}/members`), (snap) => {
    members = snap.val() || {};
    const count = Object.keys(members).length;
    $("memberCount").textContent = count;

    // If the room is now empty (last member left from another tab) and we're
    // still here, the room record itself will be removed — handled by listenToRoomStatus.
  });
}

// ---------------------------------------------------------------------------
// listenToRoomStatus() — reacts if the room is deleted/expired by cleanup logic
// ---------------------------------------------------------------------------
function listenToRoomStatus() {
  onValue(ref(db, `rooms/${roomId}`), (snap) => {
    if (!hasJoined || leavingIntentionally) return;
    if (!snap.exists() || snap.val().status === "deleted") {
      teardownListeners();
      showExpired();
    }
  });
}

// ---------------------------------------------------------------------------
// Expiration watcher — client-side check for UX; see README for the
// server-side Cloud Function that performs real enforcement + Storage cleanup.
// ---------------------------------------------------------------------------
function startExpiryWatcher() {
  expiryTimer = setInterval(async () => {
    try {
      const snap = await get(ref(db, `rooms/${roomId}/lastActivity`));
      if (snap.exists() && isExpired(snap.val())) {
        clearInterval(expiryTimer);
        teardownListeners();
        showExpired();
        const roomSnap = await get(ref(db, `rooms/${roomId}`));
        if (roomSnap.exists()) await cleanupExpiredRoom(roomId, roomSnap.val());
      }
    } catch { /* transient network errors are fine to ignore here */ }
  }, 30_000);
}

/**
 * Best-effort client-side deletion of an expired room's data. In production,
 * this must be enforced by a trusted backend (see README §"Automatic cleanup"),
 * since any connected client could otherwise tamper with expiry logic.
 */
async function cleanupExpiredRoom(id, roomData) {
  try {
    await remove(ref(db, `rooms/${id}`));
    if (roomData?.code) await remove(ref(db, `roomCodes/${roomData.code}`));
  } catch (err) {
    console.warn("Cleanup skipped (handled by backend / security rules):", err);
  }
  await deleteRoomMedia(id);
}

function teardownListeners() {
  if (expiryTimer) clearInterval(expiryTimer);
}

// ---------------------------------------------------------------------------
// listenToMessages()
// ---------------------------------------------------------------------------
let firstMessagesLoad = true;
function listenToMessages() {
  onValue(ref(db, `rooms/${roomId}/messages`), (snap) => {
    currentMessages = snap.val() || {};
    renderMessages();
    if (firstMessagesLoad) {
      scrollToBottom(false);
      firstMessagesLoad = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const messagesList = $("messagesList");
const messagesArea = $("messagesArea");
const scrollAnchor = $("scrollAnchor");

function isNearBottom() {
  return messagesArea.scrollHeight - messagesArea.scrollTop - messagesArea.clientHeight < 120;
}

function scrollToBottom(smooth = true) {
  scrollAnchor.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "end" });
}

function renderMessages() {
  const wasNearBottom = isNearBottom();
  const sorted = Object.entries(currentMessages)
    .map(([id, m]) => ({ id, ...m }))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  messagesList.innerHTML = "";
  let lastSenderId = null;
  let lastGroupEl = null;
  let lastTimestamp = 0;

  for (const msg of sorted) {
    const sameSender = msg.senderId === lastSenderId;
    const closeInTime = msg.timestamp - lastTimestamp < 5 * 60 * 1000;
    if (!sameSender || !closeInTime) {
      lastGroupEl = createMessageGroup(msg);
      messagesList.appendChild(lastGroupEl);
    }
    const row = createMessageRow(msg);
    lastGroupEl.appendChild(row);
    lastSenderId = msg.senderId;
    lastTimestamp = msg.timestamp || Date.now();
  }

  if (wasNearBottom) scrollToBottom(false);
}

function createMessageGroup(msg) {
  const isOwn = msg.senderId === uid;
  const group = document.createElement("div");
  group.className = `msg-group ${isOwn ? "msg-group--own" : "msg-group--other"}`;
  if (!isOwn) {
    const label = document.createElement("div");
    label.className = "msg-group__sender";
    label.textContent = msg.senderName || "Someone";
    group.appendChild(label);
  }
  return group;
}

function createMessageRow(msg) {
  const isOwn = msg.senderId === uid;
  const row = document.createElement("div");
  row.className = "msg-row";
  row.dataset.id = msg.id;

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  if (msg.replyTo) {
    const ref_ = document.createElement("div");
    ref_.className = "msg-reply-ref";
    ref_.innerHTML = `<strong>${escapeHTML(msg.replyTo.senderName)}</strong><br>${escapeHTML(msg.replyTo.preview)}`;
    ref_.addEventListener("click", (e) => { e.stopPropagation(); scrollToMessage(msg.replyTo.messageId); });
    bubble.appendChild(ref_);
  }

  if (msg.type === "text") {
    const textEl = document.createElement("div");
    textEl.innerHTML = renderMessageText(msg.text || "");
    bubble.appendChild(textEl);
  } else if (msg.type === "image") {
    bubble.classList.add("msg-bubble--media");
    const img = document.createElement("img");
    img.src = msg.mediaUrl;
    img.alt = "Shared image";
    img.loading = "lazy";
    img.addEventListener("click", (e) => { e.stopPropagation(); openLightbox("image", msg.mediaUrl); });
    bubble.appendChild(img);
  } else if (msg.type === "video") {
    bubble.classList.add("msg-bubble--media");
    const vid = document.createElement("video");
    vid.src = msg.mediaUrl;
    vid.controls = true;
    vid.preload = "metadata";
    vid.addEventListener("click", (e) => { e.stopPropagation(); openLightbox("video", msg.mediaUrl); });
    bubble.appendChild(vid);
  } else if (msg.type === "gif") {
    bubble.classList.add("msg-bubble--media");
    const img = document.createElement("img");
    img.src = msg.mediaUrl;
    img.alt = "GIF";
    img.loading = "lazy";
    bubble.appendChild(img);
  }

  bubble.addEventListener("click", () => openActionSheet(msg));

  const actionsBtn = document.createElement("button");
  actionsBtn.className = "msg-actions-btn";
  actionsBtn.setAttribute("aria-label", "Message actions");
  actionsBtn.textContent = "⋯";
  actionsBtn.addEventListener("click", (e) => { e.stopPropagation(); openActionSheet(msg); });

  row.appendChild(bubble);
  row.appendChild(actionsBtn);

  const wrapper = document.createElement("div");
  wrapper.style.display = "flex";
  wrapper.style.flexDirection = "column";
  wrapper.appendChild(row);

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  meta.textContent = formatTime(msg.timestamp);
  wrapper.appendChild(meta);

  if (msg.reactions) {
    wrapper.appendChild(createReactionsRow(msg));
  }

  return wrapper;
}

function createReactionsRow(msg) {
  const wrap = document.createElement("div");
  wrap.className = "msg-reactions";
  const counts = {};
  Object.values(msg.reactions || {}).forEach((emoji) => {
    counts[emoji] = (counts[emoji] || 0) + 1;
  });
  Object.entries(counts).forEach(([emoji, count]) => {
    const mine = msg.reactions[uid] === emoji;
    const chip = document.createElement("button");
    chip.className = `reaction-chip ${mine ? "reaction-chip--mine" : ""}`;
    chip.textContent = `${emoji} ${count}`;
    chip.addEventListener("click", () => toggleReaction(msg.id, emoji));
    wrap.appendChild(chip);
  });
  return wrap;
}

function scrollToMessage(messageId) {
  const row = messagesList.querySelector(`[data-id="${CSS.escape(messageId)}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  const bubble = row.querySelector(".msg-bubble");
  bubble.classList.add("msg-bubble--highlight");
  setTimeout(() => bubble.classList.remove("msg-bubble--highlight"), 1400);
}

// ---------------------------------------------------------------------------
// sendMessage() / sendMediaMessage()
// ---------------------------------------------------------------------------
async function sendMessage(text) {
  const myName = members[uid]?.name || getSavedDisplayName();
  const messageRef = push(ref(db, `rooms/${roomId}/messages`));
  const payload = {
    senderId: uid,
    senderName: myName,
    type: "text",
    text,
    timestamp: serverTimestamp(),
  };
  if (replyingTo) payload.replyTo = replyingTo;
  await set(messageRef, payload);
  await touchLastActivity();
  clearReply();
}

async function sendMediaMessage(type, mediaUrl, extra = {}) {
  const myName = members[uid]?.name || getSavedDisplayName();
  const messageRef = push(ref(db, `rooms/${roomId}/messages`));
  const payload = {
    senderId: uid,
    senderName: myName,
    type,
    mediaUrl,
    timestamp: serverTimestamp(),
    ...extra,
  };
  if (replyingTo) payload.replyTo = replyingTo;
  await set(messageRef, payload);
  await touchLastActivity();
  clearReply();
}

async function touchLastActivity() {
  await update(ref(db, `rooms/${roomId}`), { lastActivity: serverTimestamp() });
}

// ---------------------------------------------------------------------------
// sendReaction() / removeReaction()
// ---------------------------------------------------------------------------
async function toggleReaction(messageId, emoji) {
  const path = `rooms/${roomId}/messages/${messageId}/reactions/${uid}`;
  const current = currentMessages[messageId]?.reactions?.[uid];
  if (current === emoji) {
    await removeReaction(messageId);
  } else {
    await sendReaction(messageId, emoji);
  }
}
async function sendReaction(messageId, emoji) {
  await set(ref(db, `rooms/${roomId}/messages/${messageId}/reactions/${uid}`), emoji);
}
async function removeReaction(messageId) {
  await remove(ref(db, `rooms/${roomId}/messages/${messageId}/reactions/${uid}`));
}

// ---------------------------------------------------------------------------
// replyToMessage()
// ---------------------------------------------------------------------------
function replyToMessage(msg) {
  replyingTo = {
    messageId: msg.id,
    senderName: msg.senderName,
    preview: msg.type === "text" ? (msg.text || "").slice(0, 120) : `[${msg.type}]`,
  };
  $("replyPreviewName").textContent = replyingTo.senderName;
  $("replyPreviewText").textContent = replyingTo.preview;
  $("replyPreview").hidden = false;
  $("messageInput").focus();
}
function clearReply() {
  replyingTo = null;
  $("replyPreview").hidden = true;
}
$("cancelReplyBtn").addEventListener("click", clearReply);

// ---------------------------------------------------------------------------
// uploadMedia() — posts to your local media server (server.js), not Firebase
// Storage. Server contract: POST /api/upload, multipart field "file" + "roomId",
// returns { success, url } where url is a path like "/media/{roomId}/{type}/{name}".
// ---------------------------------------------------------------------------
async function uploadMedia(file, kind) {
  $("mediaPreviewProgressWrap").hidden = false;
  $("mediaPreviewProgressBar").style.width = "0%";

  const formData = new FormData();
  // roomId must come before the file field: some multer setups read
  // req.body.roomId while still parsing the file stream, so a text field
  // appended after "file" isn't populated yet and the server rejects the
  // upload with "Room ID is required".
  formData.append("roomId", roomId);
  formData.append("file", file);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${MEDIA_SERVER_URL}/api/upload`);

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        $("mediaPreviewProgressBar").style.width = pct + "%";
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          if (!data.success || !data.url) {
            reject(new Error("Media server returned an unexpected response."));
            return;
          }
          resolve({ url: `${MEDIA_SERVER_URL}${data.url}` });
        } catch (err) {
          reject(err);
        }
      } else {
        let message = `Upload failed (${xhr.status})`;
        try { message = JSON.parse(xhr.responseText).error || message; } catch { /* ignore */ }
        reject(new Error(message));
      }
    });

    xhr.addEventListener("error", () => {
      reject(new Error(`Couldn't reach the media server at ${MEDIA_SERVER_URL}. Is server.js running?`));
    });

    xhr.send(formData);
  });
}

/** Best-effort request to delete a room's uploaded media on the local media server. */
async function deleteRoomMedia(id) {
  try {
    await fetch(`${MEDIA_SERVER_URL}/api/room/${id}`, { method: "DELETE" });
  } catch (err) {
    console.warn("Media server cleanup failed (room media may be orphaned on disk):", err);
  }
}

// ---------------------------------------------------------------------------
// leaveRoom()
// ---------------------------------------------------------------------------
async function leaveRoom() {
  leavingIntentionally = true;
  teardownListeners();
  try {
    await remove(ref(db, `rooms/${roomId}/members/${uid}`));
    // If that was the last member, delete the room's data (best-effort;
    // enforced server-side too — see README).
    const membersSnap = await get(ref(db, `rooms/${roomId}/members`));
    if (!membersSnap.exists()) {
      const roomSnap = await get(ref(db, `rooms/${roomId}`));
      const roomData = roomSnap.val();
      await remove(ref(db, `rooms/${roomId}`));
      if (roomData?.code) await remove(ref(db, `roomCodes/${roomData.code}`));
      await deleteRoomMedia(roomId);
    }
  } catch (err) {
    console.warn("Leave cleanup partially failed:", err);
  }
  showToast("You left the room", "default");
  window.location.href = "index.html";
}

// ---------------------------------------------------------------------------
// copyRoomCode() / shareRoom()
// ---------------------------------------------------------------------------
function inviteLink() {
  return `${window.location.origin}${window.location.pathname.replace("room.html", "room.html")}?room=${roomCode}`;
}
async function copyRoomCode() {
  const ok = await copyToClipboard(roomCode);
  showToast(ok ? "Room code copied!" : "Couldn't copy — try manually.", ok ? "success" : "error");
}
async function shareRoom() {
  const link = inviteLink();
  if (navigator.share) {
    try {
      await navigator.share({ title: "Join my Nook chat", text: `Join my chat room: ${roomCode}`, url: link });
      return;
    } catch { /* user cancelled — fall through to copy */ }
  }
  const ok = await copyToClipboard(link);
  showToast(ok ? "Invite link copied!" : "Couldn't copy the link.", ok ? "success" : "error");
}

// ============================================================================
// UI wiring
// ============================================================================
function wireChatUI() {
  $("roomCodeBtn").addEventListener("click", copyRoomCode);
  $("shareBtn").addEventListener("click", shareRoom);

  // Leave flow
  $("leaveBtn").addEventListener("click", () => { $("leaveModalOverlay").hidden = false; });
  $("leaveCancelBtn").addEventListener("click", () => { $("leaveModalOverlay").hidden = true; });
  $("leaveConfirmBtn").addEventListener("click", leaveRoom);

  // Composer
  const input = $("messageInput");
  const sendBtn = $("sendBtn");

  function refreshSendState() {
    sendBtn.disabled = !input.value.trim() && !pendingMedia;
  }
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
    refreshSendState();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  sendBtn.addEventListener("click", handleSend);

  async function handleSend() {
    const text = input.value.trim();
    if (pendingMedia) {
      await commitPendingMedia();
      return;
    }
    if (!text) return;
    input.value = "";
    input.style.height = "auto";
    refreshSendState();
    try {
      await sendMessage(text);
    } catch (err) {
      console.error(err);
      showToast("Message failed to send.", "error");
    }
  }

  // Attach menu
  const attachBtn = $("attachBtn");
  const attachMenu = $("attachMenu");
  attachBtn.addEventListener("click", () => toggleMenu(attachMenu));
  attachMenu.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      attachMenu.hidden = true;
      if (b.dataset.attach === "image") $("imageInput").click();
      else $("videoInput").click();
    });
  });

  $("imageInput").addEventListener("change", (e) => handleFileSelect(e, "image"));
  $("videoInput").addEventListener("change", (e) => handleFileSelect(e, "video"));
  $("cancelMediaBtn").addEventListener("click", clearPendingMedia);

  // Emoji picker
  const emojiBtn = $("emojiBtn");
  const emojiPicker = $("emojiPicker");
  buildEmojiGrid(Object.values(EMOJI_GROUPS).flat());
  emojiBtn.addEventListener("click", () => toggleMenu(emojiPicker));
  $("emojiSearch").addEventListener("input", debounce((e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) { buildEmojiGrid(Object.values(EMOJI_GROUPS).flat()); return; }
    // Simple filter: emoji names aren't stored, so search is a no-op passthrough
    // for the small built-in set — kept simple and dependency-free.
    buildEmojiGrid(Object.values(EMOJI_GROUPS).flat());
  }, 200));

  function buildEmojiGrid(list) {
    const grid = $("emojiGrid");
    grid.innerHTML = "";
    list.forEach((emoji) => {
      const b = document.createElement("button");
      b.textContent = emoji;
      b.type = "button";
      b.addEventListener("click", () => {
        input.value += emoji;
        input.dispatchEvent(new Event("input"));
        input.focus();
      });
      grid.appendChild(b);
    });
  }

  document.addEventListener("click", (e) => {
    if (!attachBtn.contains(e.target) && !attachMenu.contains(e.target)) attachMenu.hidden = true;
    if (!emojiBtn.contains(e.target) && !emojiPicker.contains(e.target)) emojiPicker.hidden = true;
  });

  function toggleMenu(el) {
    const willOpen = el.hidden;
    [attachMenu, emojiPicker].forEach((m) => { m.hidden = true; });
    el.hidden = !willOpen;
  }

  // Lightbox
  $("lightboxClose").addEventListener("click", closeLightbox);
  $("lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closeLightbox(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeLightbox();
      $("actionSheetOverlay").hidden = true;
      $("reactionPickerOverlay").hidden = true;
    }
  });

  // Action sheet / reaction picker overlay dismiss
  $("actionSheetOverlay").addEventListener("click", (e) => { if (e.target.id === "actionSheetOverlay") e.target.hidden = true; });
  $("reactionPickerOverlay").addEventListener("click", (e) => { if (e.target.id === "reactionPickerOverlay") e.target.hidden = true; });

  refreshSendState();
}

// ---------------------------------------------------------------------------
// File selection → preview → send
// ---------------------------------------------------------------------------
function handleFileSelect(e, kind) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;

  const allowedTypes = kind === "image" ? ALLOWED_IMAGE_TYPES : ALLOWED_VIDEO_TYPES;
  const maxMB = kind === "image" ? MAX_IMAGE_SIZE_MB : MAX_VIDEO_SIZE_MB;

  if (!allowedTypes.includes(file.type)) {
    showToast(`Unsupported file type for ${kind}s.`, "error");
    return;
  }
  if (file.size > maxMB * 1024 * 1024) {
    showToast(`That file is too large. Max size is ${maxMB} MB.`, "error");
    return;
  }

  pendingMedia = { file, kind };
  const preview = $("mediaPreview");
  const thumb = $("mediaPreviewThumb");
  thumb.innerHTML = "";
  if (kind === "image") {
    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    thumb.appendChild(img);
  } else {
    const vid = document.createElement("video");
    vid.src = URL.createObjectURL(file);
    thumb.appendChild(vid);
  }
  $("mediaPreviewName").textContent = `${file.name} · ${formatBytes(file.size)}`;
  $("mediaPreviewProgressWrap").hidden = true;
  $("mediaPreviewProgressBar").style.width = "0%";
  preview.hidden = false;
  $("sendBtn").disabled = false;
}

function clearPendingMedia() {
  pendingMedia = null;
  $("mediaPreview").hidden = true;
  const input = $("messageInput");
  $("sendBtn").disabled = !input.value.trim();
}

async function commitPendingMedia() {
  if (!pendingMedia) return;
  const { file, kind } = pendingMedia;
  const sendBtn = $("sendBtn");
  sendBtn.disabled = true;
  try {
    const { url } = await uploadMedia(file, kind);
    await sendMediaMessage(kind, url, {
      mediaType: file.type,
      fileName: file.name,
      fileSize: file.size,
    });
    showToast("Upload complete", "success");
  } catch (err) {
    console.error(err);
    showToast("Upload failed. Please try again.", "error");
  } finally {
    clearPendingMedia();
  }
}

// ---------------------------------------------------------------------------
// Action sheet (Reply / React / Copy / Delete)
// ---------------------------------------------------------------------------
let activeMessage = null;

function openActionSheet(msg) {
  activeMessage = msg;
  const overlay = $("actionSheetOverlay");
  const sheet = $("actionSheet");
  const isOwn = msg.senderId === uid;
  sheet.querySelector('[data-action="delete"]').style.display = isOwn ? "flex" : "none";
  overlay.hidden = false;
}

$("actionSheet").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn || !activeMessage) return;
  const action = btn.dataset.action;
  $("actionSheetOverlay").hidden = true;

  if (action === "reply") {
    replyToMessage(activeMessage);
  } else if (action === "react") {
    openReactionPicker(activeMessage);
  } else if (action === "copy") {
    const text = activeMessage.type === "text" ? activeMessage.text : activeMessage.mediaUrl;
    const ok = await copyToClipboard(text || "");
    showToast(ok ? "Message copied" : "Couldn't copy message.", ok ? "success" : "error");
  } else if (action === "delete") {
    try {
      await remove(ref(db, `rooms/${roomId}/messages/${activeMessage.id}`));
    } catch (err) {
      console.error(err);
      showToast("Couldn't delete message.", "error");
    }
  }
});

function openReactionPicker(msg) {
  activeMessage = msg;
  const picker = $("reactionPicker");
  picker.innerHTML = "";
  QUICK_REACTIONS.forEach((emoji) => {
    const b = document.createElement("button");
    b.textContent = emoji;
    b.type = "button";
    b.addEventListener("click", async () => {
      $("reactionPickerOverlay").hidden = true;
      try {
        await toggleReaction(msg.id, emoji);
      } catch (err) {
        console.error(err);
        showToast("Couldn't react to message.", "error");
      }
    });
    picker.appendChild(b);
  });
  $("reactionPickerOverlay").hidden = false;
}

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------
function openLightbox(type, url) {
  const content = $("lightboxContent");
  content.innerHTML = "";
  if (type === "image") {
    const img = document.createElement("img");
    img.src = url;
    content.appendChild(img);
  } else {
    const vid = document.createElement("video");
    vid.src = url;
    vid.controls = true;
    vid.autoplay = true;
    content.appendChild(vid);
  }
  $("lightboxDownload").href = url;
  $("lightbox").hidden = false;
}
function closeLightbox() {
  $("lightbox").hidden = true;
  $("lightboxContent").innerHTML = "";
}

// ---------------------------------------------------------------------------
// Cleanup on unload (best-effort; onDisconnect handles the reliable case)
// ---------------------------------------------------------------------------
window.addEventListener("beforeunload", () => {
  if (hasJoined && !leavingIntentionally) {
    // Firebase onDisconnect() already handles member removal server-side;
    // nothing further to do here since synchronous writes aren't reliable
    // in an unload handler.
  }
});
