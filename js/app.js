// ============================================================================
// app.js — landing page logic (create room / join room)
// ============================================================================
import {
  db, ensureAuth, ref, set, get, serverTimestamp,
} from "./firebase.js";
import {
  escapeHTML, saveDisplayName,
  generateRoomCode, showToast,
} from "./utils.js";

const createModal = document.getElementById("createModal");
const joinModal = document.getElementById("joinModal");
const createForm = document.getElementById("createForm");
const joinForm = document.getElementById("joinForm");
const createNameInput = document.getElementById("createNameInput");
const joinCodeInput = document.getElementById("joinCodeInput");
const createNameError = document.getElementById("createNameError");
const joinCodeError = document.getElementById("joinCodeError");
const createSubmitBtn = document.getElementById("createSubmitBtn");
const joinSubmitBtn = document.getElementById("joinSubmitBtn");

function openModal(modal) {
  modal.hidden = false;
  const input = modal.querySelector("input");
  setTimeout(() => input?.focus(), 50);
  document.addEventListener("keydown", onEscClose);
}
function closeModal(modal) {
  modal.hidden = true;
  document.removeEventListener("keydown", onEscClose);
}
function onEscClose(e) {
  if (e.key === "Escape") {
    [createModal, joinModal].forEach((m) => { if (!m.hidden) closeModal(m); });
  }
}

document.getElementById("navCreateBtn").addEventListener("click", () => openModal(createModal));
document.getElementById("heroCreateBtn").addEventListener("click", () => openModal(createModal));
document.getElementById("navJoinBtn").addEventListener("click", () => openModal(joinModal));
document.getElementById("heroJoinBtn").addEventListener("click", () => openModal(joinModal));

document.querySelectorAll("[data-close-modal]").forEach((btn) => {
  btn.addEventListener("click", (e) => closeModal(e.target.closest(".modal-overlay")));
});
[createModal, joinModal].forEach((overlay) => {
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(overlay); });
});

function setLoading(btn, loading, label) {
  btn.disabled = loading;
  btn.querySelector(".btn__label")?.remove();
  btn.textContent = loading ? label : btn.dataset.originalLabel;
}

/**
 * Creates a new room in Realtime Database, adds the host as the first member,
 * and returns the generated room code.
 */
async function createRoom(displayName) {
  const user = await ensureAuth();
  const uid = user.uid; // must match auth.uid for the security rules to allow reads
  const roomRef = ref(db, "rooms");
  const newRoomRef = { key: null };

  // Generate a room code, retrying on the rare collision.
  let code;
  for (let attempt = 0; attempt < 5; attempt++) {
    code = generateRoomCode();
    const existing = await get(ref(db, `roomCodes/${code}`));
    if (!existing.exists()) break;
  }

  const roomId = `room_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  newRoomRef.key = roomId;

  const now = serverTimestamp();
  await set(ref(db, `rooms/${roomId}`), {
    code,
    hostId: uid,
    createdAt: now,
    lastActivity: now,
    status: "active",
  });
  await set(ref(db, `roomCodes/${code}`), roomId);
  await set(ref(db, `rooms/${roomId}/members/${uid}`), {
    name: displayName,
    joinedAt: now,
    online: true,
    isHost: true,
  });

  return { roomId, code };
}

async function findRoomIdByCode(code) {
  const snap = await get(ref(db, `roomCodes/${code.toUpperCase()}`));
  return snap.exists() ? snap.val() : null;
}

createForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = createNameInput.value.trim();
  createNameError.hidden = true;

  if (!name) {
    createNameError.textContent = "Please enter a display name.";
    createNameError.hidden = false;
    return;
  }
  if (name.length > 24) {
    createNameError.textContent = "Name must be 24 characters or fewer.";
    createNameError.hidden = false;
    return;
  }

  createSubmitBtn.dataset.originalLabel = createSubmitBtn.textContent;
  setLoading(createSubmitBtn, true, "Creating room…");

  try {
    saveDisplayName(name);
    const { roomId, code } = await createRoom(escapeHTML(name));
    window.location.href = `room.html?room=${code}`;
  } catch (err) {
    console.error(err);
    showToast("Couldn't create the room. Check your Firebase config.", "error");
    setLoading(createSubmitBtn, false);
  }
});

joinForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = joinCodeInput.value.trim().toUpperCase();
  joinCodeError.hidden = true;

  if (!code) {
    joinCodeError.textContent = "Please enter a room code.";
    joinCodeError.hidden = false;
    return;
  }

  joinSubmitBtn.dataset.originalLabel = joinSubmitBtn.textContent;
  setLoading(joinSubmitBtn, true, "Checking room…");

  try {
    await ensureAuth();
    const roomId = await findRoomIdByCode(code);
    if (!roomId) {
      joinCodeError.textContent = "No room found with that code.";
      joinCodeError.hidden = false;
      setLoading(joinSubmitBtn, false);
      return;
    }
    window.location.href = `room.html?room=${code}`;
  } catch (err) {
    console.error(err);
    showToast("Couldn't reach Firebase. Check your config and connection.", "error");
    setLoading(joinSubmitBtn, false);
  }
});

joinCodeInput.addEventListener("input", () => {
  joinCodeInput.value = joinCodeInput.value.toUpperCase();
});
